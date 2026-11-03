// Robbing the Vault — game server (prototype).
// Serves the browser game, proxies LIVE RobinVault market data (server-side only, never from the browser), and runs the
// shared economy: a provably-fair commit-reveal chamber engine + a living jackpot/pot/burn ledger in the group DB.
const express = require('express');
const crypto = require('crypto');

const app = express();
// Security headers (Jake 2026-09-09 anti-leak pass): no MIME sniffing, no framing/clickjacking, no referrer leakage.
app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Robots-Tag', 'noindex'); next(); });
app.use(express.json({ limit: '32kb' }));   // bound request bodies (event streams slice to 400 anyway) — no memory-pressure DoS on the single process
// Activity tracker: powers the demand-gate on the jackpot price poll so an idle instance doesn't hit the price API when
// nobody is playing/watching (cost hygiene, 2026-08-31 audit). Accrual itself continues by elapsed time (see below).
let _lastClient = Date.now();
app.use((req, res, next) => { _lastClient = Date.now(); next(); });
const _viewedRecently = () => (Date.now() - _lastClient) < 15 * 60 * 1000;

// ── DEV gate. Fail-closed, timing-safe, never indexable. ──
// If an outsider finds the subdomain they don't hit a boring auth error — they hit a cryptic "wrong door"
// Easter egg (misdirection, no product name) that deepens speculation. The real site stays sealed: entry is
// by password only, via a hidden lock on the door (signed HttpOnly cookie) or existing Basic Auth creds.
const DEV_PW = process.env.DEV_SITE_PASSWORD || '';
const eq = (x, y) => { const a = Buffer.from(String(x)), b = Buffer.from(String(y)); return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b); };
const gateCookie = () => DEV_PW ? crypto.createHmac('sha256', DEV_PW).update('rtv-dev-gate-v1').digest('hex') : '';
const readCookie = (req, name) => { const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)')); return m ? decodeURIComponent(m[1]) : ''; };
const pwFromBasic = (req) => { try { const dec = Buffer.from(((req.headers.authorization || '').split(' ')[1] || ''), 'base64').toString(); return dec.slice(dec.indexOf(':') + 1); } catch (e) { return ''; } };
const isAuthed = (req) => !!DEV_PW && (eq(readCookie(req, 'rtv_gate'), gateCookie()) || eq(pwFromBasic(req), DEV_PW));
const _enterRl = new Map();
const enterOk = (ip) => { const now = Date.now(), a = (_enterRl.get(ip) || []).filter(t => now - t < 600000); a.push(now); _enterRl.set(ip, a); return a.length <= 30; };

