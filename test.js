// test.js — manuális teszt egy signature-re
// Futás: node test.js SIGNATURE

import { config } from 'dotenv';
import fetch from 'node-fetch';

config(); // .env betöltése

const { RPC_HTTP, DEBUG = '1' } = process.env;
if (!RPC_HTTP) {
  console.error('HIBA: RPC_HTTP nincs beállítva .env-ben');
  process.exit(1);
}

const dlog = (...a) => (DEBUG === '1' ? console.log('[DBG]', ...a) : void 0);

async function rpc(method, params) {
  const res = await fetch(RPC_HTTP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const j = await res.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

async function getTx(sig) {
  return rpc('getTransaction', [sig, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed'
  }]);
}

// --- egyszerű feldolgozás ---
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
    if (postUi < preUi) {
      burns.push({ mint: b.mint, amountUi: preUi - postUi });
    }
  }
  return burns;
}

(async () => {
  const sig = process.argv[2];
  if (!sig) {
    console.error('Használat: node test.js <TRANSACTION_SIGNATURE>');
    process.exit(1);
  }

  console.log('Lekérés:', sig);
  const parsed = await getTx(sig);
  if (!parsed) {
    console.error('Nincs ilyen tranzakció vagy nem érhető el.');
    process.exit(1);
  }

  const burns = extractBurns(parsed);
  if (!burns.length) {
    console.log('⚠️ Nincs SPL Burn ebben a tranzakcióban.');
  } else {
    console.log('🔥 Burn események:');
    for (const b of burns) {
      console.log(`Mint: ${b.mint}, Amount: ${b.amountUi}`);
    }
  }
})();
