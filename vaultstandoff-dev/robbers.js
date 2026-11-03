// robbers.js — Vault Robbers NFT utility (per-heist airdrop) read/claim layer for Vault Standoff.
//
// MECHANIC (StandoffEscrow V9): each settled heist routes the FULL 6% rake (robberShareBps=10000, Jake 2026-10-22)
// to ONE seed-drawn Vault Robber's ERC-6551 token-bound account (TBA). The loot lives in the TBA, which the NFT
// owner controls — so a loaded robber is a tradeable piggy-bank. This module is READ-ONLY on-chain plus it builds
// (never signs) the claim calldata; the NFT owner signs the claim with their own wallet. NO keys here.
//
// All robber/RVLT/TBA reads target Robinhood MAINNET (4663) where the NFT + RVLT + 6551 registry live, regardless
// of which chain the escrow itself runs on. Bulk reads (ownerOf / account / balanceOf over the whole supply) go
// through Multicall3 (one eth_call each) — the public RPC chokes on ethers' default array-batching, so providers
// are created with batchMaxCount:1 and bulk fan-out is done via MC3 instead.
'use strict';
const { ethers } = require('ethers');

// ── canonical on-chain config (Robinhood mainnet 4663) ──────────────────────
const NFT          = (process.env.VS_NFT_ADDR    || '0xABC6c4F5d1F31326b419c2645C981743a845313a');
const REGISTRY     = (process.env.VS_6551_REGISTRY|| '0x000000006551c19487814612e58FE06813775758');
const ACCOUNT_IMPL = (process.env.VS_6551_IMPL   || '0x41C8f39463A868d3A88af00cd0fe7102F30E44eC'); // AccountV3 v0.3.1, live on 4663
const RVLT         = (process.env.VS_RVLT        || '0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04');
const MC3          = '0xcA11bde05977b3631167028862bE2a173976CA11';                                   // canonical Multicall3, live on 4663
const SALT         = '0x0000000000000000000000000000000000000000000000000000000000000000';
const HOLDER_RPC   = process.env.VS_HOLDER_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const HOLDER_CHAIN = parseInt(process.env.VS_HOLDER_CHAINID || '4663', 10);
const ESCROW_ADDR  = process.env.VS_ESCROW_ADDR || '0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5';
const ESCROW_RPC   = process.env.VS_RPC || HOLDER_RPC;
const ESCROW_CHAIN = parseInt(process.env.VS_CHAINID || String(HOLDER_CHAIN), 10);

const REGISTRY_ABI = [
  'function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) view returns (address)',
  'function createAccount(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) returns (address)',
];
const NFT_ABI  = ['function ownerOf(uint256) view returns (address)', 'function totalMinted() view returns (uint256)', 'function balanceOf(address) view returns (uint256)'];
const RVLT_ABI = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
const ACCT_ABI = ['function owner() view returns (address)', 'function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)'];
const ESCROW_ABI = ['function robberNft() view returns (address)', 'function robberSupply() view returns (uint32)', 'function robberShareBps() view returns (uint16)'];
const MC3_ABI  = ['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)'];
const ROBBERPAID_TOPIC = ethers.id('RobberPaid(uint256,uint256,address,uint256)');

const nftIface = new ethers.Interface(NFT_ABI);
const rvltIface = new ethers.Interface(RVLT_ABI);
const regIface = new ethers.Interface(REGISTRY_ABI);
const acctIface = new ethers.Interface(ACCT_ABI);

let _mp = null, _ep = null;
function mp(){ if(!_mp) _mp = new ethers.JsonRpcProvider(HOLDER_RPC, HOLDER_CHAIN, { staticNetwork:true, batchMaxCount:1 }); return _mp; }
function ep(){ if(!_ep) _ep = new ethers.JsonRpcProvider(ESCROW_RPC, ESCROW_CHAIN, { staticNetwork:true, batchMaxCount:1 }); return _ep; }
function mc3(){ return new ethers.Contract(MC3, MC3_ABI, mp()); }
function nft(){ return new ethers.Contract(NFT, NFT_ABI, mp()); }
function rvlt(){ return new ethers.Contract(RVLT, RVLT_ABI, mp()); }

const lc = (a)=> String(a||'').toLowerCase();
const ZERO = lc(ethers.ZeroAddress);
function human(wei){ try{ return Number(ethers.formatUnits(wei, 18)); }catch(_){ return 0; } }

