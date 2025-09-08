// index.js
// Raydium LP burn/incinerator watcher
// - Helius WS: logsSubscribe(Token) + transactionSubscribe(ALL)
// - Keepalive, heartbeat, backoff
// - Raydium LP cache (background)
// - Incinerator + SPL Burn detektálás
// - Dexscreener adatok
// - Rövid debug logok + feliratkozás OK log + 15s után "widen" mód
// Megjegyzés: Node 18+ környezetben a global fetch elérhető.

// ── Imports ───────────────────────────────────────────────────────────────────
import WebSocket from "ws";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

// ── ENV ───────────────────────────────────────────────────────────────────────
const HELIUS_KEY = process.env.HELIUS_API_KEY;
const TG_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const DEBUG = (process.env.DEBUG || "0") === "1";
const DISABLE_RAYDIUM_FILTER = (process.env.DISABLE_RAYDIUM_FILTER || "0") === "1";

// Opcionális küszöbök (0 = kikapcsolva)
const MIN_MCAP_USD = Number(process.env.MIN_MCAP_USD || 0);
const MIN_LIQ_USD = Number(process.env.MIN_LIQ_USD || 0);
const MIN_LP_AMOUNT = Number(process.env.MIN_LP_AMOUNT || 0);
const MIN_PAIR_AGE_MIN = Number(process.env.MIN_PAIR_AGE_MIN || 0);
const REQUIRE_DEX_DATA = (process.env.REQUIRE_DEX_DATA || "false").toLowerCase() === "true";

if (!HELIUS_KEY || !TG_TOKEN || !TG_CHAT_ID) {
  console.error("Missing env: HELIUS_API_KEY, TG_BOT_TOKEN, TG_CHAT_ID");
  process.exit(1);
}

// ── Const / utils ─────────────────────────────────────────────────────────────
const INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function nfmt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toLocaleString("en-US") : String(n ?? "?");
}
function iso(tsSec) {
  return tsSec ? new Date(tsSec * 1000).toISOString() : "";
}

async function fetchJsonWithTimeout(url, opts = {}) {
  const { timeoutMs = 10000, tries = 3, headers = {} } = opts;
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
  return null;
}

// ── Dexscreener ───────────────────────────────────────────────────────────────
async function fetchDexscreenerData(mint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/solana/${mint}`;
    const data = await fetchJsonWithTimeout(url, {
      timeoutMs: 12000,
      tries: 2,
      headers: { accept: "application/json" },
    });
    const pairs = data?.pairs || [];
    if (!pairs.length) return null;
    const p = pairs.find((x) => x.dexId === "raydium") || pairs[0];
    return {
      name: p.baseToken?.name ?? "",
      symbol: p.baseToken?.symbol ?? "",
      mcap: Number(p.fdv ?? p.marketCap ?? 0),
      liq: Number(p.liquidity?.usd ?? 0),
      url: `https://dexscreener.com/solana/${p.pairAddress}`,
      pairCreatedAtMs: Number(p.pairCreatedAt ?? 0),
    };
  } catch (e) {
    if (DEBUG) console.log("Dexscreener error:", e.message);
    return null;
  }
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function tgSend(msg) {
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: msg,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    if (DEBUG) console.log("Telegram send error:", e.message);
  }
}

// ── Raydium LP cache (background) ─────────────────────────────────────────────
let raydiumLpSet = new Set();

async function refreshRaydiumLpSet() {
  try {
    const pools = await fetchJsonWithTimeout("https://api.raydium.io/v2/main/pairs", {
      timeoutMs: 15000,
      tries: 3,
      headers: { accept: "application/json" },
    });
    const mints = (pools || []).map((p) => p.lpMint).filter(Boolean);
    raydiumLpSet = new Set(mints);
    if (DEBUG) console.log(`Raydium LP cache refreshed: ${mints.length} mints`);
  } catch (e) {
    if (DEBUG) console.log("Raydium LP refresh failed:", e.message);
  }
}
setTimeout(refreshRaydiumLpSet, 0);
setInterval(refreshRaydiumLpSet, 10 * 60 * 1000);

