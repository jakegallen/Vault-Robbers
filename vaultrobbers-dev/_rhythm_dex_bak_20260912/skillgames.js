'use strict';
/*
 * Vault Robbers — SKILL ENGINE v4 (seed-not-answer). Detached, flag-gated (RTV_SKILL_V4).
 *
 * THE ONE RULE that makes the deterministic model bot-safe:
 *   The client is NEVER sent enough to compute the winning input. Every challenge splits into:
 *     data   -> safe to ship to the browser (motion, counts, grid dims, timings). Contains NO answer.
 *     pixels -> the answer-bearing content the human PERCEIVES. In transport (P3) this is rendered as
 *               distorted glyphs / a visual scene, so only human vision extracts it; a JSON/step bot cannot.
 *     secret -> the server-only grading key. Never leaves the server.
 *   The server re-derives `secret` from the seed and grades the streamed inputs. A payload-reading bot has
 *   only `data`, so it can do no better than chance. (Full CV bots are handled by the OTHER layers:
 *   proof-of-humanity at the core + the payout cap — see P5. No single layer is claimed to be perfect.)
 *
 * Difficulty axis (NOT ms-window-shrink, which becomes superhuman under determinism and helps bots):
 *   scale by DISCRETE cognitive/perceptual load — rounds (N), memory span (M), choices (K), tolerance (T).
 *   Each atomic action stays inside a comfortable human window; quantity + cognition are the wall.
 *
 * Contract per game:
 *   family                          'memory'|'perception'|'compute'|'timing'
 *   build(seed, level) -> { data, pixels, secret }
 *   grade(built, level, events) -> score in [0,1]
 *   humanP(level) -> { p, kind }    per-item/round human success prob, for the calibration sim
 */
const crypto = require('crypto');

// deterministic byte stream from seed material (rehashes with a counter when exhausted)
function rng(mat) {
  let ctr = 0, buf = crypto.createHash('sha256').update(mat + ':0').digest(), p = 0;
  const next = () => { if (p + 4 > buf.length) { ctr++; buf = crypto.createHash('sha256').update(mat + ':' + ctr).digest(); p = 0; } const v = buf.readUInt32BE(p); p += 4; return v; };
  return { u: () => next() / 0xffffffff, int: (n) => next() % n, sample: (arr, k) => { const a = arr.slice(); const out = []; for (let i = 0; i < k && a.length; i++) out.push(a.splice(next() % a.length, 1)[0]); return out; } };
}
const LEVELS = 10;
const dOf = (lvl) => (lvl - 1) / (LEVELS - 1);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const seedMat = (seed, key, lvl) => `${seed}:${key}:${lvl}`;
// CORE HARDENING (Jake 2026-09-08 unification): shallow chambers unchanged; from ~ch6 the deep continuous games ramp HARD
// so a real human's (continuous) score collapses toward the luck backbone (~0.2% at the core). Applied to the depth-gated
// deep pools only (timing precision for skill; long-span recall for memory). Verified via sim-odds.js round-trip.
const coreSpeed = (d) => (d <= 0.55 ? 1 : 1 + 3.6 * Math.pow((d - 0.55) / 0.45, 1.5));   // 1x through ch6 -> ~4.6x at ch10
const coreTol = (d) => (d <= 0.55 ? 1 : clamp(1 - 0.6 * Math.pow((d - 0.55) / 0.45, 1.1), 0.4, 1));   // shrink tolerance to ~0.4x deep

