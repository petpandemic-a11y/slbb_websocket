import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, getMint } from '@solana/spl-token';

/* ===== ENV ===== */
const {
  RPC1, RPC2, RPC3, RPC4,
  SOLANA_RPC,
  POLL_MS = '10000',
  THRESHOLD = '0.95',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  SIG_LIMIT = '10',
  INITIAL_CATCHUP = '0',
  VERBOSE = 'true'
} = process.env;

const verbose = String(VERBOSE).toLowerCase() === 'true';

// RPC lista
const RPCS = [RPC1 || SOLANA_RPC, RPC2, RPC3, RPC4].filter(u => u && /^https?:\/\//i.test(u));
if (RPCS.length === 0) {
  console.error('❌ Nincs RPC megadva (RPC1 vagy SOLANA_RPC kötelező).');
  process.exit(1);
}
let rpcIndex = 0;
function nextConn() {
  const url = RPCS[rpcIndex % RPCS.length];
  rpcIndex++;
  console.log('🔌 Using RPC:', url.slice(0, 68) + (url.length > 68 ? '...' : ''));
  return new Connection(url, 'confirmed');
}
let conn = nextConn();

const INCINERATOR = new PublicKey('1nc1nerator11111111111111111111111111111111');

// Programok betöltése több ENV-ből
function loadProgramsFromEnv() {
  const arr = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('RAYDIUM_PROGRAM') && v) {
      try { arr.push(new PublicKey(v.trim())); }
      catch (e) { console.error(`❌ Hibás program ID (${k}):`, v, e.message); }
    }
  }
  return arr;
}
const PROGRAMS = loadProgramsFromEnv();
if (PROGRAMS.length === 0) {
  console.error('❌ Nincs RAYDIUM_PROGRAM* env beállítva.');
  process.exit(1);
}

console.log('✅ Programs =', PROGRAMS.map(p => p.toBase58()).join(', '));
console.log('✅ POLL_MS =', POLL_MS, 'THRESHOLD =', THRESHOLD, 'SIG_LIMIT =', SIG_LIMIT, 'INITIAL_CATCHUP =', INITIAL_CATCHUP);

/* ===== State ===== */
const STATE_FILE = './state.json';
let state = { lastSigPerProgram: {}, seenLpMints: [], burnedMints: [] };
try { if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
catch (e) { console.warn('⚠️ State betöltés hiba:', e.message); }
const seenSet = new Set(state.seenLpMints || []);
const burnedSet = new Set(state.burnedMints || []);
function saveState() {
  state.seenLpMints = Array.from(seenSet);
  state.burnedMints = Array.from(burnedSet);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

/* ===== Telegram ===== */
async function tgNotify(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = { chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true, parse_mode: 'HTML' };
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { console.warn('⚠️ Telegram hiba:', e.message); }
}

/* ===== Burn check ===== */
async function isLpBurned100Percent(lpMintStr, threshold = Number(THRESHOLD)) {
  const lpMint = new PublicKey(lpMintStr);
  const incAta = await getAssociatedTokenAddress(lpMint, INCINERATOR, true);
  const mintInfo = await getMint(conn, lpMint);
  const supplyRaw = BigInt(mintInfo.supply.toString());
  if (supplyRaw === 0n) return false;
  let incBalRaw = 0n;
  try { const incAcc = await getAccount(conn, incAta); incBalRaw = BigInt(incAcc.amount.toString()); }
  catch { return false; }
  const ratio = Number(incBalRaw) / Number(supplyRaw);
  return ratio >= threshold;
}

/* ===== Tx parse ===== */
function collectParsedInstructions(tx) {
  const outer = tx?.transaction?.message?.instructions || [];
  const inners = (tx?.meta?.innerInstructions || []).flatMap(ii => ii.instructions || []);
  return [...outer, ...inners];
}
function findLpMintFromTx(tx) {
  for (const ins of collectParsedInstructions(tx)) {
    if (ins?.program === 'spl-token' && ins?.parsed?.type === 'initializeMint') {
      const mint = ins.parsed?.info?.mint;
      if (mint) return { lpMint: mint, reason: 'spl-token.initializeMint' };
    }
  }
  const logs = (tx?.meta?.logMessages || []).join('\n');
  if (/init|initialize|create/i.test(logs)) {
    const mints = new Set((tx?.meta?.postTokenBalances || []).map(b => b.mint).filter(Boolean));
    if (mints.size === 1) return { lpMint: [...mints][0], reason: 'heuristic.postTokenBalances' };
  }
  return null;
}

/* ===== Rate limit kezelő ===== */
let baseDelayMs = Number(POLL_MS);
let dynamicDelayMs = baseDelayMs;
let lastWas429 = false;

function jitter(ms, spread = 0.25) {
  const d = ms * spread;
  return Math.round(ms + (Math.random() * 2 - 1) * d);
}

async function safeGetSignatures(programPk, untilSig) {
  try {
    const sigs = await conn.getSignaturesForAddress(
      programPk,
      untilSig ? { until: untilSig, limit: Number(SIG_LIMIT) } : { limit: Number(SIG_LIMIT) }
    );
    if (verbose) console.log(`↪ getSignatures(${programPk.toBase58().slice(0,6)}…): ${sigs.length} db, backoff=${dynamicDelayMs}ms`);
    lastWas429 = false;
    return sigs;
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('429') || msg.toLowerCase().includes('too many')) {
      lastWas429 = true;
      dynamicDelayMs = Math.min(dynamicDelayMs * 2, 120000);
      console.warn(`⏳ 429 detected → backoff to ${dynamicDelayMs} ms, RPC rotate`);
      conn = nextConn();
      return [];
    }
    console.warn('⚠️ getSignatures error:', msg);
    return [];
  }
}

async function safeGetTransaction(sig) {
  try {
    return await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('429') || msg.toLowerCase().includes('too many')) {
      lastWas429 = true;
      dynamicDelayMs = Math.min(dynamicDelayMs * 2, 120000);
      console.warn(`⏳ 429 on getTransaction → backoff to ${dynamicDelayMs} ms, RPC rotate`);
      conn = nextConn();
      return null;
    }
    console.warn('⚠️ getTransaction error:', msg);
    return null;
  }
}

