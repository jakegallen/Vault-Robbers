# RVLT Humanness / Bot-Detection Signal Registry

Living spec (Jake 2026-09-13). Deterministic no-roll mode makes anti-bot the vault's protection, so we cast the widest possible net of measurement points, keep everything MEASUREMENT-ONLY until Jake's human baseline proves it never false-fires, then graduate a signal to an enforcer (sticky bot-role, auto-fail). No-tolerance policy on confirmed bots; humans must never be auto-lost.

## A. Mini-game timing (LIVE — `rtv_bot_telemetry.features`, per door)
Temporal fingerprint from the tap stream (t + type; no cursor path). Tells: superhuman_cadence, robotic_even (rhythm-aware), metronomic, round_ms, low_digit_entropy, too_fast_gate, perfect_timing (na>=3+robotic), instant. Raw: iei mean/sd/cv/min/max, react, q10/q50/q100, digit_entropy, gate_ratio, score, human.
FIXED 2026-09-13 vs Jake baseline: perfect_exact (fired on every discrete win) -> perfect_timing; robotic_even/metronomic now rhythm-aware (rhythm requires even taps).

## B. World / room navigation (LIVE — `rtv_room_behavior.behavior`, per chamber; client collector in index.html)
room_ms, moves, move_dist, turns (A/D/arrows), rev_x (look reversals), keymap, clicks, dead_clicks (misclicks off any target), how_it_works, browse (door/game browsing ◄►), leave_clicks (backed out of room), robber_clicks, door_approach_ms (time from room-enter to first input — a bot beelines instantly), holds/hold_max/hold_avg (touch hold), jitter/jitter_ratio (human micro-jitter), straight_to_door.
Captures pointer-lock look (movementX/Y) + menu pointer.

## C. Wallet reputation (PLANNED — server-side, on-chain Robinhood 4663, at /api/enter)
- Fresh wallet? age / first-seen tx timestamp.
- Prior tx history / count (a spun-up bot wallet has ~none).
- Historical trading volume (no volume + fresh = likely bot).
- RVLT balance held (skin in the game).
- Funder graph (rtv_wallet_funder already tracks who funded the wallet; cluster of wallets from one funder = farm).
- Weight the above by how deep they get + how much RVLT is at stake.
Store per-wallet reputation; feed the risk score (measurement-only first).

## D. Meta / session (PLANNED)
- Did they mint a Vault Robber? how many? (minting + multi-room interaction = human intent, weak positive signal).
- Rooms clicked / actions taken on the Vault Robber page.
- Cross-run cadence: runs per minute, identical inter-run gaps (scripted), time-of-day regularity.
- Device/UA stability vs wallet rotation (bot rotates wallets on one device — key on ip/device, already partly done in the consistency monitor).
- Practice-pack volume (already flagged: PRACTICE_ABUSE_RUNS).

## E. To mine from the V1 winner audit (IN PROGRESS)
Full audit of the V1 game winner (who cracked the core, their wallet + behaviour) to reverse-engineer what a real successful agent looked like and which signals would have caught it. Findings appended below by the audit agent.

<!-- V1-AUDIT-FINDINGS -->

## E-findings: V1 winner audit (2026-09-13, read-only forensic)

Evidence base: shared group DB (rtv_runs / rtv_seeds / rtv_bot_signals / rtv_bot_telemetry / rtv_room_behavior / rtv_wallet_funder / rtv_paid_log / rtv_bot_roles), the V1 source at `robbing-the-vault-v1/server.js`, and read-only Robinhood-chain (4663) RPC (`rpc.mainnet.chain.robinhood.com`). Blockscout REST is Cloudflare-walled, so on-chain history beyond raw RPC (nonce/balance/getLogs) could not be pulled — noted where relevant.

### (a) What the winner looked like

*The one and only core-rob in the game's history:* wallet `0x01d4E1Bd8D9A73566D36bF2299d5C7feB0fE7eCe`, mainnet net=4663, run_id `0x3a56bba3376b8fba0e54184a8d22e30974c244a94a3919fffc3329b8d3ea8a95`, depth 10, status `robbed`, won 1,728,670 RVLT + **13.0955 ETH**, on 2026-09-08. (The only other net=4663 rows never exceeded shallow depth; net=46630 is testnet, max depth 9, 0 ETH — Jake's own deployer 0x411f test runs.)

