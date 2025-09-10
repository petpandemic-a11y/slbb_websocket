// index.js — Raydium LP Burn watcher (PURE BURN mode)
// - PURE_BURN_ONLY=1  → csak akkor alert, ha a tx-ben CSAK LP csökkenés van, nincs más token változás és nincs SPL Transfer/MintTo.
// - STRICT_RAYDIUM_PROG=1 → Raydium program jelenlét kötelező (opcionális).
// - STRICT_NO_NONLP_INCREASE=1 → bármely nem-LP növekmény esetén dob (extra védelem).
// - WSS_PREFILTER=1, WSS_BURN_ONLY=1, WSS_SKIP_NOISE=1 → alacsony zaj + alacsony RPC terhelés.

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

  WATCH_RAYDIUM_AMM = '1',
  WATCH_RAYDIUM_CPMM = '1',
  WATCH_RAYDIUM_CLMM = '0',
  WATCH_SPL_TOKEN_LEGACY = '1',
  WATCH_SPL_TOKEN_2022 = '1',

  STRICT_RAYDIUM_PROG = '0',

  WSS_PREFILTER = '1',
  WSS_BURN_ONLY = '1',
  WSS_SKIP_NOISE = '1',

  STRICT_NO_NONLP_INCREASE = '1',

  // ÚJ: csak "tiszta burn" riasztás
  PURE_BURN_ONLY = '0',
} = process.env;

const dbg = (...a)=>{ if (String(DEBUG)==='1') console.log('[debug]', ...a); };
if (!RPC_HTTP || !RPC_WSS) { console.error('Hiányzik RPC_HTTP vagy RPC_WSS.'); process.exit(1); }

const connection = new Connection(RPC_HTTP, { wsEndpoint: RPC_WSS, commitment: 'confirmed' });

const REQUIRE_RAYDIUM = String(STRICT_RAYDIUM_PROG) !== '0';
const PREFILTER = String(WSS_PREFILTER) === '1';
const PREFILTER_BURN_ONLY = String(WSS_BURN_ONLY) !== '0';
const PREFILTER_SKIP_NOISE = String(WSS_SKIP_NOISE) !== '0';
const NO_NONLP = String(STRICT_NO_NONLP_INCREASE) !== '0';
const PURE_ONLY = String(PURE_BURN_ONLY) !== '0';
const RATE = Math.max(150, parseInt(RATE_MS,10)||1200);

const NOISE_KEYWORDS = ['swap','route','jupiter','aggregator','meteora','goonfi'];

// ===== Program IDs (Raydium docs) =====
const RAYDIUM_AMM_V4_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CPMM_ID   = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const RAYDIUM_CLMM_ID   = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const SPL_TOKEN_LEGACY_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022_ID   = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const RAYDIUM_AUTHORITY_V4 = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