/* ===== Signature feldolgozó ===== */
async function processSignature(programStr, s) {
  const tx = await safeGetTransaction(s.signature);
  if (!tx || tx.meta?.err) return;

  const found = findLpMintFromTx(tx);
  if (!found) {
    if (verbose) console.log(`• ${s.signature.slice(0,8)}…: no LP init`);
    return;
  }

  const { lpMint, reason } = found;
  if (!lpMint || seenSet.has(lpMint)) return;

  seenSet.add(lpMint); saveState();

  let ok = false;
  try { ok = await isLpBurned100Percent(lpMint); }
  catch (e) { console.warn('⚠️ Burn check hiba', lpMint, e.message); }

  if (ok && !burnedSet.has(lpMint)) {
    burnedSet.add(lpMint); saveState();
    const msg = [
      '🔥 <b>100% LP burn confirmed</b>',
      `LP mint: <code>${lpMint}</code>`,
      `Program: ${programStr}`,
      `Tx: <code>${s.signature}</code>`,
      `Detected by: ${reason}`
    ].join('\n');
    console.log(msg.replace(/<[^>]+>/g, ''));
    await tgNotify(msg);
  } else {
    console.log(`ℹ️ Nem 95%+: ${lpMint} (prog: ${programStr}, tx: ${s.signature}, reason: ${reason})`);
  }
}

/* ===== Poll ===== */
async function pollProgram(programPk) {
  const programStr = programPk.toBase58();
  const untilSig = state.lastSigPerProgram?.[programStr];
  const sigs = await safeGetSignatures(programPk, untilSig);
  if (sigs.length === 0) {
    if (verbose) console.log(`↪ Nincs új signature (${programStr.slice(0,6)}…)`);
    return;
  }

  if (!untilSig) {
    const n = Math.min(Number(INITIAL_CATCHUP) || 0, sigs.length);
    if (verbose) console.log(`🟡 First run for ${programStr.slice(0,6)}… — catchup=${n}`);
    if (n > 0) {
      const toProcess = sigs.slice(0, n).reverse();
      for (const s of toProcess) {
        await processSignature(programStr, s);
      }
    }
    state.lastSigPerProgram[programStr] = sigs[0].signature;
    saveState();
    return;
  }

  for (const s of sigs.reverse()) {
    await processSignature(programStr, s);
    await new Promise(r => setTimeout(r, jitter(120)));
  }

  state.lastSigPerProgram[programStr] = sigs[0].signature;
  saveState();
}

async function pollAll() {
  try {
    for (const p of PROGRAMS) {
      await pollProgram(p);
      await new Promise(r => setTimeout(r, jitter(250)));
    }
    if (!lastWas429) {
      dynamicDelayMs = Math.max(baseDelayMs, Math.floor(dynamicDelayMs * 0.8));
    }
    saveState();
  } catch (e) {
    console.error('❌ Poll error:', e.message);
    saveState();
  }
}

/* ===== Loop ===== */
async function loop() {
  await pollAll();
  setTimeout(loop, dynamicDelayMs);
}

console.log('🚀 LP burn poller indul… adaptív backoff + catchup');
loop();

/* ===== Shutdown ===== */
function shutdown() {
  console.log('⏹️ Leállítás…');
  saveState();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
