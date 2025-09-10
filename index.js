// ========== Raydium LP Burn Monitor — HARD "remove" SKIP ==========
import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';
import express from 'express';
import winston from 'winston';
import dotenv from 'dotenv';

dotenv.config();

// ----------------- CONFIG -----------------
const config = {
  DEBUG: process.env.DEBUG === '1',
  RPC_HTTP: process.env.RPC_HTTP || 'https://api.mainnet-beta.solana.com',
  RPC_WSS: process.env.RPC_WSS || undefined,
  RATE_MS: Number(process.env.RATE_MS || 4000),
  MIN_LP_BURN_PCT: Number(process.env.MIN_LP_BURN_PCT || 0.90),
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || '',
  TG_CHAT_ID: process.env.TG_CHAT_ID || '',
  PORT: Number(process.env.PORT || 8080),
};

// ----------------- LOGGER -----------------
const logger = winston.createLogger({
  level: config.DEBUG ? 'debug' : 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}] ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// ----------------- CONSTS -----------------
const RAYDIUM_V4   = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM = new PublicKey('CAMMCzo5YL8w4VFF8KVHRk22GGUsp5VTaW7girrKgIrw');
const RAYDIUM_CLMM = new PublicKey('RVKd61ztZW9GUwhQYvDTKHzYS4sV6sKRQ39SL7jdpT2');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const INCINERATOR = '1nc1nerator11111111111111111111111111111111';

const prettyMint = (m) => (!m ? 'Unknown' : (m === WSOL_MINT ? 'SOL' : `${m.slice(0,4)}…${m.slice(-4)}`));

// ----------------- HELPERS -----------------
const joinLogsLower = (tx) => (tx?.meta?.logMessages || []).join(' ').toLowerCase();
const getParsedIxs = (tx) => (tx?.transaction?.message?.instructions || []).map(i => i.parsed).filter(Boolean);

function buildTokenMap(tx){
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const map = new Map();
  for (const b of pre){
    map.set(b.accountIndex, {
      owner:b.owner, mint:b.mint,
      pre:Number(b.uiTokenAmount?.uiAmountString||b.uiTokenAmount?.uiAmount||0),
      post:0
    });
  }
  for (const b of post){
    const r = map.get(b.accountIndex) || { owner:b.owner, mint:b.mint, pre:0, post:0 };
    r.owner=b.owner; r.mint=b.mint;
    r.post=Number(b.uiTokenAmount?.uiAmountString||b.uiTokenAmount?.uiAmount||0);
    map.set(b.accountIndex, r);
  }
  return map;
}

function inflowsByOwner(tx){
  const m = buildTokenMap(tx);
  const res = new Map();
  for (const [, r] of m){
    const d = r.post - r.pre;
    if (d > 0){
      if (!res.has(r.owner)) res.set(r.owner, new Set());
      res.get(r.owner).add(r.mint);
    }
  }
  return res;
}

function extractLpMintFromBurn(tx){
  for (const p of getParsedIxs(tx)){
    const t = String(p?.type||'').toLowerCase();
    if ((t === 'burn' || t === 'burnchecked') && p.info?.mint) return p.info.mint;
  }
  return null;
}

function lpSupplyDropPct(tx, lpMint){
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  let preSum = 0, postSum = 0;
  for (const b of pre)  if (b.mint === lpMint) preSum  += Number(b.uiTokenAmount?.uiAmountString||b.uiTokenAmount?.uiAmount||0);
  for (const b of post) if (b.mint === lpMint) postSum += Number(b.uiTokenAmount?.uiAmountString||b.uiTokenAmount?.uiAmount||0);
  if (preSum <= 0) return 0;
  return Math.max(0, preSum - postSum) / preSum;
}

// ----------------- HARD REMOVE FILTERS -----------------
// 1) Log-szinten bármi, ami "remove" → SKIP (kis/nagybetű mindegy)
function logsContainRemove(logs){
  return (logs || []).some(l => l && l.toLowerCase().includes('remove'));
}

// 2) Tranzakció-szinten: csak a "remove" szóra nézünk
function isRemoveLiquidityTx(tx){
  try{
    return joinLogsLower(tx).includes('remove');
  }catch(e){
    logger.warn(`isRemoveLiquidityTx failed: ${e.message}`);
    return false;
  }
}

// ----------------- PERMANENT LP BURN -----------------
function isPermanentLpBurn(tx){
  // hard skip
  if (isRemoveLiquidityTx(tx)) return false;

  const logs = joinLogsLower(tx);
  if (logs.includes('incinerator')) return true;

  const lp = extractLpMintFromBurn(tx);
  if (!lp) return false;

  const pct = lpSupplyDropPct(tx, lp);
  if (pct < config.MIN_LP_BURN_PCT) return false;

  // biztos, ami biztos
  if (isRemoveLiquidityTx(tx)) return false;
  return true;
}

