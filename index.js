// index.js
// Node 18+ (ESM)
// LP burn/incinerator figyelő Raydium LP-kre, háttér cache + Dexscreener, DEBUG kapcsolóval

import WebSocket from "ws";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

// ===== Env =====
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const TG_TOKEN   = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const DEBUG      = (process.env.DEBUG || "0") === "1";

// Opcionális küszöbök (ha 0/üres, nem szűr)
const MIN_MCAP_USD     = Number(process.env.MIN_MCAP_USD || 0);
const MIN_LIQ_USD      = Number(process.env.MIN_LIQ_USD  || 0);
const MIN_LP_AMOUNT    = Number(process.env.MIN_LP_AMOUNT || 0);
const MIN_PAIR_AGE_MIN = Number(process.env.MIN_PAIR_AGE_MIN || 0); // Dexscreener pairCreatedAt alapján (ha van)
const REQUIRE_DEX_DATA = (process.env.REQUIRE_DEX_DATA || "false").toLowerCase() === "true";

if (!HELIUS_KEY || !TG_TOKEN || !TG_CHAT_ID) {
  console.error("Hiányzó env: HELIUS_API_KEY, TG_BOT_TOKEN, TG_CHAT_ID");
  process.exit(1);
}

// ===== Konstansok =====
const INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");

// ===== Közös util =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function nfmt(n) { const x = Number(n); return Number.isFinite(x) ? x.toLocaleString("en-US") : String(n ?? "?"); }
function iso(tsSec) { return tsSec ? new Date(tsSec * 1000).toISOString() : ""; }

async function fetchJsonWithTimeout(url, { timeoutMs = 10000, tries = 3, headers = {} } = {}) {
  for (let i = 1; i <= tries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      if (i === tries) throw e;
      if (DEBUG) console.log(`[retry ${i}] ${url} – ${e.message}`);
      await sleep(1000 * i);
    }
  }
}

// ===== Dexscreener =====
async function fetchDexscreenerData(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/solana/${mint}`;
    const data = await fetchJsonWithTimeout(url, { timeoutMs: 12000, tries: 2, headers: { accept: "application/json" } });
    const pairs = data?.pairs || [];
    if (!pairs.length) return null;
    const p = pairs.find(x => x.dexId === "raydium") || pairs[0];
    return {
      name: p.baseToken?.name ?? "",
      symbol: p.baseToken?.symbol ?? "",
      mcap: Number(p.fdv ?? p.marketCap ?? 0),
      liq: Number(p.liquidity?.usd ?? 0),
      url: `https://dexscreener.com/solana/${p.pairAddress}`,
      pairCreatedAtMs: Number(p.pairCreatedAt ?? 0),
      raw: p
    };
  } catch (e) {
    if (DEBUG) console.log("Dexscreener hiba:", e.message);
    return null;
  }
}

// ===== Telegram =====
async function tgSend(msg) {
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: "HTML", disable_web_page_preview: true })
    });
  } catch (e) {
    if (DEBUG) console.log("TG küldés hiba:", e.message);
  }
}

// ===== Raydium LP cache (háttérben) =====
let raydiumLpSet = new Set();

async function refreshRaydiumLpSet() {
  try {
    const pools = await fetchJsonWithTimeout(
      "https://api.raydium.io/v2/main/pairs",
      { timeoutMs: 15000, tries: 3, headers: { accept: "application/json" } }
    );
    const mints = (pools || []).map(p => p.lpMint).filter(Boolean);
    raydiumLpSet = new Set(mints);
    if (DEBUG) console.log(`Raydium LP cache frissítve: ${mints.length} mint`);
  } catch (e) {
    if (DEBUG) console.log("Raydium LP frissítés hiba:", e.message);
  }
}
// első frissítés indulás után, majd 10 percenként
setTimeout(refreshRaydiumLpSet, 0);
setInterval(refreshRaydiumLpSet, 10 * 60 * 1000);

