// vaultrobbers.com brand hub — app artifact. Serves the ecosystem home page (game + NFT + token).
// One live stat only: RVLT total burned, read ON-CHAIN server-side (read-only eth_call, no keys, no writes),
// cached 30 min, and the page renders perfectly if it fails. NEVER serves its own source dir.
const express = require('express');
const path = require('path');
const { ethers } = require('ethers');

const app = express();
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const RVLT = '0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04';
const ORIGINAL_SUPPLY = 1000000000;
const ERC20 = ['function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)'];

let _cache = { v: null, at: 0 };
async function burnStat() {
  if (_cache.v && Date.now() - _cache.at < 1800000) return _cache.v; // 30 min cache
  const p = new ethers.JsonRpcProvider(RPC, 4663);
  const t = new ethers.Contract(RVLT, ERC20, p);
  const [supplyWei, deadWei, zeroWei] = await Promise.all([
    t.totalSupply().catch(() => 0n),
    t.balanceOf('0x000000000000000000000000000000000000dEaD').catch(() => 0n),
    t.balanceOf('0x0000000000000000000000000000000000000000').catch(() => 0n),
  ]);
  const f = v => Number(ethers.formatUnits(v, 18));
  const supply = f(supplyWei), dead = f(deadWei + zeroWei);
  const total = Math.max(0, ORIGINAL_SUPPLY - supply) + dead;
  const out = { total, totalPct: total / ORIGINAL_SUPPLY * 100, asOf: Date.now() };
  _cache = { v: out, at: Date.now() };
  return out;
}

app.get('/api/burn', async (req, res) => {
  try { res.json(await burnStat()); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT, () => console.log('[vaultrobbers] listening on', process.env.PORT));
