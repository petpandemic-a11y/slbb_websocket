// index.js — Raydium LP burn watcher
// WS figyelés + Test mód + REASON logging
// + Raydium Authority ellenőrzés (beépített + ENV + auto-learn)
// + LP-név/szimbólum ellenőrzés (REQUIRE_LP_NAME, LP_NAME_KEYWORDS)

import 'dotenv/config';
import WebSocket from 'ws';
import fetch from 'node-fetch';
import fs from 'fs';

const {
  DEBUG,
  RPC_WSS,
  RPC_HTTP,
  TG_BOT_TOKEN,
  TG_CHAT_ID,

  // Raydium authority lista (opcionális, vesszővel)
  RAYDIUM_AUTHORITIES = '',

  // Authority auto-tanulás Raydium programnyom alapján
  AUTO_LEARN_AUTHORITIES = '1',

  // LP-név szigor: ha 1 → csak akkor jelez, ha a mint neve/szimbóluma LP-re utal
  REQUIRE_LP_NAME = '1',
  // vesszővel elválasztva; nagybetűs rész-illesztés történik
  LP_NAME_KEYWORDS = 'LP,LP TOKEN,LIQUIDITY PROVIDER',

  // opcionális szigorítások
  REQUIRE_INCINERATOR = '0',
  MAX_UNDERLYING_UP_MINTS = '2',
  UNDERLYING_UP_EPS = '0.000001',
  MIN_BURN_UI = '0',
  SKIP_SIGNATURES = ''
} = process.env;

const RAYDIUM_PROGRAM_IDS = [
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'CAMMCzo5YL8w4VFF8KVHRk22GGUsp5VTaW7girrKgIrwQk',
];

// 🔒 Beépített (known-good) Raydium mintAuthority cím(ek)
const DEFAULT_RAYDIUM_AUTHORITIES = [
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium Authority V4
];

const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
const SKIP_KEYWORDS = ['remove', 'remove_liquidity', 'withdraw', 'remove-liquidity'];

const logDbg = (...a) => { if (String(DEBUG) === '1') console.log('[DBG]', ...a); };
const wsUrl = RPC_WSS;
const httpUrl = RPC_HTTP;

const AUTH_FILE = './raydium_authorities.json';
let learnedAuth = new Set();
try {
  if (fs.existsSync(AUTH_FILE)) {
    const arr = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (Array.isArray(arr)) learnedAuth = new Set(arr);
  }
} catch {}

DEFAULT_RAYDIUM_AUTHORITIES.forEach(a => learnedAuth.add(a));
RAYDIUM_AUTHORITIES.split(',').map(s=>s.trim()).filter(Boolean).forEach(a => learnedAuth.add(a));

function persistLearned() {
  try { fs.writeFileSync(AUTH_FILE, JSON.stringify([...learnedAuth], null, 2)); }
  catch (e) { logDbg('persist error:', e.message); }
}

async function sendToTG(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
    });
    if (!res.ok) console.error('Telegram hiba:', res.status, await res.text());
  } catch (e) {
    console.error('Telegram küldési hiba:', e.message);
  }
}

// ---------- Helpers ----------
const SKIP_SIG_SET = new Set(SKIP_SIGNATURES.split(',').map(s=>s.trim()).filter(Boolean));
const LP_KEYS = LP_NAME_KEYWORDS.split(',').map(s=>s.trim().toUpperCase()).filter(Boolean);

function hasRemoveHints(obj) {
  try { return SKIP_KEYWORDS.some(k => JSON.stringify(obj).toLowerCase().includes(k)); }
  catch { return false; }
}
function includesRaydium(tx) {
  try { return RAYDIUM_PROGRAM_IDS.some(id => JSON.stringify(tx).includes(id)); }
  catch { return false; }
}
function extractBurns(tx) {
  const burns = [];
  try {
    const pre = tx?.meta?.preTokenBalances || [];
    const post = tx?.meta?.postTokenBalances || [];
    const byIdx = new Map();
    for (const p of pre) byIdx.set(p.accountIndex, p);
    for (const q of post) {
      const p = byIdx.get(q.accountIndex);
      if (!p) continue;
      const dec = Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const preAmt = Number(p?.uiTokenAmount?.amount || 0);
      const postAmt = Number(q?.uiTokenAmount?.amount || 0);
      if (postAmt < preAmt) {
        const delta = (preAmt - postAmt) / Math.pow(10, dec);
        if (delta > 0) burns.push({ mint: q.mint, amount: delta });
      }
    }
  } catch (e) { logDbg('extractBurns error:', e.message); }
  return burns;
}
function analyzeUnderlyingMovements(tx) {
  try {
    const pre = tx?.meta?.preTokenBalances || [];
    const post = tx?.meta?.postTokenBalances || [];
    const idx = {};
    for (const p of pre) idx[`${p.mint}|${p.owner || ''}|${p.accountIndex}`] = p;
    const agg = {};
    for (const q of post) {
      const key = `${q.mint}|${q.owner || ''}|${q.accountIndex}`;
      const p = idx[key];
      if (!p) continue;
      const dec = Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const diff = (Number(q?.uiTokenAmount?.amount || 0) - Number(p?.uiTokenAmount?.amount || 0)) / Math.pow(10, dec);
      agg[q.mint] = (agg[q.mint] || 0) + diff;
    }
    return agg;
  } catch (e) { logDbg('analyzeUnderlyingMovements error:', e.message); return {}; }
}

