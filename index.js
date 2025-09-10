// index.js — Raydium LP burn watcher
// WS + Test mód + részletes REASON log
// LP burn akkor megy át, ha:
//   - mintAuthority ∈ Raydium Authority (V2/V3/V4)  ➜ KÖTELEZŐ
//   - + (opcionálisan) Raydium programnyom a tx-ben (REQUIRE_RAYDIUM_PROGRAM)
// Védelmek: MIN_BURN_UI, SKIP_MINTS, SKIP_SIGNATURES, underlying növekmény szűrés, (opcionális) incinerator

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

  // Raydium authority források
  RAYDIUM_AUTHORITIES = '',
  AUTO_LEARN_AUTHORITIES = '1',

  // <<< ÚJ >>> ha 1: KELL Raydium programnyom is; ha 0: authority-only is jó
  REQUIRE_RAYDIUM_PROGRAM = '0',

  // finomhangolás / védelem
  REQUIRE_INCINERATOR = '0',
  MAX_UNDERLYING_UP_MINTS = '2',
  UNDERLYING_UP_EPS = '0.000001',
  MIN_BURN_UI = '0',
  SKIP_SIGNATURES = '',
  SKIP_MINTS = '',
} = process.env;

// Raydium AMM/CPMM programok
const RAYDIUM_PROGRAM_IDS = [
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'CAMMCzo5YL8w4VFF8KVHRk22GGUsp5VTaW7girrKgIrwQk',
];

// Beépített biztos authority (bővíthető)
const DEFAULT_RAYDIUM_AUTHORITIES = [
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium Authority V4
];

const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
const SKIP_KEYWORDS = ['remove', 'remove_liquidity', 'withdraw', 'remove-liquidity'];

const logDbg = (...a) => { if (String(DEBUG) === '1') console.log('[DBG]', ...a); };
const wsUrl = RPC_WSS;
const httpUrl = RPC_HTTP;

const SKIP_SIG_SET = new Set(SKIP_SIGNATURES.split(',').map(s=>s.trim()).filter(Boolean));
const SKIP_MINT_SET = new Set(SKIP_MINTS.split(',').map(s=>s.trim()).filter(Boolean));

// ---- authority store (env + file + defaults)
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

// ---- Telegram
async function sendToTG(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true }),
    });
    if (!res.ok) console.error('Telegram hiba:', res.status, await res.text());
  } catch (e) { console.error('Telegram küldési hiba:', e.message); }
}

// ---- helpers
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
    const byIdx = new Map(); for (const p of pre) byIdx.set(p.accountIndex, p);
    for (const q of post) {
      const p = byIdx.get(q.accountIndex); if (!p) continue;
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
    const idx = {}; for (const p of pre) idx[`${p.mint}|${p.owner || ''}|${p.accountIndex}`] = p;
    const agg = {};
    for (const q of post) {
      const key = `${q.mint}|${q.owner || ''}|${q.accountIndex}`; const p = idx[key]; if (!p) continue;
      const dec = Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const diff = (Number(q?.uiTokenAmount?.amount || 0) - Number(p?.uiTokenAmount?.amount || 0)) / Math.pow(10, dec);
      agg[q.mint] = (agg[q.mint] || 0) + diff;
    }
    return agg;
  } catch (e) { logDbg('analyzeUnderlyingMovements error:', e.message); return {}; }
}

// mintAuthority cache + lekérés
const mintAuthCache = new Map(); // mint -> { authority, when }
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

async function anyBurnMintHasKnownAuthority(burns) {
  for (const b of burns) {
    if (SKIP_MINT_SET.has(b.mint)) return { ok:false, authority: null, skippedMint: b.mint };
    const auth = await fetchMintAuthority(b.mint);
    if (auth && learnedAuth.has(auth)) return { ok:true, authority: auth };
  }
  return { ok:false };
}

// Tanulás: CSAK akkor tanulunk authority-t, ha Raydium programnyom is van
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

function fmtNum(x){ if(!isFinite(x)) return String(x); return (Math.abs(x)>=1)? x.toLocaleString('en-US',{maximumFractionDigits:4}) : x.toExponential(4); }
function totalBurnUi(burns){ return burns.reduce((s,b)=> s + (Number.isFinite(b.amount)? b.amount : 0), 0); }

function buildMsg(tx, info){
  const sig = tx?.transaction?.signatures?.[0] || tx?.signature || '';
  const slot = tx?.slot ?? '';
  const time = tx?.blockTime ? new Date(tx.blockTime*1000).toISOString().replace('T',' ').replace('Z','') : '';
  const burns = info?.burns ?? extractBurns(tx);
  let out = `*Raydium LP BURN* ✅\n`;
  if (sig) out += `*Tx:* \`${sig}\`\n`;
  if (time) out += `*Time:* ${time}\n`;
  if (slot) out += `*Slot:* ${slot}\n`;
  out += `*Evidence:* ${info?.raydiumEvidence || 'authority_only'}\n`;
  const byMint = new Map(); for (const b of burns) byMint.set(b.mint, (byMint.get(b.mint)||0)+b.amount);
  for (const [mint,total] of byMint.entries()) out += `*LP Mint:* \`${mint}\`\n*Burned:* ${fmtNum(total)}\n`;
  if (sig) out += `[Solscan](https://solscan.io/tx/${sig}) | [SolanaFM](https://solana.fm/tx/${sig})`;
  return out;
}

