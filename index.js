// ===== Raydium LP Burn Monitor — HARD remove-liquidity filter =====
import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";
import express from "express";

// ---- ENV ----
const RPC_HTTP = process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";
const RPC_WSS  = process.env.RPC_WSS  || undefined;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID   = process.env.TG_CHAT_ID || "";
const DEBUG = process.env.DEBUG === "1";
const RATE_MS = Number(process.env.RATE_MS || 4000);
const MIN_LP_BURN_PCT = Number(process.env.MIN_LP_BURN_PCT || 0.9);

// ---- Raydium programs ----
const RAYDIUM_V4  = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const RAYDIUM_CPMM= new PublicKey("CAMMCzo5YL8w4VFF8KVHRk22GGUsp5VTaW7girrKgIrw");
const RAYDIUM_CLMM= new PublicKey("RVKd61ztZW9GUwhQYvDTKHzYS4sV6sKRQ39SL7jdpT2");

// ---- Constants ----
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const INCINERATOR = "1nc1nerator11111111111111111111111111111111";

// ---- Utils ----
const log = (...a)=>console.log(...a);
const dbg = (...a)=>{ if (DEBUG) console.log(...a); };
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const pretty = (m)=> m===WSOL_MINT ? "SOL" : (m ? `${m.slice(0,4)}…${m.slice(-4)}` : "Unknown");

// ---- Core helpers ----
function getParsedIxs(tx){
  const arr = tx?.transaction?.message?.instructions || [];
  return arr.map(i=>i.parsed).filter(Boolean);
}
function logsLower(tx){ return (tx?.meta?.logMessages || []).join(" ").toLowerCase(); }
function buildTokenMap(tx){
  const pre = tx?.meta?.preTokenBalances || [];
  const post= tx?.meta?.postTokenBalances || [];
  const map = new Map();
  for (const b of pre){
    map.set(b.accountIndex,{owner:b.owner,mint:b.mint,pre:Number(b.uiTokenAmount?.uiAmountString||b.uiTokenAmount?.uiAmount||0),post:0});
  }
  for (const b of post){
    const row = map.get(b.accountIndex)||{owner:b.owner,mint:b.mint,pre:0,post:0};
    row.owner=b.owner; row.mint=b.mint; row.post=Number(b.uiTokenAmount?.uiAmountString||b.uiTokenAmount?.uiAmount||0);
    map.set(b.accountIndex,row);
  }
  return map;
}
function inflowsByOwner(tx){
  const map=buildTokenMap(tx); const res=new Map();
  for (const [,r] of map){ const d=r.post-r.pre; if (d>0){ if(!res.has(r.owner)) res.set(r.owner,new Set()); res.get(r.owner).add(r.mint); } }
  return res;
}
function extractLpMintFromBurn(tx){
  for (const p of getParsedIxs(tx)){
    const t=String(p?.type||"").toLowerCase();
    if ((t==="burn"||t==="burnchecked")&&p.info?.mint) return p.info.mint;
  }
  return null;
}
function lpSupplyDropPct(tx, lpMint){
  const pre = tx?.meta?.preTokenBalances || [];
  const post= tx?.meta?.postTokenBalances || [];
  let preSum=0, postSum=0;
  for (const b of pre)  if (b.mint===lpMint) preSum  += Number(b.uiTokenAmount?.uiAmountString||b.uiTokenAmount?.uiAmount||0);
  for (const b of post) if (b.mint===lpMint) postSum += Number(b.uiTokenAmount?.uiAmountString||b.uiTokenAmount?.uiAmount||0);
  if (preSum<=0) return 0;
  return Math.max(0, preSum-postSum)/preSum;
}

// ------------------------------------------------------------------
// HARD remove-liquidity detector
//  - if logs include the word "remove" anywhere => true
//  - OR Burn/BurnChecked + two different mints inflow to the SAME owner => true
//  - OR logs contain "Transfer from Raydium Vault Authority" at least twice => true
// ------------------------------------------------------------------
function isRemoveByAnyMeans(tx){
  const logs = (tx?.meta?.logMessages || []).map(l=>(l||"").toLowerCase());

  // 1) Any "remove" word
  if (logs.some(l=>l.includes("remove"))) return true;

  // 2) Dual inflow + burn
  const hasBurn = getParsedIxs(tx).some(p=>{
    const t=String(p?.type||"").toLowerCase(); return t==="burn"||t==="burnchecked";
  });
  if (hasBurn){
    const map = inflowsByOwner(tx);
    for (const [, mints] of map){ if (mints.size>=2) return true; }
  }

  // 3) Two transfers from Raydium Vault Authority (summary logokban is megjelenik)
  const vaultTransfers = logs.filter(l => l.includes("transfer from") && l.includes("raydium vault authority")).length;
  if (vaultTransfers >= 2) return true;

  return false;
}

