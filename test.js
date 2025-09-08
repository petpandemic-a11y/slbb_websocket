// test.js — signature ellenőrzés (mintAuthority + fallback)
// Futás: node test.js <SIG>
import { config } from 'dotenv'; import fetch from 'node-fetch'; config();
const { DEBUG='1', RPC_HTTP, RATE_MS='8000', MIN_LP_BURN_PCT='0.99', MIN_BURN_MINT_AGE_MIN='0', MAX_TOKEN_AGE_MIN='525600', MAX_VAULT_OUTFLOW='0.5', LP_STRICT='0' } = process.env;
if(!RPC_HTTP){ console.error('HIBA: RPC_HTTP nincs beállítva'); process.exit(1); }
const dlog=(...a)=>(DEBUG==='1'?console.log('[DBG]',...a):void 0); const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const RAYDIUM_PROGRAMS = new Set(['CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C','675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8','CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK','LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE']);

async function rpc(m,p){ const r=await fetch(RPC_HTTP,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})}); const j=await r.json(); if(j.error) throw new Error(JSON.stringify(j.error)); return j.result; }
async function getTx(sig){ return rpc('getTransaction',[sig,{maxSupportedTransactionVersion:0,commitment:'confirmed'}]); }
async function getMintInfo(mint){ const r=await rpc('getAccountInfo',[mint,{encoding:'jsonParsed',commitment:'confirmed'}]); return r?.value?.data?.parsed?.info||null; }
async function getTokenSupply(mint){ const r=await rpc('getTokenSupply',[mint,{commitment:'confirmed'}]); return { uiAmount:r?.value?.uiAmount??null, decimals:r?.value?.decimals??null }; }
function hasBurnLog(p){ const logs=p?.meta?.logMessages||[]; return logs.some(l=>l.includes('Instruction: Burn')); }
function extractBurns(p){ const pre=p?.meta?.preTokenBalances||[], post=p?.meta?.postTokenBalances||[]; const map=new Map(); for(const b of pre) map.set(`${b.owner}:${b.mint}:${b.accountIndex}`,b); const out=[]; for(const b of post){ const pb=map.get(`${b.owner}:${b.mint}:${b.accountIndex}`); if(!pb) continue; const a=Number(pb.uiTokenAmount?.uiAmount||0)-Number(b.uiTokenAmount?.uiAmount||0); if(a>0) out.push({mint:b.mint,amountUi:a}); } return out; }
function vaultOutflowLikely(p){ const logs=p?.meta?.logMessages||[]; const pre=p?.meta?.preBalances||[], post=p?.meta?.postBalances||[]; if(pre.length&&post.length&&pre.length===post.length){ let d=0; for(let i=0;i<pre.length;i++) d+=(pre[i]-post[i]); if(d/1e9>Number(MAX_VAULT_OUTFLOW)) return true; } if(logs.some(l=>/remove.*liquidity/i.test(l))) return true; return false; }
async function estimateMintCreationTime(m){ const sigs=await rpc('getSignaturesForAddress',[m,{limit:1000,commitment:'confirmed'}]); let o=null; for(const s of (sigs||[])) if(s.blockTime&&(!o||s.blockTime<o)) o=s.blockTime; return o?new Date(o*1000):null; }
function isRaydiumMint(info,mint){ if(!info) return false; const ma=info.mintAuthority||null, fa=info.freezeAuthority||null;
  if ((ma&&RAYDIUM_PROGRAMS.has(ma))||(fa&&RAYDIUM_PROGRAMS.has(fa))) return true;
  if (LP_STRICT!=='1' && !ma && !fa){ console.log(`[WARN] Mint ${mint} authority=null → fallback LP-nek tekintve`); return true; }
  return false; }
function fmtPct(x){ return (x*100).toFixed(2)+'%'; }
function burnLine({sig,whenISO,mint,amountUi,pct,supplyUi}){ return ['🔥 <b>LP BURN</b>',`🕒 <code>${whenISO}</code>`,`🧩 mint: <code>${mint}</code>`,`💧 amount: <b>${amountUi}</b>`,`📦 supply: ${supplyUi}`,`📉 share: <b>${fmtPct(pct)}</b>`,`🔗 sig: <code>${sig}</code>`].join('\n'); }

(async()=>{
  const sig=process.argv[2]; if(!sig){ console.error('Használat: node test.js <SIG>'); process.exit(1); }
  console.log('Lekérés:', sig); await sleep(Number(RATE_MS));
  const parsed=await getTx(sig); if(!parsed||!hasBurnLog(parsed)){ console.log('⚠️ Nincs SPL Burn a tranzakcióban.'); return; }
  if(vaultOutflowLikely(parsed)){ console.log('⚠️ Skip — remove-liq/vault outflow gyanú.'); return; }
  const burns=extractBurns(parsed); if(!burns.length){ console.log('⚠️ Nem találtam csökkenő token balance-t.'); return; }
  const whenISO=parsed?.blockTime?new Date(parsed.blockTime*1000).toISOString():'n/a';
  for(const b of burns){
    const info=await getMintInfo(b.mint);
    if(!isRaydiumMint(info,b.mint)){ dlog('Skip — nem Raydium LP mint:', b.mint); continue; }
    const createdAt=await estimateMintCreationTime(b.mint);
    if(createdAt){ const ageMin=(Date.now()-createdAt.getTime())/60000;
      if(ageMin<Number(MIN_BURN_MINT_AGE_MIN)){ console.log(`⚠️ Skip — túl friss LP (${ageMin.toFixed(1)} min).`); continue; }
      if(ageMin>Number(MAX_TOKEN_AGE_MIN)){ console.log(`⚠️ Skip — túl öreg LP (${ageMin.toFixed(1)} min).`); continue; } }
    const sup=await getTokenSupply(b.mint); if(sup.uiAmount==null||sup.uiAmount<=0){ console.log('⚠️ Skip — ismeretlen/0 supply.'); continue; }
    const pct=b.amountUi/sup.uiAmount; if(pct<Number(MIN_LP_BURN_PCT)){ console.log(`⚠️ Skip — alacsony arány (${fmtPct(pct)}).`); continue; }
    console.log(burnLine({sig,whenISO,mint:b.mint,amountUi:b.amountUi,pct,supplyUi:sup.uiAmount}));
  }
})();
