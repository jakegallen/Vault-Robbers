# StandoffEscrow V1 -> V2 Mainnet Upgrade Package (REVIEW ONLY)

Status: REVIEW ONLY. Nothing in this package was deployed. No transaction was sent. No private
key was used or read. All on-chain addresses below are read from committed broadcast records and
the task brief; the only commands run were local `forge build / inspect / test` and `cast sig /
calldata` (pure encoding, no RPC, no broadcast). This document, the layout evidence, and
`script/DeployMainnetV2Impl.s.sol` are for Jake to review BEFORE a Safe-executed upgrade.

## Targets

| Thing | Value |
|---|---|
| Mainnet chain | Robinhood mainnet, chainid `4663` |
| Live proxy (UUPS) | `0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5` |
| Owner / upgrade authority | 2-of-2 Safe `0x2aA3936C0312f3604982B2504BeE7ad8c88e9397` |
| Current live impl (V1) | `0x16f19fca5f4ad6b809f83f97be0540088702c988` (from `broadcast/Deploy.s.sol/4663/run-latest.json`) |
| New impl (V2) | NOT DEPLOYED. Deploy with `script/DeployMainnetV2Impl.s.sol` only after sign-off |
| Testnet V2 proxy (reference, already live) | `0xa2321d3A8AfC966cd96636e3d11aeA2DdF8Fd355` on 46630 |

V2 source fingerprint (so the deployed impl can be matched to this exact source):
- solc `0.8.24+commit.e11b9ed9`, optimizer on (200 runs), `viaIR = true`, evmVersion `paris`
- creation-bytecode keccak256: `0xb346073ab1f4a1b5d71369e1d4992b672d49a1206dbbc9af3a12dadbc7380226`
- runtime-bytecode keccak256: `0xe640b55077873e4f6a35228eda0d4ff579f58fa586fe0f92b3f12d8b546f4379`

Compiler/optimizer settings MUST be identical at deploy time or the bytecode hash will differ.

## What V2 changes (feature summary)

1. `lockRound(id)` — signer-only, fill-driven lock. Moves `lockTime` to `block.timestamp`, can only
   move it EARLIER (never re-open/extend buy-in). Rounds open with a far-future sentinel lockTime.
2. `maxTicketsPerWallet` — owner-settable on-chain per-wallet cap, enforced in `buyIn`/`buyInFor`
   (0 = unlimited, back-compat default).
3. `buyInFor(...)` — relayer-submitted EIP-712 auto-buy. Funds pulled from the PLAYER (who approved
   escrow), never the relayer. Bounded by signed `maxTickets`/`maxEntry`/`deadline`/`nonce`.
4. `guardian` + `voidGrace` — close the post-deadline public-void griefing window (BASE-1 fix).
5. `Round.rakeBpsSnap` — rake snapshotted at `openRound`, used at `settle` so a mid-round `setRake`
   can't change this round's economics or stall settlement (BASE-2 fix).
6. `MIN_CHALLENGE` lowered from 3600 to 300 (5-minute floor).
7. `VERSION` constant bumped `1 -> 2`.

Testnet validation: V2 deployed on 46630 (proxy `0xa2321d3A...Fd355`), `forge test` = 43/43 passing
(reproduced locally: 43 passed, 0 failed), and a full E2E including claim passed.

---

## 1. Storage-layout safety report

Tooling note: `@openzeppelin/upgrades` (the Hardhat `validateUpgrade` plugin) is NOT installed in
this repo (forge + the OZ contract libs only). The evidence below is a MANUAL layout diff produced
from authoritative `forge inspect ... storage-layout` output for both versions. **Recommendation:
run `validateUpgrade` (or `forge inspect` layout diff in CI) once more immediately before the
ceremony** as an independent second check. Procedure to add it is in section 7.

