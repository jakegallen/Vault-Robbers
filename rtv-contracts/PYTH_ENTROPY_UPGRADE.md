# Robbing the Vault — Pyth Entropy on-chain randomness (post-launch upgrade spec)

Status: SPEC / not built. Do AFTER the Sep 7 2026 launch. Commit-reveal ships for launch; this is a hardening upgrade.

## Goal

Add an on-chain, unpredictable entropy **anchor** to every run so that neither the
operator (us) nor the chain sequencer can bias an outcome, while KEEPING the current
HMAC commit-reveal for instant, provably-fair gameplay. Defense in depth, not a rip-and-replace.

## What's on chain (verified 2026-09-02)

- Entropy contract (Pyth Entropy): `0x8cF4f562301fA966F153eE1e3D46D975DF21C9a3` on Robinhood Chain 4663.
- Registered provider (operator "quiver:fletcher"): `0xeb8e79d3495638dde48336d01a1f1229822bb016`.
  - Live: 1,460+ txns, 100k pre-committed hash chain, actively revealing, `paused()`=false.
  - `getFee(provider)` = **0 wei** (checked on-chain today). Can be raised via `setProviderFee`.
- Pyth's canonical provider `0x52DeaA…` is NOT registered here; `getDefaultProvider()` reverts.
  We MUST pass `0xeb8e79…` explicitly.

## Cost

- Provider fee: **0 now** (verified). Read `getFee(provider)` at request time and fund the call
  with exactly that; never hardcode 0 — the operator can change it.
- Gas: one request tx (+ the keeper's callback is covered by the fee model). Small on this L2.
- No token, no LINK, no subscription. Native ETH gas only.

## Interface (Pyth Entropy consumer pattern)

```solidity
interface IEntropy {
  function getFee(address provider) external view returns (uint128);
  function requestWithCallback(address provider, bytes32 userRandomNumber)
    external payable returns (uint64 sequenceNumber);
}
abstract contract IEntropyConsumer {
  // Entropy calls this back with the final random number
  function entropyCallback(uint64 sequenceNumber, address provider, bytes32 randomNumber) internal virtual;
}
```

Flow: `fee = getFee(provider)` → `seq = requestWithCallback{value: fee}(provider, userSeed)` →
later the keeper calls our `entropyCallback(seq, provider, R)` with the resolved `R`.

## Binding design — two options

The core question is HOW to fold `R` into the roll without killing instant gameplay.
Current roll: `roll = HMAC_SHA256(serverSeed, "${clientSeed}:${nonce}")`, serverSeed SHA256-committed
at entry, revealed at run end.

### Option A — per-run anchor (max integrity, adds latency)
Request Entropy at the paid enter tx; the run's rolls use
`HMAC(serverSeed, "${clientSeed}:${R}:${nonce}")`. `R` is unknowable at commit time and
uncontrollable by anyone. Downside: `R` arrives in a second (keeper) tx, so the first door
must wait ~1 block for the callback. Breaks the current instant-enter feel unless we mask the
wait behind the cinematic entrance.

### Option B — epoch anchor (RECOMMENDED: keeps gameplay instant)
A keeper-independent cadence (e.g. every K blocks or N minutes) requests one Entropy value;
`entropyCallback` stores `R_epoch` + its `sequenceNumber` on chain. Runs started in that epoch
fold `R_epoch` into the roll: `HMAC(serverSeed, "${clientSeed}:${R_epoch}:${nonce}")`.
Gameplay stays instant (no per-run wait); outcomes are still anchored to an unpredictable,
publicly-verifiable on-chain value the operator did not choose. Rule: a run's serverSeed commit
MUST be locked before the epoch's `R_epoch` is known (enforce commit-before-anchor ordering), so
the operator can't grind serverSeeds against a known `R`.

Recommendation: ship Option B. Revisit A only if we want per-run on-chain provability and are
willing to hide the callback latency in the entrance animation.

## Contract changes (UUPS upgrade)

- Import Entropy consumer; store `entropy` + `provider` addresses (settable by owner/Safe).
- Option B: add `requestEpochEntropy()` (permissioned keeper), `entropyCallback` writes
  `epochRandom` + `epochSeq` + `epochBlock`, emit an event.
- Expose `epochRandom()`/`epochSeq()` as views so the server + a public verifier can prove each roll.
- Upgrade via the existing Safe 2-of-2 (UUPS `upgradeToAndCall`).

## Server changes (robbing-the-vault-dev/server.js)

- Read `epochRandom()`/`epochSeq()` via `roProv()` (already has Alchemy failover).
- Fold `R_epoch` into `roll(...)` and record `epochSeq` on each `rtv_runs` row for auditability.
- Extend the public "verify the draw" so anyone can recompute the roll from
  (serverSeed, clientSeed, R_epoch, nonce).

## Risk mitigations (mandatory)

1. **Liveness / stall:** provider is a single operator EOA (also the contract owner; can pause /
   withdraw / raise fee). Keep commit-reveal able to settle with the last-known `R_epoch` if
   Entropy stalls; add a `maxEpochAge` fallback and a timeout→refund path for any per-run request.
2. **Fee drift:** always `getFee(provider)` at request time; fund dynamically.
3. **L2 sequencer / unverified source:** use reveal-delay semantics; get the Entropy contract
   source verified on an explorer before it guards real money. Never derive outcomes from raw
   block data (PREVRANDAO is constant on this Arbitrum-Orbit chain).
4. Consider asking Pyth to also register their canonical provider `0x52DeaA…` on 4663 so we have
   a fallback provider that isn't the same key that owns the contract.

## Validation

- Deploy the upgrade to testnet (46630) first, run the keeper cadence, confirm `entropyCallback`
  lands and `epochRandom` updates, and that the public verifier reproduces rolls end to end.
- Only then upgrade mainnet via the Safe.
