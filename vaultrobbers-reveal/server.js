/* Vault Robbers — progressive gated reveal server.
 * Set as the contract baseURI at reveal(). Serves a token's metadata+image ONLY after its tokenId is minted;
 * every not-yet-minted art index returns a Sealed placeholder, so future mints cannot be previewed/sniped.
 * Reads revealed()/startingIndex()/totalMinted() live from the contract (cached). At sellout -> migrate to IPFS + freeze. */
const express = require('express');
const { ethers } = require('ethers');
const fs = require('fs'); const path = require('path');
const { MAX, isLive, artToToken } = require('./gate');

const app = express();
const PORT = process.env.PORT;
const PUB = 'https://build-fdb6259277d28616cd0aa5a0.emblem.build/pub/main/vaultrobbers-reveal';
const IMAGES = '/data/app-groups/main/_vr-art/reveal/images';
const ATTRS = JSON.parse(fs.readFileSync('/data/app-groups/main/_vr-art/collection/metadata.json', 'utf8'));
const byArt = {}; for (const r of ATTRS) byArt[r.tokenId] = r;

const RPC = 'https://rpc.mainnet.chain.robinhood.com', CHAIN = 4663, ADDR = '0xABC6c4F5d1F31326b419c2645C981743a845313a';
const abi = ['function revealed() view returns (bool)', 'function startingIndex() view returns (uint256)', 'function totalMinted() view returns (uint256)'];
const provider = new ethers.JsonRpcProvider(RPC, CHAIN);
const ct = new ethers.Contract(ADDR, abi, provider);

// local gating test override (never set in prod): REVEAL_TEST=1 TEST_SI=.. TEST_MINTED=..
const TEST = process.env.REVEAL_TEST === '1';
let STATE = TEST
  ? { revealed: true, si: Number(process.env.TEST_SI||123), minted: Number(process.env.TEST_MINTED||140), ts: Date.now(), err: null }
  : { revealed: false, si: 0, minted: 0, ts: 0, err: null };
async function refresh(){ if (TEST) return; try { const [r, si, t] = await Promise.all([ct.revealed(), ct.startingIndex(), ct.totalMinted()]); STATE = { revealed: r, si: Number(si), minted: Number(t), ts: Date.now(), err: null }; } catch (e) { STATE.err = String(e.message||e); } }
refresh(); setInterval(refresh, 20000);
// Immediate-reveal guard: the 20s cache means a just-minted token can briefly still look unminted and serve the
// sealed placeholder (which OpenSea then caches). Before EVER sealing a token, do a fresh on-chain totalMinted read
// (debounced to <=1 call / 3s) so a token reveals the instant it is minted, not up to 20s later.
let _freshAt = 0;
async function freshMinted(){ if (TEST) return STATE.minted; const now = Date.now(); if (now - _freshAt < 3000) return STATE.minted;
  _freshAt = now; try { const t = Number(await ct.totalMinted()); if (t > STATE.minted) STATE.minted = t; if (!STATE.revealed) { STATE.revealed = await ct.revealed(); STATE.si = Number(await ct.startingIndex()); } } catch (e) {} return STATE.minted; }

// 1/1 SCATTER (re-weighted 2026-10-19, creator-directed at 139 minted): the ten mythic artworks sit at contiguous
// art indices 990-999, which under the startingIndex rotation would land on ten CONSECUTIVE tokenIds (875-884). We
// remap art 990-999 <-> ten UNMINTED art indices (bijective swap) to scatter them, now FRONT-WEIGHTED so early minters
// can pull a legendary: FIVE 1/1s fall in the next ~200 mints and FIVE spread across the rest. With si=115 the targets
// below land the mythics on tokens 148, 189, 233, 279, 331 (next 200) and 408, 531, 659, 787, 921 (remaining). Every
// target maps to an UNMINTED token (>139) so NO already-minted token (1-139) changes. "eff" is the effective art whose
// IMAGE + TRAITS + mythic status we serve; the NAME still follows the queried token's mint order.
const MYTHIC_SWAP_TARGETS = [263, 304, 348, 394, 446, 523, 646, 774, 902, 36];
const SWAP = {}; MYTHIC_SWAP_TARGETS.forEach((t, i) => { const m = 990 + i; SWAP[m] = t; SWAP[t] = m; });

