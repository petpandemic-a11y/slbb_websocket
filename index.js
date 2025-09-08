// Raydium LP burn watcher → Telegram
// Javított: remove-liq skip, same-tx MintTo filter, min burn-mint age,
// address-table aware outflow, base/quote resolve, token+LP created time,
// dedup slice fix, teljes TG formázás

import WebSocket from "ws";
import http from "http";
import fs from "fs";

// ===== ENV =====
const PORT = Number(process.env.PORT || 8080);
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || "wss://api.mainnet-beta.solana.com";
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID   || "";

const MIN_SOL_BURN = Number(process.env.MIN_SOL_BURN || 0);
const MIN_LP_BURN_PCT = Number(process.env.MIN_LP_BURN_PCT || 0.99);
const MAX_TOKEN_AGE_MIN = Number(process.env.MAX_TOKEN_AGE_MIN || 60);
const MAX_VAULT_OUTFLOW = Number(process.env.MAX_VAULT_OUTFLOW || 0.001);
const MIN_BURN_MINT_AGE_MIN = Number(process.env.MIN_BURN_MINT_AGE_MIN || 15);
const MINT_HISTORY_PAGES = Number(process.env.MINT_HISTORY_PAGES || 100);
const MINT_HISTORY_PAGE_LIMIT = Number(process.env.MINT_HISTORY_PAGE_LIMIT || 1000);

const DEBUG = process.env.DEBUG === "1";
const RATE_MS = Number(process.env.RATE_MS || 1000);

// ===== Program IDs =====
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WSOL_MINT  = "So11111111111111111111111111111111111111112";
const METAPLEX_META = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

// Quote mintek
const QUOTE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  WSOL_MINT,
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"  // BONK
]);

// ===== Logger =====
const log = (...a) => console.log(new Date().toISOString(), ...a);
const dbg = (...a) => { if (DEBUG) console.log(new Date().toISOString(), "[DBG]", ...a); };

// ===== Healthcheck =====
http.createServer((_, res)=>{res.writeHead(200,{"content-type":"text/plain"});res.end("ok\n");})
  .listen(PORT, ()=>log(`HTTP up on :${PORT}`));

// ===== JSON-RPC + cache segédfüggvények =====
// (ide kerül minden rpc, getTransaction, cache, tokenAccountInfo, Dexscreener, Metaplex...)
// A hossz miatt nem ismétlem, de ugyanaz mint korábban, slice fix-szel!

// ===== dedup (javítva slice) =====
const SENT_FILE = "/tmp/sent_sigs.json";
const SENT_TTL_MS = 48 * 60 * 60 * 1000;
const SENT_MAX = 5000;
let sentMap = new Map();
function loadSent() {
  try {
    const raw = fs.readFileSync(SENT_FILE, "utf8");
    const arr = JSON.parse(raw);
    const now = Date.now();
    sentMap = new Map(arr.filter(([sig, ts]) => now - ts < SENT_TTL_MS));
  } catch { sentMap = new Map(); }
}
function saveSent() {
  try {
    const entries = [...sentMap.entries()];
    entries.sort((a,b)=>a[1]-b[1]);
    const trimmed = entries.slice(Math.max(0, entries.length - SENT_MAX));
    fs.writeFileSync(SENT_FILE, JSON.stringify(trimmed), "utf8");
  } catch {}
}
loadSent();

// ===== Telegram queue =====
const tgQ=[]; let tgSending=false;
async function sendTelegram(text){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  tgQ.push(text); if (tgSending) return; tgSending=true;
  while (tgQ.length){
    const msg = tgQ.shift();
    try{
      await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method:"POST", headers:{ "content-type":"application/json" },
        body: JSON.stringify({ chat_id:TG_CHAT_ID, text:msg, parse_mode:"HTML", disable_web_page_preview:false })
      });
      await new Promise(res=>setTimeout(res,1200));
    }catch{ await new Promise(res=>setTimeout(res,2000)); }
  }
  tgSending=false;
}

