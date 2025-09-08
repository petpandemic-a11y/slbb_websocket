// index.js
// Node 18+
// Funkciók: Raydium LP mintek begyűjtése + Helius WS figyelés + TG értesítés

import WebSocket from "ws";
import fetch from "node-fetch";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

if (!HELIUS_KEY || !TG_TOKEN || !TG_CHAT_ID) {
  console.error("Állítsd be: HELIUS_API_KEY, TG_BOT_TOKEN, TG_CHAT_ID az .env-ben!");
  process.exit(1);
}

const INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");

// ================== RAYDIUM LP LISTA BEGYŰJTÉS ==================
async function fetchRaydiumLpMints() {
  const url = "https://api.raydium.io/v2/main/pairs"; // hivatalos pool-lista
  const res = await fetch(url);
  if (!res.ok) throw new Error("Nem tudtam lekérni Raydium pool listát");
  const pools = await res.json();
  return pools
    .map(p => p.lpMint)
    .filter(Boolean);
}

// ================== TELEGRAM KÜLDŐ ==================
async function tgSend(msg) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text: msg,
      parse_mode: "HTML"
    })
  });
}

// ================== HELIUS WEBSOCKET ==================
function startWs(lpMints) {
  const url = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
  const ws = new WebSocket(url);

  // Precompute incinerator ATAs
  const incAtas = new Map();
  for (const mintStr of lpMints) {
    try {
      const mint = new PublicKey(mintStr);
      const ata = getAssociatedTokenAddressSync(mint, INCINERATOR, true);
      incAtas.set(mintStr, ata.toBase58());
    } catch (_) {}
  }

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
      const ts = tx?.timestamp ? new Date(tx.timestamp * 1000).toISOString() : "";

      let hits = [];

      // 1) tokenTransfers → incinerator ATA
      for (const t of tx.tokenTransfers || []) {
        const { mint, toTokenAccount, tokenAmount } = t;
        if (!mint) continue;
        const incAta = incAtas.get(mint);
        if (incAta && toTokenAccount === incAta) {
          hits.push({ type: "INCINERATOR", mint, amount: tokenAmount });
        }
      }

      // 2) instructions → Burn
      for (const i of tx.instructions || []) {
        if (i.programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" && i.parsed?.type === "burn") {
          const mint = i.parsed?.info?.mint;
          if (incAtas.has(mint)) {
            hits.push({ type: "BURN", mint, amount: i.parsed?.info?.amount });
          }
        }
      }

      // ha volt találat
      for (const h of hits) {
        const msgTxt =
          `🔥 <b>${h.type} DETECTED</b>\n\n` +
          `Mint: <code>${h.mint}</code>\n` +
          `Amount: ${h.amount}\n` +
          `Time: ${ts}\n` +
          `<a href="https://solscan.io/tx/${sig}">[Tx link]</a>`;

        console.log(msgTxt);
        await tgSend(msgTxt);
      }

    } catch (e) {
      // swallow
    }
  });

  ws.on("close", () => {
    console.log("WS closed, reconnecting…");
    setTimeout(() => startWs(lpMints), 3000);
  });
}

// ================== MAIN ==================
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