*Behaviour — the loudest tells (all present, NONE flagged by V1):*
- *Single run, no warmup.* Exactly ONE run in rtv_runs and ONE seed for this wallet. No practice-arcade buys, no arcade pass, no prior busted/cashed runs. A human who reaches the core almost always has a trail of earlier attempts; this wallet's first and only paid play was a flawless 10/10.
- *~76 s wall-clock end to end, ~19 s of actual play.* Seed opened 18:09:59, core-rob logged 18:11:16. The ten crack signals span 18:10:56 → 18:11:15 = **~19 seconds for ten chambers**, per-door elapsed 1383–2237 ms. Machine-gun cadence with zero human dead time (reading doors, hesitating, walking the 3D room).
- *ZERO room-navigation telemetry.* rtv_room_behavior has 0 rows for this wallet (and 0 rows total in the whole table — the section-B collector was effectively not landing data in V1). A real player physically walks each 3D chamber to a door (WASD / pointer-lock look / touch drag). The winner emitted none: their client never rendered/walked the world, consistent with a headless script hitting `/api/mini/start` + `/api/crack` directly.
- *ZERO tap-stream telemetry.* rtv_bot_telemetry has rows for only ONE player in the entire DB — the deployer 0x411f (5 runs, 19 rows). The winner produced none. So the section-A per-door temporal fingerprint (iei mean/cv/digit-entropy) was never captured for the actual attacker — the richest client signal was blind to them.
- *Nerve-score machine-precision clustering (the single most damning statistical tell).* The five nerve doors (holddrill-family, score = stop.t/maxMs ÷ danger) scored: dive 0.9202022332, guardsweep 0.9197915368, crank 0.9198501116, crackdrill 0.9197416669, guardsweep 0.9195831969 — a **0.0006 spread across five different games with different maxMs and different hidden danger lines**. A human's stop-vs-hidden-line ratio scatters across 0.3–0.95; landing every single nerve game at ~0.9197 means the client computed a fixed fractional target (~92% into the safe band) every time. This is a deterministic solver, not a hand.
- *humanScore = 1 on every nerve/reflex door.* Because those games submit a SINGLE action (`stop`/`tap`/`cut`), `humanScore()` hits its `ts.length < 2 → return 1` early-out (server.js:993) and never profiles them. The naive timing gate is structurally blind to one-shot games — which is most of nerve and all of reflex.
- *One suspicious near-miss the gate ignored:* level-5 sequence, elapsed_ms 1868 < min_ms 1900, score 1.0, human dropped to 0.6 — yet NOT flagged (fast-solve fires at elapsed < minMs*0.8, and low-human fires at <0.35, so 0.6 sailed through). A perfect memory-sequence solved a hair under the minimum time is itself a tell that fell between two thresholds.
- *V1 enforcement never fired on anyone.* rtv_bot_roles has ZERO active or hard-flagged wallets. The consistency monitor (mean>0.97 AND var<0.0005 over 12 doors) never triggered because (i) the run was only 10 doors, (ii) 3 were luck (null, uncounted), and (iii) the skill sequence scored 1.0 while nerve sat at 0.92, so the *mixed* mean/variance never met the joint bar — even though the nerve subset alone had ~1e-8 variance. The bot threaded the exact gap in the joint threshold.