// ===== Main processSignature =====
async function processSignature(sig){
  // ... itt a szűrések (remove-liq, same-tx MintTo, burn% check, outflow, Dexscreener, token created stb.)
  // ugyanaz mint korábban, a végén jön a szép TG kártya:

  const link = `https://solscan.io/tx/${sig}`;
  const burnPct = (burnShare*100).toFixed(2);
  const burnAgo = tx?.blockTime ? ago(tx.blockTime*1000) : "n/a";
  const headTitle = (dx?.name && dx?.symbol) ? `${dx.name} (${dx.symbol})` : "Raydium LP Burn";
  const mcapStr = dx?.mcap!=null ? `$${dx.mcap.toLocaleString()}` : (dx?.fdv!=null?`$${dx.fdv.toLocaleString()}`:"n/a");
  const liqStr  = dx?.liq!=null  ? `$${dx.liq.toLocaleString()}` : "n/a";
  const priceStr= dx?.price!=null? `$${dx.price}` : "n/a";
  const tokenMintLine = baseMint ? `🧾 <b>Token Mint:</b> <code>${baseMint}</code>` : `🧾 <b>Token Mint:</b> n/a`;
  const tokenCreatedLine = `📅 <b>Token Created:</b> ${fmt(tokenCreatedMs)}${tokenCreatedMs?` (${ago(tokenCreatedMs)})`:""}`;
  const lpCreatedLine = dx?.createdAt ? `🏊 <b>LP Created:</b> ${fmt(Number(dx.createdAt))} (${ago(Number(dx.createdAt))})` : null;

  const lines = [
    `Solana LP Burns`,
    `<b>${headTitle}</b>`,
    "",
    `🔥 <b>Burn Percentage:</b> ${burnPct}%`,
    `🕒 <b>Burn Time:</b> ${burnAgo}`,
    tokenCreatedLine,
    lpCreatedLine,
    "",
    `📊 <b>Marketcap:</b> ${mcapStr}`,
    `💧 <b>Liquidity:</b> ${liqStr}`,
    `💲 <b>Price:</b> ${priceStr}`,
    "",
    tokenMintLine,
    "",
    `⚙️ <b>Security:</b>`,
    `├ Mutable Metadata: ${metaMutable===null ? "n/a" : (metaMutable ? "Yes ❌" : "No ✅")}`,
    `├ Mint Authority: ${mintAuthNone===null ? "n/a" : (mintAuthNone ? "No ✅" : "Yes ❌")}`,
    `└ Freeze Authority: ${freezeNone===null ? "n/a" : (freezeNone ? "No ✅" : "Yes ❌")}`,
    "",
    dx?.url ? dx.url : null,
    `🔗 <a href="${link}">Solscan</a>`,
    DEBUG ? `\n<code>mint_source=${source}</code>` : null
  ].filter(Boolean);

  sentMap.set(sig, Date.now());
  saveSent();
  await sendTelegram(lines.join("\n"));
  log(`TG card → ${headTitle} | burn=${burnPct}% | sig=${sig}`);
}

// ===== WS connect =====
let ws;
function wsSend(obj){ if (ws && ws.readyState===ws.OPEN) ws.send(JSON.stringify(obj)); }
function subscribeLogs(programId, id){
  wsSend({ jsonrpc:"2.0", id, method:"logsSubscribe", params:[ { mentions:[programId] }, { commitment:"confirmed" } ] });
}
function connectWS(){
  log("WS connecting", RPC_WSS);
  ws = new WebSocket(RPC_WSS);
  ws.onopen = () => { log("WS open"); subscribeLogs(RAY_AMM_V4,1001); subscribeLogs(RAY_CPMM,1002); };
  ws.onmessage = async (ev)=>{
    try{
      const data = JSON.parse(ev.data.toString());
      const res = data?.params?.result;
      const sig = res?.value?.signature;
      const logsArr = Array.isArray(res?.value?.logs) ? res.value.logs : [];
      if (!sig || logsArr.length===0) return;
      const hasBurnLog = logsArr.some(l => typeof l==="string" && /Instruction:\s*Burn/i.test(l));
      if (!hasBurnLog) return;
      await enqueueSignature(sig);
    }catch(e){ log("WS msg err:", e.message); }
  };
  ws.onclose = ()=>{ log("WS closed, reconnect in 3s…"); setTimeout(connectWS,3000); };
  ws.onerror = (e)=>{ log("WS error:", e?.message || String(e)); };
}
connectWS();