// ---- döntés
async function whyNotPureLPBurn(tx) {
  const sig = tx?.transaction?.signatures?.[0] || '';
  if (SKIP_SIG_SET.has(sig)) return { ok:false, reason:'manual_skip' };
  if (hasRemoveHints(tx)) return { ok:false, reason:'remove_hint' };

  const burns = extractBurns(tx);
  if (burns.length === 0) return { ok:false, reason:'no_lp_delta' };
  if (totalBurnUi(burns) < Number(MIN_BURN_UI)) return { ok:false, reason:'too_small_burn' };

  // Kötelező: Raydium authority találat legalább egy burnölt minner
  const authHit = await anyBurnMintHasKnownAuthority(burns);
  if (!authHit.ok) return { ok:false, reason:'no_raydium_authority' };

  // Programnyom – csak ha kérjük
  const hasProg = includesRaydium(tx);
  if (String(REQUIRE_RAYDIUM_PROGRAM) === '1' && !hasProg) {
    return { ok:false, reason:'no_raydium_program' };
  }

  // Incinerator (opcionális, nagyon szigorú)
  const viaIncin = JSON.stringify(tx).includes(INCINERATOR);
  if (String(REQUIRE_INCINERATOR) === '1' && !viaIncin) {
    return { ok:false, reason:'incinerator_required' };
  }

  // Underlying növekmények szűrése
  const agg = analyzeUnderlyingMovements(tx);
  const eps = Number(UNDERLYING_UP_EPS);
  const ups = Object.values(agg).filter(v => v > eps).length;
  if (ups > Number(MAX_UNDERLYING_UP_MINTS) && !viaIncin) {
    return { ok:false, reason:'underlying_growth_without_incin', details:{ups} };
  }

  return { ok:true, reason:'ok', burns, raydiumEvidence: hasProg ? 'program+authority' : 'authority_only' };
}

// ---- WebSocket
let ws, reconnTimer; const RECONNECT_MS = 5000;
function connectWS(){
  if(!wsUrl){ console.error('Hiányzik RPC_WSS'); process.exit(1); }
  ws = new WebSocket(wsUrl);
  ws.on('open', ()=>{
    logDbg('WebSocket opened:', wsUrl);
    const sub={ jsonrpc:'2.0', id:1, method:'transactionSubscribe',
      params:[{ accounts:{ any:RAYDIUM_PROGRAM_IDS }, commitment:'confirmed' }] };
    ws.send(JSON.stringify(sub));
    logDbg('Feliratkozás elküldve Raydium programokra.');
  });
  ws.on('message', async (buf)=>{
    let m; try{ m=JSON.parse(buf.toString()); } catch{ return; }
    if (m.method==='transactionNotification'){
      const tx = m?.params?.result?.transaction || m?.params?.result;
      const sig = tx?.transaction?.signatures?.[0] || '';
      await learnAuthoritiesFromTx(tx); // csak programnyom esetén tanul

      const check = await whyNotPureLPBurn(tx);
      if (!check.ok) { console.log(`SKIP ${sig} reason=${check.reason}`); return; }
      const text = buildMsg(tx, check);
      await sendToTG(text);
      console.log(`ALERT ${sig} reason=${check.reason} evidence=${check.raydiumEvidence}`);
    }
  });
  ws.on('close', (c,r)=>{ console.error('WebSocket closed:', c, r?.toString?.()||''); scheduleReconnect(); });
  ws.on('error', (e)=>{ console.error('WebSocket error:', e?.message||e); scheduleReconnect(); });
}
function scheduleReconnect(){ if(reconnTimer) return; reconnTimer=setTimeout(()=>{reconnTimer=null; connectWS();}, RECONNECT_MS); }

// ---- Teszt mód
async function testSignature(sig){
  if(!httpUrl){ console.error('Hiányzik RPC_HTTP'); process.exit(1); }
  try{
    const body={ jsonrpc:'2.0', id:'test', method:'getTransaction', params:[sig, {maxSupportedTransactionVersion:0}] };
    const res=await fetch(httpUrl,{ method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    const j=await res.json(); const tx=j?.result;
    if(!tx){ console.error('Nem találtam tranzakciót ehhez a signature-höz.'); console.error(j); return; }
    const burns=extractBurns(tx);
    for(const b of burns){
      const auth=await fetchMintAuthority(b.mint);
      console.log(`mint=${b.mint} authority=${auth||'null'}`);
    }
    const hasProg = includesRaydium(tx);
    console.log('raydium_program_present=', hasProg);
    const check=await whyNotPureLPBurn(tx);
    console.log(`TEST ${sig} looksLikePureLPBurn=${check.ok} reason=${check.reason} evidence=${check.raydiumEvidence||''}`);
    if(check.ok){ const text=buildMsg(tx, check); await sendToTG(text); console.log('Teszt üzenet elküldve TG-re.'); }
  }catch(e){ console.error('Teszt hiba:', e.message); }
}

// ---- Start
(async function main(){
  console.log('LP Burn watcher starting…');
  if (process.argv[2]) { await testSignature(process.argv[2]); }
  else { connectWS(); }
})();
