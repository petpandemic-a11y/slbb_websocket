// index.js — Raydium LP burn watcher (Helius WS) + Test mode + REASON logging + Raydium Authority mint check
import 'dotenv/config';
import WebSocket from 'ws';
import fetch from 'node-fetch';

const {
  DEBUG,
  HELIUS_API_KEY,          // nem kötelező, ha RPC_WSS és RPC_HTTP megadva
  RPC_WSS,                 // pl: wss://mainnet.helius-rpc.com/?api-key=...
  RPC_HTTP,                // pl: https://mainnet.helius-rpc.com/?api-key=...
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  // opcionális — vesszővel elválasztott Raydium Authority címek (mintAuthority-k)
  // pl.: RAYDIUM_AUTHORITIES=5L5o...xyz,7qUk...abc
  RAYDIUM_AUTHORITIES = ''
} = process.env;

// --- Konstansok / beállítások ---
// Raydium AMM/CPMM programok (ha a tx-ben ezek nincsenek, még átmehet authority alapján)
const RAYDIUM_PROGRAM_IDS = [
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'CAMMCzo5YL8w4VFF8KVHRk22GGUsp5VTaW7girrKgIrwQk',
];

const RAYDIUM_AUTH_SET = new Set(
  RAYDIUM_AUTHORITIES.split(',').map(s => s.trim()).filter(Boolean)
);

const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
const SKIP_KEYWORDS = ['remove', 'remove_liquidity', 'withdraw', 'remove-liquidity'];

