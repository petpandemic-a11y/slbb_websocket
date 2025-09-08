// SLBB — Raydium LP Burn WebSocket watcher (Render/Helius) — env-ready
// Node >=18, "type": "module"
// Env VÁLTOZÓK: lásd a te .env fájlodat (ugyanazok a nevek)

import WebSocket from 'ws';
import fetch from 'node-fetch';
import http from 'http';

const {
  DEBUG = '1',
  DEXS_ENABLED = '0',                 // jelenleg nem kell hozzá, de meghagyom
  HELIUS_API_KEY,                     // csak log-hoz/azonosításhoz
  MAX_TOKEN_AGE_MIN = '1440',         // LP mint max kora (perc)
  MAX_VAULT_OUTFLOW = '0.001',        // SOL vault outflow max (heurisztika, remove-liq szűréshez)
  MINT_HISTORY_PAGES = '50',          // mint születés idejének becsléséhez
  MINT_HISTORY_PAGE_LIMIT = '1000',
  MIN_BURN_MINT_AGE_MIN = '15',       // túl friss LP mintek kiszűrése
  MIN_LP_BURN_PCT = '0.99',           // burn / total_supply (pl. 0.99 => >=99%)
  MIN_SOL_BURN = '0',                 // min. "LP mennyiség" UI-ben NEM értelmezett SOL-ra, de meghagyom
  PORT = '8080',
  RATE_MS = '12000',
  RPC_HTTP,                           // kötelező
  RPC_WSS,                            // kötelező
  TG_BOT_TOKEN,                       // opcionális
  TG_CHAT_ID                          // opcionális
} = process.env;

if (!RPC_HTTP || !RPC_WSS) {
  console.error('HIBA: RPC_HTTP és RPC_WSS kötelezően beállítandó az env-ben!');
  process.exit(1);
}

const dlog = (...a) => (DEBUG === '1' ? console.log('[DBG]', ...a) : void 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Program ID-k
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RAYDIUM_PROGRAMS = new Set([
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // CPMM
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // AMM v4 (legacy)
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // CLMM
  'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE'  // LP Locker (információs)
]);

// Heurisztikus LP-mint cache Raydium aktivitásból (±1 óra)
const lpMintCache = new Map(); // mint -> { firstSeenSlot, sourceProgram }
const ONE_HOUR_SLOTS = 60 * 60 * 2; // ~2 slot/s becslés

async function rpc(method, params) {
  const body = { jsonrpc: '2.0', id: 1, method, params };
  const res = await fetch(RPC_HTTP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function getTx(signature) {
  return rpc('getTransaction', [signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed'
  }]);
}

async function getSlot() {
  return rpc('getSlot', [{ commitment: 'confirmed' }]);
}

async function getTokenSupply(mint) {
  const r = await rpc('getTokenSupply', [mint, { commitment: 'confirmed' }]);
  // uiAmount + decimals bőven elég százalékhoz
  const ui = r?.value?.uiAmount ?? null;
  const dec = r?.value?.decimals ?? null;
  return { uiAmount: ui, decimals: dec };
}

// Mint "születésének" ideje — best-effort: a legrégebbi signature blockTime-ja
// (Helius RPC-n működik nagy limit mellett is; oldalszámozással iterálunk)
async function estimateMintCreationTime(mint) {
  // Figyelem: ez költséges lehet. RATE_MS csökkenti a terhelést.
  let before = undefined;
  const pages = Number(MINT_HISTORY_PAGES);
  const limit = Number(MINT_HISTORY_PAGE_LIMIT);
  let oldest = null;
  for (let p = 0; p < pages; p++) {
    const params = [mint, { limit, commitment: 'confirmed', before }];
    const sigs = await rpc('getSignaturesForAddress', params);
    if (!sigs?.length) break;
    for (const s of sigs) {
      if (s.blockTime) {
        if (!oldest || s.blockTime < oldest) oldest = s.blockTime;
      }
    }
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < limit) break;
    await sleep(Number(RATE_MS)); // ne verjük agyon az RPC-t
  }
  return oldest ? new Date(oldest * 1000) : null;
}

function learnPossibleLpMints(parsed) {
  const ix = parsed?.transaction?.message?.instructions || [];
  const slot = parsed?.slot;
  for (const i of ix) {
    const pid = i.programId?.toString?.() || i.programId;
    if (RAYDIUM_PROGRAMS.has(pid)) {
      const accounts = i.accounts?.map(a => a.toString?.() || a) || [];
      for (const acc of accounts) {
        if (!lpMintCache.has(acc)) {
          lpMintCache.set(acc, { firstSeenSlot: slot, sourceProgram: pid });
          dlog('Learned LP-candidate from Raydium activity:', acc);
        }
      }
    }
  }
}

async function pruneCache() {
  const slot = await getSlot();
  for (const [mint, meta] of lpMintCache) {
    if (slot - meta.firstSeenSlot > ONE_HOUR_SLOTS) {
      lpMintCache.delete(mint);
    }
  }
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
    if (postUi < preUi) {
      burns.push({ mint: b.mint, amountUi: preUi - postUi });
    }
  }
  return burns;
}

function isCandidateLp(mint) {
  return lpMintCache.has(mint);
}

