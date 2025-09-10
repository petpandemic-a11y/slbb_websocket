// index.js — Raydium LP Burn watcher (ultra-low-noise + STRICT_RAYDIUM_PROG)
// Teszt mód (node index.js <signature>) is végigfut a teljes szűrésen és posztol TG-re.
//
// Riasztás csak akkor:
// 1) BurnChecked a logokban
// 2) Raydium authority a burn-ölt minthez
// 3) (opcionális) Raydium program jelen van a tx-ben — STRICT_RAYDIUM_PROG
// 4) Nincs zaj: swap/route/jupiter/meteora stb.
// 5) Nem remove-liq (>=2 nem-LP mint nettó növekedés)
// 6) Burn arány >= MIN_LP_BURN_PCT (default: 0.9)
// 7) Rate limiter queue-val (RATE_MS)

import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';
import fs from 'fs';

// ===== ENV =====
const {
  RPC_HTTP, RPC_WSS,
  TG_BOT_TOKEN, TG_CHAT_ID,

  RATE_MS = '1200',
  MIN_BURN_UI = '0',
  MIN_LP_BURN_PCT = '0.9',
  AUTO_LEARN_AUTHORITIES = '1',
  LOG_ALL_TX = '0',
  DEBUG = '0',

  // Program watch kapcsolók
  WATCH_RAYDIUM_AMM = '1',
  WATCH_RAYDIUM_CPMM = '1',
  WATCH_RAYDIUM_CLMM = '0',
  WATCH_SPL_TOKEN_LEGACY = '0',
  WATCH_SPL_TOKEN_2022 = '0',

  // ha 1 → kötelező Raydium program a message-ben; ha 0 → authority elég
  STRICT_RAYDIUM_PROG = '1',
} = process.env;

const REQUIRE_RAYDIUM = String(STRICT_RAYDIUM_PROG) !== '0';
const dbg = (...a)=>{ if (String(DEBUG)==='1') console.log('[debug]', ...a); };
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));

// ===== Program IDs (Raydium docs) =====
const RAYDIUM_AMM_V4_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CPMM_ID   = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const RAYDIUM_CLMM_ID   = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

// SPL Token programok
const SPL_TOKEN_LEGACY_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022_ID   = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Ismert Raydium mint authority (V4)
const RAYDIUM_AUTHORITY_V4 = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

// Zaj/aggregátor kulcsszavak (logban)
const NOISE_KEYWORDS = ['swap', 'route', 'jupiter', 'aggregator', 'meteora', 'goonfi'];

// ===== Connection =====
if (!RPC_HTTP || !RPC_WSS) {
  console.error('Hiányzik RPC_HTTP vagy RPC_WSS az ENV-ben.');
  process.exit(1);
}
const connection = new Connection(RPC_HTTP, { wsEndpoint: RPC_WSS, commitment: 'confirmed' });

// ===== Helpers =====
function safePk(s){ try { return new PublicKey(String(s).trim()); } catch { console.error('⚠️ Invalid program id:', s); return null; } }
function buildPrograms(){
  const list=[];
  if (String(WATCH_RAYDIUM_AMM)==='1')   list.push(RAYDIUM_AMM_V4_ID);
  if (String(WATCH_RAYDIUM_CPMM)==='1')  list.push(RAYDIUM_CPMM_ID);
  if (String(WATCH_RAYDIUM_CLMM)==='1')  list.push(RAYDIUM_CLMM_ID);
  if (String(WATCH_SPL_TOKEN_LEGACY)==='1') list.push(SPL_TOKEN_LEGACY_ID);
  if (String(WATCH_SPL_TOKEN_2022)==='1')   list.push(SPL_TOKEN_2022_ID);
  return list.map(safePk).filter(Boolean);
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
async function sendTG(html){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try{
    const r=await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,{
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: html, parse_mode:'HTML', disable_web_page_preview:true })
    });
    if (!r.ok) console.error('Telegram error:', r.status, await r.text());
  }catch(e){ console.error('Telegram send failed:', e.message); }
}