const logDbg = (...a) => { if (String(DEBUG) === '1') console.log('[DBG]', ...a); };
const wsUrl = RPC_WSS || (HELIUS_API_KEY ? `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null);
const httpUrl = RPC_HTTP || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null);

// --- Telegram ---
async function sendToTG(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.error('Hiányzó TG_BOT_TOKEN vagy TG_CHAT_ID');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) console.error('Telegram hiba:', res.status, await res.text());
  } catch (e) {
    console.error('Telegram küldési hiba:', e.message);
  }
}

// --- Segédfüggvények (Raydium program/LP-burn) ---
function hasRemoveHints(obj) {
  try {
    const s = JSON.stringify(obj).toLowerCase();
    return SKIP_KEYWORDS.some(k => s.includes(k));
  } catch {
    return false;
  }
}

function includesRaydium(tx) {
  try {
    const s = JSON.stringify(tx);
    return RAYDIUM_PROGRAM_IDS.some(id => s.includes(id));
  } catch {
    return false;
  }
}

function extractBurns(tx) {
  // Best-effort: pre/post token egyenlegek differenciája
  const burns = [];
  try {
    const pre = tx?.meta?.preTokenBalances || [];
    const post = tx?.meta?.postTokenBalances || [];
    const byIdx = new Map();
    for (const p of pre) byIdx.set(p.accountIndex, p);
    for (const q of post) {
      const p = byIdx.get(q.accountIndex);
      if (!p) continue;
      const dec = Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const preAmt = Number(p?.uiTokenAmount?.amount || 0);
      const postAmt = Number(q?.uiTokenAmount?.amount || 0);
      if (postAmt < preAmt) {
        const delta = (preAmt - postAmt) / Math.pow(10, dec);
        if (delta > 0) {
          burns.push({ mint: q.mint, amount: delta });
        }
      }
    }
  } catch (e) {
    logDbg('extractBurns error:', e.message);
  }
  return burns;
}

function analyzeUnderlyingMovements(tx) {
  // Mintenkénti nettó változás (post - pre), decimallal skálázva
  try {
    const pre = tx?.meta?.preTokenBalances || [];
    const post = tx?.meta?.postTokenBalances || [];
    const idx = {};
    for (const p of pre) idx[`${p.mint}|${p.owner || ''}|${p.accountIndex}`] = p;

    const agg = {};
    for (const q of post) {
      const key = `${q.mint}|${q.owner || ''}|${q.accountIndex}`;
      const p = idx[key];
      if (!p) continue;
      const dec = Number(q?.uiTokenAmount?.decimals ?? p?.uiTokenAmount?.decimals ?? 0);
      const diff = (Number(q?.uiTokenAmount?.amount || 0) - Number(p?.uiTokenAmount?.amount || 0)) / Math.pow(10, dec);
      agg[q.mint] = (agg[q.mint] || 0) + diff;
    }
    return agg; // { mint: netChange }
  } catch (e) {
    logDbg('analyzeUnderlyingMovements error:', e.message);
    return {};
  }
}

// --- Mint authority lekérdezés/cache ---
const mintAuthCache = new Map(); // mint -> { authority: string|null, when: number }

async function fetchMintAuthority(mint) {
  if (!httpUrl) return null;
  if (mintAuthCache.has(mint)) return mintAuthCache.get(mint).authority;

  try {
    const body = {
      jsonrpc: '2.0',
      id: 'mintinfo',
      method: 'getAccountInfo',
      params: [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]
    };
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await res.json();
    const authority = j?.result?.value?.data?.parsed?.info?.mintAuthority ?? null;
    mintAuthCache.set(mint, { authority, when: Date.now() });
    logDbg('mintAuthority', mint, '→', authority);
    return authority;
  } catch (e) {
    logDbg('fetchMintAuthority err:', e.message);
    return null;
  }
}

async function anyBurnMintHasRaydiumAuthority(burns) {
  for (const b of burns) {
    const auth = await fetchMintAuthority(b.mint);
    if (auth && RAYDIUM_AUTH_SET.has(auth)) return { ok: true, authority: auth };
  }
  return { ok: false };
}

// --- Döntés: miért (nem) tiszta LP burn ---
async function whyNotPureLPBurn(tx) {
  // 1) Remove-liquidity jelleg
  if (hasRemoveHints(tx)) return { ok: false, reason: 'remove_hint' };

  // 2) Van LP-szerű token csökkenés?
  const burns = extractBurns(tx);
  if (burns.length === 0) return { ok: false, reason: 'no_lp_delta' };

  // 3) Raydium nyom: (A) Raydium program-ID a tx-ben VAGY (B) a burnölt mint(ek) authority-je Raydium
  let raydiumEvidence = includesRaydium(tx) ? 'program' : '';
  if (!raydiumEvidence && RAYDIUM_AUTH_SET.size > 0 && httpUrl) {
    const authHit = await anyBurnMintHasRaydiumAuthority(burns);
    if (authHit.ok) raydiumEvidence = 'authority';
  }
  if (!raydiumEvidence) return { ok: false, reason: 'no_raydium_and_no_authority_match' };

  // 4) Remove ellenőrzés: ha két underlying nettó nő és nincs incinerator → inkább remove
  try {
    const agg = analyzeUnderlyingMovements(tx);
    const viaIncin = JSON.stringify(tx).includes(INCINERATOR);
    const bigUps = Object.values(agg).filter(v => v > 0).length;
    if (bigUps >= 2 && !viaIncin) {
      return { ok: false, reason: 'double_underlying_no_incin', details: { bigUps } };
    }
  } catch {}

  return { ok: true, reason: 'ok', burns, raydiumEvidence };
}

function fmtNum(x) {
  if (!isFinite(x)) return String(x);
  if (Math.abs(x) >= 1) return x.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return x.toExponential(4);
}

function buildMsg(tx, reasonInfo) {
  const sig = tx?.transaction?.signatures?.[0] || tx?.transaction?.signature || tx?.signature || '';
  const slot = tx?.slot ?? '';
  const time = tx?.blockTime ? new Date(tx.blockTime * 1000).toISOString().replace('T',' ').replace('Z','') : '';
  const burns = reasonInfo?.burns ?? extractBurns(tx);

  let out = `*LP Burn Detected* ✅\n`;
  if (sig) out += `*Tx:* \`${sig}\`\n`;
  if (time) out += `*Time:* ${time}\n`;
  if (slot) out += `*Slot:* ${slot}\n`;
  if (reasonInfo?.raydiumEvidence) {
    out += `*Raydium evidence:* ${reasonInfo.raydiumEvidence}\n`;
  }

  const byMint = new Map();
  for (const b of burns) {
    const prev = byMint.get(b.mint) || 0;
    byMint.set(b.mint, prev + b.amount);
  }
  for (const [mint, total] of byMint.entries()) {
    out += `*LP Mint:* \`${mint}\`\n*Burned:* ${fmtNum(total)}\n`;
  }
  if (sig) {
    out += `[Solscan](https://solscan.io/tx/${sig}) | [SolanaFM](https://solana.fm/tx/${sig})`;
  }
  return out;
}