### Method
- V2 layout: `forge inspect StandoffEscrow storage-layout` against the current `src/StandoffEscrow.sol`.
- V1 layout: reconstructed as `.v1-layout-check/src/StandoffEscrowV1.sol` (V1 state slots 0-7, Round
  struct WITHOUT `rakeBpsSnap`, no V2 vars, `__gap[45]`) and inspected the same way. This matches the
  V1 described in the contract's own `@dev` layout notes and the shipped mainnet V1.

### Top-level slot diff

| Slot | V1 | V2 | Verdict |
|---|---|---|---|
| 0 | `token` (IERC20) | `token` | unchanged |
| 1 | `settlementSigner` | `settlementSigner` | unchanged |
| 2 | `treasury` | `treasury` | unchanged |
| 3 | `burnSink`+`rakeBps`+`burnShareBps`+`challenge` (packed) | same | unchanged |
| 4 | `rounds` mapping | `rounds` mapping | unchanged |
| 5 | `tickets` mapping | `tickets` mapping | unchanged |
| 6 | `winShare` mapping | `winShare` mapping | unchanged |
| 7 | `settled` mapping | `settled` mapping | unchanged |
| 8 | `__gap[45]` (base) | `maxTicketsPerWallet` (uint128) | **V2 APPEND** (was gap) |
| 9 | (gap) | `relayer` (address) | **V2 APPEND** (was gap) |
| 10 | (gap) | `guardian` (addr) + `voidGrace` (uint32) packed | **V2 APPEND** (was gap) |
| 11 | (gap) | `autoBuyNonce` mapping (base) | **V2 APPEND** (was gap) |
| 12..52 | (gap) | `__gap[41]` | reserved tail |

Slots 0-7 are byte-for-byte identical (verified: same name, type, slot, offset, bytes in both
layouts). The four V2 variables occupy slots 8, 9, 10 (guardian+voidGrace packed: 20+4 bytes in one
slot), 11 — all drawn from space that was previously inside V1's `__gap`. No reorder, no removal, no
type change, no overlap. This is append-only and UUPS-upgrade-safe.

### `__gap` reduction

- V1: `uint256[45]` at slot 8 -> spans slots 8..52, next free slot 53.
- V2: `uint256[41]` at slot 12 -> spans slots 12..52, next free slot 53.
- The gap shrank by exactly 4 (45 - 4 = 41), matching the 4 appended slots, and **ends at the same
  slot (52)**. The total reserved footprint is unchanged, so a future V3 appends at the same place.

### Round struct (lives in the `rounds` mapping)

| Member | V1 | V2 | Note |
|---|---|---|---|
| entry | slot 0 off 0 u128 | same | |
| pot | slot 0 off 16 u128 | same | |
| rakeOwed | slot 1 off 0 u128 | same | |
| lockTime | slot 1 off 16 u64 | same | |
| deadline | slot 1 off 24 u64 | same | |
| claimAt | slot 2 off 0 u64 | same | |
| rakePaid | slot 2 off 8 bool | same | |
| seedHash | slot 3 off 0 bytes32 | same | |
| status | slot 4 off 0 enum | same | |
| **rakeBpsSnap** | (absent) | slot 4 off 1 uint16 | **V2 APPEND** |

Critical: the Round struct `numberOfBytes` is **160 in BOTH V1 and V2**. `rakeBpsSnap` was packed
into the previously-unused tail of the `status` slot (slot 4), so the struct did NOT grow. Because
the struct size is unchanged, every per-key mapping entry (`rounds[id]`) occupies the same slot range
after the upgrade — existing rounds' entry/pot/rakeOwed/lockTime/deadline/claimAt/rakePaid/seedHash/
status are all read back identically. For rounds that existed before the upgrade, `rakeBpsSnap` reads
as 0; that value is only consumed at `settle` for rounds opened AFTER the upgrade (see risk R6).

Verdict: STORAGE-SAFE. Append-only top-level state, gap correctly reduced, struct appended without
growth. Still recommend an independent `validateUpgrade` pass before execution (section 7).

