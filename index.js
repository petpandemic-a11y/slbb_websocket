import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, getMint } from '@solana/spl-token';

/* ======== ENV & CONST ======== */
const {
  RAYDIUM_POOLS_URL,
  SOLANA_RPC,
  POLL_MS = '10000',
  THRESHOLD = '0.95',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID
} = process.env;

if (!SOLANA_RPC || !/^https?:\/\//i.test(SOLANA_RPC)) {
  console.error('Hiba: SOLANA_RPC hiányzik vagy nem http/https:', SOLANA_RPC);
  process.exit(1);
}

console.log('RAYDIUM_POOLS_URL =', JSON.stringify(RAYDIUM_POOLS_URL));
console.log('SOLANA_RPC =', SOLANA_RPC?.slice(0, 60) + '...');
console.log('POLL_MS =', POLL_MS, 'THRESHOLD =', THRESHOLD);

const INCINERATOR = new PublicKey('1nc1nerator11111111111111111111111111111111');
const conn = new Connection(SOLANA_RPC, 'confirmed');

const STATE_FILE = './state.json';
let state = { lastSeenKey: 0, burnedMints: [] };

try {
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }
} catch (e) {
  console.warn('State betöltés hiba, új állapot indul:', e.message);
}
const burnedSet = new Set(state.burnedMints || []);

function saveState() {
  try {
    state.burnedMints = Array.from(burnedSet);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.warn('State mentés hiba:', e.message);
  }
}

/* ======== HELPERS ======== */
function extractLpMint(poolObj) {
  return poolObj?.lpMint || poolObj?.lpMintAddress || poolObj?.lp || null;
}
function extractSortKey(poolObj) {
  // időbélyeg jellegű kulcsok egyikét használjuk
  const k = poolObj?.createdAt ?? poolObj?.createTime ?? poolObj?.updatedAt ?? poolObj?.updateTime ?? 0;
  return Number(k) || 0;
}

async function tgNotify(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = { chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true, parse_mode: 'HTML' };
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    console.warn('Telegram hiba:', e.message);
  }
}

/* ======== POOLS FETCH (fallback-okkal) ======== */
async function fetchPoolsWithFallback() {
  const candidates = [
    RAYDIUM_POOLS_URL,                                 // amit env-ben megadtál
    'https://api-v3.raydium.io/pools',                 // általános listázó
    'https://api-v3.raydium.io/pools/info',            // részletes lista
    'https://api-v3.raydium.io/ammV3/pools'            // egyes edge-eknél ez él
  ].filter(Boolean);

  for (const url of candidates) {
    try {
      console.log('Trying pools URL:', url);
      const r = await fetch(url);
      const text = await r.text();
      if (!r.ok) {
        console.error(`Fetch ${url} -> HTTP ${r.status}. Body head:`, text.slice(0, 200));
        continue;
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        console.error(`Fetch ${url} -> 200, de nem JSON. Head:`, text.slice(0, 200));
        continue;
      }
      const pools = Array.isArray(json) ? json : (json.data || json.pools || []);
      if (!Array.isArray(pools)) {
        console.error(`Fetch ${url} -> JSON ok, de nincs pools tömb. Keys:`, Object.keys(json));
        continue;
      }
      console.log(`Using pools URL: ${url} (count=${pools.length})`);
      return pools;
    } catch (e) {
      console.error(`Fetch ${url} exception:`, e.message);
    }
  }
  throw new Error('Minden pools endpoint elbukott.');
}

/* ======== LP BURN CHECK ======== */
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
  } catch {
    return false; // nincs ATA -> biztos nem 95%+
  }
  const ratio = Number(incBalRaw) / Number(supplyRaw);
  return ratio >= threshold;
}

/* ======== POLLING ======== */
async function fetchNewPools() {
  const pools = await fetchPoolsWithFallback();

  // csökkenő időrend
  pools.sort((a, b) => extractSortKey(b) - extractSortKey(a));

  if (!state.lastSeenKey || state.lastSeenKey === 0) {
    const topKey = extractSortKey(pools[0]) || Date.now();
    state.lastSeenKey = topKey;
    saveState();
    return [];
  }

  const fresh = pools.filter(p => extractSortKey(p) > state.lastSeenKey);
  if (fresh.length > 0) {
    state.lastSeenKey = extractSortKey(fresh[0]);
    saveState();
  }
  return fresh;
}

async function poll() {
  try {
    const newPools = await fetchNewPools();
    if (newPools.length === 0) return;

    for (const p of newPools) {
      const lpMint = extractLpMint(p);
      if (!lpMint) continue;
      if (burnedSet.has(lpMint)) continue; // ne duplázzuk

      let confirmed = false;
      try {
        confirmed = await isLpBurned100Percent(lpMint);
      } catch (e) {
        console.warn('Check hiba', lpMint, e.message);
      }

      const id = p.id || p.poolId || '(no-id)';
      const when = extractSortKey(p);

      if (confirmed) {
        burnedSet.add(lpMint);
        saveState();
        const msg = [
          '🔥 <b>100% LP burn confirmed</b>',
          `LP mint: <code>${lpMint}</code>`,
          `Pool: ${id}`,
          `TimeKey: ${when}`
        ].join('\n');
        console.log(msg.replace(/<[^>]+>/g, ''));
        await tgNotify(msg);
      } else {
        console.log(`ℹ️ Nem 95%+: ${lpMint} (pool: ${id})`);
      }
    }
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

/* ======== START ======== */
console.log(`LP burn poller indul… ${Number(POLL_MS)/1000}s-enként`);
const timer = setInterval(poll, Number(POLL_MS));

function shutdown() {
  console.log('Leállítás…');
  clearInterval(timer);
  saveState();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
