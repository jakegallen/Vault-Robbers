# Vault Robbers — Deterministic Roster Prune (analysis + recommendation)

_Dev-twin analysis, 2026-09-13. Read-only: no game-logic edits, no restart, no flag flips.
Author tools added: `pergame-det.js` (per-game max-difficulty clear-rate harness)._

## The deterministic goal, restated in numbers

In deterministic (no-roll) mode the server advances on `score >= DET_BAR[door][lvl-1]` alone
(server.js:2116-2177, `RTV_DETERMINISTIC`). There is **no rarity roll** — the per-game
competent-human clear rate at the operative bar **is** the per-chamber advance probability.

Target full-clear ~1-in-88k..100k over 10 chambers ⇒ geometric per-chamber advance ~**32%**.
With a realistic shallow taper (ch1-5 ≈ 90/82/71/60/50%), the **deep chambers 6-10 each need
~14-15% competent-human clear**. That is the design zone every kept deep game must land in:
a game that saturates >40% at max difficulty cannot carry a 1-in-88k tail; a game that only ever
reaches ~20-25% is a strong deep gate.

**Solver-resistance is now the vault's only protection** (BOT-SIGNALS.md): with no roll, a
scripted client that beats the bar deterministically wins the ETH. The V1 winner was exactly this
— a **constant-fraction / fixed-target timing solver** (0.9195-0.9202 across 5 timing games,
variance ~1e-8). The whole prune below is oriented around: *can a script hit this game's bar without
a real UI and real motor/perceptual bandwidth?*

## Method

- Per-game max-difficulty clear% = `pergame-det.js`: competent-human model (verbatim from
  `sim-reach.js` humanEvents, round-tripped through the **real** `grade()`) built at the **deepest**
  difficulty (lvl 10, shipped dSkill/dShallow lift on), N=2500. Reported at bars .50/.70/.85/.95/1.0.
  bar=1.0 = "must score perfect" = the hardest achievable deterministic gate for that game.
- Input class + solver-resistance = read from `skillgames.js` build/grade source.
- Category floors cross-checked against `.det-verify.json` (per-tier pooled achieved clear at the
  solved DET bars) and `.det-tune-meta.json`.

Solver-resistance scale: 1 = script hits it deterministically (V1-winner class), 5 = needs
continuous real-time motor path or genuine perceptual bandwidth a script can't fake.

---

## SKILL (deep pool = the 9 games reachable at core, poolFor(10))

| game | max-diff clear% (bar=1.0 / .85) | input class | solver-resist | verdict + reason |
|---|---|---|---|---|
| gonogo | ~77% (coverage×speed floors high)* | visual-search, multi-select (server frame) | 4 | REWORK — needs live CV to read the lit board (strong), but grade floors ~77% deep; can't gate. Tighten to a genuine deep gate or shallow-only. |
| oddsignal | search, single-select (server frame) | 4 | REWORK — illusion-grade outlier needs live CV (strong), but single correct tap ⇒ point-mass ~1.0; bar can't carve. Shallow/mid flavor only. |
| safeproc | 48% / 48% | multi-press sequence (server frame) | 3 | KEEP — sequence recall+order, needs the board read; floors ~48% (mid gate, not deep). |
| lockorder | 56% / 56% | multi-press ordered sequence | 3 | KEEP (mid) — same class; ~56% floor = mid-chamber gate. |
| counterrot | 26% / 31% | timed alternating press stream | 3 | KEEP — multi-action cadence, floors ~26% = good deep-ish gate; cadence is harder to script than a single commit. |
| overridegrid | 77% / 77% | toggle-to-target grid | 2 | CUT — deterministic toggle set; a solver computes the diff and presses it. Floors 77%, no gate, low resistance. |
| powermeter | **0% / 10%** | **single hold (down/up)** | **1** | **CUT (solver-bait)** — one hold; solver sets hold=target/rate exactly. Fixed-target timing = V1-winner class. |
| recoilctl | 0% / 0% | tap-cadence keep-in-band | 2 | REWORK/CUT — a fixed tap frequency = perfect band-hold (computable); sim floors 0% (mis-tuned) and resistance is low. |
| anglelaunch | **0% / 8%** | **single 2-value commit** | **1** | **CUT (solver-bait)** — inverse projectile is closed-form; solver computes (angle,power). Human model literally brute-forces it. |
| pressurevalve | 0%* / 0% | tap-cadence moving band | 2 | CUT — computable vent cadence; sim can't clear it (mean 23%, bar=0), low resistance. |
| ricochet | **0% / 18%** | **single aim commit** | **1** | **CUT (solver-bait)** — bank-shot inverse is closed-form; solver computes the aim vector. Single-commit = V1 class. |

