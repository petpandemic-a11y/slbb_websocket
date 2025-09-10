// index.js
import 'dotenv/config';
import WebSocket from 'ws';
import fetch from 'node-fetch';

const {
  DEBUG,
  DEXS_ENABLED,
  HELIUS_API_KEY,
  MAX_TOKEN_AGE_MIN,
  MAX_VAULT_OUTFLOW,
  MINT_HISTORY_PAGES,
  MINT_HISTORY_PAGE_LIMIT,
  MIN_BURN_MINT_AGE_MIN,
  MIN_LP_BURN_PCT,
  MIN_SOL_BURN,
  PORT,
  RATE_MS,
  RPC_HTTP,
  RPC_WSS,
  TG_BOT_TOKEN,
  TG_CHAT_ID
} = process.env;

// Raydium AMM/CPMM programok
const RAYDIUM_PROGRAM_IDS = [
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "CAMMCzo5YL8w4VFF8KVHRk22GGUsp5VTaW7girrKgIrwQk"
];

// Incinerator
const INCINERATOR = "1nc1nerator11111111111111111111111111111111";

// Skip kulcsszavak
const SKIP_KEYWORDS = ["remove", "remove_liquidity", "withdraw", "remove-liquidity"];

const log = (...args) => { if (DEBUG) console.log('[DBG]', ...args); };

async function sendToTG(text) {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true
      })
    });
  } catch (e) {
    console.error("TG error:", e.message);
  }
}

function hasRemoveHints(obj) {
  const s = JSON.stringify(obj).toLowerCase();
  return SKIP_KEYWORDS.some(k => s.includes(k));
}

function includesRaydium(tx) {
  const txt = JSON.stringify(tx);
  return RAYDIUM_PROGRAM_IDS.some(id => txt.includes(id));
}

function extractBurns(tx) {
  const burns = [];
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const map = new Map();
  for (const p of pre) map.set(p.accountIndex, p);
  for (const q of post) {
    const p = map.get(q.accountIndex);
    if (!p) continue;
    const dec = q.uiTokenAmount?.decimals || 0;
    const preAmt = Number(p.uiTokenAmount?.amount || 0);
    const postAmt = Number(q.uiTokenAmount?.amount || 0);
    if (postAmt < preAmt) {
      const amt = (preAmt - postAmt) / Math.pow(10, dec);
      burns.push({ mint: q.mint, amount: amt });
    }
  }
  return burns;
}

function looksLikeLPBurn(tx) {
  if (!includesRaydium(tx)) return false;
  if (hasRemoveHints(tx)) return false;
  const burns = extractBurns(tx);
  return burns.length > 0;
}

function formatMsg(tx) {
  const sig = tx?.transaction?.signatures?.[0] || "";
  const time = tx?.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "";
  const burns = extractBurns(tx);
  let msg = `*LP Burn Detected* ✅\n`;
  msg += `Tx: \`${sig}\`\nTime: ${time}\n`;
  for (const b of burns) {
    msg += `Mint: \`${b.mint}\`\nAmount: ${b.amount}\n`;
  }
  msg += `[Solscan](https://solscan.io/tx/${sig})`;
  return msg;
}

function connect() {
  const ws = new WebSocket(RPC_WSS);
  ws.on("open", () => {
    log("WS opened");
    const sub = {
      jsonrpc: "2.0",
      id: 1,
      method: "transactionSubscribe",
      params: [{ accounts: { any: RAYDIUM_PROGRAM_IDS }, commitment: "confirmed" }]
    };
    ws.send(JSON.stringify(sub));
  });
  ws.on("message", async (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.method === "transactionNotification") {
      const tx = msg.params?.result?.transaction;
      if (looksLikeLPBurn(tx)) {
        const text = formatMsg(tx);
        await sendToTG(text);
      } else {
        log("Skip:", tx?.transaction?.signatures?.[0]);
      }
    }
  });
  ws.on("close", () => setTimeout(connect, 5000));
  ws.on("error", () => setTimeout(connect, 5000));
}

console.log("LP Burn watcher starting...");
connect();
