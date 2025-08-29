import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, getMint } from '@solana/spl-token';

const {
  RAYDIUM_POOLS_URL,
  SOLANA_RPC,
  POLL_MS = '10000',
  THRESHOLD = '0.95',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID
} = process.env;

if (!RAYDIUM_POOLS_URL || !SOLANA_RPC) {
  console.error('Hiányzó env: RAYDIUM_POOLS_URL vagy SOLANA_RPC');
  process.exit(1);
}
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn('Figyelem: nincs Telegram beállítva, nem lesz értesítés.');
}

const INCINERATOR = new PublicKey('1nc1nerator11111111111111111111111111111111');
const conn = new Connection(SOLANA_RPC, 'confirmed');

const STATE_FILE = './state.json';
let state = { lastSeenKey: 0 };

try {
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }
} catch (e) {
  console.warn('Nem sikerült beolvasni a state.json-t, újraindítjuk alapállapotról.');
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.warn('State mentés hiba:', e.message);
  }
}

function extractLpMint(poolObj) {
  // Alkalmazkodunk eltérő mezőnevekhez
  return poolObj.lpMint || poolObj.lpMintAddress || poolObj.lp || null;
}

function extractSortKey(poolObj) {
  // Próbáld a legfrissebb időbélyeget (ms vagy s). Ha nincs, 0.
  const k = poolObj.createdAt ?? poolObj.createTime ?? poolObj.updatedAt ?? poolObj.updateTime ?? 0;
  return Number(k);
}

async function isLpBurned100Percent(lpMintStr, threshold = Number(THRESHOLD)) {
  const lpMint = new PublicKey(lpMintStr);

  // Incinerator ATA (owner off-curve engedélyezve)
  const incAta = await getAssociatedTokenAddress(lpMint, INCINERATOR, true);

  // Teljes supply (raw integer)
  const mintInfo = await getMint(conn, lpMint);
  const supplyRaw = BigInt(mintInfo.supply.toString());
  if (supplyRaw === 0n) return false;

  // Incinerator balance
  let incBalRaw = 0n;
  try {
    const incAcc = await getAccount(conn, incAta);
    incBalRaw = BigInt(incAcc.amount.toString());
  } catch {
    // Ha nincs ATA, biztosan nem 95%+
    return false;
  }

  const ratio = Number(incBalRaw) / Number(supplyRaw);
  return ratio >= threshold;
}

async function fetchNewPools() {
  const res = await fetch(RAYDIUM_POOLS_URL);
  if (!res.ok) throw new Error(`Pools fetch failed: ${res.status}`);
  const data = await res.json();

  // A Raydium válasz lehet tömb vagy {data: [...]}
  const pools = Array.isArray(data) ? data : (data.data || data.pools || []);
  if (!Array.isArray(pools)) return [];

  // Rendezés csökkenő idő szerint
  pools.sort((a, b) => extractSortKey(b) - extractSortKey(a));

  // Első indításnál: csak regisztráljuk a legfrissebb kulcsot
  if (!state.lastSeenKey || state.lastSeenKey === 0) {
    const topKey = extractSortKey(pools[0]) || Date.now();
    state.lastSeenKey = topKey;
    saveState();
    return [];
  }

  // Csak az újak (nagyobb sortKey)
  const fresh = pools.filter(p => extractSortKey(p) > state.lastSeenKey);
  if (fresh.length > 0) {
    state.lastSeenKey = extractSortKey(fresh[0]);
    saveState();
  }
  return fresh;
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

function fmtPct(v) {
  return (v * 100).toFixed(2) + '%';
}

async function poll() {
  try {
    const newPools = await fetchNewPools();
    if (newPools.length === 0) return;

    for (const p of newPools) {
      const lpMint = extractLpMint(p);
      if (!lpMint) continue;

      let confirmed = false;
      try {
        confirmed = await isLpBurned100Percent(lpMint);
      } catch (e) {
        console.warn('check hiba', lpMint, e.message);
      }

      const id = p.id || p.poolId || '(no-id)';
      const when = extractSortKey(p);

      if (confirmed) {
        const msg = `🔥 <b>100% LP burn confirmed</b>\nLP mint: <code>${lpMint}</code>\nPool: ${id}\nTimeKey: ${when}`;
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

console.log(`LP burn poller indul… ${Number(POLL_MS)/1000}s-enként`);
setInterval(poll, Number(POLL_MS));
