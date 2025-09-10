// index.js - Raydium LP Burn Detector (CPMM + CLMM) with Remove-Liquidity Exclusion
// Self-contained polling-based example using Solana JSON-RPC getSignaturesForAddress/getTransaction.
// Requires Node 18+ (global fetch).
// Environment variables:
//   RPC_URL                -> Solana RPC endpoint (e.g., Helius/QuickNode/free RPC)
//   PROGRAM_ADDRESSES     -> comma-separated list of Raydium program IDs to follow (optional; defaults below)
//   POLL_MS               -> polling interval in ms (default 5000)
//   TELEGRAM_BOT_TOKEN    -> optional; if set, messages are sent to Telegram
//   TELEGRAM_CHAT_ID      -> chat/channel ID
//   MIN_LP_BURN_PCT       -> e.g., 0.9 (90%)
//   DEBUG                 -> "1" to enable verbose logs
//
// Notes:
//  - Detects *permanent* LP burns; excludes Remove Liquidity for both CPMM and CLMM.
//  - Formats pair label and pool type; avoids showing WSOL mint as the token.
//  - You can adapt this to a webhook or websocket feed easily; core detection is below.

import { Connection, PublicKey } from "@solana/web3.js";

// ---------- Config ----------
const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const POLL_MS = Number(process.env.POLL_MS || 5000);
const DEBUG = process.env.DEBUG === "1";
const MIN_LP_BURN_PCT = Number(process.env.MIN_LP_BURN_PCT || 0.9);

// Raydium programs (not exhaustive, but good start)
const DEFAULT_PROGRAMS = [
  // Raydium AMM/CPMM/CLMM program ids (historical + current common ones)
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // AMM v4
  "CAMMCzo5YL8w4VFF8KVHRk22GGUsp5VTaW7girrKgIrw", // CPMM
  "RVKd61ztZW9GUwhQYvDTKHzYS4sV6sKRQ39SL7jdpT2", // CLMM (common)
  "AMM55ShX9BWeJHzSXDDJr2T1gmTyXQJYcwQ6pCkX6FfS", // alt (placeholder; keep list editable)
].concat(
  (process.env.PROGRAM_ADDRESSES || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
);
const PROGRAM_KEYS = buildProgramKeys([...new Set(DEFAULT_PROGRAMS)]);
// --- Robust base58 validation for program addresses ---
function isValidBase58PublicKey(str){
  try{
    const pk = new PublicKey(str);
    // If it constructed, it's valid 32-byte key.
    return !!pk;
  }catch(e){
    return false;
  }
}
function buildProgramKeys(list){
  const keys = [];
  for (const s of list){
    const trimmed = (s || "").trim();
    if (!trimmed) continue;
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)){
      log(`[CONFIG] Skipping invalid (non-base58 chars): ${JSON.stringify(trimmed)}`);
      continue;
    }
    if (!isValidBase58PublicKey(trimmed)){
      log(`[CONFIG] Skipping invalid public key length: ${JSON.stringify(trimmed)}`);
      continue;
    }
    try{
      keys.push(new PublicKey(trimmed));
    }catch(e){
      log(`[CONFIG] Skipping invalid key (${trimmed}):`, e.message);
    }
  }
  // dedupe by base58
  const uniq = [];
  const seen = new Set();
  for (const k of keys){
    const b58 = k.toBase58();
    if (!seen.has(b58)){ uniq.push(k); seen.add(b58); }
  }
  if (uniq.length === 0){
    log("[CONFIG] WARNING: No valid program addresses left. Using minimal Raydium set.");
    const fallback = ["CAMMCzo5YL8w4VFF8KVHRk22GGUsp5VTaW7girrKgIrw","RVKd61ztZW9GUwhQYvDTKHzYS4sV6sKRQ39SL7jdpT2","675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"];
    for (const s of fallback){
      uniq.push(new PublicKey(s));
    }
  }
  return uniq;
}


// Known constants
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const INCINERATOR = "1nc1nerator11111111111111111111111111111111"; // owner for incinerations (account owner), not SPL mint
const ZERO_ADDRESS = "11111111111111111111111111111111";

