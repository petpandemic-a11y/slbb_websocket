// SLBB — Raydium LP Burn watcher (mintAuthority + fallback) — v2.1
import WebSocket from 'ws';
import fetch from 'node-fetch';
import http from 'http';

const {
  DEBUG = '1',
  RPC_HTTP,
  RPC_WSS,
  PORT = '8080',
  MIN_LP_BURN_PCT = '0.99',
  MIN_BURN_MINT_AGE_MIN = '0',
  MAX_TOKEN_AGE_MIN = '525600',
  RATE_MS = '8000',
  MAX_VAULT_OUTFLOW = '0.5',
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  LP_STRICT = '0'
} = process.env;

if (!RPC_HTTP || !RPC_WSS) { console.error('HIBA: RPC_HTTP és RPC_WSS kötelező!'); process.exit(1); }
const dlog = (...a) => (DEBUG === '1' ? console.log('[DBG]', ...a) : void 0);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RAYDIUM_PROGRAMS = new Set([
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE'
]);

async function rpc(method, params) {
  const res = await fetch(RPC_HTTP, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params }) });
  const j = await res.json(); if (j.error) throw new Error(`RPC ${method} error: ${JSON.stringify(j.error)}`);
  return j.result;
}
async function getTx(sig){ return rpc('getTransaction',[sig,{maxSupportedTransactionVersion:0,commitment:'confirmed'}]); }
async function getTokenSupply(mint){ const r=await rpc('getTokenSupply',[mint,{commitment:'confirmed'}]); return { uiAmount:r?.value?.uiAmount??null, decimals:r?.value?.decimals??null }; }
async function getMintInfo(mint){ const r=await rpc('getAccountInfo',[mint,{encoding:'jsonParsed',commitment:'confirmed'}]); return r?.value?.data?.parsed?.info||null; }
function hasBurnLog(parsed){ const logs=parsed?.meta?.logMessages||[]; return logs.some(l=>l.includes('Instruction: Burn')); }
function extractBurns(parsed){
  const pre=parsed?.meta?.preTokenBalances||[], post=parsed?.meta?.postTokenBalances||[];
  const preMap=new Map(); for(const b of pre) preMap.set(`${b.owner}:${b.mint}:${b.accountIndex}`,b);
  const out=[]; for(const b of post){ const pb=preMap.get(`${b.owner}:${b.mint}:${b.accountIndex}`); if(!pb) continue;
    const a=Number(pb.uiTokenAmount?.uiAmount||0)-Number(b.uiTokenAmount?.uiAmount||0); if(a>0) out.push({mint:b.mint,amountUi:a}); }
  return out;
}
function vaultOutflowLikely(parsed){
  const logs=parsed?.meta?.logMessages||[]; const pre=parsed?.meta?.preBalances||[], post=parsed?.meta?.postBalances||[];
  if(pre.length&&post.length&&pre.length===post.length){ let d=0; for(let i=0;i<pre.length;i++) d+=(pre[i]-post[i]); if(d/1e9>Number(MAX_VAULT_OUTFLOW)) return true; }
  if (logs.some(l=>/remove.*liquidity/i.test(l))) return true; return false;
}
async function estimateMintCreationTime(mint){
  const sigs=await rpc('getSignaturesForAddress',[mint,{limit:1000,commitment:'confirmed'}]);
  let oldest=null; for(const s of (sigs||[])) if(s.blockTime&&(!oldest||s.blockTime<oldest)) oldest=s.blockTime;
  return oldest?new Date(oldest*1000):null;
}

// 🔑 LP ellenőrzés mintAuthority + fallback
function isRaydiumMint(info, mint){
  if(!info) return false;
  const ma = info.mintAuthority || null;
  const fa = info.freezeAuthority || null;
  if ((ma && RAYDIUM_PROGRAMS.has(ma)) || (fa && RAYDIUM_PROGRAMS.has(fa))) return true;
  if (LP_STRICT !== '1' && !ma && !fa) { // fallback csak ha nem strict
    console.log(`[WARN] Mint ${mint} authority=null → fallback LP-nek tekintve`);
    return true;
  }
  return false;
}