// --- WebSocket kapcsolat ---
let ws;
let reconnTimer;
const RECONNECT_MS = 5000;

function connectWS() {
  if (!wsUrl) {
    console.error('Hiányzik RPC_WSS (vagy HELIUS_API_KEY). Állítsd be az .env-ben.');
    process.exit(1);
  }
  ws = new WebSocket(wsUrl);
  ws.on('open', () => {
    logDbg('WebSocket opened:', wsUrl);
    const sub = {
      jsonrpc: '2.0',
      id: 1,
      method: 'transactionSubscribe',
      params: [{
        accounts: { any: RAYDIUM_PROGRAM_IDS },
        commitment: 'confirmed'
      }]
    };
    ws.send(JSON.stringify(sub));
    logDbg('Feliratkozás elküldve Raydium programokra.');
  });

  ws.on('message', async (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.method === 'transactionNotification') {
      const tx = m?.params?.result?.transaction || m?.params?.result;
      const sig = tx?.transaction?.signatures?.[0] || '';

      const check = await whyNotPureLPBurn(tx);

      if (!check.ok) {
        console.log(`SKIP ${sig} reason=${check.reason}`);
        return;
      }

      // OK → TG
      const text = buildMsg(tx, check);
      await sendToTG(text);
      console.log(`ALERT ${sig} reason=${check.reason} evidence=${check.raydiumEvidence || 'program'}`);
    }
  });

  ws.on('close', (c, r) => {
    console.error('WebSocket closed:', c, r?.toString?.() || '');
    scheduleReconnect();
  });
  ws.on('error', (e) => {
    console.error('WebSocket error:', e?.message || e);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnTimer) return;
  reconnTimer = setTimeout(() => {
    reconnTimer = null;
    connectWS();
  }, RECONNECT_MS);
}

// --- Teszt mód: node index.js <signature> ---
// Kiírja a mintAuthority-ket is, hogy fel tudd venni az .env-be
async function testSignature(sig) {
  if (!httpUrl) {
    console.error('Hiányzik RPC_HTTP (vagy HELIUS_API_KEY). Állítsd be az .env-ben.');
    process.exit(1);
  }
  try {
    const body = {
      jsonrpc: '2.0',
      id: 'test',
      method: 'getTransaction',
      params: [sig, { maxSupportedTransactionVersion: 0 }]
    };
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json();
    const tx = j?.result;
    if (!tx) {
      console.error('Nem találtam tranzakciót ehhez a signature-höz.');
      console.error(j);
      return;
    }
    const burns = extractBurns(tx);
    if (burns.length) {
      for (const b of burns) {
        const auth = await fetchMintAuthority(b.mint);
        console.log(`mint=${b.mint} mintAuthority=${auth || 'null'}`);
      }
    }
    const check = await whyNotPureLPBurn(tx);
    console.log(`TEST ${sig} looksLikePureLPBurn=${check.ok} reason=${check.reason} evidence=${check.raydiumEvidence || ''}`);
    if (check.ok) {
      const text = buildMsg(tx, check);
      await sendToTG(text);
      console.log('Teszt üzenet elküldve TG-re.');
    }
  } catch (e) {
    console.error('Teszt hiba:', e.message);
  }
}

// --- Indítás ---
(async function main() {
  console.log('LP Burn watcher starting…');
  if (process.argv[2]) {
    await testSignature(process.argv[2]);
  } else {
    connectWS();
  }
})();
