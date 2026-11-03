// On-chain settlement orchestrator for Vault Standoff (escrow Option D).
// The game engine stays 100% off-chain; THIS is the only bridge to the StandoffEscrow contract.
// Fully inert unless VS_ESCROW=on AND the address + signer key are provisioned, so fake-chip preview is untouched.
//
// Env:
//   VS_ESCROW           'on' to enable
//   VS_ESCROW_ADDR      deployed StandoffEscrow address
//   VS_ESCROW_SIGNER_PK settlement hot key (NEVER hardcode; env only)
//   VS_RPC              RPC (default Robinhood mainnet); use the testnet RPC while validating
//   VS_CHAINID          chain id (default 4663 mainnet; 46630 testnet)
//   VS_RVLT             ROBINVAULT token address (surfaced to the client for buy-ins)
//
// V2 OPS KEYS (features 1-3; keep distinct roles, env-only, NEVER the settlement signer):
//   VS_RELAY_PK         DEDICATED auto-buy relayer hot key (calls buyInFor). Falls back to DEPLOYER_PRIVATE_KEY
//                       for TESTNET testing ONLY (logs a loud warning). Go-live: provision a separate sealed key.
//   DEPLOYER_PRIVATE_KEY testnet deployer/owner key; used ONLY on 46630 as the relayer fallback while validating.
//                       NEVER use on mainnet.
//   VS_HOLDER_RPC       read-only RPC to the chain the Vault Robbers NFT lives on (default Robinhood MAINNET).
//   VS_NFT_ADDR         Vault Robbers ERC-721 (default mainnet 0xABC6...313a). READ-ONLY balanceOf lookups only.
//   VS_HOLDER_ALLOWLIST comma-separated addresses treated as holders regardless of on-chain balance (TEST override
//                       so testnet wallets that hold no NFT can exercise the rebate path). Never use on mainnet.
const { ethers } = require('ethers');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Local, git-excluded config for the testnet dry run (keeps the throwaway key + settings off source control
// and out of the platform env). Falls back to process.env for a production secret mechanism later.
let LOCAL = {};
try { LOCAL = JSON.parse(fs.readFileSync(path.join(__dirname, '.escrow.local.json'), 'utf8')); } catch (_) {}
let LOCAL_PK = '';
try { LOCAL_PK = fs.readFileSync(path.join(__dirname, '.escrow-signer.key'), 'utf8').trim(); } catch (_) {}

// Decide the chain first so the mainnet guard below can refuse filesystem-sourced secrets.
const CHAIN = parseInt(LOCAL.chainId || process.env.VS_CHAINID || '4663', 10);
const PROD = CHAIN === 4663;
// PROD DEPLOY DEFAULTS (vault_standoff host): the NON-SECRET public config for this mainnet artifact is baked in so the
// ONLY values an operator must place in sealed env are the genuine secrets (VS_PASSWORD, VS_ADMIN_TOKEN) plus the
// already-provisioned signer/relayer keys. Everything here is a PUBLIC on-chain fact (the proxy address, the RVLT
// entry amount, the fill mode); env STILL overrides each one. No secret is ever baked here. Set VS_ESCROW=off to disable.
// CANARY RESTORED 2026-10-14: entry returned to 46584000000000000000000 RVLT (~$10) for public launch; the prior
// 5000 RVLT (~$1) canary value for the solo multi-wallet Relay-funnel test is no longer in effect.
const PROD_CFG = { on: true, addr: '0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5', entryWei: '46584000000000000000000', mode: 'rmfill' };
// KH-1: MAINNET DEPLOYER-KEY BOOT GUARD. In production (chain 4663) the contract owner is the Safe, NOT any EOA
// this process holds. A DEPLOYER_PRIVATE_KEY in the mainnet env is a standing reconfigure/drain vector with no
// legitimate use (the owner key must never live on the server), so refuse to start if one is present. Testnet
// (46630) is unaffected: DEPLOYER_PRIVATE_KEY is the allowed relayer fallback there (see RELAY_PK below).
if (PROD && process.env.DEPLOYER_PRIVATE_KEY) {
  console.error('[vault-standoff] FATAL (KH-1): DEPLOYER_PRIVATE_KEY is set on MAINNET (chain 4663). No deployer/owner key may be present in the production env — the contract owner is the Safe. Remove DEPLOYER_PRIVATE_KEY from the mainnet environment. Refusing to boot.');
  process.exit(1);
}
// MAINNET HARDENING: on 4663 the signer key, escrow address, token, entry, mode and the enable switch come
// ONLY from sealed env, never from the git-excluded flat files (.escrow.local.json / .escrow-signer.key),
// which exist for the testnet dry run only. This removes the plaintext-key-on-disk exfil path in production.
const ADDR = PROD ? (process.env.VS_ESCROW_ADDR || PROD_CFG.addr) : (LOCAL.addr || process.env.VS_ESCROW_ADDR || '');
// SETTLEMENT SIGNER: a DEDICATED key, env-only, used ONLY to call settle/void/commit on StandoffEscrow. The
// former `OPERATOR_PK` fallback is REMOVED on purpose: the settlement signer must hold NO other role (it is not
// the deployer/owner, not the rake receiver, not any game wallet) so a leak of it cannot drain or reconfigure
// anything beyond the bounded settle path the audited contract already constrains (winners-are-participants,
// sum == pot - rake). OPS: fund this signer with gas and MONITOR its balance; a gasless signer stalls settles.
// Settlement signer key. Primary env name is VS_ESCROW_SIGNER_PK; STANDOFF_SIGNER is accepted as a fallback because
// that is the secret name the key was saved under in the dashboard (same key either way; boot parity-check asserts the
// derived address == the on-chain settlementSigner, so a wrong value can't silently be used).
const PK = PROD ? (process.env.VS_ESCROW_SIGNER_PK || process.env.STANDOFF_SIGNER || '')
                : (LOCAL_PK || process.env.VS_ESCROW_SIGNER_PK || process.env.STANDOFF_SIGNER || '');
const RPC = (PROD ? '' : LOCAL.rpc) || process.env.VS_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const RVLT = (PROD ? '' : LOCAL.rvlt) || process.env.VS_RVLT || '0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04';
const ENTRY_WEI = String((PROD ? '' : LOCAL.entryWei) || process.env.VS_ENTRY_WEI || (PROD ? PROD_CFG.entryWei : '0'));
const MODE_OVERRIDE = (PROD ? '' : LOCAL.mode) || process.env.VS_MODE_ESCROW || (PROD ? PROD_CFG.mode : '');
const ON = (((!PROD && LOCAL.on === true) || process.env.VS_ESCROW === 'on' || (PROD && PROD_CFG.on && process.env.VS_ESCROW !== 'off'))) && !!ADDR && !!PK;

const ABI = [
  'function openRound(uint256 id,uint128 entry,uint64 lockTime,uint64 deadline)',
  // V2: fill-driven close. Signer moves a still-Open round's lockTime to now so buyIn reverts and commit opens.
  'function lockRound(uint256 id)',
  'function commit(uint256 id,bytes32 seedHash)',
  'function settle(uint256 id,bytes32 seed,address[] winners,uint256[] amounts)',
  'function voidRound(uint256 id)',
  // V5: progressive jackpot + auto-send. rolloverRound = final-vault mutual-bust -> pot into the jackpot (no winner);
  // payWinners = push the settled payout to winners after the challenge window (auto-send, no claim click).
  'function rolloverRound(uint256 id,bytes32 seed)',
  'function payWinners(uint256 id,address[] ws)',
  'function payRake(uint256 id)',   // sends rake (burn + treasury split) after the challenge window; anyone may call
  'function jackpot() view returns (uint256)',
  // V3 round struct: rakeBpsSnap (10th) + burnShareSnap (11th). Decode both so reads stay in sync with the ABI.
  // L-4: rounds() index [10] is burnShareSnap and is intentionally unused server-side -- the contract applies the
  // burn split internally at settle, so settleEqualSplit never reads or re-derives it (no server-side burn math).
  'function rounds(uint256) view returns (uint128 entry,uint128 pot,uint128 rakeOwed,uint64 lockTime,uint64 deadline,uint64 claimAt,bool rakePaid,bytes32 seedHash,uint8 status,uint16 rakeBpsSnap,uint16 burnShareSnap)',
  'function tickets(uint256,address) view returns (uint256)',
  'function rakeBps() view returns (uint16)',
  // GAP-B parity self-check reads (read-only): token (RVLT), settlementSigner (the on-chain settle authority),
  // burnShareBps (rake burn/treasury split, read for the accurate metrics display AD-1).
  'function token() view returns (address)',
  'function settlementSigner() view returns (address)',
  'function burnShareBps() view returns (uint16)',
  // V4 PRE-FLIGHT reads. entryPriceFor(id,a) is the EXACT per-ticket RVLT a given wallet is charged on a round
  // (already halves for a holder via the contract's _ticketPrice), so it is the single source of truth for the
  // required deliver amount. maxTicketsPerWallet is the global on-chain per-wallet cap (0 = unlimited); buyIn is
  // simulated with staticCall to catch any OTHER state revert before a swap commits.
  'function entryPriceFor(uint256 id,address a) view returns (uint256)',
  // V4 holder-discount config (owner-set via the Safe). holderNft==0 => discount OFF (everyone full price).
  // These are read-only so the client pricing endpoint can reconcile VS_NFT_ADDR with the on-chain NFT and
  // surface the exact discount in effect (0 bps = not yet enabled).
  'function holderNft() view returns (address)',
  'function holderDiscountBps() view returns (uint16)',
  'function isHolder(address a) view returns (bool)',
  'function maxTicketsPerWallet() view returns (uint128)',
  'function buyIn(uint256 id,uint256 nTickets)',
  // V2 auto-buy: relayer submits a player's EIP-712 AutoBuy authorization. Replay-safe per-player nonce.
  'function buyInFor(uint256 id,address player,uint256 nTickets,uint256 maxTickets,uint256 maxEntry,uint256 deadline,uint256 nonce,bytes sig)',
  // V6: ONE range signature covers many rounds; relayer submits this per round. Cuts a multi-game deposit to 1 sig.
  'function buyInForRange(uint256 id,address player,uint256 nTickets,uint256 roundStart,uint256 roundCount,uint256 maxTickets,uint256 maxEntry,uint256 nonce,uint256 deadline,bytes sig)',
  'function invalidateAutoBuy()',
  'function rangeSpent(address,uint256) view returns (bool)',
  'function autoBuyNonce(address) view returns (uint256)',
  'function domainSeparatorV4() view returns (bytes32)',
  'function relayer() view returns (address)',
];

// Minimal ERC-721 surface for holder detection: balanceOf only. READ-ONLY — there is no ERC-20 WRITE path.
const ERC721_ABI = ['function balanceOf(address) view returns (uint256)'];

function normPk(k) { return k && (k.startsWith('0x') ? k : '0x' + k); }

// ---- H2 RPC RESILIENCE (Robinhood 4663 has no dedicated/paid endpoint; use REDUNDANCY across the free public RPCs) ----
// READ path: an ethers v6 FallbackProvider across the known-good public endpoints (quorum 1) so a 429/timeout on one
// falls through to the next. Each sub-provider pins the static 4663 network (no per-call eth_chainId) and disables
// request batching (batchMaxCount:1) because Robinhood throttles batched calls. VS_RPC (if set) is tried FIRST so Jake
// can later point the primary at a paid dedicated endpoint; VS_READ_RPCS can override the whole comma-separated list.
// SEND path (MONEY-SAFETY): the signer + relayer stay on a SINGLE JsonRpcProvider (VS_RPC or the official endpoint) so a
// state-changing tx is NEVER broadcast across multiple backends (no nonce races / double-broadcast). Same static
// network + no batching for robustness. ethers' own transient-error handling covers retries on this single endpoint.
const RH_PUBLIC_RPCS = ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com', 'https://robinhood.drpc.org'];
function _mkJsonRpc(url) { return new ethers.JsonRpcProvider(url, CHAIN, { staticNetwork: ethers.Network.from(CHAIN), batchMaxCount: 1 }); }
function _mkSendProvider() { return _mkJsonRpc(RPC); }   // SINGLE endpoint for sends (VS_RPC override, else official)
function _mkReadProvider() {
  // Only the mainnet (4663) public RPC set is valid; on testnet (46630) fall back to the single configured RPC.
  if (CHAIN !== 4663) return _mkJsonRpc(RPC);
  const urls = [];
  const envList = (process.env.VS_READ_RPCS || '').split(',').map(s => s.trim()).filter(Boolean);
  [RPC, ...(envList.length ? envList : RH_PUBLIC_RPCS)].forEach(u => { if (u && urls.indexOf(u) < 0) urls.push(u); });
  if (urls.length <= 1) return _mkJsonRpc(urls[0] || RPC);
  const configs = urls.map((u, i) => ({ provider: _mkJsonRpc(u), priority: i + 1, weight: 1, stallTimeout: 2000 }));
  return new ethers.FallbackProvider(configs, ethers.Network.from(CHAIN), { quorum: 1 });
}
// H2 LIGHT READ CACHE: a short-TTL memo for the hot pre-flight reads a buy BURST would otherwise multiply (every polling
// client hits entryPriceFor + the per-wallet cap). The money-critical seat/lock inputs (ticketsOf, round pot/status)
// are deliberately LEFT UNCACHED so seating + the lock gate always see fresh on-chain truth. Errors are never cached.
const _roMemo = new Map();
async function _memo(key, ttlMs, fn) {
  const now = Date.now(); const hit = _roMemo.get(key);
  if (hit && hit.exp > now) return hit.v;
  const v = await fn();
  _roMemo.set(key, { v, exp: now + ttlMs });
  if (_roMemo.size > 4000) { for (const k of _roMemo.keys()) { _roMemo.delete(k); if (_roMemo.size <= 2000) break; } }
  return v;
}

let _ct = null;
function ct() {
  if (!ON) return null;
  if (!_ct) {
    const provider = _mkSendProvider();   // H2: single-endpoint send provider (no FallbackProvider on the signer path)
    const wallet = new ethers.Wallet(normPk(PK), provider);
    _ct = new ethers.Contract(ADDR, ABI, wallet);
  }
  return _ct;
}

// ---- HOLDER DETECTION (read-only, mainnet NFT) -----------------------------------------------------------
// The Vault Robbers NFT is an ERC-721 on Robinhood MAINNET (4663). The holder discount is charged ON-CHAIN at
// buy time (V4 entryPriceFor halves the per-ticket price for a holder), so the escrow pot receives the already
// discounted amount; this off-chain read is used ONLY to tell the client whether to show the discounted price
// before they buy. It MUST reference the same NFT the contract uses for the discount (holderNft). This provider
// is READ-ONLY to mainnet and NEVER signs. A VS_HOLDER_ALLOWLIST env override lets testnet wallets exercise the
// client-side price display (the authoritative charge still comes from the contract's entryPriceFor).
// Precedence: env (sealed, used on MAINNET) > .escrow.local.json (TESTNET ONLY, !PROD) > mainnet default. This lets
// the testnet config point holder lookups at a mock Vault Robber NFT on 46630 so the $5 display matches the
// contract's on-chain charge during staging. On PROD the local-file fallback is disabled (env is the only source).
const HOLDER_RPC = process.env.VS_HOLDER_RPC || (!PROD && LOCAL.holderRpc) || 'https://rpc.mainnet.chain.robinhood.com';
const HOLDER_CHAIN = parseInt(process.env.VS_HOLDER_CHAINID || (!PROD && LOCAL.holderChainId) || '4663', 10);
const NFT_ADDR = process.env.VS_NFT_ADDR || (!PROD && LOCAL.nft) || '0xABC6c4F5d1F31326b419c2645C981743a845313a';
const HOLDER_ALLOWLIST = new Set(String(process.env.VS_HOLDER_ALLOWLIST || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(a => /^0x[0-9a-fA-F]{40}$/.test(a)));
let _holderProv = null, _nftCt = null;
function holderProvider() { if (!_holderProv) _holderProv = new ethers.JsonRpcProvider(HOLDER_RPC, HOLDER_CHAIN); return _holderProv; }
function nftCt() { if (!_nftCt) { try { _nftCt = new ethers.Contract(ethers.getAddress(NFT_ADDR), ERC721_ABI, holderProvider()); } catch (_) { _nftCt = null; } } return _nftCt; }
// Per-wallet holder cache (~10 min TTL) so a round boundary doesn't hammer the mainnet RPC.
const _holderCache = new Map();   // addr(lower) -> { holder:bool, at:ms }
// Testnet uses a short cache so a freshly minted test NFT reflects in the $5 display within seconds (floor 60s on PROD).
const HOLDER_TTL = Math.max(PROD ? 60000 : 3000, parseInt(process.env.VS_HOLDER_TTL_MS || (!PROD && LOCAL.holderTtlMs) || '600000', 10) || 600000);
// Returns true if `wallet` holds >=1 Vault Robbers NFT (or is in the test allowlist). READ-ONLY; cached.
async function isHolder(wallet) {
  const a = (typeof wallet === 'string' && wallet.startsWith('w:')) ? wallet.slice(2) : wallet;
  if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  const key = a.toLowerCase();
  if (HOLDER_ALLOWLIST.has(key)) return true;         // TEST override (never set on mainnet)
  const now = Date.now(), c = _holderCache.get(key);
  if (c && now - c.at < HOLDER_TTL) return c.holder;
  try {
    const ct = nftCt(); if (!ct) return false;
    const bal = await ct.balanceOf(ethers.getAddress(a));
    const holder = bal > 0n;
    _holderCache.set(key, { holder, at: now });
    return holder;
  } catch (_) { if (c) return c.holder; return false; }   // on RPC error, serve the stale value if we have one
}
function holderConfig() { return { nft: NFT_ADDR, chainId: HOLDER_CHAIN, allowlistSize: HOLDER_ALLOWLIST.size, ttlMs: HOLDER_TTL }; }
// On-chain holder-discount CONFIG read (owner/Safe-set). Returns { nft, discountBps, enabled, matchesVsNft }.
// enabled == holderNft is a non-zero address AND discountBps>0 (the contract's "discount is live" condition).
// matchesVsNft asserts the contract's holderNft equals our VS_NFT_ADDR (they MUST be the same NFT); if they ever
// diverge this surfaces it so the client never shows a discount the contract won't actually charge. Cached ~60s.
let _discCfg = null, _discAt = 0;
async function holderDiscountConfig() {
  const now = Date.now();
  if (_discCfg && now - _discAt < 60000) return _discCfg;
  const out = { nft: null, discountBps: 0, enabled: false, matchesVsNft: null };
  try {
    const c = roCt(); if (!c) { return out; }
    const [nft, bps] = await Promise.all([ c.holderNft().catch(() => '0x0000000000000000000000000000000000000000'), c.holderDiscountBps().catch(() => 0) ]);
    out.nft = String(nft);
    out.discountBps = Number(bps) || 0;
    const zero = /^0x0{40}$/i.test(out.nft);
    out.enabled = !zero && out.discountBps > 0;
    try { out.matchesVsNft = !zero && ethers.getAddress(out.nft) === ethers.getAddress(NFT_ADDR); } catch (_) { out.matchesVsNft = false; }
    _discCfg = out; _discAt = now;
  } catch (_) {}
  return out;
}

// NOTE: the off-chain treasury-rebate payout was REMOVED. The holder discount is now charged ON-CHAIN at buy
// time (V4 _ticketPrice halves the per-ticket price for a Vault Robbers NFT holder), so there is no treasury
// key, no RVLT write wallet, and no rebate transfer here anymore. Holder detection below is READ-ONLY.

// ---- FEATURE 2: AUTO-BUY RELAYER (dedicated key, buyInFor) -------------------------------------------------
// SECURITY SIGN-OFF REQUIRED BEFORE MAINNET. Recurring auto-buy is a custody surface: the relayer submits a
// player's signed, BOUNDED EIP-712 AutoBuy authorization and the escrow pulls RVLT from the PLAYER (who has
// approve()'d the escrow for a BOUNDED allowance). The relayer can NEVER move funds to itself (buyInFor only
// does player->escrow; the pot exits only by settle-to-participants or refund). Still, a compromised relayer
// could force a player into authorized rounds up to their signed maxTickets/deadline — so:
//   * the relayer key is DEDICATED (VS_RELAY_PK), NOT the settlement signer, NOT the treasury, NOT an owner;
//   * the player must approve(escrow, boundedAllowance) — NEVER unlimited — so the blast radius is the allowance;
//   * mainnet go-live is GATED on a security review of this path + confirming the on-chain `relayer` slot points
//     at this exact key (owner/Safe sets it via setRelayer).
// For TESTNET we fall back to DEPLOYER_PRIVATE_KEY with a loud warning; the settlement signer is NEVER used.
const RELAY_PK = PROD ? (process.env.VS_RELAY_PK || '') : (process.env.VS_RELAY_PK || process.env.DEPLOYER_PRIVATE_KEY || LOCAL_PK || '');
const RELAY_PK_IS_FALLBACK = !process.env.VS_RELAY_PK && !!RELAY_PK;
if (RELAY_PK_IS_FALLBACK && ON) {
  console.warn('[vault-standoff] WARNING: VS_RELAY_PK not set; auto-buy relayer is using the testnet DEPLOYER/local key as a FALLBACK. This is for TESTNET ONLY. Provision a dedicated VS_RELAY_PK (env-only, NOT the settlement signer) before mainnet.');
}
// Refuse to ever reuse the settlement signer as the relayer (guards a mis-set env on any chain).
if (RELAY_PK && PK && normPk(RELAY_PK) && normPk(PK) && normPk(RELAY_PK).toLowerCase() === normPk(PK).toLowerCase()) {
  console.error('[vault-standoff] FATAL: VS_RELAY_PK must NOT equal the settlement signer key. Auto-buy relayer disabled.');
}
let _relayWallet = null, _relayCt = null;
// relayUsable(): the relayer is submittable only if (a) a dedicated relay key exists, (b) it is NOT the settlement
// signer, AND (c) the on-chain `relayer` slot is not a KNOWN mismatch. (c) uses the cached verdict (relayerSlotVerdict):
//   true  -> slot matches our key, usable.
//   null  -> not yet probed / transient RPC (OPTIMISTIC: don't block on an unproven slot at cold boot; the boot
//            assertRelayerSlot() + the per-arm fresh check in server.js both close the window).
//   false -> DEFINITIVE on-chain mismatch: the relayer was never set to our key, so EVERY buyInForRange reverts.
//            Block it here so autoBuyTick goes inert and /api/autobuy rejects arming instead of silently no-op'ing.
function relayUsable() {
  const base = !!(RELAY_PK && ADDR && (!PK || normPk(RELAY_PK).toLowerCase() !== normPk(PK).toLowerCase()));
  if (!base) return false;
  return relayerSlotVerdict() !== false;   // null/true pass; only a cleanly-read mismatch blocks
}
function relayWallet() {
  if (!relayUsable()) return null;
  if (!_relayWallet) { try { _relayWallet = new ethers.Wallet(normPk(RELAY_PK), _mkSendProvider()); } catch (_) { return null; } }   // H2: single-endpoint send provider (relayer never broadcasts across backends)
  return _relayWallet;
}
function relayContract() {
  const w = relayWallet(); if (!w) return null;
  if (!_relayCt) _relayCt = new ethers.Contract(ADDR, ABI, w);
  return _relayCt;
}
function relayAddress() { const w = relayWallet(); return w ? w.address : null; }
function relayIsFallback() { return RELAY_PK_IS_FALLBACK; }

// ---- RELAYER NONCE ALLOCATOR (SHARED by buyInForRange sends AND dripNativeTo) -------------------------------
// PARALLELIZATION SAFETY: the auto-buy tick now BROADCASTS the whole per-round batch concurrently (one burst, nonces
// base..base+N-1) instead of awaiting each receipt serially, so late players in a fast-filling round still make the
// lock window. Concurrent sends with ethers' implicit auto-nonce would collide (every pending send reads the same
// `pending` count), so the relayer wallet's next-nonce is managed explicitly here and SERIALIZED through a single
// in-memory allocator that BOTH the buy sends and the gas-drip draw from. That guarantees no two in-flight relayer
// txs are ever assigned the same nonce (the classic drip-vs-buy collision), while still letting them broadcast
// without waiting on each other's receipts.
//
// The allocator keeps a monotonically-increasing `_relayNextNonce` cursor. It is (re)synced from the chain's
// `pending` count whenever (a) it has never been seeded, (b) a caller forces a resync after a nonce error, or
// (c) it has gone stale (no allocation for a while) — so an externally-submitted relayer tx (there should be none,
// but defensively) or a server restart can never leave the cursor behind the chain. allocNonces() is the only
// writer and runs under a promise-chain mutex so concurrent callers in the same tick get a contiguous block.
let _relayNextNonce = null;        // next nonce to hand out (null = needs a fresh chain read)
let _relayNonceAt = 0;             // ts of the last allocation (staleness check)
let _relayNonceLock = Promise.resolve();   // serializes allocation so blocks never overlap
let _relayReseedLatest = false;    // when set, the next reseed reads 'latest' (MINED) not 'pending' -> deterministic gap-fill
const RELAY_NONCE_STALE_MS = 15000;   // if no allocation for >15s, reseed from chain before handing out (defensive)
// Force the next allocation to reseed from the chain's pending count (call after a nonce-too-low/high error).
function resetRelayNonce() { _relayNextNonce = null; }
// RISK#1 gap-fill: after a rejected send left a reserved-but-unbroadcast nonce (a gap), reseed from the MINED ('latest')
// nonce instead of 'pending'. 'latest' is node-independent (it ignores queued mempool txs sitting ABOVE the gap) and
// always points at the lowest unmined nonce, so the gapped nonce is re-broadcast instead of being skipped forever (the
// node-dependent 'pending' wedge). Money-safe: a rejected nonce never entered a block, and the on-chain rangeSpent
// mapping hard-blocks any double-buy if a re-send races an already-pending tx.
function resetRelayNonceToLatest() { _relayNextNonce = null; _relayReseedLatest = true; }
// Allocate `count` CONTIGUOUS nonces for the relayer wallet. Returns an array [n, n+1, ... n+count-1] or null if the
// relayer is unusable / the chain read failed (caller must then skip this tick, not guess a nonce). Serialized via
// the promise-chain mutex so two concurrent callers (e.g. a buy batch + a drip) never receive overlapping nonces.
async function allocNonces(count) {
  const n = Math.max(0, count | 0);
  if (n === 0) return [];
  const run = async () => {
    const w = relayWallet();
    if (!w) return null;
    const now = Date.now();
    // Reseed from chain if never seeded, explicitly reset, or stale. getTransactionCount('pending') counts all
    // mined + mempool txs for the address, so it is the correct base for the next not-yet-submitted nonce.
    if (_relayNextNonce == null || (now - _relayNonceAt) > RELAY_NONCE_STALE_MS) {
      let pend;
      // Default reseed reads 'pending' (counts our own in-flight). After a rejected-send gap we reseed from 'latest'
      // (mined) once, so the gapped nonce is re-broadcast rather than skipped (see resetRelayNonceToLatest).
      const _tag = _relayReseedLatest ? 'latest' : 'pending'; _relayReseedLatest = false;
      try { pend = await w.provider.getTransactionCount(w.address, _tag); }
      catch (_) { return null; }   // RPC blip: caller skips this tick (no guessed nonce ever submitted)
      // Never move the cursor BACKWARDS below what we've already handed out this session (a 'pending' read can
      // momentarily lag a just-broadcast tx the node hasn't accepted into its mempool view yet). Take the max.
      _relayNextNonce = (_relayNextNonce == null) ? pend : Math.max(_relayNextNonce, pend);
    }
    const base = _relayNextNonce;
    _relayNextNonce = base + n;     // reserve the block before releasing the lock
    _relayNonceAt = now;
    const out = []; for (let i = 0; i < n; i++) out.push(base + i);
    return out;
  };
  // chain onto the mutex: the allocation body runs only after any prior allocation resolves
  const p = _relayNonceLock.then(run, run);
  // keep the lock chain alive regardless of this allocation's outcome
  _relayNonceLock = p.then(() => {}, () => {});
  return p;
}
// Current on-chain per-player auto-buy nonce (what a fresh authorization must sign over). Read-only.
async function autoBuyNonce(player) { try { const c = roCt(); if (!c) return null; const n = await c.autoBuyNonce(ethers.getAddress(player)); return n.toString(); } catch (_) { return null; } }
// EIP-712 domain separator the client must sign under (chain + contract bound). Read-only.
async function domainSeparator() { try { const c = roCt(); if (!c) return null; return await c.domainSeparatorV4(); } catch (_) { return null; } }
// EIP-712 AutoBuy signing material a client needs for signTypedData(domain,types,value). The domain name +
// version are the StandoffEscrow contract's EIP712 constructor constants (OpenZeppelin EIP712 "StandoffEscrow"
// / "2"); they are FIXED per-deployment, not readable via a getter on this contract (it predates ERC-5267's
// eip712Domain()). They are asserted correct at boot in server.js by recomputing domainSeparatorV4() locally
// and comparing to the on-chain value, so a wrong constant can never be silently served. The typed-data field
// set + order below MUST match the on-chain AUTOBUY_TYPEHASH exactly (roundId first).
const EIP712_NAME = process.env.VS_EIP712_NAME || 'StandoffEscrow';
const EIP712_VERSION = process.env.VS_EIP712_VERSION || '2';
const AUTOBUY_TYPE_STRING = 'AutoBuy(uint256 roundId,address player,uint256 maxTickets,uint256 maxEntry,uint256 nonce,uint256 deadline)';
const AUTOBUY_TYPEHASH = ethers.keccak256(ethers.toUtf8Bytes(AUTOBUY_TYPE_STRING));
// The ethers v6 TypedData `types` object (no EIP712Domain entry; ethers injects it). Field order == typehash.
const AUTOBUY_TYPES = { AutoBuy: [
  { name: 'roundId', type: 'uint256' },
  { name: 'player', type: 'address' },
  { name: 'maxTickets', type: 'uint256' },
  { name: 'maxEntry', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] };
function eip712Domain() { return { name: EIP712_NAME, version: EIP712_VERSION, chainId: CHAIN, verifyingContract: ADDR || null }; }
function autobuyTypes() { return AUTOBUY_TYPES; }
function autobuyTypehash() { return AUTOBUY_TYPEHASH; }
// V6 RANGE auto-buy typed-data (field order MUST match AUTOBUY_RANGE_TYPEHASH in the contract: roundStart first).
const AUTOBUY_RANGE_TYPES = { AutoBuyRange: [
  { name: 'roundStart', type: 'uint256' },
  { name: 'roundCount', type: 'uint256' },
  { name: 'player', type: 'address' },
  { name: 'maxTickets', type: 'uint256' },
  { name: 'maxEntry', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] };
function autobuyRangeTypes() { return AUTOBUY_RANGE_TYPES; }
// Relayer submits a player's single RANGE authorization for one specific round `id` within [roundStart,roundStart+count).
// `opts` (optional):
//   opts.nonce  -> submit under this EXPLICIT relayer tx nonce (managed by the caller via allocNonces); omit to let
//                  ethers auto-nonce (legacy single-shot behavior).
//   opts.noWait -> do NOT await tx.wait() inline; broadcast only and RETURN { tx } (the ethers TransactionResponse) so
//                  the caller can track the receipt OFF the critical path (parallel batch broadcast). The caller MUST
//                  only commit rangeSpent after tx.wait() confirms.
// Default (no opts): unchanged — awaits the receipt and returns the tx hash string, or throws/returns null on failure.
async function buyInForRange(id, player, nTickets, roundStart, roundCount, maxTickets, maxEntry, nonce, deadline, sig, opts) {
  const c = relayContract(); if (!c) return null;
  const overrides = {};
  if (opts && opts.nonce != null) overrides.nonce = Number(opts.nonce);
  const tx = await c.buyInForRange(id, ethers.getAddress(player), nTickets, roundStart, roundCount, maxTickets, maxEntry, nonce, deadline, sig, overrides);
  if (opts && opts.noWait) return { tx };   // broadcast done; caller awaits tx.wait() off the critical path
  return (await tx.wait()).hash;
}
function autobuyTypeString() { return AUTOBUY_TYPE_STRING; }
// Boot assertion: recompute domainSeparatorV4 from our constants and compare to the on-chain value. If a
// deployment ever uses a different name/version, this surfaces it loudly instead of serving an unsignable domain.
async function assertDomain() {
  try {
    if (!ADDR) return { ok: false, reason: 'no escrow address' };
    const onchain = await domainSeparator(); if (!onchain) return { ok: false, reason: 'could not read on-chain domainSeparator' };
    const TH = ethers.keccak256(ethers.toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
    const local = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32','bytes32','bytes32','uint256','address'],
      [TH, ethers.keccak256(ethers.toUtf8Bytes(EIP712_NAME)), ethers.keccak256(ethers.toUtf8Bytes(EIP712_VERSION)), BigInt(CHAIN), ethers.getAddress(ADDR)]));
    return { ok: local.toLowerCase() === String(onchain).toLowerCase(), onchain, local };
  } catch (e) { return { ok: false, reason: e.message }; }
}
// The on-chain relayer slot (owner-set). Auto-buy only works if this equals relayAddress(). Read-only.
async function onchainRelayer() { try { const c = roCt(); if (!c) return null; return await c.relayer(); } catch (_) { return null; } }
// P0 RELAYER-SLOT GUARD. buyInForRange / buyInFor REVERT unless the on-chain `relayer` slot == our relay key's
// address (the contract gates msg.sender against that slot). The boot parity check asserts token + settlementSigner
// but NOT this, so if the Safe never ran setRelayer(ourKey) EVERY auto-buy would revert and autoBuyTick swallows
// it silently (.catch(()=>null)) — armed but never landing. This read-only probe compares the two and CACHES the
// result so relayUsable() (hot path, called every tick + per arm) can incorporate it without an RPC per call.
// Semantics:
//   null  => not yet determined / RPC unreadable (do NOT flip usable to false on a transient blip; keep last known)
//   true  => on-chain relayer == our relay address (auto-buy can land)
//   false => DEFINITIVE mismatch read cleanly from chain (auto-buy is a silent no-op; arming must be blocked)
// Refreshed lazily (~60s TTL) and eagerly at boot by assertRelayerSlot().
let _relaySlot = { ok: null, at: 0, onchain: null };
const RELAY_SLOT_TTL = 60000;
async function refreshRelayerSlot(force) {
  const now = Date.now();
  if (!force && _relaySlot.at && (now - _relaySlot.at) < RELAY_SLOT_TTL) return _relaySlot;
  const local = relayAddress();
  if (!local) { _relaySlot = { ok: null, at: now, onchain: _relaySlot.onchain }; return _relaySlot; }
  const onchain = await onchainRelayer();
  if (onchain == null) {
    // transient RPC failure: keep the prior verdict (don't let a blip disarm a correctly-set relayer), just stamp.
    _relaySlot = { ok: _relaySlot.ok, at: now, onchain: _relaySlot.onchain };
    return _relaySlot;
  }
  let ok = false;
  try { ok = ethers.getAddress(String(onchain)) === ethers.getAddress(local); } catch (_) { ok = false; }
  _relaySlot = { ok, at: now, onchain: String(onchain) };
  return _relaySlot;
}
// Synchronous accessor for the hot path. Returns the last cached verdict (null until first read). relayUsable()
// treats null as "not yet proven false" (optimistic) so a cold boot before the first probe doesn't block arming;
// assertRelayerSlot() runs at boot and the lazy TTL refresh keeps it current. Only a DEFINITIVE false blocks.
function relayerSlotVerdict() { return _relaySlot.ok; }
function relayerSlotOnchain() { return _relaySlot.onchain; }
// Submit a player's EIP-712 AutoBuy authorization for `nTickets` on round `id`. Bounds (maxTickets/maxEntry/
// deadline/nonce) are verified ON-CHAIN in buyInFor; this just relays. Returns the tx hash or null on failure.
async function buyInFor(id, auth, nTickets, opts) {
  const c = relayContract(); if (!c) return null;
  try {
    const overrides = {};
    if (opts && opts.nonce != null) overrides.nonce = Number(opts.nonce);
    const tx = await c.buyInFor(id, ethers.getAddress(auth.player), BigInt(nTickets),
      BigInt(auth.maxTickets), BigInt(auth.maxEntry), BigInt(auth.deadline), BigInt(auth.nonce), auth.sig, overrides);
    return (await tx.wait()).hash;
  } catch (e) {
    // surface nonce errors so the caller can reset the shared allocator (don't swallow them into the generic null).
    if (opts && opts.nonce != null) { const m = String((e && (e.shortMessage || e.message)) || ''); if (/nonce/i.test(m)) resetRelayNonce(); }
    return null;
  }
}
async function relayGasEth() { try { const a = relayAddress(); if (!a) return null; const b = await roProvider().getBalance(a); return Number(ethers.formatEther(b)); } catch (_) { return null; } }

// ---- GAS DRIP (relayer -> gas-short player) -----------------------------------------------------------------
// A TINY, BOUNDED native-4663 transfer from the RELAYER wallet (the key whose whole job is already to pay gas for
// this game) to a gas-short player so they can sign the approve/buyIn of a pay-any-token buy. This exists because
// a player already on Robinhood with zero native gas CANNOT be topped up via Relay: a same-chain 4663 native
// "send" is rejected by Relay ("Sender and recipient cannot be the same"), and any cross-chain delivery still
// requires the (gasless) player to sign+pay an origin deposit tx, which they can't. A direct relayer transfer is
// the only reliable mechanism. MONEY-SAFETY: the AMOUNT is bounded server-side (dripNativeTo ignores any caller
// value and uses DRIP_WEI), the balance is read on-chain before sending (skip if already funded), and the SERVER
// gates this to a SIWE-verified session + once-per-wallet + rate limits. This function does the on-chain send only;
// all gating lives in server.js. Returns { ok, tx?, skipped?, reason?, balWei?, wei? }.
// SERVER-BOUNDED drip amount. Default 0.0005 native (~a few cents on 4663 at ~$0.002/tx => ~many approve/buyIn txs).
// VS_GAS_DRIP_WEI overrides. A HARD CEILING (DRIP_WEI_MAX) caps a mis-set env so a fat-fingered value can never
// turn the drip into a drain: anything above the ceiling is clamped down to it (never raised).
const DRIP_WEI_MAX = 100000000000000n;   // 0.0001 native (ETH, ~$0.24) hard ceiling; also sets the relayer reserve (= *50 = 0.005 ETH). Native gas token on 4663 is ETH, so keep this small.
const DRIP_WEI = (function(){
  let v = 20000000000000n;   // 0.00002 native (ETH, ~$0.05) default = covers ~25 approve/buyIn txs. (Native gas is ETH; a tx is ~$0.002, so this is generous but cheap.)
  try { const e = process.env.VS_GAS_DRIP_WEI; if (e && /^\d+$/.test(String(e))) { const b = BigInt(e); if (b > 0n) v = b; } } catch (_) {}
  if (v > DRIP_WEI_MAX) v = DRIP_WEI_MAX;   // clamp down only, never up
  return v;
})();
// The gas-short threshold in WEI (match the client's ~0.0001 native "has gas" bar and the $0.25 reserve spirit).
// If the player already holds >= this, we send nothing. VS_GAS_DRIP_RESERVE_WEI overrides.
const DRIP_RESERVE_WEI = (function(){
  let v = 150000000000000n;   // 0.00015 native (~$0.25-ish on 4663, comfortably covers several txs)
  try { const e = process.env.VS_GAS_DRIP_RESERVE_WEI; if (e && /^\d+$/.test(String(e))) { const b = BigInt(e); if (b > 0n) v = b; } } catch (_) {}
  return v;
})();
function gasDripConfig() { return { wei: DRIP_WEI.toString(), reserveWei: DRIP_RESERVE_WEI.toString(), maxWei: DRIP_WEI_MAX.toString() }; }
// Read a player's on-chain native 4663 balance (read-only provider). Returns a wei BigInt, or null on error.
async function nativeBalanceWei(addr) {
  try { if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(String(addr))) return null; return await roProvider().getBalance(ethers.getAddress(addr)); }
  catch (_) { return null; }
}
// Send the BOUNDED native drip to `user` from the relayer wallet. Server is authoritative: this ALWAYS sends
// exactly DRIP_WEI (no caller-controlled amount). Skips (sends nothing) if the user already holds >= the reserve.
// Returns { ok, tx?, wei?, balWei?, skipped?, reason? }. Never throws; errors come back as { ok:false, reason }.
async function dripNativeTo(user) {
  try {
    if (!user || !/^0x[0-9a-fA-F]{40}$/.test(String(user))) return { ok: false, reason: 'bad user address' };
    const to = ethers.getAddress(user);
    const w = relayWallet();   // reuse the auto-buy relayer signer (dedicated key, already funded, pays game gas)
    if (!w) return { ok: false, reason: 'relayer not provisioned' };
    // ONLY drip when actually short: read the player's current native balance first.
    const bal = await nativeBalanceWei(to);
    if (bal == null) return { ok: false, reason: 'could not read user gas balance' };
    if (bal >= DRIP_RESERVE_WEI) return { ok: true, skipped: true, reason: 'already has gas', balWei: bal.toString() };
    // Guard the relayer's own gas: it must keep enough to cover the drip itself PLUS a buffer for its buyInForRange
    // duties. Refuse (don't half-drain the relayer) if its balance can't cover the drip + a working reserve.
    let relayBal = 0n;
    try { relayBal = await roProvider().getBalance(w.address); } catch (_) { return { ok: false, reason: 'could not read relayer balance' }; }
    const RELAY_MIN_RESERVE = DRIP_WEI_MAX * 50n;   // keep ~0.1 native working reserve for buyInForRange
    if (relayBal < DRIP_WEI + RELAY_MIN_RESERVE) return { ok: false, reason: 'relayer low on gas' };
    // NONCE-COORDINATE with the auto-buy batch: draw this drip's nonce from the SAME shared allocator the
    // buyInForRange sends use, so a drip can NEVER grab the same pending nonce as an in-flight buy (the collision
    // this build fixes). On a nonce error we reset + the caller (server) retries; here we reset so the next drip
    // reseeds. If allocation fails (RPC blip) fall back to ethers auto-nonce rather than block the drip entirely.
    let dripNonce = null;
    try { const alloc = await allocNonces(1); if (alloc && alloc.length) dripNonce = alloc[0]; } catch (_) { dripNonce = null; }
    const sendOpts = { to, value: DRIP_WEI };
    if (dripNonce != null) sendOpts.nonce = dripNonce;
    let tx;
    try { tx = await w.sendTransaction(sendOpts); }
    catch (e) {
      // a nonce collision/stale allocator surfaces here: reset so the next alloc reseeds from chain, then report.
      resetRelayNonce();
      return { ok: false, reason: (e && (e.shortMessage || e.message)) || 'drip send failed' };
    }
    const rec = await tx.wait();
    return { ok: true, tx: (rec && rec.hash) || tx.hash, wei: DRIP_WEI.toString(), balWei: bal.toString() };
  } catch (e) { return { ok: false, reason: (e && (e.shortMessage || e.message)) || 'drip failed' }; }
}

// ---- HIGH-4: KEY-SEPARATION BOOT GUARD ---------------------------------------------------------------------
// The three privileged roles MUST be distinct keys so a leak of any one has a bounded blast radius:
//   signer   = settlement signer (settle/void/commit only; VS_ESCROW_SIGNER_PK)
//   relayer  = auto-buy relayer (buyInFor only; VS_RELAY_PK)
//   owner    = deployer/owner (can reconfigure the contract; DEPLOYER_PRIVATE_KEY on testnet)
// On PROD (mainnet 4663) ANY collapse of these roles is FATAL (the server refuses to boot / disables the paths).
// On testnet (46630) a shared key is tolerated for the dry run but logs a LOUD warning naming the collapsed roles.
function _addrOfPk(k) { try { if (!k) return null; return new ethers.Wallet(normPk(k)).address.toLowerCase(); } catch (_) { return null; } }
// Resolve the owner/deployer key the same way the relayer fallback does (testnet: DEPLOYER_PRIVATE_KEY).
const OWNER_PK = process.env.DEPLOYER_PRIVATE_KEY || (PROD ? '' : LOCAL_PK || '');
// Compute the collision report (same logic both chains; the CALLER decides fatal-vs-warn based on PROD).
function keySeparationReport() {
  const roles = { signer: _addrOfPk(PK), relayer: _addrOfPk(RELAY_PK), owner: _addrOfPk(OWNER_PK) };
  const collisions = [];
  const names = Object.keys(roles);
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const a = names[i], b = names[j];
    if (roles[a] && roles[b] && roles[a] === roles[b]) collisions.push({ a, b, addr: roles[a] });
  }
  return { prod: PROD, roles, collisions, clean: collisions.length === 0 };
}

function isOn() { return ON; }
function entryWei() { return ENTRY_WEI; }
function modeOverride() { return MODE_OVERRIDE; }
// OPERATOR VOID GRACE (anti-griefing SLA): after a round's on-chain deadline passes, the contract may allow a
// PUBLIC void (so funds are never permanently stuck). That public path is a griefing vector: an outsider can
// void a round the operator is a few seconds from settling. The operator commits to settling-or-voiding every
// round within this window of the deadline; the intent is that the contract's public-void only opens AFTER it.
// Raising the contract's challenge window + adding a guardian-void role are owner/deploy-time settings (held
// for go-live, see report). This constant documents the off-chain SLA the settle-watcher is held to.
const VOID_GRACE_SEC = Math.max(60, parseInt(process.env.VS_VOID_GRACE_SEC || '900', 10) || 900);  // default 15m
function voidGraceSec() { return VOID_GRACE_SEC; }
function config() { return { on: ON, address: ON ? ADDR : null, chainId: CHAIN, rvlt: RVLT, entry: ON ? ENTRY_WEI : '0', voidGraceSec: VOID_GRACE_SEC }; }
// A fresh 32-byte seed; commit hash = keccak256(seed) to match the contract's keccak256(abi.encodePacked(seed)).
function newSeed() { const seed = '0x' + crypto.randomBytes(32).toString('hex'); return { seed, hash: ethers.keccak256(seed) }; }

// ---- SEC-1: OFF-CHAIN SIGNED SEED PRE-COMMIT (provable fairness) -------------------------------------------
// At round OPEN the server fixes the round's seed and must PUBLICLY BIND itself to that seed's hash BEFORE buy-in
// opens — so a malicious operator cannot grind/re-roll the seed after seeing who bought in to favor a chosen
// paying wallet. The on-chain commit (commit(id,seedHash)) only happens at LOCK (after the roster is known), so it
// cannot provide that early binding. This adds an EARLY, public, cryptographic commitment: the settlement signer
// signs a canonical tuple over the seedHash + openedAt the instant the seed is fixed. It is a MESSAGE SIGNATURE
// ONLY (EIP-191 personal_sign via wallet.signMessage) — NO transaction, NO gas, NO on-chain state change — so it
// never touches the money path. The RAW SEED is NEVER signed, logged, or exposed here; only its keccak256 hash.
//
// Canonical signed message (pipe-delimited, order-fixed, self-contained for independent verification):
//   VaultStandoff|precommit|<chainId>|<escrowAddr>|<roundId>|<seedHash>|<openedAt>
// where seedHash = keccak256(seed) (the SAME hash committed on-chain at lock) and openedAt = server time (ms).
// A verifier recomputes this string and calls ethers.verifyMessage(msg, sig) === signerAddress() to confirm the
// operator was bound to this exact seedHash at this exact openedAt before any pick was made; at settle they also
// check keccak256(revealedSeed) === seedHash. The signer address + the exact message are published alongside.
const PRECOMMIT_TAG = 'VaultStandoff|precommit';
function precommitMessage(roundId, seedHash, openedAt) {
  // escrow address may be unset on a fully-disabled testnet; include it as-is (lower-cased for a canonical string).
  const esc = ADDR ? String(ADDR).toLowerCase() : '';
  return [PRECOMMIT_TAG, String(CHAIN), esc, String(roundId), String(seedHash).toLowerCase(), String(openedAt)].join('|');
}
// Produce the signed pre-commit for a round. READ-ONLY: builds a keyless provider-less Wallet from the settlement
// signer key purely to sign a message (no RPC, no tx, no nonce, no gas). Returns
//   { roundId, seedHash, openedAt, chainId, escrow, signer, sig, message }
// or null if signing is unavailable (no key / sign error) so the caller degrades gracefully and still opens the
// round. NEVER logs or returns the private key or the raw seed. `openedAt` is supplied by the caller so the value
// signed is the exact persisted value (idempotent across restarts — the caller reuses a stored openedAt).
// FIX 5 (design hardening): the seed PRE-COMMIT should be signed with a DEDICATED key, not the settlement signer. As
// long as signPrecommit reuses VS_ESCROW_SIGNER_PK, the fairness binding (operator committed to keccak256(seed) BEFORE
// seeing the roster) only holds while that single settlement key stays secret — a leak of the settlement key would also
// let an attacker forge pre-commits. A separate VS_PRECOMMIT_PK decouples the two: the pre-commit remains verifiable
// (its own published signer address) even if the settlement key is ever rotated/compromised, and vice-versa. We FALL
// BACK to the settlement key when VS_PRECOMMIT_PK is unset so nothing breaks today (the binding still holds under the
// current single-key secrecy assumption). OPS: set a dedicated VS_PRECOMMIT_PK (env-only, its own fresh keypair, NOT
// the settlement signer / relayer / owner) BEFORE launch so the pre-commit binding is independent of the settle key.
const PRECOMMIT_PK = process.env.VS_PRECOMMIT_PK || PK;
async function signPrecommit(roundId, seedHash, openedAt) {
  try {
    if (!PRECOMMIT_PK || !seedHash) return null;
    // A Wallet with NO provider: signMessage is a pure local ECDSA op (no network, no gas, no tx). Uses the dedicated
    // pre-commit key when VS_PRECOMMIT_PK is provisioned, else falls back to the settlement signer (see note above).
    const w = new ethers.Wallet(normPk(PRECOMMIT_PK));
    const message = precommitMessage(roundId, seedHash, openedAt);
    const sig = await w.signMessage(message);
    return {
      roundId: String(roundId),
      seedHash: String(seedHash).toLowerCase(),
      openedAt: Number(openedAt),
      chainId: CHAIN,
      escrow: ADDR ? String(ADDR) : null,
      signer: w.address,
      sig,
      message,
    };
  } catch (_) { return null; }
}
// Independent verification helper (read-only): recompute the canonical message and recover the signer, returning
// true iff it matches `signer` and the message components match. Used by /proof to self-assert the stored sig.
function verifyPrecommit(pc) {
  try {
    if (!pc || !pc.sig || !pc.signer || !pc.seedHash || pc.openedAt == null) return false;
    const message = pc.message || precommitMessage(pc.roundId, pc.seedHash, pc.openedAt);
    const rec = ethers.verifyMessage(message, pc.sig);
    return ethers.getAddress(rec) === ethers.getAddress(pc.signer);
  } catch (_) { return false; }
}
function addrOfToken(tok) { return (typeof tok === 'string' && tok.startsWith('w:')) ? ethers.getAddress(tok.slice(2)) : null; }

async function openRound(id, entryWei, lockTs, deadlineTs) {
  const c = ct(); if (!c) return null;
  const tx = await c.openRound(id, entryWei, lockTs, deadlineTs); return (await tx.wait()).hash;
}
// V2 THRESHOLD-FILL: close buy-in NOW for a still-Open round by moving its lockTime to the current block.
// Signer-only on-chain; the contract refuses to move the lock later (only earlier), so this can never re-open
// or extend buy-in. Returns the tx hash, or null if it reverts (e.g. not Open, or lockTime already passed).
async function lockRound(id) { const c = ct(); if (!c) return null; const tx = await c.lockRound(id); return (await tx.wait()).hash; }
async function commit(id, seedHash) { const c = ct(); if (!c) return null; const tx = await c.commit(id, seedHash); return (await tx.wait()).hash; }
async function readRound(id) { const c = roCt(); if (!c) return null; const r = await c.rounds(id); return { entry: r[0], pot: r[1], lockTime: Number(r[3]), deadline: Number(r[4]), status: Number(r[8]) }; }   // H2: read via the FallbackProvider (failover), not the signer provider
// On-chain truth for whether the rake was already swept (rounds struct field 6). Lets the keeper confirm against
// chain state before dropping a rake when payRake reverts with a CUSTOM error the string-match wouldn't catch.
async function rakePaidOf(id) { const c = roCt(); if (!c) return null; try { const r = await c.rounds(id); return !!r[6]; } catch (e) { return null; } }   // H2: read via FallbackProvider
// On-chain claimAt (unix s) for a round = when winners/rake become payable (settle time + challenge). 0 if unset.
// Used by the auto-payout keeper so it waits EXACTLY the configured challenge window (any value), not a hardcoded 300s.
async function claimAtOf(id) { try { const c = roCt(); if (!c) return 0; const r = await c.rounds(id); return Number(r[5]); } catch (_) { return 0; } }
async function isParticipant(id, addr) { const c = roCt(); if (!c || !addr) return false; try { return (await c.tickets(id, addr)) > 0n; } catch { return false; } }   // H2: read via FallbackProvider
// Coupling reads: how many tickets an address bought on-chain for a round, and the round's real escrow pot (in RVLT).
// H2: read via the FallbackProvider (failover across the public RH RPCs). NOT memoized -- this is the authoritative
// seat/lock-gate input and must always reflect fresh on-chain truth so a just-landed buy seats without delay.
async function ticketsOf(id, addr) { const c = roCt(); if (!c || !addr) return 0; try { return Number(await c.tickets(id, addr)); } catch { return 0; } }
async function potRvlt(id) { const c = roCt(); if (!c) return 0; try { const r = await c.rounds(id); return Number(ethers.formatUnits(r[1], 18)); } catch { return 0; } }

// ---- PRE-FLIGHT READS (buy-before-swap safety; read-only, no signer required) ----------------------------
// SINGLE SOURCE OF TRUTH for "how much RVLT this wallet must deliver to buy `nTickets` into round `id`". Reads
// the contract's entryPriceFor(id, addr) — which ALREADY applies the holder discount on-chain (V4 _ticketPrice
// halves for a Vault Robbers NFT holder) — and multiplies by the ticket count. Returns a wei string. Falls back
// to the plain entryWei() * tickets ONLY if the per-address price read fails (older contract / RPC blip), so the
// quote is never understated. Because the amount comes from the on-chain price, the per-holder 50% discount
// work needs NO change here: the instant holderDiscountBps/holderNft are set on-chain, this returns the halved
// amount automatically. `addr` may be null (then the generic non-holder entry is used).
async function requiredRvltWei(id, nTickets, addr) {
  const n = BigInt(Math.max(1, parseInt(nTickets, 10) || 1));
  const c = roCt();
  if (c && addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) {
    // H2: memo the per-(round,addr) price for 4s. The per-ticket price only changes with holder status (effectively
    // static within a round), so a buy burst of polling clients shares one read instead of one RPC per poll. We cache
    // the UNIT price and multiply by n after, so any ticket count reuses the same memo. Errors fall through (never cached).
    try { const price = await _memo('ep:' + id + ':' + addr.toLowerCase(), 4000, () => c.entryPriceFor(id, ethers.getAddress(addr))); if (price > 0n) return (price * n).toString(); } catch (_) {}
  }
  return (BigInt(ENTRY_WEI || '0') * n).toString();   // fallback: full entry (never under-quote)
}
// Full round-state read for the pre-flight: status + lockTime + deadline + the global per-wallet cap, all from
// one place so the server can reason about "open? how close to lock? room under the cap?" before a swap.
async function preflightState(id) {
  const c = roCt(); if (!c) return null;
  try {
    // H2: the round struct read stays LIVE (status/lockTime gate the buy and must be fresh), but the global per-wallet
    // cap is config that changes only via an owner tx, so memo it for 10s to shave an RPC off every pre-flight in a burst.
    const [r, cap] = await Promise.all([ c.rounds(id), _memo('cap', 10000, () => c.maxTicketsPerWallet().catch(() => 0n)) ]);
    return { entry: r[0], pot: r[1], lockTime: Number(r[3]), deadline: Number(r[4]), status: Number(r[8]), walletCap: Number(cap || 0n) };
  } catch (_) { return null; }
}
// STATIC SIMULATION of buyIn(id, nTickets) as `from`. This reproduces the contract's state guards (status==Open,
// block.timestamp < lockTime, ticket bounds, per-wallet cap) via eth_call. The token pull (safeTransferFrom)
// WILL revert here because `from` holds no RVLT / hasn't approved — that is EXPECTED and is NOT a state failure.
// So we classify: a revert whose reason is a known STATE guard ("not open" / "locked" / "wallet cap" / "bad
// tickets") is a hard fail; a revert that looks like an ERC-20 transfer/allowance failure is treated as "state
// OK" (the swap will give them the balance + the client approves before buyIn). Returns {ok, reason}.
async function simulateBuyInState(id, nTickets, from) {
  const c = roCt(); if (!c) return { ok: true, reason: 'no-rpc' };   // can't simulate -> don't block (other checks still gate)
  try {
    await c.buyIn.staticCall(id, BigInt(Math.max(1, parseInt(nTickets, 10) || 1)), from && /^0x[0-9a-fA-F]{40}$/.test(from) ? { from: ethers.getAddress(from) } : {});
    return { ok: true, reason: 'ok' };   // would succeed outright (from happens to be funded/approved)
  } catch (e) {
    const msg = (e && (e.reason || e.shortMessage || e.message) || '').toLowerCase();
    if (/not open/.test(msg))    return { ok: false, reason: 'not_open' };
    // Contract _buyIn reverts the string "locked" when block.timestamp >= r.lockTime (round past its lock,
    // buy-in closed). Match the substring "locked" directly. (The earlier /\blocked\b/ was WRONG: \b is a word
    // boundary, so that pattern only matched the literal word "blocked", never "locked".)
    if (msg.includes('locked'))  return { ok: false, reason: 'round_locking' };
    if (/wallet cap/.test(msg))  return { ok: false, reason: 'cap_reached' };
    if (/bad tickets/.test(msg)) return { ok: false, reason: 'bad_tickets' };
    // ERC-20 transfer/allowance/balance reverts are EXPECTED (from isn't funded yet) -> state is fine.
    if (/transfer|allowance|balance|insufficient|erc20|exceeds/.test(msg)) return { ok: true, reason: 'funding-only-revert' };
    // OpenZeppelin v5 ERC-20 uses CUSTOM ERRORS (no string message), so the regex above misses a normal
    // not-yet-approved / underfunded wallet and it looked like an unknown revert — which blocked every UI buy-in
    // pre-flight. Detect the funding selectors from the revert DATA and treat them as expected funding reverts:
    //   ERC20InsufficientAllowance(address,uint256,uint256) = 0xfb8f41b2
    //   ERC20InsufficientBalance(address,uint256,uint256)   = 0xe450d38c
    let data = (e && (e.data || (e.info && e.info.error && e.info.error.data))) || '';
    if (!data) { const m = /0x[0-9a-fA-F]{8,}/.exec((e && e.message) || ''); if (m) data = m[0]; }
    data = String(data).toLowerCase();
    if (data.includes('fb8f41b2') || data.includes('e450d38c')) return { ok: true, reason: 'funding-only-revert' };
    // Unknown revert: fail closed (don't let a swap commit into an unexplained revert).
    return { ok: false, reason: 'sim_revert' };
  }
}

// Settle with the winners' ADDRESSES (must be on-chain participants) sharing pot-minus-rake equally.
// Returns the tx hash, or null if it can't settle (e.g. no real participant won -> caller should void/refund).
async function settleEqualSplit(id, seed, winnerAddrs) {
  const c = ct(); if (!c || !winnerAddrs.length) return null;
  const r = await c.rounds(id); const pot = r[1];
  if (pot === 0n) return null;
  // CRIT-1: the budget MUST use the round's SNAPSHOT rake (r.rakeBpsSnap, struct index [9]), captured on-chain
  // when the round opened — NOT the live rakeBps(), which the owner can change mid-round. The contract's settle()
  // computes its budget from r.rakeBpsSnap; if the server used the live rate after a mid-round setRake(), the
  // amounts would not sum to pot - r.rakeBpsSnap*pot/10000 and settle() would revert. Fall back to the live rate
  // ONLY for a legacy/pre-snapshot round whose snapshot is 0 (so old rounds can still settle).
  let effRake = Number(r[9]);                                      // rakeBpsSnap
  if (!(effRake > 0)) { try { effRake = Number(await c.rakeBps()); } catch (_) { effRake = 0; } }
  // V5: the contract's settle budget is pot - rake + jackpot (the progressive jackpot is WON by this round). Read the
  // live jackpot and fold it in so our amounts sum to EXACTLY pot - rake + jackpot, else settle() reverts. jackpot is
  // almost always 0 (budget == pot - rake, unchanged). Only this signer mutates jackpot (rollover/settle), serially,
  // so there is no concurrent-change race between this read and the settle tx.
  let jp = 0n; try { jp = await c.jackpot(); } catch (_) { jp = 0n; }
  const budget = pot - (pot * BigInt(effRake)) / 10000n + jp;
  const n = BigInt(winnerAddrs.length);
  const base = budget / n; const rem = budget - base * n;      // remainder to the first winner so sum == budget exactly
  const amounts = winnerAddrs.map((_, i) => i === 0 ? base + rem : base);
  const tx = await c.settle(id, seed, winnerAddrs, amounts); return (await tx.wait()).hash;
}
async function voidRound(id) { const c = ct(); if (!c) return null; const tx = await c.voidRound(id); return (await tx.wait()).hash; }
// V5: FINAL-VAULT ROLLOVER. The committed round ended with everybody busted -> its whole pot rolls into the
// persistent jackpot (no winner, no refund). Reveals the seed (provable) and marks the round RolledOver. Signer-only.
async function rolloverRound(id, seed) { const c = ct(); if (!c) return null; const tx = await c.rolloverRound(id, seed); return (await tx.wait()).hash; }
// V5: AUTO-SEND. Push the settled payout to winners after the challenge window so the winner never clicks "collect".
// Permissionless on-chain; we submit it from the settlement signer (has gas). Idempotent per winner on-chain.
async function payWinners(id, addrs) { const c = ct(); if (!c || !addrs || !addrs.length) return null; const tx = await c.payWinners(id, addrs); return (await tx.wait()).hash; }
// Pay the rake (burn + treasury split) for a settled round after the challenge window. Idempotent on-chain (reverts
// "rake paid" if already done); the keeper calls this alongside payWinners so the treasury receives rake automatically.
async function payRake(id) { const c = ct(); if (!c) return null; const tx = await c.payRake(id); return (await tx.wait()).hash; }
// V5: current progressive jackpot in human RVLT (read-only, no signer).
async function jackpotRvlt() { try { const c = roCt(); if (!c) return 0; const j = await c.jackpot(); return Number(ethers.formatUnits(j, 18)); } catch (_) { return 0; } }

// ---- READ-ONLY metrics (admin dashboard). A provider-only (no signer) path so these reads never require or
// touch the settlement key. Works whenever an ADDR + RPC are configured, even if ON is false, so the dashboard
// can still show chain context. NEVER writes, NEVER signs. ----
let _ro = null, _roc = null;
function roProvider() { if (!_ro) _ro = _mkReadProvider(); return _ro; }   // H2: FallbackProvider across the public RH RPCs (reads only)
function roCt() { if (!ADDR) return null; if (!_roc) _roc = new ethers.Contract(ADDR, ABI, roProvider()); return _roc; }
// FEATURE 2 (auto-play funding): READ-ONLY RVLT balance of an arbitrary wallet, used server-side by the fund-quote
// to size the convert-once shortfall. Uses the read-only provider + the configured RVLT token address (same token
// the escrow pulls from). Returns a wei string, or null on any error so the caller can fail safe (treat as 0 held,
// which never under-funds). NEVER signs, NEVER writes; this is a plain ERC-20 balanceOf.
const _ERC20_BAL_ABI = ['function balanceOf(address) view returns (uint256)'];
let _rvltRoCt = null;
async function rvltBalanceWei(wallet) {
  try {
    if (!RVLT || !/^0x[0-9a-fA-F]{40}$/.test(String(RVLT))) return null;
    if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(String(wallet))) return null;
    if (!_rvltRoCt) _rvltRoCt = new ethers.Contract(ethers.getAddress(RVLT), _ERC20_BAL_ABI, roProvider());
    const bal = await _rvltRoCt.balanceOf(ethers.getAddress(wallet));
    return bal.toString();
  } catch (_) { return null; }
}
// The settlement signer's public address (derived from the key for display only) — never exposes the key.
function signerAddress() { try { if (!PK) return null; return new ethers.Wallet(PK.startsWith('0x') ? PK : '0x' + PK).address; } catch (_) { return null; } }
// Signer gas balance in native ETH, read via the read-only provider (no key use beyond deriving the address).
async function signerGasEth() { try { const a = signerAddress(); if (!a) return null; const bal = await roProvider().getBalance(a); return Number(ethers.formatEther(bal)); } catch (_) { return null; } }
// Current rake basis points configured on the contract.
async function rakeBps() { try { const c = roCt(); if (!c) return null; return Number(await c.rakeBps()); } catch (_) { return null; } }
// AD-1: current burn share of the rake (bps). 0 == 100% of the rake to treasury (the live mainnet target). Used
// by the admin metrics to split the rake pool treasury-vs-burn accurately instead of a hardcoded 50/50. Read-only.
async function burnShareBps() { try { const c = roCt(); if (!c) return null; return Number(await c.burnShareBps()); } catch (_) { return null; } }
// GAP-B: ENV / ON-CHAIN PARITY SELF-CHECK (mainnet only). Read a few invariants off the live contract and assert
// they match the server's configuration before this process is allowed to settle real money. A TOKEN or SIGNER
// mismatch is DEFINITIVE and FATAL (the server would otherwise settle against the wrong token or with a key the
// contract won't accept); a rake/cap difference is only logged (owner-set values the server doesn't itself gate).
// A transient RPC error is a non-fatal warning (we never crash boot on a network blip; the mismatch must be
// read back cleanly to be fatal). Returns { ok, fatal, reason, reads } for the caller to act + log on.
async function parityCheck() {
  if (!PROD) return { ok: true, fatal: false, reason: 'testnet (skipped)' };
  const c = roCt();
  if (!c) return { ok: false, fatal: false, reason: 'no read-only contract (RPC/addr unavailable) — parity not verified' };
  let onToken, onSigner, onRake, onCap, onBurn;
  try {
    [onToken, onSigner, onRake, onCap, onBurn] = await Promise.all([
      c.token(), c.settlementSigner(), c.rakeBps(), c.maxTicketsPerWallet(), c.burnShareBps()
    ]);
  } catch (e) {
    return { ok: false, fatal: false, reason: 'parity reads failed (transient RPC?) — ' + (e && e.message || e) };
  }
  const reads = { token: String(onToken), settlementSigner: String(onSigner),
    rakeBps: Number(onRake), maxTicketsPerWallet: String(onCap), burnShareBps: Number(onBurn) };
  const mism = [];
  // token() must equal the configured RVLT.
  try { if (ethers.getAddress(String(onToken)) !== ethers.getAddress(RVLT)) mism.push('token ' + String(onToken) + ' != configured RVLT ' + RVLT); }
  catch (_) { mism.push('token address unparseable (on-chain=' + String(onToken) + ', cfg=' + RVLT + ')'); }
  // settlementSigner() must equal the address of VS_ESCROW_SIGNER_PK (the key this server settles with).
  const localSigner = signerAddress();
  try {
    if (!localSigner) mism.push('no local settlement signer key to compare against on-chain settlementSigner ' + String(onSigner));
    else if (ethers.getAddress(String(onSigner)) !== ethers.getAddress(localSigner)) mism.push('settlementSigner ' + String(onSigner) + ' != local signer ' + localSigner);
  } catch (_) { mism.push('settlementSigner address unparseable'); }
  if (mism.length) return { ok: false, fatal: true, reason: mism.join('; '), reads };
  return { ok: true, fatal: false, reads };
}
// P0: ON-CHAIN RELAYER-SLOT ASSERTION (boot). Reads escrow.relayer() and compares it to our relay key's address,
// then caches the verdict for relayUsable(). This is the slot the contract checks msg.sender against inside
// buyInForRange/buyInFor; if it was never set to our key, every auto-buy reverts silently. Returns
// { ok, fatal, reason, onchain, local }. On PROD with the escrow ON and a relay key present, a cleanly-read
// MISMATCH is FATAL-severity for auto-buy (same loudness as the key guards) but NON-fatal to boot (settle/void/
// manual buy still work — we just disable auto-buy via the cached false). A transient RPC error is a non-fatal
// warning (the slot can't be read back cleanly, so we don't disarm a possibly-correct relayer on a blip).
async function assertRelayerSlot() {
  const local = relayAddress();
  if (!local) return { ok: false, fatal: false, reason: 'no relay key provisioned (auto-buy off)', onchain: null, local: null };
  if (!ADDR) return { ok: false, fatal: false, reason: 'no escrow address', onchain: null, local };
  const s = await refreshRelayerSlot(true);
  if (s.onchain == null) return { ok: false, fatal: false, reason: 'could not read on-chain relayer() (transient RPC?) — slot not verified', onchain: null, local };
  if (s.ok) return { ok: true, fatal: false, onchain: s.onchain, local };
  // Definitive mismatch, read cleanly off-chain.
  return { ok: false, fatal: PROD, reason: 'on-chain relayer ' + s.onchain + ' != our relay key ' + local + ' — the Safe must run setRelayer(' + local + ') or auto-buy can never land', onchain: s.onchain, local };
}
// Full round read for the dashboard: entry/pot/rakeOwed/status in human units (read-only, no signer).
async function roundInfo(id) {
  try { const c = roCt(); if (!c) return null; const r = await c.rounds(id);
    return { entry: Number(ethers.formatUnits(r[0], 18)), pot: Number(ethers.formatUnits(r[1], 18)),
      rakeOwed: Number(ethers.formatUnits(r[2], 18)), lockTime: Number(r[3]), deadline: Number(r[4]),
      rakePaid: !!r[6], status: Number(r[8]) };
  } catch (_) { return null; }
}

