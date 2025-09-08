// test.js — Offline ellenőrzés egy signature-re, az index.js logikájával
// Használat: node test.js <TRANSACTION_SIGNATURE>

import { config } from 'dotenv';
import fetch from 'node-fetch';

config(); // Render env-ek beolvasása

const {
  DEBUG = '1',
  RPC_HTTP,
  RATE_MS = '12000',
  MIN_LP_BURN_PCT = '0.99',
  MIN_BURN_MINT_AGE_MIN = '15',
  MAX_TOKEN_AGE_MIN = '1440',
  MAX_VAULT_OUTFLOW = '0.001'
} = process.env;

if (!RPC_HTTP) {
  console.error('HIBA: RPC_HTTP nincs beállítva az env-ben.');
  process.exit(1);
}

const dlog = (...a) => (DEBUG === '1' ? console.log('[DBG]', ...a) : void 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Program ID-k
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RAYDIUM_PROGRAMS = new Set([
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // CPMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // CLMM
  'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE'  // LP Locker
]);

async function rpc(method, params) {
  const res = await fetch(RPC_HTTP, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params })
  });
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function getTx(sig) {
  return rpc('getTransaction', [sig, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed'
  }]);
}

async function getTokenSupply(mint) {
  const r = await rpc('getTokenSupply', [mint, { commitment: 'confirmed' }]);
  return { uiAmount: r?.value?.uiAmount ?? null, decimals: r?.value?.decimals ?? null };
}

async function getSlot() {
  return rpc('getSlot', [{ commitment: 'confirmed' }]);
}

// --- LP mint felismerés (heurisztika) ugyanúgy, mint index.js-ben ---
function learnPossibleLpMints(parsed) {
  const ix = parsed?.transaction?.message?.instructions || [];
  const slot = parsed?.slot;
  const candidates = new Set();
  for (const i of ix) {
    const pid = i.programId?.toString?.() || i.programId;
    if (RAYDIUM_PROGRAMS.has(pid)) {
      const accounts = i.accounts?.map(a => a.toString?.() || a) || [];
      for (const acc of accounts) candidates.add(acc);
    }
  }
  return { candidates, slot };
}

function hasRaydiumCall(parsed) {
  const ix = parsed?.transaction?.message?.instructions || [];
  return ix.some(i => RAYDIUM_PROGRAMS.has(i.programId?.toString?.() || i.programId));
}

function extractBurns(parsed) {
  const logs = parsed?.meta?.logMessages || [];
  if (!logs.some(l => l.includes('Instruction: Burn'))) return [];
  const pre = parsed?.meta?.preTokenBalances || [];
  const post = parsed?.meta?.postTokenBalances || [];
  const preMap = new Map();
  for (const b of pre) preMap.set(`${b.owner}:${b.mint}:${b.accountIndex}`, b);

  const burns = [];
  for (const b of post) {
    const key = `${b.owner}:${b.mint}:${b.accountIndex}`;
    const pb = preMap.get(key);
    if (!pb) continue;
    const preUi = Number(pb.uiTokenAmount?.uiAmount || 0);
    const postUi = Number(b.uiTokenAmount?.uiAmount || 0);
    if (postUi < preUi) burns.push({ mint: b.mint, amountUi: preUi - postUi });
  }
  return burns;
}

// remove-liq / vault outflow gyanú
function vaultOutflowLikely(parsed) {
  const logs = parsed?.meta?.logMessages || [];
  if (hasRaydiumCall(parsed)) return true;
  if (logs.some(l => /remove.*liquidity/i.test(l))) return true;
  const pre = parsed?.meta?.preBalances || [];
  const post = parsed?.meta?.postBalances || [];
  if (pre.length && post.length && pre.length === post.length) {
    let deltaLamports = 0;
    for (let i = 0; i < pre.length; i++) deltaLamports += (pre[i] - post[i]);
    const sol = deltaLamports / 1e9;
    if (sol > Number(MAX_VAULT_OUTFLOW)) return true;
  }
  return false;
}

