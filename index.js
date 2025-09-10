// index.js — Universal LP Burn watcher (PURE mode + ALL-LP + Rich TG)
// Telegram üzenet: Token name, Token address, Mcap, Liquidity, Token/Pool creation, Freeze mint, Dexscreener link

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

  // mit figyelünk
  WATCH_RAYDIUM_AMM = '1',
  WATCH_RAYDIUM_CPMM = '1',
  WATCH_RAYDIUM_CLMM = '0',
  WATCH_SPL_TOKEN_LEGACY = '1',
  WATCH_SPL_TOKEN_2022 = '1',
  EXTRA_PROGRAM_IDS = '',

  // all-LP mód
  ALL_LP_BROAD = '1',               // 1 → SPL Token programokra is feliratkozunk (minden DEX)
  REQUIRE_AUTH_MATCH = '0',         // 1 → csak ismert authority-k

  // Raydium strict (opcionális)
  STRICT_RAYDIUM_PROG = '0',

  // WSS előszűrő
  WSS_PREFILTER = '1',
  WSS_BURN_ONLY = '1',
  WSS_SKIP_NOISE = '1',

  // remove-liq ellen
  STRICT_NO_NONLP_INCREASE = '1',

  // zajmentes mód
  PURE_BURN_ONLY = '1',
} = process.env;

const dbg = (...a)=>{ if (String(DEBUG)==='1') console.log('[debug]', ...a); };
if (!RPC_HTTP || !RPC_WSS) { console.error('Hiányzik RPC_HTTP vagy RPC_WSS.'); process.exit(1); }

const connection = new Connection(RPC_HTTP, { wsEndpoint: RPC_WSS, commitment: 'confirmed' });

const REQUIRE_RAYDIUM = String(STRICT_RAYDIUM_PROG) === '1';
const PREFILTER = String(WSS_PREFILTER) === '1';
const PREFILTER_BURN_ONLY = String(WSS_BURN_ONLY) !== '0';
const PREFILTER_SKIP_NOISE = String(WSS_SKIP_NOISE) !== '0';
const NO_NONLP = String(STRICT_NO_NONLP_INCREASE) !== '0';
const PURE_ONLY = String(PURE_BURN_ONLY) !== '0';
const RATE = Math.max(150, parseInt(RATE_MS,10)||1200);
const BROAD = String(ALL_LP_BROAD)==='1';
const REQUIRE_AUTH = String(REQUIRE_AUTH_MATCH) === '1';

const NOISE_KEYWORDS = ['swap','route','jupiter','aggregator','meteora','goonfi','phoenix','openbook'];

// ===== Program IDs =====
const RAYDIUM_AMM_V4_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CPMM_ID   = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const RAYDIUM_CLMM_ID   = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

const SPL_TOKEN_LEGACY_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SPL_TOKEN_2022_ID   = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const RAYDIUM_AUTHORITY_V4 = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
const WSOL = 'So11111111111111111111111111111111111111112';

