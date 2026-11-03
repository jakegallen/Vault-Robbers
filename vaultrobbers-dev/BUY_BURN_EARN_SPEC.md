# Buy, Burn, Earn — RVLT V2 Economic Spec (draft v2 for sign-off, 2026-09-11)

Status: SPEC ONLY. No code changed yet. Target: V2 launch (Tuesday). Prices: ETH ~$3,190, RVLT ~$0.00079.

## Roles (who does what)
- BUY (Emblem Terminal, external, scheduled hourly): take 50% of RobinVault creator fees (of the 0.7% creator share) -> BUY RVLT -> SEND RVLT into the pot. Always to the pot, in that order. No routing/overflow logic. Confirmed by Emblem team.
- BURN (game): 2,000 RVLT per play, 100% burned to dEaD. No practice arcade in V2 (removed) so every play burns.
- EARN (game contract): cash-out ladder chambers 6-10 + core ETH.
- ETH VAULT refill: MANUAL by Jake (from his 13 ETH reserve). Not fed by the buyback. Seed ~2 ETH.

## Cash-out model: ALL PERCENT, EACH WITH A HARD CAP
Single unified formula for every tier: `payout = min(pct[C] * pot, cap[C])`, then `min(that, pot - potFloor)` underflow guard.
Chamber = the room the player is standing in (cleared the previous). No cash-out chambers 1-5.

| Standing in | cleared | pct of pot | hard cap (RVLT) | behaves like | reach |
|---|---|---|---|---|---|
| Ch6 | 5 | 1% | 1,000 | ~fixed 1,000 (half your 2,000 back) | 15.1% |
| Ch7 | 6 | 3% | 3,000 | ~fixed 3,000 | 5.0% |
| Ch8 | 7 | 5% | 9,000 | ~fixed 9,000 | 1.0% |
| Ch9 | 8 | 10% | 800,000 | 10% until pot 8M, then capped | 0.13% |
| Ch10 / Core | 9 | 25% | 2,000,000 | 25% until pot 8M, then capped; OR crack for ETH | 0.014% |