---

## 2. Exact Safe upgrade calldata

V2 adds NO new initializer and NO `reinitializer`. `initialize(...)` still carries only the V1
`initializer` modifier (verified: the sole initializer in the source; only `VERSION` and appended
state changed). The proxy is already initialized from the V1 deploy, so the upgrade needs NO
re-init. Therefore `data = 0x` (empty).

The Safe (and ONLY the Safe — `_authorizeUpgrade` is `onlyOwner`) executes ONE transaction:

- To: `0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5` (the proxy)
- Function: `upgradeToAndCall(address newImplementation, bytes data)`  (selector `0x4f1ef286`)
- Args:
  - `newImplementation` = `<NEW_V2_IMPL>`  (the address printed by DeployMainnetV2Impl)
  - `data` = `0x`  (empty — no reinitializer)
- Value: `0`

Calldata template (placeholder impl `0x1111...1111`, data empty), to show the exact shape:

```
0x4f1ef286
  0000000000000000000000001111111111111111111111111111111111111111   <- newImplementation (left-pad)
  0000000000000000000000000000000000000000000000000000000000000040   <- offset to bytes (0x40)
  0000000000000000000000000000000000000000000000000000000000000000   <- bytes length = 0 (empty data)
```

To regenerate with the real impl (pure local encoding, no RPC):
```bash
cast calldata "upgradeToAndCall(address,bytes)" <NEW_V2_IMPL> 0x
```

In the Safe UI (Transaction Builder): target = proxy address, ABI = `upgradeToAndCall(address,bytes)`,
`newImplementation` = the deployed V2 impl, `data` = `0x`. Collect both of the 2 signatures, execute.

---

## 3. Deploy-the-implementation script (mainnet, impl ONLY)

File: `script/DeployMainnetV2Impl.s.sol`  (added in this package; NOT auto-run).

- Hard-guarded: `require(block.chainid == 4663, ...)` — reverts on any non-mainnet chain.
- Deploys ONLY the implementation contract. No proxy. No `initialize`. No `upgradeToAndCall`.
  The impl constructor runs `_disableInitializers()`, so the bare impl can never be initialized.
- Prints the new impl address + the follow-up instruction (the Safe does the upgrade, not the script).

RUN ONLY WHEN JAKE APPROVES. Requires the sealed mainnet `DEPLOYER_PK`:
```bash
export DEPLOYER_PK=0x<mainnet deployer key>     # sealed env only, never source/logs/chat
forge script script/DeployMainnetV2Impl.s.sol:DeployMainnetV2Impl \
  --rpc-url https://rpc.chain.robinhood.com \
  --broadcast --legacy
```
After it prints `new implementation : 0x...`, optionally verify its runtime-bytecode keccak matches
`0xe640b55077873e4f6a35228eda0d4ff579f58fa586fe0f92b3f12d8b546f4379`, then hand that address to the
Safe ceremony (section 2). The app/env is NEVER repointed to the impl — it always uses the proxy.

---

## 4. Post-upgrade verification checklist + rollback

Run after the Safe executes the upgrade (read-only `cast call`, no key needed). `ESC` = proxy.

```bash
export ESC=0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5
export RPC=https://rpc.chain.robinhood.com
```

- [ ] VERSION is 2:            `cast call $ESC "VERSION()(uint16)" --rpc-url $RPC`  -> `2`
- [ ] Owner is still the Safe: `cast call $ESC "owner()(address)" --rpc-url $RPC`
      -> `0x2aA3936C0312f3604982B2504BeE7ad8c88e9397`
- [ ] Impl slot points to new impl (EIP-1967 impl slot):
      `cast storage $ESC 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url $RPC`
      -> right-padded to the new V2 impl address