// ===== Helpers =====
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
function safePk(s){ try{ return new PublicKey(String(s).trim()); }catch{ console.error('⚠️ Invalid program id:', s); return null; } }
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function fmtUSD(x){
  if (x == null) return '—';
  const n = Number(x);
  if (!isFinite(n)) return '—';
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(2)}k`;
  return `$${n.toFixed(2)}`;
}
function fmtDate(ts){
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toISOString().replace('T',' ').replace('.000Z',' UTC');
}

function buildPrograms(){
  const list=[];
  // ALL-LP → mindenképp SPL token programok
  if (BROAD || String(WATCH_SPL_TOKEN_LEGACY)==='1') list.push(SPL_TOKEN_LEGACY_ID);
  if (BROAD || String(WATCH_SPL_TOKEN_2022)==='1')   list.push(SPL_TOKEN_2022_ID);

  // Raydium fókusz (ha nem BROAD)
  if (!BROAD) {
    if (String(WATCH_RAYDIUM_AMM)==='1')  list.push(RAYDIUM_AMM_V4_ID);
    if (String(WATCH_RAYDIUM_CPMM)==='1') list.push(RAYDIUM_CPMM_ID);
    if (String(WATCH_RAYDIUM_CLMM)==='1') list.push(RAYDIUM_CLMM_ID);
  }

  if (EXTRA_PROGRAM_IDS && EXTRA_PROGRAM_IDS.trim().length){
    EXTRA_PROGRAM_IDS.split(',').map(s=>s.trim()).filter(Boolean).forEach(id=>list.push(id));
  }
  return [...new Set(list)].map(safePk).filter(Boolean);
}

async function sendTG(html){
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try{
    const r=await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,{
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: html, parse_mode:'HTML', disable_web_page_preview:false })
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
      if (!p) continue;
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
async function fetchMintAccountParsed(mint){
  try{
    const body={jsonrpc:'2.0',id:'mint',method:'getAccountInfo',params:[mint,{encoding:'jsonParsed',commitment:'confirmed'}]};
    const r=await fetch(RPC_HTTP,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json();
    return j?.result?.value || null;
  }catch(e){ return null; }
}
async function fetchMintAuthority(mint){
  if (mintAuthCache.has(mint)) return mintAuthCache.get(mint).authority;
  try{
    const val = await fetchMintAccountParsed(mint);
    const auth=val?.data?.parsed?.info?.mintAuthority ?? null;
    mintAuthCache.set(mint,{authority:auth,when:Date.now()});
    return auth;
  }catch(e){ return null; }
}
async function fetchMintFreezeOnOff(mint){
  const val = await fetchMintAccountParsed(mint);
  const freeze = val?.data?.parsed?.info?.freezeAuthority ?? null;
  return !!freeze;
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
  const hasAuthorityInMsg = keys.some(k=>{
    const s = typeof k === 'string' ? k : k?.toBase58?.();
    return learned.has(s);
  });
  if (hasAuthorityInMsg) {
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

// --- PURE BURN VALIDÁTOR ---
function isPureBurn(tx, burns) {
  try {
    const pre = tx?.meta?.preTokenBalances || [];
    const post = tx?.meta?.postTokenBalances || [];
    if (!pre.length && !post.length) return false;

    const lpMints = new Set(burns.map(b => b.mint));
    if (lpMints.size === 0) return false;

    const logs = tx?.meta?.logMessages || [];
    const hasTransferLike = (logs || []).some(l =>
      /Instruction:\s*Transfer/i.test(l) || /Instruction:\s*MintTo/i.test(l)
    );
    if (hasTransferLike) return false;

    const mapPre = new Map(pre.map(p => [p.accountIndex, p]));
    let anyLpDecrease = false;

    for (const q of post) {
      const p = mapPre.get(q.accountIndex);
      const dec = Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const preAmt  = Number(p?.uiTokenAmount?.amount || 0);
      const postAmt = Number(q?.uiTokenAmount?.amount || 0);
      const mint = q.mint || p?.mint;

      if (lpMints.has(mint)) {
        if (postAmt > preAmt) return false;
        if (postAmt < preAmt) anyLpDecrease = true;
      } else {
        if (postAmt !== preAmt) return false;
      }
    }

    const postIdx = new Set(post.map(x => x.accountIndex));
    for (const p of pre) {
      if (!postIdx.has(p.accountIndex)) {
        const isLp = lpMints.has(p.mint);
        const preAmt = Number(p?.uiTokenAmount?.amount || 0);
        if (isLp) {
          anyLpDecrease = anyLpDecrease || preAmt > 0;
        } else {
          if (preAmt !== 0) return false;
        }
      }
    }
    return anyLpDecrease;
  } catch {
    return false;
  }
}

// ===== DexScreener + Token info helpers =====
async function fetchDexScreenerTopPair(tokenMint){
  try{
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    const pairs = j?.pairs || [];
    if (!pairs.length) return null;
    // Válasszuk a legnagyobb liquidity-t
    pairs.sort((a,b)=> (b?.liquidity?.usd||0) - (a?.liquidity?.usd||0));
    return pairs[0];
  }catch(e){ return null; }
}

// On-chain mint creation time (becslés): a legkorábbi ismert tx időpontja
async function fetchMintCreationTime(mint){
  try{
    let before = undefined;
    let oldest = null;
    for (let i=0;i<5;i++){ // max ~500 tx-t néz vissza
      const body = {
        jsonrpc:'2.0', id:`sig_${i}`,
        method:'getSignaturesForAddress',
        params: [ mint, { limit: 100, before } ]
      };
      const r = await fetch(RPC_HTTP,{ method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
      const j = await r.json();
      const arr = j?.result || [];
      if (!arr.length) break;
      oldest = arr[arr.length-1];
      before = oldest.signature;
      if (arr.length < 100) break;
    }
    if (!oldest) return null;
    // blockTime lekérése
    const btReq = { jsonrpc:'2.0', id:'bt', method:'getBlockTime', params:[ oldest.slot ] };
    const br = await fetch(RPC_HTTP,{ method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(btReq) });
    const bj = await br.json();
    const bt = bj?.result;
    if (!bt) return null;
    return new Date(bt*1000).toISOString();
  }catch(e){ return null; }
}

// Base token felderítése a tx accountKey-jei között (mint típusú accountok)
async function findCandidateBaseTokenMint(tx, burnLpMints){
  try{
    const keys = tx?.transaction?.message?.accountKeys || [];
    const seen = new Set();
    for (const k of keys){
      const addr = typeof k==='string' ? k : k?.toBase58?.();
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      if (burnLpMints.has(addr)) continue;
      if (addr === WSOL) continue;

      // getAccountInfo parsed – ha "mint" típus, akkor jelölt
      const info = await fetchMintAccountParsed(addr);
      const parsedType = info?.data?.parsed?.type;
      if (parsedType === 'mint'){
        return addr; // első reális jelöltet visszaadjuk
      }
    }
  }catch(e){}
  return null;
}

// ===== Értékelés + TG =====
async function evaluateAndNotify(sig, tx) {
  const logs = tx?.meta?.logMessages || [];

  if (!hasBurnChecked(logs)){ console.log('[skip]', sig, 'no_burnchecked'); return false; }

  const burns = extractBurns(tx);

  if (PURE_ONLY && !isPureBurn(tx, burns)) {
    console.log('[skip]', sig, 'not_pure_burn');
    return false;
  }
  if (REQUIRE_RAYDIUM && !hasRaydiumProgramInMessage(tx)){ console.log('[skip]', sig, 'no_raydium_program_strict'); return false; }
  if (hasNoise(logs)){ console.log('[skip]', sig, 'noise_keywords'); return false; }

  const incs = extractIncreases(tx);
  if (looksLikeRemoveLiquidity(tx, burns, incs)){ console.log('[skip]', sig, 'remove_liq_pattern'); return false; }

  if (NO_NONLP) {
    const lpMints = new Set(burns.map(b => b.mint));
    const nonLpIncs = incs.filter(x => !lpMints.has(x.mint) && x.amount > 0);
    if (nonLpIncs.length > 0) {
      console.log('[skip]', sig, 'nonlp_increase_present');
      return false;
    }
  }

  if (REQUIRE_AUTH) {
    const hit=await anyBurnMintHasKnownAuthority(burns);
    if (!hit.ok){ console.log('[skip]', sig, 'no_authority_match'); return false; }
  } else {
    await autoLearnFromTx(tx);
  }

  const totalUi=burns.reduce((s,b)=>s+b.amount,0);
  if (totalUi < Number(MIN_BURN_UI||0)){ console.log('[skip]', sig, 'too_small'); return false; }
  const pct=maxBurnPct(burns);
  if (pct < Number(MIN_LP_BURN_PCT||0.9)){ console.log('[skip]', sig, 'pct_too_low', pct.toFixed(3)); return false; }

  // ===== Részletes token/pool info összeszedése =====
  const lpMintSet = new Set(burns.map(b=>b.mint));
  // base token jelölt keresése
  let baseMint = await findCandidateBaseTokenMint(tx, lpMintSet);
  // ha nincs jelölt, utolsó esély: próbálkozzunk még 1-2 account-tal a pre/post listából (ritka eset)
  if (!baseMint){
    const allMints = new Set([
      ...lpMintSet,
      ...(tx?.meta?.preTokenBalances||[]).map(x=>x.mint),
      ...(tx?.meta?.postTokenBalances||[]).map(x=>x.mint),
    ].filter(Boolean));
    for (const m of allMints){
      if (m!==WSOL && !lpMintSet.has(m)){
        const info = await fetchMintAccountParsed(m);
        if (info?.data?.parsed?.type === 'mint'){ baseMint = m; break; }
      }
    }
  }

  // Freeze mint (LP-n)
  let freezeOn = false;
  // ha több LP mint van, bármelyikre igaz → On
  for (const m of lpMintSet){
    const fo = await fetchMintFreezeOnOff(m);
    if (fo) { freezeOn = true; break; }
  }

  // DexScreener adat (base tokenhez)
  let ds = null;
  if (baseMint) ds = await fetchDexScreenerTopPair(baseMint);

  // Token creation time (base token)
  let tokenCreatedISO = null;
  if (baseMint) tokenCreatedISO = await fetchMintCreationTime(baseMint);

  // Pool creation time
  const poolCreatedISO = ds?.createdAt ? new Date(ds.createdAt).toISOString() : null;

  // Token name/symbol
  const tokenName = ds?.baseToken?.name || 'Unknown';
  const tokenSym  = ds?.baseToken?.symbol || '';
  const tokenAddr = baseMint || [...lpMintSet][0];

  const mcap = ds?.marketCap ?? ds?.fdv ?? null;
  const liq  = ds?.liquidity?.usd ?? null;

  // ===== TG üzenet (HTML) =====
  const byMint=new Map(); for(const b of burns) byMint.set(b.mint,(byMint.get(b.mint)||0)+b.amount);
  let burnedLines = '';
  for (const [mint,amt] of byMint.entries()){
    burnedLines += `• <code>${esc(mint)}</code> — ${amt>=1?amt.toLocaleString('en-US',{maximumFractionDigits:4}):amt.toExponential(4)} LP\n`;
  }

  const tg =
`🔥 <b>LP Burn Detected</b>
<b>Tx:</b> <a href="https://solscan.io/tx/${encodeURIComponent(sig)}">${esc(sig.slice(0,8))}…</a>

