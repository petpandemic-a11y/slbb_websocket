// Raydium LP Burn Watcher (whitelist-based, remove-liq safe, debuggable)
// Focus: ONLY real SPL burns where the burned mint is a Raydium LP mint (AMM v4 / CPMM / StableSwap).
// Changes:
//  - Adds Raydium LP whitelist loader (liquidity/mainnet.json) -> lpMintSet
//  - Makes "RemoveLiquidity logs" exclusion optional via env (REMOVE_LIQ_LOG_BLOCK=1 to enable; default OFF)
//  - Keeps vault-outflow exclusion but makes it optional via env (STRICT_VAULT_OUTFLOW=1 to enable; default ON)
//  - Adds rich debug logs for skip reasons
//  - Keeps rate limiter, dedup, Telegram formatting
//
// ENV (typical):
//  PORT=8080
//  RPC_HTTP=...  RPC_WSS=...
//  TG_BOT_TOKEN=... TG_CHAT_ID=...
//  MIN_SOL_BURN=0                # estimated SOL threshold
//  MIN_LP_BURN_PCT=0.95          # 0.95 = 95% default; raise/lower as needed
//  MAX_TOKEN_AGE_MIN=0           # 0=off
//  RATE_MS=1200                  # getTransaction throttle
//  DEBUG=1
//  # new:
//  REMOVE_LIQ_LOG_BLOCK=0        # 1 => skip tx if RemoveLiquidity-like logs; 0 => just log it (default 0)
//  STRICT_VAULT_OUTFLOW=1        # 1 => skip tx if vault outflow detected (default 1)
//  RAY_LP_LIST_URL=https://api.raydium.io/v2/sdk/liquidity/mainnet.json
//
// Notes:
//  - CLMM is intentionally ignored for LP-burn: no fungible LP mint, it's position NFTs.
//  - Whitelist refreshes hourly. On failure, the previous set remains.
//  - If lpMintSet is empty at boot (e.g., network issue), we still proceed but log a big WARNING.
//

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
const MIN_LP_BURN_PCT = Number(process.env.MIN_LP_BURN_PCT || 0.95);
const MAX_TOKEN_AGE_MIN = Number(process.env.MAX_TOKEN_AGE_MIN || 0);

const DEBUG = process.env.DEBUG === "1";
const RATE_MS = Number(process.env.RATE_MS || 1200);

// new feature flags
const REMOVE_LIQ_LOG_BLOCK = process.env.REMOVE_LIQ_LOG_BLOCK === "1"; // default off
const STRICT_VAULT_OUTFLOW = process.env.STRICT_VAULT_OUTFLOW !== "0"; // default on
const RAY_LP_LIST_URL = process.env.RAY_LP_LIST_URL || "https://api.raydium.io/v2/sdk/liquidity/mainnet.json";

// ===== Program IDs =====
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM   = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const RAY_STABLE = "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h";
const TOKENKEG   = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WSOL_MINT  = "So11111111111111111111111111111111111111112";
const METAPLEX_META = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

// Quote mints (for info purposes)
const QUOTE_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  WSOL_MINT,
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"  // BONK
]);

// ===== Logger + health =====
const log = (...a) => console.log(new Date().toISOString(), ...a);
const dbg = (...a) => { if (DEBUG) console.log(new Date().toISOString(), "[DBG]", ...a); };

http.createServer((_, res)=>{res.writeHead(200,{"content-type":"text/plain"});res.end("ok\n");})
  .listen(PORT, ()=>log(`HTTP up on :${PORT}`));