// ----------------- TELEGRAM -----------------
async function sendTelegram(text){
  if (!config.TG_BOT_TOKEN || !config.TG_CHAT_ID) { logger.debug('[TG] disabled'); return; }
  const url = `https://api.telegram.org/bot${config.TG_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body: JSON.stringify({ chat_id: config.TG_CHAT_ID, text, parse_mode:'HTML', disable_web_page_preview:false })
  });
  if (!res.ok){
    logger.error(`[TG] ${res.status} ${await res.text()}`);
  }
}

function formatAlert(tx, sig){
  const lp = extractLpMintFromBurn(tx) || 'Unknown';
  const pct = (lpSupplyDropPct(tx, lp) * 100).toFixed(2);
  return [
    '🔥🔥 <b>LP BURN DETECTED</b> 🔥🔥',
    `🪙 <b>LP Mint</b>: ${prettyMint(lp)}`,
    `📊 <b>Percentage</b>: ${pct}%`,
    '',
    `🔗 <a href="https://solscan.io/tx/${sig}">View on Solscan</a>`
  ].join('\n');
}

// ----------------- MONITOR -----------------
class RaydiumLPBurnMonitor {
  constructor(){
    this.conn = new Connection(config.RPC_HTTP, { commitment: 'confirmed', wsEndpoint: config.RPC_WSS });
    this.queue = [];
    this.seen = new Set();
  }

  async start(){
    logger.info(`[START] RPC: ${config.RPC_HTTP}`);
    for (const prog of [RAYDIUM_V4, RAYDIUM_CPMM, RAYDIUM_CLMM]){
      this.conn.onLogs(prog, async (ev) => {
        // HARD: ha a logokban bárhol "remove", akkor skip
        if (logsContainRemove(ev.logs)) {
          logger.debug(`[SKIP-logs] 'remove' szó: ${ev.signature.slice(0,8)}…`);
          return;
        }
        if (!this.seen.has(ev.signature)){
          this.seen.add(ev.signature);
          this.queue.push(ev.signature);
          logger.debug(`[queue+] ${ev.signature}`);
        }
      }, 'confirmed');
    }

    // loop
    while (true){
      const sig = this.queue.shift();
      if (!sig){ await new Promise(r=>setTimeout(r,200)); continue; }
      await this.processSig(sig);
      await new Promise(r=>setTimeout(r, config.RATE_MS));
    }
  }

  async processSig(sig){
    const tx = await this.safeGetTx(sig);
    if (!tx || !tx.meta){
      logger.debug(`[NO TX] ${sig}`);
      return;
    }

    // HARD skip újra a biztonság kedvéért
    if (isRemoveLiquidityTx(tx)){
      logger.debug(`[SKIP-tx] 'remove' a logban: ${sig}`);
      return;
    }

    if (isPermanentLpBurn(tx)){
      const msg = formatAlert(tx, sig);
      await sendTelegram(msg);
      logger.info(`[ALERT] Permanent LP burn: ${sig}`);
    } else {
      logger.debug(`[NO BURN] ${sig}`);
    }
  }

  async safeGetTx(signature, tries=3, delay=500){
    try{
      return await this.conn.getTransaction(signature, { maxSupportedTransactionVersion:0, commitment:'confirmed' });
    }catch(e){
      const m = String(e?.message||'');
      if (tries>0 && (m.includes('429') || m.toLowerCase().includes('too many requests'))){
        await new Promise(r=>setTimeout(r, delay));
        return this.safeGetTx(signature, tries-1, delay*2);
      }
      logger.debug(`getTransaction error ${signature}: ${m}`);
      return null;
    }
  }
}

// ----------------- SERVER + MAIN -----------------
const app = express();
app.get('/health', (req,res)=>res.json({ ok:true }));
app.listen(config.PORT, ()=> logger.info(`[HTTP] health on :${config.PORT}`));

new RaydiumLPBurnMonitor().start().catch(e => { logger.error(`fatal: ${e.message}`); process.exit(1); });

// ----------------- (Optional) BURN PATTERN HELPER -----------------
// Ha máshol is hívod, itt is a "remove" hard-skip van beégetve.
export function detectBurnPattern(logs){
  if (!logs) return false;
  for (const log of logs){
    const lower = (log || '').toLowerCase();
    if (lower.includes('remove')) return false;     // <<< HARD SKIP
    if (lower.includes('swap')) return false;
    if (lower.includes('burn') || log.includes('Instruction: BurnChecked') || log.includes('Instruction: Burn')){
      return true;
    }
  }
  return false;
}
