# Vault Standoff V6 — Mainnet Go-Live Runbook

Prepared 2026-10-12. Target public launch: **Halloween (Oct 31 2026, 00:00 ET)**.

Nothing here moves money by itself. The implementation deploy uses the sealed mainnet deployer key;
every state/upgrade/config call is executed by the **2-of-2 Safe**. Claude never holds mainnet keys
or signs the Safe.

## Live mainnet facts (read 2026-10-12)
- Proxy (never changes): `0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5` (chain 4663)
- Current impl: **V1** (`VERSION()` and all V2..V6 getters revert) — inert, no rounds ever played
- Owner / upgrader (2-of-2 Safe): `0x3290f9cbF7bE7dEA11E7d482Ae0418b83E363665`
  - (The old V2 script hardcoded `0x2aA3…`; that is STALE. Always trust the live `owner()` read.)
- settlementSigner: `0x90DE561c63192AdcA8e5b81Bd9caa8ff8D95b3c5` (the operator key — **must be rotated**)
- rakeBps: 500 (5%). V1 -> V6 is a clean append-only upgrade (every new slot is zero on this proxy).

RPC: `https://rpc.mainnet.chain.robinhood.com`

---

## Phase 0 — Keys (mostly already provisioned; V6 needs FEWER than the old plan)
Roles needed for V6, set ONLY in the prod artifact env (never on disk, never logged), all distinct, none = the
operator `0x90DE…` or the Safe `0x3290…`:
- `VS_ESCROW_SIGNER_PK` — settlement signer. ALREADY MADE: address `0xe7B8eC63ff954E4a962E4fa953c5e6703C58fC61`
  (in secrets). Reuse it; no new key. It just has to be set on-chain via `setSigner` (currently the operator `0x90DE…`).
- `VS_RELAY_PK` — dedicated range/auto-buy relayer (distinct from signer/deployer/Safe). Needed only if range auto-buy
  is enabled. Reuse your saved relayer key if you have one; else generate ONE fresh key.
- Deployer `0x411f…` — used ONLY to deploy the impl (Phase 1); keep it OUT of the prod env (boot guard refuses it on 4663).
  Just fund it with a little 4663 gas.
- Guardian — can be the Safe `0x3290…` itself (no new key).

NOT NEEDED IN V6 (change from the old V2/V3/V4 plan): `VS_TREASURY_PK` is obsolete — the holder discount is now
ON-CHAIN (holder pays $5, pot gets $5), so there is no treasury-rebate payout to sign. The treasury (the Safe) still
receives rake via the permissionless `payRake`, which needs no hot key. If one of your three saved keys was the
treasury key, it is now spare — repurpose it as `VS_RELAY_PK` or set it aside.
`VS_ADMIN_TOKEN` (admin panel) is a token, not a wallet key; still needed, >= 32 chars.

Record each key's ADDRESS for the config calls. The prod server asserts on boot: on-chain settlementSigner == signer
key, and the three roles are distinct (FATAL otherwise).

### Key inventory (reviewed 2026-10-12, mapped by derived address — keys never printed)
USE THESE:
- Settlement signer = secret **`STANDOFF_SIGNER`** -> `0xe7B8eC63ff954E4a962E4fa953c5e6703C58fC61` (funded 0.02 ETH on 4663).
  NAMING: the server reads `VS_ESCROW_SIGNER_PK`; set that prod env var to the STANDOFF_SIGNER key value (or we add a
  code fallback to read STANDOFF_SIGNER). On-chain: `setSigner(0xe7B8…fC61)` (off the operator).
- Deployer (impl deploy only, NOT in prod env) = **`DEPLOYER_PRIVATE_KEY`** -> `0x411f…49d1` (funded 0.153 ETH).
- Guardian = the Safe `0x3290…3665` itself (no key).

NEED ONE NEW KEY (only to enable auto-play / range deposits; NOT a launch blocker — relayer can stay OFF and single
buy-ins work): `VS_RELAY_PK` = a FRESH dedicated EOA, distinct from everything below, funded with a little 4663 gas.

DO NOT REUSE (role separation):
- `OPERATOR_PK` -> `0x90DE…b3c5` = the CURRENT on-chain signer we are rotating OFF.
- `DEPLOYER_PRIVATE_KEY_2` -> `0x8444…2D0e` = the Vault Robbers NFT owner/admin EOA.
- `ROBBERS_SIGNER_PK` -> `0xa6b827…17C9` = the Vault Robbers MINT voucher signer.
- `PRIVATE_KEY` -> `0x4a75…9d4E` = unknown purpose + 0 gas; don't use unless confirmed spare.

NOT NEEDED: `VS_TREASURY_PK` (obsolete in V6).