// ── Multicall3 fan-out: run `calls` ([{target,allowFailure,callData}]) in <=500-sized MC3 batches ──
async function mcAll(calls){
  const out = [];
  for (let i=0; i<calls.length; i+=500){
    const res = await mc3().aggregate3(calls.slice(i, i+500));
    for (const r of res) out.push(r);
  }
  return out;
}

const _cache = {};
async function cached(key, ttlMs, fn){ const now=Date.now(); const c=_cache[key]; if(c && (now-c.ts)<ttlMs) return c.v; const v=await fn(); _cache[key]={ts:now,v}; return v; }

// ── armed state: is the robber leg configured on-chain? (shareBps != 0) ─────
async function armedState(){
  return cached('armed', 60000, async () => {
    try {
      const c = new ethers.Contract(ESCROW_ADDR, ESCROW_ABI, ep());
      const [rn, rs, bps] = await Promise.all([c.robberNft(), c.robberSupply(), c.robberShareBps()]);
      const armed = rn && lc(rn) !== ZERO && Number(rs) > 0 && Number(bps) > 0;
      return { armed, robberNft: rn, robberSupply: Number(rs), shareBps: Number(bps) };
    } catch (_) { return { armed:false, robberNft:ethers.ZeroAddress, robberSupply:0, shareBps:0 }; }
  });
}

async function mintedCount(){ return cached('minted', 60000, async () => { try { return Number(await nft().totalMinted()); } catch(_) { return 0; } }); }

// ── TBA addresses (deterministic; cached forever) via MC3 registry.account ──
const _tba = {};
async function tbaMany(ids){
  const need = ids.filter(id => !_tba[String(id)]);
  if (need.length){
    const calls = need.map(id => ({ target: REGISTRY, allowFailure: true, callData: regIface.encodeFunctionData('account', [ACCOUNT_IMPL, SALT, HOLDER_CHAIN, NFT, id]) }));
    const res = await mcAll(calls);
    res.forEach((r, j) => { if (r.success){ try { const [a] = regIface.decodeFunctionResult('account', r.returnData); _tba[String(need[j])] = a; } catch(_){} } });
  }
  return ids.map(id => _tba[String(id)]);
}
async function tbaOf(tokenId){ const [a] = await tbaMany([Number(tokenId)]); return a; }

// ── balances for a list of TBAs via MC3 RVLT.balanceOf ──────────────────────
async function stashMany(tbas){
  const calls = tbas.map(t => ({ target: RVLT, allowFailure: true, callData: rvltIface.encodeFunctionData('balanceOf', [t]) }));
  const res = await mcAll(calls);
  return res.map(r => { if (r.success){ try { const [w] = rvltIface.decodeFunctionResult('balanceOf', r.returnData); return BigInt(w); } catch(_){} } return 0n; });
}

// ── ownership map via MC3 ownerOf(1..totalMinted), cached 60s ───────────────
async function ownerMap(){
  return cached('owners', 60000, async () => {
    let N = await mintedCount(); if (!N) N = 1000; N = Math.min(N, 2000);
    const ids = Array.from({ length: N }, (_, i) => i + 1);
    const calls = ids.map(id => ({ target: NFT, allowFailure: true, callData: nftIface.encodeFunctionData('ownerOf', [id]) }));
    const res = await mcAll(calls);
    const map = {};
    res.forEach((r, j) => { if (r.success){ try { const [a] = nftIface.decodeFunctionResult('ownerOf', r.returnData); const o = lc(a); if (o && o !== ZERO) map[String(ids[j])] = o; } catch(_){} } });
    return map;
  });
}

// ── public: robbers owned by an address ─────────────────────────────────────
async function owned(address){
  const a = lc(address);
  if (!/^0x[0-9a-f]{40}$/.test(a)) return { address, armed:false, robbers:[] };
  const [st, map] = await Promise.all([armedState(), ownerMap()]);
  const ids = Object.keys(map).filter(id => map[id] === a).map(Number).sort((x,y)=>x-y);
  const tbas = await tbaMany(ids);
  const stashes = st.armed ? await stashMany(tbas) : ids.map(()=>0n);   // pre-arming every TBA is 0 — skip the reads
  const robbers = ids.map((tokenId, i) => ({ tokenId, tba: tbas[i], stashWei: stashes[i].toString(), stash: human(stashes[i]) }));
  return { address: a, armed: st.armed, robbers };
}