// ===== Burn / authority =====
function extractBurns(tx){
  const burns=[];
  try{
    const pre = tx?.meta?.preTokenBalances || [];
    const post= tx?.meta?.postTokenBalances || [];
    const m = new Map(); for (const p of pre) m.set(p.accountIndex, p);
    for (const q of post){
      const p = m.get(q.accountIndex); if (!p) continue;
      const dec = Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const preAmt  = Number(p?.uiTokenAmount?.amount || 0);
      const postAmt = Number(q?.uiTokenAmount?.amount || 0);
      if (postAmt < preAmt) {
        const delta = (preAmt - postAmt) / Math.pow(10, dec);
        if (delta>0) burns.push({ mint:q.mint, amount:delta, preAmt, postAmt, decimals:dec });
      }
    }
  }catch(e){ dbg('extractBurns err:', e.message); }
  return burns;
}
function extractIncreases(tx){
  const incs=[];
  try{
    const pre = tx?.meta?.preTokenBalances || [];
    const post= tx?.meta?.postTokenBalances || [];
    const m = new Map(); for (const p of pre) m.set(p.accountIndex, p);
    for (const q of post){
      const p = m.get(q.accountIndex); if (!p) continue;
      const dec = Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const preAmt  = Number(p?.uiTokenAmount?.amount || 0);
      const postAmt = Number(q?.uiTokenAmount?.amount || 0);
      if (postAmt > preAmt) {
        const delta = (postAmt - preAmt) / Math.pow(10, dec);
        if (delta>0) incs.push({ mint:q.mint, amount:delta, decimals:dec });
      }
    }
  }catch(e){ dbg('extractIncreases err:', e.message); }
  return incs;
}
const mintAuthCache=new Map();
async function fetchMintAuthority(mint){
  if (mintAuthCache.has(mint)) return mintAuthCache.get(mint).authority;
  try{
    const body={jsonrpc:'2.0',id:'mint',method:'getAccountInfo',params:[mint,{encoding:'jsonParsed',commitment:'confirmed'}]};
    const r=await fetch(RPC_HTTP,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json();
    const auth=j?.result?.value?.data?.parsed?.info?.mintAuthority ?? null;
    mintAuthCache.set(mint,{authority:auth,when:Date.now()});
    return auth;
  }catch(e){ return null; }
}
const AUTH_FILE='./raydium_authorities.json';
let learned=new Set([RAYDIUM_AUTHORITY_V4]);
try{
  if (fs.existsSync(AUTH_FILE)){
    const arr=JSON.parse(fs.readFileSync(AUTH_FILE,'utf8'));
    if (Array.isArray(arr)) arr.forEach(a=>learned.add(a));
  }
}catch{}
function persistLearned(){ try{ fs.writeFileSync(AUTH_FILE, JSON.stringify([...learned],null,2)); }catch{} }
async function anyBurnMintHasKnownAuthority(burns){
  for(const b of burns){
    const a=await fetchMintAuthority(b.mint);
    if (a && learned.has(a)) return { ok:true, authority:a, mint:b.mint };
  }
  return { ok:false };
}
async function autoLearnFromTx(tx){
  if (String(AUTO_LEARN_AUTHORITIES)!=='1') return;
  const burns=extractBurns(tx);
  for(const b of burns){
    const a=await fetchMintAuthority(b.mint);
    if (a && !learned.has(a)){
      learned.add(a); persistLearned();
      console.log('[learned]', a, 'mint', b.mint);
    }
  }
}

// ===== Log/tx vizsgálat =====
function hasBurnChecked(logs){
  return (logs||[]).some(l => l?.includes('Instruction: BurnChecked') || l?.includes('Instruction: Burn'));
}
function hasNoise(logs){
  const lower=(logs||[]).join('\n').toLowerCase();
  return NOISE_KEYWORDS.some(k=>lower.includes(k));
}
function hasRaydiumProgramInMessage(tx){
  const keys = tx?.transaction?.message?.accountKeys || [];
  const ids=[RAYDIUM_AMM_V4_ID, RAYDIUM_CPMM_ID, RAYDIUM_CLMM_ID];
  for(const k of keys){
    const s = typeof k === 'string' ? k : k?.toBase58?.();
    if (!s) continue;
    if (ids.includes(s)) return true;
  }
  return false;
}
function looksLikeRemoveLiquidity(burns, increases){
  const lpMints=new Set(burns.map(b=>b.mint));
  const nonLpIncs=increases.filter(x=>!lpMints.has(x.mint) && x.amount>0);
  const distinct=new Set(nonLpIncs.map(x=>x.mint));
  return distinct.size >= 2;
}
function maxBurnPct(burns){
  let maxPct=0;
  for(const b of burns){
    if (b.preAmt>0){
      const pct=(b.preAmt - b.postAmt)/b.preAmt;
      if (pct>maxPct) maxPct=pct;
    }
  }
  return maxPct;
}

// ===== Közös értékelés + TG küldés (éles + teszt ugyanazt használja) =====
async function evaluateAndNotify(sig, tx) {
  const logs = tx?.meta?.logMessages || [];

  // 1) BurnChecked
  if (!hasBurnChecked(logs)){
    console.log('[skip]', sig, 'no_burnchecked');
    return false;
  }

  // 2) (opcionális) Raydium program jelenlét
  if (REQUIRE_RAYDIUM && !hasRaydiumProgramInMessage(tx)){
    dbg('no raydium program (strict mode)');
    console.log('[skip]', sig, 'no_raydium_program_strict');
    return false;
  }

  // 3) zaj szűrés
  if (hasNoise(logs)){
    console.log('[skip]', sig, 'noise_keywords');
    return false;
  }

  const burns=extractBurns(tx);
  const incs =extractIncreases(tx);

  // 4) remove-liq minta
  if (looksLikeRemoveLiquidity(burns, incs)){
    console.log('[skip]', sig, 'remove_liq_pattern');
    return false;
  }

  // 5) authority check
  const hit=await anyBurnMintHasKnownAuthority(burns);
  if (!hit.ok){
    console.log('[skip]', sig, 'no_authority_match');
    return false;
  }

  // 6) min amount + pct
  const totalUi=burns.reduce((s,b)=>s+b.amount,0);
  if (totalUi < Number(MIN_BURN_UI||0)){
    console.log('[skip]', sig, 'too_small');
    return false;
  }
  const pct=maxBurnPct(burns);
  if (pct < Number(MIN_LP_BURN_PCT||0.9)){
    console.log('[skip]', sig, 'pct_too_low', pct.toFixed(3));
    return false;
  }

  await autoLearnFromTx(tx);

  // OK → TG
  const byMint=new Map(); for(const b of burns) byMint.set(b.mint,(byMint.get(b.mint)||0)+b.amount);
  let html = `<b>LP Burn Detected</b> ✅\n<b>Tx:</b> <code>${esc(sig)}</code>\n<b>Evidence:</b> authority${REQUIRE_RAYDIUM?'+raydium':''}+pct≥${Number(MIN_LP_BURN_PCT)}\n`;
  for (const [mint,amt] of byMint.entries()){
    html += `<b>LP Mint:</b> <code>${esc(mint)}</code>\n<b>Burned:</b> ${amt>=1?amt.toLocaleString('en-US',{maximumFractionDigits:4}):amt.toExponential(4)}\n`;
  }
  html += `<a href="https://solscan.io/tx/${encodeURIComponent(sig)}">Solscan</a>`;
  await sendTG(html);
  console.log('[ALERT]', sig);
  return true;
}

// ===== Queue + limiter =====
const RATE=Math.max(150, parseInt(RATE_MS,10)||1200);
const sigQueue=[];
let busy=false, lastSig='-';

function enqueue(sig, prog){
  if (String(LOG_ALL_TX)==='1') console.log('[rx]', sig, 'via', prog);
  sigQueue.push({sig, prog});
  processQueue();
}
async function processQueue(){
  if (busy || sigQueue.length===0) return;
  busy=true;

  const {sig, prog}=sigQueue.shift();
  lastSig=sig;
  console.log('[info] Processing:', sig, 'via', prog, 'queue=', sigQueue.length);

  try{
    const tx=await connection.getTransaction(sig,{maxSupportedTransactionVersion:0, commitment:'confirmed'});
    if (!tx){ console.log('[skip] not_found', sig); return finish(); }

    // közös értékelés + TG
    await evaluateAndNotify(sig, tx);

  }catch(e){
    const m=String(e?.message||e);
    console.error('[err] getTransaction', m);
    if (m.includes('429') || m.toLowerCase().includes('too many requests')){
      sigQueue.unshift({sig, prog});
      await sleep(Math.min(RATE*3, 6000));
    }
  }

  return finish();
  function finish(){
    setTimeout(()=>{ busy=false; if (sigQueue.length>0) processQueue(); }, RATE);
  }
}
setInterval(()=> console.log(`[hb] queue=${sigQueue.length} lastSig=${lastSig}`), 10000);

// ===== Subscribe =====
async function subscribe(){
  const pks=buildPrograms();
  if (pks.length===0){ console.error('Nincs bekapcsolt program (WATCH_*)'); process.exit(1); }
  console.log('[info] Subscribing onLogs to:', pks.map(p=>p.toBase58()).join(', '), '| RATE_MS=', RATE);
  for (const pk of pks){
    await connection.onLogs(pk, (logs)=>{
      const sig=logs?.signature; if (!sig) return;
      enqueue(sig, pk.toBase58().slice(0,6));
    }, 'confirmed');
    console.log('[ok] onLogs subscribed:', pk.toBase58());
  }
}

// ===== Main =====
(async function main(){
  // --- TESZT MÓD: node index.js <signature>  → ugyanaz a pipeline + TG ---
  if (process.argv[2]) {
    const sig=process.argv[2];
    const tx =await connection.getTransaction(sig,{maxSupportedTransactionVersion:0, commitment:'confirmed'});
    if (!tx){
      console.error('Teszt tx nem található');
      return;
    }
    // debug sorok, hogy lásd miért/miért nem menne át
    const logs=tx?.meta?.logMessages||[];
    console.log(
      'hasBurnChecked=', hasBurnChecked(logs),
      'hasRaydiumProg=', hasRaydiumProgramInMessage(tx),
      'noise=', hasNoise(logs)
    );
    const burns=extractBurns(tx), incs=extractIncreases(tx);
    console.log('looksRemoveLiq=', looksLikeRemoveLiquidity(burns,incs), 'maxBurnPct=', maxBurnPct(burns).toFixed(3));
    const hit=await anyBurnMintHasKnownAuthority(burns);
    console.log('authorityHit=', hit.ok, hit.authority||'');

    // itt már NEM csak kiír — lefut a teljes értékelés és ha valid, TG-t is küld
    const ok = await evaluateAndNotify(sig, tx);
    console.log(ok ? '[test] ALERT sent' : '[test] not eligible');
    return;
  }

  console.log('LP Burn watcher starting… (STRICT_RAYDIUM_PROG=', REQUIRE_RAYDIUM ? 'ON' : 'OFF', ')');
  await subscribe();
})();