// ── Hit handler + filters ─────────────────────────────────────────────────────
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

  if (MIN_LP_AMOUNT > 0 && !(Number.isFinite(amtNum) && amtNum >= MIN_LP_AMOUNT)) {
    if (DEBUG) console.log("⛔ filtered: MIN_LP_AMOUNT");
    return;
  }

  const dex = await fetchDexscreenerData(mint);
  if (REQUIRE_DEX_DATA && !dex) {
    if (DEBUG) console.log("⛔ filtered: REQUIRE_DEX_DATA but no Dex data");
    return;
  }

  if (dex) {
    if (MIN_MCAP_USD > 0 && dex.mcap < MIN_MCAP_USD) {
      if (DEBUG) console.log("⛔ filtered: MIN_MCAP_USD");
      return;
    }
    if (MIN_LIQ_USD > 0 && dex.liq < MIN_LIQ_USD) {
      if (DEBUG) console.log("⛔ filtered: MIN_LIQ_USD");
      return;
    }
    if (MIN_PAIR_AGE_MIN > 0 && dex.pairCreatedAtMs > 0 && tsSec) {
      const ageMin = (tsSec * 1000 - dex.pairCreatedAtMs) / 60000;
      if (ageMin < MIN_PAIR_AGE_MIN) {
        if (DEBUG) console.log(`⛔ filtered: pair age ${ageMin.toFixed(2)}m < ${MIN_PAIR_AGE_MIN}m`);
        return;
      }
    }
  } else if (MIN_MCAP_USD > 0 || MIN_LIQ_USD > 0 || MIN_PAIR_AGE_MIN > 0) {
    if (DEBUG) console.log("⛔ filtered: thresholds set but no Dex data");
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
    msgTxt += "<i>No Dexscreener data</i>";
  }

  console.log(msgTxt);
  await tgSend(msgTxt);

  if (DEBUG) console.log("--- DEBUG END ---\n");
}

