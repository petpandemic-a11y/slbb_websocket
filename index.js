// index.js — LP Burn watcher (web3.js onLogs + rate limiter + TG)
// ENV (példa):
// RPC_HTTP=...https://...helius-rpc.com/?api-key=...
// RPC_WSS=wss://...helius-rpc.com/?api-key=...
// TG_BOT_TOKEN=123456:ABC...   TG_CHAT_ID=-1001234...
// RATE_MS=1000
// WATCH_RAYDIUM_AMM=1
// WATCH_RAYDIUM_CPMM=1
// WATCH_TOKEN_2022=0
// WATCH_TOKEN_LEGACY=0
// LOG_ALL_TX=0
// AUTO_LEARN_AUTHORITIES=1
// MIN_BURN_UI=0

import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';
import fs from 'fs';

// ===== ENV =====
const {
  RPC_HTTP,
  RPC_WSS,
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  RATE_MS = '1000',

  WATCH_RAYDIUM_AMM = '1',
  WATCH_RAYDIUM_CPMM = '1',
  WATCH_TOKEN_2022 = '0',
  WATCH_TOKEN_LEGACY = '0',

  LOG_ALL_TX = '0',
  AUTO_LEARN_AUTHORITIES = '1',
  MIN_BURN_UI = '0',
  DEBUG = '0'
} = process.env;

const dbg = (...a)=>{ if (String(DEBUG)==='1') console.log('[debug]', ...a); };
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));

// ===== Program IDs =====
// Megjegyzés: ha bármelyik ID hibás lenne, safePk() kihagyja és nem áll le a worker.
const RAYDIUM_AMM_ID   = 'CAMMCzo5YL8w4VFF8KVHRk22GGUsp5VTaW7girrKgIrwQk'; // Raydium AMM v4 (ha hibásnak jelzi, egyszerűen kimarad)
const RAYDIUM_CPMM_ID  = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';   // Raydium CPMM
const TOKEN_2022_ID    = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';   // SPL Token-2022
const TOKEN_LEGACY_ID  = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';     // SPL Token (legacy)

// Raydium mint authority (V4)
const RAYDIUM_AUTHORITY_V4 = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

// ===== Connection =====
const connection = new Connection(RPC_HTTP, {
  wsEndpoint: RPC_WSS,
  commitment: 'confirmed'
});

// ===== Safe PublicKey =====
function safePk(s) {
  try {
    const pk = new PublicKey(String(s).trim());
    return pk;
  } catch {
    console.error('⚠️ Invalid program id:', s);
    return null;
  }
}

function buildPrograms() {
  const list = [];
  if (String(WATCH_RAYDIUM_AMM)==='1')  list.push(RAYDIUM_AMM_ID);
  if (String(WATCH_RAYDIUM_CPMM)==='1') list.push(RAYDIUM_CPMM_ID);
  if (String(WATCH_TOKEN_2022)==='1')   list.push(TOKEN_2022_ID);
  if (String(WATCH_TOKEN_LEGACY)==='1') list.push(TOKEN_LEGACY_ID);
  return list.map(safePk).filter(Boolean);
}

// ===== Telegram (HTML) =====
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
async function sendTG(html) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,{
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: html, parse_mode:'HTML', disable_web_page_preview:true })
    });
    if (!r.ok) console.error('Telegram error:', r.status, await r.text());
  } catch(e){ console.error('Telegram send failed:', e.message); }
}

// ===== Burn extraction helpers =====
function extractBurns(tx){
  const burns=[];
  try{
    const pre = tx?.meta?.preTokenBalances || [];
    const post= tx?.meta?.postTokenBalances || [];
    const m = new Map(); for(const p of pre) m.set(p.accountIndex, p);
    for(const q of post){
      const p = m.get(q.accountIndex); if(!p) continue;
      const dec = Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const preAmt  = Number(p?.uiTokenAmount?.amount || 0);
      const postAmt = Number(q?.uiTokenAmount?.amount || 0);
      if (postAmt < preAmt) {
        const delta = (preAmt - postAmt)/Math.pow(10, dec);
        if (delta > 0) burns.push({ mint: q.mint, amount: delta });
      }
    }
  }catch(e){ dbg('extractBurns err:', e.message); }
  return burns;
}