const GAMES = {
  // ── MEMORY: flash a sequence of distorted glyphs; recall them in order. Answer lives only in pixels+secret.
  lineup: {
    family: 'memory', label: 'Lineup',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'lineup', lvl)), d = dOf(lvl);
      const M = Math.min(10, Math.round(3 + 7 * d));         // span 3..10 (deep-hardened for unification)
      const palette = 10;                                    // 10 possible glyphs
      const seq = []; for (let i = 0; i < M; i++) seq.push(r.int(palette));
      const flashMs = Math.round(clamp(950 - 720 * d, 200, 950));
      return { data: { count: M, palette, flashMs }, pixels: { seq }, secret: { seq } };
    },
    grade(b, lvl, ev) {
      const picks = (ev || []).filter(e => e && e.type === 'pick').map(e => e.idx);
      let correct = 0; for (let i = 0; i < b.secret.seq.length; i++) { if (picks[i] === b.secret.seq[i]) correct++; else break; }
      return correct / b.secret.seq.length;                  // graded prefix (smooth curve, no all-or-nothing cliff)
    },
    humanP(lvl) { const d = dOf(lvl), M = Math.round(3 + 4 * d), cap = 6.4 - Math.max(0, (500 - (950 - 520 * d))) / 260; return { p: cap, M, kind: 'span' }; }
  },

  // ── MEMORY (NEW V2 batch): Safe Combo — the combination flashes ONE DIGIT at a time; recall it in order. Answer lives only
  //    in pixels+secret (a payload bot sees only count/flashMs). Span grows + flash shrinks with depth so a human's recall
  //    collapses toward the backbone; digits are a fresh modality the V1 kit never trained on.
  safecombo: {
    family: 'memory', label: 'Safe Combo',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'safecombo', lvl)), d = dOf(lvl);
      const M = Math.min(9, Math.round(3 + 6 * d));           // span 3..9 digits (deep-hardened)
      const seq = []; for (let i = 0; i < M; i++) seq.push(r.int(10));
      const flashMs = Math.round(clamp(900 - 680 * d, 200, 900));
      return { data: { count: M, palette: 10, flashMs, digits: true }, pixels: { seq }, secret: { seq } };
    },
    grade(b, lvl, ev) {
      const picks = (ev || []).filter(e => e && e.type === 'pick').map(e => e.idx);
      let correct = 0; for (let i = 0; i < b.secret.seq.length; i++) { if (picks[i] === b.secret.seq[i]) correct++; else break; }
      return correct / b.secret.seq.length;                  // graded prefix (smooth)
    },
    humanP(lvl) { const d = dOf(lvl), M = Math.round(3 + 4 * d), cap = 6.6 - Math.max(0, (500 - (900 - 500 * d))) / 260; return { p: cap, M, kind: 'span' }; }
  },

  // ── MEMORY (NEW V2 batch): Color Lock — a run of coloured indicators flashes in order; recall the colour sequence. Same
  //    farm-resistant span-recall as Lineup but a distinct colour modality; smooth graded-prefix + depth-collapse.
  colorlock: {
    family: 'memory', label: 'Color Lock',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'colorlock', lvl)), d = dOf(lvl);
      const M = Math.min(9, Math.round(3 + 6 * d));           // span 3..9 colours
      const palette = 6; const seq = []; for (let i = 0; i < M; i++) seq.push(r.int(palette));
      const flashMs = Math.round(clamp(880 - 660 * d, 200, 880));
      return { data: { count: M, palette, flashMs }, pixels: { seq }, secret: { seq } };
    },
    grade(b, lvl, ev) {
      const picks = (ev || []).filter(e => e && e.type === 'pick').map(e => e.idx);
      let correct = 0; for (let i = 0; i < b.secret.seq.length; i++) { if (picks[i] === b.secret.seq[i]) correct++; else break; }
      return correct / b.secret.seq.length;
    },
    humanP(lvl) { const d = dOf(lvl), M = Math.round(3 + 4 * d), cap = 6.8 - Math.max(0, (500 - (880 - 500 * d))) / 260; return { p: cap, M, kind: 'span' }; }
  },

  // ── MEMORY (NEW V2 batch): Bearing — a run of directions (up/right/down/left) flashes; recall the path in order.
  bearing: {
    family: 'memory', label: 'Bearing',
    build(seed, lvl) { const r = rng(seedMat(seed, 'bearing', lvl)), d = dOf(lvl); const M = Math.min(9, Math.round(3 + 6 * d)); const seq = []; for (let i = 0; i < M; i++) seq.push(r.int(4)); const flashMs = Math.round(clamp(860 - 640 * d, 200, 860)); return { data: { count: M, palette: 4, flashMs, dirs: true }, pixels: { seq }, secret: { seq } }; },
    grade(b, lvl, ev) { const picks = (ev || []).filter(e => e && e.type === 'pick').map(e => e.idx); let c = 0; for (let i = 0; i < b.secret.seq.length; i++) { if (picks[i] === b.secret.seq[i]) c++; else break; } return c / b.secret.seq.length; },
    humanP(lvl) { const d = dOf(lvl), M = Math.round(3 + 4 * d), cap = 6.9 - Math.max(0, (500 - (860 - 500 * d))) / 260; return { p: cap, M, kind: 'span' }; }
  },
  // ── MEMORY (NEW V2 batch): The Count — loot denominations flash one at a time; recall the run in order.
  denoms: {
    family: 'memory', label: 'The Count',
    build(seed, lvl) { const r = rng(seedMat(seed, 'denoms', lvl)), d = dOf(lvl); const opts = [5, 10, 25, 50, 100]; const M = Math.min(8, Math.round(3 + 5 * d)); const seq = []; for (let i = 0; i < M; i++) seq.push(opts[r.int(opts.length)]); const flashMs = Math.round(clamp(950 - 700 * d, 220, 950)); return { data: { count: M, options: opts, flashMs, values: true }, pixels: { seq }, secret: { seq } }; },
    grade(b, lvl, ev) { const picks = (ev || []).filter(e => e && e.type === 'pick').map(e => Number(e.idx)); let c = 0; for (let i = 0; i < b.secret.seq.length; i++) { if (picks[i] === b.secret.seq[i]) c++; else break; } return c / b.secret.seq.length; },
    humanP(lvl) { const d = dOf(lvl), M = Math.round(3 + 3.5 * d), cap = 6.2 - Math.max(0, (500 - (950 - 520 * d))) / 260; return { p: cap, M, kind: 'span' }; }
  },
  // ── MEMORY (NEW V2 batch): Shortlist — a SET of marks appears together for a beat; recall the whole set (order-free).
  glyphset: {
    family: 'memory', label: 'Shortlist',
    build(seed, lvl) { const r = rng(seedMat(seed, 'glyphset', lvl)), d = dOf(lvl); const K = Math.min(8, Math.round(3 + 5 * d)); const set = r.sample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], K); const flashMs = Math.round(clamp(1100 - 780 * d, 260, 1100)); return { data: { k: K, palette: 10, flashMs, set: true }, pixels: { set }, secret: { set } }; },
    grade(b, lvl, ev) { const picks = [...new Set((ev || []).filter(e => e && e.type === 'pick').map(e => e.idx))]; const S = new Set(b.secret.set); let hit = 0; for (const p of picks) if (S.has(p)) hit++; return Math.min(1, hit / b.secret.set.length); },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.95 - 0.5 * d, 0.3, 0.95), kind: 'set' }; }
  },
  // ── SKILL (NEW V2 batch): Pendulum — a bob swings (sine, eases at the ends); tap inside the hidden safe band. Band tightens deep.
  pendulum: {
    family: 'timing', label: 'Pendulum',
    build(seed, lvl) { const r = rng(seedMat(seed, 'pendulum', lvl)), d = dOf(lvl); const speed = (1.0 + 0.5 * d) * coreSpeed(d); const hw = clamp(0.13 - 0.055 * d, 0.06, 0.13) * coreTol(d); const c = 0.22 + r.u() * 0.56; return { data: { speed }, pixels: { c, hw }, secret: { c, hw, speed } }; },   // data-min: hw (band width) stays server-side; client never reads it
    grade(b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const pos = 0.5 + 0.5 * Math.sin(b.secret.speed * ((tap.t || 0) / 1000)); const err = Math.abs(pos - b.secret.c); return err <= b.secret.hw ? clamp(1 - err / b.secret.hw, 0, 1) : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.19 * d, 0.4, 0.9), kind: 'single' }; }
  },
  // ── SKILL (NEW V2 batch): Crosshair — a reticle drifts in 2D; tap when it sits inside the target box. Two-axis precision, brutal deep.
  crosshair: {
    family: 'timing', label: 'Crosshair',
    build(seed, lvl) { const r = rng(seedMat(seed, 'crosshair', lvl)), d = dOf(lvl); const sx = (0.9 + 0.5 * d) * coreSpeed(d), sy = (0.7 + 0.45 * d) * coreSpeed(d); const tol = clamp(0.12 - 0.05 * d, 0.05, 0.12) * coreTol(d); const tx = 0.2 + r.u() * 0.6, ty = 0.2 + r.u() * 0.6; return { data: { sx, sy }, pixels: { tx, ty, tol }, secret: { tx, ty, tol, sx, sy } }; },   // data-min: tol stays server-side
    grade(b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const t = (tap.t || 0) / 1000; const x = 0.5 + 0.5 * Math.sin(b.secret.sx * t), y = 0.5 + 0.5 * Math.sin(b.secret.sy * t + 1.7); const err = Math.hypot(x - b.secret.tx, y - b.secret.ty); return err <= b.secret.tol ? clamp(1 - err / b.secret.tol, 0, 1) : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.85 - 0.22 * d, 0.35, 0.85), kind: 'single' }; }
  },
  // ── SKILL (NEW V2 batch): Orbit — a dot circles the ring; tap as it crosses the marked arc.
  orbit: {
    family: 'timing', label: 'Orbit',
    build(seed, lvl) { const r = rng(seedMat(seed, 'orbit', lvl)), d = dOf(lvl); const speed = (1.0 + 0.6 * d) * coreSpeed(d); const tol = clamp(0.30 - 0.14 * d, 0.10, 0.30) * coreTol(d); const target = r.u() * Math.PI * 2, start = r.u() * Math.PI * 2; return { data: { speed, start }, pixels: { target, tol }, secret: { target, tol, speed, start } }; },
    grade(b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const a = (b.secret.start + b.secret.speed * ((tap.t || 0) / 1000)) % (Math.PI * 2); const err = Math.abs(((a - b.secret.target + Math.PI * 3) % (Math.PI * 2)) - Math.PI); return err <= b.secret.tol ? clamp(1 - err / b.secret.tol, 0, 1) : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.17 * d, 0.45, 0.9), kind: 'single' }; }
  },
  // ── SKILL (NEW V2 batch): Slider — a marker sweeps one way and wraps; stop it on the notch.
  slider: {
    family: 'timing', label: 'Slider',
    build(seed, lvl) { const r = rng(seedMat(seed, 'slider', lvl)), d = dOf(lvl); const speed = (0.55 + 0.4 * d) * coreSpeed(d); const hw = clamp(0.11 - 0.05 * d, 0.05, 0.11) * coreTol(d); const c = 0.2 + r.u() * 0.6; return { data: { speed }, pixels: { c, hw }, secret: { c, hw, speed } }; },   // data-min: hw stays server-side
    grade(b, lvl, ev) { const st = (ev || []).find(e => e && (e.type === 'stop' || e.type === 'tap')); if (!st) return 0; const pos = (b.secret.speed * ((st.t || 0) / 1000)) % 1; const raw = Math.abs(pos - b.secret.c); const err = Math.min(raw, 1 - raw); return err <= b.secret.hw ? clamp(1 - err / b.secret.hw, 0, 1) : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.18 * d, 0.4, 0.9), kind: 'single' }; }
  },
  // ── SKILL (NEW V2 batch): Triple Align — three rings spin at different rates; tap the instant all three sit on their marks.
  align3: {
    family: 'timing', label: 'Triple Align',
    build(seed, lvl) { const r = rng(seedMat(seed, 'align3', lvl)), d = dOf(lvl); const tol = clamp(0.34 - 0.15 * d, 0.12, 0.34) * coreTol(d); const rings = []; for (let i = 0; i < 3; i++) rings.push({ speed: (0.7 + 0.5 * i + 0.5 * d) * coreSpeed(d), target: r.u() * Math.PI * 2, start: r.u() * Math.PI * 2 }); return { data: { rings: rings.map(x => ({ speed: x.speed, start: x.start })) }, pixels: { rings, tol }, secret: { rings, tol } }; },   // data-min: tol + per-ring target stay server-side
    grade(b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const t = (tap.t || 0) / 1000; let mn = 1; for (const rg of b.secret.rings) { const a = (rg.start + rg.speed * t) % (Math.PI * 2); const err = Math.abs(((a - rg.target + Math.PI * 3) % (Math.PI * 2)) - Math.PI); const s = err <= b.secret.tol ? clamp(1 - err / b.secret.tol, 0, 1) : 0; if (s < mn) mn = s; } return mn; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.82 - 0.24 * d, 0.3, 0.82), kind: 'single' }; }
  },
  // ── SKILL (NEW V2 batch): Pulse — a shockwave expands from the center; tap when its radius matches the target ring.
  pulse: {
    family: 'timing', label: 'Pulse',
    build(seed, lvl) { const r = rng(seedMat(seed, 'pulse', lvl)), d = dOf(lvl); const speed = (0.7 + 0.5 * d) * coreSpeed(d); const hw = clamp(0.12 - 0.05 * d, 0.05, 0.12) * coreTol(d); const rt = 0.35 + r.u() * 0.5; return { data: { speed }, pixels: { rt, hw }, secret: { rt, hw, speed } }; },   // data-min: hw stays server-side
    grade(b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const rad = (b.secret.speed * ((tap.t || 0) / 1000)) % 1; const err = Math.abs(rad - b.secret.rt); return err <= b.secret.hw ? clamp(1 - err / b.secret.hw, 0, 1) : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.18 * d, 0.4, 0.9), kind: 'single' }; }
  },

  // ── MEMORY + COMPUTE (Finance theme): deposits/withdrawals flash ONE AT A TIME; track the running balance and
  //    submit the final total. Amounts live only in pixels; the net is server-only. Sequential flash = higher memory
  //    load than combo (which shows all at once), and it is a brand-new mechanic the V1 attacker's kit never saw.
  ledger: {
    family: 'memory', label: 'The Ledger',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'ledger', lvl)), d = dOf(lvl);
      const M = Math.round(3 + 4 * d);                       // 3..7 entries, flashed one at a time
      const maxv = Math.round(9 + 40 * d);                   // 9..49 magnitude (multi-digit deeper)
      const amts = []; let net = 0;
      for (let i = 0; i < M; i++) {
        let v = 1 + r.int(maxv);
        let sign = (i === 0) ? 1 : (r.u() < 0.4 ? -1 : 1);   // first is always a deposit; ~40% withdrawals after
        if (net + sign * v < 1) sign = 1;                    // never let the running balance drop below 1 (net stays a positive integer -> plain keypad)
        net += sign * v; amts.push({ v, sign });
      }
      const flashMs = Math.round(clamp(1000 - 560 * d, 420, 1000));
      return { data: { count: M, flashMs }, pixels: { amts }, secret: { net } };
    },
    grade(b, lvl, ev) { const a = (ev || []).find(e => e && e.type === 'answer'); return a && Number(a.value) === b.secret.net ? 1 : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.96 - 0.6 * d, 0.28, 0.96), kind: 'binary' }; }
  },

  // ── MEMORY + PERCEPTION (Tech theme): a grid flashes with cells at TWO brightness tiers (hot vs warm decoys). Recall
  //    ONLY the brightest cells. Two-tier discrimination under a flash = distinct from gridrecall's binary lit/unlit, and
  //    the brightness lives only in rendered pixels (a JSON bot sees nothing). Wrong taps subtract, so guessing is punished.
  heatmap: {
    family: 'memory', label: 'Heat Map',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'heatmap', lvl)), d = dOf(lvl);
      const grid = (d < 0.34 ? 9 : (d < 0.7 ? 16 : 25));
      const hotN = Math.round(2 + 3 * d);                  // 2..5 brightest to recall
      const warmN = Math.round(2 + 4 * d);                 // medium decoys (the discrimination load)
      const idx = []; for (let i = 0; i < grid; i++) idx.push(i);
      const pick = r.sample(idx, Math.min(grid, hotN + warmN));
      const hot = pick.slice(0, hotN), warm = pick.slice(hotN);
      const flashMs = Math.round(clamp(1100 - 620 * d, 380, 1100));
      return { data: { grid, count: hotN, flashMs }, pixels: { hot, warm }, secret: { hot } };
    },
    grade(b, lvl, ev) {
      const picks = new Set((ev || []).filter(e => e && e.type === 'cell').map(e => e.cell));
      const hot = b.secret.hot; let ok = 0; for (const h of hot) if (picks.has(h)) ok++;
      let over = 0; for (const p of picks) if (!hot.includes(p)) over++;   // wrong taps subtract (no spray-and-pray)
      return clamp((ok - over) / hot.length, 0, 1);
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.95 - 0.55 * d, 0.3, 0.95), kind: 'set' }; }
  },

  // ── PERCEPTION (Tech theme): match the slider to a target voltage tick that exists ONLY in the rendered pixels.
  //    A JSON bot never learns the target position; difficulty = tighter tolerance + more rounds deep. Distinct from
  //    shade (colour match) and torque (timed band) — a static positional match across several rounds.
  voltage: {
    family: 'perception', label: 'Voltage Match',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'voltage', lvl)), d = dOf(lvl);
      const rounds = Math.round(2 + 2 * d);                    // 2..4 rounds
      const tol = clamp((0.15 - 0.10 * d) * coreTol(d), 0.035, 0.15);   // hit window shrinks with depth (deep-hardened)
      const targets = []; for (let i = 0; i < rounds; i++) targets.push(0.10 + r.u() * 0.80);
      return { data: { rounds, tol }, pixels: { targets, tol }, secret: { targets, tol } };
    },
    grade(b, lvl, ev) {
      const locks = (ev || []).filter(e => e && e.type === 'lock');
      if (locks.length < b.secret.targets.length) return 0;
      let s = 0; for (let i = 0; i < b.secret.targets.length; i++) { const err = Math.abs((locks[i].pos != null ? locks[i].pos : 1) - b.secret.targets[i]); s += clamp(1 - err / (b.secret.tol * 2), 0, 1); }
      return s / b.secret.targets.length;
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.95 - 0.4 * d, 0.5, 0.95), N: Math.round(2 + 2 * d), kind: 'round' }; }
  },

  // ── PERCEPTION: N rounds, each a grid of K near-identical tiles with one visual outlier. Click the odd one.
  //    The perturbation is a RENDERED artifact (pixels), never a data field — the bot can't diff descriptors.
  oddone: {
    family: 'perception', label: 'Odd One Out',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'oddone', lvl)), d = dOf(lvl);
      const N = Math.round(2 + 2 * d);                       // 2..4 rounds (monotonic, less non-linear vs bar)
      const K = Math.round(6 + 10 * d);                      // 6..16 tiles
      const salience = clamp(0.85 - 0.55 * d, 0.28, 0.85);   // odd-tile distinctness (shrinks gently with depth)
      const odd = []; for (let i = 0; i < N; i++) odd.push(r.int(K));
      return { data: { rounds: N, tiles: K, salience }, pixels: { odd, salience }, secret: { odd } };
    },
    grade(b, lvl, ev) {
      const picks = (ev || []).filter(e => e && e.type === 'pick');
      let ok = 0; for (let i = 0; i < b.secret.odd.length; i++) { if (picks[i] && picks[i].idx === b.secret.odd[i]) ok++; }
      return ok / b.secret.odd.length;
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.99 - 0.5 * d, 0.4, 0.99), N: Math.round(2 + 3 * d), kind: 'round' }; }
  },

  // ── COMPUTE + MEMORY: flash M numbers + a rule, hide them, submit the computed answer. Operands only in pixels.
  combo: {
    family: 'compute', label: 'Mental Combo',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'combo', lvl)), d = dOf(lvl);
      const M = Math.round(2 + 4 * d);                       // 2..6 operands (trivial early, real deep)
      const nums = []; for (let i = 0; i < M; i++) nums.push(1 + r.int(9));
      const rules = ['sum', 'max', 'min', 'sumEven', 'sumOdd'];
      const rule = rules[r.int(d < 0.4 ? 3 : rules.length)]; // harder rules (sumEven/Odd) unlock deeper
      const ans = rule === 'sum' ? nums.reduce((a, x) => a + x, 0)
        : rule === 'max' ? Math.max(...nums) : rule === 'min' ? Math.min(...nums)
        : rule === 'sumEven' ? nums.filter(x => x % 2 === 0).reduce((a, x) => a + x, 0)
        : nums.filter(x => x % 2 === 1).reduce((a, x) => a + x, 0);
      const flashMs = Math.round(clamp(1100 - 560 * d, 460, 1100));
      return { data: { count: M, rule, flashMs }, pixels: { nums }, secret: { ans } };
    },
    grade(b, lvl, ev) { const a = (ev || []).find(e => e && e.type === 'answer'); return a && Number(a.value) === b.secret.ans ? 1 : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.97 - 0.55 * d, 0.3, 0.97), kind: 'binary' }; }
  },

  // ── TIMING (server-authoritative target): the marker MOTION is sent so the client can animate, but the TARGET
  //    notch is pixels-only. The bot knows where the marker IS but not where to STOP, so it can't beat it from JSON.
  dial: {
    family: 'timing', label: 'Crack the Dial',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'dial', lvl)), d = dOf(lvl);
      const stops = Math.round(1 + 1.2 * d);                 // 1..2 stops; difficulty = MORE stops, not a thinner arc
      const speed = (1.3 + 0.9 * d) * coreSpeed(d);          // rad/s; ramps hard past ch6
      const arcW = 0.30 * coreTol(d);                        // comfortable window shallow, deep-tightened
      const start = r.u() * Math.PI * 2;
      const targets = []; for (let i = 0; i < stops; i++) targets.push(r.u() * Math.PI * 2);
      return { data: { stops, speed, arcW, start }, pixels: { targets }, secret: { targets, arcW, speed, start } };
    },
    grade(b, lvl, ev) {
      const locks = (ev || []).filter(e => e && e.type === 'lock');
      if (locks.length < b.secret.targets.length) return 0;
      let s = 0; for (let i = 0; i < b.secret.targets.length; i++) {
        const a = (locks[i].t != null) ? (b.secret.start + b.secret.speed * (locks[i].t / 1000)) % (Math.PI * 2) : locks[i].a;   // server derives the locked angle from the tap TIME (client can't spoof an angle; the target notch it aimed at is pixels-only)
        let err = Math.abs(((a - b.secret.targets[i] + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        s += clamp(1 - err / (b.secret.arcW * 2.2), 0, 1);
      }
      return s / b.secret.targets.length;
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.95 - 0.15 * d, 0.6, 0.95), N: Math.round(1 + 3 * d), kind: 'round' }; }
  },

  // ── PERCEPTION (discrimination): match a dial to a target SHADE you can only see. Target value is pixels-only,
  //    so a bot never learns the hue/brightness to match. Difficulty = tighter tolerance + more rounds.
  shade: {
    family: 'perception', label: 'Shade Match',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'shade', lvl)), d = dOf(lvl);
      const N = Math.round(1 + 1.5 * d);                     // 1..2 rounds
      const tol = clamp(0.16 - 0.07 * d, 0.06, 0.16);        // perceptual tolerance (fraction of the scale)
      const targets = []; for (let i = 0; i < N; i++) targets.push(0.12 + r.u() * 0.76);
      return { data: { rounds: N, tol }, pixels: { targets }, secret: { targets, tol } };
    },
    grade(b, lvl, ev) {
      const m = (ev || []).filter(e => e && e.type === 'match');
      if (m.length < b.secret.targets.length) return 0;
      let s = 0; for (let i = 0; i < b.secret.targets.length; i++) { const err = Math.abs(m[i].v - b.secret.targets[i]); s += err <= b.secret.tol ? clamp(1 - err / b.secret.tol, 0, 1) : 0; }
      return s / b.secret.targets.length;
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.2 * d, 0.4, 0.9), N: Math.round(1 + 2 * d), kind: 'round' }; }
  },

  // ── MEMORY (spatial): a path of cells lights up on a grid; reproduce it in order. Which cells + order are
  //    pixels-only; the bot gets only the grid size + count, so it can't know the path.
  spatial: {
    family: 'memory', label: 'Spatial Recall',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'spatial', lvl)), d = dOf(lvl);
      const grid = d < 0.5 ? 9 : 16;                         // 3x3 early, 4x4 deep
      const M = Math.min(grid, Math.round(3 + 7 * d));       // path length 3..10 (deep-hardened)
      const cells = []; for (let i = 0; i < M; i++) cells.push(r.int(grid));
      const flashMs = Math.round(clamp(720 - 520 * d, 200, 720));
      return { data: { grid, count: M, flashMs }, pixels: { cells }, secret: { cells } };
    },
    grade(b, lvl, ev) {
      const picks = (ev || []).filter(e => e && e.type === 'pick').map(e => e.cell);
      let correct = 0; for (let i = 0; i < b.secret.cells.length; i++) { if (picks[i] === b.secret.cells[i]) correct++; else break; }
      return correct / b.secret.cells.length;
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.25 * d, 0.35, 0.9), M: Math.min(16, Math.round(3 + 4 * d)), kind: 'span' }; }
  },

  // ── RHYTHM: a beat pattern plays (audio + visual pulses); reproduce it by tapping. Graded on RELATIVE interval
  //    accuracy (tempo-invariant). The intervals are pixels/audio-only, so a JSON bot has no timestamps to copy.
  // ── KEYPAD "Keypad Breach" (memory): a keycode flashes digit-by-digit; re-enter it on the pad. The code is a
  //    TRANSPARENT server overlay (pixels-only, flashed) so a bot never sees the digits.
  keypad: {
    family: 'memory', label: 'Keypad Breach',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'keypad', lvl)), d = dOf(lvl);
      const len = Math.min(10, Math.round(3 + 7 * d)); const code = []; for (let i = 0; i < len; i++) code.push(1 + r.int(9));
      const flashMs = Math.round(clamp(880 - 640 * d, 200, 880));
      return { data: { len, flashMs }, pixels: { code }, secret: { code } };
    },
    grade(b, lvl, ev) { const picks = (ev || []).filter(e => e && e.type === 'key').map(e => e.d); let c = 0; for (let i = 0; i < b.secret.code.length; i++) { if (picks[i] === b.secret.code[i]) c++; else break; } return c / b.secret.code.length; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(6.6 - 0, 0, 99), cap: 6.6, kind: 'span' }; }
  },

  // ── TORQUE "Torque Wrench" (timing, vertical gauge): a fill rises/falls; TAP when it sits in the hidden green band.
  //    Band position is a TRANSPARENT server overlay; motion client-side; graded by tap TIME.
  torque: {
    family: 'timing', label: 'Torque Wrench',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'torque', lvl)), d = dOf(lvl);
      const speed = (0.8 + 0.55 * d) * coreSpeed(d); const hw = clamp(0.14 - 0.06 * d, 0.075, 0.14) * coreTol(d); const c = 0.28 + r.u() * 0.44;
      return { data: { speed }, pixels: { c, hw }, secret: { c, hw, speed } };   // data-min (audit 2026-09-10): hw stays server-side; presenter reads only speed, band is drawn from the PNG
    },
    grade(b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const ph = ((b.secret.speed * ((tap.t || 0) / 1000)) % 2 + 2) % 2, pos = ph < 1 ? ph : 2 - ph; const err = Math.abs(pos - b.secret.c); return err <= b.secret.hw ? clamp(1 - err / b.secret.hw, 0, 1) : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.19 * d, 0.4, 0.9), kind: 'single' }; }
  },

  // ── TARGETS "Snap the Locks" (perception + dexterity): tap all the hidden locks before the timer. Lock POSITIONS
  //    are a TRANSPARENT server overlay (pixels-only); a bot doesn't know where they are, so it can't tap them.
  targets: {
    family: 'perception', label: 'Snap the Locks',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'targets', lvl)), d = dOf(lvl);
      const n = Math.round(3 + 3 * d);                       // 3..6 locks
      const span = Math.round(clamp(4800 - 2200 * d, 2400, 4800)); const tol = 0.085;
      const pos = []; for (let i = 0; i < n; i++) pos.push({ x: 0.12 + r.u() * 0.76, y: 0.16 + r.u() * 0.68 });
      // pos IS in data on purpose: the locks are visible (a speed/accuracy game, not a hidden-answer one), so the client
      // draws them and clears each on tap. Bots that read pos and auto-snap are caught by the humanness/rate anti-bot layer.
      return { data: { n, span, tol, pos }, pixels: { pos }, secret: { pos, tol } };
    },
    grade(b, lvl, ev) {
      const taps = (ev || []).filter(e => e && e.type === 'tap'), used = []; let m = 0;
      for (const p of b.secret.pos) { for (let j = 0; j < taps.length; j++) { if (used[j]) continue; if (Math.hypot(taps[j].x - p.x, taps[j].y - p.y) <= b.secret.tol) { used[j] = 1; m++; break; } } }
      return m / b.secret.pos.length;
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.96 - 0.13 * d, 0.5, 0.96), N: Math.round(3 + 3 * d), kind: 'round' }; }
  },

  // ── SORT "Crack the Sequence" (logic): tap the numbers in ascending order. The NUMBERS are a transparent server
  //    overlay (pixels-only); a bot sees only how many slots there are, not the values, so it can't order them.
  sort: {
    family: 'compute', label: 'Crack the Sequence',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'sort', lvl)), d = dOf(lvl);
      const N = Math.round(3 + 2 * d);                       // 3..5 numbers
      const nums = [], used = new Set(); while (nums.length < N) { const v = 1 + r.int(98); if (!used.has(v)) { used.add(v); nums.push(v); } }
      const order = nums.map((v, i) => i).sort((a, b) => nums[a] - nums[b]);   // correct slot order (ascending)
      return { data: { count: N }, pixels: { nums }, secret: { nums, order } };
    },
    grade(b, lvl, ev) {
      const picks = (ev || []).filter(e => e && e.type === 'order').map(e => e.idx); if (picks.length < b.secret.order.length) return 0;
      let c = 0; for (let i = 0; i < b.secret.order.length; i++) { if (picks[i] === b.secret.order[i]) c++; else break; } return c / b.secret.order.length;
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.96 - 0.16 * d, 0.4, 0.96), kind: 'binary' }; }
  },

  // ── STOPWATCH "Time the Lock" (server-authoritative timing): a hand sweeps the dial; STOP it on the hidden mark.
  //    The mark is a TRANSPARENT server overlay (pixels-only); client renders the clock + hand; graded by stop TIME.
  stopwatch: {
    family: 'timing', label: 'Time the Lock',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'stopwatch', lvl)), d = dOf(lvl);
      const speed = (1.1 + 0.7 * d) * coreSpeed(d);         // rad/s (hand sweep); ramps hard past ch6
      const tol = clamp(0.26 - 0.12 * d, 0.10, 0.26) * coreTol(d);       // hit tolerance in radians (deep-tightened)
      const target = r.u() * Math.PI * 2, start = r.u() * Math.PI * 2;
      return { data: { speed, start }, pixels: { target, tol }, secret: { target, tol, speed, start } };
    },
    grade(b, lvl, ev) { const st = (ev || []).find(e => e && e.type === 'stop'); if (!st) return 0; const a = (b.secret.start + b.secret.speed * ((st.t || 0) / 1000)) % (Math.PI * 2); const err = Math.abs(((a - b.secret.target + Math.PI * 3) % (Math.PI * 2)) - Math.PI); return err <= b.secret.tol ? clamp(1 - err / b.secret.tol, 0, 1) : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.92 - 0.16 * d, 0.45, 0.92), kind: 'single' }; }
  },

  // ── WIRECUT (server-authoritative timing, FUN): a spark burns along the fuse; CUT when it crosses the safe zone.
  //    The safe-zone position is a TRANSPARENT server overlay (pixels-only); client renders the fuse/spark; graded by cut TIME.
  wirecut: {
    family: 'timing', label: 'Cut the Wire',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'wirecut', lvl)), d = dOf(lvl);
      const travelMs = Math.round(clamp(2300 - 1100 * d, 950, 2300));   // spark crossing time (faster deep, floored)
      const hw = clamp(0.15 - 0.07 * d, 0.06, 0.15);                    // safe-zone half-width (VISIBLE, floored)
      const c = 0.22 + r.u() * 0.56;                                    // safe-zone centre (the answer)
      return { data: { travelMs }, pixels: { c, hw }, secret: { c, hw, travelMs } };
    },
    grade(b, lvl, ev) { const cut = (ev || []).find(e => e && e.type === 'cut'); if (!cut) return 0; const f = (cut.t || 0) / b.secret.travelMs; const err = Math.abs(f - b.secret.c); return (f <= 1.05 && err <= b.secret.hw) ? clamp(1 - err / b.secret.hw, 0, 1) : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.2 * d, 0.4, 0.9), kind: 'single' }; }
  },

  // ── BEAM (server-authoritative timing, FUN): a marker sweeps a bar; TAP when it crosses the safe GAP. The gap
  //    position is pixels-only (rendered), the motion is client-side, and grading uses the tap TIME mapped through
  //    the known sweep -> a JSON bot knows the speed but not where the gap is, so it can't time the tap. Old-school fun.
  beam: {
    family: 'timing', label: 'Beat the Beam',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'beam', lvl)), d = dOf(lvl);
      const rounds = Math.round(2 + 2 * d);                 // 2..4 rounds
      const speed = 0.85 + 0.6 * d;                         // sweeps/sec (marker 0->1->0)
      const w = clamp(0.20 - 0.10 * d, 0.09, 0.20);         // safe-gap half-width (VISIBLE; floored so it's always hittable)
      const gaps = []; for (let i = 0; i < rounds; i++) gaps.push(0.15 + r.u() * 0.70);
      return { data: { rounds, speed, w }, pixels: { gaps, w }, secret: { gaps, w, speed } };
    },
    grade(b, lvl, ev) {
      const taps = (ev || []).filter(e => e && e.type === 'tap'); if (taps.length < b.secret.gaps.length) return 0;
      const tri = (x) => { const p = ((x % 2) + 2) % 2; return p < 1 ? p : 2 - p; };
      let s = 0; for (let i = 0; i < b.secret.gaps.length; i++) { const pos = tri(b.secret.speed * ((taps[i].t || 0) / 1000)); const err = Math.abs(pos - b.secret.gaps[i]); s += err <= b.secret.w ? clamp(1 - err / b.secret.w, 0, 1) : 0; }
      return s / b.secret.gaps.length;
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.18 * d, 0.4, 0.9), N: Math.round(2 + 2 * d), kind: 'round' }; }
  },

  rhythm: {
    family: 'rhythm', label: 'Rhythm Lock',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'rhythm', lvl)), d = dOf(lvl);
      const beats = Math.round(4 + 3 * d);                   // 4..7 beats (more intervals => random guessing fails)
      const iv = []; for (let i = 0; i < beats - 1; i++) iv.push(300 + Math.round(r.u() * 500));   // 300..800ms gaps
      const tol = clamp(0.19 - 0.11 * d, 0.07, 0.19);        // allowed mean relative interval error
      return { data: { beats, tol }, pixels: { iv }, secret: { iv, tol } };
    },
    grade(b, lvl, ev) {
      const taps = (ev || []).filter(e => e && e.type === 'beat').map(e => e.t).sort((a, x) => a - x);
      if (taps.length < b.secret.iv.length + 1) return 0;
      const piv = []; for (let i = 1; i <= b.secret.iv.length; i++) piv.push(taps[i] - taps[i - 1]);
      const norm = (a) => { const s = a.reduce((x, y) => x + y, 0) || 1; return a.map(x => x / s); };
      const P = norm(piv), S = norm(b.secret.iv);
      let e = 0; for (let i = 0; i < S.length; i++) e += Math.abs(P[i] - S[i]);       // total normalized deviation
      const rel = e / S.length;
      return clamp(1 - rel / b.secret.tol, 0, 1);
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.92 - 0.18 * d, 0.4, 0.92), N: Math.round(3 + 3 * d), kind: 'round' }; }
  },

  // ── HOTWIRE (timing): a spark runs an electric wire; cut it in the hidden safe gap. Same contract as wirecut.
  hotwire: {
    family: 'timing', label: 'Hotwire',
    build(seed, lvl) { const r = rng(seedMat(seed, 'hotwire', lvl)), d = dOf(lvl); const travelMs = Math.round(clamp(2200 - 1050 * d, 900, 2200)); const hw = clamp(0.15 - 0.07 * d, 0.06, 0.15); const c = 0.22 + r.u() * 0.56; return { data: { travelMs }, pixels: { c, hw }, secret: { c, hw, travelMs } }; },
    grade(b, lvl, ev) { const cut = (ev || []).find(e => e && e.type === 'cut'); if (!cut) return 0; const f = (cut.t || 0) / b.secret.travelMs; const err = Math.abs(f - b.secret.c); return (f <= 1.05 && err <= b.secret.hw) ? clamp(1 - err / b.secret.hw, 0, 1) : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.2 * d, 0.4, 0.9), kind: 'single' }; }
  },
  // ── SONIC CRACK (timing): a playhead ping-pongs a waveform; tap each hidden peak. Same contract as beam.
  sonicrack: {
    family: 'timing', label: 'Sonic Crack',
    build(seed, lvl) { const r = rng(seedMat(seed, 'sonicrack', lvl)), d = dOf(lvl); const rounds = Math.round(2 + 2 * d); const speed = 0.9 + 0.6 * d; const w = clamp(0.16 - 0.08 * d, 0.07, 0.16); const gaps = []; for (let i = 0; i < rounds; i++) gaps.push(0.15 + r.u() * 0.70); return { data: { rounds, speed, w }, pixels: { gaps, w }, secret: { gaps, w, speed } }; },
    grade(b, lvl, ev) { const taps = (ev || []).filter(e => e && e.type === 'tap'); if (taps.length < b.secret.gaps.length) return 0; const tri = (x) => { const p = ((x % 2) + 2) % 2; return p < 1 ? p : 2 - p; }; let s = 0; for (let i = 0; i < b.secret.gaps.length; i++) { const pos = tri(b.secret.speed * ((taps[i].t || 0) / 1000)); const err = Math.abs(pos - b.secret.gaps[i]); s += err <= b.secret.w ? clamp(1 - err / b.secret.w, 0, 1) : 0; } return s / b.secret.gaps.length; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.88 - 0.18 * d, 0.4, 0.88), N: Math.round(2 + 2 * d), kind: 'round' }; }
  },
  // ── COMBO DIAL (timing): multi-notch dial, direction flips each round; lock the sweep on each hidden notch.
  dialcombo: {
    family: 'timing', label: 'Combo Dial',
    build(seed, lvl) { const r = rng(seedMat(seed, 'dialcombo', lvl)), d = dOf(lvl); const rounds = Math.round(2 + 2 * d); const speed = (1.0 + 0.6 * d) * coreSpeed(d); const tol = clamp(0.30 - 0.14 * d, 0.11, 0.30) * coreTol(d); const targets = [], starts = []; for (let i = 0; i < rounds; i++) { targets.push(r.u() * Math.PI * 2); starts.push(r.u() * Math.PI * 2); } return { data: { rounds, speed, starts }, pixels: { targets, tol }, secret: { targets, tol, speed, starts } }; },
    grade(b, lvl, ev) { const locks = (ev || []).filter(e => e && e.type === 'lock'); if (locks.length < b.secret.targets.length) return 0; let s = 0; for (let i = 0; i < b.secret.targets.length; i++) { const dir = i % 2 === 0 ? 1 : -1; const a = ((b.secret.starts[i] + dir * b.secret.speed * ((locks[i].t || 0) / 1000)) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2); const err = Math.abs(((a - b.secret.targets[i] + Math.PI * 3) % (Math.PI * 2)) - Math.PI); s += err <= b.secret.tol ? clamp(1 - err / b.secret.tol, 0, 1) : 0; } return s / b.secret.targets.length; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.86 - 0.18 * d, 0.4, 0.86), N: Math.round(2 + 2 * d), kind: 'round' }; }
  },
  // ── TUMBLER DROP (timing): a pin cycles up/down; tap when it aligns with the hidden shear line. Same contract as torque.
  tumbler: {
    family: 'timing', label: 'Tumbler Drop',
    build(seed, lvl) { const r = rng(seedMat(seed, 'tumbler', lvl)), d = dOf(lvl); const speed = (0.8 + 0.5 * d) * coreSpeed(d); const hw = clamp(0.13 - 0.06 * d, 0.07, 0.13) * coreTol(d); const c = 0.25 + r.u() * 0.5; return { data: { speed }, pixels: { c, hw }, secret: { c, hw, speed } }; },   // data-min (audit): hw server-side only
    grade(b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const ph = ((b.secret.speed * ((tap.t || 0) / 1000)) % 2 + 2) % 2, pos = ph < 1 ? ph : 2 - ph; const err = Math.abs(pos - b.secret.c); return err <= b.secret.hw ? clamp(1 - err / b.secret.hw, 0, 1) : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.19 * d, 0.4, 0.9), kind: 'single' }; }
  },
  // ── PRESSURE PLATES (perception): tap the green plates, never the red. Which plates are green lives in the overlay pixels.
  pressureplates: {
    family: 'perception', label: 'Pressure Plates',
    build(seed, lvl) { const r = rng(seedMat(seed, 'pressureplates', lvl)), d = dOf(lvl); const cols = 3, rows = 3, n = cols * rows; const greens = Math.max(2, Math.round(3 + 2 * d)); const span = Math.round(clamp(4200 - 1600 * d, 2200, 4200)); const idx = []; for (let i = 0; i < n; i++) idx.push(i); const green = r.sample(idx, greens); const isGreen = idx.map(i => green.includes(i)); return { data: { cols, rows, greens, span }, pixels: { isGreen }, secret: { isGreen, greens } }; },
    grade(b, lvl, ev) { const taps = (ev || []).filter(e => e && e.type === 'plate'); let good = 0, bad = 0; const seen = new Set(); for (const t of taps) { if (seen.has(t.idx)) continue; seen.add(t.idx); if (b.secret.isGreen[t.idx]) good++; else bad++; } return clamp((good - bad) / b.secret.greens, 0, 1); },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.95 - 0.12 * d, 0.5, 0.95), N: Math.max(2, Math.round(3 + 2 * d)), kind: 'round' }; }
  },
  // ── TRIP THE WIRE (reaction): wait for green, then tap. No spatial answer to hide — bot-gated by reaction time (rt<90ms rejected).
  reflex: {
    family: 'timing', label: 'Trip the Wire',
    build(seed, lvl) { const r = rng(seedMat(seed, 'reflex', lvl)), d = dOf(lvl); const greenAt = Math.round(700 + r.u() * 1700); const window = Math.round(clamp(640 - 240 * d, 340, 640)); return { data: { greenAt }, pixels: {}, secret: { greenAt, window } }; },
    grade(b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const rt = (tap.t || 0) - b.secret.greenAt; if (rt < 0) return 0; if (rt < 90) return 0; return rt <= b.secret.window ? clamp(1 - rt / b.secret.window, 0, 1) : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.15 * d, 0.5, 0.9), kind: 'single' }; }
  },
  // ── FORCE THE DOOR (mash): hammer to force it before time. Bot-gated by inhuman cadence (>~18 taps/sec sustained).
  mash: {
    family: 'timing', label: 'Force the Door',
    build(seed, lvl) { const d = dOf(lvl); const need = Math.round(12 + 10 * d); const win = Math.round(clamp(3200 - 800 * d, 2200, 3200)); return { data: { need, win }, pixels: {}, secret: { need, win } }; },
    grade(b, lvl, ev) { const within = (ev || []).filter(e => e && e.type === 'tap' && (e.t || 0) <= b.secret.win); let fast = 0; for (let i = 1; i < within.length; i++) { if (((within[i].t || 0) - (within[i - 1].t || 0)) < 55) fast++; } if (within.length > 4 && fast > within.length * 0.5) return 0; return clamp(within.length / b.secret.need, 0, 1); },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.92 - 0.12 * d, 0.5, 0.92), kind: 'single' }; }
  },
  // ── SILENT ALARM (reaction): tap the instant it turns green — never on red. Bot-gated by reaction time.
  silentalarm: {
    family: 'timing', label: 'Silent Alarm',
    build(seed, lvl) { const r = rng(seedMat(seed, 'silentalarm', lvl)), d = dOf(lvl); const greenAt = Math.round(800 + r.u() * 1900); const window = Math.round(clamp(720 - 280 * d, 340, 720)); return { data: { greenAt }, pixels: {}, secret: { greenAt, window } }; },
    grade(b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const rt = (tap.t || 0) - b.secret.greenAt; if (rt < 0) return 0; if (rt < 90) return 0; return rt <= b.secret.window ? clamp(1 - rt / b.secret.window, 0, 1) : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.15 * d, 0.5, 0.9), kind: 'single' }; }
  },

  // ── LUCK "fate" family: ungraded. The mini is pure theatre; the real outcome is the provably-fair advance roll at
  //    /api/crack (scoreEvents/grade return null). These exist only so luck runs on the SAME v4 shell + transport as the
  //    rest. Presenters must stay OUTCOME-AGNOSTIC (never claim HEADS/win) so the canvas can't contradict the real roll.
  coinflip: {
    family: 'fate', label: 'Coin Toss',
    build(seed, lvl) { return { data: {}, pixels: {}, secret: {} }; },
    grade(b, lvl, ev) { return null; },
    humanP(lvl) { return { p: 1, kind: 'fate' }; }
  },
  // ---- MEMORY category (new, deterministic, seed-not-answer). The pattern lives in server frames/secret; the client
  // only gets counts + timing. Graded prefix / set match, gated by MEMORY_BAR (its own rising curve). ----
  // Backward Span: watch a glyph sequence, tap it back in REVERSE (working-memory manipulation).
  reverse: {
    family: 'memory', label: 'Backward Span',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'reverse', lvl)), d = dOf(lvl);
      const M = Math.min(9, Math.round(3 + 6 * d)), palette = 10;   // deep-hardened span
      const seq = []; for (let i = 0; i < M; i++) seq.push(r.int(palette));
      const flashMs = Math.round(clamp(950 - 680 * d, 220, 950));
      return { data: { count: M, palette, flashMs, reverse: true }, pixels: { seq }, secret: { seq } };
    },
    grade(b, lvl, ev) {
      const picks = (ev || []).filter(e => e && e.type === 'pick').map(e => e.idx);
      const rev = b.secret.seq.slice().reverse();
      let c = 0; for (let i = 0; i < rev.length; i++) { if (picks[i] === rev[i]) c++; else break; }
      return c / rev.length;
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.86 - 0.34 * d, 0.28, 0.86), M: Math.round(3 + 4 * d), kind: 'span' }; }
  },
  // Simon Says: four colour pads light in sequence — reproduce the order (classic sequence recall).
  simon: {
    family: 'memory', label: 'Simon Says',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'simon', lvl)), d = dOf(lvl);
      const M = Math.min(10, Math.round(3 + 7 * d));   // deep-hardened span
      const seq = []; for (let i = 0; i < M; i++) seq.push(r.int(4));
      const flashMs = Math.round(clamp(680 - 440 * d, 200, 680));
      return { data: { count: M, flashMs }, pixels: { seq }, secret: { seq } };
    },
    grade(b, lvl, ev) {
      const picks = (ev || []).filter(e => e && e.type === 'pad').map(e => e.pad);
      let c = 0; for (let i = 0; i < b.secret.seq.length; i++) { if (picks[i] === b.secret.seq[i]) c++; else break; }
      return c / b.secret.seq.length;
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.3 * d, 0.3, 0.9), M: Math.round(3 + 5 * d), kind: 'span' }; }
  },
  // Grid Recall: a SET of cells flashes at once — reproduce which cells lit (unordered spatial working memory).
  gridrecall: {
    family: 'memory', label: 'Grid Recall',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'gridrecall', lvl)), d = dOf(lvl);
      const grid = d < 0.4 ? 9 : (d < 0.7 ? 16 : 25);        // 3x3 -> 4x4 -> 5x5 (deep-hardened)
      const M = Math.min(grid - 1, Math.round(3 + 8 * d));   // set size 3..11
      const set = []; while (set.length < M) { const c = r.int(grid); if (set.indexOf(c) < 0) set.push(c); }
      const flashMs = Math.round(clamp(1300 - 1000 * d, 300, 1300));
      return { data: { grid, count: M, flashMs }, pixels: { cells: set }, secret: { cells: set } };
    },
    grade(b, lvl, ev) {
      const picks = Array.from(new Set((ev || []).filter(e => e && e.type === 'cell').map(e => e.cell)));
      const set = new Set(b.secret.cells); let good = 0, bad = 0;
      for (const p of picks) { if (set.has(p)) good++; else bad++; }
      return clamp((good - bad) / b.secret.cells.length, 0, 1);
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.34 * d, 0.28, 0.9), M: Math.round(3 + 4 * d), kind: 'span' }; }
  },
  // Match-Up (concentration): memorise a face-up board of paired shapes, then for each prompt shape find its hidden twin.
  pairs: {
    family: 'memory', label: 'Match-Up',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'pairs', lvl)), d = dOf(lvl);
      const P = Math.min(8, Math.round(3 + 5 * d)), cells = P * 2;   // deep-hardened (more pairs to hold)
      const slots = []; for (let s = 0; s < P; s++) { slots.push(s); slots.push(s); }
      for (let i = slots.length - 1; i > 0; i--) { const j = r.int(i + 1); const t = slots[i]; slots[i] = slots[j]; slots[j] = t; }
      const cellOf = {}; slots.forEach((s, idx) => { (cellOf[s] = cellOf[s] || []).push(idx); });
      const rounds = Math.min(P, Math.round(2 + 4 * d)); const order = []; for (let s = 0; s < P; s++) order.push(s);
      for (let i = order.length - 1; i > 0; i--) { const j = r.int(i + 1); const t = order[i]; order[i] = order[j]; order[j] = t; }
      const queries = order.slice(0, rounds).map(s => ({ sym: s, prompt: cellOf[s][0], answer: cellOf[s][1] }));
      const flashMs = Math.round(clamp(1700 - 1100 * d, 450, 1700));
      return { data: { cells, pairs: P, rounds, flashMs }, pixels: { layout: slots, queries }, secret: { layout: slots, queries } };
    },
    grade(b, lvl, ev) {
      const picks = (ev || []).filter(e => e && e.type === 'match'); const qs = b.secret.queries; let good = 0;
      for (let i = 0; i < qs.length; i++) { if (picks[i] && picks[i].cell === qs[i].answer) good++; }
      return good / qs.length;
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.85 - 0.35 * d, 0.24, 0.85), kind: 'pairs' }; }
  },
  // N-Back: a stream of shapes; tap MATCH whenever the current shape equals the one N steps back (working memory + updating).
  nback: {
    family: 'memory', label: 'N-Back',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'nback', lvl)), d = dOf(lvl);
      const N = d < 0.45 ? 1 : (d < 0.8 ? 2 : 3), len = Math.round(8 + 8 * d), palette = Math.max(4, 6 - N);
      const seq = []; for (let i = 0; i < len; i++) seq.push(r.int(palette));
      // deterministically PLANT a guaranteed set of match positions (min 2) so the game is always scorable; then break the rest.
      const elig = []; for (let i = N; i < len; i++) elig.push(i);
      for (let i = elig.length - 1; i > 0; i--) { const j = r.int(i + 1); const t = elig[i]; elig[i] = elig[j]; elig[j] = t; }
      const want = Math.max(2, Math.round(elig.length * 0.32)), planted = new Set(elig.slice(0, want));
      for (let i = N; i < len; i++) { if (planted.has(i)) seq[i] = seq[i - N]; else if (seq[i] === seq[i - N]) seq[i] = (seq[i] + 1) % palette; }
      const matches = []; for (let i = N; i < len; i++) if (seq[i] === seq[i - N]) matches.push(i);
      const stepMs = Math.round(clamp(1500 - 650 * d, 650, 1500));
      return { data: { N, len, stepMs, palette }, pixels: { seq }, secret: { seq, matches, N } };
    },
    grade(b, lvl, ev) {
      const N = b.secret.N, len = b.secret.seq.length, tapped = new Set((ev || []).filter(e => e && e.type === 'nback' && e.hit).map(e => e.pos));
      const mset = new Set(b.secret.matches); let hits = 0, fa = 0;
      for (let i = N; i < len; i++) { if (tapped.has(i)) { if (mset.has(i)) hits++; else fa++; } }
      return clamp((hits - fa) / (b.secret.matches.length || 1), 0, 1);
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.85 - 0.42 * d, 0.18, 0.85), kind: 'nback' }; }
  },
  // Tally (enumeration memory): gems and bombs flash by fast; count the gems, then key in the total.
  countflash: {
    family: 'memory', label: 'Tally',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'countflash', lvl)), d = dOf(lvl);
      const len = Math.round(6 + 10 * d); const seq = []; let cnt = 0;
      for (let i = 0; i < len; i++) { const gem = r.u() < 0.5; seq.push(gem ? 1 : 0); if (gem) cnt++; }
      const flashMs = Math.round(clamp(560 - 360 * d, 180, 560));
      return { data: { len, flashMs, max: len }, pixels: { seq }, secret: { seq, count: cnt } };
    },
    grade(b, lvl, ev) {
      const a = (ev || []).find(e => e && e.type === 'answer'); if (!a) return 0;
      const diff = Math.abs((a.value | 0) - b.secret.count); if (diff === 0) return 1; if (diff === 1) return 0.4; return 0;
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.85 - 0.4 * d, 0.2, 0.85), kind: 'count' }; }
  },
  // Spot the Change (change detection): study a vault of shapes, it flickers, one shape changes — tap the cell that changed.
  whatchanged: {
    family: 'memory', label: 'Spot the Change',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'whatchanged', lvl)), d = dOf(lvl);
      const grid = d < 0.5 ? 9 : 16, sceneA = []; for (let c = 0; c < grid; c++) sceneA.push(r.int(10));
      const changed = r.int(grid); let ns = r.int(10); if (ns === sceneA[changed]) ns = (ns + 1) % 10;
      const sceneB = sceneA.slice(); sceneB[changed] = ns;
      const flashMs = Math.round(clamp(1400 - 650 * d, 600, 1400));
      return { data: { grid, flashMs }, pixels: { sceneA, sceneB }, secret: { changed, sceneA, sceneB } };
    },
    grade(b, lvl, ev) { const p = (ev || []).find(e => e && e.type === 'cell'); return (p && p.cell === b.secret.changed) ? 1 : 0; },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.4 * d, 0.2, 0.9), kind: 'change' }; }
  },
  // Heist Route (spatial-order path): a route lights up cell by cell across the floorplan; retrace it in order.
  journey: {
    family: 'memory', label: 'Heist Route',
    build(seed, lvl) {
      const r = rng(seedMat(seed, 'journey', lvl)), d = dOf(lvl), grid = 16;
      const len = Math.min(12, Math.round(3 + 8 * d)), cells = []; while (cells.length < len) { const c = r.int(grid); if (cells.indexOf(c) < 0) cells.push(c); }   // deep-hardened route length
      const flashMs = Math.round(clamp(700 - 480 * d, 200, 700));
      return { data: { grid, count: len, flashMs }, pixels: { cells }, secret: { cells } };
    },
    grade(b, lvl, ev) {
      const picks = (ev || []).filter(e => e && (e.type === 'cell' || e.type === 'pick')).map(e => (e.cell != null ? e.cell : e.idx));
      let cc = 0; for (let i = 0; i < b.secret.cells.length; i++) { if (picks[i] === b.secret.cells[i]) cc++; else break; }
      return cc / b.secret.cells.length;
    },
    humanP(lvl) { const d = dOf(lvl); return { p: clamp(0.85 - 0.35 * d, 0.22, 0.85), kind: 'route' }; }
  }
};