*On-chain profile (raw RPC, best-effort):*
- EOA (no bytecode), **nonce = 5** — only five outbound tx in the wallet's entire life. Extremely thin, purpose-built-looking history (a real active trader on the chain has dozens–hundreds).
- Currently holds ~4.01 ETH (the loot, less what's moved) and **0 RVLT** (emptied).
- RVLT for the entry fee was acquired ONCE, via a self-initiated swap (tx from=winner, to=router `0x6e2a…6919`, 0.002 ETH in), receiving ~6,597 RVLT from the DEX pool contract `0x8366…0951` (a contract, i.e. the pair — NOT a farm funder). So RVLT acquisition looks organic (bought its own), and there is no sibling-wallet funder cluster visible for RVLT.
- rtv_wallet_funder has NO row for this wallet — the V1 funder-graph collector never recorded it, so the planned Section-C funder-cluster signal had no data on the actual winner.
- *Caveat:* the ETH gas/seed origin (who first funded the fresh wallet with ETH) could not be traced because Blockscout REST is Cloudflare-gated and bounded getLogs on native transfers isn't indexed by topic. Wallet-age-in-days is therefore inferred from nonce=5 (very low), not from a first-tx timestamp.

*IP/UA fingerprint reality in V1 (important calibration fact):*
- The winner's ip_hash `4b18233181f42159` is shared by **113 of 115 mainnet players** — it is a degenerate/placeholder hash (the proxy or a single egress IP), so IP-clustering was effectively DEAD in V1. Section-C/D IP-keyed defenses will only work once the real client IP is captured (rightmost-XFF is in code, but the data shows one value dominating — verify the proxy actually appends distinct IPs before relying on IP at all).
- The winner's ua_hash `3d53edf86fb98216` is **UNIQUE to them** — no other player carried that UA. A user-agent that appears on exactly one wallet, which then goes 10/10 to the core, is itself a signal.

### (b) Ranked NEW detection signals (beyond registry A–D)

Ranked by how decisively each would have caught THIS winner × low false-positive risk. "Enforce" = safe to auto-gate now; "Measure" = log against Jake's human baseline first.

1. *NERVE/RATIO SOLVER FINGERPRINT (constant-fraction targeting).* Measures: across a run's nerve/hidden-band/hidden-line games (holddrill family, tightrope/torque band, ladder trapped-rung), the variance of the *normalized* outcome fraction (stop.t/maxMs relative to the hidden danger/band). A solver lands the same fraction (~0.92) every game; a human scatters. Would have caught winner: definitively — 5 nerve games at 0.9195–0.9202 (var ~1e-8). Source: server (already have `score` + `ch` in `_active`; compute the pre-danger fraction). FP risk on humans: very low — no human reproduces a hidden-line ratio to 3 decimals across differing games. Recommend: **Enforce** at the core gate (this is the cleanest single discriminator found).
   - Refinement of the existing consistency monitor: (i) compute variance PER kind (nerve-only, skill-only), not on the mixed pool — the mix is exactly how the winner hid; (ii) drop the 12-door minimum for the core-rob decision — a 10-door full clear must be judged on its own 7 non-luck doors; (iii) lower the joint bar to var<1e-4 within a single kind.

2. *ZERO-WORLD-INTERACTION (headless client).* Measures: presence + volume of section-B room_behavior AND section-A tap-telemetry rows for the run. A browser that actually renders the 3D crawl emits room_ms/moves/turns/look-reversals per chamber and a multi-sample tap stream per door; a direct-API bot emits none. Would have caught winner: definitively — zero rows in both tables. Source: server (join the crack to expected telemetry). FP risk: low IF the collectors are reliable — BUT V1 shipped with room_behavior landing 0 rows for EVERYONE, so this MUST be fixed and baselined before enforcing, else it false-fires on all humans. Recommend: **Measure now, Enforce once the collector is proven emitting for real sessions.** This is the highest-leverage signal for the deterministic launch because it doesn't depend on beating the mini-game — it asks "did a real UI ever run?"

3. *NO-WARMUP FIRST-RUN-TO-CORE.* Measures: count of prior runs (any outcome) + practice-arcade activity for the wallet/IP before a deep clear. Winner: literally their first and only run went 10/10. Source: server/DB (rtv_runs + rtv_practice_buys count). FP risk: MEDIUM — a skilled human who practiced on a *different* wallet, or a confident whale, could first-try deep; do not hard-fail on this alone. Recommend: **Measure**, and use as a risk multiplier that lowers the enforce threshold on signals 1/2/5 (not a standalone enforcer).

4. *ONE-ACTION-GAME TIMING PROFILE (fix the humanScore blind spot).* Measures: for single-action games (stop/tap/cut/reflex), profile the ACTION LATENCY distribution across the run instead of inter-event intervals — a human's reaction/stop latency varies run-to-run; a bot's is near-constant or suspiciously optimal. Winner: humanScore=1 on all 5 nerve + both reflex doors purely because of the `ts.length<2` early-out. Source: server (per-door single-action t vs the game's window/maxMs, aggregated across the run). FP risk: low-medium. Recommend: **Measure then Enforce** — this closes the exact structural hole that let humanScore read 1.0 on the winner's most bot-like doors.

5. *SUPERHUMAN PER-DOOR CADENCE (whole-run pace).* Measures: total active play time and per-door elapsed across the run; flag runs where every door resolves in a tight low band with no human variance/pauses. Winner: 10 chambers in ~19 s, doors 1.4–2.2 s, no outliers (no "stopped to think"). Source: server (already logging elapsed_ms per door; add a run-level aggregate + variance). FP risk: low-medium — fast humans exist, but the ABSENCE of any slow/hesitation door across a full 10-deep clear is unnatural. Recommend: **Measure**, fold into the core-gate risk score.

6. *LONE-UA / UA-UNIQUENESS.* Measures: how many distinct wallets share this session's ua_hash, and whether the UA is a known headless/automation signature. Winner: ua_hash unique to them among 115 players. Source: server (rtv_bot_signals ua_hash cardinality) + a UA allow/deny classifier. FP risk: medium (privacy-mode browsers and rare UAs exist; a unique UA is weak alone). Recommend: **Measure**, weak positive; combine, never enforce alone.

7. *THIN-WALLET / ORGANIC-HISTORY score (on-chain, Section-C made real).* Measures: nonce/age, whether RVLT was bought via a swap vs received from a wallet, count of counterparties, RVLT held at play time. Winner: nonce 5, RVLT self-swapped (organic — so this signal would rate them LESS bot-like on the funder axis, but VERY bot-like on the thin-history axis). Source: on-chain RPC at /api/enter (getTransactionCount + a bounded RVLT-Transfer getLogs to classify funder as pair-vs-wallet). FP risk: HIGH on its own — see (c). Recommend: **Measure** and weight modestly; nonce/age is the useful sub-signal, funder-cluster had no data here and mislabels organic swap-buyers.

8. *ENFORCEMENT ACTUALLY FIRING (meta-fix).* Not a detection signal but the audit's blunt finding: rtv_bot_roles had zero active/hard flags ever, and room_behavior/telemetry were largely empty — V1 measured almost nothing and enforced nothing on the one wallet that mattered. Before launch, prove each graduated signal writes rtv_bot_roles and that the sticky-bot-role path actually blocks a flagged wallet at the core gate. A signal that only logs is not protection.

### (c) Signals that risk false-firing on a legit whale / skilled human

- *Signal 3 (no-warmup first-run-to-core)* and *Signal 7 (thin-wallet)* are the dangerous pair. The winner's on-chain profile (fresh-ish EOA, low nonce, bought its own RVLT via a swap) is INDISTINGUISHABLE from a legitimate new whale who bridges in, swaps for RVLT, and plays confidently. If either is an enforcer, a real high-value new user who happens to clear deep on an early run gets auto-lost — the exact "humans must never be auto-lost" violation the registry forbids. Keep both measure-only and use them ONLY to lower the threshold on the behavioural signals (1/2/4/5), never to fail a run by themselves.
- *Signal 6 (lone-UA)* false-fires on privacy browsers, uncommon devices, and locked-down configs where the UA legitimately appears once. Weak positive only.
- *Signal 5 (fast cadence)* can clip genuinely fast, practiced players; enforce only in combination with a world-interaction failure (signal 2) or a solver fingerprint (signal 1), never on pace alone.
- *Signal 2 caveat:* if the room/tap collectors are flaky (as they were in V1, where room_behavior was empty for everyone), enforcing "no telemetry = bot" would false-fire on 100% of humans. The collector reliability MUST be baselined against Jake's human runs before this graduates from measure to enforce.
- The genuinely SAFE-to-enforce discriminator is *Signal 1 (nerve/ratio solver fingerprint)*: a hidden-line ratio reproduced to 3 decimals across multiple distinct games has no human explanation and no legit-whale confound. That is the one to graduate first.