const mintAuthCache = new Map();
async function fetchMintAuthority(mint){
  if (mintAuthCache.has(mint)) return mintAuthCache.get(mint).authority;
  try{
    const body={jsonrpc:'2.0', id:'mint', method:'getAccountInfo', params:[mint, {encoding:'jsonParsed', commitment:'confirmed'}]};
    const r=await fetch(RPC_HTTP,{method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
    const j=await r.json();
    const auth = j?.result?.value?.data?.parsed?.info?.mintAuthority ?? null;
    mintAuthCache.set(mint, { authority: auth, when: Date.now() });
    return auth;
  }catch(e){ dbg('fetchMintAuthority err:', e.message); return null; }
}

// === Learned authorities (persist) ===
const AUTH_FILE = './raydium_authorities.json';
let learned = new Set([RAYDIUM_AUTHORITY_V4]);
try{
  if (fs.existsSync(AUTH_FILE)) {
    const arr = JSON.parse(fs.readFileSync(AUTH_FILE,'utf8'));
    if (Array.isArray(arr)) arr.forEach(a=> learned.add(a));
  }
}catch{}
function persistLearned(){
  try{ fs.writeFileSync(AUTH_FILE, JSON.stringify([...learned], null, 2)); }catch{}
}

async function anyBurnMintHasKnownAuthority(burns){
  for(const b of burns){
    const a = await fetchMintAuthority(b.mint);
    if (a && learned.has(a)) return { ok:true, authority:a };
  }
  return { ok:false };
}

async function autoLearnFromTx(tx){
  if (String(AUTO_LEARN_AUTHORITIES)!=='1') return;
  const burns = extractBurns(tx);
  for(const b of burns){
    const a = await fetchMintAuthority(b.mint);
    if (a && !learned.has(a)) {
      learned.add(a); persistLearned();
      console.log('[learned] authority:', a, ' mint:', b.mint);
    }
  }
}

function sumBurnUi(burns){ return burns.reduce((s,b)=> s+(Number.isFinite(b.amount)?b.amount:0),0); }

async function checkPureLPBurn(tx){
  const burns = extractBurns(tx);
  if (burns.length===0) return { ok:false, reason:'no_lp_delta' };
  if (sumBurnUi(burns) < Number(MIN_BURN_UI||0)) return { ok:false, reason:'too_small' };

  const hit = await anyBurnMintHasKnownAuthority(burns);
  if (!hit.ok) return { ok:false, reason:'no_authority_match' };
  return { ok:true, burns, evidence:'authority' };
}

function formatAlert(tx, info){
  const sig = tx?.transaction?.signatures?.[0] || '';
  const byMint=new Map(); for(const b of info.burns) byMint.set(b.mint,(byMint.get(b.mint)||0)+b.amount);

  let html = `<b>LP Burn Detected</b> ✅\n`;
  if (sig) html += `<b>Tx:</b> <code>${esc(sig)}</code>\n`;
  html += `<b>Evidence:</b> ${esc(info.evidence)}\n`;
  for(const [mint,amt] of byMint.entries()){
    html += `<b>LP Mint:</b> <code>${esc(mint)}</code>\n<b>Burned:</b> ${esc(
      Math.abs(amt)>=1 ? amt.toLocaleString('en-US',{maximumFractionDigits:4}) : amt.toExponential(4)
    )}\n`;
  }
  if (sig) html += `<a href="https://solscan.io/tx/${encodeURIComponent(sig)}">Solscan</a>`;
  return html;
}

// ===== Queue + rate limiter =====
const RATE = Math.max(100, parseInt(RATE_MS,10)||1000);
const sigQueue = [];
let busy = false;
let lastSig = '-';

function enqueue(sig, prog){
  if (String(LOG_ALL_TX)==='1') console.log('[rx]', sig, 'via', prog);
  sigQueue.push({sig, prog});
  processQueue();
}

async function processQueue(){
  if (busy || sigQueue.length===0) return;
  busy = true;

  const {sig, prog} = sigQueue.shift();
  lastSig = sig;
  console.log(`[info] Processing: ${sig} (via ${prog}) | queue=${sigQueue.length}`);

  try{
    const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment:'confirmed' });
    if (!tx) {
      console.log('[skip] not_found:', sig);
    } else {
      await autoLearnFromTx(tx);
      const chk = await checkPureLPBurn(tx);
      if (chk.ok) {
        const msg = formatAlert(tx, chk);
        await sendTG(msg);
        console.log('[ALERT]', sig, 'evidence=', chk.evidence);
      } else {
        console.log('[skip]', sig, 'reason=', chk.reason);
      }
    }
  } catch(e){
    const m = String(e?.message||e);
    console.error('[err] getTransaction:', m);
    // 429 / throttle: tegyük vissza a sor elejére kis várakozás után
    if (m.includes('429') || m.toLowerCase().includes('too many requests')) {
      sigQueue.unshift({sig, prog});
      await sleep(Math.min(RATE*3, 6000));
    }
  }

  await sleep(RATE);
  busy = false;
  if (sigQueue.length>0) processQueue();
}

// Heartbeat a Render logba
setInterval(()=> console.log(`[hb] queue=${sigQueue.length} lastSig=${lastSig}`), 10000);

// ===== Subscribe via onLogs =====
async function subscribe(){
  const progs = buildPrograms();
  if (progs.length===0) {
    console.error('Nincs bekapcsolt program figyeléshez (ENV WATCH_*).');
    process.exit(1);
  }
  console.log('[info] Subscribing (onLogs) to:', progs.map(p=>p.toBase58()).join(', '), ' | RATE_MS=', RATE);

  for(const pk of progs){
    try{
      await connection.onLogs(pk, (logs)=>{
        const sig = logs?.signature;
        if (!sig) return;
        enqueue(sig, pk.toBase58().slice(0,6));
      }, 'confirmed');
      console.log('[ok] onLogs subscribed:', pk.toBase58());
    }catch(e){
      console.error('[err] onLogs subscribe failed for', pk?.toBase58?.()||'?', e?.message||e);
    }
  }
}

// ===== Main =====
(async function main(){
  if (!RPC_HTTP || !RPC_WSS) {
    console.error('Hiányzik RPC_HTTP vagy RPC_WSS az ENV-ben.');
    process.exit(1);
  }

  // Teszt mód: node index.js <signature>
  if (process.argv[2]) {
    const sig = process.argv[2];
    const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment:'confirmed' });
    if (!tx) { console.error('Teszt tx nem található'); return; }
    await autoLearnFromTx(tx);
    const chk = await checkPureLPBurn(tx);
    console.log('TEST', sig, 'ok=', chk.ok, 'reason=', chk.reason);
    if (chk.ok) await sendTG(formatAlert(tx, chk));
    return;
  }

  console.log('LP Burn watcher starting (onLogs + rate limiter)…');
  await subscribe();
})();
