# Vault Standoff — Threshold-Fill Model Design & Implementation Spec

Status: DESIGN / SPEC ONLY. No source edits, no deploy, no mainnet, no keys. This document specs the move
of real-money Vault Standoff off the fixed 4-minute wall clock onto a demand-driven threshold-fill cadence.

Author scope: read of `vaultstandoff-dev/server.js`, `vaultstandoff-dev/escrow.js`,
`standoff-contracts/src/StandoffEscrow.sol`. Testnet escrow 46630 at
`0x22B7AAC6dd09b6B97D7f330D123e4158640e1BeE`; mainnet is a UUPS proxy (Safe-owned).

---

## 0. Executive summary

Jake wants small fixed-size rounds (e.g. 25 tickets), auto-start at 50% fill with a ~10-minute grace cap
(or immediately when full), zero dead time, max throughput. Today real money ONLY runs on a fixed
wall-clock cadence (`MODE` = `dev|demo|daily`), and the fill engine is explicitly fake-chip-only (a hard
boot assertion refuses `VS_ESCROW=on` with a non-clock engine, server.js:105-108).

The single hard blocker is the contract: `openRound(id, entry, lockTime, deadline)` fixes `lockTime`
**at open time** (StandoffEscrow.sol:103-109), and `buyIn` requires `block.timestamp < lockTime`
(line 114) while `commit` requires `block.timestamp >= lockTime` (line 128). A fill-driven start time is
not known at open. **A contract change IS required** for a true threshold model (details in §1).

Recommendation at a glance:
- §1: Add one `onlySigner` function `lockRound(uint256 id)` that sets `lockTime = block.timestamp`. Minimal,
  storage-safe (no new storage, reuses the existing `lockTime` slot), UUPS-upgrade-safe (no layout change,
  `__gap` untouched). This is the ONLY contract change needed.
- §2: Replace the real-money driver with a fill-cadence state machine that opens a round with a far-future
  `lockTime` sentinel, watches the on-chain pot for the threshold, then calls `lockRound` to close buy-in
  exactly at threshold+grace or full. Keep the rolling two-round pre-open and restart-resilience.
- §3: Per-round relative cap = `ceil(10% of target)` as a fixed per-round constant; enforce app-side today,
  optionally add a stored `maxTicketsPerWallet` per round in a later contract rev.
- §4: Recurring auto-buy: recommend **allowance + relayer with a strict per-call policy** over session keys
  or a subscription contract, with the custody analysis below.
- §5: Holder 50% discount: recommend **tiered entry within a single pot** (holder vs non-holder ticket price,
  equal pot shares) via a small contract change, OR a post-hoc treasury rebate with no contract change.
- §6: Yes — a dynamic cadence removes the fixed-interval collision, which unlocks player-clicked sudden-death
  overtime (currently `suddenDeath()` runs synchronously inside one tick).

Phasing (full detail §7): Phase A server-only (fill-cadence scaffolding, still on clock contract calls behind
a flag) → Phase B contract change `lockRound` (testnet redeploy + mainnet Safe upgrade) → Phase C auto-buy →
Phase D holder discount → Phase E interactive overtime.

---

## 1. THE CORE PROBLEM — is a contract change required?

### 1.1 Why the current contract cannot do fill-driven start

`openRound` requires `lockTime > block.timestamp` and `deadline > lockTime` at open (line 105). The clock
driver computes these deterministically from the schedule:

```
// escrow.js:80-83 / server.js:382
escrow.openRound(gs, entry, floor(chooseStart[0]/1000), floor((gameEnd+3600000)/1000))
```

In a fill model the lock time is **unknown at open** — it is whenever 50% sells (bounded by a grace cap) or
when the round fills. There is no on-chain way, with the current ABI, to move `lockTime` after open.

### 1.2 Can a convention avoid the change? (evaluated, rejected)

**Convention A — open with `lockTime = now + grace` (fixed 10 min), ignore the threshold on-chain.**
Buy-in auto-closes at the grace cap; the server starts the game when the pot crosses threshold but leaves
buy-in open on-chain until the grace cap. Trade-offs:
- Breaks "auto-start at 50%": once the game is playing you cannot still accept buy-ins (the engine has a
  locked roster), but the contract would still accept `buyIn` until `lockTime`. You would take money for a
  round the player can never be seated in → refund/void churn, or a seat-after-start exploit. Unacceptable.
