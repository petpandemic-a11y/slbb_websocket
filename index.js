// index.js — LP-only burn watcher (STRICT): authority whitelist + (optional) LP program context + PURE burn

import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';

// ===== ENV =====
const {
  RPC_HTTP, RPC_WSS,
  TG_BOT_TOKEN, TG_CHAT_ID,

  RATE_MS = '1200',
  MIN_BURN_UI = '0',           // minimum össz-UI burn méret (LP mint(ek) összeadva)
  MIN_LP_BURN_PCT = '0.90',    // min. arány (pre->post csökkenés) az LP mint(ek)re

  DEBUG = '0',
  LOG_ALL_TX = '0',

  // Pure + zaj-szűrés (feliratkozási előszűrő és elemzéskor is)
  WSS_PREFILTER = '1',
  WSS_BURN_ONLY = '1',
  WSS_SKIP_NOISE = '1',
  PURE_BURN_ONLY = '1',
  STRICT_NO_NONLP_INCREASE = '1',

  // LP-only követelmények
  REQUIRE_LP_AUTH = '1',         // KÖTELEZŐ: mintAuthority whitelist
  KNOWN_LP_AUTHORITIES = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium V4

  REQUIRE_LP_PROGRAM = '1',      // Opcionális: tx accountKeys között legyen LP program
  KNOWN_LP_PROGRAM_IDS = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8,CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C,CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium AMM/CPMM/CLMM

} = process.env;

if (!RPC_HTTP || !RPC_WSS) {
  console.error('❌ RPC_HTTP vagy RPC_WSS hiányzik!');
  process.exit(1);
}

const dbg = (...a)=>{ if (String(DEBUG)==='1') console.log('[debug]', ...a); };

const connection = new Connection(RPC_HTTP, { wsEndpoint: RPC_WSS, commitment: 'confirmed' });
const RATE = Math.max(150, parseInt(RATE_MS,10) || 1200);

const PREFILTER = String(WSS_PREFILTER) === '1';
const PREFILTER_BURN_ONLY = String(WSS_BURN_ONLY) !== '0';
const PREFILTER_SKIP_NOISE = String(WSS_SKIP_NOISE) !== '0';
const PURE_ONLY = String(PURE_BURN_ONLY) !== '0';
const NO_NONLP = String(STRICT_NO_NONLP_INCREASE) !== '0';

const REQUIRE_AUTH = String(REQUIRE_LP_AUTH) === '1';
const REQUIRE_PROG = String(REQUIRE_LP_PROGRAM) === '1';

const AUTH_WHITELIST = new Set(
  (KNOWN_LP_AUTHORITIES || '')
    .split(',')
    .map(s=>s.trim())
    .filter(Boolean)
);

const KNOWN_LP_PROGRAMS = new Set(
  (KNOWN_LP_PROGRAM_IDS || '')
    .split(',')
    .map(s=>s.trim())
    .filter(Boolean)
);

// zajkulcsszavak
const NOISE = ['swap','route','jupiter','aggregator','meteora','goonfi','phoenix','openbook'];

// ===== Helpers =====
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function sendTG(html){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try{
    const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: html, parse_mode: 'HTML', disable_web_page_preview: false })
    });
    if (!r.ok) console.error('Telegram error:', r.status, await r.text());
  }catch(e){ console.error('Telegram send failed:', e.message); }
}

function hasBurnChecked(logs){
  return (logs||[]).some(l => /Instruction:\s*BurnChecked|Instruction:\s*Burn/i.test(l));
}
function hasNoise(logs){
  const t = (Array.isArray(logs)?logs.join('\n'):String(logs)).toLowerCase();
  return NOISE.some(k=>t.includes(k));
}