<b>Token:</b> ${esc(tokenName)}${tokenSym?` (${esc(tokenSym)})`:''}
<b>Token Address:</b> <code>${esc(tokenAddr)}</code>
<b>Mcap:</b> ${fmtUSD(mcap)}
<b>Liquidity:</b> ${fmtUSD(liq)}
<b>Token Created:</b> ${tokenCreatedISO ? fmtDate(new Date(tokenCreatedISO)) : '—'}
<b>Pool Created:</b> ${poolCreatedISO ? fmtDate(new Date(poolCreatedISO)) : '—'}
<b>Freeze Mint:</b> ${freezeOn ? 'On' : 'Off'}

<b>Burned LP mints:</b>
${burnedLines.trim()}

🔗 <a href="https://dexscreener.com/solana/${encodeURIComponent(tokenAddr)}">DexScreener</a>`;

  await sendTG(tg);
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
  if (pks.length===0){ console.error('Nincs bekapcsolt program (WATCH_* vagy ALL_LP_BROAD)'); process.exit(1); }
  console.log('[info] onLogs subscribe:', pks.map(p=>p.toBase58()).join(', '), '| RATE_MS=', RATE, '| PREFILTER=', PREFILTER, '| PURE_BURN_ONLY=', PURE_ONLY, '| ALL_LP_BROAD=', BROAD);

  for (const pk of pks){
    await connection.onLogs(pk, (ev)=>{
      const sig = ev?.signature; if (!sig) return;
      let pass = true;
      if (PREFILTER){
        const ll = ev?.logs || []; const text = (Array.isArray(ll)?ll.join('\n'):String(ll));
        if (PREFILTER_BURN_ONLY && !(/Instruction:\s*BurnChecked|Instruction:\s*Burn/i.test(text))) pass=false;
        if (pass && PREFILTER_SKIP_NOISE && /(swap|route|jupiter|aggregator|meteora|goonfi|phoenix|openbook)/i.test(text)) pass=false;
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
  // Teszt mód: node index.js <sig>
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
    const ok = await evaluateAndNotify(sig, tx);
    await sendTG(ok ? `<b>Teszt mód</b> ✅ Alert elküldve\n<code>${esc(sig)}</code>` : `<b>Teszt mód</b> ⛔ Szűrő dobta\n<code>${esc(sig)}</code>`);
    return;
  }

  console.log('LP Burn watcher starting…',
    '| ALL_LP_BROAD=', BROAD?'ON':'OFF',
    '| PURE_BURN_ONLY=', PURE_ONLY?'ON':'OFF',
    '| REQUIRE_AUTH_MATCH=', REQUIRE_AUTH?'ON':'OFF',
    '| STRICT_RAYDIUM_PROG=', REQUIRE_RAYDIUM?'ON':'OFF');
  await subscribe();
})();