// ---------- Utilities ----------
function log(...a){ console.log(...a); }
function dbg(...a){ if (DEBUG) console.log(...a); }

function short(k){ return typeof k === "string" ? `${k.slice(0,4)}…${k.slice(-4)}` : String(k); }
function prettyMint(m){
  if (!m) return "Unknown";
  if (m === WSOL_MINT) return "SOL";
  return `${m.slice(0,4)}…${m.slice(-4)}`;
}
function prettyPairLabel(a,b){
  if (!a || !b) return "Unknown Pair";
  return `${prettyMint(a)}-${prettyMint(b)}`;
}

function arrayEqual(a,b){ if (a.length !== b.length) return false; for (let i=0;i<a.length;i++){ if (a[i]!==b[i]) return false; } return true; }

// Extract parsed inner instructions safely
function getParsedInstructions(tx){
  const arr = tx?.transaction?.message?.instructions || [];
  return arr.map(i => i.parsed).filter(Boolean);
}

function joinLogsLower(tx){
  return (tx?.meta?.logMessages || []).join(" ").toLowerCase();
}

// Build token balance map (pre/post)
function buildTokenDeltaMap(tx){
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const map = new Map(); // accountIndex -> {owner, mint, pre, post}
  for (const b of pre){
    map.set(b.accountIndex, {
      owner: b.owner, mint: b.mint,
      pre: Number(b.uiTokenAmount?.uiAmountString || b.uiTokenAmount?.uiAmount || 0),
      post: 0
    });
  }
  for (const b of post){
    const row = map.get(b.accountIndex) || { owner: b.owner, mint: b.mint, pre: 0, post: 0 };
    row.owner = b.owner; row.mint = b.mint;
    row.post = Number(b.uiTokenAmount?.uiAmountString || b.uiTokenAmount?.uiAmount || 0);
    map.set(b.accountIndex, row);
  }
  return map;
}

function extractInflowsByOwner(tx){
  const map = buildTokenDeltaMap(tx);
  const inflowsByOwner = new Map(); // owner -> Set<mint>
  for (const [, r] of map){
    const delta = r.post - r.pre;
    if (delta > 0){
      if (!inflowsByOwner.has(r.owner)) inflowsByOwner.set(r.owner, new Set());
      inflowsByOwner.get(r.owner).add(r.mint);
    }
  }
  return inflowsByOwner;
}

function extractBaseQuoteMints(tx){
  // From total positive delta by mint
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const totals = new Map(); // mint -> delta
  for (const b of pre){
    totals.set(b.mint, (totals.get(b.mint) || 0) - Number(b.uiTokenAmount?.uiAmountString || b.uiTokenAmount?.uiAmount || 0));
  }
  for (const b of post){
    totals.set(b.mint, (totals.get(b.mint) || 0) + Number(b.uiTokenAmount?.uiAmountString || b.uiTokenAmount?.uiAmount || 0));
  }
  const inflows = [...totals.entries()].filter(([mint, d]) => d > 0);
  inflows.sort((a,b) => b[1]-a[1]);
  const baseMint = inflows[0]?.[0];
  const quoteMint = inflows[1]?.[0];
  return { baseMint, quoteMint };
}

function extractLpMintFromBurn(tx){
  const ins = getParsedInstructions(tx);
  for (const p of ins){
    if (!p?.type) continue;
    const t = String(p.type).toLowerCase();
    if ((t === "burn" || t === "burnchecked") && p.info?.mint){
      return p.info.mint;
    }
  }
  return null;
}

function lpSupplyDeltaPct(tx, lpMint){
  // Approximate: find total LP token delta across accounts for given mint
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  let preTotal = 0, postTotal = 0;
  for (const b of pre){
    if (b.mint === lpMint) preTotal += Number(b.uiTokenAmount?.uiAmountString || b.uiTokenAmount?.uiAmount || 0);
  }
  for (const b of post){
    if (b.mint === lpMint) postTotal += Number(b.uiTokenAmount?.uiAmountString || b.uiTokenAmount?.uiAmount || 0);
  }
  if (preTotal <= 0) return 0;
  const drop = Math.max(0, preTotal - postTotal);
  return drop / preTotal; // 0..1
}

// ---------- Core classification ----------