- [ ] V2 getters resolve (do not revert):
      `cast call $ESC "maxTicketsPerWallet()(uint128)" --rpc-url $RPC`  (0 until set)
      `cast call $ESC "relayer()(address)" --rpc-url $RPC`              (0 until set)
      `cast call $ESC "guardian()(address)" --rpc-url $RPC`             (0 until set)
      `cast call $ESC "voidGrace()(uint32)" --rpc-url $RPC`             (0 until set)
      `cast call $ESC "autoBuyNonce(address)(uint256)" 0x...player --rpc-url $RPC`
      `cast call $ESC "AUTOBUY_TYPEHASH()(bytes32)" --rpc-url $RPC`
      `cast call $ESC "domainSeparatorV4()(bytes32)" --rpc-url $RPC`
- [ ] MIN_CHALLENGE reads 300:  `cast call $ESC "MIN_CHALLENGE()(uint32)" --rpc-url $RPC` -> `300`
- [ ] Preserved V1 config intact: `token()`, `settlementSigner()`, `treasury()`, `burnSink()`,
      `rakeBps()`, `burnShareBps()`, `challenge()` all equal their pre-upgrade values.
- [ ] Existing rounds unaffected: for a known pre-upgrade round id, read `rounds(id)` and confirm
      entry/pot/status/etc. are unchanged vs a pre-upgrade snapshot. (Take the snapshot BEFORE
      upgrading so you have a before/after to diff.)

Rollback: UUPS is reversible by the same owner. Because storage is append-only and the Round struct
did not grow, the proxy can be upgraded BACK to the V1 impl `0x16f19fca...c988` with another
`upgradeToAndCall(0x16f19fca...c988, 0x)` from the Safe. The 4 V2 slots simply become dormant gap
again; no V2 state corrupts V1 reads (V1 never touches slots 8-11). Do NOT roll back mid-round if any
round was opened under V2 logic and is still Open/Committed — settle or void it first (V1 settle
uses live `rakeBps`, not the snapshot, but that only affects rake math, not fund safety). Prefer
rolling back only between rounds.

---

## 5. Post-upgrade config (via Safe / owner) + env provisioning

After the upgrade, the V2 feature knobs default to 0 (disabled / unlimited / V1-equivalent). Set them
deliberately. All are `onlyOwner`, so each is a Safe transaction (or batch them in one Safe multisend).

Recommended production values (confirm with Jake; these are starting points, not mandates):

| Setter | Arg | Recommended | Rationale |
|---|---|---|---|
| `setMaxTicketsPerWallet(uint128)` | cap | choose per round economics (e.g. 5-10) | Anti-whale; 0 = unlimited. Enforced per round per wallet. |
| `setGuardian(address)` | guardian | a warm ops key distinct from signer/owner | Can void stuck un-settled rounds in the grace window. |
| `setVoidGrace(uint32)` | seconds | 3600 (1h) | Window where only owner/guardian may void; blocks public-void griefing right at deadline. 0 = V1 behaviour. |
| `setRelayer(address)` | relayer | the auto-buy relayer key (ONLY if auto-buy ships) | 0 disables `buyInFor`. MUST NOT equal signer or an owner key. |
| `setChallenge(uint32)` | seconds | 300 min; pick the production dispute window (e.g. 3600) | 300 is the floor; longer gives more void headroom. |

Do NOT set `relayer` until the auto-buy relayer service is provisioned and you intend to enable
custodial-approval auto-buy (see risk R2). Leaving it 0 keeps `buyInFor` closed.

Env / key provisioning required FIRST (sealed env, never source/logs/chat):
- Production `VS_ADMIN_TOKEN` — the game/admin API gate.
- Treasury payout key — whatever signs/holds the treasury that receives rake (section-5 payees).
- Settlement signer key — the hot key matching `settlementSigner` (rotatable via `setSigner`).
- Relayer key — ONLY if enabling auto-buy; a SEPARATE hot key, never the signer or an owner key.

---

## 6. Risk notes

