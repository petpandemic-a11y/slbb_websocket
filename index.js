// debug-index.js
// Minimal WS client Helius-hoz – csak debug
// futtasd: DEBUG=1 HELIUS_API_KEY=... node debug-index.js

import WebSocket from "ws";

const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY) {
  console.error("Missing HELIUS_API_KEY env");
  process.exit(1);
}

const url = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
console.log("Connecting to", url);

const ws = new WebSocket(url);

ws.on("open", () => {
  console.log("✅ WS connected");
  // Feliratkozás minden logra (program filter nélkül)
  const sub = {
    jsonrpc: "2.0",
    id: 1,
    method: "logsSubscribe",
    params: [{ commitment: "confirmed" }, { encoding: "jsonParsed" }],
  };
  ws.send(JSON.stringify(sub));
  console.log("[SUB] logsSubscribe ALL sent");
});

ws.on("message", (raw) => {
  console.log("[RAW]", raw.toString().slice(0, 300));
});

ws.on("error", (err) => {
  console.error("WS error:", err.message);
});

ws.on("close", () => {
  console.log("WS closed");
});