\* gonogo grade = coverage×speed with a generous window, so a correct multi-tap floors high — the
_anti-bot_ value is real (must read a time-gated server frame) but the _gating_ value is nil.

**Skill takeaway:** the charge/aim/hold games (powermeter, anglelaunch, ricochet, pressurevalve,
recoilctl) are all **single-action or computable-target** — the exact solver-bait class. The
survivable skill mechanic is the **multi-press sequence/cadence** (safeproc, lockorder, counterrot):
several ordered actions against a server-rendered board, floors 26-56%. Skill should **shrink hard**
to those 3 (+ gonogo/oddsignal shallow-only for flavor).

## DEXTERITY (full pool, 15)

| game | max-diff clear% (bar=1.0 / .85) | input class | solver-resist | verdict + reason |
|---|---|---|---|---|
| wiretrace | 0% / 0% | continuous path follow | 5 | REWORK — strong (continuous multi-sample path), but tol (0.075) < human jitter deep ⇒ unwinnable. Loosen tol. |
| gapthreader | 0% / 0% | continuous slide-to-gap | 5 | KEEP (loosen) — strong path game; floors 0% at bar1.0 but 90% at bar.5 ⇒ carveable to ~15% with a mid bar. |
| lasercorridor | 19% / 19% | timed continuous cross | 4 | KEEP — 19% deep floor = ideal deep gate; must move through on live timing. |
| coilunwind | 42% / 100% | continuous spiral trace | 5 | KEEP — strong path; ~42% at perfect, carveable. |
| tiltbalance | 0% / 94% | continuous balance track | 4 | KEEP (bar~.9) — carves cleanly 94%→0 across .85-.95; excellent gate resolution. |
| mazerun | 0% / 98% | continuous corridor path | 5 | KEEP (bar~.9) — strong path; sharp carve at high bar. |
| orbitring | 0% / 3% | continuous circular track | 5 | KEEP — carves ~3% at .85; strong resistance. |
| pinchgap | 0% / 0% | continuous hold-center | 3 | REWORK — near-static hold; a fixed center park is close to correct (lower resistance). |
| cranklever | 51% / 100% | continuous rotary trace | 5 | KEEP — strong; carveable. |
| tracechase | 0% / 1% | continuous moving-target chase | 5 | KEEP — strong path, carves to ~1% at .85; good deep gate. |
| zigzag | 0% / 0% | continuous node path | 5 | REWORK — strong but tol too tight deep (sim 0%); loosen. |
| threadneedle | **99.9%** | segment-graded ring pass | 3 | CUT — segment grading is too forgiving (99.9% at bar1.0). No gate. |
| steadyhold | 0% / 71% | continuous track drift target | 4 | KEEP — carves 71%→0 across .85-.95; good resolution, needs live tracking. |
| dodgefall | 0% / 0% | continuous evade | 4 | REWORK — strong evade path but sim floors 0% (per-wave grade harsh); retune. |
| swipegates | **100%** | discrete swipe sequence | 2 | CUT (solver-bait-ish) — discrete directional swipes, computable; 100% clear, no gate. |