// ===== Helpers =====
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function safePk(s){ try{ return new PublicKey(String(s).trim()); }catch{ console.error('⚠️ Invalid program id:', s); return null; } }
function buildPrograms(){
  const list=[];
  if (String(WATCH_RAYDIUM_AMM)==='1')      list.push(RAYDIUM_AMM_V4_ID);
  if (String(WATCH_RAYDIUM_CPMM)==='1')     list.push(RAYDIUM_CPMM_ID);
  if (String(WATCH_RAYDIUM_CLMM)==='1')     list.push(RAYDIUM_CLMM_ID);
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

// ===== Burn / balances =====
function extractBurns(tx){
  const burns=[];
  try{
    const pre = tx?.meta?.preTokenBalances || [];
    const post= tx?.meta?.postTokenBalances || [];
    const m = new Map(); for (const p of pre) m.set(p.accountIndex, p);
    for (const q of post){
      const p = m.get(q.accountIndex);
      if (!p) continue; // burnhez csökkenés kell, ehhez kell pre
      const dec = Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const preAmt  = Number(p?.uiTokenAmount?.amount || 0);
      const postAmt = Number(q?.uiTokenAmount?.amount || 0);
      if (postAmt < preAmt) {
        const delta = (preAmt - postAmt) / Math.pow(10, dec);
        if (delta>0) burns.push({ mint:q.mint, amount:delta, preAmt, postAmt, decimals:dec, owner:q?.owner||p?.owner });
      }
    }
  }catch(e){ dbg('extractBurns err:', e.message); }
  return burns;
}

// pre nélküli (új ATA) növekmény felismerése is
function extractIncreases(tx){
  const incs=[];
  try{
    const pre = tx?.meta?.preTokenBalances || [];
    const post= tx?.meta?.postTokenBalances || [];
    const m = new Map(); for (const p of pre) m.set(p.accountIndex, p);
    for (const q of post){
      const p = m.get(q.accountIndex);
      const dec = Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const preAmt  = Number(p?.uiTokenAmount?.amount || 0);   // ha nincs pre → 0
      const postAmt = Number(q?.uiTokenAmount?.amount || 0);
      if (postAmt > preAmt) {
        const delta = (postAmt - preAmt) / Math.pow(10, dec);
        if (delta>0) incs.push({ mint:q.mint || p?.mint, amount:delta, decimals:dec, owner:q?.owner });
      }
    }
  }catch(e){ dbg('extractIncreases err:', e.message); }
  return incs;
}

function getSigners(tx){
  try{
    const msg = tx?.transaction?.message;
    const n = msg?.header?.numRequiredSignatures || 0;
    const keys = msg?.accountKeys || [];
    const arr=[];
    for (let i=0;i<n && i<keys.length;i++){
      const s = typeof keys[i]==='string' ? keys[i] : keys[i]?.toBase58?.();
      if (s) arr.push(s);
    }
    return new Set(arr);
  }catch{ return new Set(); }
}

// authority cache + learning
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
try{ if (fs.existsSync(AUTH_FILE)){ const arr=JSON.parse(fs.readFileSync(AUTH_FILE,'utf8')); if (Array.isArray(arr)) arr.forEach(a=>learned.add(a)); } }catch{}
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
    if (a && !learned.has(a)){ learned.add(a); persistLearned(); console.log('[learned]', a, 'mint', b.mint); }
  }
}

