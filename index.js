import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, getMint } from '@solana/spl-token';

/* ===== ENV ===== */
const {
  PUMPPORTAL_WS = 'wss://pumpportal.fun/api/data',
  PUMPPORTAL_METHOD = 'subscribeMigration',
  SOLANA_RPC,
  THRESHOLD = '0.95',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
} = process.env;

if (!/^wss?:\/\//i.test(PUMPPORTAL_WS)) {
  console.error('Hiba: PUMPPORTAL_WS nincs beállítva vagy nem ws/wss URL:', PUMPPORTAL_WS);
  process.exit(1);
}
if (!SOLANA_RPC || !/^https?:\/\//i.test(SOLANA_RPC)) {
  console.error('Hiba: SOLANA_RPC hiányzik vagy nem http/https:', SOLANA_RPC);
  process.exit(1);
}

console.log('PUMPPORTAL_WS =', PUMPPORTAL_WS);
console.log('PUMPPORTAL_METHOD =', PUMPPORTAL_METHOD);
console.log('SOLANA_RPC =', SOLANA_RPC.slice(0, 64) + '...');
console.log('THRESHOLD =', THRESHOLD);

/* ===== Állandók, állapot ===== */
const INCINERATOR = new PublicKey('1nc1nerator11111111111111111111111111111111');
const conn = new Connection(SOLANA_RPC, 'confirmed');

const STATE_FILE = './state.json';
let state = { burnedMints: [], seenMints: [] };
try {
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }
} catch (e) {
  console.warn('State betöltés hiba, tiszta indulás:', e.message);
}
const burnedSet = new Set(state.burnedMints || []);
const seenSet = new Set(state.seenMints || []);
function saveState() {
  try {
    state.burnedMints = Array.from(burnedSet);
    state.seenMints = Array.from(seenSet);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    console.warn('State mentés hiba:', e.message);
  }
}

/* ===== Segédek ===== */
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
function pick(obj, ...keys) { for (const k of keys) { if (obj && obj[k] != null) return obj[k]; } }

/* ===== LP burn ellenőrzés (incinerator arány) ===== */
async function isLpBurned100Percent(lpMintStr, threshold = Number(THRESHOLD)) {
  const lpMint = new PublicKey(lpMintStr);
  const incAta = await getAssociatedTokenAddress(lpMint, INCINERATOR, true);

  const mintInfo = await getMint(conn, lpMint); // supply raw integer
  const supplyRaw = BigInt(mintInfo.supply.toString());
  if (supplyRaw === 0n) return false;

  let incBalRaw = 0n;
  try {
    const incAcc = await getAccount(conn, incAta);
    incBalRaw = BigInt(incAcc.amount.toString());
  } catch {
    // nincs incinerator ATA -> biztos nem 95%+
    return false;
  }
  const ratio = Number(incBalRaw) / Number(supplyRaw);
  return ratio >= threshold;
}

/* ===== Esemény kezelése a WS feedről ===== */
async function handleMigrationEvent(ev) {
  // a PumpPortal migration esemény formátuma szolgáltatófüggő,
  // próbálunk rugalmasan mezőt találni:
  const lpMint =
    pick(ev, 'raydiumLpMint', 'raydium_lp_mint', 'lpMint', 'lp_mint', 'lp') ||
    pick(ev?.data, 'raydiumLpMint', 'lpMint', 'lp');

  if (!lpMint) {
    console.log('⚠️ Eseményben nincs lpMint:', JSON.stringify(ev).slice(0, 240));
    return;
  }
  if (seenSet.has(lpMint)) return; // már feldolgoztuk
  seenSet.add(lpMint);
  saveState();

  const symbol = pick(ev, 'symbol', 'ticker', 'sym') || pick(ev?.data, 'symbol', 'ticker');
  const name = pick(ev, 'name', 'tokenName') || pick(ev?.data, 'name', 'tokenName');
  const tx = pick(ev, 'signature', 'sig', 'tx') || pick(ev?.data, 'signature', 'tx');

  let ok = false;
  try {
    ok = await isLpBurned100Percent(lpMint);
  } catch (e) {
    console.warn('Check hiba', lpMint, e.message);
    return;
  }

  if (ok && !burnedSet.has(lpMint)) {
    burnedSet.add(lpMint);
    saveState();
    const msg = [
      '🔥 <b>100% LP burn confirmed</b>',
      symbol || name ? `Token: <b>${symbol || name}</b>` : null,
      `LP mint: <code>${lpMint}</code>`,
      tx ? `Tx: <code>${tx}</code>` : null
    ].filter(Boolean).join('\n');
    console.log(msg.replace(/<[^>]+>/g, ''));
    await tgNotify(msg);
  } else {
    console.log(`ℹ️ Nem 95%+: ${lpMint}${symbol ? ' ('+symbol+')' : ''}`);
  }
}

/* ===== WebSocket kliens ===== */
function startWS() {
  const ws = new WebSocket(PUMPPORTAL_WS);

  ws.on('open', () => {
    console.log('PumpPortal WS: open → feliratkozás:', PUMPPORTAL_METHOD);
    // A PumpPortal egyszerű metódusneveket vár JSON-ban:
    ws.send(JSON.stringify({ method: PUMPPORTAL_METHOD }));
    // életjel (néhány szolgáltató igényli)
    const pingInt = setInterval(() => {
      try { ws.ping(); } catch {}
    }, 30000);
    ws.on('close', () => clearInterval(pingInt));
  });

  ws.on('message', async (buf) => {
    const text = buf.toString();
    try {
      const data = JSON.parse(text);
      // lehet lista vagy egyedi objektum:
      const list = Array.isArray(data) ? data : (data.data || data.result || data.items || [data]);
      for (const it of list) {
        await handleMigrationEvent(it);
      }
    } catch (e) {
      console.warn('WS parse hiba:', e.message, 'head=', text.slice(0, 200));
    }
  });

  ws.on('error', (err) => {
    console.error('PumpPortal WS error:', err.message);
  });

  ws.on('close', (code) => {
    console.log('PumpPortal WS: close', code, '→ reconnect 3s');
    setTimeout(startWS, 3000);
  });
}

/* ===== Start ===== */
console.log('LP burn figyelés indul (PumpPortal WebSocket)…');
startWS();

function shutdown() {
  console.log('Leállítás…');
  saveState();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
