import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, getMint } from '@solana/spl-token';

/* ===== ENV ===== */
const {
  // Több RPC támogatás: RPC1, RPC2, RPC3... (https URL-ek). Ha csak egy van, elég az RPC1.
  RPC1, RPC2, RPC3, RPC4,
  // régi névvel is működjön:
  SOLANA_RPC,
  POLL_MS = '10000',          // alap poll idő (ms)
  THRESHOLD = '0.95',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  // lekért sign-ok száma hívásonként (alap: 10)
  SIG_LIMIT = '10'
} = process.env;

// RPC pool összeállítása
const RPCS = [RPC1 || SOLANA_RPC, RPC2, RPC3, RPC4].filter(u => u && /^https?:\/\//i.test(u));
if (RPCS.length === 0) {
  console.error('❌ Nincs egyetlen HTTPS RPC megadva (RPC1 / SOLANA_RPC kötelező).');
  process.exit(1);
}
let rpcIndex = 0;
function nextConn() {
  const url = RPCS[rpcIndex % RPCS.length]; rpcIndex++;
  console.log('🔌 Using RPC:', url.slice(0, 68) + (url.length > 68 ? '...' : ''));
  return new Connection(url, 'confirmed');
}
let conn = nextConn();

const INCINERATOR = new PublicKey('1nc1nerator11111111111111111111111111111111');

// Programok több ENV-ből: RAYDIUM_PROGRAM1, RAYDIUM_PROGRAM2, ...
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
console.log('✅ POLL_MS =', POLL_MS, 'THRESHOLD =', THRESHOLD, 'SIG_LIMIT =', SIG_LIMIT);

/* ===== Állapot ===== */
const STATE_FILE = './state.json';
let state = { lastSigPerProgram: {}, seenLpMints: [], burnedMints: [], lastPollOkAt: 0, lastError: null };
try { if (fs.existsSync(STATE_FILE)) state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) }; }
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

/* ===== Rate-limit aware helper ===== */
let baseDelayMs = Number(POLL_MS);         // alap ciklusidő
let dynamicDelayMs = baseDelayMs;          // adaptív (429 esetén nő)
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
    lastWas429 = false;
    return sigs;
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('429') || msg.toLowerCase().includes('too many')) {
      // rate limit → növeljük a delayt, váltunk RPC-t
      lastWas429 = true;
      dynamicDelayMs = Math.min(dynamicDelayMs * 2, 120000); // max 2 perc
      console.warn(`⏳ 429 detected → backoff to ${dynamicDelayMs} ms, RPC rotate`);
      conn = nextConn();
      return [];
    }
    // más hiba
    console.warn('⚠️ getSignatures error:', msg);
    return [];
  }
}

async function safeGetTransaction(sig) {
  try {
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    return tx;
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

/* ===== Poll core ===== */
async function pollProgram(programPk) {
  const programStr = programPk.toBase58();
  const untilSig = state.lastSigPerProgram?.[programStr];

  const sigs = await safeGetSignatures(programPk, untilSig);
  if (sigs.length === 0) return;

  if (!untilSig) state.lastSigPerProgram[programStr] = sigs[0].signature;

  for (const s of sigs.reverse()) {
    const tx = await safeGetTransaction(s.signature);
    if (!tx || tx.meta?.err) continue;

    const found = findLpMintFromTx(tx);
    if (!found) continue;

    const { lpMint, reason } = found;
    if (!lpMint || seenSet.has(lpMint)) continue;

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
    // kis alvás két tx között, hogy ne burstöljön
    await new Promise(r => setTimeout(r, jitter(120)));
  }

  state.lastSigPerProgram[programStr] = sigs[0].signature;
  saveState();
}

async function pollAll() {
  try {
    for (const p of PROGRAMS) {
      await pollProgram(p);
      // per-program kis szünet (jitter), hogy eloszoljanak a kérések
      await new Promise(r => setTimeout(r, jitter(250)));
    }
    // Ha nem kaptunk 429-et ebben a körben, lassan csökkentjük a delayt az alap felé
    if (!lastWas429) {
      dynamicDelayMs = Math.max(baseDelayMs, Math.floor(dynamicDelayMs * 0.8));
    }
    state.lastPollOkAt = Date.now();
    state.lastError = null;
    saveState();
  } catch (e) {
    state.lastError = String(e?.message || e);
    console.error('❌ Poll error:', state.lastError);
    saveState();
  }
}

/* ===== Loop (adaptív) ===== */
async function loop() {
  await pollAll();
  setTimeout(loop, dynamicDelayMs);
}

console.log('🚀 LP burn poller (RPC) adaptív backoff-fal indul…');
loop();

/* ===== Graceful shutdown ===== */
function shutdown() {
  console.log('⏹️ Leállítás…');
  saveState();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
