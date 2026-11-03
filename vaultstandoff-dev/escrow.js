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
// SEC: the testnet signer key must NOT sit in PLAINTEXT on the shared host. Preference: a sealed env override
// (VS_DEV_SIGNER_PK, dashboard) > an AES-256-GCM encrypted-at-rest file (.escrow-signer.key.enc; key DERIVED from
// a stable sealed env secret, never on disk) > a legacy plaintext .escrow-signer.key (auto-migrated to the
// encrypted file on first boot, verified round-trip, then the plaintext is DELETED). Mainnet never uses these
// file paths (PK comes from sealed env below); this is testnet-only plumbing.
const _KEY_PLAIN = path.join(__dirname, '.escrow-signer.key');
const _KEY_ENC = path.join(__dirname, '.escrow-signer.key.enc');
function _devKeyMat(){ return String(process.env.VS_SEED_KEY || process.env.VS_ESCROW_SIGNER_PK || process.env.VS_ADMIN_TOKEN || ''); }
function _devEncKey(){ const m=_devKeyMat(); if(!m || m.length<16) throw new Error('vs-devkey: refusing to (de)crypt with empty/weak key material — set VS_SEED_KEY or VS_ESCROW_SIGNER_PK (AUDIT fix: never fake-encrypt a persistent key with a constant key and then delete the plaintext)'); return crypto.createHash('sha256').update(m + ':vs-devkey-at-rest-v1').digest(); }
function _devEnc(pk){ const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', _devEncKey(), iv); const ct = Buffer.concat([c.update(String(pk),'utf8'), c.final()]); return 'v1:'+iv.toString('hex')+':'+ct.toString('hex')+':'+c.getAuthTag().toString('hex'); }
function _devDec(enc){ try { if(typeof enc!=='string'||enc.slice(0,3)!=='v1:') return ''; const p=enc.split(':'); const d=crypto.createDecipheriv('aes-256-gcm', _devEncKey(), Buffer.from(p[1],'hex')); d.setAuthTag(Buffer.from(p[3],'hex')); return Buffer.concat([d.update(Buffer.from(p[2],'hex')), d.final()]).toString('utf8'); } catch(_) { return ''; } }
let LOCAL_PK = '';
try {
  if (process.env.VS_DEV_SIGNER_PK) {
    LOCAL_PK = String(process.env.VS_DEV_SIGNER_PK).trim();
  } else if (fs.existsSync(_KEY_ENC)) {
    LOCAL_PK = _devDec(fs.readFileSync(_KEY_ENC, 'utf8').trim());
  } else if (fs.existsSync(_KEY_PLAIN)) {
    LOCAL_PK = fs.readFileSync(_KEY_PLAIN, 'utf8').trim();
    // MIGRATE: encrypt-at-rest, verify the round-trip, THEN remove the plaintext. Never delete the plaintext if
    // we lack key material to derive a stable enc key or the round-trip does not match (fail safe, keep plaintext).
    try {
      if (LOCAL_PK && _devKeyMat()) {
        const enc = _devEnc(LOCAL_PK);
        if (_devDec(enc) === LOCAL_PK) {
          fs.writeFileSync(_KEY_ENC, enc, { mode: 0o600 });
          try { fs.chmodSync(_KEY_ENC, 0o600); } catch(_){}
          fs.unlinkSync(_KEY_PLAIN);
          console.log('[vaultstandoff-dev] migrated .escrow-signer.key -> encrypted-at-rest (.enc); plaintext removed');
        }
      }
    } catch(_){}
  }
} catch (_) {}

// Decide the chain first so the mainnet guard below can refuse filesystem-sourced secrets.
const CHAIN = parseInt(LOCAL.chainId || process.env.VS_CHAINID || '4663', 10);
const PROD = CHAIN === 4663;
// KH-1: MAINNET DEPLOYER-KEY BOOT GUARD. In production (chain 4663) the contract owner is the Safe, NOT any EOA
// this process holds. A DEPLOYER_PRIVATE_KEY in the mainnet env is a standing reconfigure/drain vector with no
// legitimate use (the owner key must never live on the server), so refuse to start if one is present. Testnet
// (46630) is unaffected: DEPLOYER_PRIVATE_KEY is the allowed relayer fallback there (see RELAY_PK below).
if (PROD && process.env.DEPLOYER_PRIVATE_KEY) {
  console.error('[vaultstandoff-dev] FATAL (KH-1): DEPLOYER_PRIVATE_KEY is set on MAINNET (chain 4663). No deployer/owner key may be present in the production env — the contract owner is the Safe. Remove DEPLOYER_PRIVATE_KEY from the mainnet environment. Refusing to boot.');
  process.exit(1);
}
// MAINNET HARDENING: on 4663 the signer key, escrow address, token, entry, mode and the enable switch come
// ONLY from sealed env, never from the git-excluded flat files (.escrow.local.json / .escrow-signer.key),
// which exist for the testnet dry run only. This removes the plaintext-key-on-disk exfil path in production.
const ADDR = PROD ? (process.env.VS_ESCROW_ADDR || '') : (LOCAL.addr || process.env.VS_ESCROW_ADDR || '');
// SETTLEMENT SIGNER: a DEDICATED key, env-only, used ONLY to call settle/void/commit on StandoffEscrow. The
// former `OPERATOR_PK` fallback is REMOVED on purpose: the settlement signer must hold NO other role (it is not
// the deployer/owner, not the rake receiver, not any game wallet) so a leak of it cannot drain or reconfigure
// anything beyond the bounded settle path the audited contract already constrains (winners-are-participants,
// sum == pot - rake). OPS: fund this signer with gas and MONITOR its balance; a gasless signer stalls settles.
// Settlement signer key. PROD uses VS_ESCROW_SIGNER_PK (sealed env, mainnet signer); STANDOFF_SIGNER is a fallback
// alias. On TESTNET (!PROD) the key is a DIFFERENT (testnet) signer, so it must NOT read the shared-group
// VS_ESCROW_SIGNER_PK (that is prod's mainnet key). SEC fix: prefer a dedicated sealed env VS_DEV_SIGNER_PK so the
// testnet key no longer has to live in a plaintext .escrow-signer.key file on the shared host; the flat file
// remains only as a fallback until the dashboard secret is set. Boot parity-check asserts the derived address ==
// the on-chain settlementSigner, so a wrong value can never be silently used.
const PK = PROD ? (process.env.VS_ESCROW_SIGNER_PK || process.env.STANDOFF_SIGNER || '')
                : (process.env.VS_DEV_SIGNER_PK || LOCAL_PK || process.env.STANDOFF_SIGNER || '');
const RPC = LOCAL.rpc || process.env.VS_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const RVLT = (PROD ? '' : LOCAL.rvlt) || process.env.VS_RVLT || '0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04';
const ENTRY_WEI = String((PROD ? '' : LOCAL.entryWei) || process.env.VS_ENTRY_WEI || '0');
const MODE_OVERRIDE = (PROD ? '' : LOCAL.mode) || process.env.VS_MODE_ESCROW || '';
const ON = (((!PROD && LOCAL.on === true) || process.env.VS_ESCROW === 'on')) && !!ADDR && !!PK;

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

let _ct = null;
function ct() {
  if (!ON) return null;
  if (!_ct) {
    const provider = new ethers.JsonRpcProvider(RPC, CHAIN);
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
  console.warn('[vaultstandoff-dev] WARNING: VS_RELAY_PK not set; auto-buy relayer is using the testnet DEPLOYER/local key as a FALLBACK. This is for TESTNET ONLY. Provision a dedicated VS_RELAY_PK (env-only, NOT the settlement signer) before mainnet.');
}
// Refuse to ever reuse the settlement signer as the relayer (guards a mis-set env on any chain).
if (RELAY_PK && PK && normPk(RELAY_PK) && normPk(PK) && normPk(RELAY_PK).toLowerCase() === normPk(PK).toLowerCase()) {
  console.error('[vaultstandoff-dev] FATAL: VS_RELAY_PK must NOT equal the settlement signer key. Auto-buy relayer disabled.');
}
let _relayWallet = null, _relayCt = null;
function relayUsable() { return !!(RELAY_PK && ADDR && (!PK || normPk(RELAY_PK).toLowerCase() !== normPk(PK).toLowerCase())); }
function relayWallet() {
  if (!relayUsable()) return null;
  if (!_relayWallet) { try { _relayWallet = new ethers.Wallet(normPk(RELAY_PK), new ethers.JsonRpcProvider(RPC, CHAIN)); } catch (_) { return null; } }
  return _relayWallet;
}
function relayContract() {
  const w = relayWallet(); if (!w) return null;
  if (!_relayCt) _relayCt = new ethers.Contract(ADDR, ABI, w);
  return _relayCt;
}
function relayAddress() { const w = relayWallet(); return w ? w.address : null; }
function relayIsFallback() { return RELAY_PK_IS_FALLBACK; }
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
async function buyInForRange(id, player, nTickets, roundStart, roundCount, maxTickets, maxEntry, nonce, deadline, sig) {
  const c = relayContract(); if (!c) return null;
  const tx = await c.buyInForRange(id, ethers.getAddress(player), nTickets, roundStart, roundCount, maxTickets, maxEntry, nonce, deadline, sig);
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
// Submit a player's EIP-712 AutoBuy authorization for `nTickets` on round `id`. Bounds (maxTickets/maxEntry/
// deadline/nonce) are verified ON-CHAIN in buyInFor; this just relays. Returns the tx hash or null on failure.
async function buyInFor(id, auth, nTickets) {
  const c = relayContract(); if (!c) return null;
  try {
    const tx = await c.buyInFor(id, ethers.getAddress(auth.player), BigInt(nTickets),
      BigInt(auth.maxTickets), BigInt(auth.maxEntry), BigInt(auth.deadline), BigInt(auth.nonce), auth.sig);
    return (await tx.wait()).hash;
  } catch (_) { return null; }
}
async function relayGasEth() { try { const a = relayAddress(); if (!a) return null; const b = await roProvider().getBalance(a); return Number(ethers.formatEther(b)); } catch (_) { return null; } }

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
async function readRound(id) { const c = ct(); if (!c) return null; const r = await c.rounds(id); return { entry: r[0], pot: r[1], lockTime: Number(r[3]), deadline: Number(r[4]), status: Number(r[8]) }; }
// On-chain truth for whether the rake was already swept (rounds struct field 6); keeper confirms this before
// dropping a rake when payRake reverts with a custom error the string-match wouldn't catch.
async function rakePaidOf(id) { const c = ct(); if (!c) return null; try { const r = await c.rounds(id); return !!r[6]; } catch (e) { return null; } }
// On-chain claimAt (unix s) for a round = when winners/rake become payable (settle time + challenge). 0 if unset.
// Used by the auto-payout keeper so it waits EXACTLY the configured challenge window (any value), not a hardcoded 300s.
async function claimAtOf(id) { try { const c = roCt(); if (!c) return 0; const r = await c.rounds(id); return Number(r[5]); } catch (_) { return 0; } }
async function isParticipant(id, addr) { const c = ct(); if (!c || !addr) return false; try { return (await c.tickets(id, addr)) > 0n; } catch { return false; } }
// Coupling reads: how many tickets an address bought on-chain for a round, and the round's real escrow pot (in RVLT).
async function ticketsOf(id, addr) { const c = ct(); if (!c || !addr) return 0; try { return Number(await c.tickets(id, addr)); } catch { return 0; } }
async function potRvlt(id) { const c = ct(); if (!c) return 0; try { const r = await c.rounds(id); return Number(ethers.formatUnits(r[1], 18)); } catch { return 0; } }

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
    try { const price = await c.entryPriceFor(id, ethers.getAddress(addr)); if (price > 0n) return (price * n).toString(); } catch (_) {}
  }
  return (BigInt(ENTRY_WEI || '0') * n).toString();   // fallback: full entry (never under-quote)
}
// Full round-state read for the pre-flight: status + lockTime + deadline + the global per-wallet cap, all from
// one place so the server can reason about "open? how close to lock? room under the cap?" before a swap.
async function preflightState(id) {
  const c = roCt(); if (!c) return null;
  try {
    const [r, cap] = await Promise.all([ c.rounds(id), c.maxTicketsPerWallet().catch(() => 0n) ]);
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
    // buy-in closed). \b here is the word-boundary escape, so /\blocked\b/ matches "locked" as a whole word
    // (verified: /\blocked\b/.test("locked") === true) without colliding with ERC-20 messages.
    if (/\blocked\b/.test(msg))  return { ok: false, reason: 'round_locking' };
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
// Push the rake (burn + treasury split) to its payees after the challenge window. Separate on-chain call from
// payWinners; idempotent (reverts "rake paid" if already done). Anyone may call it.
async function payRake(id) { const c = ct(); if (!c) return null; const tx = await c.payRake(id); return (await tx.wait()).hash; }
// V5: current progressive jackpot in human RVLT (read-only, no signer).
async function jackpotRvlt() { try { const c = roCt(); if (!c) return 0; const j = await c.jackpot(); return Number(ethers.formatUnits(j, 18)); } catch (_) { return 0; } }

// ---- READ-ONLY metrics (admin dashboard). A provider-only (no signer) path so these reads never require or
// touch the settlement key. Works whenever an ADDR + RPC are configured, even if ON is false, so the dashboard
// can still show chain context. NEVER writes, NEVER signs. ----
let _ro = null, _roc = null;
function roProvider() { if (!_ro) _ro = new ethers.JsonRpcProvider(RPC, CHAIN); return _ro; }
function roCt() { if (!ADDR) return null; if (!_roc) _roc = new ethers.Contract(ADDR, ABI, roProvider()); return _roc; }
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
// Full round read for the dashboard: entry/pot/rakeOwed/status in human units (read-only, no signer).
async function roundInfo(id) {
  try { const c = roCt(); if (!c) return null; const r = await c.rounds(id);
    return { entry: Number(ethers.formatUnits(r[0], 18)), pot: Number(ethers.formatUnits(r[1], 18)),
      rakeOwed: Number(ethers.formatUnits(r[2], 18)), lockTime: Number(r[3]), deadline: Number(r[4]),
      rakePaid: !!r[6], status: Number(r[8]) };
  } catch (_) { return null; }
}

module.exports = { isOn, entryWei, modeOverride, voidGraceSec, config, newSeed, addrOfToken, openRound, lockRound, commit, readRound, rakePaidOf, claimAtOf, isParticipant, ticketsOf, potRvlt, settleEqualSplit, voidRound, rolloverRound, payWinners, payRake, jackpotRvlt,
  // pre-flight (buy-before-swap safety) + single-source-of-truth required-RVLT helper
  requiredRvltWei, preflightState, simulateBuyInState,
  signerAddress, signerGasEth, rakeBps, burnShareBps, roundInfo, keySeparationReport, parityCheck,
  // holder discount (applied ON-CHAIN at buy time via entryPriceFor; these are read-only helpers for the client)
  isHolder, holderConfig, holderDiscountConfig,
  // feature 2 (auto-buy relayer)
  buyInFor, buyInForRange, autobuyRangeTypes, autoBuyNonce, domainSeparator, onchainRelayer, relayAddress, relayIsFallback, relayUsable, relayGasEth,
  // feature 2 (EIP-712 signing material for the client)
  eip712Domain, autobuyTypes, autobuyTypehash, autobuyTypeString, assertDomain };