// Heuristic: is Remove Liquidity (CPMM or CLMM)
function isRemoveLiquidityTx(tx){
  const logs = joinLogsLower(tx);

  // Hints for CPMM + CLMM
  const removeHints = [
    "remove liquidity","removeliquidity",
    "decrease liquidity","decrease position","close position",
    "concentrated liquidity","clmm","cpmm","raydium",
  ];
  const hasRemoveHint = removeHints.some(h => logs.includes(h));

  // Burn present?
  const ins = getParsedInstructions(tx);
  const hasBurn = ins.some(p => {
    const t = String(p?.type || "").toLowerCase();
    return t === "burn" || t === "burnchecked";
  });
  if (!hasBurn) return false;

  // Two different mints flowing to same owner
  const inflowsByOwner = extractInflowsByOwner(tx);
  let twoMintsToSameOwner = false;
  for (const [, set] of inflowsByOwner){
    if (set.size >= 2){ twoMintsToSameOwner = true; break; }
  }

  // If we saw a burn + dual inflow + AMM/CLMM hints -> remove liquidity
  return twoMintsToSameOwner && hasRemoveHint;
}

// Heuristic: is Permanent LP Burn (do not confuse with remove-liquidity)
function isPermanentLpBurn(tx){
  // 1) Direct transfer of LP tokens to incinerator? (common pattern)
  // Check token balance: any LP mint with delta < 0 for user and owner == INCINERATOR as receiver ATA? Tough with parsed balances only.
  // We'll rely on parsed instructions for SPL Token 'transfer' with destination owner = incinerator OR log mentions incinerator.
  const logs = joinLogsLower(tx);
  if (logs.includes("incinerator")) return true;

  const ins = getParsedInstructions(tx);
  let sawBurn = false;
  let lpMint = null;
  for (const p of ins){
    const t = String(p?.type || "").toLowerCase();
    if (t === "burn" || t === "burnchecked"){
      sawBurn = true;
      if (p.info?.mint) lpMint = p.info.mint;
    }
    // SPL Token Transfer to incinerator ATA (parsed sometimes as 'transfer')
    if (t === "transfer" && p.info?.destinationOwner){
      const dest = String(p.info.destinationOwner);
      if (dest === INCINERATOR) return true;
    }
  }

  // 2) If there is a Burn but NOT remove-liquidity pattern (checked by caller), accept if supply drop >= threshold.
  if (sawBurn && lpMint){
    const pct = lpSupplyDeltaPct(tx, lpMint);
    if (pct >= MIN_LP_BURN_PCT){
      // Extra guard: ensure we did not see dual inflow to same owner
      const inflowsByOwner = extractInflowsByOwner(tx);
      let twoMintsToSameOwner = false;
      for (const [, set] of inflowsByOwner){
        if (set.size >= 2){ twoMintsToSameOwner = true; break; }
      }
      if (!twoMintsToSameOwner){
        return true;
      }
    }
  }

  return false;
}

// Pool type label
function detectPoolType(tx){
  const logs = joinLogsLower(tx);
  if (logs.includes("concentrated liquidity") || logs.includes("clmm")) return "Raydium CLMM";
  if (logs.includes("cpmm")) return "Raydium CPMM";
  if (logs.includes("raydium")) return "Raydium";
  return "Unknown";
}

// ---------- Messaging ----------
async function sendTelegram(text){
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId){
    log("[TELEGRAM] skipping (no token/chat id). Message:\n", text);
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false
    })
  });
  if (!res.ok){
    const body = await res.text();
    log("[TELEGRAM] error:", res.status, body);
  }
}