// ===== Értesítés-építő + szűrés =====
async function handleHit({ type, mint, amount, sig, tsSec }) {
  const when = iso(tsSec);
  const amtNum = Number(amount || 0);

  if (DEBUG) {
    console.log("\n--- DEBUG START ---");
    console.log("Tx:", sig);
    console.log("Type:", type);
    console.log("Mint:", mint);
    console.log("Amount:", amount);
    console.log("Timestamp:", when);
  }

  // LP amount minimum
  if (MIN_LP_AMOUNT > 0 && !(Number.isFinite(amtNum) && amtNum >= MIN_LP_AMOUNT)) {
    if (DEBUG) console.log("⛔ MIN_LP_AMOUNT szűrő miatt kiesett");
    return;
  }

  const dex = await fetchDexscreenerData(mint);

  if (REQUIRE_DEX_DATA && !dex) {
    if (DEBUG) console.log("⛔ REQUIRE_DEX_DATA=true, de nincs Dex adat");
    return;
  }

  if (dex) {
    if (MIN_MCAP_USD > 0 && !(dex.mcap >= MIN_MCAP_USD)) {
      if (DEBUG) console.log("⛔ MIN_MCAP_USD szűrő miatt kiesett");
      return;
    }
    if (MIN_LIQ_USD > 0 && !(dex.liq >= MIN_LIQ_USD)) {
      if (DEBUG) console.log("⛔ MIN_LIQ_USD szűrő miatt kiesett");
      return;
    }
    if (MIN_PAIR_AGE_MIN > 0 && dex.pairCreatedAtMs > 0 && tsSec) {
      const ageMin = (tsSec * 1000 - dex.pairCreatedAtMs) / 60000;
      if (!(ageMin >= MIN_PAIR_AGE_MIN)) {
        if (DEBUG) console.log(`⛔ Pár túl friss: ${ageMin.toFixed(2)} min (< ${MIN_PAIR_AGE_MIN})`);
        return;
      }
    }
  } else if (MIN_MCAP_USD > 0 || MIN_LIQ_USD > 0 || MIN_PAIR_AGE_MIN > 0) {
    // ha bármely küszöb be van állítva és nincs dex adat, szigorúan eldobjuk
    if (DEBUG) console.log("⛔ Küszöbök aktívak, de nincs Dex adat → drop");
    return;
  }

  let msgTxt =
    `🔥 <b>${type} DETECTED</b>\n\n` +
    `Mint: <code>${mint}</code>\n` +
    `Amount: ${amount}\n` +
    `Time: ${when}\n` +
    `<a href="https://solscan.io/tx/${sig}">[Tx link]</a>\n\n`;

  if (dex) {
    msgTxt +=
      `<b>${dex.name || "?"} (${dex.symbol || "?"})</b>\n` +
      `MCAP: $${nfmt(dex.mcap)}\n` +
      `Liquidity: $${nfmt(dex.liq)}\n` +
      `<a href="${dex.url}">[Dexscreener]</a>`;
  } else {
    msgTxt += `<i>No Dexscreener data</i>`;
  }

  console.log(msgTxt);
  await tgSend(msgTxt);

  if (DEBUG) console.log("--- DEBUG END ---\n");
}

// ===== WebSocket indulása (nem blokkol LP-cache-re) =====
function startWs() {
  const url = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
  const ws = new WebSocket(url);
  const seen = new Set(); // (sig:mint:type) dedupe

  ws.on("open", () => {
    console.log("Helius WS connected ✅");
    const sub = {
      jsonrpc: "2.0",
      id: 1,
      method: "transactionSubscribe",
      params: [{ commitment: "confirmed" }, { encoding: "jsonParsed" }]
    };
    ws.send(JSON.stringify(sub));
  });

  ws.on("message", async raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.method !== "transactionNotification") return;
      const tx = msg?.params?.result;
      const sig = tx?.signature;
      const tsSec = tx?.timestamp;

      const hits = [];

      // 1) tokenTransfers → incinerator ATA
      for (const t of tx.tokenTransfers || []) {
        const { mint, toTokenAccount, tokenAmount } = t || {};
        if (!mint) continue;

        // Ha Raydium cache van és NEM tartalmazza a mintet → biztosan nem Raydium LP → skip
        if (raydiumLpSet.size && !raydiumLpSet.has(mint)) {
          if (DEBUG) console.log(`[${sig}] skip (nem Raydium LP): ${mint}`);
          continue;
        }

        // incinerator ATA kiszámítása on-the-fly
        let incAta;
        try {
          incAta = getAssociatedTokenAddressSync(new PublicKey(mint), INCINERATOR, true).toBase58();
        } catch { continue; }

        if (toTokenAccount === incAta) {
          hits.push({ type: "INCINERATOR", mint, amount: tokenAmount });
        }
      }

      // 2) SPL Burn
      for (const i of tx.instructions || []) {
        if (i.programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" && i.parsed?.type === "burn") {
          const mint = i.parsed?.info?.mint;
          if (!mint) continue;
          if (raydiumLpSet.size && !raydiumLpSet.has(mint)) {
            if (DEBUG) console.log(`[${sig}] skip burn (nem Raydium LP): ${mint}`);
            continue;
          }
          hits.push({ type: "BURN", mint, amount: i.parsed?.info?.amount });
        }
      }

      for (const h of hits) {
        const key = `${sig}:${h.mint}:${h.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await handleHit({ ...h, sig, tsSec });
      }

      // memória prune
      if (seen.size > 50000) {
        const keep = Array.from(seen).slice(-20000);
        seen.clear();
        for (const k of keep) seen.add(k);
      }
    } catch (e) {
      if (DEBUG) console.log("WS message parse error:", e.message);
    }
  });

  ws.on("close", () => {
    console.log("WS closed, reconnecting…");
    setTimeout(() => startWs(), 3000);
  });

  ws.on("error", (err) => {
    if (DEBUG) console.log("WS error:", err?.message || String(err));
  });
}

// ===== MAIN =====
startWs();