- You could instead NOT start the engine until the grace cap, i.e. always wait the full 10 min. That is just
  a 10-minute fixed clock — it defeats the throughput goal and the "immediately when full" requirement.

**Convention B — open a fresh round at threshold with `lockTime = now + tiny`.**
Only open the on-chain round once the off-chain fake-seat threshold is hit, then give a very short buy-in
window. Trade-offs:
- Players cannot pre-commit real money toward the fill; the threshold must be reached with fake interest,
  then a race to buy in a tiny window. Terrible UX, and it breaks the rolling pre-buy that exists today.
- Still fixed-window, just a short one. Does not achieve "fill drives the lock".

**Conclusion:** No pure-convention path satisfies (auto-start at 50%) AND (keep buy-in open until then) AND
(immediate on full) AND (no dead time). A contract change is required. The minimal one is a signer-only
`lockRound`.

### 1.3 The minimal, storage-safe, UUPS-friendly change

Add a single `onlySigner` function that sets `lockTime = now` and leaves everything else intact. `openRound`
is opened with a **sentinel far-future `lockTime`** (e.g. `now + MAX_FILL_WINDOW`, a generous cap such as 24h)
so `buyIn`'s `block.timestamp < lockTime` stays true during the fill, and `commit`'s `>= lockTime` only
becomes true once the signer calls `lockRound`.

No new storage variables. It writes the EXISTING `lockTime` slot in the EXISTING `Round` struct. Storage
layout is byte-identical; `__gap` is untouched. This is the safest class of UUPS upgrade (pure logic add).

#### Solidity diff

```solidity
// --- add near openRound, same onlySigner section (StandoffEscrow.sol ~line 109) ---

event RoundLocked(uint256 indexed id, uint64 lockTime);   // add beside the other events

/// @notice Close buy-in NOW for a still-open round (fill-driven start). Sets lockTime to the current block
/// so buyIn (requires < lockTime) reverts and commit (requires >= lockTime) becomes callable. Signer-only:
/// it is the same trust boundary as openRound/commit and cannot move money. Idempotent-guarded: only an Open
/// round whose lockTime has not yet passed can be locked early.
function lockRound(uint256 id) external onlySigner {
    Round storage r = rounds[id];
    require(r.status == Status.Open, "not open");
    require(block.timestamp < r.lockTime, "already locked");
    r.lockTime = uint64(block.timestamp);
    emit RoundLocked(id, r.lockTime);
}
```

And `openRound` stays as-is — the server simply passes a sentinel `lockTime`. Optionally relax nothing; the
existing `lockTime > block.timestamp` check is satisfied by the sentinel.

Why this is safe:
- `onlySigner` is the same hot-key boundary that already opens/commits/settles. `lockRound` moves no funds,
  changes no config, cannot pay a non-participant. Worst case a leaked signer locks a round early → players
  who intended to buy in are denied; they lose nothing (funds only ever leave by settle/refund), and the
  owner can `voidRound` after deadline to refund everyone. Bounded exactly like the existing commit path.
- No reorder/removal of storage. No new state var. `uint256[45] private __gap` unchanged. `Round` struct
  unchanged (we reuse `lockTime`).
- `deadline` is still set at open (sentinel `lockTime` plus a safe margin). `commit`'s `>= lockTime` and
  `settle`/`claim`/`void` are all unaffected.

#### A note on `deadline` with the sentinel

`openRound` requires `deadline > lockTime`. If `lockTime` is a 24h sentinel, `deadline` must be > that. That
is fine — `deadline` is the void backstop (anyone can void an un-settled round after it). After `lockRound`
moves `lockTime` earlier, `deadline` is unchanged and still comfortably in the future. The server should set
`deadline = sentinelLock + playWindow + challenge + margin` so a stalled round is still voidable on a sane
timeline. (If the fill never reaches threshold within the grace cap, the server calls `lockRound` anyway at
the grace cap to start whatever filled, OR lets it expire to `voidRound` for a refund — see §2.6.)

#### Alternative shape considered (rejected as heavier)

