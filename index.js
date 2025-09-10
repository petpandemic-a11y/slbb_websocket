// index.js — LP Burn watcher (web3.js onLogs + ENV kapcsolók)

import 'dotenv/config';
import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';
import fs from 'fs';

// ========= ENV =========
const {
  DEBUG,
  RPC_WSS,
  RPC_HTTP,
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  RAYDIUM_AUTHORITIES = '',
  AUTO_LEARN_AUTHORITIES = '1',

  WATCH_RAYDIUM_AMM = '1',
  WATCH_RAYDIUM_CPMM = '1',
  WATCH_TOKEN_2022 = '0',
  WATCH_TOKEN_LEGACY = '0',
} = process.env;

const logDbg = (...a) => { if (String(DEBUG) === '1') console.log('[DBG]', ...a); };

// ========= Program IDs =========
const RAYDIUM_AMM  = 'CAMMCzo5YL8w4VFF8KVHRk22GGUsp5VTaW7girrKgIrwQk';
const RAYDIUM_CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const TOKEN_2022   = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const TOKEN_LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

function safePk(s) {
  try { return new PublicKey(s.trim()); }
  catch { console.error('⚠️ Invalid program id:', s); return null; }
}

function buildProgramList() {
  const arr = [];
  if (String(WATCH_RAYDIUM_AMM) === '1') arr.push(RAYDIUM_AMM);
  if (String(WATCH_RAYDIUM_CPMM) === '1') arr.push(RAYDIUM_CPMM);
  if (String(WATCH_TOKEN_2022) === '1') arr.push(TOKEN_2022);
  if (String(WATCH_TOKEN_LEGACY) === '1') arr.push(TOKEN_LEGACY);
  return arr.map(safePk).filter(Boolean);
}

// ========= Authority kezelés =========
const DEFAULT_RAYDIUM_AUTHORITIES = [
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium Authority V4
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
  try { fs.writeFileSync(AUTH_FILE, JSON.stringify([...learnedAuth], null, 2)); }
  catch (e) { logDbg('persist error:', e.message); }
}

// ========= Connection =========
const connection = new Connection(RPC_HTTP, {
  wsEndpoint: RPC_WSS,
  commitment: 'confirmed',
});

// ========= Telegram =========
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

// ========= Burn detektálás =========
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

const mintAuthCache = new Map();
async function fetchMintAuthority(mint) {
  if (mintAuthCache.has(mint)) return mintAuthCache.get(mint).authority;
  try {
    const body = { jsonrpc:'2.0', id:'mintinfo', method:'getAccountInfo', params:[mint, {encoding:'jsonParsed', commitment:'confirmed'}] };
    const res = await fetch(RPC_HTTP, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    const j = await res.json();
    const authority = j?.result?.value?.data?.parsed?.info?.mintAuthority ?? null;
    mintAuthCache.set(mint, { authority, when: Date.now() });
    return authority;
  } catch { return null; }
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

async function whyNotPureLPBurn(tx) {
  const burns = extractBurns(tx);
  if (burns.length === 0) return { ok:false, reason:'no_lp_delta' };

  const hit = await anyBurnMintHasKnownAuthority(burns);
  if (!hit.ok) return { ok:false, reason:'no_authority_match' };

  return { ok:true, burns, raydiumEvidence:'authority' };
}

function fmtNum(x){ if(!isFinite(x))return String(x); if(Math.abs(x)>=1) return x.toLocaleString('en-US',{maximumFractionDigits:4}); return x.toExponential(4); }
function buildMsg(tx, info){
  const sig = tx?.transaction?.signatures?.[0] || tx?.signature || '';
  const burns = info?.burns ?? extractBurns(tx);
  let out = `*LP Burn Detected* ✅\n`;
  if (sig) out += `*Tx:* \`${sig}\`\n`;
  if (info?.raydiumEvidence) out += `*Evidence:* ${info.raydiumEvidence}\n`;
  const byMint = new Map();
  for (const b of burns) byMint.set(b.mint, (byMint.get(b.mint)||0)+b.amount);
  for (const [mint,total] of byMint.entries()){
    out += `*LP Mint:* \`${mint}\`\n*Burned:* ${fmtNum(total)}\n`;
  }
  if (sig) out += `[Solscan](https://solscan.io/tx/${sig})`;
  return out;
}

// ========= Feliratkozás =========
async function subscribeOnLogs() {
  const programs = buildProgramList();
  console.log('[INFO] Feliratkozás indul:', programs.map(p=>p.toBase58()).join(', '));
  for (const prog of programs) {
    await connection.onLogs(prog, async (logs) => {
      const sig = logs?.signature;
      if (!sig) return;
      console.log(`[onLogs] ${prog.toBase58()} sig=${sig}`);
      try {
        const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (!tx) return;
        await learnAuthoritiesFromTx(tx);
        const check = await whyNotPureLPBurn(tx);
        if (check.ok) {
          const text = buildMsg(tx, check);
          await sendToTG(text);
          console.log(`[ALERT] ${sig}`);
        } else {
          console.log(`[SKIP] ${sig} → ${check.reason}`);
        }
      } catch (e) {
        console.error('getTransaction error:', e.message);
      }
    }, 'confirmed');
    console.log(`✅ Subscribed onLogs: ${prog.toBase58()}`);
  }
}

// ========= Main =========
(async function main(){
  console.log('LP Burn watcher (onLogs + ENV kapcsolók) starting…');
  if (process.argv[2]) {
    const sig = process.argv[2];
    const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment:'confirmed' });
    if (!tx) { console.error('Teszt tx nem található'); return; }
    await learnAuthoritiesFromTx(tx);
    const check = await whyNotPureLPBurn(tx);
    console.log(`TEST ${sig} → ${check.ok} reason=${check.reason}`);
    if (check.ok) {
      const text = buildMsg(tx, check);
      await sendToTG(text);
    }
  } else {
    await subscribeOnLogs();
  }
})();