function fmtPct(x){ return (x*100).toFixed(2)+'%'; }
function burnLine({sig,whenISO,mint,amountUi,pct,supplyUi}){
  return ['🔥 <b>LP BURN</b>',`🕒 <code>${whenISO}</code>`,`🧩 mint: <code>${mint}</code>`,`💧 amount: <b>${amountUi}</b>`,`📦 supply: ${supplyUi}`,`📉 share: <b>${fmtPct(pct)}</b>`,`🔗 sig: <code>${sig}</code>`].join('\n');
}
async function maybeSendTelegram(text){
  if(!TG_BOT_TOKEN||!TG_CHAT_ID) return;
  try{
    const url=`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TG_CHAT_ID,text,parse_mode:'HTML',disable_web_page_preview:true})});
    const j=await r.json(); if(!j.ok) dlog('TG send error:',j);
  }catch(e){ dlog('TG send exception:', e.message||e); }
}

function startWS(){
  let ws, subId=null, alive=false;
  const connect=()=>{
    ws=new WebSocket(RPC_WSS);
    ws.on('open',()=>{
      alive=true; console.log('[WS] connected');
      ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'logsSubscribe',params:[{mentions:[TOKEN_PROGRAM]},{commitment:'confirmed'}]}));
    });
    ws.on('message',async (buf)=>{
      let msg; try{ msg=JSON.parse(buf.toString()); }catch{ return; }
      if(msg.result && !subId){ subId=msg.result; console.log('[WS] subscribed, id =', subId); return; }
      if(msg.method!=='logsNotification') return;
      const { value } = msg.params; const { signature, logs } = value||{};
      if(!logs?.some(l=>l.includes('Instruction: Burn'))) return;

      try{
        await sleep(Number(RATE_MS));
        const parsed=await getTx(signature); if(!parsed||!hasBurnLog(parsed)) return;
        if (vaultOutflowLikely(parsed)) { dlog('Skip — remove-liq/vault outflow gyanú:', signature); return; }

        const burns=extractBurns(parsed); if(!burns.length) return;
        const whenISO=parsed?.blockTime?new Date(parsed.blockTime*1000).toISOString():'n/a';

        for(const b of burns){
          const mint=b.mint;
          const info=await getMintInfo(mint);
          if (!isRaydiumMint(info, mint)) { dlog('Skip — nem Raydium LP mint:', mint); continue; }

          const createdAt=await estimateMintCreationTime(mint);
          if(createdAt){
            const ageMin=(Date.now()-createdAt.getTime())/60000;
            if(ageMin<Number(MIN_BURN_MINT_AGE_MIN)){ dlog(`Skip — túl friss LP (${ageMin.toFixed(1)} min)`); continue; }
            if(ageMin>Number(MAX_TOKEN_AGE_MIN)){ dlog(`Skip — túl öreg LP (${ageMin.toFixed(1)} min)`); continue; }
          }

          const sup=await getTokenSupply(mint);
          if(sup.uiAmount==null||sup.uiAmount<=0){ dlog('Skip — ismeretlen/0 supply'); continue; }
          const pct=b.amountUi/sup.uiAmount;
          if(pct<Number(MIN_LP_BURN_PCT)){ dlog(`Skip — alacsony arány ${fmtPct(pct)}`); continue; }

          const line=burnLine({sig:signature,whenISO,mint,amountUi:b.amountUi,pct,supplyUi:sup.uiAmount});
          console.log(line);
          await maybeSendTelegram(line);
        }
      }catch(e){ console.error('Handle error:', e.message||e); }
    });
    ws.on('close',()=>{ console.warn('[WS] closed — reconnecting in 2s'); alive=false; setTimeout(connect,2000); });
    ws.on('error',(err)=>{ console.error('[WS] error:', err?.message||err); });
    setInterval(()=>{ if(alive) try{ ws.ping(); }catch{} },15000);
  };
  connect();
}

http.createServer((_req,res)=>{ res.writeHead(200,{'Content-Type':'text/plain'}); res.end('ok\n'); }).listen(Number(PORT),()=>{ console.log(`Healthcheck on :${PORT} — TG=${TG_BOT_TOKEN?'yes':'no'} strict=${LP_STRICT}`); });
console.log('SLBB WS watcher (mintAuthority+fallback) starting…');
startWS();