function extractBurns(tx){
  const burns=[];
  try{
    const pre = tx?.meta?.preTokenBalances || [];
    const post= tx?.meta?.postTokenBalances || [];
    const m = new Map(); for (const p of pre) m.set(p.accountIndex, p);
    for (const q of post){
      const p = m.get(q.accountIndex);
      if (!p) continue;
      const dec = Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const preAmt  = Number(p?.uiTokenAmount?.amount || 0);
      const postAmt = Number(q?.uiTokenAmount?.amount || 0);
      if (postAmt < preAmt) {
        const deltaUI = (preAmt - postAmt) / Math.pow(10, dec);
        burns.push({ mint: q.mint || p?.mint, amountUI: deltaUI, preRaw: preAmt, postRaw: postAmt, decimals: dec, owner: q?.owner || p?.owner });
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
      const p = m.get(q.accountIndex);
      const dec = Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const preAmt  = Number(p?.uiTokenAmount?.amount || 0);
      const postAmt = Number(q?.uiTokenAmount?.amount || 0);
      if (postAmt > preAmt) {
        const deltaUI = (postAmt - preAmt) / Math.pow(10, dec);
        incs.push({ mint: q.mint || p?.mint, amountUI: deltaUI, decimals: dec, owner: q?.owner });
      }
    }
  }catch(e){ dbg('extractIncreases err:', e.message); }
  return incs;
}

function isPureBurn(tx, burns){
  try{
    const logs = tx?.meta?.logMessages || [];
    // tiltjuk a Transfer/MintTo jellegű SPL token műveleteket
    const transferLike = (logs || []).some(l => /Instruction:\s*Transfer|Instruction:\s*MintTo/i.test(l));
    if (transferLike) return false;

    const pre = tx?.meta?.preTokenBalances || [];
    const post= tx?.meta?.postTokenBalances || [];
    const lpSet = new Set(burns.map(b=>b.mint));
    if (lpSet.size === 0) return false;

    // csak LP csökkenhet; bármely más token változása kizáró ok
    const mapPre = new Map(pre.map(p=>[p.accountIndex,p]));
    let anyLpDec=false;

    for (const q of post){
      const p = mapPre.get(q.accountIndex);
      const preAmt  = Number(p?.uiTokenAmount?.amount || 0);
      const postAmt = Number(q?.uiTokenAmount?.amount || 0);
      const mint = q.mint || p?.mint;

      if (lpSet.has(mint)) {
        if (postAmt > preAmt) return false; // LP nem nőhet
        if (postAmt < preAmt) anyLpDec = true;
      } else {
        if (postAmt !== preAmt) return false; // nem-LP nem változhat
      }
    }

    const postIdx = new Set(post.map(x=>x.accountIndex));
    for (const p of pre){
      if (!postIdx.has(p.accountIndex)){
        const preAmt = Number(p?.uiTokenAmount?.amount || 0);
        if (lpSet.has(p.mint)) { if (preAmt>0) anyLpDec = true; }
        else if (preAmt !== 0) return false;
      }
    }
    return anyLpDec;
  }catch{ return false; }
}

function maxBurnPct(burns){
  let maxPct=0;
  for (const b of burns){
    if (b.preRaw>0){
      const pct = (b.preRaw - b.postRaw)/b.preRaw;
      if (pct>maxPct) maxPct=pct;
    }
  }
  return maxPct;
}

async function getMintParsed(mint){
  const body={jsonrpc:'2.0', id:'mint', method:'getAccountInfo', params:[mint, {encoding:'jsonParsed', commitment:'confirmed'}]};
  const r=await fetch(RPC_HTTP,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  return j?.result?.value?.data?.parsed || null;
}
async function getMintAuthority(mint){
  try{
    const parsed = await getMintParsed(mint);
    return parsed?.info?.mintAuthority ?? null;
  }catch{ return null; }
}
async function hasFreezeAuthority(mint){
  try{
    const parsed = await getMintParsed(mint);
    return !!parsed?.info?.freezeAuthority;
  }catch{ return false; }
}

function hasKnownProgramContext(tx){
  try{
    const keys = tx?.transaction?.message?.accountKeys || [];
    const arr = keys.map(k => (typeof k==='string' ? k : k?.toBase58?.())).filter(Boolean);
    return arr.some(k => KNOWN_LP_PROGRAMS.has(k));
  }catch{ return false; }
}

function looksLikeRemoveLiquidity(tx, burns, increases){
  const logs = tx?.meta?.logMessages || [];
  const txt = (logs||[]).join('\n');
  if (/(remove[\s_-]*liquidity|removeliquidity|withdraw[\s_-]*liquidity|withdrawliquidity|burn\s+lp)/i.test(txt)) {
    return true;
  }
  const lp = new Set(burns.map(b=>b.mint));
  const nonLpIncs = (increases||[]).filter(x => !lp.has(x.mint) && x.amountUI > 0);
  if (nonLpIncs.length >= 2) return true;
  return false;
}

// ===== Értékelés + TG =====
async function evaluateAndNotify(sig, tx){
  const logs = tx?.meta?.logMessages || [];
  if (!hasBurnChecked(logs)) { dbg('no burnchecked', sig); return false; }
  if (PREFILTER_SKIP_NOISE && hasNoise(logs)) { dbg('noise', sig); return false; }

  // LP-only feltétel #1: PURE burn
  const burns = extractBurns(tx);
  if (PURE_ONLY && !isPureBurn(tx, burns)) { dbg('not pure burn', sig); return false; }

  // LP-only feltétel #2: ne legyen remove-liq mintázat
  const incs = extractIncreases(tx);
  if (looksLikeRemoveLiquidity(tx, burns, incs)) { dbg('remove-liq pattern', sig); return false; }

  // LP-only feltétel #3: nincs nem-LP növekedés
  if (NO_NONLP) {
    const lp = new Set(burns.map(b=>b.mint));
    const nonLpIncs = incs.filter(x => !lp.has(x.mint) && x.amountUI > 0);
    if (nonLpIncs.length>0) { dbg('non-LP incs', sig); return false; }
  }

  // LP-only feltétel #4: minden égetett mint authority-ja whitelistes
  if (REQUIRE_AUTH) {
    for (const b of burns) {
      const auth = await getMintAuthority(b.mint);
      if (!auth || !AUTH_WHITELIST.has(auth)) {
        dbg('auth not whitelisted', b.mint, '->', auth);
        return false; // SIMA token burn itt kiesik
      }
    }
  }

  // LP-only feltétel #5: (opcionális) legyen LP program kontextus is
  if (REQUIRE_PROG && !hasKnownProgramContext(tx)) {
    dbg('no known LP program context', sig);
    return false;
  }

  // további határértékek
  const totalUI = burns.reduce((s,b)=>s+b.amountUI,0);
  if (totalUI < Number(MIN_BURN_UI||0)) { dbg('too small', totalUI); return false; }
  const pct = maxBurnPct(burns);
  if (pct < Number(MIN_LP_BURN_PCT||0.9)) { dbg('pct too low', pct); return false; }

  // Freeze státusz
  let hasFreeze=false;
  for (const b of burns) { if (await hasFreezeAuthority(b.mint)) { hasFreeze=true; break; } }

  // Üzenet
  const byMint = new Map();
  for (const b of burns) byMint.set(b.mint, (byMint.get(b.mint)||0)+b.amountUI);

  let lines='';
  for (const [mint,amt] of byMint.entries()){
    const pretty = amt>=1 ? amt.toLocaleString('en-US',{maximumFractionDigits:4}) : amt.toExponential(4);
    lines += `• <code>${esc(mint)}</code> — ${pretty} LP\n`;
  }

  const html =
`🔥 <b>LP Burn Detected</b> (STRICT)
<b>Tx:</b> <a href="https://solscan.io/tx/${encodeURIComponent(sig)}">${esc(sig.slice(0,8))}…</a>

<b>Freeze Mint:</b> ${hasFreeze ? 'On' : 'Off'}
<b>Burned LP mints:</b>
${lines.trim()}

🔗 <a href="https://dexscreener.com/solana/${encodeURIComponent([...byMint.keys()][0])}">DexScreener</a>`;

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
  console.log('[info] Processing', sig, 'via', prog, 'q=', sigQueue.length);
  try{
    const tx = await connection.getTransaction(sig, {maxSupportedTransactionVersion:0, commitment:'confirmed'});
    if (!tx){ console.log('[skip] not found', sig); return fin(); }
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
setInterval(()=>console.log(`[hb] queue=${sigQueue.length} lastSig=${lastSig}`), 10000);

// ===== Subscribe (SPL token programokra, előszűrővel) =====
function programList(){
  // SPL Token programok – ezeken jönnek a Burn/BurnChecked logok
  return [
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',       // legacy
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',       // token-2022
  ].map(s=>new PublicKey(s));
}

async function subscribe(){
  const pks = programList();
  console.log('[info] onLogs subscribe SPL token programs | RATE_MS=', RATE,
              '| PREFILTER=', PREFILTER, '| PURE_BURN_ONLY=', PURE_ONLY,
              '| REQUIRE_LP_AUTH=', REQUIRE_AUTH, '| REQUIRE_LP_PROGRAM=', REQUIRE_PROG);

  for (const pk of pks){
    await connection.onLogs(pk, (ev)=>{
      const sig = ev?.signature; if (!sig) return;
      let pass = true;
      if (PREFILTER){
        const ll = ev?.logs || []; const text=(Array.isArray(ll)?ll.join('\n'):String(ll));
        if (PREFILTER_BURN_ONLY && !(/Instruction:\s*BurnChecked|Instruction:\s*Burn/i.test(text))) pass=false;
        if (pass && PREFILTER_SKIP_NOISE && /(swap|route|jupiter|aggregator|meteora|goonfi|phoenix|openbook)/i.test(text)) pass=false;
      }
      if (pass) enqueue(sig, pk.toBase58().slice(0,6));
      else if (String(DEBUG)==='1') console.log('[prefilter-skip]', sig);
    }, 'confirmed');
    console.log('[ok] subscribed:', pk.toBase58());
  }
}

// ===== Main =====
(async function main(){
  // Teszt: node index.js <signature>
  if (process.argv[2]) {
    const sig=process.argv[2];
    const tx=await connection.getTransaction(sig,{maxSupportedTransactionVersion:0, commitment:'confirmed'});
    if (!tx){ await sendTG(`<b>Teszt</b> ❌ Tx nem található\n<code>${esc(sig)}</code>`); return; }
    const ok = await evaluateAndNotify(sig, tx);
    await sendTG(ok ? `<b>Teszt</b> ✅ Alert kiment\n<code>${esc(sig)}</code>`
                   : `<b>Teszt</b> ⛔ Szűrő dobta\n<code>${esc(sig)}</code>`);
    return;
  }

  console.log('LP Burn watcher starting…',
    '| PURE_ONLY=', PURE_ONLY?'ON':'OFF',
    '| REQUIRE_LP_AUTH=', REQUIRE_AUTH?'ON':'OFF',
    '| REQUIRE_LP_PROGRAM=', REQUIRE_PROG?'ON':'OFF');
  await subscribe();
})();
