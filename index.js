// index.js
// LP burn/incinerator figyelő Raydium LP-kre, Dexscreener adatokkal, debug kapcsolóval

import WebSocket from "ws";
import fetch from "node-fetch";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const DEBUG = (process.env.DEBUG || "0") === "1";

if (!HELIUS_KEY || !TG_TOKEN || !TG_CHAT_ID) {
  console.error("Állítsd be: HELIUS_API_KEY, TG_BOT_TOKEN, TG_CHAT_ID az .env-ben!");
  process.exit(1);
}

// Szűrők (maradhatnak, de minden logolva lesz, hogy miért szűrt)
const MIN_MCAP_USD = Number(process.env.MIN_MCAP_USD || 0);
const MIN_LIQ_USD  = Number(process.env.MIN_LIQ_USD  || 0);
const MIN_LP_AMOUNT = Number(process.env.MIN_LP_AMOUNT || 0);

const INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");

// Dexscreener fetch
async function fetchDexscreenerData(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/solana/${mint}`;
    const res = await fetch(url, { headers: { "accept": "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.pairs?.length) return null;

    const p = data.pairs.find(x => x.dexId === "raydium") || data.pairs[0];
    return {
      name: p.baseToken?.name ?? "",
      symbol: p.baseToken?.symbol ?? "",
      mcap: Number(p.fdv ?? p.marketCap ?? 0),
      liq: Number(p.liquidity?.usd ?? 0),
      url: `https://dexscreener.com/solana/${p.pairAddress}`,
      raw: p
    };
  } catch (e) {
    if (DEBUG) console.error("Dex fetch error:", e.message);
    return null;
  }
}

// Telegram küldő
async function tgSend(msg) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: "HTML", disable_web_page_preview: true })
  });
}

// Raydium LP lista
async function fetchRaydiumLpMints() {
  const url = "https://api.raydium.io/v2/main/pairs";
  const res = await fetch(url);
  if (!res.ok) throw new Error("Nem tudtam lekérni Raydium pool listát");
  const pools = await res.json();
  return pools.map(p => p.lpMint).filter(Boolean);
}

// Formázó
function nfmt(n) {
  const num = Number(n);
  return Number.isFinite(num) ? num.toLocaleString("en-US") : String(n);
}

// Helius WS
function startWs(lpMints) {
  const url = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
  const ws = new WebSocket(url);

  const incAtas = new Map();
  for (const mintStr of lpMints) {
    try {
      const mint = new PublicKey(mintStr);
      const ata = getAssociatedTokenAddressSync(mint, INCINERATOR, true);
      incAtas.set(mintStr, ata.toBase58());
    } catch {}
  }
  const lpMintSet = new Set(incAtas.keys());
  const seen = new Set();

  ws.on("open", () => {
    console.log("Helius WS connected ✅");
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "transactionSubscribe",
      params: [{ commitment: "confirmed" }, { encoding: "jsonParsed" }]
    }));
  });

  ws.on("message", async raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.method !== "transactionNotification") return;

      const tx = msg?.params?.result;
      const sig = tx?.signature;
      const tsIso = tx?.timestamp ? new Date(tx.timestamp * 1000).toISOString() : "";

      let hits = [];

      // tokenTransfers
      for (const t of tx.tokenTransfers || []) {
        const { mint, toTokenAccount, tokenAmount } = t || {};
        if (!mint) continue;
        if (!lpMintSet.has(mint)) continue;
        const incAta = incAtas.get(mint);
        if (incAta && toTokenAccount === incAta) {
          hits.push({ type: "INCINERATOR", mint, amount: tokenAmount });
        }
      }

      // Burn instructions
      for (const i of tx.instructions || []) {
        if (i.programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" && i.parsed?.type === "burn") {
          const mint = i.parsed?.info?.mint;
          if (mint && lpMintSet.has(mint)) {
            hits.push({ type: "BURN", mint, amount: i.parsed?.info?.amount });
          }
        }
      }

      for (const h of hits) {
        const dedupeKey = `${sig}:${h.mint}:${h.type}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        if (DEBUG) {
          console.log("\n--- DEBUG START ---");
          console.log("Tx:", sig);
          console.log("Type:", h.type);
          console.log("Mint:", h.mint);
          console.log("Amount:", h.amount);
          console.log("Timestamp:", tsIso);
        }

        const amt = Number(h.amount || 0);
        if (MIN_LP_AMOUNT > 0 && !(amt >= MIN_LP_AMOUNT)) {
          if (DEBUG) console.log("⛔ Filtered out: MIN_LP_AMOUNT not met");
          continue;
        }

        const dex = await fetchDexscreenerData(h.mint);
        if (dex && DEBUG) {
          console.log("Dexscreener data:", {
            name: dex.name,
            symbol: dex.symbol,
            mcap: dex.mcap,
            liq: dex.liq,
          });
        }

        if (dex) {
          if (MIN_MCAP_USD > 0 && dex.mcap < MIN_MCAP_USD) {
            if (DEBUG) console.log("⛔ Filtered out: MIN_MCAP_USD not met");
            continue;
          }
          if (MIN_LIQ_USD > 0 && dex.liq < MIN_LIQ_USD) {
            if (DEBUG) console.log("⛔ Filtered out: MIN_LIQ_USD not met");
            continue;
          }
        }

        let msgTxt =
          `🔥 <b>${h.type} DETECTED</b>\n\n` +
          `Mint: <code>${h.mint}</code>\n` +
          `Amount: ${h.amount}\n` +
          `Time: ${tsIso}\n` +
          `<a href="https://solscan.io/tx/${sig}">[Tx link]</a>\n\n`;

        if (dex) {
          msgTxt +=
            `<b>${dex.name} (${dex.symbol})</b>\n` +
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
    } catch (e) {
      if (DEBUG) console.error("Parsing error:", e.message);
    }
  });

  ws.on("close", () => {
    console.log("WS closed, reconnecting…");
    setTimeout(() => startWs(lpMints), 3000);
  });
}

// MAIN
(async () => {
  try {
    console.log("Raydium LP mintek lekérése…");
    const lpMints = await fetchRaydiumLpMints();
    console.log(`Talált LP mints: ${lpMints.length}`);
    startWs(lpMints);
  } catch (e) {
    console.error("Hiba:", e);
    process.exit(1);
  }
})();