**Dexterity takeaway:** the **strongest solver-resistant category** — continuous multi-sample motor
paths a script cannot reproduce without a real pointer trajectory, and they carve cleanly across the
bar (lasercorridor 19%, orbitring/tracechase ~1-3% at .85, tiltbalance/mazerun/steadyhold sharp
high-bar carves). Cut the two computable/forgiving ones (threadneedle, swipegates). This is the
backbone category to lean on for the deep gate.

## PERCEPTION (full pool, 15)

Multi-round MIN gate (K=percRounds; K=4 at ch10). Each round = one `pick` into N options, answer in a
one-shot time-gated PNG. Measured clear% = P(ace **all** K rounds) at deepest level.

| game | max-diff clear% (4-round gate) | input class | solver-resist | verdict + reason |
|---|---|---|---|---|
| appraise | 22% | count/sum judgment, 1 pick/round | 4 | KEEP — 22% deep = on-target; sum-of-squares appraisal is a genuine perceptual read. |
| counttake | 23% | subitizing estimate | 4 | KEEP — numerosity under deadline, VLM-hard. |
| forgery | 20% | shade discrimination | 4 | KEEP — sub-5% luminance delta deep, CV-hard. |
| balance | 22% | comparative tilt | 3 | KEEP — clean judgment gate at 22%. |
| sigil | 24% | shape match | 3 | KEEP (or trim) — match task, mid resistance; redundant with shadowmatch/peephole. |
| oddglyph | 23% | odd-one-out grid | 3 | TRIM — overlaps oddsignal/sigil; keep the stronger illusion set instead. |
| readdial | 22% | boundary-ambiguous gauge read | 4 | KEEP — deep needle sits on bucket edges (ambiguous), strong. |
| peephole | 20% | degraded-image recognition | 4 | KEEP — blur recognition, VLM-hard deep. |
| shaderank | 22% | fine luminance rank | 4 | KEEP — near-identical shades, CV-hard. |
| shadowmatch | 22% | silhouette match | 3 | TRIM — overlaps sigil/peephole. |
| muller | 29% | Müller-Lyer illusion | 5 | KEEP — engineered to fight VLMs (illusion), strongest class. |
| ponzo | 31% | Ponzo illusion | 5 | KEEP — illusion, strongest class. |
| simcontrast | 23% | simultaneous-contrast illusion | 5 | KEEP — illusion, strong. |
| camobreak | 22% | figure-from-camouflage | 5 | KEEP — camouflage break, VLM-hard. |
| figurenoise | 21% | figure-from-noise | 5 | KEEP — noise embedding, VLM-hard. |

**Perception takeaway:** uniformly lands ~20-31% at the deep 4-round gate — **structurally
on-target for the 1-in-88k deep zone** and the multi-round MIN gate kills blind guessing
((1/N)^4). Solver-resistance is high for the **illusion / degraded-stimulus** games (muller, ponzo,
simcontrast, camobreak, figurenoise, forgery, shaderank, peephole, readdial) — these are the
literature-backed VLM-hard set. The plain match games (sigil, oddglyph, shadowmatch) are the weakest
and redundant; trim to shrink the roster. Perception SURVIVES and does not need mechanic hardening —
only its shallow rounds (ch1-3, K=1) saturate high, which is fine (shallow is meant to be beatable).

## RHYTHM (full pool, 15) — CONFIRM THE CUT

