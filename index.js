// index.js — Raydium LP burn watcher (Helius WS) + Test mode
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

  // opcionálisak (env-ből jönnek, nem muszáj használni őket):
  MIN_LP_BURN_PCT,         // nem használjuk szigorúan, de marad a kompat miatt
  MIN_SOL_BURN,            // -||-
  MAX_VAULT_OUTFLOW,       // -||-
} = process.env;

// --- Konstansok / beállítások ---
const RAYDIUM_PROGRAM_IDS = [
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'CAMMCzo5YL8w4VFF8KVHRk22GGUsp5VTaW7girrKgIrwQk',
];

const INCINERATOR = '1nc1nerator11111111111111111111111111111111';

// minden remove-liquidity jelleg: skip
const SKIP_KEYWORDS = ['remove', 'remove_liquidity', 'withdraw', 'remove-liquidity'];

const log = (...a) => { if (String(DEBUG) === '1') console.log('[DBG]', ...a); };
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

// --- Segédfüggvények ---
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
  // Best-effort: összevetjük pre/post token egyenlegeket
  const burns = [];
  try {
    const pre = tx?.meta?.preTokenBalances || [];
    const post = tx?.meta?.postTokenBalances || [];
    const byIdx = new Map();
    for (const p of pre) byIdx.set(p.accountIndex, p);
    for (const q of post) {
      const p = byIdx.get(q.accountIndex);
      if (!p) continue;
      const dec = Number(q?.uiTokenAmount?.decimals || p?.uiTokenAmount?.decimals || 0);
      const preAmt = Number(p?.uiTokenAmount?.amount || 0);
      const postAmt = Number(q?.uiTokenAmount?.amount || 0);
      if (postAmt < preAmt) {
        const delta = (preAmt - postAmt) / Math.pow(10, dec);
        if (delta > 0) {
          burns.push({
            mint: q.mint,
            amount: delta,
          });
        }
      }
    }
  } catch (e) {
    log('extractBurns error:', e.message);
  }
  return burns;
}

function looksLikePureLPBurn(tx) {
  // Szigor:
  // 1) Raydium program jelen van
  // 2) NINCS remove-liquidity jellegű kulcsszó
  // 3) Van tényleges token-csökkenés (burn-szerű)
  if (!includesRaydium(tx)) return false;
  if (hasRemoveHints(tx)) return false;
  const burns = extractBurns(tx);
  if (burns.length === 0) return false;

  // Plusz óvatosság: ha két külön mint nagyot NŐ ugyanebben a tx-ben és nincs incinerator, az remove-ra utal
  try {
    const pre = tx?.meta?.preTokenBalances || [];
    const post = tx?.meta?.postTokenBalances || [];
    const agg = {};
    const idx = {};
    for (const p of pre) idx[`${p.mint}|${p.owner || ''}|${p.accountIndex}`] = p;
    for (const q of post) {
      const key = `${q.mint}|${q.owner || ''}|${q.accountIndex}`;
      const p = idx[key];
      if (!p) continue;
      const dec = Number(q?.uiTokenAmount?.decimals || p?.uiTokenAmount?.decimals || 0);
      const diff = (Number(q?.uiTokenAmount?.amount || 0) - Number(p?.uiTokenAmount?.amount || 0)) / Math.pow(10, dec);
      agg[q.mint] = (agg[q.mint] || 0) + diff;
    }
    const bigUps = Object.values(agg).filter(v => v > 0).length;
    const viaIncin = JSON.stringify(tx).includes(INCINERATOR);
    if (bigUps >= 2 && !viaIncin) return false; // inkább remove → skip
  } catch {}

  return true;
}

function fmtNum(x) {
  if (!isFinite(x)) return String(x);
  if (Math.abs(x) >= 1) return x.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return x.toExponential(4);
}

function buildMsg(tx) {
  const sig = tx?.transaction?.signatures?.[0] || tx?.transaction?.signature || tx?.signature || '';
  const slot = tx?.slot ?? '';
  const time = tx?.blockTime ? new Date(tx.blockTime * 1000).toISOString().replace('T',' ').replace('Z','') : '';
  const burns = extractBurns(tx);

  let out = `*LP Burn Detected* ✅\n`;
  if (sig) out += `*Tx:* \`${sig}\`\n`;
  if (time) out += `*Time:* ${time}\n`;
  if (slot) out += `*Slot:* ${slot}\n`;

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
    log('WebSocket opened:', wsUrl);
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
    log('Feliratkozás elküldve Raydium programokra.');
  });

  ws.on('message', async (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch { return; }
    if (m.method === 'transactionNotification') {
      const tx = m?.params?.result?.transaction || m?.params?.result;
      if (hasRemoveHints(tx)) {
        log('SKIP remove-hint:', tx?.transaction?.signatures?.[0] || '');
        return;
      }
      if (looksLikePureLPBurn(tx)) {
        const text = buildMsg(tx);
        await sendToTG(text);
        log('TG sent for:', tx?.transaction?.signatures?.[0] || '');
      } else {
        log('SKIP (not pure LP burn):', tx?.transaction?.signatures?.[0] || '');
      }
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
    const sigFound = tx?.transaction?.signatures?.[0] || sig;
    console.log('Tesztelt signature:', sigFound);
    const isLPBurn = looksLikePureLPBurn(tx);
    console.log('looksLikePureLPBurn:', isLPBurn);
    if (isLPBurn) {
      const text = buildMsg(tx);
      await sendToTG(text);
      console.log('Teszt üzenet elküldve TG-re.');
    } else {
      console.log('Teszt: SKIP (nem tiszta LP burn).');
    }
  } catch (e) {
    console.error('Teszt hiba:', e.message);
  }
}

// --- Indítás ---
(async function main() {
  console.log('LP Burn watcher starting…');
  if (process.argv[2]) {
    // teszt mód egy konkrét tx-re
    await testSignature(process.argv[2]);
  } else {
    connectWS();
  }
})();