const sealedMeta = { name: 'Vault Robber (Sealed)', description: 'Sealed. This Vault Robber unmasks the moment it is minted.', image: PUB + '/sealed.png', attributes: [{ trait_type: 'Status', value: 'Sealed' }] };
function realMeta(A){ const eff = (SWAP[A] !== undefined) ? SWAP[A] : A; const row = byArt[eff]; const mythic = eff >= 990;
  const by = (row.attributes.find(a=>a.trait_type==='Inspired By')||{}).value, kl = (row.attributes.find(a=>a.trait_type==='Class')||{}).value;
  const clause = by ? (kl ? `, inspired by ${by} (${kl}).` : `, inspired by ${by}.`) : '.';  // omit clause if source trait is missing — never emit "undefined"
  const desc = mythic ? `A 1 of 1 Vault Robber. ${row.name}${clause} One of ten legendary robbers hidden in the 1,000.`
                      : 'One of 1,000 Vault Robbers, cracked from the Robbing the Vault heist on Robinhood Chain.';
  const tokenId = artToToken(A, STATE.si);                 // ON-CHAIN token id the QUERIED art maps to; NAME follows mint order, not art index
  const name = 'Vault Robber #' + tokenId;
  let attrs = row.attributes.slice();   // real traits only — no redundant "Token ID" trait (OpenSea shows the token id natively)
  if (mythic) attrs = [{ trait_type: 'Legendary 1/1', value: row.name }].concat(attrs);
  return { name: name, description: desc, image: `${PUB}/img/${eff}.png`, attributes: attrs }; }

app.use((req,res,next)=>{ res.set('Access-Control-Allow-Origin','*'); res.set('Access-Control-Allow-Methods','GET'); next(); });
app.get('/meta/:file', async (req,res)=>{ const m=/^(\d+)\.json$/.exec(req.params.file); if(!m) return res.status(404).json({error:'bad id'});
  const A=+m[1]; if(A<0||A>=MAX) return res.status(404).json({error:'range'});
  if(!isLive(A,STATE)){ await freshMinted(); if(!isLive(A,STATE)){ res.set('Cache-Control','no-store'); return res.json(sealedMeta); } }
  res.set('Cache-Control','public, max-age=300'); res.json(realMeta(A)); });
app.get('/img/:file', async (req,res)=>{ const m=/^(\d+)\.png$/.exec(req.params.file); if(!m) return res.status(404).end();
  const A=+m[1]; if(A<0||A>=MAX) return res.status(404).end();
  // This image file is DISPLAYED by the token for `disp` (the swap partner when A is a 1/1-scatter index), so gate
  // liveness on THAT token — otherwise a minted 1/1 (which serves a remapped image) would wrongly return sealed.
  const disp=(SWAP[A]!==undefined)?SWAP[A]:A;
  if(!isLive(disp,STATE)){ await freshMinted(); if(!isLive(disp,STATE)){ res.set('Cache-Control','no-store'); return res.sendFile(path.join(__dirname,'public','sealed.png')); } }
  const f=path.join(IMAGES,`${A}.png`); if(!fs.existsSync(f)) return res.status(404).end();
  res.set('Cache-Control','public, max-age=86400'); res.type('png'); fs.createReadStream(f).pipe(res); });
app.get('/status', (req,res)=> res.json({ revealed:STATE.revealed, startingIndex:STATE.si, totalMinted:STATE.minted, maxSupply:MAX, ageMs:Date.now()-STATE.ts, err:STATE.err }));
app.use(express.static(path.join(__dirname,'public')));
app.listen(PORT, ()=> console.log('[vr-reveal] listening on', PORT));
