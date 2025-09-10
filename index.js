// index.js — Raydium LP burn watcher (onLogs + HTML TG + queue + heartbeat)

import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';
import fs from 'fs';

// ==== ENV ====
const {
  DEBUG,
  RPC_HTTP,
  RPC_WSS,
  TG_BOT_TOKEN,
  TG_CHAT_ID,

  // authority + szűrők (maradtak a régi verzióból)
  RAYDIUM_AUTHORITIES = '',
  AUTO_LEARN_AUTHORITIES = '1',
  REQUIRE_RAYDIUM_PROGRAM = '0',
  REQUIRE_INCINERATOR = '0',
  MAX_UNDERLYING_UP_MINTS = '2',
  UNDERLYING_UP_EPS = '0.000001',
  MIN_BURN_UI = '0',
  SKIP_SIGNATURES = '',
  SKIP_MINTS = '',

  // új kapcsolók
  TX_COMMITMENT = 'processed',
  WATCH_RAYDIUM_PROGRAMS = '1',
  WATCH_TOKEN_2022 = '0',
  WATCH_TOKEN_LEGACY = '0',
  LOG_ALL_TX = '0',
  QUEUE_INTERVAL_MS = '1000',
} = process.env;

const logDbg = (...a) => { if (String(DEBUG) === '1') console.log('[debug]:', ...a); };

// ==== Program IDs ====
const RAYDIUM_AMM = new PublicKey('CAMMCzo5YL8w4VFF8KVHRk22GGUsp5VTaW7girrKgIrwQk');
const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
const TOKEN_2022   = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const TOKEN_LEGACY = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

function buildSubscribePrograms() {
  const arr = [];
  if (String(WATCH_RAYDIUM_PROGRAMS) !== '0') { arr.push(RAYDIUM_AMM, RAYDIUM_CPMM); }
  if (String(WATCH_TOKEN_2022) === '1') arr.push(TOKEN_2022);
  if (String(WATCH_TOKEN_LEGACY) === '1') arr.push(TOKEN_LEGACY);
  if (arr.length === 0) { arr.push(RAYDIUM_AMM, RAYDIUM_CPMM); } // fallback
  return arr;
}

// ==== Authorities (env + file + defaults) ====
const DEFAULT_RAYDIUM_AUTHORITIES = [
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // V4
];

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
  try { fs.writeFileSync(AUTH_FILE, JSON.stringify([...learnedAuth], null, 2)); } catch {}
}

// ==== Telegram (HTML, escape) ====
function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
async function sendToTG(text){
  if(!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try{
    const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,{
      method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode:'HTML', disable_web_page_preview:true })
    });
    if(!r.ok) console.error('Telegram hiba:', r.status, await r.text());
  }catch(e){ console.error('Telegram küldési hiba:', e.message); }
}

// ==== Helpers / detectors (régi verzióból) ====
const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
const SKIP_SIG_SET  = new Set(SKIP_SIGNATURES.split(',').map(s=>s.trim()).filter(Boolean));
const SKIP_MINT_SET = new Set(SKP_MINTS_HELPER());
function SKP_MINTS_HELPER(){ return SKIP_MINTS.split(',').map(s=>s.trim()).filter(Boolean); }

function extractBurns(tx){
  const burns=[]; try{
    const pre=tx?.meta?.preTokenBalances||[]; const post=tx?.meta?.postTokenBalances||[];
    const by=new Map(); for(const p of pre) by.set(p.accountIndex,p);
    for(const q of post){
      const p=by.get(q.accountIndex); if(!p) continue;
      const dec=Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const preAmt=Number(p?.uiTokenAmount?.amount||0); const postAmt=Number(q?.uiTokenAmount?.amount||0);
      if(postAmt<preAmt){ const delta=(preAmt-postAmt)/Math.pow(10,dec); if(delta>0) burns.push({mint:q.mint,amount:delta}); }
    }
  }catch(e){ logDbg('extractBurns error:', e.message); }
  return burns;
}
function analyzeUnderlyingMovements(tx){
  try{
    const pre=tx?.meta?.preTokenBalances||[]; const post=tx?.meta?.postTokenBalances||[];
    const idx={}; for(const p of pre) idx[`${p.mint}|${p.owner||''}|${p.accountIndex}`]=p;
    const agg={}; for(const q of post){ const key=`${q.mint}|${q.owner||''}|${q.accountIndex}`; const p=idx[key]; if(!p) continue;
      const dec=Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const diff=(Number(q?.uiTokenAmount?.amount||0)-Number(p?.uiTokenAmount?.amount||0))/Math.pow(10,dec);
      agg[q.mint]=(agg[q.mint]||0)+diff; }
    return agg;
  }catch(e){ logDbg('analyzeUnderlyingMovements error:', e.message); return {}; }
}
function fmtNum(x){ if(!isFinite(x)) return String(x); return (Math.abs(x)>=1)? x.toLocaleString('en-US',{maximumFractionDigits:4}) : x.toExponential(4); }
function totalBurnUi(burns){ return burns.reduce((s,b)=> s+(Number.isFinite(b.amount)?b.amount:0),0); }