// Heurisztika: remove-liquidity közben a pool vaultokból jelentős base/quote token outflow történik.
// Egyszerűen a logokban keressük a "Remove Liquidity" jellegű hívást, és/vagy
// a Raydium programok jelenlétét. A MAX_VAULT_OUTFLOW itt csupán kiegészítő, laza szűrő.
function vaultOutflowLikely(parsed) {
  const logs = parsed?.meta?.logMessages || [];
  if (hasRaydiumCall(parsed)) return true;
  // Ha a szolgáltató logolja a "Remove Liquidity" stringet:
  if (logs.some(l => /remove.*liquidity/i.test(l))) return true;
  // SOL outflow becslés: postBalances vs preBalances (lamports)
  const pre = parsed?.meta?.preBalances || [];
  const post = parsed?.meta?.postBalances || [];
  if (pre.length && post.length && pre.length === post.length) {
    let delta = 0;
    for (let i = 0; i < pre.length; i++) delta += (pre[i] - post[i]); // lamports csökkenés összesítve
    const sol = delta / 1e9;
    if (sol > Number(MAX_VAULT_OUTFLOW)) return true;
  }
  return false;
}

async function maybeSendTelegram(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const j = await res.json();
    if (!j.ok) dlog('TG send error:', j);
  } catch (e) {
    dlog('TG send exception:', e.message || e);
  }
}

function fmtPct(x) {
  return (x * 100).toFixed(2) + '%';
}

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

// --- WebSocket főhurok ---
function startWS() {
  let ws;
  let subId = null;
  let alive = false;

  const connect = () => {
    ws = new WebSocket(RPC_WSS);
    ws.on('open', () => {
      alive = true;
      console.log('[WS] connected');
      const req = {
        jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
        params: [
          { mentions: [TOKEN_PROGRAM] },
          { commitment: 'confirmed' }
        ]
      };
      ws.send(JSON.stringify(req));
    });

    ws.on('message', async (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }

      if (msg.result && !subId) {
        subId = msg.result;
        console.log('[WS] subscribed, id =', subId);
        return;
      }
      if (msg.method !== 'logsNotification') return;

      const { value } = msg.params;
      const { signature, logs } = value || {};
      if (!logs?.some(l => l.includes('Instruction: Burn'))) return;

      try {
        // Pihenő, hogy RATE_MS szerint ne áraszd el az RPC-t:
        await sleep(Number(RATE_MS));

        const parsed = await getTx(signature);
        if (!parsed) return;

        // LP jelöltek tanulása Raydium aktivitásból
        try { learnPossibleLpMints(parsed); } catch {}

        // Remove-liq vagy vault outflow gyanú -> skip
        if (vaultOutflowLikely(parsed)) {
          dlog('Skip — remove-liq/vault outflow:', signature);
          return;
        }

        // Burn-ek kigyűjtése
        const burns = extractBurns(parsed);
        if (!burns.length) return;

        const whenISO = parsed?.blockTime ? new Date(parsed.blockTime * 1000).toISOString() : 'n/a';

        for (const b of burns) {
          const mint = b.mint;

          // Csak LP-k: cache alapján
          if (!isCandidateLp(mint)) {
            dlog('Not LP candidate (skip):', mint, signature);
            continue;
          }

          // LP mint "érettsége": MIN_BURN_MINT_AGE_MIN és MAX_TOKEN_AGE_MIN
          const createdAt = await estimateMintCreationTime(mint);
          if (createdAt) {
            const ageMin = (Date.now() - createdAt.getTime()) / 60000;
            if (ageMin < Number(MIN_BURN_MINT_AGE_MIN)) {
              dlog(`Skip — LP mint túl friss (${ageMin.toFixed(1)} min):`, mint);
              continue;
            }
            if (ageMin > Number(MAX_TOKEN_AGE_MIN)) {
              dlog(`Skip — LP mint túl öreg (${ageMin.toFixed(1)} min):`, mint);
              continue;
            }
          } else {
            dlog('Mint creation time ismeretlen (engedjük tovább).');
          }

          // Arány: burn / total_supply
          const sup = await getTokenSupply(mint);
          if (sup.uiAmount == null || sup.uiAmount <= 0) {
            dlog('Supply ismeretlen/0 (skip):', mint);
            continue;
          }
          const pct = b.amountUi / sup.uiAmount;
          if (pct < Number(MIN_LP_BURN_PCT)) {
            dlog(`Skip — alacsony arány (${fmtPct(pct)} < ${fmtPct(Number(MIN_LP_BURN_PCT))})`, signature);
            continue;
          }

          const line = burnLine({
            sig: signature,
            whenISO,
            mint,
            amountUi: b.amountUi,
            pct,
            supplyUi: sup.uiAmount
          });

          console.log(line);
          await maybeSendTelegram(line);
        }
      } catch (e) {
        console.error('Handle error:', e.message || e);
      }
    });

    ws.on('close', () => {
      console.warn('[WS] closed — reconnecting in 2s');
      alive = false;
      setTimeout(connect, 2000);
    });

    ws.on('error', (err) => {
      console.error('[WS] error:', err?.message || err);
    });

    // Keepalive
    const ping = setInterval(() => { if (alive) try { ws.ping(); } catch {} }, 15000);
    // Cache prune
    const prune = setInterval(() => { pruneCache().catch(()=>{}); }, 60000);
  };

  connect();
}

// Egyszerű healthcheck (Render mögé)
http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type':'text/plain' });
  res.end('ok\n');
}).listen(Number(PORT), () => {
  console.log(`Healthcheck on :${PORT} — Helius=${HELIUS_API_KEY ? 'yes' : 'no'}, TG=${TG_BOT_TOKEN ? 'yes' : 'no'}`);
});

// Indítás
console.log('SLBB WS watcher starting…');
startWS();