// ── public: most-loaded robbers leaderboard ─────────────────────────────────
async function leaderboard(limit){
  limit = Math.min(Math.max(parseInt(limit||25,10),1), 100);
  const st = await armedState();
  if (!st.armed) return { armed:false, updated:null, rows:[] };          // nothing loaded until armed
  return cached('leaderboard', 120000, async () => {
    let N = st.robberSupply || await mintedCount() || 0;
    const ids = Array.from({ length: N }, (_, i) => i + 1);
    const tbas = await tbaMany(ids);
    const stashes = await stashMany(tbas);
    const rows = [];
    ids.forEach((tokenId, i) => { if (stashes[i] > 0n) rows.push({ tokenId, tba: tbas[i], stashWei: stashes[i].toString(), stash: human(stashes[i]) }); });
    rows.sort((a,b)=> (BigInt(b.stashWei) > BigInt(a.stashWei) ? 1 : -1));
    return { armed:true, updated: Date.now(), rows: rows.slice(0, limit) };
  });
}

// ── public: RobberPaid feed (who slipped out with a cut) ────────────────────
async function feed(limit){
  limit = Math.min(Math.max(parseInt(limit||25,10),1), 100);
  return cached('feed:'+limit, 30000, async () => {
    try {
      const provider = ep();
      const latest = await provider.getBlockNumber();
      const from = Math.max(0, latest - 500000);
      const logs = await provider.getLogs({ address: ESCROW_ADDR, topics: [ROBBERPAID_TOPIC], fromBlock: from, toBlock: latest });
      const iface = new ethers.Interface(['event RobberPaid(uint256 indexed roundId, uint256 indexed tokenId, address tba, uint256 amount)']);
      const rows = logs.slice(-limit).reverse().map(l => { try { const d = iface.parseLog(l); return { roundId: Number(d.args.roundId), tokenId: Number(d.args.tokenId), tba: d.args.tba, amountWei: d.args.amount.toString(), amount: human(d.args.amount), block: l.blockNumber, tx: l.transactionHash }; } catch(_){ return null; } }).filter(Boolean);
      return { rows };
    } catch (_) { return { rows:[] }; }
  });
}

// ── public: build (never sign) the claim plan for a tokenId ─────────────────
async function claimPlan(tokenId, owner){
  const o = lc(owner);
  if (!/^0x[0-9a-f]{40}$/.test(o)) throw new Error('bad owner address');
  const tba = await tbaOf(tokenId);
  const r = rvlt();
  const [balRaw, deployedCode, chainOwner] = await Promise.all([
    r.balanceOf(tba).catch(()=>0n),
    mp().getCode(tba).catch(()=>'0x'),
    nft().ownerOf(tokenId).catch(()=>ethers.ZeroAddress),
  ]);
  const bal = BigInt(balRaw);
  if (lc(chainOwner) !== o) throw new Error('connected wallet does not own robber #'+tokenId);
  const transferData = rvltIface.encodeFunctionData('transfer', [owner, bal]);
  const executeData  = acctIface.encodeFunctionData('execute', [RVLT, 0, transferData, 0]);
  const createData   = regIface.encodeFunctionData('createAccount', [ACCOUNT_IMPL, SALT, HOLDER_CHAIN, NFT, tokenId]);
  const deployed = deployedCode && deployedCode !== '0x';
  return {
    tokenId: Number(tokenId), tba, deployed, stashWei: bal.toString(), stash: human(bal), chainId: HOLDER_CHAIN,
    steps: [
      ...(deployed ? [] : [{ label:'Activate robber account', to: REGISTRY, data: createData, value:'0x0' }]),
      ...(bal > 0n ? [{ label:'Claim '+human(bal)+' RVLT', to: tba, data: executeData, value:'0x0' }] : []),
    ],
  };
}

function config(){ return { nft: NFT, registry: REGISTRY, accountImpl: ACCOUNT_IMPL, rvlt: RVLT, salt: SALT, chainId: HOLDER_CHAIN, escrow: ESCROW_ADDR }; }

module.exports = { config, armedState, owned, leaderboard, feed, claimPlan, tbaOf };