| game | max-diff clear% (bar=1.0 / .85) | input class | solver-resist | verdict |
|---|---|---|---|---|
| pulselock | 59% / 59% | beat-tap timing | 1 | CUT |
| beatrunner | 44% / 44% | beat-tap timing | 1 | CUT |
| metroswing | 60% / 60% | beat-tap timing | 1 | CUT |
| echotap | 0% / 0.4% | interval reproduction | 2 | CUT (sim floors 0, mis-tuned; still timing) |
| combochain | 35% / 40% | beat-tap streak | 1 | CUT |
| sustainhold | 71% / 71% | hold-window timing | 1 | CUT |
| offbeat | 51% / 51% | beat-tap timing | 1 | CUT |
| accentonly | 66% / 71% | selective beat-tap | 1 | CUT |
| twinstrike | 47% / 69% | double-tap timing | 1 | CUT |
| rampup | 34% / 73% | accelerating beat-tap | 1 | CUT |
| laneswitch | 48% / 85% | lane+beat timing | 1 | CUT |
| echoreverse | 0% / 0.8% | reversed interval | 2 | CUT |
| gatepulse | 97% / 97% | gated beat-tap | 1 | CUT |
| stepladder | 49% / 49% | tempo-step timing | 1 | CUT |
| heartbeat | 32% / 72% | irregular beat-tap | 1 | CUT |

**RHYTHM CUT CONFIRMED — with data.** Pooled achieved clear at max difficulty (`.det-verify.json`
rhythm, ch10) floors at **46.2-46.4%** across all three tiers — it physically cannot be pushed lower
because a beat-tap stream graded by a per-note tolerance saturates: a competent human hits most beats
within tolerance, so the score point-mass sits high. Worse, **every rhythm game is timing-only
(input class = tap-at-time)** — the exact **constant-fraction / fixed-target timing** family the V1
winner solved to 3-decimal precision. A scripted client with the beat schedule (which it can infer
from the audio/period) taps each beat dead-on and scores ~1.0 deterministically. Rhythm is both the
**weakest gate** (46% floor, >>32% needed) **and the single easiest solver target**. **Delete the
category.**

---

## RECOMMENDED LEAN ROSTER

Surviving categories: **DEXTERITY, PERCEPTION, SKILL (shrunk hard)**. **RHYTHM deleted.**

Quality over count — the tightest set that stays varied:

**DEXTERITY (7)** — the deep backbone (continuous motor paths, resist scripting):
`lasercorridor, orbitring, tracechase, tiltbalance, mazerun, steadyhold, coilunwind`
(+ `gapthreader`, `cranklever` as alternates once tol is loosened). Cut: threadneedle, swipegates.
Rework tol before use: wiretrace, zigzag, dodgefall, pinchgap.

**PERCEPTION (9)** — the illusion / degraded-stimulus set (VLM-hard, on-target 20-31% deep):
`muller, ponzo, simcontrast, camobreak, figurenoise, forgery, shaderank, peephole, readdial`
(+ `appraise, counttake, balance` as variety alternates). Trim: sigil, oddglyph, shadowmatch.

**SKILL (3 core + 2 shallow-flavor)** — multi-press sequence/cadence only:
core `safeproc, lockorder, counterrot`; shallow-only flavor `gonogo, oddsignal` (ch1-3, must read a
time-gated server frame — anti-bot value even though they don't gate).
**Cut outright:** powermeter, anglelaunch, ricochet, pressurevalve, recoilctl, overridegrid,
threadneedle-equivalent (swipegates) — all single-action/computable.

This gives ~19 gating games across 2 strong categories + a small sequence-skill set — varied, and
every kept game is either a continuous motor path, a multi-round perceptual judgment, or a multi-press
sequence. No single-action timing game survives.

## Can this hit 1-in-88k deterministically?

**Yes, with the recommended roster — and the arithmetic is comfortable.**

- **Deep zone need:** ch6-10 each ~14-15% competent-human clear (with the shallow taper), ch10 the
  hardest gate.
- **Dexterity** delivers deep floors of ~1-3% (orbitring, tracechase at bar .85) up to ~19%
  (lasercorridor) — it can hit **any** deep target from ~1% to ~40% by bar choice, so it can produce
  the ch10 core gate directly.
- **Perception** lands 20-31% at the 4-round deep gate — perfect for ch5-7, and can be pushed lower
  by adding a 5th round or tightening the stimulus.
- **Skill (sequence)** floors 26-56% — good for **mid** chambers (ch4-6), not the deepest gate.

Because door-distinct guarantees ≥2 skill-based doors per chamber and all survivors sit on one
difficulty curve, the **optimal path** (a robber always picking the easiest surviving door) is bounded
by the *easiest* category per chamber. To keep the vault at 1-in-88k the DET bars must be solved so the
**easiest** surviving door per chamber clears ~32% geometric — which dexterity and perception both
support at every depth. `.det-verify.json` already shows dexterity/perception pooled clears tracking
DET_CLEAR down to ch4 and floors of ~20-23% deep; the residual gap below ~20% at ch8-10 is the one
place a bar alone can't reach (point-mass), and that is covered by **difficulty (tighter tol / more
rounds / faster deep games)**, not a roll.