// The rest of LUCK: all ungraded 'fate' entries so luck runs on the SAME v4 shell + transport as skill. Pure theatre;
// the real outcome is the provably-fair advance roll at /api/crack (grade returns null). Presenters stay outcome-agnostic.
['wheel', 'dice', 'cardflip', 'slots', 'roulette', 'shells', 'scratch', 'plinko', 'keno', 'goldbar', 'magnetgrab', 'fuserace', 'elevatorroulette', 'safedial'].forEach(function (k) {
  if (!GAMES[k]) GAMES[k] = { family: 'fate', label: k, build: function () { return { data: {}, pixels: {}, secret: {} }; }, grade: function () { return null; }, humanP: function () { return { p: 1, kind: 'fate' }; } };
});

// ── SKILL V3 (Jake 2026-09-11): 15 BRAND-NEW mechanics replacing the old dial/torque/etc. the adversary's agent is trained on.
//    Client-drawn, answer-free data (motion params only), hidden per-depth TOLERANCE in secret (continuous-collapse => deep-safe).
//    Skill can't hide its target (you must see it), so bot-resistance = novelty (new solvers needed) + humanness/rate-limit layers.
// ── SKILL V3 Batch 1: precision timing/position (Wrecking Ball / Satellite Lock / Rail Brake / Shockwave) ──
(function () {
  const skHumanP = function (lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.45 * d, 0.05, 0.9), kind: 'single' }; };
  GAMES.pendulum = {
    family: 'skill', label: 'Wrecking Ball',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'pendulum', lvl)), d = dOf(lvl); const omega = +(0.0040 * (1 + 1.35 * d)).toFixed(6); const tol = Math.round(260 - 150 * d); return { data: { mode: 'skpend', omega: omega, dur: 6000, skin: { label: 'Wrecking Ball' } }, secret: { tol: tol, omega: omega } }; },
    grade: function (b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const t = tap.t || 0; if (t < 250) return 0; const om = b.secret.omega, p = om * t, k = Math.round((p - Math.PI / 2) / Math.PI), tb = (Math.PI / 2 + k * Math.PI) / om; return clamp(1 - Math.abs(t - tb) / b.secret.tol, 0, 1); },
    humanP: skHumanP
  };
  GAMES.orbit = {
    family: 'skill', label: 'Satellite Lock',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'orbit', lvl)), d = dOf(lvl); const omega = +(0.0034 * (1 + 1.4 * d)).toFixed(6); const tol = Math.round(255 - 148 * d); return { data: { mode: 'skorbit', omega: omega, dur: 6000, skin: { label: 'Satellite Lock' } }, secret: { tol: tol, omega: omega } }; },
    grade: function (b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const t = tap.t || 0; if (t < 250) return 0; const om = b.secret.omega, TAU2 = Math.PI * 2, tgt = 3 * Math.PI / 2, k = Math.round((om * t - tgt) / TAU2), tt = (tgt + k * TAU2) / om; return clamp(1 - Math.abs(t - tt) / b.secret.tol, 0, 1); },
    humanP: skHumanP
  };
  GAMES.slider = {
    family: 'skill', label: 'Rail Brake',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'slider', lvl)), d = dOf(lvl); const omega = +(0.0036 * (1 + 1.2 * d)).toFixed(6); const tolPos = +(0.31 - 0.19 * d).toFixed(4); return { data: { mode: 'skslider', omega: omega, dur: 6000, skin: { label: 'Rail Brake' } }, secret: { tolPos: tolPos, omega: omega } }; },
    grade: function (b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const t = tap.t || 0; if (t < 250) return 0; const pos = Math.abs(Math.sin(b.secret.omega * t)); return clamp(1 - pos / b.secret.tolPos, 0, 1); },
    humanP: skHumanP
  };
  GAMES.pulse = {
    family: 'skill', label: 'Shockwave',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'pulse', lvl)), d = dOf(lvl); const cycle = Math.round(1500 - 650 * d); const rT = +(0.55 + r.u() * 0.35).toFixed(3); const tolR = +(0.22 - 0.125 * d).toFixed(4); return { data: { mode: 'skpulse', cycle: cycle, dur: 6000, skin: { label: 'Shockwave' } }, pixels: { rT: rT }, secret: { tolR: tolR, cycle: cycle, rT: rT } }; },
    grade: function (b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const t = tap.t || 0; if (t < 200) return 0; const rr = (t % b.secret.cycle) / b.secret.cycle; return clamp(1 - Math.abs(rr - b.secret.rT) / b.secret.tolR, 0, 1); },
    humanP: skHumanP
  };
})();
// ── SKILL V3 Batch 2: aim / momentum / multi-stage (Sniper Window / Safe Dial / Triple Tumbler / Triple Align) ──
(function () {
  const skHumanP = function (lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.45 * d, 0.05, 0.9), kind: 'single' }; };
  const TAU2 = Math.PI * 2;
  const angDist = (a, b2) => { const x = ((a - b2) % TAU2 + TAU2) % TAU2; return Math.min(x, TAU2 - x); };
  GAMES.crosshair = {
    family: 'skill', label: 'Sniper Window',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'crosshair', lvl)), d = dOf(lvl); const omx = +(0.0026 * (1 + 1.2 * d)).toFixed(6), omy = +(2 * omx).toFixed(6); const tol = +(0.27 - 0.155 * d).toFixed(4); return { data: { mode: 'skaim', omx: omx, omy: omy, dur: 6000, skin: { label: 'Sniper Window' } }, secret: { tol: tol, omx: omx, omy: omy } }; },
    grade: function (b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const t = tap.t || 0; if (t < 250) return 0; const err = Math.hypot(Math.sin(b.secret.omx * t), Math.sin(b.secret.omy * t)); return clamp(1 - err / b.secret.tol, 0, 1); },
    humanP: skHumanP
  };
  GAMES.dial = {
    family: 'skill', label: 'Safe Dial',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'dial', lvl)), d = dOf(lvl); const v0 = +(0.011 * (1 + 0.9 * d)).toFixed(6); const a = +(v0 / (2600 - 900 * d)).toFixed(9); const notch = +(r.u() * TAU2).toFixed(4); const tol = +(0.52 - 0.33 * d).toFixed(4); return { data: { mode: 'skdial', v0: v0, a: a, dur: 6000, skin: { label: 'Safe Dial' } }, pixels: { notch: notch }, secret: { tol: tol, v0: v0, a: a, notch: notch } }; },
    grade: function (b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; let t = tap.t || 0; if (t < 250) return 0; const tStop = b.secret.v0 / b.secret.a; if (t > tStop) t = tStop; const th = b.secret.v0 * t - 0.5 * b.secret.a * t * t; return clamp(1 - angDist(th, b.secret.notch) / b.secret.tol, 0, 1); },
    humanP: skHumanP
  };
  GAMES.dialcombo = {
    family: 'skill', label: 'Triple Tumbler',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'dialcombo', lvl)), d = dOf(lvl); const pins = []; for (let i = 0; i < 3; i++) pins.push({ om: +(0.0044 * (1 + 1.1 * d) * (0.85 + i * 0.18)).toFixed(6) }); const tol = Math.round(270 - 150 * d); return { data: { mode: 'sktriple', pins: pins, dur: 8000, skin: { label: 'Triple Tumbler' } }, secret: { tol: tol, pins: pins } }; },
    grade: function (b, lvl, ev) { const taps = (ev || []).filter(e => e && e.type === 'tap'); if (taps.length < 3) return 0; let sum = 0; for (let i = 0; i < 3; i++) { const om = b.secret.pins[i].om, t = taps[i].t || 0; const k = Math.round((om * t - Math.PI / 2) / Math.PI), tb = (Math.PI / 2 + k * Math.PI) / om; sum += clamp(1 - Math.abs(t - tb) / b.secret.tol, 0, 1); } return clamp(sum / 3, 0, 1); },
    humanP: skHumanP
  };
  GAMES.align3 = {
    family: 'skill', label: 'Triple Align',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'align3', lvl)), d = dOf(lvl); const tAlign = 2200 + r.u() * 3500; const arcs = []; for (let i = 0; i < 3; i++) { const om = +(0.0022 * (1 + 1.0 * d) * (1 + i * 0.55)).toFixed(6); arcs.push({ om: om, ph: +((((3 * Math.PI / 2) - om * tAlign) % TAU2 + TAU2) % TAU2).toFixed(4) }); } const tol = +(0.42 - 0.255 * d).toFixed(4); return { data: { mode: 'skalign', arcs: arcs, dur: 9000, skin: { label: 'Triple Align' } }, secret: { tol: tol, arcs: arcs } }; },
    grade: function (b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === 'tap'); if (!tap) return 0; const t = tap.t || 0; if (t < 250) return 0; const top = 3 * Math.PI / 2; let worst = 0; for (const arc of b.secret.arcs) { const e2 = angDist(arc.om * t + arc.ph, top); if (e2 > worst) worst = e2; } return clamp(1 - worst / b.secret.tol, 0, 1); },
    humanP: skHumanP
  };
})();