- Shallow caps (1k/3k/9k) bind at any real pot (>~180k), so ch6-8 feel fixed and predictable.
- Deep tiers (ch9/ch10) scale as 10%/25% up to an 8M pot, then the cap holds. Big-win feel preserved, farm risk removed.
- Core (Ch10): crack for 100% of the ETH vault OR take 25% of pot; winner takes the higher USD value. ETH is more liquid (can't cleanly market-sell millions of RVLT), so many take ETH anyway. Natural balancing, no cap logic needed on the choice.
- NO pot soft cap. Pot grows freely; the per-cash-out caps do the safety work.

BEFORE (V1, pure % no cap): Ch6-10 = 1/3/10/20/30% of pot. Drain ~1,090 RVLT/play @1M pot and it scaled WITH the pot. Bled V1 (3.13M RVLT + 13.1 ETH out vs 905k in, 2.25 days).

## Farm-safety proof (holds at ANY pot size because payouts are capped)
Max expected winnings for a perfect deep-pusher (all caps binding, worst case):
- Ch8: clear7 0.01004 x 9,000 = 90
- Ch9: clear8 0.001305 x 800,000 = 1,044
- Ch10: clear9 0.0001435 x 2,000,000 = 287
- Total ~1,421 RVLT expected vs 2,000 burn. House keeps ~29% edge at ANY pot size, forever. Not farmable.
Every shallow strategy is far more negative (bank 1,000 at 15% reach = 150 expected vs 2,000 burn).
This is why per-cash-out caps beat a pot cap: the pot can be 5M or 50M, the caps keep EV < burn regardless.

## Expected drain + sustainability
Behavior model bank rates 25/40/50/60/70% at ch6-10. Expected drain ~120-165 RVLT/play (1M-3M pot); the caps keep it from scaling away.
Inflow (50% of 0.7% fees, in RVLT): $20k/day vol ~88k RVLT/day; $50k ~221k; $100k (anchor) ~442k RVLT/day.
Net at $100k anchor: +400k+/day at 200 plays, +360k at 500, +280k at 1,000. Pot grows at every realistic level.
Low-volume corner ($20k, 1,000 plays) goes slightly negative; covered by the 20M RVLT treasury backstop.

## Anti-farm: automated tracking (no manual approval gate)
Jake does NOT want a pre-payout approval gate. Payouts flow automatically. Instead, harden the automated bot-tracking:
- Extend rtv_bot_signals to score per-wallet patterns, especially wallets that repeatedly BANK the two deepest tiers (Ch9/Ch10) with bot signatures (superhuman timing, low humanness, shared IP/UA, common funder cluster).
- Flag + auto-throttle/ban flagged wallets (rtv_reviews already models this); no human approval needed to pay a clean winner.
- Because the caps make farming -EV, detection is a backstop, not the primary defense (a bot that evades detection still loses money).
- RECOMMENDED (not approval, just a circuit-breaker): on a CORE ETH crack (the one big payout), a short notify + optional time-delay so Jake can react to an obvious bot before the ETH moves. Non-blocking for RVLT cash-outs. Jake to decide keep/drop.

## Contract changes (RobbingTheVaultV2, Safe upgrade)
State (owner-settable): `uint16[11] pctBps` (Ch6-10 = 100/300/500/1000/2500), `uint256[11] payoutCap` (1000e18/3000e18/9000e18/800000e18/2000000e18), `uint8 cashoutMin = 6`, `uint256 potFloor` (~100000e18).
Payout at chamber C: `pay = min(pot * pctBps[C] / 10000, payoutCap[C]); pay = min(pay, pot > potFloor ? pot - potFloor : 0);` decrement pot, transfer to recorded r.player, settle-once.
Deposits: `depositPot(uint256 amount)` add-only (Terminal buyback calls this; open-to-anyone OR dev-only per Jake). `depositEthVault() payable` for manual ETH seeding. No pot cap.
Core: `crackCore(runId, choice)` ETH (100% vault) or POT (25%), single-settle, operator-signed authoritative outcome, commit-reveal. Cannot claim both.
Keep: settle-once per runId, pay recorded player, operator signs server-authoritative outcome only, reentrancy-safe, Pausable, owner=multisig (mainnet), operator=dedicated hot key.

## Server changes (vaultrobbers-dev)
- CASHOUT_MIN 5 -> 6.
- Replace POT_LADDER with unified `{C:{pctBps,cap}}` for 6-10; compute offer = min(pct*pot, cap); sync pctBps/caps from chain so display == payout.
- /api/config + cash-out UI: show the min(percent, cap) offer per tier + USD value; Core shows ETH-or-25% choice.
- Remove practice arcade (delete arcade routes + pass gate); all play = real paid entry.
- Enhance bot-tracking (deep-tier repeat-banker scoring).

## Terminal job (Emblem, external)
Hourly: take 50% of accrued creator fees -> buy RVLT -> depositPot(). Small clips / TWAP to avoid sandwich MEV on the buy.

## Red-team checklist (all mitigated)
1. Deep-% farmable on a big pot -> PER-CASH-OUT CAPS (headline; farm-safe at any pot size, no pot cap needed).
2. Fixed/low-cap cash-out zeroing a depleted pot -> min(payout, pot - floor) guard.
3. Core double-claim -> single-settle, one crackCore.
4. Buyback sandwich MEV -> Terminal TWAP/clips.
5. Pot deposit abuse -> add-only; only exit is a game settle.
6. Client-claimed outcome -> operator signs server-authoritative outcome only (C1 fix, in place).
7. Free-run farming -> paid-entry verify, bot-signal monitor, 60s post-cashout cooldown, per-IP rate-limit, Turnstile fail-closed.
8. Bot winners -> automated deep-tier flagging + ban (no manual approval); optional notify/delay on ETH crack.
9. Owner/operator key risk (mainnet) -> owner=multisig, operator=dedicated hot key.

## Rollout order (dev-first, prod-gated; Tuesday launch)
1. Sign off numbers (this doc).
2. Contract V2: pctBps + payoutCap ladder, cashoutMin, deposit funcs, core choice, guards; test suite; Safe upgrade (testnet then mainnet).
3. Server: cashoutMin, unified ladder, chain-sync, config/UI, arcade removal, bot-tracking. Dev twin first.
4. Dedicated adversarial CODE review on the implementation before promotion.
5. Terminal buyback job live (Emblem).
6. Seed 2 ETH vault + initial RVLT pot; enable.
If Tuesday is firm and the contract upgrade + audit cannot finish: launch with the ladder server-gated (offers computed server-side, capped) and ship the contract upgrade right after; caps still enforced in the offer math.

## Open decisions
1. Confirm pctBps 1/3/5/10/25% and caps 1k/3k/9k/800k/2M RVLT.
2. depositPot open-to-anyone or dev-wallet-only?
3. potFloor value (suggest 100k RVLT).
4. Keep the optional notify/short-delay on a CORE ETH crack (non-blocking), or fully automatic?

## Contract deliverable — RobbingTheVaultV4.sol (drafted 2026-09-11)
Written at rtv-contracts/src/RobbingTheVaultV4.sol. Append-only UUPS upgrade of V3:
- NEW storage: `mapping(uint8=>uint256) payoutCap` + `uint256 potFloor` (2 slots from __gap[36]->[34]).
- settle() payout = min(pct*pot, cap) then floored to (pot - potFloor). Mirrors the server payoutFor() exactly.
- crackCore() UNCHANGED (ETH or 100% pot; the rare apex, intentionally uncapped).
- seedPot() add-only (Terminal buyback calls this hourly). quoteCashout(stage) view for UI/admin.
- Runtime setters (owner=multisig): setLadder(stage,bps), setPayoutCap(stage,cap), setPotFloor(f), setCashoutMin.
- initializeV4() reinitializer(4) one-shot sets the whole ladder.

### Safe migration batch (run once on upgrade; order matters — caps MUST be set or the ladder falls back to uncapped pure-%)
1. upgradeToAndCall(V4_IMPL, initializeV4())   // sets everything below in one shot, OR do the explicit calls:
   - setCashoutMin(5)
   - setLadder(5,100) setLadder(6,300) setLadder(7,500) setLadder(8,1000) setLadder(9,2500)
   - setPayoutCap(5,1000e18) setPayoutCap(6,3000e18) setPayoutCap(7,9000e18) setPayoutCap(8,800000e18) setPayoutCap(9,2000000e18)
   - setPotFloor(100000e18)
2. setSponsor(<terminal buyback wallet>) if the Terminal calls seedPot from a dedicated wallet (or leave seedPot open).
CRITICAL: until the caps are set, payoutCap=0 = uncapped = the V1 bleed. The upgrade is not complete until step 1 runs.

## Anti-farm tracking (shipped server-side, track-only)
/api/bot-review now returns `deepBankers`: wallets that banked the two deepest tiers (cleared 8-9 = Ch9/Ch10) >=3 times in the
window, with distinct-IP count + mean humanness. Surfaced for review only; never blocks a cash-out (RVLT is cheap to acquire).

## Build status (2026-09-11)
- SERVER (vaultrobbers-dev): capped ladder payoutFor() + POT_PAY_FLOOR + /api/admin/ladder runtime setter + config exposure + deepBankers tracking. DONE, flag-gated RTV_LADDER_V2 (off until contract live). node --check clean.
- CONTRACT: RobbingTheVaultV4.sol drafted for team review + Safe deploy (compile + test on the team's side).
- PENDING: client offer UI (min pct,cap display) + rtv-admin ladder panel; flip RTV_LADDER_V2 on after V4 is live on testnet; dedicated code-level red-team of V4 before mainnet. Arcade removal deferred (Jake still testing mini-games).