// ── WebSocket (logsSubscribe + transactionSubscribe ALL) ───────────────────────
function startWs() {
  const url = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
  let backoffMs = 1000;
  let ws;
  let pingTimer = null;
  let heartbeatTimer = null;
  let lastMsgTs = Date.now();
  let processed = 0;
  const seen = new Set();

  if (DEBUG) {
    console.log("ENV check:", {
      HELIUS_API_KEY: HELIUS_KEY ? `len=${HELIUS_KEY.length}` : "MISSING",
      TG_BOT_TOKEN: !!TG_TOKEN,
      TG_CHAT_ID: TG_CHAT_ID,
      DEBUG,
      DISABLE_RAYDIUM_FILTER,
    });
  }

  const openWs = () => {
    ws = new WebSocket(url);

    ws.on("open", () => {
      console.log("Helius WS connected ✅");
      backoffMs = 1000;
      lastMsgTs = Date.now();

      // 1) Token program logs
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [{ mentions: [TOKEN_PROGRAM_ID], commitment: "confirmed" }, { encoding: "jsonParsed" }],
        }),
      );
      // 2) Minden tranzakció (ALL)
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "transactionSubscribe",
          params: [{ commitment: "confirmed" }, { encoding: "jsonParsed" }],
        }),
      );
      console.log("[SUB] logsSubscribe(Token) + transactionSubscribe(ALL)");

      // 15s után, ha nincs üzenet → widen logs (mentions nélkül)
      setTimeout(() => {
        const idleSec = Math.floor((Date.now() - lastMsgTs) / 1000);
        if (idleSec >= 15) {
          console.log("[WIDEN] No messages for 15s → logsSubscribe without filter");
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              method: "logsSubscribe",
              params: [{ commitment: "confirmed" }, { encoding: "jsonParsed" }],
            }),
          );
        }
      }, 15000);

      // keepalive ping 20s
      pingTimer = setInterval(() => {
        try {
          ws.ping();
        } catch {
          /* noop */
        }
      }, 20000);

      // heartbeat 60s
      heartbeatTimer = setInterval(() => {
        const idleSec = Math.floor((Date.now() - lastMsgTs) / 1000);
        console.log(`[HB] alive, processed=${processed}, raydiumCache=${raydiumLpSet.size}, idle=${idleSec}s`);
        if (idleSec > 300) {
          if (DEBUG) console.log("[HB] idle too long → manual reconnect");
          try {
            ws.terminate();
          } catch {
            /* noop */
          }
        }
      }, 60000);
    });

    ws.on("pong", () => {
      // noop
    });

    ws.on("message", async (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        // Feliratkozás visszaigazolás
        if (data.id === 1 && data.result) {
          console.log(`[SUB OK] logsSubscribe id=${data.result}`);
          return;
        }
        if (data.id === 2 && data.result) {
          console.log(`[SUB OK] transactionSubscribe id=${data.result}`);
          return;
        }
        if (data.id === 3 && data.result) {
          console.log(`[SUB OK] logsSubscribe (widen) id=${data.result}`);
          return;
        }

        if (DEBUG && data.method && data.params) {
          const m = data.method;
          const sig =
            data.params?.result?.value?.signature ||
            data.params?.result?.signature ||
            "";
          console.log(`[RX] ${m}${sig ? ` sig=${sig}` : ""}`);
        }

        // LOGS jelzés
        if (data.method === "logsNotification") {
          lastMsgTs = Date.now();
          return;
        }

        // TRANSACTION feldolgozás
        if (data.method !== "transactionNotification") return;
        lastMsgTs = Date.now();

        const tx = data?.params?.result;
        const sig = tx?.signature;
        const tsSec = tx?.timestamp;

        const hits = [];

        // tokenTransfers → incinerator ATA
        for (const t of tx.tokenTransfers || []) {
          const { mint, toTokenAccount, tokenAmount } = t || {};
          if (DEBUG) {
            console.log(`[CHECK tokenTransfer] sig=${sig} mint=${mint} to=${toTokenAccount} amt=${tokenAmount}`);
          }
          if (!mint) continue;

          if (!DISABLE_RAYDIUM_FILTER && raydiumLpSet.size && !raydiumLpSet.has(mint)) {
            continue;
          }

          let incAta;
          try {
            incAta = getAssociatedTokenAddressSync(new PublicKey(mint), INCINERATOR, true).toBase58();
          } catch {
            continue;
          }

          if (toTokenAccount === incAta) {
            hits.push({ type: "INCINERATOR", mint, amount: tokenAmount });
          }
        }

        // SPL Burn
        for (const i of tx.instructions || []) {
          if (DEBUG) {
            const p = i.programId;
            const t = i.parsed?.type;
            const m = i.parsed?.info?.mint;
            console.log(`[CHECK instr] sig=${sig} prog=${p} type=${t} mint=${m}`);
          }
          if (i.programId === TOKEN_PROGRAM_ID && i.parsed?.type === "burn") {
            const mint = i.parsed?.info?.mint;
            if (!mint) continue;
            if (!DISABLE_RAYDIUM_FILTER && raydiumLpSet.size && !raydiumLpSet.has(mint)) {
              continue;
            }
            hits.push({ type: "BURN", mint, amount: i.parsed?.info?.amount });
          }
        }

        for (const h of hits) {
          const key = `${sig}:${h.mint}:${h.type}`;
          if (seen.has(key)) continue;
          seen.add(key);
          processed += 1;
          await handleHit({ ...h, sig, tsSec });
        }

        if (seen.size > 50000) {
          const keep = Array.from(seen).slice(-20000);
          seen.clear();
          for (const k of keep) seen.add(k);
        }
      } catch (e) {
        if (DEBUG) console.log("WS message parse error:", e.message);
      }
    });

    const cleanup = () => {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    ws.on("close", () => {
      console.log("WS closed, reconnecting…");
      cleanup();
      setTimeout(openWs, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    });

    ws.on("error", (err) => {
      if (DEBUG) console.log("WS error:", err?.message || String(err));
      // close handler intézi a reconnectet
    });
  };

  openWs();
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
startWs();
```0