// Mint „születési” idő — best effort
async function estimateMintCreationTime(mint) {
  // rövidített változat: 1 nagy oldal elég a teszthez
  const sigs = await rpc('getSignaturesForAddress', [mint, { limit: 1000, commitment: 'confirmed' }]);
  let oldest = null;
  for (const s of (sigs || [])) if (s.blockTime && (!oldest || s.blockTime < oldest)) oldest = s.blockTime;
  return oldest ? new Date(oldest * 1000) : null;
}

// formázás
function fmtPct(x) { return (x * 100).toFixed(2) + '%'; }
function burnLine({sig, whenISO, mint, amountUi, pct, supplyUi}) {
  return [
    '🔥 <b>LP BURN</b>',
    `🕒 <code>${whenISO}</code>`,
    `🧩 mint: <code>${mint}</code>`,
    `💧 amount: <b>${amountUi}</b>`,
    `📦 supply: ${supplyUi}`,
    `📉 share: <b>${fmtPct(pct)}</b>`,
    `🔗 sig: <code>${sig}</code>`
  ].join('\n');
}

(async () => {
  const sig = process.argv[2];
  if (!sig) {
    console.error('Használat: node test.js <TRANSACTION_SIGNATURE>');
    process.exit(1);
  }
  console.log('Lekérés:', sig);

  // kis pihenő, hogy ne spammeljük az RPC-t, és egyformán viselkedjen az index.js-sel
  await sleep(Number(RATE_MS));

  const parsed = await getTx(sig);
  if (!parsed) {
    console.error('Nincs ilyen tranzakció vagy nem érhető el.');
    process.exit(1);
  }

  // Remove-liq / vault outflow gyanú?
  if (vaultOutflowLikely(parsed)) {
    console.log('⚠️ Skip — remove-liquidity/vault outflow gyanú.');
    return;
  }

  const burns = extractBurns(parsed);
  if (!burns.length) {
    console.log('⚠️ Nincs SPL Burn ebben a tranzakcióban.');
    return;
  }

  // LP mint jelöltek Raydium-tevékenységből
  const { candidates } = learnPossibleLpMints(parsed);
  if (!candidates.size) dlog('Nincs Raydium-aktivitásból tanult LP jelölt.');

  const whenISO = parsed?.blockTime ? new Date(parsed.blockTime * 1000).toISOString() : 'n/a';

  for (const b of burns) {
    const mint = b.mint;

    // Csak LP jelölt?
    if (!candidates.has(mint)) {
      dlog('Burn, de nem LP jelölt (skip):', mint);
      continue;
    }

    // Mint kora
    const createdAt = await estimateMintCreationTime(mint);
    if (createdAt) {
      const ageMin = (Date.now() - createdAt.getTime()) / 60000;
      if (ageMin < Number(MIN_BURN_MINT_AGE_MIN)) {
        console.log(`⚠️ Skip — LP mint túl friss (${ageMin.toFixed(1)} min).`);
        continue;
      }
      if (ageMin > Number(MAX_TOKEN_AGE_MIN)) {
        console.log(`⚠️ Skip — LP mint túl öreg (${ageMin.toFixed(1)} min).`);
        continue;
      }
    } else {
      dlog('Mint creation time ismeretlen (engedékeny mód).');
    }

    // Arány ellenőrzés
    const sup = await getTokenSupply(mint);
    if (sup.uiAmount == null || sup.uiAmount <= 0) {
      console.log('⚠️ Skip — supply ismeretlen vagy 0.');
      continue;
    }
    const pct = b.amountUi / sup.uiAmount;
    if (pct < Number(MIN_LP_BURN_PCT)) {
      console.log(`⚠️ Skip — alacsony arány (${fmtPct(pct)} < ${fmtPct(Number(MIN_LP_BURN_PCT))}).`);
      continue;
    }

    // Megfelelt: írjuk ugyanúgy, mint az éles watcher
    const line = burnLine({
      sig,
      whenISO,
      mint,
      amountUi: b.amountUi,
      pct,
      supplyUi: sup.uiAmount
    });
    console.log(line);
  }
})();
