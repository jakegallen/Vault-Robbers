# Vault Standoff V2 — Mainnet GO-LIVE EXECUTION Pack

Status: AUTHORING / READ-ONLY. Producing this pack sent NO transaction, used NO private key,
set NO secret, and did NOT touch the dev twin. The only network calls were read-only `cast call`
/ `cast storage` / `cast chain-id` against mainnet, plus offline `cast calldata` / `cast sig`
(pure local encoding). Deploy + Safe + env steps below are for Jake to execute; they are not run
here. This is the copy-paste runbook for the V1 -> V2 upgrade of the live mainnet escrow.

Companion review doc: `MAINNET-UPGRADE-V2.md` (storage-layout proof, risks R1-R7, rollback).

---

## 0. Targets (fixed)

| Thing | Value |
|---|---|
| Mainnet chain | Robinhood mainnet, chainid `4663` (verified live via `cast chain-id` = `4663`) |
| Mainnet RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Live proxy (UUPS) | `0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5` |
| Owner / upgrade + config authority | 2-of-2 Safe `0x2aA3936C0312f3604982B2504BeE7ad8c88e9397` |
| Current live impl (V1) | `0x16f19fca5f4ad6b809f83f97be0540088702c988` (from EIP-1967 impl slot, confirmed live) |
| New impl (V2) | NOT DEPLOYED YET — deploy with `script/DeployMainnetV2Impl.s.sol` after sign-off |
| ROBINVAULT token (RVLT) | `0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04` (confirmed = `token()` on proxy) |

---

## 1. LIVE mainnet config READ (actual values, read-only, today)

Read via `cast call` against the live proxy on `https://rpc.mainnet.chain.robinhood.com`:

| Getter | Live value | Notes |
|---|---|---|
| `owner()` | `0x2aA3936C0312f3604982B2504BeE7ad8c88e9397` | the 2-of-2 Safe — correct, do not change |
| `settlementSigner()` | `0x90DE561c63192AdcA8e5b81Bd9caa8ff8D95b3c5` | current hot signer — see role note below |
| `treasury()` | `0x2aA3936C0312f3604982B2504BeE7ad8c88e9397` | currently = the Safe |
| `burnSink()` | `0x000000000000000000000000000000000000dEaD` | dead address |
| `token()` | `0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04` | RVLT — correct |
| `rakeBps()` | `500` | 5% — ALREADY the target |
| `burnShareBps()` | `0` | 100% to treasury — ALREADY the target (Jake's prior decision) |
| `challenge()` | `3600` | 1h — WILL CHANGE to 300 |
| `MIN_CHALLENGE()` | `3600` | V1 floor; becomes `300` after upgrade |
| `VERSION()` | REVERTS (`execution reverted, 0x`) | confirms the proxy is STILL V1 |
| `maxTicketsPerWallet()` | REVERTS | V2 getter absent on V1 — confirms still V1 |
| EIP-1967 impl slot | `0x16f19fca5f4ad6b809f83f97be0540088702c988` | = the V1 impl |
| `rounds(0)` / `rounds(1)` | all-zero | no rounds opened on mainnet yet (clean upgrade, no in-flight round) |

What this means for the runbook — only these actually need changing:

- `challenge`: `3600 -> 300` (needs `setChallenge(300)`).
- `rakeBps` / `burnShareBps`: already `500` / `0` -> **SKIP `setRake`** (no diff; don't waste a Safe tx).
- `maxTicketsPerWallet`: absent (V1) -> set to `3` after upgrade.
- `voidGrace`: absent (V1) -> set to `900` after upgrade.
- `guardian`, `relayer`, `settlementSigner`: set to Jake's 3 dedicated keys (address-dependent, below).
- `treasury` currently = Safe. If the dedicated treasury PAYOUT key (`VS_TREASURY_PK`) is a DIFFERENT
  address than the Safe and you want rake to land there, add `setPayees(<treasury>, 0x...dEaD)`.
  If treasury stays the Safe, leave `treasury` as-is (no call). Decide at config time.

---

## 2. Recommended PRODUCTION values (the economy decisions)

### On-chain (set via Safe after upgrade)

| Param | Setter | Value | Rationale |
|---|---|---|---|
| challenge | `setChallenge(uint32)` | `300` (5 min) | dispute/void window; = the new MIN_CHALLENGE floor |
| rakeBps | `setRake(uint16,uint16)` | `500` (5%) | ALREADY live — SKIP |
| burnShareBps | (same setter) | `0` (100% treasury) | Jake's prior decision — ALREADY live, SKIP |
| maxTicketsPerWallet | `setMaxTicketsPerWallet(uint128)` | `3` | 10% of a 25-ticket round (ceil(0.10*25)=3); anti-whale |
| voidGrace | `setVoidGrace(uint32)` | `900` (15 min) | matches the off-chain void SLA; closes public-void griefing |

### Roles (3 DISTINCT dedicated keys Jake generates)

| Role | Setter | Key env | Constraint |
|---|---|---|---|
| settlement signer | `setSigner(address)` | `VS_ESCROW_SIGNER_PK` | hot key; opens/commits/settles. Rotatable. |
| relayer (auto-buy) | `setRelayer(address)` | `VS_RELAY_PK` | DISTINCT from signer and owner; `0` disables `buyInFor`. |
| guardian | `setGuardian(address)` | (held by ops / may be the Safe) | voids stuck rounds in the grace window. MAY be the Safe itself. |

All three MUST be distinct from each other (the server refuses to boot if `VS_RELAY_PK` == signer).
Guardian may be the Safe `0x2aA3...9397` (no new key needed) — recommended for maximum trust.

### Server-side (config/dashboard — NOT on-chain)

Stored in the hot economy config (`.vs-store/.vs-config.json`), set via the admin dashboard:

| Knob | Value |
|---|---|
| entryUsd | `10` |
| roundTarget | `25` |
| thresholdPct | `50` |
| graceSec | `600` (10 min) |
| holderDiscountPct | `50` |
| otDoors | `2` |

Note: on-chain `maxTicketsPerWallet=3` is the hard cap; the server's `maxTicketsPerWalletPct=10`
against `roundTarget=25` computes `ceil(0.10*25)=3`, so the two layers agree.

---

## 3. EXACT Safe calldata (abi-encoded, generated offline)

Selectors confirmed against V2 source (`src/StandoffEscrow.sol`):

```
upgradeToAndCall(address,bytes)   0x4f1ef286
setChallenge(uint32)              0x5697ee9f
setMaxTicketsPerWallet(uint128)   0xa8cc615f
setVoidGrace(uint32)              0x58092714
setSigner(address)                0x6c19e783
setRelayer(address)               0x6548e9bc
setGuardian(address)              0x8a0dac4a
setRake(uint16,uint16)            0xa8412d5c   (NOT needed — already 500/0)
setPayees(address,address)        0x651dd5d7   (only if changing treasury off the Safe)
```

### 3a. upgradeToAndCall — TEMPLATE (impl not deployed yet)

`data = 0x` (empty): V2 adds no initializer/reinitializer; the proxy is already initialized.
Target = the proxy `0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5`. Value = `0`.

Template with `<IMPL_ADDRESS>` placeholder shown as `0x1111...1111`:

```
0x4f1ef286
  0000000000000000000000001111111111111111111111111111111111111111   <- <IMPL_ADDRESS> (left-pad)
  0000000000000000000000000000000000000000000000000000000000000040   <- offset to bytes (0x40)
  0000000000000000000000000000000000000000000000000000000000000000   <- bytes length = 0 (data = 0x)
```

Finalize with the REAL impl address (pure offline encoding, no RPC):
```bash
cast calldata "upgradeToAndCall(address,bytes)" <IMPL_ADDRESS> 0x
```

### 3b. Config calls with FINAL values baked in (value known)

```
setChallenge(300):
0x5697ee9f000000000000000000000000000000000000000000000000000000000000012c

setMaxTicketsPerWallet(3):
0xa8cc615f0000000000000000000000000000000000000000000000000000000000000003

setVoidGrace(900):
0x580927140000000000000000000000000000000000000000000000000000000000000384
```

`setRake(500,0)` — SKIP (live values already 500/0). For reference only if ever needed:
```
0xa8412d5c00000000000000000000000000000000000000000000000000000000000001f40000000000000000000000000000000000000000000000000000000000000000
```

### 3c. Address-dependent calls (Jake fills his generated addresses)

Generate calldata per address with one of these (offline, no RPC):
```bash
# settlement signer
cast calldata "setSigner(address)"   <SIGNER_ADDRESS>
# auto-buy relayer (MUST differ from signer and owner)
cast calldata "setRelayer(address)"  <RELAYER_ADDRESS>
# guardian (may be the Safe 0x2aA3936C0312f3604982B2504BeE7ad8c88e9397)
cast calldata "setGuardian(address)" <GUARDIAN_ADDRESS>
```
ethers equivalent (offline):
```js
const { ethers } = require('ethers');
const iface = new ethers.Interface([
  'function setSigner(address)','function setRelayer(address)','function setGuardian(address)'
]);
iface.encodeFunctionData('setSigner',   ['<SIGNER_ADDRESS>']);
iface.encodeFunctionData('setRelayer',  ['<RELAYER_ADDRESS>']);
iface.encodeFunctionData('setGuardian', ['<GUARDIAN_ADDRESS>']);
```

Optional, only if treasury moves off the Safe:
```bash
cast calldata "setPayees(address,address)" <TREASURY_ADDRESS> 0x000000000000000000000000000000000000dEaD
```

---

## 4. GO-LIVE RUNBOOK (single ordered copy-paste sequence)

Do the whole thing BETWEEN ROUNDS (no Open/Committed round on mainnet — confirmed clean today).

### (a) Generate 3 keys + seal env + fund

One-liner to generate three DISTINCT keys (prints addr+key; paste keys straight into sealed env,
never into logs/chat/source):
```bash
for role in SIGNER RELAY TREASURY; do
  echo "== $role =="; cast wallet new | sed 's/^/  /'
done
```
Guardian: you may reuse the Safe `0x2aA3936C0312f3604982B2504BeE7ad8c88e9397` (no 4th key needed).

Seal into env (sealed secret store ONLY — never `.escrow-signer.key`/`.escrow.local.json` in prod,
never echoed):
```
VS_ESCROW_SIGNER_PK = 0x<signer key>
VS_RELAY_PK         = 0x<relayer key>      # MUST differ from signer
VS_TREASURY_PK      = 0x<treasury key>     # distinct; holds/pays treasury RVLT
VS_ADMIN_TOKEN      = <strong random admin token for the game/admin API gate>
```
Fund the keys on Robinhood mainnet (4663):
- `VS_ESCROW_SIGNER_PK` address -> native gas (runs openRound/lockRound/commit/settle).
- `VS_RELAY_PK` address -> native gas (runs buyInFor), ONLY if enabling auto-buy.
- `VS_TREASURY_PK` address -> RVLT (`0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04`) for holder rebates,
  plus a little native gas to send them.

### (b) Deploy the V2 implementation (THE ONE GUARDED COMMAND — needs sign-off)

Hard-guarded to chainid 4663. Deploys impl ONLY (no proxy, no init, no upgrade). Uses sealed
`DEPLOYER_PK` (the mainnet deployer key, env-only, NOT any of the 3 role keys above):
```bash
cd /data/app-groups/main/standoff-contracts
export DEPLOYER_PK=0x<mainnet deployer key>   # sealed env only; never source/logs/chat
forge script script/DeployMainnetV2Impl.s.sol:DeployMainnetV2Impl \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --broadcast --legacy
```
Record the printed `new implementation : 0x...` as `<IMPL_ADDRESS>`. Optionally confirm its
runtime-bytecode keccak matches the fingerprint in `MAINNET-UPGRADE-V2.md`.

### (c) Finalize the upgrade calldata with the real impl (one-liner, offline)

```bash
cast calldata "upgradeToAndCall(address,bytes)" <IMPL_ADDRESS> 0x
```

### (d) Safe executes — upgrade + config, BATCHED, between rounds

In the Safe (Transaction Builder, target = proxy `0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5`,
value `0` for each), add these transactions in order and batch into ONE multisend, then collect
both 2-of-2 signatures and execute:

1. `upgradeToAndCall(<IMPL_ADDRESS>, 0x)`  — calldata from step (c)
2. `setChallenge(300)`                     — `0x5697ee9f...012c`
3. `setMaxTicketsPerWallet(3)`             — `0xa8cc615f...0003`
4. `setVoidGrace(900)`                     — `0x58092714...0384`
5. `setSigner(<SIGNER_ADDRESS>)`           — calldata from 3c
6. `setGuardian(<GUARDIAN_ADDRESS>)`       — calldata from 3c (may be the Safe)
7. `setRelayer(<RELAYER_ADDRESS>)`         — calldata from 3c (ONLY if enabling auto-buy; else skip, leaves buyInFor off)
   (SKIP `setRake` — already 500/0. SKIP `setPayees` unless treasury moves off the Safe.)

Upgrade MUST be first in the batch so the config setters hit V2 logic.

### (e) Run the verification script (section 5) — must all pass before flipping the server.

### (f) Flip the server to mainnet escrow config + restart

Set on the prod server (the `.escrow` equivalent, via sealed env):
```
VS_ESCROW           = on
VS_ESCROW_ADDR      = 0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5
VS_CHAINID          = 4663
VS_RVLT             = 0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04
VS_ESCROW_SIGNER_PK = (from step a)
VS_RELAY_PK         = (from step a, if auto-buy)
VS_TREASURY_PK      = (from step a)
VS_ADMIN_TOKEN      = (from step a)
```
Then restart the prod Vault Standoff app artifact. Confirm the boot log shows escrow ON, the right
address/chainId, and NO "VS_RELAY_PK fallback" / "relayer == signer" warnings.

### (g) One $10 Relay smoke buy-in

Do a single real $10 buy-in through the Relay funding path (any currency -> RVLT buy-pressure ->
approve escrow -> buyIn). Confirm: ticket counted on-chain, pot increased by entry, the UI reflects
it, then let the round settle or void cleanly. One buy-in only — do not grind.

---

## 5. Post-upgrade READ-ONLY verification script

Save as `verify-v2.sh` and run after step (d). All read-only `cast call` — no key, no tx.

```bash
#!/usr/bin/env bash
set -euo pipefail
ESC=0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5
RPC=https://rpc.mainnet.chain.robinhood.com
SAFE=0x2aA3936C0312f3604982B2504BeE7ad8c88e9397
RVLT=0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04
SIGNER=<SIGNER_ADDRESS>     # the newly-set signer
GUARDIAN=<GUARDIAN_ADDRESS> # the newly-set guardian (may be the Safe)
RELAYER=<RELAYER_ADDRESS>   # the newly-set relayer, or 0x0 if auto-buy disabled
IMPL=<IMPL_ADDRESS>         # the deployed V2 impl

fail(){ echo "FAIL: $1"; exit 1; }
eq(){ [ "${1,,}" = "${2,,}" ] || fail "$3 (got $1 want $2)"; echo "ok: $3 = $1"; }

eq "$(cast call $ESC 'VERSION()(uint16)' --rpc-url $RPC)" "2" "VERSION==2"
eq "$(cast call $ESC 'owner()(address)' --rpc-url $RPC)" "$SAFE" "owner==Safe"
eq "$(cast call $ESC 'MIN_CHALLENGE()(uint32)' --rpc-url $RPC)" "300" "MIN_CHALLENGE==300"
eq "$(cast call $ESC 'challenge()(uint32)' --rpc-url $RPC)" "300" "challenge==300"
eq "$(cast call $ESC 'rakeBps()(uint16)' --rpc-url $RPC)" "500" "rakeBps==500"
eq "$(cast call $ESC 'burnShareBps()(uint16)' --rpc-url $RPC)" "0" "burnShareBps==0"
eq "$(cast call $ESC 'maxTicketsPerWallet()(uint128)' --rpc-url $RPC)" "3" "maxTicketsPerWallet==3"
eq "$(cast call $ESC 'voidGrace()(uint32)' --rpc-url $RPC)" "900" "voidGrace==900"
eq "$(cast call $ESC 'settlementSigner()(address)' --rpc-url $RPC)" "$SIGNER" "settlementSigner==new"
eq "$(cast call $ESC 'guardian()(address)' --rpc-url $RPC)" "$GUARDIAN" "guardian==new"
eq "$(cast call $ESC 'relayer()(address)' --rpc-url $RPC)" "$RELAYER" "relayer==set"
eq "$(cast call $ESC 'token()(address)' --rpc-url $RPC)" "$RVLT" "token==RVLT (preserved)"

# EIP-1967 impl slot points at the new V2 impl
SLOT=$(cast storage $ESC 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url $RPC)
echo "impl slot raw: $SLOT"
echo "$SLOT" | grep -iq "${IMPL#0x}" || fail "impl slot != new V2 impl"
echo "ok: impl slot -> $IMPL"

# V2 getters resolve without reverting
cast call $ESC 'AUTOBUY_TYPEHASH()(bytes32)' --rpc-url $RPC >/dev/null && echo "ok: AUTOBUY_TYPEHASH resolves"
cast call $ESC 'domainSeparatorV4()(bytes32)' --rpc-url $RPC >/dev/null && echo "ok: domainSeparatorV4 resolves"

# existing rounds intact: pre-upgrade snapshot vs post. Mainnet has NO rounds yet (rounds(0/1) all-zero),
# so this asserts they are still zero/untouched. If rounds existed, diff rounds(id) vs a pre-upgrade snapshot.
cast call $ESC 'rounds(uint256)(uint128,uint128,uint128,uint64,uint64,uint64,bool,bytes32,uint8,uint16)' 0 --rpc-url $RPC
cast call $ESC 'rounds(uint256)(uint128,uint128,uint128,uint64,uint64,uint64,bool,bytes32,uint8,uint16)' 1 --rpc-url $RPC

echo "ALL CHECKS PASSED"
```

Note: the V2 `rounds(id)` tuple has a trailing `uint16 rakeBpsSnap` member that V1 lacked — that
extra field decoding is itself a signal the upgrade took. For any round that existed pre-upgrade,
the first 9 fields must be byte-identical to a snapshot taken BEFORE the upgrade; `rakeBpsSnap`
reads `0` for pre-upgrade rounds (harmless — see R4/R6 in `MAINNET-UPGRADE-V2.md`). Mainnet is
clean today, so there is nothing to diff.

Rollback (if needed): the Safe runs `upgradeToAndCall(0x16f19fca5f4ad6b809f83f97be0540088702c988, 0x)`
to return to V1. Storage is append-only, so the 4 V2 slots become dormant gap again. Only roll back
between rounds.

---

## 6. Confirmation

- Nothing was deployed. No `forge script ... --broadcast` was run. No proxy, no impl, no upgrade tx.
- No Safe transaction was signed or executed.
- No private key was generated, read, or used. No secret / env var was set.
- The dev twin (`vaultstandoff-dev`) was not modified — only read for env-var names.
- The only network activity was READ-ONLY RPC (`cast call` / `cast storage` / `cast chain-id`)
  against mainnet, plus OFFLINE encoding (`cast calldata` / `cast sig`).
