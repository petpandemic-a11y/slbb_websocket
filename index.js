// debug-index.js
// Minimal Helius WS debug client – minden hiba/állapot logolva
// Node 18+, ESM (import). Futtatás: DEBUG=1 HELIUS_API_KEY=... node debug-index.js

import WebSocket from "ws";

const HELIUS_KEY = process.env.HELIUS_API_KEY;
const DEBUG = (process.env.DEBUG || "0") === "1";
const RAW_DUMP = (process.env.RAW_DUMP || "1") === "1";         // 1 = [RAW] logok is
const RAW_MAX = Number(process.env.RAW_MAX || 400);              // [RAW] truncation
const PING_MS = Number(process.env.PING_MS || 20000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 60000);
const WIDEN_AFTER_MS = Number(process.env.WIDEN_AFTER_MS || 15000);

if (!HELIUS_KEY) {
  console.error("Missing HELIUS_API_KEY env");
  process.exit(1);
}

const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

function ts() {
  return new Date().toISOString();
}

function safeJsonParse(s) {
  try { return JSON.parse(s); }
  catch (e) { return { __parse_error: e instanceof Error ? e.message : String(e) }; }
}

function openWs() {
  let ws;
  let pingTimer = null;
  let hbTimer = null;
  let lastMsgAt = Date.now();
  let backoff = 1000;
  const sentAt = new Map(); // id -> time
  let processed = 0;

  const connect = () => {
    console.log(`[${ts()}] Connecting → ${WS_URL}`);
    ws = new WebSocket(WS_URL);

    // Extra: handshake hibák (401/403/5xx) megfogása
    ws.on("unexpected-response", (req, res) => {
      console.error(
        `[${ts()}] unexpected-response: HTTP ${res.statusCode} ${res.statusMessage}`,
      );
    });

    ws.on("open", () => {
      console.log(`[${ts()}] ✅ WS connected`);

      // 1) logsSubscribe (Token program)
      const subLogs = {
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{ mentions: ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"], commitment: "confirmed" },
                 { encoding: "jsonParsed" }]
      };
      ws.send(JSON.stringify(subLogs)); sentAt.set(1, Date.now());
      console.log(`[${ts()}] [SUB] logsSubscribe(Token) sent`);

      // 2) transactionSubscribe (ALL)
      const subTx = {
        jsonrpc: "2.0",
        id: 2,
        method: "transactionSubscribe",
        params: [{ commitment: "confirmed" }, { encoding: "jsonParsed" }]
      };
      ws.send(JSON.stringify(subTx)); sentAt.set(2, Date.now());
      console.log(`[${ts()}] [SUB] transactionSubscribe(ALL) sent`);

      // 15s után – ha nincs üzenet – widen logs (mentions nélkül)
      setTimeout(() => {
        if (Date.now() - lastMsgAt >= WIDEN_AFTER_MS) {
          const subWide = {
            jsonrpc: "2.0",
            id: 3,
            method: "logsSubscribe",
            params: [{ commitment: "confirmed" }, { encoding: "jsonParsed" }]
          };
          ws.send(JSON.stringify(subWide)); sentAt.set(3, Date.now());
          console.log(`[${ts()}] [WIDEN] logsSubscribe(ALL) sent`);
        }
      }, WIDEN_AFTER_MS);

      // keepalive ping
      pingTimer = setInterval(() => { try { ws.ping(); } catch {} }, PING_MS);

      // heartbeat
      hbTimer = setInterval(() => {
        const idle = Math.floor((Date.now() - lastMsgAt) / 1000);
        console.log(
          `[${ts()}] [HB] alive | processed=${processed} | idle=${idle}s`,
        );
        if (idle > 300) { // 5 perc csend → újranyitás
          console.warn(`[${ts()}] [HB] idle too long, terminating socket`);
          try { ws.terminate(); } catch {}
        }
      }, HEARTBEAT_MS);
    });

    // Szerver ping → automatikus pong (ws lib intézi), de logoljuk
    ws.on("ping", () => { if (DEBUG) console.log(`[${ts()}] < ping`); });
    ws.on("pong", () => { if (DEBUG) console.log(`[${ts()}] > pong`); });

    ws.on("message", (buf) => {
      lastMsgAt = Date.now();
      const raw = buf.toString();
      if (RAW_DUMP) {
        const view = raw.length > RAW_MAX ? raw.slice(0, RAW_MAX) + "…(trunc)" : raw;
        console.log(`[${ts()}] [RAW] ${view}`);
      }

      const data = safeJsonParse(raw);
      if (data.__parse_error) {
        console.error(`[${ts()}] [PARSE ERR] ${data.__parse_error}`);
        return;
      }

      // ACK-ek mérésével
      if (typeof data.id === "number" && data.result) {
        const rtt = sentAt.has(data.id) ? (Date.now() - sentAt.get(data.id)) : null;
        console.log(`[${ts()}] [SUB OK] id=${data.result} (reqId=${data.id}${rtt !== null ? `, rtt=${rtt}ms` : ""})`);
        return;
      }

      // Rövid típus log
      if (data.method) {
        const sig =
          data.params?.result?.signature ||
          data.params?.result?.value?.signature || "";
        console.log(`[${ts()}] [RX] ${data.method}${sig ? ` sig=${sig}` : ""}`);
      }

      // Számoljuk a feldolgozott értesítéseket
      processed++;
    });

    const cleanup = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    };

    ws.on("error", (err) => {
      console.error(`[${ts()}] [WS ERROR] ${err?.message || String(err)}`);
    });

    ws.on("close", (code, reason) => {
      cleanup();
      const text = reason && reason.length ? Buffer.from(reason).toString() : "";
      console.warn(`[${ts()}] [WS CLOSED] code=${code}${text ? ` reason=${text}` : ""}`);
      // reconnect backoff (max 30s)
      const wait = backoff;
      backoff = Math.min(backoff * 2, 30000);
      console.log(`[${ts()}] Reconnecting in ${wait}ms…`);
      setTimeout(connect, wait);
    });
  };

  connect();
}

console.log(`[${ts()}] DEBUG=${DEBUG} RAW_DUMP=${RAW_DUMP} RAW_MAX=${RAW_MAX}`);
openWs();