// ===== JSON-RPC =====
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc:"2.0", id:1, method, params });
  const r = await fetch(RPC_HTTP, { method:"POST", headers:{ "content-type":"application/json" }, body });
  if (!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}`);
  const j = await r.json(); if (j.error) throw new Error(`RPC ${method} err: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function getTransaction(signature, tries=3){
  for (let i=0;i<tries;i++){
    try{
      return await rpc("getTransaction",[signature,{encoding:"jsonParsed",maxSupportedTransactionVersion:0}]);
    }catch(e){
      log(`getTransaction fail (${i+1}/${tries}) ${signature}:`, e.message);
      if (i<tries-1) await new Promise(r=>setTimeout(r,1500*(i+1)));
    }
  }
  return null;
}
async function getParsedAccountInfo(pubkey){ return rpc("getParsedAccountInfo",[pubkey,{commitment:"confirmed"}]); }
async function getAccountInfoRaw(pubkey){ return rpc("getAccountInfo",[pubkey,{commitment:"confirmed",encoding:"base64"}]); }
async function getProgramAccounts(programId, filters=[]) {
  return rpc("getProgramAccounts", [ programId, { commitment:"confirmed", encoding:"base64", filters } ]);
}

// ===== parsed cache =====
const parsedCache = new Map();
async function getParsedCached(pubkey){
  if (parsedCache.has(pubkey)) return parsedCache.get(pubkey);
  try{ const info = await getParsedAccountInfo(pubkey); parsedCache.set(pubkey,info); return info; }
  catch{ parsedCache.set(pubkey,null); return null; }
}
async function isMintAccount(pubkey){
  const info = await getParsedCached(pubkey);
  const d = info?.value?.data?.parsed;
  return d?.type === "mint" ? d : null;
}
async function tokenAccountInfo(pubkey){
  const info = await getParsedCached(pubkey);
  const d = info?.value?.data?.parsed;
  return d?.type === "account" ? d?.info : null;
}

// ===== Dexscreener (optional info) =====
async function fetchDexscreenerByToken(mint){
  try{
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { headers:{accept:"application/json"} });
    if (!r.ok) { dbg("dexs HTTP", r.status); return null; }
    const j = await r.json();
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    if (!pairs.length) return null;
    pairs.sort((a,b)=>{
      const ra = (a?.dexId||"").toLowerCase()==="raydium" ? 0 : 1;
      const rb = (b?.dexId||"").toLowerCase()==="raydium" ? 0 : 1;
      if (ra!==rb) return ra-rb;
      return (b?.liquidity?.usd||0) - (a?.liquidity?.usd||0);
    });
    const p = pairs[0];
    return {
      name:   p?.baseToken?.name   || null,
      symbol: p?.baseToken?.symbol || null,
      price:  p?.priceUsd ? Number(p.priceUsd) : null,
      liq:    p?.liquidity?.usd ? Number(p.liquidity.usd) : null,
      fdv:    p?.fdv ? Number(p.fdv) : null,
      mcap:   p?.marketCap ? Number(p.marketCap) : null,
      url:    p?.url || null,
      createdAt: p?.pairCreatedAt || null
    };
  }catch(e){ dbg("dexs err:", e.message); return null; }
}

// ===== Base58 util =====
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58encode(buf){
  if (!buf || !buf.length) return "";
  let x = [...buf];
  let zeros = 0;
  while (zeros < x.length && x[zeros] === 0) zeros++;
  const b58 = [];
  let start = zeros;
  while (start < x.length) {
    let carry = 0;
    for (let i = start; i < x.length; i++) {
      const v = (x[i] & 0xff) + carry * 256;
      x[i] = (v / 58) | 0;
      carry = v % 58;
    }
    b58.push(ALPHABET[carry]);
    while (start < x.length && x[start] === 0) start++;
  }
  for (let i = 0; i < zeros; i++) b58.push("1");
  return b58.reverse().join("");
}

// ===== Perzisztens dedup =====
const SENT_FILE = "/tmp/sent_sigs.json";
const SENT_TTL_MS = 48 * 60 * 60 * 1000; // 48h
const SENT_MAX = 5000;
let sentMap = new Map(); // sig -> ts

