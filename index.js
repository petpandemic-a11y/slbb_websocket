// ================== index2_full_patched.js ==================
// Raydium LP Burn Detector - Remove Liquidity skip erősítve
// Minden remove-liquidity (CPMM, CLMM, withdraw, close position) tranzakciót kiszűr,
// csak a valódi, incinerator vagy végleges LP burn kerül jelzésre.

import { Connection, PublicKey } from "@solana/web3.js";

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const POLL_MS = Number(process.env.POLL_MS || 4000);
const DEBUG = process.env.DEBUG === "1";
const MIN_LP_BURN_PCT = Number(process.env.MIN_LP_BURN_PCT || 0.9);

const DEFAULT_PROGRAMS = [
  "CAMMCzo5YL8w4VFF8KVHRk22GGUsp5VTaW7girrKgIrw", // CPMM
  "RVKd61ztZW9GUwhQYvDTKHzYS4sV6sKRQ39SL7jdpT2", // CLMM
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"  // AMM v4
];

const WSOL_MINT = "So11111111111111111111111111111111111111112";
const INCINERATOR = "1nc1nerator11111111111111111111111111111111";

function log(...a){ console.log(...a); }
function dbg(...a){ if (DEBUG) console.log(...a); }

function getParsedInstructions(tx){
  const arr = tx?.transaction?.message?.instructions || [];
  return arr.map(i => i.parsed).filter(Boolean);
}
function joinLogsLower(tx){ return (tx?.meta?.logMessages || []).join(" ").toLowerCase(); }

function buildTokenDeltaMap(tx){
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  const map = new Map();
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
  const inflowsByOwner = new Map();
  for (const [, r] of map){
    const delta = r.post - r.pre;
    if (delta > 0){
      if (!inflowsByOwner.has(r.owner)) inflowsByOwner.set(r.owner, new Set());
      inflowsByOwner.get(r.owner).add(r.mint);
    }
  }
  return inflowsByOwner;
}

function extractLpMintFromBurn(tx){
  const ins = getParsedInstructions(tx);
  for (const p of ins){
    const t = String(p?.type||"").toLowerCase();
    if ((t === "burn" || t === "burnchecked") && p.info?.mint) return p.info.mint;
  }
  return null;
}

function lpSupplyDeltaPct(tx, lpMint){
  const pre = tx?.meta?.preTokenBalances || [];
  const post = tx?.meta?.postTokenBalances || [];
  let preTotal = 0, postTotal = 0;
  for (const b of pre) if (b.mint === lpMint) preTotal += Number(b.uiTokenAmount?.uiAmountString || b.uiTokenAmount?.uiAmount || 0);
  for (const b of post) if (b.mint === lpMint) postTotal += Number(b.uiTokenAmount?.uiAmountString || b.uiTokenAmount?.uiAmount || 0);
  if (preTotal <= 0) return 0;
  return Math.max(0, preTotal - postTotal) / preTotal;
}

// ================== REMOVE LIQUIDITY DETECTION ==================
function isRemoveLiquidityTx(tx){
  const logs = joinLogsLower(tx);
  const ins = getParsedInstructions(tx);

  const hasBurnIx = ins.some(p => {
    const t = String(p?.type||"").toLowerCase();
    return t === "burn" || t === "burnchecked";
  });
  if (!hasBurnIx) return false;

  const inflowsByOwner = extractInflowsByOwner(tx);
  let hasTwoMintsToSameOwner = false;
  for (const [, mints] of inflowsByOwner){
    if (mints.size >= 2){ hasTwoMintsToSameOwner = true; break; }
  }
  if (hasTwoMintsToSameOwner && hasBurnIx) return true; // dual inflow + burn → remove-liquidity

  const removeHints = [
    'remove liquidity','removeliquidity','withdraw liquidity',
    'decrease liquidity','close position','concentrated liquidity',
    'clmm','cpmm','raydium'
  ];
  const hasRemoveHint = removeHints.some(h => logs.includes(h));
  return hasRemoveHint;
}

// ================== PERMANENT LP BURN ==================
function isPermanentLpBurn(tx){
  const logs = joinLogsLower(tx);
  if (logs.includes("incinerator")) return true;

  const lpMint = extractLpMintFromBurn(tx);
  if (!lpMint) return false;

  const pct = lpSupplyDeltaPct(tx, lpMint);
  if (pct < MIN_LP_BURN_PCT) return false;

  // Ensure not remove-liquidity
  if (isRemoveLiquidityTx(tx)) return false;
  return true;
}

// ================== MAIN LOOP (váz) ==================
const connection = new Connection(RPC_URL, { commitment: "confirmed" });
const PROGRAM_KEYS = DEFAULT_PROGRAMS.map(s => new PublicKey(s));

async function processSignature(sig){
  const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx || !tx.meta) return;

  if (isRemoveLiquidityTx(tx)){
    dbg(`[SKIP] Remove-liquidity detected: ${sig}`);
    return;
  }
  if (isPermanentLpBurn(tx)){
    log(`[ALERT] Permanent LP burn: ${sig}`);
    // ide jön a Telegram/üzenetküldés
  }
}

async function main(){
  log("[LPBurnDetector] starting. RPC:", RPC_URL);
  while (true){
    try{
      for (const pk of PROGRAM_KEYS){
        const sigs = await connection.getSignaturesForAddress(pk, { limit: 5 });
        for (const s of sigs.reverse()){
          await processSignature(s.signature);
        }
      }
    }catch(e){ log("poll error", e); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`){
  main();
}