module.exports = { isOn, entryWei, modeOverride, voidGraceSec, config, newSeed, addrOfToken, openRound, lockRound, commit, readRound, rakePaidOf, claimAtOf, isParticipant, ticketsOf, potRvlt, settleEqualSplit, voidRound, rolloverRound, payWinners, payRake, jackpotRvlt,
  // SEC-1: off-chain signed seed pre-commit (read-only message signature; no tx/gas; raw seed never exposed)
  signPrecommit, verifyPrecommit, precommitMessage,
  // pre-flight (buy-before-swap safety) + single-source-of-truth required-RVLT helper
  requiredRvltWei, preflightState, simulateBuyInState,
  signerAddress, signerGasEth, rakeBps, burnShareBps, roundInfo, keySeparationReport, parityCheck, rvltBalanceWei,
  // holder discount (applied ON-CHAIN at buy time via entryPriceFor; these are read-only helpers for the client)
  isHolder, holderConfig, holderDiscountConfig,
  // feature 2 (auto-buy relayer)
  buyInFor, buyInForRange, autobuyRangeTypes, autoBuyNonce, domainSeparator, onchainRelayer, relayAddress, relayIsFallback, relayUsable, relayGasEth,
  // relayer nonce allocator (shared by buy sends + gas drip) — managed nonces for concurrent broadcast
  allocNonces, resetRelayNonce, resetRelayNonceToLatest,
  // gas drip (relayer -> gas-short player; bounded native transfer so they can sign approve/buyIn)
  dripNativeTo, nativeBalanceWei, gasDripConfig,
  // P0 relayer-slot verification (boot assert + hot-path verdict + lazy refresh)
  assertRelayerSlot, refreshRelayerSlot, relayerSlotVerdict, relayerSlotOnchain,
  // feature 2 (EIP-712 signing material for the client)
  eip712Domain, autobuyTypes, autobuyTypehash, autobuyTypeString, assertDomain };