function loadSent() {
  try {
    const raw = fs.readFileSync(SENT_FILE, "utf8");
    const arr = JSON.parse(raw);
    const now = Date.now();
    sentMap = new Map(arr.filter(([sig, ts]) => now - ts < SENT_TTL_MS));
    log(`sent_sigs loaded: ${sentMap.size}`);
  } catch { sentMap = new Map(); }
}
function saveSent() {
  try {
    const entries = [...sentMap.entries()];
    entries.sort((a,b)=>a[1]-b[1]); // oldest first
    const trimmed = entries.slice(Math.max(0, entries.length - SENT_MAX));
    fs.writeFileSync(SENT_FILE, JSON.stringify(trimmed), "utf8");
  } catch (e) { dbg("saveSent err:", e.message); }
}
loadSent();

// ===== Telegram (queue + throttle) =====
const tgQ=[]; let tgSending=false;
async function sendTelegram(text){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  tgQ.push(text); if (tgSending) return; tgSending=true;
  while (tgQ.length){
    const msg = tgQ.shift();
    try{
      const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method:"POST", headers:{ "content-type":"application/json" },
        body: JSON.stringify({ chat_id:TG_CHAT_ID, text:msg, parse_mode:"HTML", disable_web_page_preview:false })
      });
      if (r.status===429){
        let wait=3000; try{ const jr=await r.json(); if (jr?.parameters?.retry_after) wait=jr.parameters.retry_after*1000; }catch{}
        await new Promise(res=>setTimeout(res,wait)); tgQ.unshift(msg);
      } else {
        await new Promise(res=>setTimeout(res,1200));
      }
    }catch(e){ log("TG err:", e.message); await new Promise(res=>setTimeout(res,2000)); }
  }
  tgSending=false;
}

// ===== Rate limiter for getTransaction =====
const sigQueue=[]; const seenSig=new Set(); let workerRunning=false;
async function enqueueSignature(sig){
  if (seenSig.has(sig)) return; seenSig.add(sig); sigQueue.push(sig);
  if (!workerRunning){
    workerRunning=true;
    while (sigQueue.length){
      const s = sigQueue.shift();
      try{ await processSignature(s); }catch(e){ log("processSignature err:", e.message); }
      await new Promise(r=>setTimeout(r, RATE_MS));
    }
    workerRunning=false;
  }
}

// ===== Utils =====
function ago(tsMs){
  const s = Math.max(1, Math.floor((Date.now()-tsMs)/1000));
  if (s<60) return `${s}s ago`;
  const m = Math.floor(s/60); if (m<60) return `${m} minutes ago`;
  const h = Math.floor(m/60); if (h<24) return `${h} hours ago`;
  const d = Math.floor(h/24); return `${d} days ago`;
}