// Format burn alert
function formatBurnMessage(tx, signature){
  const lpMint = extractLpMintFromBurn(tx) || "Unknown LP";
  const { baseMint, quoteMint } = extractBaseQuoteMints(tx);
  const pairLabel = prettyPairLabel(baseMint, quoteMint);
  const poolType = detectPoolType(tx);
  const pct = lpSupplyDeltaPct(tx, lpMint);
  const pctStr = (pct*100).toFixed(2);

  // Estimate SOL inflow (if any)
  const map = buildTokenDeltaMap(tx);
  let solInflow = 0;
  for (const [, r] of map){
    if (r.mint === WSOL_MINT){
      const d = r.post - r.pre;
      if (d > 0) solInflow += d;
    }
  }

  // Burner address heuristic: first signer
  const burner = tx?.transaction?.message?.accountKeys?.[0]?.toBase58?.() || "Unknown";

  const solscan = `https://solscan.io/tx/${signature}`;
  const dexscreener = `https://dexscreener.com/solana/${signature}`; // tx page (fallback)
  const birdeye = `https://birdeye.so/tx/${signature}?chain=solana`;

  const lines = [];
  lines.push("🔥🔥 <b>LP BURN DETECTED</b> 🔥🔥");
  lines.push(`💎 <b>Pair</b>: ${pairLabel}`);
  lines.push(`🪙 <b>LP Mint</b>: ${prettyMint(lpMint)}`);
  lines.push(`📊 <b>Percentage</b>: ${pctStr}%`);
  if (solInflow > 0) lines.push(`💰 <b>Est. SOL Inflow</b>: ${solInflow.toFixed(4)} SOL`);
  lines.push(`👤 <b>Burner</b>: ${short(burner)}`);
  lines.push(`🛟 <b>Pool</b>: ${poolType}`);
  lines.push("");
  lines.push(`🔗 <a href="${solscan}">View on Solscan</a>`);
  lines.push(`📈 <a href="${dexscreener}">View on DexScreener</a>`);
  lines.push(`🕊️ <a href="${birdeye}">View on Birdeye</a>`);
  return lines.join("\n");
}

// ---------- Polling Loop ----------
const connection = new Connection(RPC_URL, { commitment: "confirmed" });

let lastFetched = new Map(); // programId -> last signature fetched
let seen = new Set();

async function fetchRecentSigsForProgram(programPk, before){
  try{
    return await connection.getSignaturesForAddress(programPk, { limit: 25, before });
  }catch(e){
    dbg("getSignaturesForAddress error", e.message);
    return [];
  }
}

async function getParsedTx(signature){
  try{
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed"
    });
    return tx;
  }catch(e){
    dbg("getTransaction error", signature, e.message);
    return null;
  }
}

async function processSignature(sig){
  if (seen.has(sig)) return;
  seen.add(sig);

  const tx = await getParsedTx(sig);
  if (!tx || !tx.meta) return;

  // Quick filter: only consider if any account key matches our Raydium programs
  const keys = tx?.transaction?.message?.accountKeys?.map(k => k.toBase58?.()) || [];
  const matchesRaydium = PROGRAM_KEYS.some(pk => keys.includes(pk.toBase58()));
  if (!matchesRaydium){
    // Still allow incinerator-based burns even if program not present (rare)
    const logs = joinLogsLower(tx);
    if (!logs.includes("incinerator")) return;
  }

  // Exclude remove-liquidity (CPMM + CLMM)
  if (isRemoveLiquidityTx(tx)){
    dbg(`[SKIP] Remove-liquidity detected: ${sig}`);
    return;
  }

  // Permanent LP burn?
  if (isPermanentLpBurn(tx)){
    const msg = formatBurnMessage(tx, sig);
    await sendTelegram(msg);
    log(`[ALERT] Permanent LP burn: ${sig}`);
  }else{
    dbg(`[NO BURN] ${sig}`);
  }
}

async function pollOnce(){
  for (const pk of PROGRAM_KEYS){
    const last = lastFetched.get(pk.toBase58()) || undefined;
    const sigs = await fetchRecentSigsForProgram(pk, last);
    if (sigs.length === 0) continue;

    // Process newest -> oldest, then remember the oldest to paginate next time
    for (const s of sigs){
      await processSignature(s.signature);
    }
    lastFetched.set(pk.toBase58(), sigs[sigs.length-1].signature);
  }
}

async function main(){
  log("[LPBurnDetector] starting. RPC:", RPC_URL);
  log("[LPBurnDetector] Programs:", PROGRAM_KEYS.map(k=>k.toBase58()).join(", "));
  while (true){
    try{
      await pollOnce();
    }catch(e){
      log("poll error", e);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`){
  main().catch(e => {
    log("fatal", e);
    process.exit(1);
  });
}
