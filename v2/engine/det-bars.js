// DETERMINISTIC (no-roll) difficulty bars — HAND-TUNED (Jake 2026-09-13, replacing the sim's broken output).
// The Monte-Carlo solver (tune-det.js) cannot model the continuous motor/precision games — it maxed every dexterity/skill bar to
// ~0.99-1.0 (unplayable at ch1), confirmed by Jake's live play (busting ch2 games at bar 0.99). So dexterity + skill use a sane
// difficulty RAMP here: gentle shallow, tough deep. These are STARTING points to refine from real playtest scores, not sim output.
// Per-DOOR shallow variation (Jake 2026-09-13: room1 85±15, tightening to ~0 deep) is applied at runtime in server.js (barVar), so
// the three doors in a room differ and luck isn't the auto-pick — NOT baked into these base tables.
// tiers: left = easier (lower bar), center = base, right = harder (higher bar). Perception is a binary right-answer K-gate (any
// threshold in (0,1] = "must get the round(s) right"), so it stays flat 0.5 — its difficulty is the multi-round stimulus, not the bar.
module.exports = {
  "DET_SKILL_BAR_T": {
    // SKILL (multi-press sequence) is a shallow/mid door only (deep chambers draw dexterity/luck/perception). ch1-5 the sane ramp; ch6-10 high (unused).
    "left":   [0.22, 0.32, 0.42, 0.50, 0.57, 0.85, 0.88, 0.90, 0.92, 0.94],
    "center": [0.30, 0.40, 0.50, 0.58, 0.65, 0.88, 0.90, 0.92, 0.94, 0.96],
    "right":  [0.36, 0.46, 0.56, 0.64, 0.71, 0.90, 0.92, 0.94, 0.96, 0.97]
  },
  "DET_DEXTERITY_BAR_T": {
    // DEXTERITY is the deep backbone — the ramp keeps rising into the vault gate (ch8-10) where rarity lives. Tune deep from Jake's deep-reach data.
    "left":   [0.22, 0.32, 0.42, 0.50, 0.57, 0.64, 0.72, 0.78, 0.83, 0.87],
    "center": [0.30, 0.40, 0.50, 0.58, 0.65, 0.72, 0.80, 0.86, 0.90, 0.94],
    "right":  [0.36, 0.46, 0.56, 0.64, 0.71, 0.78, 0.86, 0.91, 0.95, 0.97]
  },
  "DET_PERCEPTION_BAR_T": {
    // binary right-answer K-round gate: difficulty is the number of rounds + stimulus, not the bar. Flat 0.5 = "get the round(s) right".
    "left":   [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    "center": [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    "right":  [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
  }
};
