# Vault Standoff — Launch-Readiness R&D Synopsis (2026-10-17)

Combines two deep read-only audits (purchase/pay/gas pipeline; queuing/on-chain/overflow) + the overflow-roundabout scoping + the rake-funded-gas strategy. Goal: make the whole experience fast, smooth, simple, efficient, and rush-proof.

## 0. Bottom line
- The game is money-safe. No live security hole in the buy/pay/gas or lifecycle paths. All invariants intact (no rake on void, refund every payer, on-chain rangeSpent double-buy guard, bounded approvals, per-wallet caps, SEC-1 per-round seed).
- Launch can proceed on the current model AFTER two launch-critical relayer-robustness fixes (below). Everything else is polish or post-launch.
- The rake-funded-gas strategy is correct and absurdly sustainable (quantified below).

## 1. Gas + buy-pressure strategy (validated)
- Native 4663 gas is ~$0.001 per drip (21k gas @ 0.02 gwei, ETH ~$2400); a relayer buyInForRange ~$0.006. Worst case ~$0.007/buy.
- Rake at $10 entry = $0.50/ticket. Subsidy is <2% of rake. 10,000 buy-ins = ~$5,000 rake vs ~$70 gas.
- Every non-RVLT buy-in is an external-liquidity RVLT market-buy via Relay = net buy-pressure on the coin. Treat gas subsidy as customer-acquisition cost. VERDICT: subsidize liberally; raise the daily drip cap (VS_GAS_DRIP_DAILY_MULT 12 -> 50-100) and keep the global/hour + relayer-reserve guards as the real ceiling. Farming yields sub-cent dust (drip is non-withdrawable native gas), so no abuse risk.

## 2. Buy experience — friction + fixes (client, served live)
Current Relay buy = 3-5 signatures, ~7+N server round-trips. Biggest wins:
- F1/C1 (HIGH): the Relay path quotes TWICE (entry-quote + relayDeliver's own quote). Collapse to one; pass the pre-fetched quote into relayDeliver. Removes one 20s-timeout round-trip per external buy.
- F3/C2 (HIGH): the gas leg runs IN FRONT of the RVLT convert (two sequential Relay trips for gasless buyers). Overlap them (Promise.all). Shaves the whole gas leg off the critical path for the cohort we most want to convert.
- F2/C3 (HIGH): status-poll loop is coarse (3s floor) + serial. Faster early ramp (600ms x6 then 2s). 1-3s off most fills.
- F5/C4 (MED): preflight runs up to 3x per Relay buy. Drop the redundant client preflight (server gates inside entry-quote).
- F4/C5 (MED): has4663Gas optimistic-null lets gasless buyers reach the signer and fail. Pre-warm the balance read at pay-sheet open so we drip ahead.
- F6/C6 (LATER): network-switch friction for multi-chain holders.
- C7 (LATER, depends on Relay): single combined "gas + RVLT" multi-output quote so a gasless external buyer signs ONE origin deposit.

## 3. Queue health / staleness (server)
Root cause of the backlog (~21 pending): abandoned Open partials are un-voidable until the ~25h sentinel deadline, and boot resumes the OLDEST accountable round (re-parks cruft).
- B-1 (MED->do now): add staleOpenVoidSec (~15-30 min). In the settle-watcher Open-round branch, void-refund an Open sub-viable round older than the TTL instead of waiting 25h. Money-safe (lockRound only moves lock earlier; void refunds all, no rake).
- B-2 (MED->do now): on boot, RESUME only accountable rounds at/above threshold (viable); VOID-FORWARD sub-viable partials (RM_VOID_FLAG path already exists). Keeps the invariant, refuses to re-park cruft.
- B-4 (MED): widen the watcher scan window (currently [nextId-24, nextId]) so a deep backlog can't escape the sweep.

## 4. Relayer under a rush (server) — LAUNCH-CRITICAL
- RISK #1 (HIGH): mid-batch nonce-gap wedge. resetRelayNonce reseeds from `pending` and max(cursor,pend) refuses to move backward; if a middle nonce is rejected while higher nonces are already in the mempool, the gap is never re-broadcast and the relayer stalls. FIX: on a detected gap, reseed to the LOWEST unconfirmed (rejected) nonce, allowing a backward move in the reset path only. Money-safe (rejected nonce never entered a block; rangeSpent is the hard guard).
- RISK #2 (HIGH): unbounded broadcast burst. toSend has no cap; a 200-person rush fires 200 concurrent sends -> RPC rate-limit -> partial rejections -> triggers #1. FIX: cap the burst (AUTOBUY_BATCH_MAX ~25-40) + an in-flight ceiling; slice across 1s ticks.
- In-flight TTL (DONE, staged): 45s staleness on the in-flight lock so a hung receipt can't permanently wedge a wallet.
- Single relayer key = throughput ceiling (one serial nonce lane). A small relayer KEY-POOL (N keys, round-robin) is the scaling lever and complements the roundabout. CAVEAT: needs the contract to authorize multiple relayers (relayer() may be a single slot) -> likely a V8 contract change. Verify against the .sol first.

## 5. Overflow "roundabout" (post-launch, dev twin)
Recommended: HYBRID ELASTIC-CAP on the existing buyInForRange rail (matches RUSH-OVERFLOW-DESIGN.md + overflow-sim.js, which already proves 200 buyers, 0 lost, deposit-ordered). Target 10, ceiling ~20, spill beyond into the next pre-opened round; each round keeps its OWN pre-committed seed; funds lock on the round the buy landed in. Rejected alternatives: on-chain fill-cursor (contract risk + seed-across-rounds awkward), deposit-pool (custody surface), timer-elastic (breaks caps/fairness).
- Phasing: MVP preopenDepth=2 (inert, ~0.5d) -> Phase 1 per-round fill tracking (~2-3d) -> Phase 2 resolver+cascade (~3-4d) -> Phase 3 N-round lifecycle + dynamic deepening (~1wk + rush testing). No contract change for Phase 1-3; rides buyInForRange.

## 6. The plan — NOW vs LATER
NOW (one server restart): RISK #1 nonce-gap fix, RISK #2 burst cap, in-flight TTL (staged), staleness B-1/B-2, drip cap raise. These are the launch-rush robustness + queue-health set.
NOW (client, served live): pay quick-wins C1/C2/C3/C4/C5; plus the two open bugs (wallet reconnect-needs-refresh; auto-play tickets-each vs "1 left" display).
LATER (dev twin, post-launch): overflow roundabout Phase 1-3; relayer key-pool (verify contract first); chain-agnostic origin (C6); combined gas+RVLT quote (C7).
VERIFY (before high volume): the StandoffEscrow .sol is NOT in the repo — confirm voidRound Open-vs-locked rules, the relayer() single-slot-vs-allowlist (bears on key-pool), and settle budget math against the deployed source.