`openRound` without `lockTime` + a separate `lockRound`: this requires changing `openRound`'s signature and
the `RoundOpened` event, touching the off-chain ABI and the restart-resilience read path. The single-function
add above is strictly smaller and keeps `openRound`/`RoundOpened` byte-compatible with the deployed ABI used
in escrow.js:44-51. Prefer the single add.

---

## 2. Server / engine design — fill cadence instead of wall clock

Today two engines exist (server.js:2-6): `fill` (fake chips only) and `clock` (the only real-money path).
`realMoney()` is defined as `escrow.isOn() && C.engine==='clock'` (server.js:191), and the fill engine is
explicitly off the on-chain path. The target is a THIRD mode: a fill engine that IS the real-money driver.

### 2.1 New mode shape

Add a real-money-capable fill mode (keep the existing fake `fill` untouched for preview):

```
rmfill: {
  engine:'rmfill', target:25, threshold:0.5, graceMs:600000, fullIsImmediate:true,
  choose:15000, blind:1000, reveal:5000, maxch:6,
  perWalletCap: /* ceil(0.10 * target) = 3 for target 25 */,
  settleGapMs:0   // no dead time: open the next round the instant this one locks
}
```

Boot assertion change: today server.js:105 refuses escrow-on unless `C.engine==='clock'`. Extend it to
accept `C.engine==='rmfill'` as a valid real-money engine. The fake `fill` engine stays forbidden with
escrow on (it has no on-chain rounds). `realMoney()` becomes
`escrow.isOn() && (C.engine==='clock' || C.engine==='rmfill')`.

### 2.2 The real-money fill state machine

Per round, module-scope state keyed by `roundId` (not `G`, which is recreated per game):

```
states: open -> filling -> locking -> committed -> playing -> settled/voided
```

Round IDs: the clock model uses the aligned timestamp `gs` as the id. The fill model has no timestamp grid,
so use a **monotonic counter** persisted to disk (e.g. `.vs-store/rmround.json: { nextId }`), surviving
restart. Round id = integer sequence (1, 2, 3, ...). This matters for the contract `id` and for the proof
store keys.

Lifecycle driven from the 1s `tick()` (server.js:442-443), through a new `rmfillTick()` plus a new
`rmEscrowLifecycle()` that replaces the clock-specific `escrowLifecycle()` when `C.engine==='rmfill'`:

1. **open** — If fewer than two rounds are open on-chain, open the next with the sentinel:
   `openRound(id, entry, now + MAX_FILL_WINDOW, now + MAX_FILL_WINDOW + playMargin)`.
   Persist the round seed at open (reusing `ensureRoundSeed(id)`; this already locks the seed so the later
   commit hash matches — server.js:380, 54).
2. **filling** — Poll the on-chain pot/ticket count (`escrow.potRvlt(id)` / per-wallet
   `escrow.ticketsOf(id, addr)`, escrow.js:88-89) on the existing ~3s throttle (server.js:427). Seat wallets
   into the lobby exactly as today via `seatWalletCount` (server.js:194, 432-433). Track `ticketsSold`.
   - Arm the grace timer the first time `ticketsSold >= ceil(threshold * target)` (e.g. >= 13 of 25):
     `graceEndsAt = now + graceMs`.
3. **locking** — Lock buy-in when `ticketsSold >= target` (full → immediate) OR `now >= graceEndsAt`
   (grace cap reached with >= threshold). Call the new `escrow.lockRound(id)`. This is the fill analogue of
   the clock's "lock at `chooseStart[0]`".
   - Guard: only lock if `ticketsSold >= minViable` (e.g. >= 2 real participants, else there is no game).
     If the grace cap is hit with < minViable, see §2.6 (void/extend).
4. **committed** — After `lockRound` confirms, call `escrow.commit(id, seedHash)` (escrow.js:84) exactly as
   the clock path does at lock (server.js:396-398). Snapshot the seated roster into `G`, build routes, run
   the heist.