// ===== Log/tx vizsgálat =====
function hasBurnChecked(logs){
  return (logs||[]).some(l => l?.includes('Instruction: BurnChecked') || l?.includes('Instruction: Burn'));
}
function hasNoise(logs){
  const text = (Array.isArray(logs) ? logs.join('\n') : String(logs)).toLowerCase();
  return NOISE_KEYWORDS.some(k=>text.includes(k));
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

// remove-liq felismerés (több réteg)
function looksLikeRemoveLiquidity(tx, burns, increases){
  const logs = tx?.meta?.logMessages || [];
  const txt = (logs || []).join('\n');
  if (/(remove[\s_-]*liquidity|removeliquidity|withdraw[\s_-]*liquidity|withdrawliquidity|burn\s+lp)/i.test(txt)) {
    return true;
  }
  const lpMints = new Set(burns.map(b => b.mint));
  const nonLpIncs = (increases || []).filter(x => !lpMints.has(x.mint) && x.amount > 0);
  if (nonLpIncs.length >= 2) return true;

  const keys = tx?.transaction?.message?.accountKeys || [];
  const hasRayAuthInMsg = keys.some(k=>{
    const s = typeof k === 'string' ? k : k?.toBase58?.();
    return s === RAYDIUM_AUTHORITY_V4;
  });
  if (hasRayAuthInMsg) {
    const signers = getSigners(tx);
    const toSigner = nonLpIncs.filter(x => x.owner && signers.has(x.owner));
    if (toSigner.length >= 1) return true;
  }
  return false;
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

// --- ÚJ: PURE BURN VALIDÁTOR ---
function isPureBurn(tx, burns) {
  try {
    const pre = tx?.meta?.preTokenBalances || [];
    const post = tx?.meta?.postTokenBalances || [];
    if (!pre.length && !post.length) return false;

    const lpMints = new Set(burns.map(b => b.mint));
    if (lpMints.size === 0) return false;

    // Ne legyen SPL Transfer / MintTo
    const logs = tx?.meta?.logMessages || [];
    const hasTransferLike = (logs || []).some(l =>
      /Instruction:\s*Transfer/i.test(l) || /Instruction:\s*MintTo/i.test(l)
    );
    if (hasTransferLike) return false;

    // Csak LP mint(ek) csökkenhetnek, más token NEM változhat
    const mapPre = new Map(pre.map(p => [p.accountIndex, p]));
    let anyLpDecrease = false;

    for (const q of post) {
      const p = mapPre.get(q.accountIndex);
      const dec = Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const preAmt  = Number(p?.uiTokenAmount?.amount || 0);
      const postAmt = Number(q?.uiTokenAmount?.amount || 0);
      const mint = q.mint || p?.mint;

      if (lpMints.has(mint)) {
        if (postAmt > preAmt) return false;          // LP-nél növekmény TILOS
        if (postAmt < preAmt) anyLpDecrease = true;  // legalább egy csökkenés legyen
      } else {
        if (postAmt !== preAmt) return false;        // nem-LP-nél bármilyen változás tiltott
      }
    }

    // Eltűnt pre-számla (account close) vizsgálat
    const postIdx = new Set(post.map(x => x.accountIndex));
    for (const p of pre) {
      if (!postIdx.has(p.accountIndex)) {
        const isLp = lpMints.has(p.mint);
        const preAmt = Number(p?.uiTokenAmount?.amount || 0);
        if (isLp) {
          anyLpDecrease = anyLpDecrease || preAmt > 0; // LP 0-ra égett -> OK
        } else {
          if (preAmt !== 0) return false; // nem-LP eltűnése változást jelez -> NEM pure
        }
      }
    }

    return anyLpDecrease;
  } catch {
    return false;
  }
}

// ===== Értékelés + TG =====
async function evaluateAndNotify(sig, tx) {
  const logs = tx?.meta?.logMessages || [];

  if (!hasBurnChecked(logs)){ console.log('[skip]', sig, 'no_burnchecked'); return false; }

  // PURE BURN mód: már itt levágjuk
  if (PURE_ONLY) {
    const burns = extractBurns(tx);
    if (!isPureBurn(tx, burns)) {
      console.log('[skip]', sig, 'not_pure_burn');
      return false;
    }
  }

  if (REQUIRE_RAYDIUM && !hasRaydiumProgramInMessage(tx)){ console.log('[skip]', sig, 'no_raydium_program_strict'); return false; }
  if (hasNoise(logs)){ console.log('[skip]', sig, 'noise_keywords'); return false; }

  const burns=extractBurns(tx);
  const incs =extractIncreases(tx);

  // remove-liq klasszikus minták
  if (looksLikeRemoveLiquidity(tx, burns, incs)){ console.log('[skip]', sig, 'remove_liq_pattern'); return false; }

  // NINCS megengedett nem-LP növekmény
  if (NO_NONLP) {
    const lpMints = new Set(burns.map(b => b.mint));
    const nonLpIncs = incs.filter(x => !lpMints.has(x.mint) && x.amount > 0);
    if (nonLpIncs.length > 0) {
      console.log('[skip]', sig, 'nonlp_increase_present');
      return false;
    }
  }

  const hit=await anyBurnMintHasKnownAuthority(burns);
  if (!hit.ok){ console.log('[skip]', sig, 'no_authority_match'); return false; }

  const totalUi=burns.reduce((s,b)=>s+b.amount,0);
  if (totalUi < Number(MIN_BURN_UI||0)){ console.log('[skip]', sig, 'too_small'); return false; }
  const pct=maxBurnPct(burns);
  if (pct < Number(MIN_LP_BURN_PCT||0.9)){ console.log('[skip]', sig, 'pct_too_low', pct.toFixed(3)); return false; }

  await autoLearnFromTx(tx);

  const byMint=new Map(); for(const b of burns) byMint.set(b.mint,(byMint.get(b.mint)||0)+b.amount);
  let html = `<b>LP Burn Detected</b> ✅\n<b>Tx:</b> <code>${esc(sig)}</code>\n<b>Evidence:</b> ${PURE_ONLY?'pure_burn+':''}authority${REQUIRE_RAYDIUM?'+raydium':''}+pct≥${Number(MIN_LP_BURN_PCT)}\n`;
  for (const [mint,amt] of byMint.entries()){
    html += `<b>LP Mint:</b> <code>${esc(mint)}</code>\n<b>Burned:</b> ${amt>=1?amt.toLocaleString('en-US',{maximumFractionDigits:4}):amt.toExponential(4)}\n`;
  }
  html += `<a href="https://solscan.io/tx/${encodeURIComponent(sig)}">Solscan</a>`;
  await sendTG(html);
  console.log('[ALERT]', sig);
  return true;
}

// ===== Queue & limiter =====
const sigQueue=[]; let busy=false, lastSig='-';
function enqueue(sig, prog){ if (String(LOG_ALL_TX)==='1') console.log('[rx]', sig, 'via', prog); sigQueue.push({sig, prog}); processQueue(); }
async function processQueue(){
  if (busy || sigQueue.length===0) return; busy=true;
  const {sig, prog}=sigQueue.shift(); lastSig=sig;
  console.log('[info] Processing:', sig, 'via', prog, 'queue=', sigQueue.length);
  try{
    const tx=await connection.getTransaction(sig,{maxSupportedTransactionVersion:0, commitment:'confirmed'});
    if (!tx){ console.log('[skip] not_found', sig); return fin(); }
    await evaluateAndNotify(sig, tx);
  }catch(e){
    const m=String(e?.message||e); console.error('[err] getTransaction', m);
    if (m.includes('429') || m.toLowerCase().includes('too many requests')){
      sigQueue.unshift({sig, prog}); await sleep(Math.min(RATE*3, 6000));
    }
  }
  return fin();
  function fin(){ setTimeout(()=>{ busy=false; if (sigQueue.length>0) processQueue(); }, RATE); }
}
setInterval(()=> console.log(`[hb] queue=${sigQueue.length} lastSig=${lastSig}`), 10000);

// ===== Subscribe (WSS előszűrés) =====
async function subscribe(){
  const pks=buildPrograms();
  if (pks.length===0){ console.error('Nincs bekapcsolt program (WATCH_*)'); process.exit(1); }
  console.log('[info] onLogs subscribe:', pks.map(p=>p.toBase58()).join(', '), '| RATE_MS=', RATE, '| PREFILTER=', PREFILTER, '| PURE_BURN_ONLY=', PURE_ONLY);

  for (const pk of pks){
    await connection.onLogs(pk, (ev)=>{
      const sig = ev?.signature; if (!sig) return;
      let pass = true;
      if (PREFILTER){
        const ll = ev?.logs || []; const text = (Array.isArray(ll)?ll.join('\n'):String(ll));
        if (PREFILTER_BURN_ONLY && !(/Instruction:\s*BurnChecked|Instruction:\s*Burn/i.test(text))) pass=false;
        if (pass && PREFILTER_SKIP_NOISE && /(swap|route|jupiter|aggregator|meteora|goonfi)/i.test(text)) pass=false;
        if (pass && /(remove[\s_-]*liquidity|removeliquidity|withdraw[\s_-]*liquidity|withdrawliquidity|burn\s+lp)/i.test(text)) pass=false;
      }
      if (pass) enqueue(sig, pk.toBase58().slice(0,6));
      else if (String(DEBUG)==='1') console.log('[prefilter-skip]', sig);
    }, 'confirmed');
    console.log('[ok] subscribed:', pk.toBase58());
  }
}

// ===== Main =====
(async function main(){
  // Teszt mód: node index.js <sig>  → felküld TG-re is, hogy lásd az eredményt
  if (process.argv[2]) {
    const sig=process.argv[2];
    const tx =await connection.getTransaction(sig,{maxSupportedTransactionVersion:0, commitment:'confirmed'});
    if (!tx){
      await sendTG(`<b>Teszt mód</b> ❌ Tx nem található: <code>${esc(sig)}</code>`);
      return;
    }
    const logs=tx?.meta?.logMessages||[];
    const burns=extractBurns(tx), incs=extractIncreases(tx);
    console.log(
      'hasBurnChecked=', hasBurnChecked(logs),
      'hasRaydiumProg=', hasRaydiumProgramInMessage(tx),
      'noise=', hasNoise(logs),
      'looksRemoveLiq=', looksLikeRemoveLiquidity(tx,burns,incs),
      'nonLPincs=', incs.filter(x=>!new Set(burns.map(b=>b.mint)).has(x.mint)).length
    );
    const hit=await anyBurnMintHasKnownAuthority(burns); console.log('authorityHit=', hit.ok, hit.authority||'');
    const ok = await evaluateAndNotify(sig, tx);
    await sendTG(ok ? `<b>Teszt mód</b> ✅ Alert elküldve\n<code>${esc(sig)}</code>` : `<b>Teszt mód</b> ⛔ Szűrő dobta\n<code>${esc(sig)}</code>`);
    return;
  }
  console.log('LP Burn watcher starting…',
    'STRICT_RAYDIUM_PROG=', REQUIRE_RAYDIUM?'ON':'OFF',
    '| STRICT_NO_NONLP_INCREASE=', NO_NONLP?'ON':'OFF',
    '| PURE_BURN_ONLY=', PURE_ONLY?'ON':'OFF');
  await subscribe();
})();