**Deep-mechanic hardening still needed on kept games:**
1. **Dexterity tol loosening** (wiretrace, zigzag, dodgefall, pinchgap) — currently unwinnable/mis-graded
   at deep tol; loosen so a faithful trace clears ~15-25%, then they join the deep pool.
2. **gonogo/oddsignal** — keep shallow-only; do NOT let them into ch6-10 (their grade floors high, no
   deep gate; already handled by poolFor but re-verify under DET).
3. **Skill sequence deep bar** — safeproc/lockorder floor ~48-56%; fine for mid but they should not be
   the ch9-10 gate. Ensure the deepest chambers draw from dexterity/perception.

## SOLVER-BAIT TO REMOVE FIRST (V1-winner class — cut/rework regardless of category)

Single-action / constant-fraction / fixed-target-timing games — a script beats these deterministically:

1. **RHYTHM — entire category** (15 games). All timing-tap, solver-resist 1, floors 46%. The literal
   V1-winner mechanic. Highest priority.
2. **SKILL: powermeter** — single hold; solver sets hold = target/rate. (solver-resist 1)
3. **SKILL: anglelaunch** — single 2-value commit; closed-form inverse. (1)
4. **SKILL: ricochet** — single aim commit; closed-form bank-shot inverse. (1)
5. **SKILL: pressurevalve, recoilctl** — computable tap-cadence to hold a band. (2)
6. **SKILL: overridegrid** — deterministic toggle-to-target; solver computes the diff. (2)
7. **DEXTERITY: swipegates** — discrete computable directional sequence, 100% clear. (2)
8. **DEXTERITY: threadneedle** — segment grading too forgiving (99.9%); not solver-bait per se but
   provides no gate. Cut or re-grade.

Everything on this list is either deleted in the lean roster or flagged REWORK; none should sit on a
ch6-10 door in deterministic mode.

---

### Caveats / ambiguity flags

- Several dexterity path games (wiretrace, zigzag, dodgefall) and skill cadence games
  (pressurevalve, recoilctl) read **0% at bar=1.0** in the sim. This is partly the deep tolerance
  being tighter than the competent-human motor model (genuinely near-unwinnable deep) and partly the
  sim's `follow()`/tap-cadence human model not perfectly reproducing the presenter's live integration.
  Treat their **0% as "too hard / mis-graded", not as strong gating** — hence REWORK, not KEEP. Their
  input **class** (continuous path) is solid; the numbers need a real-tolerance re-tune (and ideally a
  human playtest per BOT-SIGNALS.md) before trusting them on a live deep door.
- Perception numbers are the honest 4-round MIN gate at deepest stimulus; the shallow (K=1) rounds
  saturate high by design and are not a concern.
- All clear-rates are the *competent-human* model, not a bot. Solver-resistance is a source-read
  judgment, not measured against an actual solver — the deterministic launch's real backstop remains
  the humanness/enforcement layer in BOT-SIGNALS.md (esp. the nerve/ratio solver fingerprint and
  zero-world-interaction signals), regardless of roster.
