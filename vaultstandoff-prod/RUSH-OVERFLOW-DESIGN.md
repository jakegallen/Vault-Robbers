# Rush Overflow / Multi-Game Fill — design + integration spec (2026-10-13)

Goal (Jake): under a rush, satisfy EVERY deposit and fill MULTIPLE games in strict
deposit-landing order, until the admin's per-game cap is the only limit. No lost funds,
no purchase-time ordering, slow origins (BTC/ETH-L1) roll forward instead of being dropped.

## What already holds today (verified in server.js, rmfill engine)
- Seats fill by ON-CHAIN buyIn landing order (chain-arbitrated), NOT purchase time. Fair.
- A swap never starts unless pre-flight says a seat is near-guaranteed (seat margin 3,
  grace margin 90s), so a slow BTC buyer is routed to the next round BEFORE spending.
- If the targeted round locks mid-swap, the delivered RVLT auto-rolls to the next open
  round; if both open rounds are full, the RVLT is kept in the wallet (never lost) and a
  one-tap retry deposits it with no second swap.
- Two rounds are always open (current + pre-opened next), zero dead time.
- roundTarget (per-game cap) is live-adjustable via /api/admin/config — the width lever.

## The gap
Only TWO rounds are buyable at once, and the engine tracks fill for the ACTIVE round only.
A 200-person simultaneous rush fills game-by-game as rounds cycle; nothing is lost or
mis-ordered, but throughput is bounded by (2 open rounds x cadence). True parallel fill
needs per-round seat tracking across an N-round open window + a "first open round with
room" resolver.

## Proven algorithm (overflow-sim.js, run it: `node overflow-sim.js`)
Allocator: keep `preopenDepth` rounds open ahead (dynamic deepening up to maxOpenRounds);
`nextBuyRound()` = earliest open round with sold<cap; seat is taken at buyIn LAND time,
cascading to the next open round if the assigned one filled in the gap.
Results (deterministic):
- 200 buyers, cap 5, depth 3  -> 40 games, 200 seated, 0 lost, 0 over-cap, deposit-ordered.
- 200 buyers, cap 50          -> 4 games, 200 seated, 0 lost. Fast tokens take early seats;
  slow (ETH-L1/USDC-eth/BTC) land later and cascade into later games — exactly the ask.
- 50 buyers, cap 5, depth 2   -> 10 games, 50 seated, 0 lost (reduces to today at depth 2).

## Integration into prod rmfill (the actual change)
1. CFG: add `preopenDepth` (default 2 = TODAY; range [2,12]) + `maxOpenRounds` (default 20;
   [2,50]). At depth 2 the whole feature reduces to current behavior (inert ship).
2. Per-round seat tracking for the OPEN WINDOW: maintain sold counts for every open round
   id (not just G.rmId), updated from the existing on-chain escSync (ticketsOf per open id).
3. rmEscrowLifecycle pre-open: open cur..cur+(preopenDepth-1) (rmEscOpenRound is idempotent),
   reserve the consumed ids, and when depth>2 open one more each time the deepest open round
   crosses thresholdPct (dynamic deepening, capped at maxOpenRounds).
4. Resolver: RM_BUY / currentBuyRoundId() = first open round with sold<target and not
   locking (scan the open window in id order). preflight already validates the specific round.
5. Post-swap cascade: buyInViaRelay already rolls to next; extend to walk the whole open
   window so a rush never strands delivered RVLT.
6. Lock/commit/settle/boot-reconcile must handle N open rounds (today handles 2). This is the
   delicate part — each open round still plays in turn; only the "how many are warm + tracked"
   changes.

## Why this is NOT hot-patched to prod yet
- It's an architectural change to a LIVE MAINNET money engine (parallel per-round fill).
- The dev twin (vaultstandoff-dev) runs the OLDER fill/clock engine, not rmfill — it is a
  stale test bed and cannot faithfully exercise this.
- Correct path: (a) refresh vaultstandoff-dev to the current rmfill engine (testnet-scoped),
  (b) implement 1-6 there, (c) rush-test (simulate N concurrent mixed-speed buyIns, assert
  deposit-order seating + overflow + 0 loss), (d) promote to prod with preopenDepth still
  defaulting to 2, (e) raise preopenDepth when ready.
- The algorithm is already proven (sim); only the lifecycle wiring needs the test bed.

## Interim safety (already true)
No deposit is lost today: pre-flight blocks doomed swaps, the post-swap cascade + kept-RVLT
net catch overflow, and roundTarget can be raised live to widen each game under load.