const mintAuthCache = new Map();
async function fetchMintAuthority(mint){
  if(mintAuthCache.has(mint)) return mintAuthCache.get(mint).authority;
  try{
    const body={jsonrpc:'2.0',id:'mintinfo',method:'getAccountInfo',params:[mint,{encoding:'jsonParsed',commitment:'confirmed'}]};
    const r=await fetch(RPC_HTTP,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json(); const authority=j?.result?.value?.data?.parsed?.info?.mintAuthority ?? null;
    mintAuthCache.set(mint,{authority,when:Date.now()}); return authority;
  }catch(e){ logDbg('fetchMintAuthority err:', e.message); return null; }
}
async function anyBurnMintHasKnownAuthority(burns){
  for(const b of burns){
    if(SKIP_MINT_SET.has(b.mint)) return {ok:false};
    const auth=await fetchMintAuthority(b.mint);
    if(auth && learnedAuth.has(auth)) return {ok:true, authority:auth};
  }
  return {ok:false};
}

function buildMsg(tx, info){
  const sig  = tx?.transaction?.signatures?.[0] || tx?.signature || '';
  const slot = tx?.slot ?? '';
  const time = tx?.blockTime ? new Date(tx.blockTime*1000).toISOString().replace('T',' ').replace('Z','') : '';
  const burns = info?.burns ?? extractBurns(tx);

  let out = `<b>Raydium LP BURN</b> ✅\n`;
  if(sig)  out+=`<b>Tx:</b> <code>${escapeHtml(sig)}</code>\n`;
  if(time) out+=`<b>Time:</b> ${escapeHtml(time)}\n`;
  if(slot) out+=`<b>Slot:</b> ${escapeHtml(slot)}\n`;
  const evidence = escapeHtml(info?.raydiumEvidence||'authority_only');
  out += `<b>Evidence:</b> ${evidence} ✅\n`;

  const byMint=new Map(); for(const b of burns) byMint.set(b.mint,(byMint.get(b.mint)||0)+b.amount);
  for(const [mint,total] of byMint.entries()){
    out += `<b>LP Mint:</b> <code>${escapeHtml(mint)}</code>\n<b>Burned:</b> ${escapeHtml(fmtNum(total))}\n`;
  }
  if(sig){
    const solscan = `https://solscan.io/tx/${encodeURIComponent(sig)}`;
    const solanafm = `https://solana.fm/tx/${encodeURIComponent(sig)}`;
    out += `<a href="${solscan}">Solscan</a> | <a href="${solanafm}">SolanaFM</a>`;
  }
  return out;
}

async function whyNotPureLPBurn(tx){
  const sig = tx?.transaction?.signatures?.[0] || '';
  if(SKIP_SIG_SET.has(sig)) return {ok:false, reason:'manual_skip'};

  const burns=extractBurns(tx);
  if(burns.length===0) return {ok:false, reason:'no_lp_delta'};
  if(totalBurnUi(burns)<Number(MIN_BURN_UI)) return {ok:false, reason:'too_small_burn'};

  const authHit = await anyBurnMintHasKnownAuthority(burns);
  if(!authHit.ok) return {ok:false, reason:'no_raydium_authority'};

  // opcionális incinerator + underlying növekmény
  const viaIncin = JSON.stringify(tx).includes(INCINERATOR);
  if(String(REQUIRE_INCINERATOR)==='1' && !viaIncin) return {ok:false, reason:'incinerator_required'};

  const agg = analyzeUnderlyingMovements(tx);
  const eps=Number(UNDERLYING_UP_EPS);
  const ups=Object.values(agg).filter(v=>v>eps).length;
  if(ups>Number(MAX_UNDERLYING_UP_MINTS) && !viaIncin) return {ok:false, reason:'underlying_growth_without_incin'};

  // onLogs esetén Raydium programnyom nem garantált; ha kötelező, nézzük accountKeys-ben
  if(String(REQUIRE_RAYDIUM_PROGRAM)==='1'){
    const keys = tx?.transaction?.message?.accountKeys?.map(k=> (typeof k==='string'?k:k.toBase58?.()))||[];
    const hasRay = keys.includes(RAYDIUM_AMM.toBase58()) || keys.includes(RAYDIUM_CPMM.toBase58());
    if(!hasRay) return {ok:false, reason:'no_raydium_program'};
  }

  return {ok:true, burns, raydiumEvidence:'authority_only'};
}

// ===== Queue + heartbeat =====
const connection = new Connection(RPC_HTTP, { commitment: TX_COMMITMENT, wsEndpoint: RPC_WSS });
const queue = [];
let processing=false;
let lastSig='-';
let connected=true; // web3 kezeli a ws-t belül
const processed = new Set();

function enqueueSignature(sig, sourceTag){
  if(processed.has(sig)) return;
  processed.add(sig);
  if(String(LOG_ALL_TX)==='1') console.log(`[rx] ${sig} via=${sourceTag}`);
  queue.push(sig);
  console.log(`[info]:  🔥 Queued signature: ${sig} (queue size: ${queue.length})`);
  processQueue(); // indíts feldolgozást
}

async function processQueue(){
  if(processing) return;
  processing=true;
  while(queue.length){
    const sig=queue.shift();
    lastSig=sig;
    console.log(`[INFO] Vizsgálom tx: ${sig}`);
    try{
      const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
      if(!tx){ console.log(`[SKIP] ${sig} → not_found`); continue; }
      // auto-learn csak Raydium-nyom esetén
      if(String(AUTO_LEARN_AUTHORITIES)==='1'){
        const burns=extractBurns(tx);
        for(const b of burns){
          const auth = await fetchMintAuthority(b.mint);
          if(auth && !learnedAuth.has(auth)){
            learnedAuth.add(auth); persistLearned();
            console.log(`[learned] authority=${auth} mint=${b.mint}`);
          }
        }
      }
      const check = await whyNotPureLPBurn(tx);
      if(!check.ok){
        console.log(`[SKIP] ${sig} → ${check.reason}`);
      }else{
        const text = buildMsg(tx, check);
        await sendToTG(text);
        console.log(`[ALERT] ${sig} ✅ evidence=${check.raydiumEvidence}`);
      }
    }catch(e){
      console.error('[ERR] feldolgozás hiba', sig, e.message);
    }
    // lépésköz
    await new Promise(r=>setTimeout(r, Number(QUEUE_INTERVAL_MS)||1000));
  }
  processing=false;
}

setInterval(()=>{ console.log(`[hb]: connected=${connected} queue=${queue.length} lastSig=${lastSig}`); }, 10000);

// ===== Feliratkozások onLogs-szal =====
async function subscribeOnLogs(){
  const programs = buildSubscribePrograms();
  console.log('[INFO] onLogs feliratkozások indulnak commit=', TX_COMMITMENT, ' -> ', programs.map(p=>p.toBase58()).join(', '));
  for(const p of programs){
    try{
      await connection.onLogs(p, (logs /* Logs */, _ctx) => {
        const sig = logs?.signature;
        if(!sig) return;
        // Gyors zajszűrés a log-szöveg alapján (nem kötelező)
        const arr = logs?.logs || [];
        const lower = arr.join(' | ').toLowerCase();
        // ha nagyon zajos: csak akkor queue, ha van "burn" vagy "burnchecked"
        if (lower.includes('burnchecked') || lower.includes(' instruction: burn') || lower.includes(' instruction: burnchecked')) {
          enqueueSignature(sig, p.toBase58().slice(0,6));
        } else {
          // különben is engedjük át — a mély vizsgálat majd szűr
          enqueueSignature(sig, p.toBase58().slice(0,6));
        }
      }, TX_COMMITMENT);
      console.log(`[INFO] ✅ Subscribed onLogs: ${p.toBase58()}`);
    }catch(e){
      console.error('[ERR] onLogs subscribe failed for', p.toBase58(), e.message);
    }
  }
}

// ===== Main =====
(async function main(){
  console.log('LP Burn watcher (onLogs) starting…');
  if(!RPC_HTTP || !RPC_WSS){ console.error('Hiányzik RPC_HTTP vagy RPC_WSS'); process.exit(1); }
  // teszt mód: node index.js <signature>
  if(process.argv[2]){ enqueueSignature(process.argv[2], 'test'); }
  await subscribeOnLogs();
})();
