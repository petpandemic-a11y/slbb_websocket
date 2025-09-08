// SLBB — Raydium LP Burn WebSocket watcher (mintAuthority check) — v2
// Node >=18, "type": "module"

import WebSocket from 'ws';
import fetch from 'node-fetch';
import http from 'http';

const {
  DEBUG = '1',
  HELIUS_API_KEY,               // csak log infó
  RPC_HTTP,                     // kötelező
  RPC_WSS,                      // kötelező
  PORT = '8080',
  // Küszöbök / opciók (megtartva a régieket)
  MIN_LP_BURN_PCT = '0.99',
  MIN_BURN_MINT_AGE_MIN = '0',  // ha 0: nincs alsó korlát
  MAX_TOKEN_AGE_MIN = '525600', // 1 év (gyakorlatilag off)
  RATE_MS = '8000',
  MAX_VAULT_OUTFLOW = '0.5',    // SOL – laza védelem remove-liq ellen
  TG_BOT_TOKEN,
  TG_CHAT_ID
} = process.env;

if (!RPC_HTTP || !RPC_WSS) {
  console.error('HIBA: RPC_HTTP és RPC_WSS kötelező!');
  process.exit(1);
}

const dlog = (...a) => (DEBUG === '1' ? console.log('[DBG]', ...a) : void 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Program IDs
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
  return rpc('getTransaction', [sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
}

async function getTokenSupply(mint) {
  const r = await rpc('getTokenSupply', [mint, { commitment: 'confirmed' }]);
  return { uiAmount: r?.value?.uiAmount ?? null, decimals: r?.value?.decimals ?? null };
}

async function getMintInfo(mint) {
  const r = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return r?.value?.data?.parsed?.info || null;
}

function isRaydiumMint(info) {
  if (!info) return false;
  const ma = info.mintAuthority || null;
  const fa = info.freezeAuthority || null;
  return (ma && RAYDIUM_PROGRAMS.has(ma)) || (fa && RAYDIUM_PROGRAMS.has(fa));
}

function hasBurnLog(parsed) {
  const logs = parsed?.meta?.logMessages || [];
  return logs.some(l => l.includes('Instruction: Burn'));
}

function extractBurns(parsed) {
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

// remove-liq / nagy SOL kiáramlás heurisztika (opcionális védelem)
function vaultOutflowLikely(parsed) {
  const logs = parsed?.meta?.logMessages || [];
  const pre = parsed?.meta?.preBalances || [];
  const post = parsed?.meta?.postBalances || [];
  if (pre.length && post.length && pre.length === post.length) {
    let deltaLamports = 0;
    for (let i = 0; i < pre.length; i++) deltaLamports += (pre[i] - post[i]);
    const sol = deltaLamports / 1e9;
    if (sol > Number(MAX_VAULT_OUTFLOW)) return true;
  }
  // Ha a szolgáltató beírja a logokba:
  if (logs.some(l => /remove.*liquidity/i.test(l))) return true;
  return false;
}

async function estimateMintCreationTime(mint) {
  const sigs = await rpc('getSignaturesForAddress', [mint, { limit: 1000, commitment: 'confirmed' }]);
  let oldest = null;
  for (const s of (sigs || [])) if (s.blockTime && (!oldest || s.blockTime < oldest)) oldest = s.blockTime;
  return oldest ? new Date(oldest * 1000) : null;
}

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

async function maybeSendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const j = await res.json();
    if (!j.ok) dlog('TG send error:', j);
  } catch (e) {
    dlog('TG send exception:', e.message || e);
  }
}

// --- WebSocket loop (mintAuthority ellenőrzéssel) ---
function startWS() {
  let ws, subId = null, alive = false;

  const connect = () => {
    ws = new WebSocket(RPC_WSS);

    ws.on('open', () => {
      alive = true;
      console.log('[WS] connected');
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
        params: [{ mentions: [TOKEN_PROGRAM] }, { commitment: 'confirmed' }]
      }));
    });

    ws.on('message', async (buf) => {
      let msg; try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg.result && !subId) { subId = msg.result; console.log('[WS] subscribed, id =', subId); return; }
      if (msg.method !== 'logsNotification') return;

      const { value } = msg.params;
      const { signature, logs } = value || {};
      if (!logs?.some(l => l.includes('Instruction: Burn'))) return;

      try {
        await sleep(Number(RATE_MS)); // kíméletes RPC-terhelés
        const parsed = await getTx(signature);
        if (!parsed || !hasBurnLog(parsed)) return;

        if (vaultOutflowLikely(parsed)) {
          dlog('Skip — remove-liq/vault outflow gyanú:', signature);
          return;
        }

        const burns = extractBurns(parsed);
        if (!burns.length) return;

        const whenISO = parsed?.blockTime ? new Date(parsed.blockTime * 1000).toISOString() : 'n/a';

        for (const b of burns) {
          const mint = b.mint;

          // 🔑 LP-azonosítás: mintAuthority/freezeAuthority Raydium?
          const info = await getMintInfo(mint);
          if (!isRaydiumMint(info)) {
            dlog('Skip — nem Raydium LP mint:', mint);
            continue;
          }

          // Mint kora (opcionális)
          const createdAt = await estimateMintCreationTime(mint);
          if (createdAt) {
            const ageMin = (Date.now() - createdAt.getTime()) / 60000;
            if (ageMin < Number(MIN_BURN_MINT_AGE_MIN)) { dlog(`Skip — túl friss LP mint (${ageMin.toFixed(1)} min)`); continue; }
            if (ageMin > Number(MAX_TOKEN_AGE_MIN)) { dlog(`Skip — túl öreg LP mint (${ageMin.toFixed(1)} min)`); continue; }
          }

          // Arányszűrés
          const sup = await getTokenSupply(mint);
          if (sup.uiAmount == null || sup.uiAmount <= 0) { dlog('Skip — ismeretlen/0 supply'); continue; }
          const pct = b.amountUi / sup.uiAmount;
          if (pct < Number(MIN_LP_BURN_PCT)) { dlog(`Skip — alacsony arány ${fmtPct(pct)}`); continue; }

          const line = burnLine({ sig: signature, whenISO, mint, amountUi: b.amountUi, pct, supplyUi: sup.uiAmount });
          console.log(line);
          await maybeSendTelegram(line);
        }
      } catch (e) {
        console.error('Handle error:', e.message || e);
      }
    });

    ws.on('close', () => { console.warn('[WS] closed — reconnecting in 2s'); alive = false; setTimeout(connect, 2000); });
    ws.on('error', (err) => { console.error('[WS] error:', err?.message || err); });
    setInterval(() => { if (alive) try { ws.ping(); } catch {} }, 15000);
  };

  connect();
}

// Healthcheck
http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type':'text/plain' });
  res.end('ok\n');
}).listen(Number(PORT), () => {
  console.log(`Healthcheck on :${PORT} — Helius=${HELIUS_API_KEY ? 'yes' : 'no'}, TG=${TG_BOT_TOKEN ? 'yes' : 'no'}`);
});

// Start
console.log('SLBB WS watcher (mintAuthority) starting…');
startWS();