// ------------------------------------------------------------------
// Permanent LP burn
// ------------------------------------------------------------------
function isPermanentLpBurn(tx){
  if (isRemoveByAnyMeans(tx)) return false; // hard skip before bármi
  const all = logsLower(tx);
  if (all.includes("incinerator")) return true;

  const lp = extractLpMintFromBurn(tx);
  if (!lp) return false;

  const pct = lpSupplyDropPct(tx, lp);
  if (pct < MIN_LP_BURN_PCT) return false;

  // még egy guard
  if (isRemoveByAnyMeans(tx)) return false;
  return true;
}

// ------------------------------------------------------------------
// Messaging
// ------------------------------------------------------------------
async function sendTelegram(text){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) { log("[TG] disabled"); return; }
  const url=`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url,{
    method:"POST", headers:{ "content-type":"application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode:"HTML", disable_web_page_preview:false })
  });
  if (!res.ok) log("[TG] error", await res.text());
}
function formatAlert(tx, sig){
  const lp = extractLpMintFromBurn(tx) || "Unknown";
  const pct = (lpSupplyDropPct(tx, lp)*100).toFixed(2);
  const lines=[];
  lines.push("🔥🔥 <b>LP BURN DETECTED</b> 🔥🔥");
  lines.push(`🪙 <b>LP Mint</b>: ${pretty(lp)}`);
  lines.push(`📊 <b>Percentage</b>: ${pct}%`);
  lines.push("");
  lines.push(`🔗 <a href="https://solscan.io/tx/${sig}">View on Solscan</a>`);
  return lines.join("\n");
}

// ------------------------------------------------------------------
// Monitor
// ------------------------------------------------------------------
class Monitor{
  constructor(){
    this.conn = new Connection(RPC_HTTP, { commitment:"confirmed", wsEndpoint: RPC_WSS });
    this.queue = [];
    this.detected = new Set();
  }
  async start(){
    log("[Monitor] start RPC:", RPC_HTTP);
    for (const prog of [RAYDIUM_V4, RAYDIUM_CPMM, RAYDIUM_CLMM]){
      this.conn.onLogs(prog, async (ev)=>{
        // HARD log-level skip: if any log line contains "remove" => skip
        if ((ev.logs||[]).some(l => (l||"").toLowerCase().includes("remove"))) {
          dbg(`[SKIP-logs] remove* in logs ${ev.signature.slice(0,8)}…`);
          return;
        }
        if (!this.detected.has(ev.signature)){
          this.detected.add(ev.signature);
          this.queue.push(ev.signature);
          dbg("[queue+]", ev.signature);
        }
      },"confirmed");
    }
    // loop
    while (true){
      const sig = this.queue.shift();
      if (sig){
        const tx = await this.safeGetTx(sig);
        if (tx){
          if (isRemoveByAnyMeans(tx)){
            dbg(`[SKIP-tx] remove-liquidity pattern ${sig}`);
          }else if (isPermanentLpBurn(tx)){
            const msg = formatAlert(tx, sig);
            await sendTelegram(msg);
            log("[ALERT] permanent LP burn", sig);
          }else{
            dbg("[NO BURN]", sig);
          }
        }
        await sleep(RATE_MS);
      }else{
        await sleep(500);
      }
    }
  }
  async safeGetTx(sig, tries=3, delay=500){
    try{
      return await this.conn.getTransaction(sig, { maxSupportedTransactionVersion:0, commitment:"confirmed" });
    }catch(e){
      const m=String(e?.message||"");
      if (tries>0 && (m.includes("429")||m.toLowerCase().includes("too many requests"))){
        await sleep(delay); return this.safeGetTx(sig, tries-1, delay*2);
      }
      dbg("getTransaction error", sig, m);
      return null;
    }
  }
}

// ------------------------------------------------------------------
// Health server + start
// ------------------------------------------------------------------
const app = express();
app.get("/health",(req,res)=>res.json({ok:true}));
app.listen(8080, ()=>log("Health on :8080"));

new Monitor().start().catch(e=>{ console.error("fatal",e); process.exit(1); });