// what the browser is allowed to receive: DATA ONLY. pixels+secret never ship as parseable fields.
function renderSafe(gameKey, built) { return { gameKey, data: built.data }; }

// ── SKILL V3 Batch 3: hold / align / stop (Torque Wrench / Shear Line / Detonator Timer) ──
(function () {
  const skHumanP = function (lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.45 * d, 0.05, 0.9), kind: "single" }; };
  GAMES.torque = {
    family: "skill", label: "Torque Wrench",
    build: function (seed, lvl) { const r = rng(seedMat(seed, "torque", lvl)), d = dOf(lvl); const rate = +(0.55 + 0.35 * d).toFixed(4); const target = +(0.45 + r.u() * 0.35).toFixed(3); const tol = +(0.24 - 0.14 * d).toFixed(4); return { data: { mode: "sktorque", rate: rate, dur: 6000, skin: { label: "Torque Wrench" } }, pixels: { target: target }, secret: { tol: tol, rate: rate, target: target } }; },
    grade: function (b, lvl, ev) { const dn = (ev || []).find(e => e && e.type === "down"); const up = (ev || []).find(e => e && e.type === "up"); if (!dn || !up) return 0; const hold = (up.t || 0) - (dn.t || 0); if (hold <= 0) return 0; const v = clamp(b.secret.rate * hold / 1000, 0, 1.2); return clamp(1 - Math.abs(v - b.secret.target) / b.secret.tol, 0, 1); },
    humanP: skHumanP
  };
  GAMES.tumbler = {
    family: "skill", label: "Shear Line",
    build: function (seed, lvl) { const r = rng(seedMat(seed, "tumbler", lvl)), d = dOf(lvl); const omega = +(0.0034 * (1 + 1.3 * d)).toFixed(6); const shear = +(0.30 + r.u() * 0.40).toFixed(3); const tol = +(0.23 - 0.135 * d).toFixed(4); return { data: { mode: "skshear", omega: omega, dur: 6000, skin: { label: "Shear Line" } }, pixels: { shear: shear }, secret: { tol: tol, omega: omega, shear: shear } }; },
    grade: function (b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === "tap"); if (!tap) return 0; const t = tap.t || 0; if (t < 250) return 0; const pos = 0.5 + 0.5 * Math.sin(b.secret.omega * t); return clamp(1 - Math.abs(pos - b.secret.shear) / b.secret.tol, 0, 1); },
    humanP: skHumanP
  };
  GAMES.stopwatch = {
    family: "skill", label: "Detonator Timer",
    build: function (seed, lvl) { const r = rng(seedMat(seed, "stopwatch", lvl)), d = dOf(lvl); const period = Math.round(1500 - 650 * d); const mark = +(0.55 + r.u() * 0.35).toFixed(3); const tol = +(0.20 - 0.11 * d).toFixed(4); return { data: { mode: "sktimer", period: period, dur: 6000, skin: { label: "Detonator Timer" } }, pixels: { mark: mark }, secret: { tol: tol, period: period, mark: mark } }; },
    grade: function (b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === "tap"); if (!tap) return 0; const t = tap.t || 0; if (t < 150) return 0; const pos = (t % b.secret.period) / b.secret.period; return clamp(1 - Math.abs(pos - b.secret.mark) / b.secret.tol, 0, 1); },
    humanP: skHumanP
  };
})();
// ── SKILL V3 Batch 4 (shallow): reaction / dexterity / match / speed (Trip Beam / Steady Hand / Surge Match / Reflex Grid) ──
(function () {
  const skHumanP = function (lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.45 * d, 0.05, 0.9), kind: "single" }; };
  GAMES.beam = {
    family: "skill", label: "Trip Beam",
    build: function (seed, lvl) { const r = rng(seedMat(seed, "beam", lvl)), d = dOf(lvl); const oma = +(0.0030 * (1 + 1.2 * d)).toFixed(6), omb = +(0.0019 * (1 + 1.2 * d)).toFixed(6); const tol = +(0.22 - 0.125 * d).toFixed(4); return { data: { mode: "skbeam", oma: oma, omb: omb, dur: 6000, skin: { label: "Trip Beam" } }, secret: { tol: tol, oma: oma, omb: omb } }; },
    grade: function (b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === "tap"); if (!tap) return 0; const t = tap.t || 0; if (t < 250) return 0; const ba = (1 + Math.sin(b.secret.oma * t)) / 2, gp = (1 + Math.sin(b.secret.omb * t)) / 2; return clamp(1 - Math.abs(ba - gp) / b.secret.tol, 0, 1); },
    humanP: skHumanP
  };
  GAMES.wirecut = {
    family: "skill", label: "Steady Hand",
    build: function (seed, lvl) { const r = rng(seedMat(seed, "wirecut", lvl)), d = dOf(lvl); const amp = +(0.18 + 0.14 * d).toFixed(3), fx = +(4 + 4 * d).toFixed(3); const tol = +(0.24 - 0.13 * d).toFixed(4); return { data: { mode: "skdrag", amp: amp, fx: fx, dur: 7000, skin: { label: "Steady Hand" } }, secret: { tol: tol, amp: amp, fx: fx } }; },
    grade: function (b, lvl, ev) { const pts = (ev || []).filter(e => e && e.type === "pt"); if (pts.length < 5) return 0; let xmin = 1, xmax = 0, maxDev = 0; for (const p of pts) { const x = clamp(p.x || 0, 0, 1), y = clamp(p.y || 0, 0, 1); if (x < xmin) xmin = x; if (x > xmax) xmax = x; const dev = Math.abs(y - (0.5 + b.secret.amp * Math.sin(b.secret.fx * x))); if (dev > maxDev) maxDev = dev; } if (xmax - xmin < 0.6) return 0; return clamp(1 - maxDev / b.secret.tol, 0, 1); },
    humanP: skHumanP
  };
  GAMES.voltage = {
    family: "skill", label: "Surge Match",
    build: function (seed, lvl) { const r = rng(seedMat(seed, "voltage", lvl)), d = dOf(lvl); const speed = +(0.45 + 0.4 * d).toFixed(4); const target = +(0.4 + r.u() * 0.4).toFixed(3); const tol = +(0.21 - 0.115 * d).toFixed(4); return { data: { mode: "skmatch", speed: speed, dur: 6000, skin: { label: "Surge Match" } }, pixels: { target: target }, secret: { tol: tol, speed: speed, target: target } }; },
    grade: function (b, lvl, ev) { const tap = (ev || []).find(e => e && e.type === "tap"); if (!tap) return 0; const t = tap.t || 0; if (t < 150) return 0; const bar = clamp(b.secret.speed * t / 1000, 0, 1); return clamp(1 - Math.abs(bar - b.secret.target) / b.secret.tol, 0, 1); },
    humanP: skHumanP
  };
  GAMES.keypad = {
    family: "skill", label: "Reflex Grid",
    build: function (seed, lvl) { const r = rng(seedMat(seed, "keypad", lvl)), d = dOf(lvl); const n = 4 + Math.round(2 * d); const winLen = Math.round(680 - 300 * d); const cells = []; let t = 500; for (let i = 0; i < n; i++) { cells.push({ x: +(0.15 + r.u() * 0.7).toFixed(3), y: +(0.2 + r.u() * 0.6).toFixed(3), s: Math.round(t), e: Math.round(t + winLen) }); t += winLen + 220; } return { data: { mode: "skgrid", cells: cells, n: n, dur: t + 500, skin: { label: "Reflex Grid" } }, secret: { cells: cells, n: n } }; },
    grade: function (b, lvl, ev) { const hits = (ev || []).filter(e => e && e.type === "hit"); let got = 0; for (let i = 0; i < b.secret.n; i++) { const c = b.secret.cells[i]; if (hits.some(hh => (hh.i | 0) === i && (hh.t || 0) >= c.s - 110 && (hh.t || 0) <= c.e + 110)) got++; } return clamp(got / b.secret.n, 0, 1); },
    humanP: skHumanP
  };
})();
// ── MEMORY V2 (Jake 2026-09-11): TRANSFORMATION games — capture != answer. Stimulus flashes (server frames); the graded answer is a transform (sort/shift), so a screenshot/recording is only the input to an in-head computation.
(function () {
  const _sc = GAMES.safecombo, _cl = GAMES.colorlock;
  GAMES.safecombo = {
    family: "memory", label: "Sorted Combo",
    build: function (seed, lvl) { const r = rng(seedMat(seed, "safecombo", lvl)), d = dOf(lvl); const M = Math.min(8, Math.round(3 + 5 * d)); const seq = []; for (let i = 0; i < M; i++) seq.push(r.int(10)); const flashMs = Math.round(clamp(900 - 680 * d, 200, 900)); const sorted = seq.slice().sort((a, b) => a - b); return { data: { count: M, palette: 10, flashMs, digits: true, transform: "sort" }, pixels: { seq }, secret: { seq, sorted } }; },
    grade: function (b, lvl, ev) { const picks = (ev || []).filter(e => e && e.type === "pick").map(e => e.idx); const ans = b.secret.sorted; let c = 0; for (let i = 0; i < ans.length; i++) { if (picks[i] === ans[i]) c++; else break; } return c / ans.length; },
    humanP: _sc.humanP
  };
  GAMES.colorlock = {
    family: "memory", label: "Shift Lock",
    build: function (seed, lvl) { const r = rng(seedMat(seed, "colorlock", lvl)), d = dOf(lvl); const palette = 6, M = Math.min(8, Math.round(3 + 5 * d)); const shift = 1 + r.int(Math.min(3, palette - 1)); const seq = []; for (let i = 0; i < M; i++) seq.push(r.int(palette)); const shifted = seq.map(c => (c + shift) % palette); const flashMs = Math.round(clamp(880 - 660 * d, 200, 880)); return { data: { count: M, palette, flashMs, shift: shift, transform: "shift" }, pixels: { seq }, secret: { seq, shift, shifted } }; },
    grade: function (b, lvl, ev) { const picks = (ev || []).filter(e => e && e.type === "pick").map(e => e.idx); const ans = b.secret.shifted; let c = 0; for (let i = 0; i < ans.length; i++) { if (picks[i] === ans[i]) c++; else break; } return c / ans.length; },
    humanP: _cl.humanP
  };
})();
// ── MEMORY V2 batch 2: Vault Weigh (denoms -> total value) + Dead Reckoning (bearing -> net direction). Transform: capture != answer.
(function () {
  const _md = GAMES.denoms, _mb = GAMES.bearing;
  GAMES.denoms = {
    family: "memory", label: "Vault Weigh",
    build: function (seed, lvl) { const r = rng(seedMat(seed, "denoms", lvl)), d = dOf(lvl); const opts = [5, 10, 25, 50, 100]; const M = Math.min(7, Math.round(3 + 4 * d)); const seq = []; let total = 0; for (let i = 0; i < M; i++) { const v = opts[r.int(opts.length)]; seq.push(v); total += v; } const flashMs = Math.round(clamp(950 - 700 * d, 220, 950)); return { data: { count: M, options: opts, flashMs, values: true, transform: "sum" }, pixels: { seq }, secret: { seq, total } }; },
    grade: function (b, lvl, ev) { const a = (ev || []).find(e => e && e.type === "answer"); return a && Number(a.value) === b.secret.total ? 1 : 0; },
    humanP: _md.humanP
  };
  GAMES.bearing = {
    family: "memory", label: "Dead Reckoning",
    build: function (seed, lvl) { const r = rng(seedMat(seed, "bearing", lvl)), d = dOf(lvl); const M = Math.min(9, Math.round(3 + 6 * d)); let seq, net, tries = 0; do { seq = []; let dx = 0, dy = 0; for (let i = 0; i < M; i++) { const a = r.int(4); seq.push(a); if (a === 0) dy -= 1; else if (a === 1) dx += 1; else if (a === 2) dy += 1; else dx -= 1; } if (Math.abs(dx) >= Math.abs(dy)) net = dx > 0 ? 1 : (dx < 0 ? 3 : -1); else net = dy < 0 ? 0 : 2; tries++; } while (net === -1 && tries < 40); if (net === -1) net = 1; const flashMs = Math.round(clamp(860 - 640 * d, 200, 860)); return { data: { count: M, palette: 4, flashMs, dirs: true, transform: "net" }, pixels: { seq }, secret: { seq, net } }; },
    grade: function (b, lvl, ev) { const p = (ev || []).find(e => e && e.type === "pick"); return p && p.idx === b.secret.net ? 1 : 0; },
    humanP: _mb.humanP
  };
})();
// ── PERCEPTION (Jake 2026-09-11): replaces MEMORY. Verb = JUDGE, not recall. The stimulus renders to a ONE-SHOT server PNG (the
//    answer lives in pixels, never JSON) and the player answers under a tight DEADLINE — so an off-device screenshot/recording
//    can't be analysed in time, and a JSON/CV scraper gets nothing usable. Each game is its own independent mechanic + secret.
(function () {
  const pH = function (lvl) { const d = dOf(lvl); return { p: clamp(0.92 - 0.6 * d, 0.05, 0.92), kind: 'single' }; };
  const DL = (lvl) => Math.round(6000 - 3800 * dOf(lvl));   // answer deadline: ch1 ~6.0s -> ch10 ~2.2s
  const pk = (ev) => (ev || []).find(e => e && e.type === 'pick');
  // 1) APPRAISE THE HAUL — two coin piles; pick the more valuable. Value = summed coin sizes (area judgment, hard to script).
  GAMES.appraise = { family: 'perception', label: 'Appraise the Haul',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'appraise', lvl)), d = dOf(lvl); const N = 3; const sum = a => a.reduce((s, x) => s + x * x, 0); const piles = []; for (let i = 0; i < N; i++) { const n = 4 + r.int(5), a = []; for (let j = 0; j < n; j++) a.push(5 + r.int(9)); piles.push(a); } const ans = r.int(N), margin = Math.max(150, (1 - 0.55 * d) * 640); let mx = 0; for (let i = 0; i < N; i++) if (i !== ans) mx = Math.max(mx, sum(piles[i])); let guard = 0; while (sum(piles[ans]) < mx + margin && guard++ < 60) piles[ans].push(8 + r.int(8)); return { data: { mode: 'perc', kind: 'taprow', cols: N, prompt: 'TAP THE MOST VALUABLE PILE', deadlineMs: DL(lvl) }, pixels: { piles: piles }, secret: { ans: ans } }; },
    grade: function (b, lvl, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
  // 2) COUNT THE TAKE — a scatter of gems flashes; estimate which range it falls in (subitizing under a deadline).
  GAMES.counttake = { family: 'perception', label: 'Count the Take',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'counttake', lvl)), d = dOf(lvl); const n = 6 + Math.round(d * 20) + r.int(5); const width = Math.max(3, Math.round(9 - 5 * d)); const ansK = r.int(4); let lo0 = n - ansK * width - r.int(width); if (lo0 < 0) lo0 = 0; const labels = []; for (let k = 0; k < 4; k++) labels.push((lo0 + k * width) + '-' + (lo0 + (k + 1) * width - 1)); return { data: { mode: 'perc', kind: 'choose', labels: labels, prompt: 'HOW MANY GEMS?', deadlineMs: Math.round(DL(lvl) * 0.8) }, pixels: { n: n }, secret: { ans: ansK } }; },
    grade: function (b, lvl, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
  // 3) SPOT THE FORGERY — a grid of gold bars; one is a subtly different shade. Tap it. (shade discrimination)
  GAMES.forgery = { family: 'perception', label: 'Spot the Forgery',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'forgery', lvl)), d = dOf(lvl); const side = 3 + Math.round(d * 2), tiles = side * side; const baseL = 0.5, delta = Math.max(0.03, 0.2 - 0.16 * d); const oddL = clamp(baseL + (r.u() < 0.5 ? delta : -delta), 0.2, 0.85), ans = r.int(tiles); return { data: { mode: 'perc', kind: 'tapgrid', cols: side, rows: side, prompt: 'TAP THE ODD BAR', deadlineMs: DL(lvl) }, pixels: { cols: side, baseL: baseL, oddL: oddL, ans: ans }, secret: { ans: ans } }; },
    grade: function (b, lvl, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
  // 4) BALANCE THE SAFES — two safes on a beam with a subtle tilt; pick the heavier (lower) side. (comparative judgment)
  GAMES.balance = { family: 'perception', label: 'Balance the Safes',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'balance', lvl)), d = dOf(lvl); const N = 3, ans = r.int(N), drop = Math.max(10, Math.round(42 - 30 * d)); const ys = []; for (let i = 0; i < N; i++) ys.push(4 + r.int(8)); let mx = 0; for (let i = 0; i < N; i++) if (i !== ans) mx = Math.max(mx, ys[i]); ys[ans] = mx + drop; return { data: { mode: 'perc', kind: 'taprow', cols: N, prompt: 'TAP THE HEAVIEST SAFE', deadlineMs: DL(lvl) }, pixels: { ys: ys }, secret: { ans: ans } }; },
    grade: function (b, lvl, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
  // 5) MATCH THE SIGIL — a target glyph up top; tap its twin in the lineup below.
  GAMES.sigil = { family: 'perception', label: 'Match the Sigil',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'sigil', lvl)), d = dOf(lvl); const cols = 4 + Math.round(d * 2), target = r.int(10), ans = r.int(cols); const shapes = []; for (let i = 0; i < cols; i++) { if (i === ans) shapes.push(target); else { let s; do { s = r.int(10); } while (s === target); shapes.push(s); } } return { data: { mode: 'perc', kind: 'taprow', cols: cols, prompt: 'TAP THE MATCHING SIGIL', deadlineMs: DL(lvl) }, pixels: { target: target, shapes: shapes }, secret: { ans: ans } }; },
    grade: function (b, lvl, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
  // 6) ODD GLYPH OUT — a grid of one glyph; one cell is a different glyph. Tap the odd one.
  GAMES.oddglyph = { family: 'perception', label: 'Odd Glyph Out',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'oddglyph', lvl)), d = dOf(lvl); const side = 3 + Math.round(d * 2), tiles = side * side; const common = r.int(10); let odd; do { odd = r.int(10); } while (odd === common); const ans = r.int(tiles); return { data: { mode: 'perc', kind: 'tapgrid', cols: side, rows: side, prompt: 'TAP THE ODD GLYPH', deadlineMs: DL(lvl) }, pixels: { cols: side, common: common, odd: odd, ans: ans }, secret: { ans: ans } }; },
    grade: function (b, lvl, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
  // 7) READ THE DIAL — a gauge needle points at a hidden value; pick the range it lands in.
  GAMES.readdial = { family: 'perception', label: 'Read the Dial',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'readdial', lvl)), d = dOf(lvl); const bins = 4; let value; if (r.u() < 0.35 + 0.5 * d) { const bnd = 25 * (1 + r.int(3)); const eps = Math.max(1, Math.round(7 - 5 * d)); value = clamp(bnd + (r.u() < 0.5 ? -1 : 1) * (1 + r.int(eps)), 0, 99); } else value = r.int(100); const ans = Math.min(bins - 1, Math.floor(value / 25)); return { data: { mode: 'perc', kind: 'choose', labels: ['0-24', '25-49', '50-74', '75-99'], prompt: 'WHERE DOES THE NEEDLE POINT?', deadlineMs: DL(lvl) }, pixels: { value: value }, secret: { ans: ans } }; },   // Lever 5: deep = needle sits near a bucket boundary (ambiguous read), scaled by d
    grade: function (b, lvl, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
  // 8) THROUGH THE PEEPHOLE — a blurred item up top; tap which of the clear options it is. (degraded-image recognition)
  GAMES.peephole = { family: 'perception', label: 'Through the Peephole',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'peephole', lvl)), d = dOf(lvl); const cols = 4 + Math.round(d * 2), target = r.int(10), ans = r.int(cols); const opts = []; for (let i = 0; i < cols; i++) { if (i === ans) opts.push(target); else { let s; do { s = r.int(10); } while (s === target || opts.indexOf(s) >= 0); opts.push(s); } } return { data: { mode: 'perc', kind: 'taprow', cols: cols, prompt: 'WHICH ITEM IS BEHIND THE BLUR?', deadlineMs: DL(lvl) }, pixels: { target: target, blur: Math.min(0.85, 0.3 + 0.5 * d), opts: opts }, secret: { ans: ans } }; },
    grade: function (b, lvl, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
  // 9) SHADE RANK — a row of near-identical shades; tap the lightest. (fine luminance discrimination)
  GAMES.shaderank = { family: 'perception', label: 'Shade Rank',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'shaderank', lvl)), d = dOf(lvl); const N = 3 + Math.round(d * 2), base = 0.4, step = Math.max(0.04, 0.16 - 0.11 * d); const vals = []; for (let k = 0; k < N; k++) vals.push(base + k * step); for (let i = vals.length - 1; i > 0; i--) { const j = r.int(i + 1); const t = vals[i]; vals[i] = vals[j]; vals[j] = t; } let ans = 0; for (let k = 1; k < N; k++) if (vals[k] > vals[ans]) ans = k; return { data: { mode: 'perc', kind: 'taprow', cols: N, prompt: 'TAP THE LIGHTEST SHADE', deadlineMs: DL(lvl) }, pixels: { shades: vals }, secret: { ans: ans } }; },
    grade: function (b, lvl, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
  // 10) SHADOW MATCH — a silhouette up top; tap the object that casts it.
  GAMES.shadowmatch = { family: 'perception', label: 'Shadow Match',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'shadowmatch', lvl)), d = dOf(lvl); const cols = 4 + Math.round(d * 2), target = r.int(10), ans = r.int(cols); const opts = []; for (let i = 0; i < cols; i++) { if (i === ans) opts.push(target); else { let s; do { s = r.int(10); } while (s === target || opts.indexOf(s) >= 0); opts.push(s); } } return { data: { mode: 'perc', kind: 'taprow', cols: cols, prompt: 'TAP THE MATCHING OBJECT', deadlineMs: DL(lvl) }, pixels: { target: target, opts: opts }, secret: { ans: ans } }; },
    grade: function (b, lvl, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
})();
// ── PERCEPTION batch 2 — ILLUSION HARDENING (Jake 2026-09-11, deep-research backed): ambiguous/illusion stimuli read near-0% for
//    CV/VLM bots but easy for humans (IllusionCAPTCHA WWW'25). Fills Perception to 15 and raises the deep-chamber bot wall. Answer
//    always lives only in pixels + secret; the illusion is engineered to FIGHT the correct answer, harder with depth.
(function () {
  const pH = function (lvl) { const d = dOf(lvl); return { p: clamp(0.9 - 0.6 * d, 0.05, 0.9), kind: 'single' }; };
  const DL = (lvl) => Math.round(6000 - 3800 * dOf(lvl));
  const pk = (ev) => (ev || []).find(e => e && e.type === 'pick');
  // 11) LONGER LINE (Müller-Lyer): two lines; the shorter one wears outward fins so it LOOKS longer. Pick the truly longer.
  GAMES.muller = { family: 'perception', label: 'Longer Line',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'muller', lvl)), d = dOf(lvl); const N = 3, ans = r.int(N), base = 86, diff = Math.max(8, Math.round(46 - 34 * d)); const lens = []; for (let i = 0; i < N; i++) lens.push(base + r.int(10)); let mx = 0; for (let i = 0; i < N; i++) if (i !== ans) mx = Math.max(mx, lens[i]); lens[ans] = mx + diff; const fins = lens.map((_, i) => i === ans ? 'in' : 'out'); return { data: { mode: 'perc', kind: 'tapgrid', cols: 1, rows: N, prompt: 'TAP THE LONGEST LINE', deadlineMs: DL(lvl) }, pixels: { lens: lens, fins: fins }, secret: { ans: ans } }; },
    grade: function (b, l, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
  // 12) TRUE SIZE (Ponzo): two bars between converging rails; the "far" bar looks bigger. Pick the truly wider.
  GAMES.ponzo = { family: 'perception', label: 'True Size',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'ponzo', lvl)), d = dOf(lvl); const N = 3, ans = r.int(N), base = 52, diff = Math.max(6, Math.round(28 - 20 * d)); const ws = []; for (let i = 0; i < N; i++) ws.push(base + r.int(8)); let mx = 0; for (let i = 0; i < N; i++) if (i !== ans) mx = Math.max(mx, ws[i]); ws[ans] = mx + diff; return { data: { mode: 'perc', kind: 'tapgrid', cols: 1, rows: N, prompt: 'TAP THE WIDEST BAR', deadlineMs: DL(lvl) }, pixels: { ws: ws }, secret: { ans: ans } }; },
    grade: function (b, l, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
  // 13) TRUE SHADE (simultaneous contrast): swatches on different backgrounds; tap the one whose true value matches the target.
  GAMES.simcontrast = { family: 'perception', label: 'True Shade',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'simcontrast', lvl)), d = dOf(lvl); const N = 3 + Math.round(d * 2), tv = 0.5, delta = Math.max(0.05, 0.18 - 0.12 * d), ans = r.int(N); const shades = [], bgs = []; for (let i = 0; i < N; i++) { shades.push(i === ans ? tv : clamp(tv + (r.u() < 0.5 ? delta : -delta), 0.2, 0.8)); bgs.push(clamp(0.2 + r.u() * 0.6, 0.15, 0.85)); } return { data: { mode: 'perc', kind: 'taprow', cols: N, prompt: 'TAP THE SWATCH MATCHING THE TARGET', deadlineMs: DL(lvl) }, pixels: { target: tv, shades: shades, bgs: bgs }, secret: { ans: ans } }; },
    grade: function (b, l, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
  // 14) BREAK THE CAMO: a grid of one striped pattern; one tile's stripes are shifted, breaking the camouflage. Tap it.
  GAMES.camobreak = { family: 'perception', label: 'Break the Camo',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'camobreak', lvl)), d = dOf(lvl); const side = 3 + Math.round(d * 2), ans = r.int(side * side), shift = Math.max(2, Math.round(9 - 6 * d)); return { data: { mode: 'perc', kind: 'tapgrid', cols: side, rows: side, prompt: 'TAP THE TILE THAT BREAKS THE PATTERN', deadlineMs: DL(lvl) }, pixels: { cols: side, ans: ans, shift: shift }, secret: { ans: ans } }; },
    grade: function (b, l, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
  // 15) HIDDEN FIGURE: a shape buried in visual noise; tap which clean option it is. (degraded-recognition, brutal for CV)
  GAMES.figurenoise = { family: 'perception', label: 'Hidden Figure',
    build: function (seed, lvl) { const r = rng(seedMat(seed, 'figurenoise', lvl)), d = dOf(lvl); const cols = 4 + Math.round(d * 2), target = r.int(10), ans = r.int(cols); const opts = []; for (let i = 0; i < cols; i++) { if (i === ans) opts.push(target); else { let s; do { s = r.int(10); } while (s === target || opts.indexOf(s) >= 0); opts.push(s); } } return { data: { mode: 'perc', kind: 'taprow', cols: cols, prompt: 'WHICH SHAPE IS HIDDEN IN THE NOISE?', deadlineMs: DL(lvl) }, pixels: { target: target, noise: Math.min(0.82, 0.32 + 0.5 * d), opts: opts }, secret: { ans: ans } }; },
    grade: function (b, l, ev) { const p = pk(ev); return p && (p.idx | 0) === b.secret.ans ? 1 : 0; }, humanP: pH };
})();
module.exports = { GAMES, rng, dOf, renderSafe, LEVELS };
