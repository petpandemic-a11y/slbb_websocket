import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, getMint } from '@solana/spl-token';

const {
  SOLANA_RPC,
  RAYDIUM_PROGRAMS =
    'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C,CAMMCzo5YL8w4VFF8KVHRk22GGUsp5VTaW7girrKgIrwQk',
  POLL_MS = '10000',
  THRESHOLD = '0.95',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID
} = process.env;

if (!SOLANA_RPC || !/^https?:\/\//i.test(SOLANA_RPC)) {
  console.error('Hiba: SOLANA_RPC hiányzik vagy nem http/https:', SOLANA_RPC);
  process.exit(1);
}
const PROGRAMS = RAYDIUM_PROGRAMS.split(',').map(s => s.trim()).filter(Boolean).map(s => new PublicKey(s));

console.log('RPC =', SOLANA_RPC.slice(0, 64) + '...');
console.log('Raydium programs =', PROGRAMS.map(p => p.toBase58()).join(', '));
console.log('POLL_MS =', POLL_MS, 'THRESHOLD =', THRESHOLD);

const conn = new Connection(SOLANA_RPC, 'confirmed');
const INCINERATOR = new PublicKey('1nc1nerator11111111111111111111111111111111');

/* ------ State ------ */
const STATE_FILE = './state.json';
let state = { lastSigPerProgram: {}, seenLpMints: [], burnedMints: [] };
try { if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
catch (e) { console.warn('State betöltés hiba, tiszta indulás:', e.message); }
const seenSet = new Set(state.seenLpMints || []);
const burnedSet = new Set(state.burnedMints || []);
function saveState() {
  state.seenLpMints = Array.from(seenSet);
  state.burnedMints = Array.from(burnedSet);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

/* ------ Telegram ------ */
async function tgNotify(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = { chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true, parse_mode: 'HTML' };
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) { console.warn('Telegram hiba:', e.message); }
}

/* ------ Burn check ------ */
async function isLpBurned100Percent(lpMintStr, threshold = Number(THRESHOLD)) {
  const lpMint = new PublicKey(lpMintStr);
  const incAta = await getAssociatedTokenAddress(lpMint, INCINERATOR, true);

  const mintInfo = await getMint(conn, lpMint);
  const supplyRaw = BigInt(mintInfo.supply.toString());
  if (supplyRaw === 0n) return false;

  let incBalRaw = 0n;
  try {
    const incAcc = await getAccount(conn, incAta);
    incBalRaw = BigInt(incAcc.amount.toString());
  } catch { return false; }

  const ratio = Number(incBalRaw) / Number(supplyRaw);
  return ratio >= threshold;
}

/* ------ Tx parse ------ */
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

/* ------ Poll core ------ */
async function pollProgram(programPk) {
  const programStr = programPk.toBase58();
  const untilSig = state.lastSigPerProgram?.[programStr];
  const sigs = await conn.getSignaturesForAddress(programPk, untilSig ? { until: untilSig, limit: 40 } : { limit: 40 });
  if (sigs.length === 0) return;

  if (!untilSig) state.lastSigPerProgram[programStr] = sigs[0].signature;

  for (const s of sigs.reverse()) {
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx || tx.meta?.err) continue;

    const found = findLpMintFromTx(tx);
    if (!found) continue;

    const { lpMint, reason } = found;
    if (!lpMint || seenSet.has(lpMint)) continue;
    seenSet.add(lpMint);
    saveState();

    let ok = false;
    try { ok = await isLpBurned100Percent(lpMint); }
    catch (e) { console.warn('Burn check hiba', lpMint, e.message); }

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

  state.lastSigPerProgram[programStr] = sigs[0].signature;
  saveState();
}

/* ------ Poll loop ------ */
async function pollAll() {
  try {
    for (const p of PROGRAMS) {
      await pollProgram(p);
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

console.log(`LP burn poller (RPC) indul… ${Number(POLL_MS)/1000}s-enként`);
const timer = setInterval(pollAll, Number(POLL_MS));

function shutdown() {
  console.log('Leállítás…');
  clearInterval(timer);
  saveState();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