## Phase 1 — Deploy the V6 implementation (sealed deployer key)
```
export DEPLOYER_PK=0x<sealed mainnet deployer key>
forge script script/DeployMainnetV6Impl.s.sol:DeployMainnetV6Impl \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --legacy
```
Copy the printed **new implementation address** -> this is `IMPL` below. (It deploys ONLY the logic contract; it does not touch the proxy.)

Verify before the Safe ceremony:
```
cast call 0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5 "owner()(address)" --rpc-url <mainnet>   # expect 0x3290…3665
```

## Phase 2 — Safe ceremony (2-of-2). Each row: to = proxy `0x6486…3EEA5`, value = 0, data = calldata
Run in this order. Build the address-dependent calldata with `cast calldata` (shown), the fixed ones are pre-computed.

1. **Upgrade to V6**
   `cast calldata "upgradeToAndCall(address,bytes)" <IMPL> 0x`
2. **Rotate settlement signer** (off the operator key)
   `cast calldata "setSigner(address)" <SIGNER_ADDR>`
3. **Set the range/auto-buy relayer**
   `cast calldata "setRelayer(address)" <RELAY_ADDR>`
4. **Per-wallet ticket cap = 3**  → `0xa8cc615f0000000000000000000000000000000000000000000000000000000000000003`
5. **Holder collection** (Vault Robbers NFT, confirmed on 4663: name "Vault Robbers" / "ROBBERS", ERC721)
   `cast calldata "setHolderNft(address)" 0xABC6c4F5d1F31326b419c2645C981743a845313a`
   (= `0x3ca80443000000000000000000000000abc6c4f5d1f31326b419c2645c981743a845313a`)
6. **Holder discount 50%** → `0x6e3dd4b60000000000000000000000000000000000000000000000000000000000001388`
7. **Guardian** (void-window operator; can be the Safe or an ops key)
   `cast calldata "setGuardian(address)" <GUARDIAN_ADDR>`
8. **Void grace 15 min** → `0x5809271400000000000000000000000000000000000000000000000000000000000000384`  *(re-generate: `cast calldata "setVoidGrace(uint32)" 900`)*
9. (optional) **Challenge window 300s** → `0x5697ee9f000000000000000000000000000000000000000000000000000000000000012c` (only if not already 300; keep the server's CHALLENGE_SEC in sync)

Post-ceremony verify:
```
cast call <proxy> "VERSION()(uint16)"          # 6
cast call <proxy> "settlementSigner()(address)" # new signer, NOT 0x90DE…
cast call <proxy> "relayer()(address)"          # relay addr
cast call <proxy> "maxTicketsPerWallet()(uint128)" # 3
cast call <proxy> "holderNft()(address)"        # Vault Robbers NFT
cast call <proxy> "holderDiscountBps()(uint16)" # 5000
```

## Phase 3 — Prod artifact (gated canary)
- Promote the V6 `server.js` + `escrow.js` + `public/` from `vaultstandoff-dev` to the prod Vault Standoff artifact pointed at the mainnet proxy (4663).
- Prod `.escrow.local`/env: `on:true`, `addr:<proxy>`, `chainId:4663`, `rvlt:<mainnet RVLT>`, `entryWei:<$10 in RVLT>`, `mode:rmfill`, `nft:<Vault Robbers NFT>`; sealed `VS_ESCROW_SIGNER_PK` + `VS_RELAY_PK`.
- Keep `launchGate = 1` (the Halloween countdown overlay shows to the public; the game is reachable only behind the password host for the canary).
- Fund the signer + relayer with a little gas; fund 1-2 test wallets with RVLT.

**Canary runs (small, real money, behind the gate):**
1. Normal round: buy in -> win -> auto-payout lands after the challenge window (no claim click).
2. Final-vault rollover: force/observe a mutual-bust -> pot rolls into the jackpot -> next win sweeps pot+jackpot.
3. Range deposit: one approve + one signature covers N heists -> relayer enters each -> confirm only N entries, no over-spend.
4. Confirm: holder pays $5 vs $10, 3-ticket cap holds, nothing drains, void/refund works.

## Phase 4 — Public launch (Halloween)
- Flip `launchGate = 0` (admin config) at/just before the countdown hits zero.
- vaultrobbers.com: game at root, mint linked; MetaMask/Rabby note surfaced (Phantom can't do 4663).

## Rollback
- Any issue: the Safe can `upgradeToAndCall` back to a prior impl, or `voidRound` in-flight rounds (refunds), or `setRelayer(0)` to kill auto-buy. Funds only ever leave via settle-to-participant or refund-to-payer.

## Audit note (2026-10-12)
Full audit: no critical, no fund-drain. Relayer cannot pay itself; jackpot accounting sound; EIP-712 replay-safe; storage append-only (verified). The relayer range-authorization is the one custody surface — reviewed, bounded by the player's allowance + signed limits; keep the dedicated `VS_RELAY_PK` requirement.