// ===== Whitelist loader (Raydium LP mints) =====
let lpMintSet = new Set();
async function loadRaydiumLpMints() {
  try {
    const r = await fetch(RAY_LP_LIST_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const lists = [
      ...(Array.isArray(j?.official) ? j.official : []),
      ...(Array.isArray(j?.unOfficial) ? j.unOfficial : []),
    ];
    const mints = lists
      .map(p => p?.lpMint || p?.lp?.mint || p?.lp_mint)
      .filter(Boolean);
    if (mints.length === 0) throw new Error("empty mint list");
    lpMintSet = new Set(mints);
    log(`[Raydium] LP mints loaded: ${lpMintSet.size}`);
  } catch (e) {
    log(`[Raydium] LP list load FAILED: ${e.message}. Using previous set size=${lpMintSet.size}`);
  }
}
loadRaydiumLpMints();
setInterval(loadRaydiumLpMints, 60 * 60 * 1000); // hourly

// ===== Remove Liquidity detection (optional SKIP) =====
function hasRemoveLiquidityLogs(logsArr){
  return logsArr.some(l =>
    typeof l==="string" &&
    ( /Remove\s*Liquidity/i.test(l)
      || /RemoveLiquidity/i.test(l)
      || /DecreaseLiquidity/i.test(l)
      || /Withdraw\b/i.test(l) )
  );
}

// Tokenkeg transfer out of Raydium vaults => remove-liq like tx
function hasVaultOutflows(tx, rayAccounts, lpMint){
  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap(x=>x?.instructions||[]);
  const all = [...top, ...inner];
  for (const ix of all){
    if ((ix?.programId||"") !== TOKENKEG) continue;
    const p = ix?.parsed;
    if (!p || p?.type !== "transfer") continue;
    const info = p?.info || {};
    const source = info?.source;
    const mint   = info?.mint || null;
    if (source && rayAccounts.has(source) && mint && mint !== lpMint) {
      return true;
    }
  }
  return false;
}

// ===== Main =====
async function processSignature(sig){
  // persistent dedup
  if (sentMap.has(sig)) { dbg("skip already sent sig:", sig); return; }

  const tx = await getTransaction(sig);
  if (!tx) return;

  const top = tx?.transaction?.message?.instructions || [];
  const inner = (tx?.meta?.innerInstructions || []).flatMap(x=>x?.instructions||[]);
  const all = [...top, ...inner];

  // Raydium accounts seen in tx
  const rayPrograms = new Set([RAY_AMM_V4, RAY_CPMM, RAY_STABLE]);
  const rayAccounts = new Set();
  for (const ix of all){
    const pid = typeof ix?.programId==="string" ? ix.programId : null;
    if (pid && rayPrograms.has(pid)){
      const accs = (ix?.accounts||[]).map(a=>typeof a==="string"?a:(a?.pubkey||a?.toString?.())).filter(Boolean);
      for (const a of accs) rayAccounts.add(a);
    }
  }
  const msgKeys = tx?.transaction?.message?.accountKeys || [];
  for (const k of msgKeys) {
    const pk = typeof k === "string" ? k : (k?.pubkey || k?.toString?.());
    if (pk) rayAccounts.add(pk);
  }
  dbg("rayAccounts count:", rayAccounts.size);

  // RemoveLiquidity logs handling (optional block)
  const logsArr = Array.isArray(tx?.meta?.logMessages) ? tx.meta.logMessages
                : Array.isArray(tx?.logs) ? tx.logs : [];
  if (hasRemoveLiquidityLogs(logsArr)) {
    if (REMOVE_LIQ_LOG_BLOCK) {
      dbg("skip: RemoveLiquidity pattern (LOG BLOCK ON)");
      return;
    } else {
      dbg("HAS RemoveLiquidity-like logs, but not skipping (LOG BLOCK OFF)");
    }
  }

  // Find a Tokenkeg Burn and ensure the burned mint is a known Raydium LP mint
  let lpMint=null, burnAmountRaw=0;
  for (const ix of all){
    const pid = typeof ix?.programId==="string" ? ix.programId : null;
    if (pid!==TOKENKEG) continue;
    const isBurn = ix?.parsed?.type==="burn" || ix?.instructionName==="Burn";
    if (!isBurn) continue;
    const cand = ix?.parsed?.info?.mint || ix?.mint;
    if (!cand) continue;

    // LP whitelist gate
    if (lpMintSet.size === 0) {
      log("[WARN] lpMintSet empty; accepting burn candidates for now:", cand);
    } else if (!lpMintSet.has(cand)) {
      dbg("skip burn: mint not in Raydium LP whitelist", cand);
      continue;
    }
    lpMint = cand;
    burnAmountRaw = Number(ix?.parsed?.info?.amount || ix?.amount || 0);
    break;
  }
  if (!lpMint){ dbg("no LP mint burn found (after whitelist check)"); return; }

  // Optional: vault outflow exclusion
  if (STRICT_VAULT_OUTFLOW && hasVaultOutflows(tx, rayAccounts, lpMint)) {
    dbg("skip: detected vault outflow transfers (remove-liq like, STRICT_VAULT_OUTFLOW=1)");
    return;
  }

  // LP supply + burn% check
  let lpSupplyPost=0, lpDecimals=0;
  try{
    const mi = await getParsedCached(lpMint);
    const d = mi?.value?.data?.parsed?.info;
    if (d?.supply) lpSupplyPost = Number(d.supply);
    if (d?.decimals!=null) lpDecimals = Number(d.decimals)||0;
  }catch{}
  const lpSupplyPre = lpSupplyPost + burnAmountRaw;
  const burnShare = lpSupplyPre>0 ? (burnAmountRaw/lpSupplyPre) : 0;

  if (!isFinite(burnShare) || burnShare <= 0){
    dbg("skip: invalid burnShare", burnShare);
    return;
  }
  if (burnShare < MIN_LP_BURN_PCT){
    dbg(`skip: burnShare ${(burnShare*100).toFixed(2)}% < min ${(MIN_LP_BURN_PCT*100).toFixed(2)}%`);
    return;
  }

  // Estimate SOL value from WSOL vault (optional heuristic)
  let wsolVaultRaw=0, wsolDecimals=9; let checked=0;
  for (const a of rayAccounts){
    if (checked++>120) break;
    const acc = await tokenAccountInfo(a);
    if (acc?.mint===WSOL_MINT){
      const ta = acc?.tokenAmount;
      if (ta?.amount) wsolVaultRaw = Number(ta.amount);
      if (ta?.decimals!=null) wsolDecimals = Number(ta.decimals)||9;
      break;
    }
  }
  const estSolOut = burnShare * (wsolVaultRaw/Math.pow(10,wsolDecimals));
  if (MIN_SOL_BURN>0 && estSolOut < MIN_SOL_BURN){
    log(`skip (est SOL ${estSolOut.toFixed(4)} < min ${MIN_SOL_BURN}) sig=${sig}`);
    return;
  }

  // Resolve base token (best-effort heuristics via balance-diff on non-LP mints)
  function resolveBaseMintViaBalances(tx, lpMint) {
    const pre = Array.isArray(tx?.meta?.preTokenBalances) ? tx.meta.preTokenBalances : [];
    const post = Array.isArray(tx?.meta?.postTokenBalances) ? tx.meta.postTokenBalances : [];
    const key = (b) => `${b?.accountIndex || 0}|${b?.mint || ""}`;
    const preMap = new Map(pre.map(b => [key(b), b]));
    const changes = [];
    for (const b of post) {
      const k = key(b);
      const p = preMap.get(k);
      const mint = b?.mint;
      if (!mint || mint === lpMint) continue;
      const dec = Number(b?.uiTokenAmount?.decimals || 0);
      const postAmt = Number(b?.uiTokenAmount?.amount || 0);
      const preAmt  = Number(p?.uiTokenAmount?.amount || 0);
      const diffRaw = postAmt - preAmt;
      const diffAbs = Math.abs(diffRaw) / (10 ** dec);
      if (diffAbs > 0) changes.push({ mint, diffAbs });
    }
    const byMint = new Map();
    for (const c of changes) byMint.set(c.mint, (byMint.get(c.mint) || 0) + c.diffAbs);
    const ranked = [...byMint.entries()].sort((a,b)=>b[1]-a[1]);
    if (ranked.length >= 2) {
      const [m1, m2] = ranked.slice(0,2).map(x=>x[0]);
      if (QUOTE_MINTS.has(m1) && !QUOTE_MINTS.has(m2)) return m2;
      if (QUOTE_MINTS.has(m2) && !QUOTE_MINTS.has(m1)) return m1;
      return m1;
    }
    return ranked[0]?.[0] || null;
  }
  const baseMint = resolveBaseMintViaBalances(tx, lpMint);

  // Dexscreener info (best effort)
  let dx=null; if (baseMint) dx = await fetchDexscreenerByToken(baseMint);

  // Optional token age filter
  if (MAX_TOKEN_AGE_MIN > 0) {
    const createdAt = dx?.createdAt ? Number(dx.createdAt) : null;
    if (!createdAt) { dbg("skip: no pairCreatedAt (age unknown)"); return; }
    const ageMin = (Date.now() - createdAt) / 60000;
    if (ageMin > MAX_TOKEN_AGE_MIN) {
      dbg(`skip: token age ${ageMin.toFixed(1)}min > max ${MAX_TOKEN_AGE_MIN}min`);
      return;
    }
  }

  // Build TG message
  const link = `https://solscan.io/tx/${sig}`;
  const burnPct = (burnShare*100).toFixed(2);
  const burnAgo = tx?.blockTime ? ago(tx.blockTime*1000) : "n/a";
  const headTitle = (dx?.name && dx?.symbol) ? `${dx.name} (${dx.symbol})` : "Raydium LP Burn";
  const mcapStr = dx?.mcap!=null ? `$${dx.mcap.toLocaleString()}` : (dx?.fdv!=null?`$${dx.fdv.toLocaleString()}`:"n/a");
  const liqStr  = dx?.liq!=null  ? `$${dx.liq.toLocaleString()}` : "n/a";
  const priceStr= dx?.price!=null? `$${dx.price}` : "n/a";

  const lines = [
    `Solana LP Burns`,
    `<b>${headTitle}</b>`,
    ``,
    `🔥 <b>Burn Percentage:</b> ${burnPct}%`,
    `🕒 <b>Burn Time:</b> ${burnAgo}`,
    ``,
    `📊 <b>Marketcap:</b> ${mcapStr}`,
    `💧 <b>Liquidity:</b> ${liqStr}`,
    `💲 <b>Price:</b> ${priceStr}`,
    ``,
    baseMint ? `🧾 <b>Token Mint:</b> <code>${baseMint}</code>` : `🧾 <b>Token Mint:</b> n/a`,
    ``,
    `🔗 <a href="${link}">Solscan</a>`,
    DEBUG ? `\n<code>wl=${lpMintSet.size} rlq=${REMOVE_LIQ_LOG_BLOCK?1:0} vlo=${STRICT_VAULT_OUTFLOW?1:0}</code>` : null
  ].filter(Boolean);

  // dedup record now
  sentMap.set(sig, Date.now());
  saveSent();

  await sendTelegram(lines.join("\n"));
  log(`TG → ${headTitle} | burn=${burnPct}% | sig=${sig}`);
}

// ===== WS =====
let ws;
function wsSend(obj){ if (ws && ws.readyState===ws.OPEN) ws.send(JSON.stringify(obj)); }
function subscribeLogs(programId, id){
  wsSend({ jsonrpc:"2.0", id, method:"logsSubscribe", params:[ { mentions:[programId] }, { commitment:"confirmed" } ] });
}
function connectWS(){
  log("WS connecting", RPC_WSS);
  ws = new WebSocket(RPC_WSS);
  ws.onopen = () => { 
    log("WS open"); 
    subscribeLogs(RAY_AMM_V4,1001); 
    subscribeLogs(RAY_CPMM,1002); 
    subscribeLogs(RAY_STABLE,1003); 
  };
  ws.onmessage = async (ev)=>{
    try{
      const data = JSON.parse(ev.data.toString());
      const res = data?.params?.result;
      const sig = res?.value?.signature;
      const logsArr = Array.isArray(res?.value?.logs) ? res.value.logs : [];
      if (!sig || logsArr.length===0) return;

      // Must contain Instruction: Burn (Token program)
      const hasBurnLog = logsArr.some(l => typeof l==="string" && /Instruction:\s*Burn\b/i.test(l));
      if (!hasBurnLog) return;

      // Remove-liq logs handling is deferred to processSignature (we don't skip here)
      await enqueueSignature(sig);
    }catch(e){ log("WS msg err:", e.message); }
  };
  ws.onclose = ()=>{ log("WS closed, reconnect in 3s…"); setTimeout(connectWS,3000); };
  ws.onerror = (e)=>{ log("WS error:", e?.message || String(e)); };
}
connectWS();