const DOOR_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>·</title>
<style>
 *{box-sizing:border-box;margin:0}html,body{height:100%}
 body{background:#000;color:#7fae93;font-family:'Courier New',monospace;overflow:hidden;display:flex;align-items:center;justify-content:center;min-height:100vh}
 .bg{position:fixed;inset:0;background:radial-gradient(60vw 60vw at 50% 42%,rgba(20,120,66,.14),transparent 70%),#000}
 .grain{position:fixed;inset:-60%;opacity:.04;pointer-events:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");animation:g .5s steps(3) infinite}
 @keyframes g{0%{transform:translate(0,0)}50%{transform:translate(-2%,1%)}}
 .wrap{position:relative;z-index:2;text-align:center;padding:24px;max-width:560px}
 .key{width:82px;height:82px;margin:0 auto 26px;filter:drop-shadow(0 0 18px rgba(61,255,143,.5));cursor:pointer;transition:transform .2s}
 .key:hover{transform:scale(1.06)}
 .whisper{font-size:15px;letter-spacing:.14em;min-height:1.6em;color:#8fbfa4;transition:opacity .8s}
 .sub{margin-top:14px;font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:#3a5a48}
 .lock{margin-top:30px;max-height:0;opacity:0;overflow:hidden;transition:.5s}
 .lock.on{max-height:220px;opacity:1}
 input{background:rgba(6,16,11,.7);border:1px solid rgba(61,255,143,.25);color:#cdead9;font-family:inherit;font-size:14px;letter-spacing:.2em;text-align:center;padding:11px 16px;border-radius:8px;outline:none;width:240px}
 input:focus{border-color:#3dff8f}
 .hint{margin-top:12px;font-size:10px;letter-spacing:.24em;color:#2f4a3b}
 .go{display:block;margin:14px auto 0;background:rgba(61,255,143,.12);border:1px solid rgba(61,255,143,.45);color:#3dff8f;font-family:inherit;font-size:13px;letter-spacing:.22em;text-transform:uppercase;padding:13px 30px;border-radius:8px;cursor:pointer}
 .go:active{background:rgba(61,255,143,.24)}
 .argOut{margin-top:22px;max-width:340px;font-size:12px;line-height:1.7;color:#9fcbb3;opacity:0;transition:opacity 1s;letter-spacing:.03em;text-shadow:0 0 16px rgba(61,255,143,.2)}
 .no{animation:shake .35s}@keyframes shake{25%{transform:translateX(-7px)}75%{transform:translateX(7px)}}
</style></head><body>
<div class="bg"></div><div class="grain"></div>
<div class="wrap">
 <svg class="key" id="key" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="19" r="11" stroke="#3dff8f" stroke-width="2"/><circle cx="24" cy="19" r="4" fill="#0a2417"/><path d="M24 30 L24 42 M24 42 L31 42 M24 36 L29 36" stroke="#3dff8f" stroke-width="2" stroke-linecap="round"/></svg>
 <div class="whisper" id="w">You found a door that was not meant for you.</div>
 <div class="sub">Sealed</div>
 <form class="lock" id="lock" onsubmit="return sub(event)"><input id="k" type="password" autocomplete="off" spellcheck="false" placeholder="speak the word" enterkeyhint="go"><button type="submit" class="go">Enter</button><div class="hint">the door listens</div></form>
 <div class="argOut" id="argOut"></div>
</div>
<script>
 // whispers rotate daily so returning hunters get a fresh lead; several hint at words the door will answer
 var L=["You found a door that was not meant for you.","There is more than one vault.","What burns is not gone. It is only moved.","The feather remembers every hand.","What Robin takes, he takes from the rich.","The greedy fall the deepest.","He never rides alone.","Keep your eyes on the chain.","Not all who descend are counted.","Some doors open only for those who already know.","Speak, and the door may answer."];
 var day=Math.floor(Date.now()/86400000), i=day%L.length, w=document.getElementById("w");
 w.textContent=L[i];
 setInterval(function(){w.style.opacity=0;setTimeout(function(){i=(i+1)%L.length;w.textContent=L[i];w.style.opacity=1;},800);},4200);
 // the door answers certain words with a fragment of the story (lore only; the real way in is still the password)
 var ARG={
  "feather":"The feather is not a key. It is a mark. It means the vault has already noticed you.",
  "robin":"He never rides alone. Find the ones who ride with him.",
  "crew":"You found them. The first crew rides on the sixth. Tell no one, and watch the chain.",
  "rich":"What is taken from the rich does not vanish. It is buried, and it grows.",
  "gold":"The gold is bait. The real prize has no name yet.",
  "descend":"The greedy fall the deepest. What waits at the bottom is worth the fall.",
  "core":"At the core, everything is claimed at once. No one has reached it. Yet.",
  "burn":"Every entry feeds the fire. What survives the fire only grows rarer.",
  "vault":"There is more than one. You may be standing at the wrong one. Or not."
 };
 var argEl=document.getElementById("argOut");
 function answer(m){ if(!argEl)return; argEl.style.opacity=0; setTimeout(function(){ argEl.textContent=m; argEl.style.opacity=1; },300); }
 document.getElementById("key").onclick=function(){document.getElementById("lock").classList.add("on");document.getElementById("k").focus();};
 function sub(e){e.preventDefault();var raw=document.getElementById("k").value,v=(raw||"").trim().toLowerCase();
  if(ARG[v]){ answer(ARG[v]); document.getElementById("k").value=""; return false; }   // a known word: the door whispers back, but stays shut
  fetch("__enter",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({k:raw})})
   .then(function(r){return r.json();}).then(function(j){if(j&&j.ok){location.reload();}else{var f=document.getElementById("lock");f.classList.add("no");setTimeout(function(){f.classList.remove("no");},400);document.getElementById("k").value="";}}).catch(function(){});
  return false;}
</script></body></html>`;

app.use((req, res, next) => {
  if (process.env.RTV_PUBLIC === '1') return next();   // PUBLIC PROD (launch): no password door, fully open + indexable. Only start-prod.js sets this; dev/test/mainnet-test never do, so their gate stays on.
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  // The one unauthenticated endpoint: the lock on the door. Validates the word, sets the signed cookie.
  if (req.method === 'POST' && req.path === '/__enter') {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?');
    if (!enterOk(ip)) return res.status(429).json({ ok: false });
    if (eq((req.body && req.body.k) || '', DEV_PW)) {
      res.set('Set-Cookie', 'rtv_gate=' + gateCookie() + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800');
      return res.json({ ok: true });
    }
    return res.status(401).json({ ok: false });
  }
  if (isAuthed(req)) return next();
  // Outsiders: a GET navigation gets the cryptic door; everything else gets a bare 401 (no content).
  if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return res.status(200).type('html').send(DOOR_HTML);
  return res.status(401).send('Restricted');
});

// ── On-chain (Robinhood testnet 46630) config + operator signing for the live contract ──
const { ethers } = require('ethers');
// LAUNCH SWITCH: the PROD artifact sets RTV_NET=mainnet (flips chain + contracts + keys together);
// dev/testnet leaves it unset and stays exactly as before. Deployed mainnet addresses (Robinhood 4663) baked in below.
const MAINNET = process.env.RTV_NET === 'mainnet';
const OC = MAINNET ? {
  chainId: 4663,
  rpc: process.env.RTV_RPC || 'https://rpc.mainnet.chain.robinhood.com',
  vault: '0x254DBcB680ECdF534eC0Dafb7aC476Bc768C77C1',   // RobbingTheVault (UUPS proxy), owner=Safe, fee 1000, gameEnd Oct 31
  rvlt: '0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04',    // ROBINVAULT (18dp)
  robbers: process.env.ROBBERS_CONTRACT || '0xABC6c4F5d1F31326b419c2645C981743a845313a',   // mainnet VaultRobbers v2 (redeploy 2026-09-05): OWNER-SETTABLE prices 25/50/75/100k, LootBag account, rescue nets, enforced 2% royalty (validator 0xA0000...5A0000). sink 0xe8886, royalties 0x96bc, signer 0xa6b8, owner=EOA 0x8444. Prev: 0x0741A47CE1A25419335dD4a39059Ec63Ba336f69
  robbersPrice: '12500',
  robbersTiers: [{ end: 250, price: '12500' }, { end: 500, price: '25000' }, { end: 750, price: '37500' }, { end: 1000, price: '50000' }],   // Option C (2026-09-06, Jake): tiers halved for max mint participation; live price read on-chain via currentPrice()
  robbersMax: 3,
  robbersSupply: 1000,
  sacRegistry: '0x000000006551c19487814612e58FE06813775758',
  sacImpl: process.env.SAC_IMPL || '0x8c56AAc07a7704A1C8C109664EDB379701Afcd17',   // LootBag account impl (mainnet redeploy 2026-09-05). Prev RobberSAC: 0x621Fc3874B834BA88Ef9eA03D990422D32151F62
  gameEnd: 1793462400,   // 2026-10-31 12:00 ET — vault seals; entries close + Safe can drain. Drives the in-game bank clock + landing countdown.
  explorer: 'https://robin.etherscan.io'
} : {
  chainId: 46630,
  rpc: 'https://rpc.testnet.chain.robinhood.com',
  vault: '0x3fB4f3667b907bc97d5322D3A4889b404E17909e',
  rvlt: '0x2B21e55fB7A84a500B23396a57D4dbA456c145b3',
  // Vault Robbers NFT (easter-egg mint at the teller desk, chamber 5) — testnet, tiered price
  robbers: process.env.ROBBERS_CONTRACT || '0x23371ca4608F1942a68435d51484ca71f9fFd0F6',   // testnet VaultRobbers v7: ERC721C (OpenSea royalty enforcement via transferValidator) + ERC2981 2% + ERC-6551 SAC; website-gated voucher mint, 900 public + 100 team reserve, max 3/wallet, 4-tier price (50/75/100/150k). validator: 0x93b4f258b30eA4BC25A3cEFcf44BE911B1cB676f
  robbersPrice: '50000',   // base/tier-1 price (live price is read on-chain via currentPrice/quote)
  robbersTiers: [{ end: 250, price: '50000' }, { end: 500, price: '75000' }, { end: 750, price: '100000' }, { end: 1000, price: '150000' }],
  robbersMax: 3,           // per wallet
  robbersSupply: 1000,
  // ERC-6551 "SAC" — each Robber owns a token-bound wallet (Emblem-Vault style). Canonical registry + our account impl.
  sacRegistry: '0x000000006551c19487814612e58FE06813775758',
  sacImpl: process.env.SAC_IMPL || '0xFA39cFc3D81F12F7E02Ee800849e4CE67aD2Df85',
  explorer: 'https://explorer.testnet.chain.robinhood.com'
};
const EIP712_DOMAIN = { name: 'RobbingTheVault', version: '1', chainId: OC.chainId, verifyingContract: OC.vault };
const SETTLE_TYPES = { Settle: [{ name: 'runId', type: 'bytes32' }, { name: 'stage', type: 'uint8' }, { name: 'robbed', type: 'bool' }] };
let _operator = null;
// Mainnet uses the DEDICATED operator key (0x90DE…, == the contract's operator); testnet uses the deployer. Chain-gated
// so the mainnet OPERATOR_PK group-secret never signs testnet settles (whose on-chain operator is the testnet deployer).
function operatorWallet() { const pk = MAINNET ? process.env.OPERATOR_PK : process.env.DEPLOYER_PRIVATE_KEY; if (!_operator && pk) _operator = new ethers.Wallet(pk); return _operator; }
// MAINNET posture: on the real chain (or when forced) the OFF-CHAIN demo money path is disabled so ALL value routes
// through the contract (verify-enter fee proof + operator settle-sig + contract-capped payout). The off-chain /api/enter
// and /api/cashout move DB-only "chips" and must never be redeemable for real value once real money is live. (Item #2.)
const ONCHAIN_ONLY = process.env.RTV_ONCHAIN_ONLY === '1' || OC.chainId === 4663;   // Robinhood MAINNET = 4663
// KEY HYGIENE (item #3): a DEDICATED Robbers-voucher signer, separate from the settle operator / deployer / owner. If
// ROBBERS_SIGNER_PK is set (mainnet), vouchers are signed by that key (which must equal the contract's `signer`), so a
// leaked voucher key can't also settle payouts or own the contract. Falls back to the operator key on testnet.
let _robSigner = null;
function robbersSigner() { if (MAINNET && process.env.ROBBERS_SIGNER_PK) { if (!_robSigner) _robSigner = new ethers.Wallet(process.env.ROBBERS_SIGNER_PK); return _robSigner; } return operatorWallet(); }   // mainnet: dedicated signer (==contract signer 0xa6b8…); testnet: deployer (==testnet robbers signer)

app.get('/api/onchain/config', (req, res) => res.json({ ...OC, fee: String(FEE), operator: operatorWallet() ? operatorWallet().address : null, turnstileSiteKey: TURNSTILE_SITE_KEY || '' }));

// Admin deposit history — PotSeeded (ROBINVAULT) + VaultSeeded (ETH) events, newest-first, with block timestamps and tx
// hashes for explorer links. Server-side because the public RPC blocks eth_getLogs from the browser (eth_call works, logs
// don't). Chunked getLogs from a fixed floor + 30s cache so it never outgrows the RPC as the season runs.
let _seedHist = { at: 0, data: null };
app.get('/api/onchain/seed-history', async (req, res) => {
  try {
    if (_seedHist.data && Date.now() - _seedHist.at < 30000) return res.json(_seedHist.data);
    const p = roProv();
    const v = new ethers.Contract(OC.vault, ['event PotSeeded(address indexed from,uint256 amount)', 'event VaultSeeded(address indexed from,uint256 amount)'], p);
    const head = await p.getBlockNumber();
    const START = 55000000, STEP = 900000;
    const chunk = async (filter) => { let o = []; for (let f = START; f <= head; f += STEP) { const t = Math.min(f + STEP - 1, head); try { o = o.concat(await v.queryFilter(filter, f, t)); } catch (_) {} } return o; };
    const [pot, eth] = await Promise.all([chunk(v.filters.PotSeeded()), chunk(v.filters.VaultSeeded())]);
    const blk = {}; const tsOf = async (bn) => { if (blk[bn] != null) return blk[bn]; try { const b = await p.getBlock(bn); blk[bn] = b ? Number(b.timestamp) : 0; } catch (_) { blk[bn] = 0; } return blk[bn]; };
    const rows = async (evs, kind) => { const out = []; for (const e of evs.sort((a, b) => b.blockNumber - a.blockNumber)) out.push({ amount: kind === 'eth' ? +ethers.formatEther(e.args.amount) : Math.round(+ethers.formatUnits(e.args.amount, 18)), ts: await tsOf(e.blockNumber), tx: e.transactionHash, from: e.args.from }); return out; };
    const data = { rvlt: await rows(pot, 'rvlt'), eth: await rows(eth, 'eth'), explorer: OC.chainId === 4663 ? 'https://robin.etherscan.io' : 'https://explorer.testnet.chain.robinhood.com' };
    _seedHist = { at: Date.now(), data };
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ── Bot-review analysis (admin-gated) ── Aggregates rtv_bot_signals into per-wallet suspicion + cash-out-farm signatures for the
// week-1 observation window (Jake 2026-09-04). Auth: x-admin-token or ?k= must equal RTV_ADMIN_TOKEN or DEV_SITE_PASSWORD (so it
// stays private even on the public prod artifact). Read-only.
app.get('/api/admin/bot-review', async (req, res) => {
  // Auth (hardened 2026-09-04 red-team C1): on the PUBLIC prod build require a DEDICATED RTV_ADMIN_TOKEN and FAIL CLOSED if it is
  // unset — never fall back to the shared DEV_SITE_PASSWORD on a public site. On the gated dev/test twins, DEV_PW is still accepted.
  const ADMIN = process.env.RTV_ADMIN_TOKEN || (process.env.RTV_PUBLIC === '1' ? '' : DEV_PW);
  const t = req.get('x-admin-token') || req.query.k || '';
  if (!ADMIN || t !== ADMIN) return res.status(403).json({ error: 'forbidden' });
  try {
    const tp = p => { p = String(p || ''); return p.length > 12 ? p.slice(0, 6) + '…' + p.slice(-4) : p; };   // truncate wallets — no full-address PII leak
    const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 7));
    const net = OC.chainId;
    // per-wallet skill/nerve signal aggregates; variance via E[x^2]-E[x]^2 (SQLite has no VARIANCE). The bot signature is a high
    // mean score with near-zero variance (a human's scores wobble), low humanness, or high volume from a single IP.
    const sus = await dbQuery(`SELECT player, COUNT(*) n, ROUND(AVG(score),3) mean_score, ROUND(AVG(score*score)-AVG(score)*AVG(score),5) var_score, ROUND(AVG(human),3) mean_human, SUM(flagged) flags, COUNT(DISTINCT ip_hash) ips, MIN(ts) first_seen, MAX(ts) last_seen FROM rtv_bot_signals WHERE event='crack' AND score IS NOT NULL AND net=? AND ts > datetime('now','-${days} days') GROUP BY player HAVING n>=8 ORDER BY n DESC LIMIT 300`, [net]).catch(() => []);
    const suspects = (sus || []).map(r => { const f = []; if (r.mean_score >= 0.95 && r.var_score <= 0.001) f.push('low-variance-high-score'); if (r.mean_human != null && r.mean_human < 0.5) f.push('low-humanness'); if (r.n >= 40 && r.ips <= 1) f.push('single-ip-high-volume'); if (r.flags >= 5) f.push('anticheat-flagged'); return { ...r, player: tp(r.player), suspicion: f }; }).filter(r => r.suspicion.length);
    const farmers = await dbQuery(`SELECT player, COUNT(*) cashouts, GROUP_CONCAT(DISTINCT level) stages, COUNT(DISTINCT ip_hash) ips, MAX(ts) last FROM rtv_bot_signals WHERE event='cashout' AND net=? AND ts > datetime('now','-${days} days') GROUP BY player HAVING cashouts>=5 ORDER BY cashouts DESC LIMIT 200`, [net]).catch(() => []);
    const totals = (await dbQuery(`SELECT COUNT(*) cracks, SUM(flagged) flags, COUNT(DISTINCT player) wallets FROM rtv_bot_signals WHERE event='crack' AND net=? AND ts > datetime('now','-${days} days')`, [net]).catch(() => [{}]))[0] || {};
    res.json({ days, net, turnstileArmed: !!TURNSTILE_SECRET, totals, suspects, cashoutFarmers: (farmers || []).map(r => ({ ...r, player: tp(r.player) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Open a run on-chain: server owns the seed, returns the keccak commit for the entry tx.
// Post-cashout cooldown (Jake 2026-09-04): after a wallet banks a cash-out, it can't start a new run for a short window. Pure
// wall-clock friction on the cash-out-farm loop (a bot can play filler games at machine speed, but can't compress real time);
// a busted player replaying is never affected. Defense-in-depth on top of the odds model — set 0 to disable.
const CASHOUT_COOLDOWN_MS = 60_000;
const _lastCashout = new Map();   // player -> ts of their last cash-out settle authorization
app.post('/api/onchain/newrun', async (req, res) => {
  try {
    const player = String(req.body.player || 'anon').slice(0, 64);
    if (ONCHAIN_ONLY && !ethers.isAddress(player)) return res.status(400).json({ error: 'valid wallet required' });   // mainnet: bind the run to a real address so keys can't be dodged with junk strings (red-team H-1)
    if (!rateOk('nr:' + _clientIp(req), req)) return res.status(429).json({ error: 'slow down' });   // throttle free run-creation by IP, NOT the client-supplied player (rotating player strings dodged the per-player cap)
    const _cd = _lastCashout.get(player.toLowerCase());   // enforce the post-cashout cooldown (lowercased key so wallet-casing variants can't dodge it — red-team H1)
    if (CASHOUT_COOLDOWN_MS && _cd && (Date.now() - _cd) < CASHOUT_COOLDOWN_MS) return res.status(429).json({ error: 'Just banked a cash-out. Take a breath and re-enter in a moment.', retryMs: CASHOUT_COOLDOWN_MS - (Date.now() - _cd) });
    const runId = ethers.hexlify(ethers.randomBytes(32));
    const serverSeed = ethers.hexlify(ethers.randomBytes(32));
    const commit = ethers.keccak256(serverSeed);
    // GRIND-PROOF: the server commits its seed HERE (returned as `commit`, and locked on-chain by the enter() tx) BEFORE it
    // knows the player's seed. The player then binds their OWN clientSeed via /bind-seed. Because neither side sees the other's
    // seed when choosing its own, the operator cannot grind a house-favorable pair and the player cannot predict a roll. The
    // run is unplayable until a seed is bound (crack rejects an unbound run). client_seed starts empty and is set exactly once.
    await dbExec("INSERT INTO rtv_seeds (run_id,player,stake,server_seed,server_hash,client_seed,nonce,depth,mult,status,net) VALUES (?,?,?,?,?,'',0,0,1,'open',?)",
      [runId, player, CHIPS, serverSeed, commit, OC.chainId]);
    if (req.body.pageNonce) _runPage.set(runId, String(req.body.pageNonce));   // bind to the page load so a later refresh forfeits
    res.json({ runId, commit, doors: doorsLayout(serverSeed, 1) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GRIND-PROOF seed binding: the player supplies their OWN entropy AFTER the server has committed its seed (above). Set-once —
// a bound seed can never be changed (so a player can't re-roll it after seeing an outcome), and it can only be set while the
// run is still open and unbound. The WHERE guard makes the set atomic against a double-submit race. This is what closes the
// only residual weakness in the old model (server generated BOTH seeds → could grind the pair). Now: server blind to client
// seed at commit; player blind to server seed (only has its hash) at bind. Fair if EITHER party is honest.
app.post('/api/onchain/bind-seed', async (req, res) => {
  try {
    const runId = String(req.body.runId || '');
    const cs = String(req.body.clientSeed || '').trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{16,64}$/.test(cs)) return res.status(400).json({ error: 'bad client seed' });   // 8-32 bytes of hex entropy
    if (!rateOk('bind:' + runId, req)) return res.status(429).json({ error: 'slow down' });
    const row = (await dbQuery("SELECT client_seed, status FROM rtv_seeds WHERE run_id=?", [runId]))[0];
    if (!row) return res.status(404).json({ error: 'no such run' });
    if (row.status !== 'open') return res.status(400).json({ error: 'run not open' });
    if (row.client_seed) return row.client_seed === cs ? res.json({ ok: true, clientSeed: cs }) : res.status(409).json({ error: 'seed already bound' });   // set-once (idempotent on identical)
    await dbExec("UPDATE rtv_seeds SET client_seed=? WHERE run_id=? AND (client_seed='' OR client_seed IS NULL)", [cs, runId]);   // atomic set-once
    const after = (await dbQuery("SELECT client_seed FROM rtv_seeds WHERE run_id=?", [runId]))[0];
    res.json({ ok: true, clientSeed: after ? after.client_seed : cs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mark a run PAID only after verifying the real on-chain entry tx. This is what makes a run "count" toward the Vault
// Robbers teller gate — free/scripted DB runs can never set paid=1, so they can't farm their way to a mint.
app.post('/api/onchain/verify-enter', async (req, res) => {
  try {
    const runId = String(req.body.runId || '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(runId)) return res.status(400).json({ error: 'bad runId' });
    const row = (await dbQuery("SELECT player, paid FROM rtv_seeds WHERE run_id=?", [runId]))[0];
    if (!row) return res.status(404).json({ error: 'no such run' });
    if (Number(row.paid) === 1) return res.json({ ok: true, paid: true });   // idempotent
    const txHash = String(req.body.txHash || '');
    // FAST-PATH nudge: if the client handed us the entry tx hash, wait for it to mine via the Alchemy socket so the on-chain
    // read below never races ahead of indexing. Optional + best-effort; we no longer REQUIRE a hash (that was the bug: a
    // wallet that hung after broadcasting lost the hash, stranding a PAID player). Recovery below works without it.
    if (/^0x[0-9a-fA-F]{64}$/.test(txHash)) { const ws = wsProv(); if (ws) { try { await Promise.race([ws.waitForTransaction(txHash, 1, 8000), new Promise((_, r) => setTimeout(() => r(new Error('ws-timeout')), 8500))]); } catch (_) {} } }
    // AUTHORITATIVE confirm by CONTRACT run state (Jake 2026-09-07): enter() sets runs[runId]={player: msg.sender, status: Open}
    // and require()s the fee transfer, so status==Open ⟹ the entry was PAID on-chain for THIS run. We match the on-chain
    // entrant to the run's recorded player. This recovers a paid entry whose wallet hung and never returned a tx hash — no
    // hash required. settle() independently re-checks status==Open on-chain, so paid=1 can never over-authorize a payout.
    let r; try { r = await new ethers.Contract(OC.vault, VAULT_READ_ABI, roProv()).runs(runId); } catch (e) { return res.status(502).json({ error: 'chain read failed, retry' }); }
    const onchainPlayer = String((r && (r.player !== undefined ? r.player : r[0])) || '').toLowerCase();
    const status = Number(r && (r.status !== undefined ? r.status : r[3]) || 0);   // enum Status { None:0, Open:1, Settled:2 }
    if (status === 0 || /^0x0+$/.test(onchainPlayer)) return res.status(400).json({ error: 'entry not confirmed yet' });   // not mined/indexed yet — client keeps polling
    if (onchainPlayer !== String(row.player || '').toLowerCase()) return res.status(400).json({ error: 'entrant mismatch' });
    await dbExec("UPDATE rtv_seeds SET paid=1 WHERE run_id=?", [runId]);
    await dbExec("INSERT OR IGNORE INTO rtv_paid_log (run_id,net,player) VALUES (?,?,?)", [runId, OC.chainId, String(row.player || '').toLowerCase()]).catch(() => {});   // DURABLE serviced marker (survives the rtv_seeds GC) so the reconcile loop never mistakes a real, played entry for an orphan
    res.json({ ok: true, paid: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── House-sponsored comp entries (make-good for paid-but-never-serviced runs; reconciliation audit 2026-09-07) ─────────
// A wallet listed in rtv_comps can redeem a FREE run: the dedicated SPONSOR wallet (0x411f…, group secret DEPLOYER_PRIVATE_KEY
// — deliberately NOT the operator, which stays empty/sign-only) pays the entry fee on-chain via enterFor(player,runId,commit),
// so the run is credited to the PLAYER and settles/cracks EXACTLY like a paid run (paid=1, on-chain runs[runId] Open, real
// pot payout). Capped to the audited comp balance per wallet, gated by a wallet-ownership signature (so nobody can burn
// another wallet's comps), atomic (decrement-then-spend with refund-on-failure), and idempotent per runId.
const COMP_MSG = (runId) => `Robbing the Vault\nRedeem free run:\n${runId}`;
let _sponsor = null;
function sponsorWallet() {
  if (_sponsor) return _sponsor;
  const pk = process.env.DEPLOYER_PRIVATE_KEY;   // 0x411f… on BOTH nets (mainnet comp wallet == testnet deployer, per Jake 2026-09-07)
  if (!pk) return null;
  try { _sponsor = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk, new ethers.JsonRpcProvider(OC.rpc, OC.chainId)); } catch (_) { _sponsor = null; }
  return _sponsor;
}
const ENTERFOR_ABI = ['function enterFor(address player, bytes32 runId, bytes32 commit)'];
const ERC20_APPROVE_ABI = ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'];
let _sponsorApproved = false;
async function ensureSponsorApproval(sp) {
  if (_sponsorApproved) return;
  const tok = new ethers.Contract(OC.rvlt, ERC20_APPROVE_ABI, sp);
  const cur = await tok.allowance(sp.address, OC.vault);
  if (cur >= ethers.parseUnits('1000000', 18)) { _sponsorApproved = true; return; }   // enough headroom already
  const need = ethers.parseUnits('100000000', 18);   // 100M RVLT cap — bounded (NOT unlimited), one-time approval
  console.log('[rtv-comp] approve: token', OC.rvlt, 'spender(vault)', OC.vault, 'amount 100000000 RVLT (bounded, one-time)');
  const tx = await tok.approve(OC.vault, need); await tx.wait(1);
  _sponsorApproved = true;
}

// AUTO-GATE: comps only go live once the V3 upgrade is on-chain (the proxy exposes sponsor() and it is set). Until the Safe
// executes the upgrade + setSponsor, this reads false and the client never promises a free run it can't yet redeem. Cached 60s.
let _compsLive = { at: 0, on: false };
async function compsLive() {
  if (!ONCHAIN_ONLY) return false;
  if (Date.now() - _compsLive.at < 60000) return _compsLive.on;
  let on = false;
  try { const s = await new ethers.Contract(OC.vault, ['function sponsor() view returns (address)'], roProv()).sponsor(); on = /^0x[0-9a-fA-F]{40}$/.test(String(s)) && !/^0x0+$/.test(String(s)); } catch (_) { on = false; }   // V2 has no sponsor() -> reverts -> false
  _compsLive = { at: Date.now(), on };
  return on;
}

// How many free comp runs a wallet has left (drives the client "use a free run" prompt).
app.get('/api/comp/status', async (req, res) => {
  try {
    const a = String(req.query.player || req.query.address || '');
    if (!ethers.isAddress(a)) return res.json({ freeRuns: 0 });
    if (!(await compsLive())) return res.json({ freeRuns: 0, pending: true });   // V3 not live yet — don't surface redeemable comps
    const row = (await dbQuery("SELECT free_runs FROM rtv_comps WHERE wallet=? AND net=?", [a.toLowerCase(), OC.chainId]).catch(() => []))[0];
    res.json({ freeRuns: row ? Math.max(0, Number(row.free_runs)) : 0 });
  } catch (e) { res.json({ freeRuns: 0 }); }
});

// Redeem one comp for an already-created (newrun+bind-seed) open run: sponsor its on-chain entry, mark it paid.
app.post('/api/onchain/comp-enter', async (req, res) => {
  try {
    if (!ONCHAIN_ONLY) return res.status(400).json({ error: 'comps are mainnet-only' });
    if (!(await compsLive())) return res.status(400).json({ error: 'free runs are not live yet — the on-chain upgrade is still pending' });
    const runId = String(req.body.runId || '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(runId)) return res.status(400).json({ error: 'bad runId' });
    if (!rateOk('comp:' + _clientIp(req), req)) return res.status(429).json({ error: 'slow down' });
    const row = (await dbQuery("SELECT player, server_hash, status, paid FROM rtv_seeds WHERE run_id=?", [runId]))[0];
    if (!row) return res.status(404).json({ error: 'no such run' });
    if (Number(row.paid) === 1) return res.json({ ok: true, paid: true });   // idempotent
    if (row.status !== 'open') return res.status(400).json({ error: 'run not open' });
    const player = String(row.player || '');
    if (!ethers.isAddress(player)) return res.status(400).json({ error: 'run has no wallet' });
    // WALLET-OWNERSHIP PROOF (anti-grief): only the run's own wallet can spend its comps — otherwise anyone could burn a
    // comped player's free runs by starting-and-busting runs in their name.
    let recovered = '';
    try { recovered = ethers.verifyMessage(COMP_MSG(runId), String(req.body.sig || '')); } catch (_) {}
    if (recovered.toLowerCase() !== player.toLowerCase()) return res.status(403).json({ error: 'sign with the run wallet to redeem a free run' });
    // ATOMIC claim BEFORE spending: consume a comp only if one is available; refunded below if the on-chain entry fails.
    const claim = await dbExec("UPDATE rtv_comps SET free_runs=free_runs-1, redeemed=COALESCE(redeemed,0)+1 WHERE wallet=? AND net=? AND free_runs>0", [player.toLowerCase(), OC.chainId]);
    if (!claim || Number(claim.changes) !== 1) return res.status(403).json({ error: 'no free runs available for this wallet' });
    const refund = () => dbExec("UPDATE rtv_comps SET free_runs=free_runs+1, redeemed=MAX(0,COALESCE(redeemed,1)-1) WHERE wallet=? AND net=?", [player.toLowerCase(), OC.chainId]).catch(() => {});
    const sp = sponsorWallet();
    if (!sp) { await refund(); return res.status(500).json({ error: 'sponsor key not set' }); }
    let txHash = '';
    try {
      await ensureSponsorApproval(sp);
      const vault = new ethers.Contract(OC.vault, ENTERFOR_ABI, sp);
      const tx = await vault.enterFor(player, runId, row.server_hash);
      txHash = tx.hash;
      await tx.wait(1);
    } catch (e) {
      // If it reverted only because the run is ALREADY entered on-chain (a retry), treat as success. Otherwise refund the comp.
      let entered = false;
      try { const r = await new ethers.Contract(OC.vault, VAULT_READ_ABI, roProv()).runs(runId); const st = Number(r && (r.status !== undefined ? r.status : r[3]) || 0); const pl = String((r && (r.player !== undefined ? r.player : r[0])) || '').toLowerCase(); entered = st === 1 && pl === player.toLowerCase(); } catch (_) {}
      if (!entered) { await refund(); return res.status(502).json({ error: 'sponsor entry failed, try again in a moment' }); }
    }
    await dbExec("UPDATE rtv_seeds SET paid=1 WHERE run_id=?", [runId]);
    await dbExec("INSERT OR IGNORE INTO rtv_paid_log (run_id,net,player) VALUES (?,?,?)", [runId, OC.chainId, player.toLowerCase()]).catch(() => {});   // durable serviced marker (a comp entry IS a serviced run, so it must count against future reconcile deficits)
    await dbExec("INSERT INTO rtv_comp_redemptions (wallet,run_id,tx,net) VALUES (?,?,?,?)", [player.toLowerCase(), runId, txHash, OC.chainId]).catch(() => {});
    res.json({ ok: true, paid: true, txHash });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Practice Arcade pass: pay 10,000 RVLT ONCE (tied to the wallet, forever) to unlock unlimited free practice of every
// mini-game. Split 50/50 burn/pot (same ethos as the run entry fee). Payment is an on-chain RVLT transfer to the vault,
// verified here from the tx logs — the client can't fake it. (Note: the burn half is DB accounting on testnet; a true
// on-chain burn/split would want a dedicated contract method at mainnet.)
const ARCADE_FEE = 25000, ARCADE_BURN = 12500, ARCADE_POT = 12500;   // arcade pass 10k->25k (2026-09-03, ~25 runs' worth); plain RVLT transfer, no signature. Client reads fee from /api/arcade/status.
const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const _pad32 = (x) => '0x' + String(x).toLowerCase().replace(/^0x/, '').padStart(64, '0');
app.get('/api/arcade/status', async (req, res) => {
  try {
    const a = String(req.query.address || '');
    const base = { paid: false, fee: ARCADE_FEE, burn: ARCADE_BURN, pot: ARCADE_POT, sink: OC.vault };
    if (!ethers.isAddress(a)) return res.json(base);
    const row = (await dbQuery("SELECT wallet FROM rtv_arcade_pass WHERE wallet=? AND net=?", [ethers.getAddress(a), OC.chainId]).catch(() => []))[0];
    res.json({ ...base, paid: !!row });
  } catch (e) { res.json({ paid: false, fee: ARCADE_FEE, sink: OC.vault }); }
});
app.post('/api/arcade/pass', async (req, res) => {
  try {
    let addr = String(req.body.address || '');
    if (!ethers.isAddress(addr)) return res.status(400).json({ error: 'bad address' });
    addr = ethers.getAddress(addr);
    if (!rateOk('arcade:' + addr, req)) return res.status(429).json({ error: 'slow down' });
    const have = (await dbQuery("SELECT wallet FROM rtv_arcade_pass WHERE wallet=? AND net=?", [addr, OC.chainId]).catch(() => []))[0];
    if (have) return res.json({ ok: true, paid: true });   // idempotent: already unlocked forever (per network)
    const txHash = String(req.body.txHash || '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return res.status(400).json({ error: 'bad tx hash' });
    // WS fast-path (same fix as verify-enter): confirm the tx via the Alchemy socket so the receipt read below doesn't race
    // ahead of the public node's indexing (that lag is what made the arcade unlock feel like it hung for ~20s). Bounded + optional.
    const _ws = wsProv();
    if (_ws) { try { await Promise.race([_ws.waitForTransaction(txHash, 1, 8000), new Promise((_, r) => setTimeout(() => r(new Error('ws-timeout')), 8500))]); } catch (_) {} }
    const rcpt = await roProv().getTransactionReceipt(txHash);
    if (!rcpt || rcpt.status !== 1) return res.status(400).json({ error: 'payment tx not confirmed' });
    // Require an RVLT Transfer(from=addr, to=vault, value>=10,000) in this tx — proof of the one-time arcade payment.
    const need = ethers.parseUnits(String(ARCADE_FEE), 18);
    const ok = (rcpt.logs || []).some(l => {
      try {
        return l.address && l.address.toLowerCase() === OC.rvlt.toLowerCase()
          && l.topics && l.topics[0] && l.topics[0].toLowerCase() === ERC20_TRANSFER_TOPIC.toLowerCase()
          && l.topics[1] && l.topics[1].toLowerCase() === _pad32(addr).toLowerCase()
          && l.topics[2] && l.topics[2].toLowerCase() === _pad32(OC.vault).toLowerCase()
          && BigInt(l.data) >= need;
      } catch (_) { return false; }
    });
    if (!ok) return res.status(400).json({ error: 'no matching 10,000 RVLT payment to the vault in that tx' });
    await dbExec("INSERT OR IGNORE INTO rtv_arcade_pass (wallet,tx,net,fee_paid) VALUES (?,?,?,?)", [addr, txHash, OC.chainId, ARCADE_FEE]);
    await bumpState({ burned_rvlt: ARCADE_BURN, pot_rvlt: ARCADE_POT });   // 50/50 accounting
    res.json({ ok: true, paid: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Operator-signed settlement: the contract caps the payout; here we sign the outcome + reveal the seed.
app.post('/api/onchain/settle-sig', async (req, res) => {
  try {
    const op = operatorWallet(); if (!op) return res.status(500).json({ error: 'operator key not set' });
    const runId = String(req.body.runId || '');
    if (!rateOk('settle:' + runId, req)) return res.status(429).json({ error: 'slow down' });   // throttle operator-signing per run
    const row = (await dbQuery("SELECT player, server_seed, depth, status, paid FROM rtv_seeds WHERE run_id=?", [runId]))[0];
    if (!row) return res.status(404).json({ error: 'no such run' });
    // PAID GATE: only a run that actually paid its entry on-chain (verify-enter set paid=1) can ever be settled. This
    // closes "open a run, grind depth WITHOUT paying, then claim" — the settle path is now as strict as the mint gate.
    // (The on-chain vault must ALSO escrow per-runId + single-claim guard; this is the server-side half.)
    if (!Number(row.paid)) return res.status(403).json({ error: 'run not paid on-chain' });
    // AUTHORITATIVE: the outcome we sign comes from the SERVER's run state, never the client. A client cannot ask
    // us to sign a "robbed" (the ETH-jackpot claim) for a run that never cracked the core, nor inflate the stage to
    // enlarge a cash-out. This is the gate that stops "call settle on-chain to skip the whole game and take the vault".
    const realRobbed = row.status === 'robbed';
    const realStage = realRobbed ? LEVELS : Math.min(num(row.depth), LEVELS);
    // HUMAN FIREWALL at cash-out (Jake 2026-09-04): a cash-out must pass Turnstile. No-op if Turnstile isn't configured. Core
    // (robbed) settles are exempt so a genuine 1-in-a-million jackpot can never be blocked by a captcha hiccup.
    if (!realRobbed && !(await verifyTurnstile(req.body.captcha, req))) return res.status(403).json({ error: 'Quick human check needed to cash out. Complete the check and try again.', captcha: true });
    if (req.body.robbed && !realRobbed) return res.status(403).json({ error: 'this run has not cracked the core' });
    // BANKABLE GATE (2026-08-31, vicious bug): a cash-out (non-robbed settle) is only valid while the run is still OPEN — i.e.
    // the player is banking mid-run. A BUSTED or FORFEITED run must NEVER be settleable, otherwise a player could push past a
    // safe stage, bust on the next chamber, then still claim that stage's cash-out — removing all downside from pushing their
    // luck. Robbed runs (status='robbed') are exempt (they settle the core). The on-chain single-claim guard stops re-banking.
    if (!realRobbed && row.status !== 'open') return res.status(403).json({ error: 'run is not bankable (busted, forfeited, or already settled)' });
    if (!realRobbed && realStage < 1) return res.status(403).json({ error: 'nothing to settle yet' });
    const sig = await op.signTypedData(EIP712_DOMAIN, SETTLE_TYPES, { runId, stage: realStage, robbed: realRobbed });
    if (!realRobbed) _lastCashout.set(String(row.player || '').toLowerCase(), Date.now());   // start the post-cashout cooldown, lowercased key (row.player == the verified on-chain payer via verify-enter) — red-team H1
    try { const _fp = _reqFP(req); logBotSignal({ player: row.player, run: runId, level: realStage, kind: realRobbed ? 'core' : 'cashout', ipHash: _fp.ip, uaHash: _fp.ua, event: realRobbed ? 'core' : 'cashout' }); } catch (e) {}   // bot-review metadata
    res.json({ sig, serverSeed: row.server_seed, stage: realStage, robbed: realRobbed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Vault Robbers WEBSITE-GATED mint voucher ─────────────────────────────────────────────────────────
// The contract's mint() rejects any call without a fresh EIP-712 voucher signed by the operator key. Only
// this endpoint issues them, and only to a wallet that actually reached the teller (chamber 5) in a real,
// server-scored run — so nobody can call the contract directly to bypass the game and hoard supply.
const ROBBERS_VOUCHER_TYPES = { MintVoucher: [{ name: 'minter', type: 'address' }, { name: 'qty', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] };
const robbersDomain = () => ({ name: 'Vault Robbers', version: '1', chainId: OC.chainId, verifyingContract: OC.robbers });
// LOCKED (Jake 2026-08-30): minting REQUIRES reaching the teller (chamber 5) in a real run — 4 = reached teller.
// (The env override exists only as a break-glass; production intent is the teller gate. Do not ship 0.)
// On mainnet, floor the teller-gate at 4 so a stray ROBBERS_MIN_DEPTH=0 break-glass env can never silently open the mint gate. (item #3)
const ROBBERS_MIN_DEPTH = ONCHAIN_ONLY ? Math.max(4, Number(process.env.ROBBERS_MIN_DEPTH || 4)) : Number(process.env.ROBBERS_MIN_DEPTH || 4);
app.post('/api/onchain/robbers-voucher', async (req, res) => {
  try {
    if (process.env.RTV_NO_MINT === '1') return res.status(403).json({ error: 'minting disabled' });   // mint fully cut on the classic (Jake 2026-09-09)
    const op = robbersSigner(); if (!op) return res.status(500).json({ error: 'signer key not set' });   // dedicated voucher signer (item #3)
    let minter = String(req.body.minter || '');
    if (!ethers.isAddress(minter)) return res.status(400).json({ error: 'bad minter address' });
    minter = ethers.getAddress(minter);
    // HUMAN FIREWALL at the mint gate (Jake 2026-09-04): must pass Turnstile to get a mint voucher. No-op if Turnstile unset.
    if (!(await verifyTurnstile(req.body.captcha, req))) return res.status(403).json({ error: 'Quick human check needed to mint. Complete the check and try again.', captcha: true });
    let qty = Math.max(1, Math.min(OC.robbersMax || 3, Number(req.body.qty || 1) | 0));
    // GATE: this wallet must have reached the teller in a real run (on-chain runs are keyed by wallet).
    if (ROBBERS_MIN_DEPTH > 0) {
      // must have reached the teller in a PAID, on-chain-verified run (paid=1) — free/scripted DB runs never count.
      const row = (await dbQuery("SELECT MAX(depth) d FROM rtv_seeds WHERE lower(player)=lower(?) AND paid=1 AND net=?", [minter, OC.chainId]))[0];
      if (!row || Number(row.d || 0) < ROBBERS_MIN_DEPTH) return res.status(403).json({ error: 'Reach the teller (chamber 5) in a paid run before you can mint.' });
    }
    // Read the on-chain nonce (voucher must match) + remaining wallet cap (never sign a wasted voucher).
    const prov = roProv();   // shared cached provider
    const c = new ethers.Contract(OC.robbers, ['function mintNonce(address) view returns (uint256)', 'function mintedBy(address) view returns (uint256)'], prov);
    const [nonce, already] = await Promise.all([c.mintNonce(minter), c.mintedBy(minter)]);
    const remaining = (OC.robbersMax || 3) - Number(already);
    if (remaining <= 0) return res.status(403).json({ error: 'This wallet already minted its 3.' });
    qty = Math.min(qty, remaining);
    const deadline = Math.floor(Date.now() / 1000) + 15 * 60;   // voucher valid 15 minutes
    const signature = await op.signTypedData(robbersDomain(), ROBBERS_VOUCHER_TYPES, { minter, qty, nonce, deadline });
    res.json({ qty, deadline, signature, nonce: Number(nonce), remaining });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Server-side chain READ proxies (Shannon review): the browser must never construct its own RPC provider. These mirror
// the reads the teller/gallery/SAC overlay used to do client-side. All read-only, public data; writes still go via the
// user's wallet. Shared cached provider so we don't spin one up per request. ───────────────────────────────────────────
// Read provider with FAILOVER. A single RPC is a single point of failure, so on mainnet we fail over from the public
// Robinhood RPC to Alchemy (robinhood-mainnet). Alchemy key is the group secret 'Alchemy' (optional); primary-first via
// priority, Alchemy only kicks in when the public RPC stalls/errors (quorum 1), so it costs no extra compute normally.
const _ALCHEMY_KEY = process.env.Alchemy || process.env.ALCHEMY || '';
const _ALCHEMY_HTTP = (OC.chainId === 4663 && _ALCHEMY_KEY) ? 'https://robinhood-mainnet.g.alchemy.com/v2/' + _ALCHEMY_KEY : '';
const _ALCHEMY_WS = (OC.chainId === 4663 && _ALCHEMY_KEY) ? 'wss://robinhood-mainnet.g.alchemy.com/v2/' + _ALCHEMY_KEY : '';
let _roProv = null;
function roProv() {
  if (_roProv) return _roProv;
  const primary = new ethers.JsonRpcProvider(OC.rpc, OC.chainId);
  if (_ALCHEMY_HTTP) {
    try {
      const alch = new ethers.JsonRpcProvider(_ALCHEMY_HTTP, OC.chainId);
      _roProv = new ethers.FallbackProvider([
        { provider: primary, priority: 1, stallTimeout: 1500, weight: 1 },
        { provider: alch, priority: 2, stallTimeout: 1500, weight: 1 }
      ], OC.chainId, { quorum: 1 });
      console.log('[rtv] RPC failover active: public Robinhood -> Alchemy');
      return _roProv;
    } catch (e) { console.error('[rtv] fallback provider init failed, using single RPC:', e.message); }
  }
  _roProv = primary;
  return _roProv;
}
// Optional WebSocket provider (Alchemy, mainnet only) for near-instant tx confirmation on entry. Lazily opened; self-heals
// on socket error by dropping the handle so the next call rebuilds. Never required — every path falls back to HTTP reads.
let _wsProv = null;
function wsProv() {
  if (!_ALCHEMY_WS) return null;
  if (_wsProv) return _wsProv;
  try {
    _wsProv = new ethers.WebSocketProvider(_ALCHEMY_WS, OC.chainId);
    try { const s = _wsProv.websocket; if (s && s.on) s.on('error', () => { try { _wsProv && _wsProv.destroy(); } catch (_) {} _wsProv = null; }); } catch (_) {}
  } catch (e) { _wsProv = null; }
  return _wsProv;
}
const RB_READ_ABI = ['function totalMinted() view returns (uint256)', 'function mintActive() view returns (bool)', 'function currentPrice() view returns (uint256)', 'function mintedBy(address) view returns (uint256)', 'function ownerOf(uint256) view returns (address)', 'function tokenURI(uint256) view returns (string)', 'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)'];
const REG_READ_ABI = ['function account(address,bytes32,uint256,address,uint256) view returns (address)'];
const BAL_ABI = ['function balanceOf(address) view returns (uint256)'];
const VAULT_READ_ABI = ['function potRvlt() view returns (uint256)', 'function vaultEth() view returns (uint256)', 'function runs(bytes32) view returns (address player, bytes32 commit, uint8 stage, uint8 status)'];
const SALT6551 = '0x' + '00'.repeat(32);
const sacAddr = (tokenId) => new ethers.Contract(OC.sacRegistry, REG_READ_ABI, roProv()).account(OC.sacImpl, SALT6551, OC.chainId, OC.robbers, tokenId);
// SSRF guard: tokenURI can (in theory) point anywhere; only fetch public https and never internal/private hosts, with a hard timeout.
function safeMetaUrl(u) {
  try { const url = new URL(u); if (url.protocol !== 'https:') return null;
    const h = url.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.internal') || h.endsWith('.local')) return null;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|::1|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return null;
    return url.toString();
  } catch (_) { return null; }
}
async function fetchMetaJson(u) { const safe = safeMetaUrl(u); if (!safe) return null; try { return await fetch(safe, { signal: AbortSignal.timeout(6000) }).then(r => r.json()); } catch (_) { return null; } }

// pot + prize vault always; wallet gas/RVLT balances when an address is given.
// This endpoint is unauthenticated and hit on a hot poll loop, and each live path does 2-5 on-chain eth_calls — so cache
// aggressively (red-team M3: RPC-cost amplifier / soft-DoS). Base (address-less) payload is shared for 8s; per-address balances
// are cached 8s per address; and a per-IP cap stops an attacker from rotating addresses to force unbounded live RPC.
const _csBase = { t: 0, out: null };
const _csAddr = new Map();   // ad -> { t, out }
const _csRl = new Map();     // ip -> [timestamps]
app.get('/api/onchain/chainstate', async (req, res) => {
  try {
    const ip = _clientIp(req); const now = Date.now();
    const hits = (_csRl.get(ip) || []).filter(t => now - t < 10000); hits.push(now); _csRl.set(ip, hits);
    if (_csRl.size > 5000) { for (const [k, v] of _csRl) if (!v.some(t => now - t < 10000)) _csRl.delete(k); }
    if (hits.length > 30) return res.status(429).json({ error: 'slow down' });
    let out;
    if (_csBase.out && now - _csBase.t < 8000) { out = { ..._csBase.out }; }
    else {
      const p = roProv(); const vault = new ethers.Contract(OC.vault, VAULT_READ_ABI, p);
      const [pot, veth] = await Promise.all([vault.potRvlt(), vault.vaultEth()]);
      out = { potRvlt: +ethers.formatUnits(pot, 18), vaultEth: +ethers.formatEther(veth) };
      // Live USD sitting INSIDE the vault (ETH prize + RVLT pot), from cached market prices — so "opening the vault" shows real money.
      try { const m = await market(); const ethUsd = num(m.ethUsd), rvltUsd = num(m.priceUsd);
        out.ethUsd = ethUsd; out.rvltUsd = rvltUsd; out.usdTotal = out.vaultEth * ethUsd + out.potRvlt * rvltUsd; } catch (_) {}
      _csBase.t = now; _csBase.out = { ...out };
    }
    const a = String(req.query.address || ''); if (ethers.isAddress(a)) { const ad = ethers.getAddress(a);
      const c = _csAddr.get(ad);
      if (c && now - c.t < 8000) { Object.assign(out, c.out); }
      else {
        const p = roProv();
        // balance + gas + ROBINVAULT allowance to the game vault — read on the SERVER's reliable FallbackProvider so the client
        // never has to eth_call through a flaky mobile wallet (which returns 0x for custom chains -> "could not decode result data").
        const rvltC = new ethers.Contract(OC.rvlt, ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'], p);
        const [b, g, al] = await Promise.all([rvltC.balanceOf(ad), p.getBalance(ad), rvltC.allowance(ad, OC.vault).catch(() => 0n)]);
        const addrOut = { tRvlt: +ethers.formatUnits(b, 18), ethGas: +ethers.formatEther(g), allowanceWei: al.toString(), address: ad };
        _csAddr.set(ad, { t: now, out: addrOut });
        if (_csAddr.size > 3000) { let ex = _csAddr.size - 3000; for (const k of _csAddr.keys()) { if (ex-- <= 0) break; _csAddr.delete(k); } }
        Object.assign(out, addrOut);
      }
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
});
// ── "Inside the vault" live value: the ROBINVAULT treasury / dev wallet on Robinhood MAINNET. Read on the mainnet chain
// regardless of the game's chain (read-only balance, no tx), so players always see the real money the vault holds. Cached 60s.
// RVLT is added to the total only once a mainnet RVLT token address is configured (RVLT_TREASURY_TOKEN) and it has a price. (Jake 2026-09-01)
const TREASURY = { addr: process.env.RVLT_TREASURY || '0xe8886fd4863855884d5f1fffa38f8c1c8502ec8c', rpc: process.env.RVLT_TREASURY_RPC || 'https://rpc.mainnet.chain.robinhood.com', chainId: 4663, rvlt: process.env.RVLT_TREASURY_TOKEN || '' };
let _mnProv = null; const mnProv = () => _mnProv || (_mnProv = new ethers.JsonRpcProvider(TREASURY.rpc, TREASURY.chainId));
let _treasCache = { at: 0, data: null };
app.get('/api/onchain/treasury', async (req, res) => {
  try {
    if (_treasCache.data && (Date.now() - _treasCache.at) < 60000) return res.json(_treasCache.data);   // 60s cache; no idle hammering of the mainnet RPC
    let eth = 0, rvlt = 0;
    try {
      const p = mnProv(), addr = ethers.getAddress(TREASURY.addr);
      eth = +ethers.formatEther(await p.getBalance(addr));
      if (TREASURY.rvlt && ethers.isAddress(TREASURY.rvlt)) { try { rvlt = +ethers.formatUnits(await new ethers.Contract(TREASURY.rvlt, BAL_ABI, p).balanceOf(addr), 18); } catch (_) {} }
    } catch (_) {}
    let ethUsd = 0, rvltUsd = 0; try { const m = await market(); ethUsd = num(m.ethUsd); rvltUsd = num(m.priceUsd); } catch (_) {}
    const usdTotal = eth * ethUsd + rvlt * rvltUsd;
    const data = { address: TREASURY.addr, eth, rvlt, ethUsd, rvltUsd, usdTotal, explorer: 'https://robin.etherscan.io/address/' + TREASURY.addr };
    _treasCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) { res.json({ usdTotal: 0, error: String(e && e.message || e) }); }
});
app.get('/api/onchain/robbers-state', async (req, res) => {
  try {
    if (!OC.robbers) return res.json({ error: 'not configured' });
    const c = new ethers.Contract(OC.robbers, RB_READ_ABI, roProv());
    const [minted, active, cur] = await Promise.all([c.totalMinted(), c.mintActive(), c.currentPrice().catch(() => null)]);
    let mine = 0; const a = String(req.query.address || ''); if (ethers.isAddress(a)) { try { mine = Number(await c.mintedBy(ethers.getAddress(a))); } catch (_) {} }
    const price = cur != null ? ethers.formatUnits(cur, 18) : String(OC.robbersPrice || '77777');
    res.json({ minted: Number(minted), supply: OC.robbersSupply || 777, max: OC.robbersMax || 3, active: !!active, mine, price: String(Math.round(Number(price))) });
  } catch (e) { res.json({ error: String(e && e.message || e) }); }
});
app.get('/api/onchain/robbers-gallery', async (req, res) => {
  try {
    if (!rateOk('gallery', req)) return res.json({ items: [] });   // this route fans out up to 30 sequential RPC calls — throttle it
    const a = String(req.query.address || ''); if (!OC.robbers || !ethers.isAddress(a)) return res.json({ items: [] });
    const addr = ethers.getAddress(a); const c = new ethers.Contract(OC.robbers, RB_READ_ABI, roProv());
    let ids = [];
    try { const logs = await c.queryFilter(c.filters.Transfer(null, addr), 0, 'latest'); ids = [...new Set(logs.map(l => l.args[2].toString()))]; }
    catch (e) { try { const tot = Number(await c.totalMinted()); for (let i = 1; i <= Math.min(tot, 120); i++) ids.push(String(i)); } catch (_) {} }
    const out = [];
    for (const id of ids.slice(0, 30)) {
      try {
        const o = await c.ownerOf(id); if (o.toLowerCase() !== addr.toLowerCase()) continue;
        const uri = await c.tokenURI(id); let img = '', nm = 'Vault Robber #' + id;
        if (uri.startsWith('data:application/json')) { const j = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString()); img = j.image || ''; nm = j.name || nm; }
        else { const j = await fetchMetaJson(uri); if (j) { img = j.image || ''; nm = j.name || nm; } }
        out.push({ id, name: nm, image: img });
      } catch (_) {}
    }
    out.sort((x, y) => Number(x.id) - Number(y.id));
    res.json({ items: out });
  } catch (e) { res.json({ items: [] }); }
});
app.get('/api/onchain/sac-address', async (req, res) => {
  try {
    const id = String(req.query.tokenId || ''); if (!OC.sacRegistry || !OC.sacImpl || !/^\d+$/.test(id)) return res.json({ error: 'bad request' });
    res.json({ addr: await sacAddr(id) });
  } catch (e) { res.json({ error: String(e && e.message || e) }); }
});
app.get('/api/onchain/sac-info', async (req, res) => {
  try {
    const id = String(req.query.tokenId || ''); if (!OC.sacRegistry || !OC.sacImpl || !/^\d+$/.test(id)) return res.json(null);
    const a = await sacAddr(id); const p = roProv();
    const [code, eth] = await Promise.all([p.getCode(a), p.getBalance(a)]);
    let rvlt = 0n; try { rvlt = await new ethers.Contract(OC.rvlt, BAL_ABI, p).balanceOf(a); } catch (_) {}
    res.json({ addr: a, created: !!(code && code !== '0x'), eth: +ethers.formatEther(eth), rvlt: +ethers.formatUnits(rvlt, 18) });
  } catch (e) { res.json(null); }
});

const API = process.env.DASHBOARD_BASE || `http://localhost:${process.env.DASHBOARD_PORT || 4000}`;
const TOKEN = process.env.DASHBOARD_TOKEN || '';
const GROUP = process.env.ARTIFACT_GROUP || 'main';
const AUTH = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

// ── RobinVault (RVLT) on Robinhood Chain ─────────────────────────────────────────────────────────────────────────────
const RVLT = '0x77061b45c5e4d440bd681b5f72bd0f4231a6fc04';
const PAIR = '0xcc31c5acf0db55d391a9d97171c6bcc549ec7974540e84dddaaf0cabd3384697';
const CREATOR_BPS = 70;   // creator earns 0.7% of every trade (0.7 of the 1.3% swap fee)

// ── Economy (authoritative; the client only mirrors this for display) ────────────────────────────────────────────────
// 10 chambers, success chance falling as you tunnel deeper toward the vault core (the keyhole). The house keeps a small
// edge on every step so the chamber pot — funded by other players' burned losses — never drains. The ETH jackpot is only
// reachable by cracking chamber 10, so it grows relentlessly and is almost never paid.
// L1-7 are fun and winnable (people cash out here); L8-10 (Cold Vault / Blast Chamber / The Core) are the near-impossible
// jackpot approach. With this curve a FLAWLESS player clears all 10 about 1 in 914,000 (≈ once over the game's ~1M-attempt
// life); an average player is ~1 in 284,000,000. Reward = (1-edge)/baseOdds stays fair at every step, so the deep chambers
// pay enormous fair multiples — the incentive to push into them is the ETH jackpot, not the chip reward.
// LOCKED on-chain economic model (2026-08-27): tuned so the core cracks ~1 per 153k plays (~35% of supply burned by then).
const P = [0.92, 0.78, 0.72, 0.48, 0.30, 0.15, 0.055, 0.020, 0.007, 0.0022];   // ch1-3 LOOSENED + ch4-5 ramp (Jake 2026-09-05, Option B): friendlier front (clear ch3 33%->52%, mint gate 18%->25%), jackpot rarity held (core rate 0.99x vs prev), first-cashout unchanged (~7.5%). Tail ch6-10 FROZEN. Prev curve: 0.85,0.64,0.60,0.56,0.41,...
const HOUSE_EDGE = 0.06;                                                    // legacy margin (informational; payouts now use %-of-pot)
const LEVELS = P.length;
// PAY-TO-PLAY (Jake): flat fee per attempt. Half BURNED forever (deflation), half into the shared pot.
let FEE = 1000;                                                            // entry fee (RVLT) — SYNCED from the on-chain vault fee() (contract is source of truth; ramp = one setFee call, no code change)
const BURN_SHARE = 0.5;                                                    // half the fee is burned, half into the pot
let CHIPS = FEE * (1 - BURN_SHARE);                                        // portion added to the pot per play
const JACKPOT_TAKE = 1.0;                                                  // core-robber claims 100% of the ETH vault; it rebuilds from creator fees each season
const CASHOUT_MIN = 5;                                                     // no cash-out until chamber 5 is cleared
// Keep FEE/CHIPS in lockstep with the on-chain vault fee() so the two never drift and a fee ramp needs no redeploy.
async function syncFee() {
  try {
    const c = new ethers.Contract(OC.vault, ['function fee() view returns (uint256)'], roProv());   // reuse cached provider (no churn)
    const f = Math.round(Number(ethers.formatUnits(await c.fee(), 18)));
    if (f > 0 && f !== FEE) { FEE = f; CHIPS = FEE * (1 - BURN_SHARE); console.log('[rtv] fee synced from chain:', FEE); }
  } catch (e) {}
}
syncFee(); setInterval(syncFee, 5 * 60 * 1000);
// %-OF-POT payout ladder: cashing out at stage k takes this share of the CURRENT pot. Self-solvent + self-capping.
const POT_LADDER = { 5: 0.01, 6: 0.03, 7: 0.10, 8: 0.20, 9: 0.30 };        // V2 ladder (Jake 2026-09-07): 1/3/10/20/30%. MUST match the on-chain potLadderBps (setLadder 100/300/1000/2000/3000, executed via Safe + verified on-chain 2026-09-07) so the displayed cashout offer equals what the contract pays. Core (10) via crackCore: choose 100% ETH OR 100% pot.
const potShareFor = (depth) => (depth >= LEVELS ? 1.0 : (POT_LADDER[depth] || 0));
// Doors = risk preference (variance), NOT free EV. Each door's base odds×reward holds the SAME house edge; Left is safer with a
// smaller multiple, Right is greedier with a bigger multiple. Skill (the mini-game score) then lifts your actual odds within a cap.
const DOORS = { left: { odds: 1.22, tier: 'cautious' }, center: { odds: 1.0, tier: 'standard' }, right: { odds: 0.72, tier: 'greedy' } };
const baseOdds = (lvl, door) => Math.min(0.97, P[lvl - 1] * ((DOORS[door] || DOORS.center).odds));   // pass-chance before skill
const stepReward = (lvl, door) => (1 - HOUSE_EDGE) / baseOdds(lvl, door);                            // reward multiple for clearing (holds the edge)
// The skill band WIDENS with depth: shallow chambers barely reward skill (+25%), the core is almost all skill (+100%). Base
// odds collapse faster, so the net stays brutal — but deep down, mastery is the only edge that exists.
// Deep-chamber taper (2026-09-03): halve the skill bonus on chambers 6-10 so an AI agent that aces the mini-games can't
// inflate the tail where the jackpot lives (skill still feels full on 1-5). Neutralises the bot-precision edge deep.
const skillBonusFor = (lvl) => { const b = 0.25 + ((lvl - 1) / (LEVELS - 1)) * 0.75; return lvl >= 6 ? b * 0.5 : b; };
const effOdds = (lvl, door, score) => Math.min(0.985, baseOdds(lvl, door) * (1 + Math.max(0, Math.min(1, score)) * skillBonusFor(lvl)));
// ── ODDS_V2 (skill-driven model, Jake 2026-09-04) ── SKILL doors only: chambers 1-5 are DETERMINISTIC (beat a rising skill bar
// -> advance, no roll); chambers 6-10 are a bot-proof gauntlet (skill sets the chance, roll decides). Nerve + Luck are UNCHANGED.
// Validated by sim: mint gate ~56%, cashout ~34%, perfect run reaches the final door ~1 in 45k and cracks the core ~1 in 1.12M
// (population ~1 in 7M). Default OFF so Monday launches on the frozen model; enabled per-artifact via RTV_ODDS_V2=on for dev tests.
const ODDS_V2 = process.env.RTV_ODDS_V2 === 'on';
// ch1-10 pass-to-advance skill bar. 1-5 unchanged from ODDS_V2; 6-10 ADDED for SKILL_V3 (rising toward near-perfect at the core).
const V2_SKILL_BAR = [0.10, 0.24, 0.40, 0.55, 0.68, 0.74, 0.80, 0.86, 0.91, 0.95];
const V2_GCEIL  = [0, 0, 0, 0, 0, 0.100, 0.080, 0.062, 0.045, 0.040];        // (legacy gauntlet, used only when SKILL_V3 is OFF) ch6-10 perfect-run advance chance
const V2_GFLOOR = [0, 0, 0, 0, 0, 0.045, 0.025, 0.015, 0.008, 0.005];        // (legacy) ch6-10 weak-run advance chance
const v2GauntletAdv = (lvl, score) => { const c = V2_GCEIL[lvl - 1], f = V2_GFLOOR[lvl - 1]; return f + Math.max(0, Math.min(1, score)) * (c - f); };
// SKILL_V3 (Jake 2026-09-07): SKILL DECIDES chambers 6-9 deterministically (beat the harder, faster bar -> advance, no roll), so
// "I scored 88% and still lost" can't happen on the way down. The mini-games get much faster/tougher with depth (buildChallenge),
// so the deep tail stays rare by DIFFICULTY not luck. The CORE (ch10, full ETH jackpot) keeps ONE rarity roll on top of skill so a
// hot run / timing bot can't drain the vault in a single crack. Behind a flag so production (start-prod.js) is untouched until we
// deliberately promote; enable per-site via RTV_SKILL_V3=on. Nerve + Luck are unchanged.
const SKILL_V3 = process.env.RTV_SKILL_V3 === 'on';
const EXTRA_MINT_SPOTS = process.env.RTV_MINT_SPOTS === 'on';   // extra hidden Vault Robbers dealers in chambers 3 & 4 (Jake 2026-09-07); flag-gated so prod is untouched until promote
const CORE_CHOICE = process.env.RTV_CORE_V2 === 'on';   // V2 core: winner CHOOSES ETH-or-pot via crackCore(). ONLY enable once the RobbingTheVaultV2 upgrade is live on-chain, else the client would call a function the contract lacks.
const CORE_CRACK_ODDS = 0.12;   // ch10 ONLY: after beating the skill bar, this provably-fair roll gates the jackpot (protects ~4.8 ETH)
// Reported advance chance for the client/metadata under whichever model is live (so the odds shown match what actually decides).
const advChance = (kind, lvl, door, score) => {
  if (SKILL_V3 && kind === 'skill') { if (!(score > 0) || score < V2_SKILL_BAR[lvl - 1]) return 0; return lvl >= LEVELS ? CORE_CRACK_ODDS : 1; }
  if (ODDS_V2 && kind === 'skill') { if (!(score > 0)) return 0; return lvl <= 5 ? (score >= V2_SKILL_BAR[lvl - 1] ? 1 : 0) : v2GauntletAdv(lvl, score); }
  return effOdds(lvl, door, score);
};
const difficultyFor = (lvl) => (lvl - 1) / (LEVELS - 1);                                              // 0 (lobby) .. 1 (core)
// Three CATEGORIES: Luck (fate, no skill channel), Skill (execution → score), Nerve (judgment / push-your-luck → score).
// Skill + Nerve both modulate the odds within the band; Luck does not. Every chamber presents ONE of each, on SHUFFLED
// positions (deterministically from the seed), so the category is never fixed to a side and can't be pattern-learned.
// 15 per category (Jake 2026-08-31). Trimmed the near-duplicates: dropped quickdraw(=reflex), lockpins(=lasers), catch(=targets),
// gripandpry(=torque), drilldepth(=mash) from Skill; safepick(bland fallback, still the renderer default), colorbet, cookie, drawstraw, capsule from Luck.
const SKILL_GAMES = ['dial', 'lasers', 'sequence', 'reflex', 'wirecut', 'targets', 'stopwatch', 'mash', 'silentalarm', 'tumbler', 'torque', 'sonicrack', 'pressureplates', 'dialcombo', 'hotwire'];
const LUCK_GAMES = ['wheel', 'dice', 'cardflip', 'coinflip', 'slots', 'roulette', 'shells', 'scratch', 'plinko', 'keno', 'goldbar', 'magnetgrab', 'fuserace', 'elevatorroulette', 'safedial'];
// NERVE = push-your-luck on a shared VISIBLE-RISK engine. 8 climb (discrete steps, one hidden rigged step, honest 1-in-N odds shown) + 7 gauge
// (continuous hold, a SHOWN danger line + live bust %). The old hidden-band games (tightrope/coolant/balancescale/rappel/surge) were retired
// because a band you cannot see is luck wearing a skill costume. Scoring math is unchanged, so the frozen odds curve is untouched.
const NERVE_GAMES = ['ladder', 'cascadelocks', 'vaultstack', 'dominoes', 'ziplinebail', 'minefield', 'defuse', 'heisttimer', 'crank', 'dive', 'thermite', 'staticcharge', 'crackdrill', 'nitro', 'guardsweep'];
const POOL = { luck: LUCK_GAMES, skill: SKILL_GAMES, nerve: NERVE_GAMES };
// Deterministic Fisher-Yates of the three categories onto [left, center, right] for a given chamber.
function chamberCategories(seed, level) {
  // Random door COMPOSITION (Jake 2026-09-04): each door independently rolls its kind from the committed seed, so a room can be
  // any mix — 1/1/1, 2+1, or 3 of a kind (adds variety + modest anti-farm since a Skill door isn't guaranteed every room). Tiers
  // (left/center/right = cautious/standard/greedy reward) are unchanged; only the luck/skill/nerve kind varies. Provably fair.
  const kinds = ['luck', 'skill', 'nerve'], b = _hb(seed, 'cat:' + level);
  const pick = (i) => kinds[Math.floor(_u(b, i) * 3) % 3];
  return { left: pick(0), center: pick(1), right: pick(2) };
}
// The three doors for a chamber: category (shuffled) + positional risk tier (Left cautious … Right greedy) + odds/reward.
function doorsLayout(seed, level) {
  const cat = chamberCategories(seed, level), out = {};
  for (const side of ['left', 'center', 'right']) out[side] = { category: cat[side], tier: (DOORS[side] || {}).tier, odds: baseOdds(level, side), reward: stepReward(level, side) };
  return out;
}

const num = v => (typeof v === 'number' ? v : parseFloat(v)) || 0;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ── Dashboard DB helpers (server-side only) ──────────────────────────────────────────────────────────────────────────
const _timeout = () => { try { return AbortSignal.timeout(8000); } catch (e) { return undefined; } };
// READS are idempotent, so retry transient failures. WRITES are NOT retried (a lost response could double-apply an increment).
async function dbQuery(sql, params) {
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      const u = new URL(`${API}/api/db/${GROUP}/database/query`);
      u.searchParams.set('sql', sql);
      if (params) u.searchParams.set('params', JSON.stringify(params));
      const r = await fetch(u, { headers: AUTH, signal: _timeout() });
      if (!r.ok) throw new Error('dbQuery ' + r.status);
      const j = await r.json();
      return j.rows || j.result || [];
    } catch (e) { err = e; await new Promise(res => setTimeout(res, 120 * (i + 1))); }
  }
  throw err;
}
async function dbExec(sql, params) {
  const r = await fetch(`${API}/api/db/${GROUP}/database/execute`, { method: 'POST', headers: AUTH, body: JSON.stringify({ sql, params: params || [] }), signal: _timeout() });
  if (!r.ok) throw new Error('dbExec ' + r.status + ' ' + (await r.text().catch(() => '')));
  return r.json().catch(() => ({}));
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS rtv_state (id TEXT PRIMARY KEY, jackpot_eth REAL DEFAULT 0, pot_rvlt REAL DEFAULT 0, burned_rvlt REAL DEFAULT 0, plays INTEGER DEFAULT 0, robs INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS rtv_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, player TEXT, stake REAL, depth INTEGER, outcome TEXT, won_rvlt REAL DEFAULT 0, burned_rvlt REAL DEFAULT 0, robbed_eth REAL DEFAULT 0, net INTEGER DEFAULT 46630, server_seed TEXT, server_hash TEXT, client_seed TEXT, ts TEXT DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS rtv_seeds (run_id TEXT PRIMARY KEY, player TEXT, stake REAL, server_seed TEXT, server_hash TEXT, client_seed TEXT, nonce INTEGER DEFAULT 0, depth INTEGER DEFAULT 0, mult REAL DEFAULT 1, status TEXT DEFAULT 'open', paid INTEGER DEFAULT 0, cur_door TEXT, cur_started INTEGER, net INTEGER DEFAULT 46630, ts TEXT DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS rtv_door_picks (kind TEXT, net INTEGER DEFAULT 46630, n INTEGER DEFAULT 0, PRIMARY KEY (kind, net))",   // cumulative door-category preference (luck / skill / nerve), PER NETWORK
  "CREATE TABLE IF NOT EXISTS rtv_visits (id TEXT, device TEXT, net INTEGER DEFAULT 46630, ts TEXT DEFAULT (datetime('now')), PRIMARY KEY (id, net))",   // unique visitors + device (mobile/desktop), PER NETWORK (a returning visitor gets one row per net)
  "CREATE TABLE IF NOT EXISTS rtv_arcade_pass (wallet TEXT, tx TEXT, net INTEGER DEFAULT 46630, fee_paid INTEGER, paid_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (wallet, net))",   // one-time practice-arcade unlock, per wallet PER NETWORK. GRANDFATHERED: the pass is existence-based — once a wallet has a row it is unlocked FOREVER, regardless of any future price rise. fee_paid records what they paid (audit / future tiers).
];
async function ensureSchema() { for (const s of SCHEMA) { try { await dbExec(s); } catch (e) { if(!/\b40[13]\b|not allowed|Schema modif/i.test(e.message||'')) console.error('[rtv] schema', e.message); } }   // schema mods are blocked via the API by design (tables come from the package.json manifest / agent tools); only log genuine, unexpected errors try { await dbExec("ALTER TABLE rtv_seeds ADD COLUMN mult REAL DEFAULT 1"); } catch (e) {} try { await dbExec("ALTER TABLE rtv_seeds ADD COLUMN paid INTEGER DEFAULT 0"); } catch (e) {} try { await dbExec("ALTER TABLE rtv_seeds ADD COLUMN cur_door TEXT"); } catch (e) {} try { await dbExec("ALTER TABLE rtv_seeds ADD COLUMN cur_started INTEGER"); } catch (e) {}   // active door + start time, so /api/crack can rebuild the deterministic challenge after a restart
  // net-scope migrations (existing rows predate mainnet → tag them testnet 46630). rtv_runs takes a plain column; the
  // arcade pass needs a composite (wallet,net) PK, so rebuild it once if it's still on the old wallet-only PK.
  try { await dbExec("ALTER TABLE rtv_runs ADD COLUMN net INTEGER DEFAULT 46630"); } catch (e) {}
  try {
    const pk = (await dbQuery("SELECT COUNT(*) c FROM pragma_table_info('rtv_arcade_pass') WHERE pk>0").catch(() => []))[0];
    if (pk && Number(pk.c) < 2) {
      await dbExec("CREATE TABLE IF NOT EXISTS rtv_arcade_pass_v2 (wallet TEXT, tx TEXT, net INTEGER DEFAULT 46630, paid_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (wallet, net))");
      await dbExec("INSERT OR IGNORE INTO rtv_arcade_pass_v2 (wallet,tx,net,paid_at) SELECT wallet, tx, 46630, paid_at FROM rtv_arcade_pass");
      await dbExec("DROP TABLE rtv_arcade_pass");
      await dbExec("ALTER TABLE rtv_arcade_pass_v2 RENAME TO rtv_arcade_pass");
    }
  } catch (e) { console.error('[rtv] arcade_pass migrate', e.message); }
  try { await dbExec("ALTER TABLE rtv_arcade_pass ADD COLUMN fee_paid INTEGER"); } catch (e) {}   // record what each holder paid (grandfathering stays existence-based); no-op if the column already exists
  // net-scope door picks + visits (existing aggregate/rows predate the net split → tag testnet 46630). Door picks moves from
  // a (kind) PK to a (kind, net) PK so mainnet and testnet counters are independent; visits gets a plain net column. These
  // schema mods are blocked via the API, so they only take on machines where an agent ran the migration (see db_execute run).
  try {
    const pk = (await dbQuery("SELECT COUNT(*) c FROM pragma_table_info('rtv_door_picks') WHERE pk>0").catch(() => []))[0];
    if (pk && Number(pk.c) < 2) {
      await dbExec("CREATE TABLE IF NOT EXISTS rtv_door_picks_v2 (kind TEXT, net INTEGER DEFAULT 46630, n INTEGER DEFAULT 0, PRIMARY KEY (kind, net))");
      await dbExec("INSERT OR IGNORE INTO rtv_door_picks_v2 (kind,net,n) SELECT kind, 46630, n FROM rtv_door_picks");
      await dbExec("DROP TABLE rtv_door_picks");
      await dbExec("ALTER TABLE rtv_door_picks_v2 RENAME TO rtv_door_picks");
    }
  } catch (e) { console.error('[rtv] door_picks migrate', e.message); }
  try { await dbExec("ALTER TABLE rtv_visits ADD COLUMN net INTEGER DEFAULT 46630"); } catch (e) {}
  for (const k of ['luck', 'skill', 'nerve']) { try { await dbExec("INSERT OR IGNORE INTO rtv_door_picks (kind,net,n) VALUES (?,?,0)", [k, OC.chainId]); } catch (e) {} } }   // seed this network's 3 category counters so a plain UPDATE can increment
async function getState() {
  let row = (await dbQuery("SELECT * FROM rtv_state WHERE id='main'").catch(() => []))[0];
  if (!row) { await dbExec("INSERT OR IGNORE INTO rtv_state (id,jackpot_eth,pot_rvlt,burned_rvlt,plays,robs) VALUES ('main',?,?,0,0,0)", [JACKPOT_SEED_ETH, POT_SEED_RVLT]).catch(() => {}); row = { id: 'main', jackpot_eth: JACKPOT_SEED_ETH, pot_rvlt: POT_SEED_RVLT, burned_rvlt: 0, plays: 0, robs: 0 }; }
  return row;
}
// Atomic: the arithmetic happens IN the single SQL statement, so concurrent cash-outs / a core crack can't
// read-modify-write over each other (the old read-then-write in JS had a race that could double-spend the pot).
async function bumpState(d) {
  await getState();   // idempotent: ensures the 'main' row exists
  await dbExec("UPDATE rtv_state SET jackpot_eth=MAX(0,jackpot_eth+?), pot_rvlt=MAX(0,pot_rvlt+?), burned_rvlt=burned_rvlt+?, plays=plays+?, robs=robs+?, updated_at=datetime('now') WHERE id='main'",
    [d.jackpot_eth || 0, d.pot_rvlt || 0, d.burned_rvlt || 0, d.plays || 0, d.robs || 0]).catch(() => {});
  return d;
}

// ── Live market data (DexScreener; cached) ───────────────────────────────────────────────────────────────────────────
let _mkt = { t: 0, v: null };
async function market() {
  if (_mkt.v && Date.now() - _mkt.t < 30000) return _mkt.v;
  let out = { priceUsd: 0, fdvUsd: 0, liquidityUsd: 0, volume24hUsd: 0, buys24h: 0, sells24h: 0, ethUsd: 0 };
  try {
    const j = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${RVLT}`, { headers: { accept: 'application/json' } }).then(r => r.json());
    const p = (j.pairs || []).find(x => (x.pairAddress || '').toLowerCase() === PAIR.toLowerCase()) || (j.pairs || [])[0];
    if (p) { out.priceUsd = num(p.priceUsd); out.fdvUsd = num(p.fdv); out.liquidityUsd = num(p.liquidity && p.liquidity.usd); out.volume24hUsd = num(p.volume && p.volume.h24); out.buys24h = num(p.txns && p.txns.h24 && p.txns.h24.buys); out.sells24h = num(p.txns && p.txns.h24 && p.txns.h24.sells); }
  } catch (e) {}
  try { const e = await fetch('https://api.dexscreener.com/latest/dex/tokens/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', { headers: { accept: 'application/json' } }).then(r => r.json()); const wp = (e.pairs || []).find(x => num(x.priceUsd) > 100); if (wp) out.ethUsd = num(wp.priceUsd); } catch (e) {}
  if (!out.ethUsd) out.ethUsd = 2750;
  out.creatorFeeUsdPerDay = out.volume24hUsd * (CREATOR_BPS / 10000);   // the jackpot's real-world fuel rate
  out.creatorFeeEthPerDay = out.ethUsd ? out.creatorFeeUsdPerDay / out.ethUsd : 0;
  _mkt = { t: Date.now(), v: out };
  return out;
}

// Contract-truth vault read (Jake 2026-09-07): the jackpot + pot displayed must come STRAIGHT from the smart contract
// (vaultEth() / potRvlt()), not the DB mirror, so the lobby shows the real prize even before a wallet connects. The dev
// wallet is intentionally separate and never folded in. 30s cache so /api/state doesn't hammer the RPC.
let _cvault = { t: 0, v: null };
async function chainVault() {
  if (_cvault.v && Date.now() - _cvault.t < 30000) return _cvault.v;
  try {
    const vault = new ethers.Contract(OC.vault, VAULT_READ_ABI, roProv());
    const [pot, veth] = await Promise.all([vault.potRvlt(), vault.vaultEth()]);
    _cvault = { t: Date.now(), v: { potRvlt: +ethers.formatUnits(pot, 18), vaultEth: +ethers.formatEther(veth) } };
  } catch (e) { /* keep last-known-good; /api/state falls back to the DB mirror */ }
  return _cvault.v;
}

// Seed the shared ledger with meaningful starting values so the world feels alive on first boot.
const JACKPOT_SEED_ETH = 3.2;      // simulated creator-fee ETH already in the core
const POT_SEED_RVLT = 250000;      // simulated RVLT already in the chamber pot

// ── Live jackpot accrual: the core fills continuously at the real creator-fee rate (0.7% of live volume, in ETH). ───────
let _jackAccrual = 0;   // ETH accrued since last DB flush
let _accrualPerSec = 0, _accrualLast = Date.now();
setInterval(async () => {
  const now = Date.now(); const dt = (now - _accrualLast) / 1000; _accrualLast = now;
  // Only refresh the rate from the price API while someone's around (market() is 30s-cached, so this is the only external
  // egress here). When idle we keep accruing at the last known rate — no API call, no Zerion-style idle bleed.
  if (_viewedRecently()) { try { const m = await market(); _accrualPerSec = (m.creatorFeeEthPerDay || 0) / 86400; } catch (e) {} }
  _jackAccrual += _accrualPerSec * dt;   // accrue by REAL elapsed time, so the gated/slower loop still totals correctly
}, 5000);
setInterval(async () => { if (_jackAccrual > 0) { const add = _jackAccrual; _jackAccrual = 0; await bumpState({ jackpot_eth: add }).catch(() => { _jackAccrual += add; }); } }, 30000);

// ── Provably-fair chamber outcome ────────────────────────────────────────────────────────────────────────────────────
// r = HMAC-SHA256(serverSeed, clientSeed:nonce) → [0,1). The player clears chamber `level` (1-based) iff r < P[level-1].
// serverHash = SHA256(serverSeed) is committed at entry; serverSeed is revealed when the run ends, so any outcome is auditable.
function roll(serverSeed, clientSeed, nonce) {
  const h = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
  return parseInt(h.slice(0, 13), 16) / 0x10000000000000;   // 52 bits → [0,1)
}

// ── Server-authoritative mini-games ──────────────────────────────────────────────────────────────────────────────────
// The browser is hostile: it never computes the score. The SERVER generates the challenge (deterministically, from the
// committed seed, so it stays provably fair) and the client streams raw timestamped input events; the server replays them
// against the challenge and scores. A bot can no longer POST "I won" — only "here is what I did". On top of the score the
// server judges HUMANNESS from the input timing (superhuman speed / robotic consistency) and shadow-voids the skill bonus
// for non-human patterns, plus a hard minimum-duration gate and a per-player rate limit. All anti-automation, all server-side.
const _hb = (seed, tag) => crypto.createHmac('sha256', seed).update(tag).digest();
const _u = (buf, i) => buf.readUInt32BE((i % 8) * 4) / 0xffffffff;    // deterministic unit float from the digest (uses all 8 words)
function gameForDoor(seed, level, door) {
  const kind = chamberCategories(seed, level)[door] || 'skill';   // category is shuffled per chamber
  const pool = POOL[kind] || SKILL_GAMES;
  const b = _hb(seed, `game:${level}:${door}`);
  const key = pool[Math.floor(_u(b, 0) * pool.length) % pool.length];
  return { kind, gameKey: key };
}
function buildChallenge(gameKey, level, door, seed) {
  const d = difficultyFor(level), b = _hb(seed, `ch:${level}:${door}`);
  // SKILL_V3 (Jake 2026-09-07): deep chambers get MUCH faster/tougher so skill (not luck) gates the tail. `dd` adds an eased deep
  // ramp ON TOP of the base `d` curve — near 0 early (onboarding stays gentle) and steep toward the core. When SKILL_V3 is OFF
  // (production today) dd=0, so difficulty is byte-for-byte unchanged. Only SKILL doors accelerate; Nerve/Luck are untouched.
  const dd = SKILL_V3 ? Math.pow(d, 1.35) : 0;
  if (gameKey === 'dial') return { speed: 0.9 + d * 2.1 + dd * 1.5, arcW: 0.9 - d * 0.6 - dd * 0.26, target: _u(b, 0) * Math.PI * 2, start: _u(b, 1) * Math.PI * 2, minMs: 900 };
  if (gameKey === 'lasers' || gameKey === 'sonicrack' || gameKey === 'dialcombo' || gameKey === 'hotwire') { const rounds = Math.round(2 + d * 3 + dd * 1), gaps = []; for (let k = 0; k < rounds; k++) gaps.push({ pos: 0.12 + _u(b, k) * 0.76, w: 0.34 - d * 0.15 - dd * 0.12 }); return { rounds, speed: 1.1 + d * 1.9 + dd * 1.3, gaps, minMs: 500 + rounds * 380 }; }
  if (gameKey === 'sequence') { const len = Math.round(3 + d * 5 + dd * 1), pads = 9, seq = []; for (let k = 0; k < len; k++) seq.push(Math.floor(_u(b, k) * pads) % pads); return { seq, pads, flashMs: Math.round(600 - d * 230 - dd * 140), minMs: 500 + len * 280 }; }
  // reflex (SKILL): a red light turns green after a hidden delay; tap as fast as you can once it does — jumping early = 0.
  if (gameKey === 'reflex' || gameKey === 'quickdraw' || gameKey === 'silentalarm') return { greenAt: Math.round(700 + _u(b, 0) * 1600), window: 700 - d * 230 - dd * 170, minMs: 400 };
  if (gameKey === 'wirecut') { const c = 0.42 + _u(b, 0) * 0.36; const hw = 0.15 - d * 0.07 - dd * 0.05; return { travelMs: Math.round(2600 - d * 1100 - dd * 700), bandLo: c - hw, bandHi: c + hw, minMs: 500 }; }   // SKILL (timing): cut the fuse as the spark crosses the VISIBLE safe zone; band shrinks + spark speeds up with depth
  if (gameKey === 'targets' || gameKey === 'catch' || gameKey === 'pressureplates') return { n: Math.round(4 + d * 6 + dd * 2), span: Math.round(4200 - d * 1700 - dd * 900), minMs: 800 };   // tap all targets before time
  if (gameKey === 'lasers' || gameKey === 'lockpins') { const rounds = Math.round(2 + d * 3 + dd * 1), gaps = []; for (let k = 0; k < rounds; k++) gaps.push({ pos: 0.12 + _u(b, k) * 0.76, w: 0.34 - d * 0.15 - dd * 0.12 }); return { rounds, speed: 1.1 + d * 1.9 + dd * 1.3, gaps, minMs: 500 + rounds * 380 }; }
  if (gameKey === 'stopwatch' || gameKey === 'tumbler') return { target: Math.round(1400 + _u(b, 0) * 2200), tol: Math.round(760 - d * 360 - dd * 230), minMs: 500 };   // stop the timer on the mark
  if (gameKey === 'mash' || gameKey === 'drilldepth') return { need: Math.round(9 + d * 15 + dd * 6), win: Math.round(3200 - d * 1000 - dd * 700), minMs: 700 };   // rapid taps to fill the bar
  // holddrill / crank / pressure / overload / dive (NERVE): push over `maxMs`; a HIDDEN danger line from the seed. Stop under it.
  if (gameKey === 'holddrill' || gameKey === 'crank' || gameKey === 'pressure' || gameKey === 'overload' || gameKey === 'dive' || gameKey === 'thermite' || gameKey === 'staticcharge' || gameKey === 'crackdrill' || gameKey === 'nitro' || gameKey === 'guardsweep') return { maxMs: Math.round(3000 - d * 1400), danger: 0.5 + _u(b, 0) * (0.45 - d * 0.1), warn: 0.5, minMs: 500 };   // warn = the VISIBLE start of the danger zone (safe below it); the exact `danger` line stays hidden (stripped in sanitizeParams). Since danger's floor is 0.5, showing 0.5 is honest.
  if (gameKey === 'ladder' || gameKey === 'minefield' || gameKey === 'cascadelocks' || gameKey === 'ziplinebail' || gameKey === 'defuse' || gameKey === 'vaultstack' || gameKey === 'heisttimer' || gameKey === 'dominoes') { const rungs = Math.round(5 + d * 5); return { rungs, fail: 1 + Math.floor(_u(b, 0) * rungs), minMs: 500 }; }   // step across; a hidden one is trapped
  if (gameKey === 'tightrope' || gameKey === 'torque' || gameKey === 'coolant' || gameKey === 'balancescale' || gameKey === 'gripandpry' || gameKey === 'rappel' || gameKey === 'surge') { const c = 0.35 + _u(b, 0) * 0.4, hw = 0.15 - d * 0.06 - dd * 0.05; return { maxMs: Math.round(2800 - d * 1100 - dd * 750), lo: c - hw, hi: c + hw, minMs: 500 }; }   // stop inside a safe band; SKILL_V3 speeds the sweep + shrinks the band with depth
  // luck games — pure theatre over the provably-fair roll (scoreEvents returns null)
  if (gameKey === 'wheel') return { segments: 8, minMs: 900 };
  if (gameKey === 'dice') return { minMs: 800 };
  if (gameKey === 'cardflip') return { cards: 3, minMs: 700 };
  if (gameKey === 'coinflip') return { minMs: 700 };
  if (gameKey === 'slots') return { reels: 3, minMs: 900 };
  if (gameKey === 'roulette') return { minMs: 1000 };
  if (gameKey === 'shells') return { cups: 3, minMs: 800 };
  if (gameKey === 'scratch') return { cells: 6, minMs: 700 };
  if (gameKey === 'plinko') return { rows: 8, minMs: 1100 };
  if (gameKey === 'keno') return { cells: 9, minMs: 800 };
  if (gameKey === 'colorbet') return { minMs: 700 };
  if (gameKey === 'goldbar') return { bars: 5, minMs: 800 };
  if (gameKey === 'cookie') return { minMs: 700 };
  if (gameKey === 'drawstraw') return { straws: 5, minMs: 700 };
  return { options: 3, minMs: 700 };   // safepick (luck)
}
// Replay the streamed events against the challenge → raw skill score in [0,1]. Luck games return null (no skill channel).
function scoreEvents(gameKey, ch, events) {
  const taps = (events || []).filter(e => e && Number.isFinite(e.t));   // drop non-finite timestamps (t:NaN/Infinity) at the source so no game can ever score NaN
  if (gameKey === 'dial') { const lock = taps.find(e => e.type === 'lock'); if (!lock) return 0; const a = (ch.start + ch.speed * (lock.t / 1000)) % (Math.PI * 2); let dd = Math.abs(((a - ch.target + Math.PI * 3) % (Math.PI * 2)) - Math.PI); return clamp(1 - dd / (ch.arcW * 2.2), 0, 1); }
  if (gameKey === 'lasers' || gameKey === 'lockpins' || gameKey === 'sonicrack' || gameKey === 'dialcombo' || gameKey === 'hotwire') { const hits = taps.filter(e => e.type === 'tap'); if (hits.length < ch.rounds) return 0;   // MUST clear every round — a missed/skipped round = loss
    let s = 0; for (let k = 0; k < ch.rounds; k++) { const e = hits[k]; if (!e) return 0; const m = Math.abs(((ch.speed * (e.t / 1000)) % 2) - 1); const g = ch.gaps[k]; const rs = clamp(1 - Math.abs(m - g.pos) / (g.w * 0.9), 0, 1); if (rs <= 0) return 0; s += rs; } return clamp(s / ch.rounds, 0, 1); }
  if (gameKey === 'sequence') { const picks = taps.filter(e => e.type === 'pad'); let correct = 0; for (let k = 0; k < ch.seq.length; k++) { if (picks[k] && picks[k].idx === ch.seq[k]) correct++; else break; } return correct >= ch.seq.length ? 1 : 0; }   // MUST complete the full sequence — a partial run = loss
  if (gameKey === 'holddrill' || gameKey === 'crank' || gameKey === 'pressure' || gameKey === 'overload' || gameKey === 'dive' || gameKey === 'thermite' || gameKey === 'staticcharge' || gameKey === 'crackdrill' || gameKey === 'nitro' || gameKey === 'guardsweep') { const stop = taps.find(e => e.type === 'stop'); if (!stop) return 0; const f = clamp(stop.t / ch.maxMs, 0, 1); return f <= ch.danger ? clamp(f / ch.danger, 0, 1) : 0; }   // nerve: closer under the hidden line = higher; overshoot = 0
  if (gameKey === 'reflex' || gameKey === 'quickdraw' || gameKey === 'silentalarm') { const tap = taps.find(e => e.type === 'tap'); if (!tap) return 0; if (tap.t < ch.greenAt) return 0; return clamp(1 - (tap.t - ch.greenAt) / ch.window, 0, 1); }   // faster reaction after green = higher; jumping early = 0
  if (gameKey === 'wirecut') { const c = taps.find(e => e.type === 'cut'); if (!c) return 0; const f = c.t / ch.travelMs; if (f < ch.bandLo || f > ch.bandHi) return 0; const mid = (ch.bandLo + ch.bandHi) / 2, hw = (ch.bandHi - ch.bandLo) / 2; return clamp(1 - Math.abs(f - mid) / hw, 0, 1); }   // timing: score by how centred the cut landed in the safe zone
  if (gameKey === 'targets' || gameKey === 'catch' || gameKey === 'pressureplates') { const n = taps.filter(e => e.type === 'tap').length; return n >= ch.n ? 1 : 0; }   // MUST get them all — missing any = loss
  if (gameKey === 'stopwatch' || gameKey === 'tumbler') { const s = taps.find(e => e.type === 'stop'); if (!s) return 0; return clamp(1 - Math.abs(s.t - ch.target) / ch.tol, 0, 1); }   // closeness to the mark
  if (gameKey === 'mash' || gameKey === 'drilldepth') { const n = taps.filter(e => e.type === 'tap').length; return n >= ch.need ? 1 : 0; }   // MUST reach the target count — anything short = loss (no partial credit / no timeout gimme)
  if (gameKey === 'ladder' || gameKey === 'minefield' || gameKey === 'cascadelocks' || gameKey === 'ziplinebail' || gameKey === 'defuse' || gameKey === 'vaultstack' || gameKey === 'heisttimer' || gameKey === 'dominoes') { const c = Math.min(taps.filter(e => e.type === 'climb').length, ch.rungs); return c < ch.fail ? clamp(c / ch.rungs, 0, 1) : 0; }   // stepped under the trapped tile = higher; hit it = 0
  if (gameKey === 'tightrope' || gameKey === 'torque' || gameKey === 'coolant' || gameKey === 'balancescale' || gameKey === 'gripandpry' || gameKey === 'rappel' || gameKey === 'surge') { const s = taps.find(e => e.type === 'stop'); if (!s) return 0; const f = clamp(s.t / ch.maxMs, 0, 1); return (f >= ch.lo && f <= ch.hi) ? clamp(1 - Math.abs(f - (ch.lo + ch.hi) / 2) / (((ch.hi - ch.lo) / 2) || 1), 0, 1) : 0; }   // stop inside the hidden band; centre = best
  return null;   // luck games — the roll decides
}
// Strip the HIDDEN answers from the challenge before it goes to the browser. These fields are invisible to the player by
// design (a hidden danger line, the trapped rung, the safe wire) yet were being handed to the client — letting a script
// read the JSON and play every nerve/wire game perfectly. Render params (speed, gaps, target arcs the player can SEE) stay.
// The full ch (with answers) is kept server-side in _active, so scoring is unaffected.
function sanitizeParams(gameKey, ch) {
  const c = { ...ch };
  delete c.danger;   // nerve gauges (holddrill family): the hidden burst line
  delete c.fail;     // ladder/climb family: the trapped rung/tile
  if (gameKey !== 'torque') { delete c.lo; delete c.hi; }   // torque SHOWS its sweet-spot band on purpose (real skill — hit the visible green); retired hidden-band games stay stripped
  // wirecut is now a VISIBLE-band timing skill (bandLo/bandHi are shown on purpose) — no hidden answer to strip
  if (gameKey === 'sequence') { c.seqLen = (ch.seq || []).length; delete c.seq; }   // never ship the full sequence; the client fetches each pad, time-gated, via /api/mini/step
  return c;
}
// Humanness in [0,1] from input timing. Superhuman reaction (<70ms between actions) or robotic consistency (near-zero
// variance) drags it down. Below the gate we void the skill bonus (shadow) rather than error, so bots waste their runs.
function humanScore(events) {
  const ts = (events || []).filter(e => e && typeof e.t === 'number' && (e.type === 'tap' || e.type === 'pad' || e.type === 'lock' || e.type === 'pick' || e.type === 'climb')).map(e => e.t).sort((a, b) => a - b);
  if (ts.length < 2) return 1;   // single-action games can't be timing-profiled; the minMs gate covers them
  const iv = []; for (let i = 1; i < ts.length; i++) iv.push(ts[i] - ts[i - 1]);
  let h = 1;
  if (iv.some(x => x < 70)) h -= 0.5;                                                  // superhuman cadence
  if (iv.length >= 3) { const mean = iv.reduce((a, b) => a + b, 0) / iv.length, varc = iv.reduce((a, b) => a + (b - mean) ** 2, 0) / iv.length, cv = mean > 0 ? Math.sqrt(varc) / mean : 0; if (cv < 0.06) h -= 0.4; }   // robotic evenness
  return clamp(h, 0, 1);
}

// ── Bot-review metadata (Jake 2026-09-04) ── Log every skill/nerve resolution + cash-out with its anti-cheat signals so week-1
// bot activity is analyzable (we're seeding 2M and observing before deciding on the contract-cap upgrade). Privacy: IP/UA are
// stored only as short salted hashes. Best-effort + non-blocking so it can never affect gameplay. Table: rtv_bot_signals.
function _hsh(s) { try { return crypto.createHash('sha256').update('rtv:' + String(s || '')).digest('hex').slice(0, 16); } catch (e) { return ''; } }
// Trusted client IP = the RIGHTMOST XFF hop (appended by our proxy); a spoofed XFF prepends fakes on the LEFT. Same logic as
// rateOk, so the bot-review IP hash + Turnstile remoteip can't be poisoned by a client-supplied header (audit 2026-09-04).
function _clientIp(req) { try { const xff = String((req && req.headers && req.headers['x-forwarded-for']) || ''); return (xff ? xff.split(',').pop().trim() : '') || (req && req.socket && req.socket.remoteAddress) || ''; } catch (e) { return ''; } }
function _reqFP(req) { try { return { ip: _hsh(_clientIp(req)), ua: _hsh((req.headers && req.headers['user-agent']) || '') }; } catch (e) { return { ip: '', ua: '' }; } }
function logBotSignal(o) { try { dbExec("INSERT INTO rtv_bot_signals (player,run_id,net,level,kind,game_key,score,human,flagged,flag_reason,elapsed_ms,min_ms,ip_hash,ua_hash,event) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [o.player || '', o.run || '', OC.chainId || 0, o.level || 0, o.kind || '', o.gameKey || '', (o.score == null ? null : o.score), (o.human == null ? null : o.human), o.flagged ? 1 : 0, o.reason || '', o.elapsed || 0, o.minMs || 0, o.ipHash || '', o.uaHash || '', o.event || 'crack']).catch(() => {}); } catch (e) {} }

// ── Cloudflare Turnstile human-firewall (mint gate + cash-out only). KEY-PLUGGABLE: with no TURNSTILE_SECRET set the gate NO-OPS
// (returns true) so nothing breaks before keys are configured; set TURNSTILE_SECRET + TURNSTILE_SITE_KEY (group secrets) to arm it.
// Verified server-side against Cloudflare. It's a friction layer, NOT the economic protection (that's the right-sized pot + caps).
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const _tsUsed = new Map();   // token -> ts, for local single-use enforcement (red-team H2); pruned in the sweep
async function verifyTurnstile(token, req) {
  // FAIL-CLOSED on ANY real-money build (red-team H2/H4): if the secret is ever unset, only wave through on a NON-onchain,
  // non-public (testnet dev) build. On mainnet (ONCHAIN_ONLY, chain 4663) or public prod, a missing secret must BLOCK the
  // human-gated action rather than silently no-op the firewall on real value.
  if (!TURNSTILE_SECRET) return !ONCHAIN_ONLY && process.env.RTV_PUBLIC !== '1';
  if (!token) return false;
  token = String(token);
  if (_tsUsed.has(token)) return false;   // one solved captcha = one action (don't rely solely on Cloudflare's single-use)
  try {
    const ip = _clientIp(req);   // trusted rightmost hop, not a spoofable leftmost XFF
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: token, remoteip: ip }).toString() });
    const j = await r.json(); const ok = !!(j && j.success);
    if (ok) _tsUsed.set(token, Date.now());   // consume it
    return ok;
  } catch (e) { return false; }
}
// Active challenges (in-memory, per run) + a light per-player rate limiter.
const _active = new Map();     // runId -> { gameKey, kind, door, level, ch, startTs }
const _rl = new Map();         // player -> [timestamps]
const _ipRl = new Map();
const _skillHist = new Map();   // player -> recent raw skill/nerve scores (bot-consistency monitor, item #4)
function rateOk(player, req) {
  const now = Date.now();
  const a = (_rl.get(player) || []).filter(t => now - t < 10000); a.push(now); _rl.set(player, a);
  let ipC = 0;
  if (req) { const xff = String(req.headers['x-forwarded-for'] || ''); const ip = (xff ? xff.split(',').pop().trim() : '') || (req.socket && req.socket.remoteAddress) || '?';   // LAST hop = appended by our trusted proxy; spoofed XFF prepends fake entries on the LEFT, so take the right (item #4)
    const b = (_ipRl.get(ip) || []).filter(t => now - t < 10000); b.push(now); _ipRl.set(ip, b); ipC = b.length; }
  return a.length <= 10 && ipC <= 40;   // player key is client-controlled, so the per-IP cap is the real anti-bot gate
}
if (!global.__rtvRlSweep) { global.__rtvRlSweep = setInterval(() => { const now = Date.now(); for (const [k, v] of _active) if (now - v.startTs > 120000) _active.delete(k); for (const [k, v] of _rl) if (!v.some(t => now - t < 60000)) _rl.delete(k); for (const [k, v] of _ipRl) if (!v.some(t => now - t < 60000)) _ipRl.delete(k); for (const [k, v] of _enterRl) if (!v.some(t => now - t < 700000)) _enterRl.delete(k); if (_skillHist.size > 5000) _skillHist.clear();
  for (const [k, v] of _lastCashout) if (now - v > CASHOUT_COOLDOWN_MS * 4) _lastCashout.delete(k);   // prune expired cooldowns (audit 2026-09-04)
  for (const [k, v] of _tsUsed) if (now - v > 300000) _tsUsed.delete(k);   // used Turnstile tokens expire with Cloudflare's ~5min TTL
  if (_runPage.size > 20000) { let ex = _runPage.size - 20000; for (const k of _runPage.keys()) { if (ex-- <= 0) break; _runPage.delete(k); } }   // bound the page-nonce map (evict oldest = long-terminal runs)
  dbExec("DELETE FROM rtv_seeds WHERE status='open' AND paid=0 AND ts < datetime('now','-30 minutes')").catch(() => {});   // fast GC of free UNPAID open runs (no one legitimately takes 30min to pay) — bounds the free-newrun row flood (red-team M2)
  // GC abandoned runs: an open seed older than 24h can never legitimately resume (well past any session), so purge it — this
  // bounds rtv_seeds growth and stops keeping unrevealed server_seeds around indefinitely. Terminal history in rtv_runs is untouched.
  dbExec("DELETE FROM rtv_seeds WHERE status='open' AND ts < datetime('now','-1 day')").catch(() => {});
  // Bound the bot-signals telemetry table: keep a 30-day window (well past the week-1 launch bot review) so it can't grow forever.
  dbExec("DELETE FROM rtv_bot_signals WHERE ts < datetime('now','-30 days')").catch(() => {}); }, 60000); }

// ── AUTO-RECONCILIATION (prevention + auto-remediation, Jake 2026-09-07) ────────────────────────────────────────────────
// The original bug: a wallet pays enter() on-chain but the run is never serviced server-side (e.g. verify-enter never ran and
// the paid=0 seed got GC'd), so the player paid and got no game. Run-ID recovery (verify-enter by runId) already prevents the
// common hung-wallet case; this loop is the safety net for the rest. It periodically counts on-chain Entered events per wallet
// and compares them to the DURABLE serviced marker (rtv_paid_log, which survives the seed GC). Any excess = a paid-but-never-
// serviced game -> auto-grant a free comp run so the player gets their game with no manual audit. A per-wallet self-calibrating
// high-water mark (rtv_comps.base_granted; -1 = uncalibrated) ensures we ONLY grant for orphans that appear AFTER this loop
// first sees a wallet — every pre-existing entry is baseline (already handled by the manual audit + goodwill), so nobody is
// retroactively double-granted. Gated to the public prod artifact so it runs exactly once across the shared source.
const ENTERED_TOPIC = ethers.id('Entered(bytes32,address,bytes32,uint256,uint256)');
async function reconcileComps() {
  try {
    const p = roProv();
    const head = await p.getBlockNumber();
    const SAFE = Math.max(0, head - 450);   // ~15min grace (2s blocks): don't count an entry before verify-enter has had time to service it
    const FLOOR = Math.max(0, SAFE - 500000), STEP = 45000;
    const onchain = {};
    for (let f = FLOOR; f <= SAFE; f += STEP) {
      const t = Math.min(f + STEP - 1, SAFE);
      let logs = []; try { logs = await p.getLogs({ address: OC.vault, fromBlock: f, toBlock: t, topics: [ENTERED_TOPIC] }); } catch (_) {}
      for (const lg of logs) { const who = ('0x' + lg.topics[2].slice(26)).toLowerCase(); onchain[who] = (onchain[who] || 0) + 1; }
    }
    let granted = 0, wallets = 0;
    for (const [w, n] of Object.entries(onchain)) {
      const srv = (await dbQuery("SELECT COUNT(*) c FROM rtv_paid_log WHERE player=? AND net=?", [w, OC.chainId]).catch(() => [{ c: 0 }]))[0] || { c: 0 };
      const rawOwed = Math.max(0, n - Number(srv.c || 0));
      const row = (await dbQuery("SELECT base_granted FROM rtv_comps WHERE wallet=? AND net=?", [w, OC.chainId]).catch(() => []))[0];
      if (!row) { await dbExec("INSERT OR IGNORE INTO rtv_comps (wallet,net,free_runs,owed_at_audit,base_granted,reason) VALUES (?,?,0,0,?,?)", [w, OC.chainId, rawOwed, 'auto-reconcile baseline']).catch(() => {}); continue; }   // brand-new wallet: calibrate baseline, never retro-grant
      const seen = Number(row.base_granted);
      if (seen < 0) { await dbExec("UPDATE rtv_comps SET base_granted=? WHERE wallet=? AND net=?", [rawOwed, w, OC.chainId]).catch(() => {}); continue; }   // first sight of an audited wallet: calibrate, no grant
      if (rawOwed > seen) {
        const delta = rawOwed - seen;
        await dbExec("UPDATE rtv_comps SET free_runs=free_runs+?, base_granted=?, reason=COALESCE(reason,'')||' +auto' WHERE wallet=? AND net=?", [delta, rawOwed, w, OC.chainId]).catch(() => {});
        console.log('[rtv-recon] auto-granted', delta, 'comp run(s) ->', w, '(onchain', n, 'serviced', Number(srv.c || 0), ')');
        granted += delta; wallets++;
      }
    }
    if (granted) console.log('[rtv-recon] cycle auto-granted', granted, 'run(s) across', wallets, 'wallet(s)');
  } catch (e) { console.error('[rtv-recon] error', e && e.message); }
}
if (ONCHAIN_ONLY && process.env.RTV_PUBLIC === '1' && !global.__rtvRecon) {
  global.__rtvRecon = setInterval(reconcileComps, 30 * 60 * 1000);   // every 30 min, public prod artifact only (shared DB/contract)
  setTimeout(reconcileComps, 90 * 1000);   // first pass ~90s after boot to calibrate baselines
}

// ── API ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Per-level/door preview table so the client can show odds + reward multiples without duplicating the math.
function doorTable() {
  const t = [];
  for (let lvl = 1; lvl <= LEVELS; lvl++) { const row = {}; for (const d of ['left', 'center', 'right']) row[d] = { odds: baseOdds(lvl, d), reward: stepReward(lvl, d) }; t.push(row); }
  return t;
}
// Real Rare Pepe / Fake Rares card art, proxied same-origin (no CORS) and cached in-memory so the SAME image loads every time.
// Source is Emblem's Counterparty card resolver (api.explorer.hnft.wtf), the same one the metadata companion uses.
const PEPE_SRC = 'https://api.explorer.hnft.wtf/images/';
const _pepeCache = new Map();   // ASSET -> { buf, type } (kept) | { miss: true }
function pepeSet(a, v) { _pepeCache.set(a, v); if (_pepeCache.size > 3000) _pepeCache.delete(_pepeCache.keys().next().value); }   // bounded (item #4): evict oldest, Map keeps insertion order
app.get('/api/pepe/:asset', async (req, res) => {
  try {
    const a = String(req.params.asset || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (a.length < 3) return res.status(400).end();
    if (!rateOk('pepe:' + a, req)) return res.status(429).end();   // throttle the outbound-fetch amplifier (item #4)
    const hit = _pepeCache.get(a);
    if (hit && hit.buf) { res.set('Content-Type', hit.type); res.set('Cache-Control', 'public, max-age=604800, immutable'); return res.end(hit.buf); }
    if (hit && hit.miss) return res.status(404).end();
    for (const ext of ['jpg', 'png', 'gif']) {
      try {
        const r = await fetch(PEPE_SRC + a + '.' + ext, { signal: AbortSignal.timeout(9000) });
        const ct = r.headers.get('content-type') || '';
        if (r.ok && /^image\//i.test(ct)) { const buf = Buffer.from(await r.arrayBuffer()); pepeSet(a, { buf, type: ct }); res.set('Content-Type', ct); res.set('Cache-Control', 'public, max-age=604800, immutable'); return res.end(buf); }
      } catch (e) {}
    }
    pepeSet(a, { miss: true });
    res.status(404).end();
  } catch (e) { res.status(502).end(); }
});

// Resume support: current status of an in-flight run so a refreshed / returning player can pick up where they left off.
// Safe: never reveals server_seed (only the settle path does). Door layouts are already public in-game, so returning them is fine.
app.get('/api/run/:runId', async (req, res) => {
  try {
    const runId = String(req.params.runId);
    const row = (await dbQuery("SELECT player, stake, depth, mult, status, server_seed, server_hash, client_seed FROM rtv_seeds WHERE run_id=?", [runId]))[0];
    if (!row) return res.status(404).json({ ok: false, error: 'not found' });
    const depth = num(row.depth), alive = row.status === 'open';
    res.json({
      ok: true, alive, status: row.status, runId, depth, mult: num(row.mult) || 1,
      chips: num(row.stake), hash: row.server_hash, clientSeed: row.client_seed,
      levels: LEVELS, cashoutMin: CASHOUT_MIN,
      doors: alive ? doorsLayout(row.server_seed, depth + 1) : undefined
    });
  } catch (e) { res.status(500).json({ ok: false, error: String(e && e.message || e) }); }
});

// Practice-arcade challenge cache: holds the FULL challenge (answers included) server-side so /api/mini/preview/score can
// grade a practice run authoritatively WITHOUT ever sending answers to the client. TTL'd + hard-capped (memory safety).
const _pvCache = new Map();   // pvid -> { gameKey, ch, exp }
// Mini-game preview (powers the Vault Arcade): authentic params from buildChallenge, no run / odds / stakes. Scored by /preview/score.
app.get('/api/mini/preview', (req, res) => {
  try {
    if (!rateOk('pv:' + _clientIp(req), req)) return res.status(429).json({ error: 'slow down' });   // rate-limit the practice-preview oracle (red-team M2)
    const gameKey = String(req.query.game || '');
    const kind = SKILL_GAMES.includes(gameKey) ? 'skill' : (LUCK_GAMES.includes(gameKey) ? 'luck' : (NERVE_GAMES.includes(gameKey) ? 'nerve' : null));
    if (!kind) return res.status(404).json({ ok: false, error: 'unknown game' });
    let level = parseInt(req.query.level, 10); if (!Number.isFinite(level)) level = 3;
    level = Math.max(1, Math.min(LEVELS, level));
    const seed = crypto.randomBytes(32).toString('hex');
    const ch = buildChallenge(gameKey, level, 'center', seed);
    const params = sanitizeParams(gameKey, ch);   // strip hidden answers, so the practice arcade can't be used as an answer oracle for the real games
    const pvid = crypto.randomBytes(12).toString('hex');
    const _now = Date.now(); for (const [k, v] of _pvCache) if (v.exp < _now) _pvCache.delete(k);   // GC expired
    if (_pvCache.size > 500) _pvCache.clear();   // hard cap
    _pvCache.set(pvid, { gameKey, ch, start: _now, exp: _now + 180000 });   // 3-min TTL; start = for time-gated /step reveal
    params._pvid = pvid;   // so the sequence renderer can fetch its pads one at a time
    res.json({ ok: true, pvid, gameKey, kind, level, params, games: { luck: LUCK_GAMES, skill: SKILL_GAMES, nerve: NERVE_GAMES } });
  } catch (e) { res.status(500).json({ ok: false, error: String(e && e.message || e) }); }
});

// Score a practice-arcade run authoritatively (win/loss feedback only — NO odds roll, NO stakes, nothing recorded). Skill/Nerve:
// pass = you beat the mini (scoreEvents > 0). Luck: no skill channel, so it's just theatre. Answers stay server-side (see cache above).
app.post('/api/mini/preview/score', (req, res) => {
  try {
    if (!rateOk('pvs:' + _clientIp(req), req)) return res.status(429).json({ error: 'slow down' });   // rate-limit the free authoritative scorer (red-team M2)
    const pvid = String(req.body.pvid || '');
    const rec = _pvCache.get(pvid);
    if (!rec) return res.json({ ok: false, error: 'expired' });
    _pvCache.delete(pvid);   // one-shot
    const events = Array.isArray(req.body.events) ? req.body.events.slice(0, 400) : [];
    const kind = SKILL_GAMES.includes(rec.gameKey) ? 'skill' : (LUCK_GAMES.includes(rec.gameKey) ? 'luck' : 'nerve');
    const raw = scoreEvents(rec.gameKey, rec.ch, events);   // null for luck
    const passed = kind === 'luck' ? null : (Number.isFinite(raw) && raw > 0);
    const score = kind === 'luck' ? null : Math.max(0, Math.min(1, raw || 0));
    res.json({ ok: true, kind, passed, score });
  } catch (e) { res.status(500).json({ ok: false, error: String(e && e.message || e) }); }
});

// NOTE: the odds model is deliberately NOT exposed to the client. The player must never be able to read the bust
// probability of any chamber/door (Jake: "never, ever show what the actual odds were"). p / doorTable / houseEdge /
// jackpotTake / skillBonusByLevel / v2 are server-only; the UI needs only fee/levels/ladder/cashout to render.
app.get('/api/config', (req, res) => res.json({ levels: LEVELS, doors: DOORS, categories: ['luck', 'skill', 'nerve'], burnShare: BURN_SHARE, fee: FEE, chips: CHIPS, cashoutMin: CASHOUT_MIN, potLadder: POT_LADDER, token: RVLT, pair: PAIR, creatorBps: CREATOR_BPS, mintSpots: EXTRA_MINT_SPOTS, coreChoice: CORE_CHOICE, noMint: process.env.RTV_NO_MINT === '1' }));

app.get('/api/stats', async (req, res) => { try { res.json(await market()); } catch (e) { res.status(500).json({ error: 'stats' }); } });

// Public game statistics for the dashboard (aggregates the group DB + on-chain mint count).
app.get('/api/stats/public', async (req, res) => {
  try {
    const s = (await dbQuery("SELECT jackpot_eth, pot_rvlt, burned_rvlt, plays, robs FROM rtv_state WHERE id='main'").catch(() => []))[0] || {};
    const uniq = (await dbQuery("SELECT COUNT(DISTINCT player) c FROM rtv_runs WHERE net=?", [OC.chainId]).catch(() => []))[0] || {};
    const triesRow = (await dbQuery("SELECT COUNT(*) c FROM rtv_runs WHERE net=?", [OC.chainId]).catch(() => []))[0] || {};
    const totalRuns = Number(triesRow.c || 0);
    const plays = Number(s.plays || 0);
    // level funnel: how many runs REACHED each depth 1..LEVELS (and % of all runs)
    const depthRows = await dbQuery("SELECT depth, COUNT(*) c FROM rtv_runs WHERE net=? GROUP BY depth", [OC.chainId]).catch(() => []);
    const byDepth = {}; for (const r of depthRows) byDepth[Number(r.depth)] = Number(r.c);
    const funnel = [];
    for (let d = 1; d <= LEVELS; d++) { let reached = 0; for (const k in byDepth) if (Number(k) >= d) reached += byDepth[k]; funnel.push({ level: d, reached, pct: totalRuns ? +(reached / totalRuns * 100).toFixed(1) : 0 }); }
    // on-chain NFT mint count
    let minted = null;
    try { const c = new ethers.Contract(OC.robbers, ['function totalMinted() view returns (uint256)'], roProv()); minted = Number(await c.totalMinted()); } catch (e) {}   // reuse cached provider (no churn)
    res.json({
      entries: plays,
      uniquePlayers: Number(uniq.c || 0),
      uniqueTries: totalRuns,
      rvltPaidToGame: plays * FEE,          // total RVLT entry fees paid into the game
      rvltBurned: Number(s.burned_rvlt || 0),// the game's own entry-fee burn (mint proceeds go to treasury, burned later)
      potRvlt: Number(s.pot_rvlt || 0),
      jackpotEth: Number(s.jackpot_eth || 0),
      robs: Number(s.robs || 0),
      levels: LEVELS,
      funnel,
      nft: { minted, supply: OC.robbersSupply, maxPerWallet: OC.robbersMax }
    });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
});

app.get('/api/state', async (req, res) => {
  try {
    const s = await getState();
    const live = _jackAccrual;   // show the un-flushed accrual live so the counter ticks between flushes
    const recent = await dbQuery("SELECT player, stake, depth, outcome, won_rvlt, robbed_eth, ts FROM rtv_runs WHERE net=? ORDER BY id DESC LIMIT 12", [OC.chainId]).catch(() => []);
    const board = await dbQuery("SELECT player, SUM(won_rvlt) won, SUM(robbed_eth) eth, MAX(depth) deep, COUNT(*) runs FROM rtv_runs WHERE outcome!='fail' AND net=? GROUP BY player ORDER BY won DESC LIMIT 10", [OC.chainId]).catch(() => []);
    // Privacy: never publish a full wallet address in the public feed. Truncate 0x… addresses (nicknames pass through).
    const shortP = (p) => { const s = String(p || ''); return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.slice(0, 6) + '…' + s.slice(-4) : s; };
    for (const r of recent) r.player = shortP(r.player);
    for (const r of board) r.player = shortP(r.player);
    const m = await market();
    // Jackpot + pot come STRAIGHT from the smart contract (Jake 2026-09-07) so the lobby shows the real prize even before a
    // wallet connects; the DB mirror is only a fallback if the RPC read fails. Dev wallet is separate and never folded in.
    const cv = await chainVault().catch(() => null);
    const jackEth = (cv && cv.vaultEth != null) ? cv.vaultEth : (num(s.jackpot_eth) + live);
    const potR = (cv && cv.potRvlt != null) ? cv.potRvlt : num(s.pot_rvlt);
    res.json({ jackpotEth: jackEth, potRvlt: potR, burnedRvlt: num(s.burned_rvlt), plays: num(s.plays), robs: num(s.robs), jackpotUsd: jackEth * (m.ethUsd || 0), recent, board });
  } catch (e) { res.status(500).json({ error: 'state' }); }
});

// Winners ticker (Jake 2026-09-07): recent banked/robbed runs for the lobby marquee — social proof that the pot pays out.
// Wins only (cashout/rob), net-scoped, addresses truncated for privacy (same rule as the public feed).
app.get('/api/recent-wins', async (req, res) => {
  try {
    const rows = await dbQuery("SELECT player, depth, outcome, won_rvlt, robbed_eth, ts FROM rtv_runs WHERE outcome IN ('cashout','rob') AND net=? AND won_rvlt>0 ORDER BY id DESC LIMIT 20", [OC.chainId]).catch(() => []);
    const shortP = (p) => { const s = String(p || ''); return /^0x[0-9a-fA-F]{40}$/.test(s) ? s.slice(0, 6) + '…' + s.slice(-4) : s; };
    res.json({ wins: rows.map(r => ({ player: shortP(r.player), depth: Number(r.depth), rvlt: Number(r.won_rvlt || 0), eth: Number(r.robbed_eth || 0), rob: r.outcome === 'rob', ts: r.ts })) });
  } catch (e) { res.status(500).json({ error: 'recent-wins', wins: [] }); }
});

// Enter the vault: pay the flat fee, commit a hashed server seed, open a run. Body: { player, clientSeed }.
// The fee is consumed on entry — half BURNED (deflation), half added to the pot as your CHIPS (the multiplier's principal).
app.post('/api/enter', async (req, res) => {
  try {
    if (ONCHAIN_ONLY) return res.status(403).json({ error: 'on-chain entry required — pay via the contract (enter), not the demo path' });   // item #2: no unpaid DB-money runs on mainnet
    const player = String(req.body.player || 'anon').slice(0, 24);
    const clientSeed = String(req.body.clientSeed || crypto.randomBytes(8).toString('hex')).slice(0, 64);
    if (!rateOk(player, req)) return res.status(429).json({ error: 'slow down' });
    const serverSeed = crypto.randomBytes(32).toString('hex');
    const serverHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
    const runId = crypto.randomBytes(12).toString('hex');
    // stake column holds the CHIPS (fee/2) — the at-risk principal the multiplier applies to.
    await dbExec("INSERT INTO rtv_seeds (run_id,player,stake,server_seed,server_hash,client_seed,nonce,depth,mult,status,net) VALUES (?,?,?,?,?,?,0,0,1,'open',?)", [runId, player, CHIPS, serverSeed, serverHash, clientSeed, OC.chainId]);
    if (req.body.pageNonce) _runPage.set(runId, String(req.body.pageNonce));   // bind to the page load so a later refresh forfeits
    await bumpState({ burned_rvlt: FEE * BURN_SHARE, pot_rvlt: CHIPS, plays: 1 });   // fee consumed now: burn half, chips into pot
    res.json({ runId, serverHash, clientSeed, fee: FEE, burned: FEE * BURN_SHARE, chips: CHIPS, levels: LEVELS, doors: doorsLayout(serverSeed, 1) });
  } catch (e) { res.status(500).json({ error: 'enter', detail: e.message }); }
});

// Step into a door: the SERVER picks the mini-game (from the seed, so the client can't shop for an easier one) and returns the
// challenge params to render. Body: { runId, door }. Opens an active challenge with a start timestamp.
// Lightweight unique-visitor + device tracker (each client id counted once; device = mobile/desktop).
app.post('/api/visit', async (req, res) => {
  try {
    if (!rateOk('visit', req)) return res.status(429).json({ ok: false });   // throttle the unauthenticated write (item #4)
    const id = String((req.body && req.body.id) || '').slice(0, 64);
    const device = (req.body && req.body.device) === 'mobile' ? 'mobile' : 'desktop';
    if (id) dbExec("INSERT OR IGNORE INTO rtv_visits (id,device,net) VALUES (?,?,?)", [id, device, OC.chainId]).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});
// ── Refresh = forfeit (no resume, no do-over). Each run is bound to an in-memory PAGE NONCE that regenerates on every page
// load. If a later action arrives with a different nonce, the player reloaded mid-run, so the run is an automatic loss. A
// server restart just clears the map and rebinds on the next action (never helps a cheater: they still can't un-bust or
// skip depth). Combined with the removal of the client resume, refreshing mid-heist can no longer be used as a do-over. (Jake 2026-08-31)
const _runPage = new Map();   // runId -> pageNonce
async function forfeitRun(cur) {
  _active.delete(cur.run_id); _runPage.delete(cur.run_id);
  await dbExec("UPDATE rtv_seeds SET status='busted' WHERE run_id=? AND status='open'", [cur.run_id]).catch(() => {});
  await dbExec("INSERT INTO rtv_runs (player,stake,depth,outcome,burned_rvlt,net,server_seed,server_hash,client_seed) VALUES (?,?,?,?,?,?,?,?,?)", [cur.player, FEE, num(cur.depth), 'fail', FEE * BURN_SHARE, OC.chainId, cur.server_seed, cur.server_hash, cur.client_seed]).catch(() => {});
}
// Guard for mini/start + crack: forfeit if the page reloaded since the run was bound; bind the nonce on first sight.
async function pageReloadForfeit(runId, row, req) {
  const pn = String((req.body && req.body.pageNonce) || '');
  const bound = _runPage.get(runId);
  if (bound && pn && bound !== pn) { await forfeitRun(row); return true; }
  if (pn && !bound) _runPage.set(runId, pn);
  return false;
}
// Explicit forfeit (page-unload beacon or on-load cleanup of an abandoned run). Idempotent; only busts an open run.
app.post('/api/forfeit', async (req, res) => {
  try {
    const runId = String(req.body.runId || '');
    if (!runId) return res.json({ ok: false });
    if (!rateOk('forfeit', req)) return res.json({ ok: false });   // throttle the unauthenticated forfeit write (grief/spam guard)
    await withRunLock(runId, async () => {
      const cur = (await dbQuery("SELECT * FROM rtv_seeds WHERE run_id=?", [runId]).catch(() => []))[0];
      if (cur && cur.status === 'open') await forfeitRun(cur);
    });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});
app.post('/api/mini/start', async (req, res) => {
  try {
    const runId = String(req.body.runId || '');
    const door = ['left', 'center', 'right'].includes(req.body.door) ? req.body.door : 'center';
    const row = (await dbQuery("SELECT * FROM rtv_seeds WHERE run_id=?", [runId]).catch(() => []))[0];
    if (!row || row.status !== 'open') return res.status(400).json({ error: 'no open run' });
    if (await pageReloadForfeit(runId, row, req)) return res.status(403).json({ error: 'run forfeited (page reloaded)', forfeited: true });   // refresh mid-run = loss
    if (ONCHAIN_ONLY && !Number(row.paid)) return res.status(403).json({ error: 'run not paid on-chain' });   // mainnet: no unpaid run can advance state (H2)
    if (!rateOk(row.player, req)) return res.status(429).json({ error: 'slow down' });
    const level = num(row.depth) + 1;
    if (level > LEVELS) return res.status(400).json({ error: 'cleared' });
    const { kind, gameKey } = gameForDoor(row.server_seed, level, door);
    const ch = buildChallenge(gameKey, level, door, row.server_seed);
    _active.set(runId, { gameKey, kind, door, level, ch, startTs: Date.now() });   // FULL ch (incl answers) stays server-side for scoring
    dbExec("UPDATE rtv_seeds SET cur_door=?, cur_started=? WHERE run_id=?", [door, Date.now(), runId]).catch(() => {});   // persist door + start so /api/crack can rebuild the deterministic challenge if the server restarts / the in-memory cache is swept
    dbExec("INSERT OR IGNORE INTO rtv_door_picks (kind,net,n) VALUES (?,?,0)", [kind, OC.chainId]).catch(() => {});   // ensure this network's counter row exists
    dbExec("UPDATE rtv_door_picks SET n=n+1 WHERE kind=? AND net=?", [kind, OC.chainId]).catch(() => {});   // cumulative door-category preference (luck/skill/nerve), per network
    const _p = sanitizeParams(gameKey, ch); _p._rid = runId;   // _rid lets the sequence renderer fetch its pads via /api/mini/step
    res.json({ gameKey, kind, door, level, tier: (DOORS[door] || {}).tier, minMs: ch.minMs, params: _p });   // browser gets render data ONLY — hidden answers stripped
  } catch (e) { res.status(500).json({ error: 'mini-start', detail: e.message }); }
});

// Paced pad-reveal for Keypad Breach (sequence): serves ONE pad at a time, never before its natural flash moment, so the full
// sequence is never in a single payload and can't be fetched ahead of the animation. Works for a live run (rid) or the arcade (pvid).
app.get('/api/mini/step', (req, res) => {
  try {
    const i = Math.max(0, parseInt(req.query.i, 10) || 0);
    const rid = String(req.query.rid || ''), pvid = String(req.query.pvid || '');
    const rec = rid ? _active.get(rid) : (pvid ? _pvCache.get(pvid) : null);
    if (!rec || !rec.ch || rec.gameKey !== 'sequence') return res.json({ done: true });
    const seq = rec.ch.seq || [], flashMs = rec.ch.flashMs || 500, start = rec.startTs || rec.start || 0;
    if (i >= seq.length) return res.json({ done: true });
    if (start && (Date.now() - start) < (i * flashMs - 250)) return res.json({ wait: true });   // too early -> can't peek ahead
    res.json({ pad: seq[i], i });
  } catch (e) { res.json({ done: true }); }
});

// Resolve the chamber from the streamed input events. Body: { runId, events }. The server scores the events against the
// active challenge, judges humanness, and rolls the provably-fair outcome. Success accumulates the run's multiple; a fail
// settles it (50% burned / 50% to pot). No client score is trusted — skill is measured here.
// Per-run in-process MUTEX: serialize every state-changing op on ONE runId (crack + cashout) so a player can't RACE two
// requests to be paid twice from the shared pot (e.g. a final core-crack vs a cashout, or two cashouts firing together).
// This is a single Node process, so an in-memory lock is authoritative; with it, the `status='open'` re-check inside each
// critical section becomes the atomic guard — the 2nd request runs only after the 1st flips the run to a terminal status,
// sees it, and 400s. (Security audit 2026-08-31, HIGH: double-settlement.)
const _runLock = new Map();   // runId -> { tail: Promise, n: pending-waiters }
async function withRunLock(runId, fn) {
  let ent = _runLock.get(runId);
  if (!ent) { ent = { tail: Promise.resolve(), n: 0 }; _runLock.set(runId, ent); }
  ent.n++;
  const prev = ent.tail; let release; ent.tail = new Promise(r => release = r);
  try { await prev.catch(() => {}); return await fn(); }
  finally { release(); ent.n--; if (ent.n === 0 && _runLock.get(runId) === ent) _runLock.delete(runId); }
}

app.post('/api/crack', async (req, res) => {
  try {
    const runId = String(req.body.runId || '');
    if (!rateOk('c:' + runId, req)) return res.status(429).json({ error: 'slow down' });
    await withRunLock(runId, async () => {
    const events = Array.isArray(req.body.events) ? req.body.events.slice(0, 400) : [];
    const row = (await dbQuery("SELECT * FROM rtv_seeds WHERE run_id=?", [runId]).catch(() => []))[0];
    if (!row || row.status !== 'open') return res.status(400).json({ error: 'no open run' });
    let act = _active.get(runId);
    if (!act) {
      // RESTART / SWEEP RESILIENCE: the active challenge is an in-memory cache that a server restart (deploy/crash/watchdog)
      // or the 120s sweep wipes, which would otherwise brick a paid, in-flight run ("no active challenge"). The challenge is
      // fully deterministic from (server_seed, level, door), and mini/start persists the door + its start time to rtv_seeds,
      // so we rebuild the EXACT same challenge (and its anti-cheat timing) with zero client trust and no replay.
      const rdoor = ['left', 'center', 'right'].includes(row.cur_door) ? row.cur_door : null;
      if (!rdoor) return res.status(400).json({ error: 'no active challenge, step through a door first' });
      const rlevel = num(row.depth) + 1;
      const { kind, gameKey } = gameForDoor(row.server_seed, rlevel, rdoor);
      const ch = buildChallenge(gameKey, rlevel, rdoor, row.server_seed);
      act = { gameKey, kind, door: rdoor, level: rlevel, ch, startTs: Number(row.cur_started) || (Date.now() - (ch.minMs || 0)) };
    }
    _active.delete(runId);
    const door = act.door;
    if (!row.client_seed) return res.status(409).json({ error: 'seed not secured, reload and re-enter' });   // grind-proof: no roll until the player has bound their own seed
    if (await pageReloadForfeit(runId, row, req)) return res.status(403).json({ error: 'run forfeited (page reloaded)', forfeited: true });   // refresh mid-run = loss (we already hold the run lock here)
    if (ONCHAIN_ONLY && !Number(row.paid)) return res.status(403).json({ error: 'run not paid on-chain' });   // mainnet: only a paid run mutates depth/pot/jackpot/leaderboard (H2)
    const level = num(row.depth) + 1;
    if (level > LEVELS) return res.status(400).json({ error: 'cleared' });
    // Anti-bot: hard minimum-duration gate, server-side scoring, humanness shadow-gate on the skill bonus.
    const elapsed = Date.now() - act.startTs;
    const human = humanScore(events);
    let raw = scoreEvents(act.gameKey, act.ch, events);         // null for luck games
    let flagged = false, flagReason = '';
    // BOT-CONSISTENCY MONITOR (item #4): a human's skill/nerve scores vary door-to-door; a jitter-bot that beats the naive
    // humanness gate clusters at the ceiling with near-zero variance. Over a rolling window of 12 skill/nerve doors, if the
    // mean is > 0.97 AND the variance is < 0.0005 (a bar no real human sustains), treat it as a bot and void the score.
    if (act.kind !== 'luck' && Number.isFinite(raw)) {
      const _fpK = _reqFP(req); const _k = (_fpK && _fpK.ip) || String(row.player || 'anon');   // key on IP-hash, not the client-supplied player, so a jitter-bot can't reset its history by rotating player strings (red-team M4)
      const _h = _skillHist.get(_k) || []; _h.push(raw); if (_h.length > 12) _h.shift(); _skillHist.set(_k, _h);
      if (_h.length >= 12) { const _m = _h.reduce((s, x) => s + x, 0) / _h.length; const _v = _h.reduce((s, x) => s + (x - _m) * (x - _m), 0) / _h.length; if (_m > 0.97 && _v < 0.0005) { raw = 0; flagged = true; flagReason = 'consistency'; } }
    }
    if (elapsed < (act.ch.minMs || 0) * 0.8) { raw = 0; flagged = true; flagReason = 'fast-solve'; }   // solved implausibly fast → void the bonus
    // TIME-TRAVEL GUARD: every score on the timer/skill/nerve games is derived from the CLIENT-supplied event `t` (ms since
    // the mini started). A cheater could wait past the minMs gate, then POST a fabricated perfect `t` (e.g. stop dead on the
    // mark) that never really happened. The server's wall-clock `elapsed` (start→crack) always exceeds the real client play
    // time — it also carries the network round-trips and the read-instructions/GO delay — so the latest claimed event can
    // never legitimately be later than `elapsed`. Reject the run if it is (beyond a network/skew tolerance). Odds math is
    // untouched; this only voids physically-impossible timings. (This is the founder's timer-cheat, closed simply.)
    const _tol = 400;   // ms: absorbs client→server transmission + clock skew; real plays clear it easily since elapsed >> play time
    let _maxT = 0; for (const e of events) { if (e && Number.isFinite(e.t) && e.t > _maxT) _maxT = e.t; }
    if (_maxT > elapsed + _tol) { raw = 0; flagged = true; flagReason = 'time-travel'; }   // claimed to act later than real time allowed → fabricated
    if (act.kind !== 'luck' && human < 0.35) { raw = 0; flagged = true; flagReason = flagReason || 'low-human'; }   // non-human input pattern → void the bonus
    const score = act.kind !== 'luck' ? Math.max(0, Math.min(1, raw || 0)) : 0;   // Skill + Nerve modulate odds; Luck has no channel
    const nonce = num(row.nonce) + 1;
    const r = roll(row.server_seed, row.client_seed, nonce);
    const eff = advChance(act.kind, level, door, score);   // reported advance chance under the LIVE model (frozen or V2)
    // NO GIMMES: on a Skill/Nerve door, failing the mini-game (score 0 = missed / busted / wrong pick) is an automatic
    // loss regardless of the provably-fair roll. A real success (score > 0) still faces the roll. Luck has no mini to fail.
    const failedMini = act.kind !== 'luck' && !(score > 0);
    let success;
    if (SKILL_V3 && act.kind === 'skill') {
      // SKILL_V3 (Jake 2026-09-07): skill DECIDES every chamber. Beat the rising bar (games are much faster/tougher deep) and you
      // advance — ch1-9 with NO roll, so a clean run is never stolen by luck. The CORE (ch10) also needs the rarity roll on top of
      // the bar, the only luck left, so the full ETH jackpot can't be drained by one hot run / bot.
      if (failedMini || !(score >= V2_SKILL_BAR[level - 1])) success = false;
      else if (level >= LEVELS) success = r < CORE_CRACK_ODDS;
      else success = true;
    } else if (ODDS_V2 && act.kind === 'skill') {
      // Skill-driven model (Jake 2026-09-04): ch1-5 DETERMINISTIC — beat the rising skill bar and you advance, no roll; a real
      // mini-fail busts. ch6-10 GAUNTLET — skill sets the chance and the provably-fair roll decides (bot-proof deep tail).
      if (failedMini) success = false;
      else if (level <= 5) success = score >= V2_SKILL_BAR[level - 1];
      else success = r < v2GauntletAdv(level, score);
    } else {
      success = !failedMini && r < eff;   // Nerve + Luck unchanged (and Skill too when ODDS_V2 is off)
    }
    try { const _fp = _reqFP(req); logBotSignal({ player: row.player, run: runId, level, kind: act.kind, gameKey: act.gameKey, score: act.kind === 'luck' ? null : score, human: act.kind === 'luck' ? null : human, flagged, reason: flagReason, elapsed, minMs: act.ch.minMs || 0, ipHash: _fp.ip, uaHash: _fp.ua, event: 'crack' }); } catch (e) {}   // bot-review metadata
    const mult = (num(row.mult) || 1);
    if (success) {
      const newMult = mult * stepReward(level, door);
      await dbExec("UPDATE rtv_seeds SET depth=?, nonce=?, mult=? WHERE run_id=? AND status='open'", [level, nonce, newMult, runId]);
      const robbed = level === LEVELS;   // cracked the core
      let payout = { jackpotEth: 0 };
      if (robbed) {
        const acc = _jackAccrual; _jackAccrual = 0;       // capture synchronously before any await so the 30s flush cannot double-count
        const st = await getState();
        const jack = num(st.jackpot_eth) + acc;
        const take = jack * JACKPOT_TAKE;                 // core-robber claims 100% of the ETH vault
        payout.jackpotEth = take;
        const winR = num(st.pot_rvlt);                    // and robs the entire RVLT pot (stage-10 share = 100%)
        await bumpState({ jackpot_eth: -take, pot_rvlt: -winR, robs: 1 });   // plays already counted at entry
        await dbExec("INSERT INTO rtv_runs (player,stake,depth,outcome,won_rvlt,robbed_eth,net,server_seed,server_hash,client_seed) VALUES (?,?,?,?,?,?,?,?,?,?)", [row.player, FEE, LEVELS, 'rob', winR, take, OC.chainId, row.server_seed, row.server_hash, row.client_seed]);
        await dbExec("UPDATE rtv_seeds SET status='robbed', depth=? WHERE run_id=? AND status='open'", [LEVELS, runId]);
        payout.wonRvlt = winR;
      }
      // NOTE: roll / effOdds / baseChance intentionally NOT returned — the client must never learn the actual odds (Jake).
      res.json({ success: true, level, door, gameKey: act.gameKey, kind: act.kind, score, human, flagged, potShare: potShareFor(level), robbed, doors: robbed ? undefined : doorsLayout(row.server_seed, level + 1), serverSeed: robbed ? row.server_seed : undefined, ...payout });
    } else {
      // Bust: the fee was already consumed at entry (burned + chips into pot), and the chips stay in the pot for others. No
      // further burn or pot change — just end the run.
      await dbExec("INSERT INTO rtv_runs (player,stake,depth,outcome,burned_rvlt,net,server_seed,server_hash,client_seed) VALUES (?,?,?,?,?,?,?,?,?)", [row.player, FEE, level - 1, 'fail', FEE * BURN_SHARE, OC.chainId, row.server_seed, row.server_hash, row.client_seed]);
      await dbExec("UPDATE rtv_seeds SET status='busted', nonce=? WHERE run_id=? AND status='open'", [nonce, runId]);
      // Loss reveal (Nerve only): the run is over and the seed is already returned, so showing where the hidden line/step was is safe
      // and teaches the push-your-luck lesson ("you pushed one step too far"). Only when the MINI was busted, not a roll loss.
      let reveal = null;
      if (failedMini) {
        const CLIMB = ['ladder', 'minefield', 'cascadelocks', 'ziplinebail', 'defuse', 'vaultstack', 'heisttimer', 'dominoes'];
        const GAUGE = ['holddrill', 'crank', 'pressure', 'overload', 'dive', 'thermite', 'staticcharge', 'crackdrill', 'nitro', 'guardsweep'];
        if (CLIMB.includes(act.gameKey) && act.ch.fail != null) { const c = events.filter(e => e && e.type === 'climb').length; reveal = { mini: 'climb', trap: act.ch.fail, reached: c, total: act.ch.rungs }; }
        else if (GAUGE.includes(act.gameKey) && act.ch.danger != null) { const st = events.find(e => e && e.type === 'stop'); const f = st ? Math.max(0, Math.min(1, st.t / act.ch.maxMs)) : 1; reveal = { mini: 'gauge', line: Math.round(act.ch.danger * 100), held: Math.round(f * 100) }; }
        else {   // SKILL loss reveal: an honest one-line "here's the miss" so a failed skill door also teaches (run is over → safe to reveal)
          const gk = act.gameKey, ch = act.ch, taps = events.filter(e => e && Number.isFinite(e.t)); let msg = null;
          if (gk === 'dial') { const lk = taps.find(e => e.type === 'lock'); if (!lk) msg = 'You never locked the dial.'; else { const a = (ch.start + ch.speed * (lk.t / 1000)) % (Math.PI * 2); const dd = Math.abs(((a - ch.target + Math.PI * 3) % (Math.PI * 2)) - Math.PI); msg = 'You locked ' + Math.round(dd * 180 / Math.PI) + '° off the mark.'; } }
          else if (gk === 'reflex' || gk === 'quickdraw' || gk === 'silentalarm') { const tp = taps.find(e => e.type === 'tap'); msg = !tp ? 'You never moved.' : (tp.t < ch.greenAt ? 'You moved before the signal.' : 'Too slow after the signal.'); }
          else if (gk === 'wirecut') { const c = taps.find(e => e.type === 'cut'); if (!c) msg = 'You never made the cut.'; else { const f = c.t / ch.travelMs; msg = f > ch.bandHi ? 'Too late — the spark reached the detonator.' : (f < ch.bandLo ? 'You cut too early, before the safe window.' : 'Just off the centre of the safe window.'); } }
          else if (gk === 'sequence') { const picks = taps.filter(e => e.type === 'pad'); let c = 0; for (let k = 0; k < ch.seq.length; k++) { if (picks[k] && picks[k].idx === ch.seq[k]) c++; else break; } msg = 'You matched ' + c + ' of ' + ch.seq.length + '.'; }
          else if (gk === 'lasers' || gk === 'lockpins' || gk === 'sonicrack' || gk === 'dialcombo' || gk === 'hotwire') { const h = taps.filter(e => e.type === 'tap').length; msg = 'You cleared ' + Math.min(h, ch.rounds) + ' of ' + ch.rounds + ' rounds.'; }
          else if (gk === 'targets' || gk === 'catch' || gk === 'pressureplates') { const n = taps.filter(e => e.type === 'tap').length; msg = 'You tagged ' + n + ' of ' + ch.n + '.'; }
          else if (gk === 'stopwatch' || gk === 'tumbler') { const s = taps.find(e => e.type === 'stop'); msg = !s ? 'You never stopped it.' : 'You stopped ' + Math.abs(Math.round(s.t - ch.target)) + 'ms off the mark.'; }
          else if (gk === 'mash' || gk === 'drilldepth') { const n = taps.filter(e => e.type === 'tap').length; msg = 'You reached ' + n + ' of ' + ch.need + '.'; }
          if (msg) reveal = { mini: 'skill', msg };
        }
      }
      // GAUNTLET honesty (Jake 2026-09-07): under ODDS_V2 the inner chambers (6-10) are NOT deterministic — a clean run (score>0)
      // only buys a CHANCE and the provably-fair roll decides. Players who mastered the deterministic approach (ch1-5) read a
      // roll-loss here as "the game ignored my win." Return an honest, in-world reveal so the deep loss is explained, not silent.
      // (Pure messaging — no odds change; the frozen/approved curve is untouched.)
      else if (SKILL_V3 && act.kind === 'skill' && score > 0 && level < LEVELS) { reveal = { mini: 'gauntlet', msg: 'So close. This deep the vault demands a near-flawless run and you came up just short. Sharpen up and go again.' }; }
      else if (SKILL_V3 && act.kind === 'skill' && score > 0 && level >= LEVELS) { reveal = { mini: 'gauntlet', msg: 'You cracked it clean, but the core’s final lock held. The jackpot resists this time.' }; }
      else if (ODDS_V2 && act.kind === 'skill' && level >= 6 && score > 0) { reveal = { mini: 'gauntlet', msg: 'Clean run. But past the Bank Lobby the inner vault only grants a chance, and this time the roll held it shut.' }; }
      res.json({ success: false, level, door, gameKey: act.gameKey, kind: act.kind, score, human, flagged, serverSeed: row.server_seed, reveal });
    }
    });
  } catch (e) { res.status(500).json({ error: 'crack', detail: e.message }); }
});

// Walk away with the loot cleared so far. Body: { runId }. Pays stake × the run's accumulated multiple from the pot.
app.post('/api/cashout', async (req, res) => {
  try {
    if (ONCHAIN_ONLY) return res.status(403).json({ error: 'on-chain cash-out required — settle via the contract, not the demo path' });   // item #2: real cash-out is the contract settle
    const runId = String(req.body.runId || '');
    await withRunLock(runId, async () => {   // serialized vs /api/crack and vs another cashout — no double-pay from the pot
    const row = (await dbQuery("SELECT * FROM rtv_seeds WHERE run_id=?", [runId]).catch(() => []))[0];
    if (!row || row.status !== 'open') return res.status(400).json({ error: 'no open run' });
    const depth = num(row.depth);
    if (depth < CASHOUT_MIN) return res.status(400).json({ error: 'cash-out unlocks at chamber ' + CASHOUT_MIN });
    // Consume the run FIRST (atomic-under-lock): flip status before paying so a racing crack/cashout can't also pay.
    await dbExec("UPDATE rtv_seeds SET status='cashed' WHERE run_id=? AND status='open'", [runId]);
    const chk = (await dbQuery("SELECT status FROM rtv_seeds WHERE run_id=?", [runId]).catch(() => []))[0];
    if (!chk || chk.status !== 'cashed') return res.status(409).json({ error: 'already settled' });
    const st = await getState();
    const share = potShareFor(depth);                         // %-of-pot ladder for this stage
    const won = Math.max(0, num(st.pot_rvlt) * share);        // take that share of the CURRENT pot
    await bumpState({ pot_rvlt: -won });                      // winnings come from the shared pot
    await dbExec("INSERT INTO rtv_runs (player,stake,depth,outcome,won_rvlt,net,server_seed,server_hash,client_seed) VALUES (?,?,?,?,?,?,?,?,?)", [row.player, FEE, depth, 'cashout', won, OC.chainId, row.server_seed, row.server_hash, row.client_seed]);
    res.json({ won, depth, potShare: share, serverSeed: row.server_seed });
    });
  } catch (e) { res.status(500).json({ error: 'cashout', detail: e.message }); }
});

// Record an ON-CHAIN cash-out for the Activity log + stats. The client calls this AFTER its settle tx confirms. The demo
// /api/cashout is disabled on mainnet, and settle-sig only signs, so without this an on-chain cash-out never lands in rtv_runs.
// Server-authoritative + idempotent: only a paid, still-open run is recorded, and the atomic flip stops double-recording. (Jake 2026-09-05)
app.post('/api/onchain/settled', async (req, res) => {
  try {
    const runId = String((req.body && req.body.runId) || '');
    if (!runId) return res.json({ ok: false });
    await withRunLock(runId, async () => {
      const row = (await dbQuery("SELECT player, status, paid, depth, server_seed, server_hash, client_seed FROM rtv_seeds WHERE run_id=?", [runId]).catch(() => []))[0];
      if (!row || !Number(row.paid)) return res.json({ ok: false });
      if (row.status !== 'open') return res.json({ ok: true, already: true });   // already busted/cashed/robbed — nothing to add
      const depth = Math.max(0, Math.min(LEVELS, num(req.body && req.body.depth) || num(row.depth)));
      if (depth < CASHOUT_MIN) return res.json({ ok: false });   // below the cash-out gate — not a cash-out
      await dbExec("UPDATE rtv_seeds SET status='cashed', depth=? WHERE run_id=? AND status='open'", [depth, runId]);
      const chk = (await dbQuery("SELECT status FROM rtv_seeds WHERE run_id=?", [runId]).catch(() => []))[0];
      if (!chk || chk.status !== 'cashed') return res.json({ ok: true, already: true });   // lost the race
      const won = Math.max(0, Math.round(num(req.body && req.body.won)));   // client's confirmed on-chain delta (display only; the money already moved on-chain)
      await dbExec("INSERT INTO rtv_runs (player,stake,depth,outcome,won_rvlt,net,server_seed,server_hash,client_seed) VALUES (?,?,?,?,?,?,?,?,?)", [row.player, FEE, depth, 'cashout', won, OC.chainId, row.server_seed, row.server_hash, row.client_seed]).catch(() => {});
      res.json({ ok: true });
    });
  } catch (e) { res.json({ ok: false }); }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));
// Force fresh code on every load for HTML + JS. Mobile in-app wallet browsers (OKX, MetaMask, etc.) cache JS/HTML so aggressively
// that players kept running STALE builds after fixes shipped (Jake 2026-09-04: mobile showed a "no gas / open Testnet panel" error
// from old code even though the wallet had mainnet gas). no-store on .html/.js guarantees the current build; images/fonts still cache.
app.use(express.static('public', {
  setHeaders: (res, p) => {
    if (/\.(html|js)$/i.test(p)) res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    else if (/\.(png|jpg|jpeg|webp|gif|svg|woff2?|ttf|mp3|wav|ogg)$/i.test(p)) res.set('Cache-Control', 'public, max-age=604800');
  }
}));

// Process-level crash guards — a single uncaught rejection (e.g. a dropped RPC socket mid-run) must never take the
// game process down during launch. Log and keep serving (mirrors the EmblemScan crash-hardening).
process.on('unhandledRejection', (e) => { try { console.error('[rtv] unhandledRejection:', (e && (e.stack || e.message)) || e); } catch (_) {} });
process.on('uncaughtException', (e) => { try { console.error('[rtv] uncaughtException:', (e && (e.stack || e.message)) || e); } catch (_) {} });

ensureSchema().finally(() => { app.listen(process.env.PORT || 3000, () => console.log('[rtv] listening on', process.env.PORT || 3000)); });