- R1 (BASE-1, FIXED): post-deadline public-void griefing. V1 let anyone void the instant a round
  passed `deadline`. V2 adds `guardian` + `voidGrace`: inside the grace window only owner/guardian may
  void; the public path opens after. With `voidGrace = 0` this is exactly V1 behaviour. Set a nonzero
  `voidGrace` at config time to actually get the protection.
- R2 (BASE-2, FIXED): mid-round rake change stalling settlement. V1 computed rake from live `rakeBps`
  at settle, so an owner `setRake` between open and settle could change a round's economics or make a
  pre-computed split fail the `sum == pot - rake` check. V2 snapshots `rakeBpsSnap` at `openRound` and
  settles against the snapshot. Pre-upgrade rounds read `rakeBpsSnap = 0` (see R6).
- R3 (auto-buy custody caveat): `buyInFor` pulls RVLT from the PLAYER's approved allowance, submitted
  by the relayer. The contract bounds this tightly (signed round/maxTickets/maxEntry/deadline/nonce,
  nonce consumed before the pull, funds can only go player->escrow then settle-to-participants or
  refund — never to the relayer). But it IS a standing allowance: a player who approved the escrow a
  large/unlimited amount is trusting (a) the relayer to only submit authorizations they signed and
  (b) the escrow logic. Mitigations: advise players to approve only `entry * maxTickets`, not
  unlimited; keep the relayer key sealed and separate; ship `buyInFor` disabled (`relayer = 0`) until
  the relayer service is hardened. This is the one place a hot key (relayer) can move player funds,
  albeit only into the escrow under the player's own signed bounds.
- R4 (schedule between rounds): perform the upgrade with NO round in flight (no Open/Committed round).
  A round that is opened under V1 and settled under V2 would have `rakeBpsSnap = 0`, so V2's settle
  would compute `rake = pot * 0 / BPS = 0` for it (full pot paid to winners, no rake). Not a fund-loss
  for players, but it silently zeroes the rake on that round and is confusing. Upgrading between
  rounds avoids it entirely.
- R5 (independent layout re-check): the storage proof here is a manual `forge inspect` diff because
  `validateUpgrade` tooling is not installed. Run an independent `validateUpgrade` (or CI layout diff)
  right before the ceremony (section 7) so two methods agree.
- R6 (pre-upgrade rounds and `rakeBpsSnap`): existing `rounds[id]` entries read `rakeBpsSnap = 0`
  after the upgrade (the slot was zero gap-space before). Only matters if such a round is settled
  AFTER the upgrade (see R4). Settle those under V1 or void them before upgrading.
- R7 (trust disclosure unchanged): the Safe remains the sole upgrade + config authority. V2 does not
  reduce that trust; it is disclosed in the UI. Keep the owner as the 2-of-2 Safe (never an EOA).

---

## 7. Recommended pre-ceremony independent check (validateUpgrade)

Optional but recommended: add a one-off Hardhat project (or a CI step) with
`@openzeppelin/hardhat-upgrades` and run `validateUpgrade(V1Artifact, V2Artifact, { kind: 'uups' })`,
or use its `forceImport` of the live proxy + `validateUpgrade`. If a Hardhat setup is undesirable,
re-run both `forge inspect ... storage-layout` outputs in CI and assert slots 0-7 and the gap end-slot
are unchanged (the diff this package already documents). Either way, get a SECOND independent green
before the Safe executes.

---

## Housekeeping

- `.v1-layout-check/` is a scratch reconstruction of V1 used only to produce the authoritative V1
  layout for the diff. It is NOT a deployable contract and is not wired into the main foundry project.
  It can be deleted after review; kept here as the evidence artifact for the layout claims.
- Files in this package: this doc, `script/DeployMainnetV2Impl.s.sol`, `.v1-layout-check/`.
- Reconfirmation: nothing was deployed, no transaction was sent, no key was read or used. Only local
  `forge build/inspect/test` and `cast sig/calldata` (offline encoding) were run.