5. **playing** — Run the chambers on a RELATIVE clock from the lock instant (identical math to the fake fill
   engine's `running` phase, server.js:354-359: `rel = now - runStart`, `SLOT = choose + reveal`). No wall
   grid. On `done`, resolve champion exactly as today.
6. **settle** — `escSettleGame()` logic unchanged (server.js:400-412): real winners → `settleEqualSplit`,
   no real winner → `voidRound` for refund. Keyed off the same durable seed so a restart mid-round still
   settles.
7. **open the next** — The instant a round moves to `locking`, open the next round (step 1). This is the
   zero-dead-time property: while round N plays, round N+1 is already `open/filling`.

### 2.3 Rolling two-round pre-open (preserved and generalized)

The clock model keeps BOTH `cur` and `next = cur + interval` open (server.js:418-420) so a spectator can
pre-buy the upcoming heist. The fill model preserves this with the monotonic counter: always keep the
`playing/locking` round AND the next `open/filling` round live. `G._buyRound` becomes "the round a buy-in
targets" = the earliest round still in `open/filling` (server.js:425 analogue). The client `escrow` block
(server.js:647) continues to surface `id = buyRound`, `pot`, `live`, `startsIn` — but `startsIn` changes
from a wall-clock delta to "estimated fill" (or simply drop the countdown and show
`ticketsSold / target` + grace remaining, which is the whole point of the model).

### 2.4 Restart resilience (preserved)

Today a mid-round restart wipes `ESC_OPENED/ESC_COMMITTED/ESC_SETTLED`, and the re-open re-reads on-chain to
avoid orphaning (server.js:383-391). This logic ports directly:
- On boot, read the persisted `nextId` and scan backward a few ids: for each, `readRound(id)` (escrow.js:85)
  and rebuild in-memory sets from on-chain `status` (`>=1` Open → track; `>=2` Committed → mark committed).
- A round that was `Open` with a passed sentinel-or-locked `lockTime` but never committed → re-commit from
  the durable seed (seed survives in `seeds.json`, server.js:47-54).
- A round `Committed` but not `Settled` whose off-chain game state is lost → the server cannot reconstruct the
  roster deterministically from chain alone (picks live in `picks.jsonl`, server.js:42, and the roster in
  `G`). Fallback: if the play window + challenge has elapsed and no settle is possible, let `deadline` pass
  and `voidRound` for a full refund (the contract guarantees funds are claimable, StandoffEscrow.sol:192-214).
  This is the same safety net the clock model relies on.

Key invariant kept: the seed is committed at OPEN (server.js:380) so commit==reveal always holds, and the
durable seed store lets any orphan settle-or-void. The fill model must keep committing the seed at open, not
at lock, for exactly this reason.

### 2.5 Interaction with `lockRound` timing and the void-grace SLA

escrow.js:67-74 documents an off-chain SLA: the operator settles-or-voids every round within `VOID_GRACE_SEC`
(default 15m) of its deadline, so the public-void griefing window only opens after. With the fill model:
- `deadline` is now far out (sentinel + margin), so the public-void path is naturally distant. Good.
- The NEW griefing concern is `lockRound` itself: a leaked signer could lock early. Mitigation: `lockRound`
  is `onlySigner` (same key, same bounded blast radius as commit), and a prematurely-locked round still pays
  only real participants or voids to refund. No new trust is introduced.

### 2.6 Under-fill handling (grace cap reached below threshold)

If the grace cap is reached with `ticketsSold < ceil(threshold*target)` (not enough demand):
- Option (recommended): **extend quietly** — do NOT lock; keep filling, re-arm a shorter grace, and surface
  "waiting for players" in the UI. No dead time because the next round is not yet needed. Cap total open time
  at `MAX_FILL_WINDOW` (the sentinel lock). If the sentinel is hit, the contract's own `lockTime` passes and
  buy-in closes; the server then either plays whatever filled (if `>= minViable`) or lets `deadline` pass to
  `voidRound` for refunds.
- Do NOT auto-void the instant grace lapses — that would refund a half-filled room that was about to fill.

### 2.7 What stays identical (do not touch)

- Verifiability core (seed commit/reveal, `prng`, proofs) — server.js:16-65, 144-154. Unchanged.
- Resolution logic (`resolve`, `resolveFinale`, `suddenDeath`, winner-takes-all) — server.js:198-284.
- `settleEqualSplit` and the settle/void branch — escrow.js:93-104, server.js:400-412.
- The fake-chip `fill` preview engine — server.js:331-366. Left as-is for the gated preview.

---

## 3. Relative per-wallet cap (~10% of a round)

### 3.1 Current state

App-side only: `MAX_TIX_WALLET = clamp(VS_MAX_TICKETS_PER_WALLET, 1, 100)` (default 10), enforced in
`seatWalletCount` (server.js:116, 194) and surfaced to the client (server.js:638). On-chain the only cap is
`MAX_TICKETS = 100` per `buyIn` call (StandoffEscrow.sol:42, 115) — an **absolute per-call** cap, not a
per-round per-wallet cap, and trivially bypassed by multiple `buyIn` calls from the same wallet.

### 3.2 Recommendation

For a `target = 25` round, 10% = 2.5 → **fixed per-round cap = `ceil(0.10 * target) = 3` tickets/wallet**.

Enforce in TWO places:
1. **App-side (immediate, no contract change):** set `MAX_TIX_WALLET` dynamically per round to
   `ceil(0.10 * target)`. `seatWalletCount` already clamps seats to this (server.js:194), so a wallet that
   buys more on-chain than the cap is only SEATED up to the cap. BUT: on-chain they still PAID for the extra
   tickets and would be under-seated → they overpay for seats they do not get. That is unfair and must be
   prevented at buy time, not just at seat time.
2. **On-chain (recommended, needs a contract rev — fold into the §1 upgrade):** add a per-round
   `maxTicketsPerWallet` enforced in `buyIn`. Because the per-round target is small and fixed, a single
   stored `uint16` per round suffices.

#### On-chain cap — the storage-safe way

Do NOT reorder the `Round` struct. Add a **parallel mapping** (append-only storage, slot after existing
state, before `__gap` region is irrelevant since mappings occupy their own slots):

```solidity
// append after the existing mappings (StandoffEscrow.sol ~line 61), consumes one new storage slot number,
// does NOT touch __gap's reserved slots (mappings are keyed; this is append-only and layout-safe)
mapping(uint256 => uint16) public maxTicketsPerWallet;   // 0 = unlimited (back-compat)

// in openRound, accept and store it (or add a twin openRoundCapped to keep openRound byte-compatible):
function openRoundCapped(uint256 id, uint128 entry, uint64 lockTime, uint64 deadline, uint16 capPerWallet)
    external onlySigner
{
    openRound(id, entry, lockTime, deadline);           // reuse (make openRound internal-callable or inline)
    maxTicketsPerWallet[id] = capPerWallet;
}

// in buyIn, after computing the new ticket total for msg.sender:
uint16 cap = maxTicketsPerWallet[id];
if (cap != 0) require(tickets[id][msg.sender] <= cap, "wallet cap");
```

Decrement `__gap` by 0 — a new mapping does NOT consume `__gap` slots (mappings live at `keccak`-derived
slots). Appending the mapping declaration after the existing mappings is layout-safe for UUPS; the compiler
assigns it the next sequential slot number, which was previously unused. Confirm with
`@openzeppelin/upgrades` storage-layout check before the Safe upgrade.

### 3.3 Limits / caveats

- A determined Sybil still buys N wallets to exceed the per-wallet cap. As the Sybil note already documents
  (server.js:110-117), the economy is near-zero-sum: a Sybil buys a proportional share of a pot it also
  funds and cannot drain the house. The per-wallet cap limits **concentration/odds-buying within one
  identity**, not Sybil fan-out. SIWE (server.js:133-136) ties a seat to a proven address but not to a
  unique human.
- `ceil(10%)` on small targets rounds generously (target 25 → cap 3 = 12%). For exactly 10% use `floor` or a
  separate configured integer. Recommend `ceil` so small rounds are not over-restricted; document the
  effective percentage per target.

---

## 4. Recurring auto-buy authorization model

Goal: a player opts into "auto-enter the next N rounds" without signing each buy-in. Three models compared.

### 4.1 Allowance + relayer (RECOMMENDED)

Player signs one ERC-20 `approve(escrow or relayer, cap)` once (or an EIP-2612 `permit` if ROBINVAULT
supports it). A server-side relayer holds a hot key and submits `buyIn(id, n)` on the player's behalf when a
new round opens — BUT `buyIn` pulls funds via `token.safeTransferFrom(msg.sender, ...)` (StandoffEscrow.sol:121),
so `msg.sender` must be the player. The relayer cannot be `msg.sender`. Two sub-options:

- **4.1a — relayer calls a new `buyInFor(id, player, n)` with signed authorization.** Needs a contract add:
  an EIP-712 "auto-buy authorization" (player signs {roundRange or roundId, maxTickets, entry, nonce,
  expiry}); `buyInFor` verifies the signature, then `transferFrom(player, ...)`. This keeps custody with the
  player's own token allowance (approve is to the escrow, not the relayer).
- **4.1b — player approves the RELAYER contract, relayer pulls and forwards.** Simpler but the relayer
  contract touches funds; strictly worse custody than 4.1a.

Custody/trust (4.1a, recommended):
- Allowance is granted to the ESCROW, not the relayer. The relayer only submits a player-signed, bounded
  authorization. The relayer key can NEVER move tokens to itself: `buyInFor` only ever does
  `transferFrom(player, escrow)` for a specific round at the fixed `entry`, and the pot can only exit by
  settle (to participants) or refund.
- **Worst case if the relayer key leaks:** the attacker can spend a player's remaining approved allowance by
  entering them into rounds up to their signed `maxTickets`/expiry — i.e. force participation and consume
  the per-round entry. They CANNOT redirect funds to themselves (contract rules), cannot exceed the signed
  authorization, and the player can revoke by `approve(escrow, 0)` at any time. Blast radius: forced entries
  up to the signed budget until revoke/expiry. This is the smallest-blast-radius option.

### 4.2 Session key (dApp-scoped key)

Player provisions a scoped session key (e.g. via a smart-account/4337 wallet) limited to calling `buyIn` on
the escrow for a token budget. The session key is held client-side or by the relayer.
- Pros: granular, revocable, native to smart-account wallets.
- Cons: Robinhood Chain + ROBINVAULT + the current EOA-signing flow (SIWE, server.js:133) is EOA-centric;
  requires players to have a smart account. Higher integration cost. If the session key is held server-side,
  custody collapses to the same leak profile as 4.1 but with MORE scope if the budget is loosely bounded.
- Verdict: good long-term with account abstraction, over-engineered for now.

### 4.3 Subscription contract

A new contract that custodies a player deposit and auto-funds the next N rounds, pulled by the relayer.
- Pros: one deposit, N auto-entries, clean UX.
- Cons: the subscription contract CUSTODIES player funds between rounds — a new honeypot and a new audit
  surface. If the subscription contract or its puller key is compromised, funds held in it are at risk
  (unlike 4.1 where tokens stay in the player's wallet until the instant of entry). Strictly worse custody.
- Verdict: reject for a money app that has deliberately minimized custody (StandoffEscrow holds funds only
  per-round and only pays by rule, StandoffEscrow.sol:14-24).

### 4.4 Recommendation

**4.1a — allowance-to-escrow + relayer-submitted EIP-712 auto-buy authorization.** Smallest blast radius,
no between-round custody, player-revocable via `approve(…,0)`. It requires a contract add (`buyInFor` +
EIP-712 verify), so it is a Phase C contract change, bundled logically with the §1/§3 upgrade if timing
allows, or as its own later UUPS upgrade. The relayer key must be a DEDICATED key (mirror the settlement
signer discipline, escrow.js:31-35) with gas monitoring, and MUST NOT be the settlement signer or any owner
role.

---

## 5. Holder 50% discount — preserving pot integrity

Problem: a 50% discount for ROBINVAULT holders must not corrupt equal pot shares (every seated ticket should
win an equal share of `pot - rake`; the engine's `settleEqualSplit` splits the pot equally across winning
addresses, escrow.js:93-103). If holders pay half but win a full share, non-holders subsidize them and the
pot math is unfair.

### 5.1 Holder-only rounds

Separate round class where entry is 50% and only verified holders can buy in.
- Pro: pot integrity trivially preserved (everyone in that round paid the same discounted price; equal
  shares of a self-consistent pot).
- Con: fragments liquidity/fill (two pools to fill → slower fills, more dead-ish time); holders and
  non-holders never play together. Hurts the throughput goal.

### 5.2 Post-hoc treasury rebate (NO contract change)

Everyone pays full entry into one pot (shares stay equal, pot integrity intact). Separately, the treasury
sends a 50%-of-entry rebate in ROBINVAULT to verified holders who entered, out of the treasury's rake share.
- Pro: zero contract change; one unified pot; shares provably equal; discount is a marketing cost funded by
  treasury, not by other players.
- Con: holders front the full entry then get rebated later (worse UX than paying less up front); requires a
  verified-holder list + a rebate payout job; the rebate is a trusted off-chain action (the proof/escrow does
  not attest it).

### 5.3 Tiered entry within one pot (RECOMMENDED, small contract change)

One pot, two ticket prices: holders pay `entry/2`, non-holders pay `entry`. Pot shares are weighted by what
each ticket PAID, not one-share-per-ticket. This keeps pot integrity: a holder who paid half wins half the
share of a non-holder, which is fair and self-consistent.

Implementation sketch (contract):
```solidity
// buyIn would need a price tier. Add holder proof: signer-attested or an on-chain balance check at buy time.
// Simplest storage-safe path: a per-round holderEntry alongside entry, and a signer-attested holder flag.
// settle weights by paid amount: track paidByPlayer, and settleEqualSplit becomes settleByStake.
```
This is a LARGER change (settle must split by stake, not equally) — it touches `settle`'s
`sum == pot - rake` invariant math and `settleEqualSplit` in escrow.js. Doable but it is the heaviest of the
three.

Simpler tiered variant that avoids changing settle: **holders get 2 tickets for the price of 1** (pay full
entry, receive a holder bonus ticket). Equal shares preserved (settle unchanged), discount delivered as extra
odds. But this changes odds/concentration and interacts with the §3 per-wallet cap. Document carefully.

### 5.4 Recommendation

Start with **5.2 post-hoc treasury rebate** (zero contract change, ship immediately, discount funded from
treasury's own rake share, pot provably equal). Migrate to **5.3 tiered entry (stake-weighted settle)** only
if holders dislike fronting full entry — and only as a dedicated, separately-audited UUPS upgrade, because it
changes the settle invariant that the whole escrow safety model rests on (StandoffEscrow.sol:134-161). Do
NOT rush stake-weighted settle into the §1 upgrade.

---

## 6. Interactive (player-clicked) sudden-death overtime

Yes — the fill model unlocks this. Today `suddenDeath()` (server.js:269-283) runs synchronously inside a
single tick: it loops up to 64 rounds instantly and lands the whole overtime in the proof. It is instant
because a wall-clock game must finish before the next fixed interval collides with it (server.js:260
comment). With no fixed interval in the fill model, there is no collision risk — the next round is a separate
sequential id that opens on `lock`, not on a grid.

So overtime can become INTERACTIVE: when >1 robber survives all scheduled chambers, instead of auto-looping,
present real OT chambers with a choose window (reuse `choose/reveal` timing) and let players click doors.
Each OT draw stays a seeded `prng` stream keyed to the round (server.js:274 `ot:round:id`), so it remains
verifiable — the ONLY change is that a present human's click overrides the seeded default for their own seat
(mirroring the normal-chamber absent-default logic, server.js:204). The proof records human picks the same
way it records normal picks.

Design notes:
- Keep a hard OT round cap (the existing 64, server.js:272) and the low-door crowding design (`VS_OT_DOORS`,
  server.js:270) so interactive OT still converges quickly.
- Absent players in OT fall back to the seeded default (unchanged), so a round never stalls on a
  disconnected player.
- This is purely a Phase E server/engine change — NO contract change (settle still just takes the final
  champion's address).

---

## 7. Phased implementation plan

Legend: [S] server-only · [C] contract change (testnet redeploy + mainnet Safe UUPS upgrade) · [R] relayer/ops.

### Phase A — fill-cadence scaffolding behind a flag  [S]
- Add `rmfill` mode config (§2.1). Extend the boot assertion (server.js:105) and `realMoney()` (server.js:191)
  to accept `rmfill`.
- Build `rmfillTick()` + `rmEscrowLifecycle()` (§2.2), monotonic persisted round id, rolling two-round
  pre-open (§2.3), restart resilience port (§2.4), under-fill handling (§2.6).
- In Phase A, drive the contract with the EXISTING ABI by opening each round with a **short fixed grace-cap
  lockTime** (Convention A limited to "always wait grace cap") so it is testable on the current deployed
  contract WITHOUT the §1 change. This proves the engine end-to-end on testnet before any contract change.
  Accept that true "lock-at-threshold" is not yet active (buy-in stays open until the grace cap).
- Client: replace the wall-clock countdown with `ticketsSold / target` + grace remaining in the `escrow`
  state block (server.js:647) and `fill` block (server.js:606).
- Gate behind an env flag; fake-chip preview and the live clock game remain the defaults until validated.

### Phase B — `lockRound` contract change (enables true threshold lock)  [C][S]
- Add `lockRound(uint256 id)` + `RoundLocked` event (§1.3). Storage-layout check with
  `@openzeppelin/upgrades`. Add to the escrow.js ABI and an `escrow.lockRound(id)` wrapper.
- Redeploy the implementation to testnet 46630, point the proxy's implementation there, dry-run the full
  open→fill→lockRound→commit→play→settle loop with the throwaway testnet key.
- Server: switch `rmfill` from the Phase-A grace-cap-only behavior to true lock-at-threshold / lock-on-full,
  calling `lockRound` (§2.2 step 3). Open rounds with the far-future sentinel `lockTime` (§1.3).
- MAINNET: prepare the UUPS upgrade transaction for the 2-of-2 Safe (`_authorizeUpgrade` is `onlyOwner`,
  StandoffEscrow.sol:94). Execute only on Jake's go. This is the gating real-money change.

### Phase C — per-wallet on-chain cap + recurring auto-buy  [C][S][R]
- Per-round `maxTicketsPerWallet` mapping + `openRoundCapped` + `buyIn` guard (§3.2). App-side dynamic cap
  (`MAX_TIX_WALLET = ceil(0.10*target)`) can ship in Phase A [S]; the on-chain guard is Phase C [C].
- Auto-buy: `buyInFor(id, player, n)` + EIP-712 auto-buy authorization verify (§4.1a). Relayer service with
  a dedicated gas-monitored key, distinct from the settlement signer (§4.4) [C][R].
- Both are contract changes → testnet redeploy + a (second) mainnet Safe upgrade. Can be bundled with Phase B
  into one upgrade if schedule allows (fewer Safe ceremonies), at the cost of a larger single audit.

### Phase D — holder 50% discount  [S] then optionally [C]
- Ship 5.2 post-hoc treasury rebate first: a verified-holder list + a rebate payout job from treasury
  (server + ops, NO contract change) [S][R].
- Only if needed, migrate to 5.3 stake-weighted settle as a SEPARATE, independently-audited UUPS upgrade [C]
  (do not bundle — it changes the settle invariant).

### Phase E — interactive sudden-death overtime  [S]
- Convert `suddenDeath()` from an instant loop to an interactive per-chamber flow (§6). Server-only; no
  contract change. Verifiability preserved (seeded defaults, human-click overrides recorded in the proof).

### Contract-change summary
- Phase A: NONE (runs on the deployed contract in grace-cap-only mode).
- Phase B: `lockRound` — REQUIRED for true threshold fill. Testnet redeploy + mainnet Safe upgrade.
- Phase C: `maxTicketsPerWallet` + `buyInFor`/EIP-712 — contract change (optional to bundle with B).
- Phase D: contract change ONLY if moving to stake-weighted settle (otherwise server/ops only).
- Phase E: NONE.

---

## 8. Open questions for Jake / Shannon

1. `target` ticket count per round (spec says 25; confirm). Per-wallet cap = `ceil(0.10*target)` → 3 at 25.
2. `graceMs` (spec ~10 min) and `MAX_FILL_WINDOW` sentinel (recommend 24h) and `minViable` participants.
3. Bundle Phase B + C into one mainnet Safe upgrade, or two separate ceremonies?
4. Holder discount: start with treasury rebate (5.2) as recommended, or go straight to tiered (5.3)?
5. Auto-buy: confirm 4.1a (allowance-to-escrow + relayer EIP-712) over session keys; who runs/funds the
   relayer key and where is it sealed (mirror escrow.js:31-35 env-only discipline)?
6. Interactive OT: desired, or keep instant auto-OT? (Phase E is independent, can ship anytime after A.)
```