// mintAuthority & meta cache + lekérés
const mintAuthCache = new Map(); // mint -> { authority, when }
const mintMetaCache = new Map(); // mint -> { name, symbol, when }

async function fetchMintAuthority(mint) {
  if (!httpUrl) return null;
  if (mintAuthCache.has(mint)) return mintAuthCache.get(mint).authority;
  try {
    const body = { jsonrpc:'2.0', id:'mintinfo', method:'getAccountInfo', params:[mint, {encoding:'jsonParsed', commitment:'confirmed'}] };
    const res = await fetch(httpUrl, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    const j = await res.json();
    const authority = j?.result?.value?.data?.parsed?.info?.mintAuthority ?? null;
    mintAuthCache.set(mint, { authority, when: Date.now() });
    logDbg('mintAuthority', mint, '→', authority);
    return authority;
  } catch (e) { logDbg('fetchMintAuthority err:', e.message); return null; }
}

async function fetchMintNameSymbol(mint) {
  if (!httpUrl) return { name:'', symbol:'' };
  if (mintMetaCache.has(mint)) return mintMetaCache.get(mint);
  try {
    const body = { jsonrpc:'2.0', id:'tokenmeta', method:'getAccountInfo', params:[mint, {encoding:'jsonParsed', commitment:'confirmed'}] };
    const res = await fetch(httpUrl, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    const j = await res.json();
    const info = j?.result?.value?.data?.parsed?.info || {};
    const meta = { name: info?.name || '', symbol: info?.symbol || '', when: Date.now() };
    mintMetaCache.set(mint, meta);
    logDbg('mintMeta', mint, '→', meta.name, '/', meta.symbol);
    return meta;
  } catch (e) { logDbg('fetchMintNameSymbol err:', e.message); return { name:'', symbol:'' }; }
}

async function anyBurnMintHasKnownAuthority(burns) {
  for (const b of burns) {
    const auth = await fetchMintAuthority(b.mint);
    if (auth && learnedAuth.has(auth)) return { ok:true, authority: auth };
  }
  return { ok:false };
}

async function learnAuthoritiesFromTx(tx) {
  if (String(AUTO_LEARN_AUTHORITIES) !== '1') return;
  if (!includesRaydium(tx)) return;
  const burns = extractBurns(tx);
  for (const b of burns) {
    const auth = await fetchMintAuthority(b.mint);
    if (auth && !learnedAuth.has(auth)) {
      learnedAuth.add(auth);
      persistLearned();
      console.log(`LEARNED authority=${auth} mint=${b.mint}`);
    }
  }
}

function fmtNum(x){ if(!isFinite(x))return String(x); if(Math.abs(x)>=1) return x.toLocaleString('en-US',{maximumFractionDigits:4}); return x.toExponential(4); }
function buildMsg(tx, info){
  const sig = tx?.transaction?.signatures?.[0] || tx?.signature || '';
  const slot = tx?.slot ?? '';
  const time = tx?.blockTime ? new Date(tx.blockTime*1000).toISOString().replace('T',' ').replace('Z','') : '';
  const burns = info?.burns ?? extractBurns(tx);
  let out = `*LP Burn Detected* ✅\n`;
  if (sig) out += `*Tx:* \`${sig}\`\n`;
  if (time) out += `*Time:* ${time}\n`;
  if (slot) out += `*Slot:* ${slot}\n`;
  if (info?.raydiumEvidence) out += `*Raydium evidence:* ${info.raydiumEvidence}\n`;
  const byMint = new Map();
  for (const b of burns) byMint.set(b.mint, (byMint.get(b.mint)||0)+b.amount);
  for (const [mint,total] of byMint.entries()){
    out += `*LP Mint:* \`${mint}\`\n*Burned:* ${fmtNum(total)}\n`;
  }
  if (sig) out += `[Solscan](https://solscan.io/tx/${sig}) | [SolanaFM](https://solana.fm/tx/${sig})`;
  return out;
}

function totalBurnUi(burns) {
  return burns.reduce((s,b)=> s + (Number.isFinite(b.amount) ? b.amount : 0), 0);
}

// ---------- Döntés ----------
async function isLikelyLpMint(mint) {
  // LP név/szimbólum ellenőrzés
  const { name, symbol } = await fetchMintNameSymbol(mint);
  const upper = (name + ' ' + symbol).toUpperCase();
  if (LP_KEYS.length && LP_KEYS.some(k => upper.includes(k))) return true;
  // ha kötelező a név-alapú jelzés és nem találtunk kulcsszót → nem LP
  if (String(REQUIRE_LP_NAME) === '1') return false;
  // lazább módban, ha nincs infó, nem zárjuk ki pusztán emiatt
  return true;
}

async function whyNotPureLPBurn(tx) {
  const sig = tx?.transaction?.signatures?.[0] || '';
  if (SKIP_SIG_SET.has(sig)) return { ok:false, reason:'manual_skip' };

  if (hasRemoveHints(tx)) return { ok:false, reason:'remove_hint' };

  const burns = extractBurns(tx);
  if (burns.length === 0) return { ok:false, reason:'no_lp_delta' };

  if (totalBurnUi(burns) < Number(MIN_BURN_UI)) {
    return { ok:false, reason:'too_small_burn' };
  }

  // Minden burnölt mintről bizonyosodjunk meg, hogy LP-jellegű
  for (const b of burns) {
    const isLp = await isLikelyLpMint(b.mint);
    if (!isLp) return { ok:false, reason:'mint_not_lp' };
  }

  // Raydium evidence: program vagy authority
  let evidence = '';
  if (includesRaydium(tx)) evidence = 'program';
  if (!evidence) {
    const hit = await anyBurnMintHasKnownAuthority(burns);
    if (hit.ok) evidence = 'authority';
  }
  if (!evidence) return { ok:false, reason:'no_raydium_and_no_authority_match' };

  // Incinerator követelmény (ha be van kapcsolva)
  const viaIncin = JSON.stringify(tx).includes(INCINERATOR);
  if (String(REQUIRE_INCINERATOR) === '1' && !viaIncin) {
    return { ok:false, reason:'incinerator_required' };
  }

  // Underlying növekmények szigorítása
  const agg = analyzeUnderlyingMovements(tx);
  const eps = Number(UNDERLYING_UP_EPS);
  const ups = Object.values(agg).filter(v => v > eps).length;
  if (ups > Number(MAX_UNDERLYING_UP_MINTS)) {
    if (!viaIncin) return { ok:false, reason:'underlying_growth_without_incin', details:{ups} };
  }

  return { ok:true, reason:'ok', burns, raydiumEvidence:evidence };
}

// ---------- WebSocket ----------
let ws, reconnTimer; const RECONNECT_MS=5000;
function connectWS(){
  if(!wsUrl){ console.error('Hiányzik RPC_WSS'); process.exit(1); }
  ws = new WebSocket(wsUrl);
  ws.on('open', ()=>{
    logDbg('WebSocket opened:', wsUrl);
    const sub={jsonrpc:'2.0',id:1,method:'transactionSubscribe',params:[{accounts:{any:RAYDIUM_PROGRAM_IDS},commitment:'confirmed'}]};
    ws.send(JSON.stringify(sub));
    logDbg('Feliratkozás elküldve Raydium programokra.');
  });
  ws.on('message', async (buf)=>{
    let m; try{ m=JSON.parse(buf.toString()); } catch{ return; }
    if (m.method==='transactionNotification'){
      const tx = m?.params?.result?.transaction || m?.params?.result;
      const sig = tx?.transaction?.signatures?.[0] || '';
      await learnAuthoritiesFromTx(tx);

      const check = await whyNotPureLPBurn(tx);
      if(!check.ok){ console.log(`SKIP ${sig} reason=${check.reason}`); return; }
      const text = buildMsg(tx, check);
      await sendToTG(text);
      console.log(`ALERT ${sig} reason=${check.reason} evidence=${check.raydiumEvidence}`);
    }
  });
  ws.on('close', (c,r)=>{ console.error('WebSocket closed:', c, r?.toString?.()||''); scheduleReconnect(); });
  ws.on('error', (e)=>{ console.error('WebSocket error:', e?.message||e); scheduleReconnect(); });
}
function scheduleReconnect(){ if(reconnTimer) return; reconnTimer=setTimeout(()=>{reconnTimer=null; connectWS();}, RECONNECT_MS); }

// ---------- Teszt mód ----------
async function testSignature(sig){
  if(!httpUrl){ console.error('Hiányzik RPC_HTTP'); process.exit(1); }
  try{
    const body={jsonrpc:'2.0',id:'test',method:'getTransaction',params:[sig,{maxSupportedTransactionVersion:0}]};
    const res=await fetch(httpUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const j=await res.json(); const tx=j?.result; if(!tx){ console.error('Nem találtam tranzakciót ehhez a signature-höz.'); console.error(j); return; }
    const burns=extractBurns(tx);
    for (const b of burns) {
      const auth=await fetchMintAuthority(b.mint);
      const {name,symbol}=await fetchMintNameSymbol(b.mint);
      console.log(`mint=${b.mint} mintAuthority=${auth||'null'} name="${name||''}" symbol="${symbol||''}"`);
    }
    await learnAuthoritiesFromTx(tx);
    const check=await whyNotPureLPBurn(tx);
    console.log(`TEST ${sig} looksLikePureLPBurn=${check.ok} reason=${check.reason} evidence=${check.raydiumEvidence||''}`);
    if(check.ok){ const text=buildMsg(tx, check); await sendToTG(text); console.log('Teszt üzenet elküldve TG-re.'); }
  }catch(e){ console.error('Teszt hiba:', e.message); }
}

// ---------- Indítás ----------
(async function main(){
  console.log('LP Burn watcher starting…');
  if(process.argv[2]){ await testSignature(process.argv[2]); }
  else { connectWS(); }
})();
