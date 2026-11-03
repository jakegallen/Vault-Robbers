'use strict';
/*
 * Vault Robbers — SKILL ENGINE v4 server integration (flag: RTV_SKILL_V4). Ties engine + secure transport together.
 * Flow: startSession -> serve opaque frames/audio -> grade. The full challenge (incl. answers) stays server-side;
 * the client only ever receives `data` (answer-free) + rendered PNG/WAV media. Grading uses the server's secret.
 */
const crypto = require('crypto');
const { GAMES } = require('./skillgames.js');
const { renderFrame, renderAudio } = require('./render.js');

// PER-TIER UNIFICATION (Jake 2026-09-08, sim-odds.js): every category targets baseOdds(lvl,door) = P[lvl] x tier (Left 1.22 /
// Center 1.0 / Right 0.72, cap 0.97), so ALL 12 door+tier combos sit on the same win curve and the tier is pure EV-neutral
// variance (Left easier + smaller reward, Right harder + bigger reward) — identical to how luck already behaves. Center = the
// luck backbone. Arcade (no door) uses the center column. DEV twin only until the before/after table is signed off.
// V2 JACKPOT-LANE v3 re-solve (Jake 2026-09-08, sim-odds.js, DEV-ONLY): bars solved to the SMOOTHED tougher backbone
// P=[0.90,0.82,0.71,0.575,0.50,0.333,0.20,0.13,0.11,0.0245] — STRICTLY DECREASING per-chamber pass (ch10 the single hardest
// gate, easing toward the front; deterministic-skill intent = the core level is the toughest). reach ch5 ~30%, ch10 ~1-in-7k,
// crack ~1-in-284k. The bar VALUES are not monotonic across chambers because deep games are intrinsically harder (coreSpeed/
// coreTol), so a lower bar deep can still yield a lower pass; the ACHIEVED pass rates are what match the backbone. Nerve ~0
// gimme chambers use the 0.02 floor so a BUSTED nerve run (score exactly 0, banked over the line) still FAILS.
// (Re-solved 2026-09-08 after the V2 roster cull + new games ledger/heatmap/voltage — same P backbone, new pool averages.)
const SKILL_BAR_T = {   // RE-SOLVED 2026-09-10 for the 15-game skill pool (sim-odds.js) — bars back on the ~1-in-284k backbone with the 6 new games in.
  left: [0.236, 0.134, 0.366, 0.376, 0.440, 0.603, 0.570, 0.422, 0.204, 0.455],
  center: [0.463, 0.524, 0.574, 0.560, 0.583, 0.682, 0.638, 0.489, 0.275, 0.500],
  right: [0.711, 0.719, 0.727, 0.713, 0.720, 0.770, 0.728, 0.605, 0.399, 0.629]
};
const NERVE_BAR_T = {
  left: [0.02, 0.02, 0.851, 0.861, 0.799, 0.777, 0.775, 0.769, 0.718, 0.898],
  center: [0.30, 0.38, 0.45, 0.52, 0.58, 0.63, 0.68, 0.72, 0.76, 0.80],   // NERVE V3 WINNABLE ramp (Jake 2026-09-11): "make games winnable+fun first, curve later". Fill-to-green FLOOR model (overshoot-bust removed on count games, widened to 1.6x on hold games) so target = reach bar*ceiling with NO instadeath band. Bars are a smooth "hit X% of the safe windows" ramp (ch1 30% -> ch10 80%), hard-but-winnable. Exact odds curve to be re-derived AFTER winnability/fun confirmed. Prev razor-band bars: [0.596,0.613,0.688,0.747,0.787,0.867,0.904,0.946,0.958,0.992].
  right: [0.956, 0.956, 0.944, 0.919, 0.876, 0.855, 0.853, 0.850, 0.817, 0.939]
};
// MEMORY: one center bar (discrete recall can't carve finer) + a per-tier rarity roll that pulls each door's NET onto baseOdds.
// Deep memory (ch8) floors at net ~9% vs 13% target (ace-rate cap, roll can't exceed 1.0), so memory runs a touch HARDER at ch8.
// Intentional and acceptable: memory is the strongest anti-bot surface, so slightly tougher deep is fine.
const MEMORY_BAR = [1.000, 1.000, 1.000, 1.000, 0.800, 0.833, 0.857, 0.857, 0.833, 1.000];   // RE-SOLVED 2026-09-10 for the 15-game memory pool (+bearing/denoms/glyphset).
const MEM_ROLL_T = {
  left: [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.727],
  center: [0.962, 0.908, 0.891, 0.940, 1.000, 1.000, 1.000, 1.000, 1.000, 0.596],
  right: [0.692, 0.654, 0.642, 0.677, 0.750, 0.790, 0.743, 0.748, 0.824, 0.429]
};
const BAR = SKILL_BAR_T.center;        // arcade default (no door)
const NERVE_BAR = NERVE_BAR_T.center;  // arcade default
// SKILL category = the ORIGINAL games users loved, ported 1:1 into v4. Only games with a shipped v4 presenter go in the
// door pool (more land as each legacy game is ported). MEMORY = the new perception/recall set — kept for the arcade
// "Memory" category and future use, but NEVER served by skill doors. keypad/torque engines exist but stay parked too.
const SKILL_POOL = ['beam', 'wirecut', 'dial', 'stopwatch', 'torque', 'keypad', 'dialcombo', 'tumbler', 'voltage', 'pendulum', 'crosshair', 'orbit', 'slider', 'align3', 'pulse'];   // V2 CULL (Jake 2026-09-08) + NEW V2 batch (2026-09-10): pendulum/crosshair/orbit/slider/align3/pulse — continuous-precision timing that collapses to the backbone deep (coreSpeed/coreTol).
const MEMORY_POOL = ['lineup', 'spatial', 'reverse', 'simon', 'gridrecall', 'pairs', 'nback', 'journey', 'ledger', 'heatmap', 'safecombo', 'colorlock', 'bearing', 'denoms', 'glyphset'];   // V2 CULL (Jake 2026-09-08) + NEW V2 batch (2026-09-10): safecombo/colorlock/bearing/denoms (span recall) + glyphset (set recall). Memory = the anti-bot crown jewel. 15 total.
const LUCK_POOL = ['coinflip', 'wheel', 'dice', 'cardflip', 'slots', 'roulette', 'shells', 'scratch', 'plinko', 'keno', 'goldbar', 'magnetgrab', 'fuserace', 'elevatorroulette', 'safedial'];   // 15 fate games (ungraded)
const NERVE_POOL = ['crank', 'dive', 'thermite', 'staticcharge', 'nitro', 'crackdrill', 'guardsweep', 'ladder', 'cascadelocks', 'vaultstack', 'dominoes', 'ziplinebail', 'minefield', 'defuse', 'heisttimer'];   // 15 deterministic precision games
// GAMBLE (Jake 2026-09-11): replaces NERVE. Chance-dominated + decision/timing shifts EV; each outcome is a server secret. Grows to 15.
const GAMBLE_POOL = ['crashout', 'presspot', 'wheelbrake', 'plinkodrop', 'saferoulette', 'dicebet', 'coinclimb', 'hilo', 'hitstand', 'sweep', 'rocketcrash', 'turbopress', 'deepsweep', 'hilo5', 'doubledeck'];
const GAMBLE_BAR = [0.30, 0.34, 0.38, 0.42, 0.46, 0.50, 0.54, 0.58, 0.62, 0.66];   // winnable ramp for now (curve re-derived after playtest, per Jake)
// PERCEPTION (Jake 2026-09-11): replaces MEMORY. Judgment games — mostly correct/incorrect, so the bar is flat (pass = right answer);
// difficulty scales via the STIMULUS (shrinking shade delta / more decoys / rising count / blur / tighter deadline), not the bar.
const PERCEPTION_POOL = ['appraise', 'counttake', 'forgery', 'balance', 'sigil', 'oddglyph', 'readdial', 'peephole', 'shaderank', 'shadowmatch', 'muller', 'ponzo', 'simcontrast', 'camobreak', 'figurenoise'];
const PERCEPTION_BAR = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
// depth-weighted pools (the harder reads — dial/dialcombo/torque/tumbler — favoured deeper; reaction/mash shallow)
function poolFor(level) {
  if (level <= 3) return ['beam', 'wirecut', 'stopwatch', 'keypad', 'voltage', 'pendulum', 'orbit', 'slider', 'pulse'];
  if (level <= 5) return ['beam', 'wirecut', 'dial', 'stopwatch', 'torque', 'keypad', 'tumbler', 'voltage', 'pendulum', 'orbit', 'slider', 'pulse', 'crosshair', 'align3'];
  // DEEP (ch6-10): ONLY continuous-precision timing games, core-hardened (coreSpeed/coreTol) so a real human's score collapses
  // to the luck backbone. The NEW V2 games (pendulum/crosshair/orbit/slider/align3/pulse) are all continuous → deep-safe.
  return ['dial', 'dialcombo', 'torque', 'tumbler', 'stopwatch', 'pendulum', 'crosshair', 'orbit', 'slider', 'align3', 'pulse'];
}
// MEMORY depth-gate (mirror of poolFor for unification): shallow uses everything; mid drops the pure binary one-shots
// (whatchanged/shade/combo) whose exact-1.0 rate floors the pass curve; deep uses ONLY collapsing recall games (long spans +
// set recall), which are deep-hardened (longer spans, faster flashes) so a human's continuous score falls to the backbone.
function memoryPoolFor(level) {
  if (level <= 3) return MEMORY_POOL;
  if (level <= 5) return ['lineup', 'spatial', 'reverse', 'simon', 'journey', 'pairs', 'nback', 'gridrecall', 'ledger', 'heatmap', 'safecombo', 'colorlock', 'bearing', 'denoms', 'glyphset'];
  return ['lineup', 'spatial', 'reverse', 'simon', 'journey', 'pairs', 'nback', 'gridrecall', 'heatmap', 'safecombo', 'colorlock', 'bearing', 'denoms', 'glyphset'];   // deep: collapsing recall + set-discrimination only (safecombo/colorlock/bearing/denoms = long-span recall, glyphset = set recall; all deep-safe)
}
// door pool for a given CATEGORY: skill + memory are depth-gated; luck/nerve pick from their full rosters.
function kindPoolFor(kind, level) { if (kind === 'luck') return LUCK_POOL; if (kind === 'gamble') return GAMBLE_POOL; if (kind === 'perception') return PERCEPTION_POOL; if (kind === 'nerve') return NERVE_POOL; if (kind === 'memory') return memoryPoolFor(level); return poolFor(level); }
function frameCount(gameKey, b) {
  if (GAMES[gameKey] && GAMES[gameKey].family === 'fate') return 0;   // luck fate games = no overlay (agnostic client animation)
  if (GAMES[gameKey] && GAMES[gameKey].family === 'perception') return 1;   // PERCEPTION: single one-shot stimulus frame (answer in pixels)
  if (b && b.data && typeof b.data.mode === 'string' && b.data.mode.indexOf('sk') === 0) return (b.pixels && Object.keys(b.pixels).length) ? 1 : 0;   // SKILL V3: fixed-target games are client-drawn (0); games with a RANDOM target ship it as a one-shot PNG in pixels (return 1) so the answer never rides in `data` (anti-cheat, Jake 2026-09-11)
  if (b && b.data && b.data.mode === 'gauge') return 1;   // nerve gauge = one hidden-danger-line overlay
  if (b && b.data && b.data.mode === 'climb') return 0;   // nerve climb = no overlay (trap is server secret only)
  if (b && b.data && (b.data.mode === 'nitro' || b.data.mode === 'gapgrab' || b.data.mode === 'creep' || b.data.mode === 'beam' || b.data.mode === 'defuse' || b.data.mode === 'valve' || b.data.mode === 'cascade' || b.data.mode === 'stack' || b.data.mode === 'siphon' || b.data.mode === 'alarm' || b.data.mode === 'dive' || b.data.mode === 'zip' || b.data.mode === 'thermite' || b.data.mode === 'domino' || b.data.mode === 'drill')) return 0;   // NERVE V2: fully client-drawn from shipped data; the bust ceiling/live-item/time-limit/trap is server-secret (no overlay to read)
  if (b && b.data && (b.data.mode === 'crash' || b.data.mode === 'press')) return 0;   // GAMBLE: client-drawn from shipped data; the bust/trip is server-secret (no overlay to read)
  if (gameKey === 'oddone') return b.secret.odd.length;
  if (gameKey === 'shade') return b.secret.targets.length;
  if (gameKey === 'spatial') return b.secret.cells.length;
  if (gameKey === 'lineup' || gameKey === 'reverse' || gameKey === 'simon' || gameKey === 'safecombo' || gameKey === 'colorlock' || gameKey === 'bearing' || gameKey === 'denoms') return b.secret.seq.length;
  if (gameKey === 'glyphset') return 1;
  if (gameKey === 'pendulum' || gameKey === 'crosshair' || gameKey === 'orbit' || gameKey === 'slider' || gameKey === 'align3' || gameKey === 'pulse') return 1;
  if (gameKey === 'ledger') return b.pixels.amts.length;
  if (gameKey === 'heatmap') return 1;
  if (gameKey === 'voltage') return b.pixels.targets.length;
  if (gameKey === 'gridrecall') return 1;
  if (gameKey === 'pairs') return 1 + b.secret.queries.length;
  if (gameKey === 'nback') return b.secret.seq.length;
  if (gameKey === 'countflash') return b.secret.seq.length;
  if (gameKey === 'whatchanged') return 2;
  if (gameKey === 'journey') return b.secret.cells.length;
  if (gameKey === 'dial') return b.secret.targets.length;
  if (gameKey === 'beam') return b.secret.gaps.length;
  if (gameKey === 'wirecut') return 1;
  if (gameKey === 'stopwatch') return 1;
  if (gameKey === 'targets') return 0;   // locks are drawn client-side from data.pos now (no server overlay)
  if (gameKey === 'sort') return 1;
  if (gameKey === 'keypad') return b.secret.code.length;
  if (gameKey === 'torque') return 1;
  if (gameKey === 'combo') return 1;
  if (gameKey === 'hotwire') return 1;
  if (gameKey === 'sonicrack') return b.secret.gaps.length;
  if (gameKey === 'dialcombo') return b.secret.targets.length;
  if (gameKey === 'tumbler') return 1;
  if (gameKey === 'pressureplates') return 1;
  if (gameKey === 'coinflip') return 0;   // luck fate = no overlay (agnostic animation; real outcome is the /api/crack roll)
  // reflex / mash / silentalarm = no overlay (client-rendered, reaction/mash graded server-side)
  return 0; // rhythm = audio only
}

const _sessions = new Map();
function sweep(now) { for (const [k, v] of _sessions) if (now - v.created > 5 * 60 * 1000) _sessions.delete(k); }

function pickGame(seed, level) { const pool = poolFor(level); const h = crypto.createHash('sha256').update(seed + ':pick:' + level).digest(); return pool[h.readUInt32BE(0) % pool.length]; }
// ARCADE HARDENING (Jake 2026-09-09 audit): the ONLY game keys the arcade / practice may start are those actually reachable on a
// live door (any kind, any level). This blocks a client from requesting a culled/parked game (e.g. 'targets', 'sort') that would
// leak its answer in the shipped `data`. Unknown/non-servable keys fall back to the seed-picked game instead of being honored.
let _SERVABLE = null;
function servableSet() { if (_SERVABLE) return _SERVABLE; const s = new Set();
  for (const kind of ['luck', 'skill', 'gamble', 'perception']) for (let lv = 1; lv <= 10; lv++) { try { (kindPoolFor(kind, lv) || []).forEach(g => s.add(g)); } catch (e) {} }   // V2: Nerve + Memory eliminated — only the four live categories are servable
  _SERVABLE = s; return s; }

// start a challenge. opts: { seed, level, gameKey? }. Returns the ANSWER-FREE descriptor for the client.
// PERCEPTION difficulty (Jake 2026-09-11). Lever 1: a multi-round GATE — the player must get EVERY round right, so one lucky 1-in-N
// guess can't pass (kills the 25-33% blind-guess floor and any blind bot). Lever 2: a steeper per-round ramp — each round is built at
// an EFFECTIVE level lifted in the mid-range so ch4 plays like ~ch6 (ends unchanged: ch1 stays gentle, ch10 max).
function percRounds(lvl) { const d = (Math.max(1, Math.min(10, lvl)) - 1) / 9; return 1 + Math.round(d * 3); }              // 1 (shallow) -> 4 (core)
function percEffLevel(lvl) { const d = (Math.max(1, Math.min(10, lvl)) - 1) / 9; const pd = Math.pow(d, 0.62); return Math.max(1, Math.min(10, Math.round(1 + 9 * pd))); }   // L1->1, L4->6, L7->8, L10->10

function startSession(opts) {
  const now = Date.now(); sweep(now);
  const level = Math.max(1, Math.min(10, opts.level | 0 || 1));
  const seed = String(opts.seed || crypto.randomBytes(8).toString('hex'));
  const gameKey = (opts.gameKey && GAMES[opts.gameKey] && servableSet().has(opts.gameKey)) ? opts.gameKey : pickGame(seed, level);
  const isPerc = GAMES[gameKey] && GAMES[gameKey].family === 'perception';
  let built, rounds = null, frames;
  if (isPerc) {
    const K = percRounds(level), eLvl = percEffLevel(level);
    // NO-DUPLICATE STAGES (Jake 2026-09-12): each round is a DISTINCT perception game (round 0 keeps the door-chosen game; the
    // rest are drawn distinct from the pool via a deterministic seed-shuffle). A stimulus-signature guard then re-salts any round
    // whose rendered stimulus+answer would still collide, so no two stages can ever be identical, at any difficulty.
    const rest = PERCEPTION_POOL.filter(g => g !== gameKey);
    const hb = crypto.createHash('sha256').update(seed + ':percorder').digest();
    for (let i = rest.length - 1; i > 0; i--) { const j = hb[i % hb.length] % (i + 1); const t = rest[i]; rest[i] = rest[j]; rest[j] = t; }   // deterministic Fisher-Yates
    const order = [gameKey]; for (const g of rest) { if (order.length >= K) break; order.push(g); }
    while (order.length < K) order.push(gameKey);   // safety only (pool 15 >= max 4 rounds, so never hit)
    rounds = []; const seen = new Set();
    for (let k = 0; k < K; k++) {
      let gk = order[k], b, sig, salt = 0;
      do { b = GAMES[gk].build(seed + ':pr' + k + (salt ? ':s' + salt : ''), eLvl); sig = gk + '|' + JSON.stringify(b.pixels || {}) + '|' + JSON.stringify(b.secret || {}); salt++; }
      while (seen.has(sig) && salt < 16);
      seen.add(sig); rounds.push({ gk: gk, built: b });
    }
    built = rounds[0].built; frames = K;
  } else {
    built = GAMES[gameKey].build(seed, level);
    frames = frameCount(gameKey, built);
  }
  const sid = 'sk_' + crypto.randomBytes(12).toString('hex');
  _sessions.set(sid, { gameKey, level, built, rounds, created: now, frames, seed, done: false });
  const sbar = (GAMES[gameKey].family === 'gamble' ? GAMBLE_BAR : GAMES[gameKey].family === 'perception' ? PERCEPTION_BAR : GAMES[gameKey].family === 'nerve' ? NERVE_BAR : (MEMORY_POOL.includes(gameKey) ? MEMORY_BAR : BAR))[level - 1];
  if (GAMES[gameKey].family === 'nerve' && built.secret && built.secret.ceiling != null) {
    built.data.ceiling = built.secret.ceiling;   // ship the target so the client draws the gold PASS mark (bar x ceiling)
    // NERVE V3 FLOOR MODEL (Jake 2026-09-11): count/window games = "fill to green = win, NO bust above" (data.floor). Hold games
    // keep a blow-bust but WIDE (1.6x ceiling) so the safe release window is legible, not a razor edge (data.blow). Client renders
    // the red zone ONLY for hold games (above blow); floor games show no death zone. Makes the visual match the grade.
    const HOLD = { nitro: 1, beam: 1, dive: 1, zip: 1, thermite: 1, drill: 1 };
    if (HOLD[built.data.mode]) built.data.blow = +(built.secret.ceiling * 1.6).toFixed(4);
    else built.data.floor = true;
  }
  // PERCEPTION multi-round: ship ONLY per-round render params (kind/cols/rows/labels/prompt/deadlineMs) + a top-level deadline for any
  // server code that reads it. Answers never leave the server (each round's secret stays in _sessions).
  const clientData = isPerc
    ? { mode: 'perc', multi: true, K: frames, deadlineMs: (built.data && built.data.deadlineMs) || 5000, rounds: rounds.map(rb => rb.built.data) }
    : built.data;
  return { sid, gameKey, level, data: clientData, frames, hasAudio: gameKey === 'rhythm', flashMs: built.data.flashMs || 0, bar: sbar };
}
// getFrame returns a PNG Buffer, or a numeric HTTP status for a refusal.
// MEMORY anti-cheat (Jake 2026-09-11): the flashed frames ARE the answer, so a scraper could bulk-fetch every frame at t=0 (or
// re-fetch them at the recall step) and OCR at leisure — defeating the working-memory challenge. For memory games we (a) TIME-GATE
// future frames (frame i isn't served until its flash would have arrived) so they can't be pre-fetched, and (b) ONE-SHOT each
// frame (served ~twice for a network retry, then locked) so they can't be re-fetched to study after the flash. This forces a
// single real-time pass — a bot must build a live OCR pipeline instead of screenshotting and thinking. (Post-grade is already
// closed: gradeSession deletes the session, so all frames 404.) Skill/luck/nerve are unaffected (some preload their frames).
function getFrame(sid, i) {
  const s = _sessions.get(sid); if (!s || s.done) return 404; i = i | 0;
  const fam = GAMES[s.gameKey] && GAMES[s.gameKey].family;
  if (fam === 'memory') {
    const flash = (s.built.data && s.built.data.flashMs) || 600, spacing = Math.max(140, flash * 0.5);
    if (i > 0 && (Date.now() - s.created) < i * spacing) return 425;          // Too Early: no bulk pre-fetch of frames not yet flashed
    s._srv = s._srv || {}; s._srv[i] = (s._srv[i] || 0) + 1; if (s._srv[i] > 2) return 404;   // one-shot(+1 retry): can't re-fetch to study later
  }
  if (fam === 'perception') {   // PERCEPTION anti-cheat: the stimulus IS the answer, so ONE-SHOT it (served ~twice for a retry, then locked) — no re-fetching the image to analyse off-device; combined with the answer deadline in gradeSession.
    s._srv = s._srv || {}; s._srv[i] = (s._srv[i] || 0) + 1; if (s._srv[i] > 2) return 404;
    if (s.rounds) { if (i < 0 || i >= s.rounds.length) return 404; return renderFrame(s.rounds[i].gk, s.rounds[i].built, 0); }   // multi-round: frame i = round i's own game + stimulus
  }
  return renderFrame(s.gameKey, s.built, i);
}
function getAudio(sid) { const s = _sessions.get(sid); if (!s) return null; return renderAudio(s.gameKey, s.built); }
function gradeSession(sid, events) {
  const s = _sessions.get(sid); if (!s) return { error: 'no session' };
  if (s.done) return { error: 'already graded' };
  s.done = true;
  let score = GAMES[s.gameKey].grade(s.built, s.level, events || []);
  const fam = GAMES[s.gameKey].family;
  // PERCEPTION multi-round GATE: score = MIN over rounds (binary grades -> must get EVERY round right). Each round is graded against
  // its OWN server-side secret; the client sends one {type:'pick', round:k, idx} per round. A blind guesser now passes ~(1/N)^K.
  if (fam === 'perception' && s.rounds) {
    let all = 1;
    for (let k = 0; k < s.rounds.length; k++) {
      const pick = (events || []).find(e => e && e.type === 'pick' && (e.round | 0) === k);
      const rs = GAMES[s.rounds[k].gk].grade(s.rounds[k].built, s.level, pick ? [{ type: 'pick', idx: pick.idx }] : []);
      if (rs < all) all = rs;
    }
    score = all;
  }
  // MEMORY recall deadline (Jake 2026-09-11): a human recalls from working memory in seconds; someone who screenshots/records the
  // flash and studies it before inputting blows past a generous window. Server-timed (client can't forge). Voids the score on timeout.
  // Deadline = flash phase (frames × flash) + a generous per-item recall budget + buffer. Only memory; never trips a normal player.
  let tooSlow = false;
  if (fam === 'memory') {
    const d = s.built.data || {}, cnt = d.count || d.k || s.frames || 4, flashMs = d.flashMs || 600;
    const flashPhase = (s.frames || cnt) * (flashMs + 180), deadline = flashPhase + cnt * 3500 + 9000;   // ~generous: e.g. 5-item ≈ 30s+
    if (Date.now() - s.created > deadline) { score = 0; tooSlow = true; }
  }
  // PERCEPTION answer deadline (Jake 2026-09-11): the judgment must land inside the shipped window (+ countdown/network slack).
  // A screenshot/recording analysed off-device blows past it. Server-timed backstop to the client countdown; never trips a live player.
  if (fam === 'perception') { const dl = s.rounds ? s.rounds.reduce((a, rb) => a + ((rb.built.data && rb.built.data.deadlineMs) || 5000), 0) : ((s.built.data && s.built.data.deadlineMs) || 5000); const slack = 8000 + (s.rounds ? s.rounds.length * 2500 : 0); if (Date.now() - s.created > dl + slack) { score = 0; tooSlow = true; } }
  const bar = (fam === 'gamble' ? GAMBLE_BAR : fam === 'perception' ? PERCEPTION_BAR : fam === 'nerve' ? NERVE_BAR : (MEMORY_POOL.includes(s.gameKey) ? MEMORY_BAR : BAR))[s.level - 1];
  // reveal (nerve): where the target line was + where you stopped, so the client can show the miss VISUALLY (not text). Safe to
  // reveal AFTER grading — the answer is spent. Bot can't OCR a pixel marker into training data.
  let reveal = null;
  if (fam === 'nerve' && s.built.secret && s.built.secret.line != null) { const bk = (events || []).find(e => e && e.type === 'bank'); reveal = { mode: 'gauge', line: s.built.secret.line, banked: bk ? Math.max(0, Math.min(1.3, s.built.secret.speed * ((bk.t || 0) / 1000))) : null }; }   // gauge-shaped reveal only for the legacy meter games; NERVE V2 modes (nitro/gapgrab/creep) have no line, no reveal
  // GAMBLE reveal hook (Jake 2026-09-11): a game may expose reveal(built, events) -> the resolved outcome (landed sector/slot/roll/
  // cards/bombs). Safe AFTER grading (answer spent); lets the client honestly animate what the SERVER picked instead of a fake.
  if (!reveal && typeof GAMES[s.gameKey].reveal === 'function') { try { reveal = GAMES[s.gameKey].reveal(s.built, events || []); } catch (e) { reveal = null; } }
  _sessions.delete(sid);
  return { score, bar, pass: score >= bar, gameKey: s.gameKey, level: s.level, reveal, tooSlow };
}

// express mount (behind RTV_SKILL_V4). deps optional: { rateOk, clientIp }
function mountSkillV4(app, deps) {
  deps = deps || {};
  // PRACTICE THROTTLE (Jake 2026-09-08 V2, anti-farming): cap arcade session-starts per IP so the free practice arena can't be
  // scraped into a large labelled training set for a CV solver. The 250k-burn pass raises the entry cost; this caps throughput.
  const ipOf = deps.clientIp || ((req) => String((req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '')).split(',')[0].trim());
  const _pv = new Map();   // ip -> { n, t }
  const PV_MAX = Number(process.env.RTV_PRACTICE_MAX_PER_MIN || 30), PV_WIN = 60000;
  function practiceOk(req) {
    const ip = ipOf(req), now = Date.now(), r = _pv.get(ip);
    if (!r || now - r.t > PV_WIN) { if (_pv.size > 5000) _pv.clear(); _pv.set(ip, { n: 1, t: now }); return true; }
    r.n++; return r.n <= PV_MAX;
  }
  app.post('/api/skill/start', require('express').json(), (req, res) => {
    if (!practiceOk(req)) return res.status(429).json({ error: 'practice rate limit — slow down' });
    try { const out = startSession({ seed: req.body.seed, level: req.body.level, gameKey: req.body.gameKey }); res.json(out); }
    catch (e) { res.status(500).json({ error: 'start', detail: e.message }); }
  });
  app.get('/api/skill/frame', (req, res) => {
    const r = getFrame(String(req.query.sid || ''), parseInt(req.query.i, 10) || 0);
    if (typeof r === 'number') return res.status(r).end();   // 404 (gone/locked) or 425 (too early — anti pre-fetch)
    if (!r) return res.status(404).end();
    res.setHeader('Content-Type', 'image/png'); res.setHeader('Cache-Control', 'no-store'); res.end(r);
  });
  app.get('/api/skill/audio', (req, res) => {
    const wav = getAudio(String(req.query.sid || ''));
    if (!wav) return res.status(404).end();
    res.setHeader('Content-Type', 'audio/wav'); res.setHeader('Cache-Control', 'no-store'); res.end(wav);
  });
  app.post('/api/skill/grade', require('express').json(), (req, res) => {
    res.json(gradeSession(String(req.body.sid || ''), req.body.events));
  });
  console.log('[rtv-v4] skill engine v4 mounted (games: ' + SKILL_POOL.join('/') + ')');
}

module.exports = { startSession, getFrame, getAudio, gradeSession, mountSkillV4, poolFor, memoryPoolFor, kindPoolFor, frameCount, BAR, NERVE_BAR, MEMORY_BAR, GAMBLE_BAR, PERCEPTION_BAR, GAMBLE_POOL, PERCEPTION_POOL, SKILL_BAR_T, NERVE_BAR_T, MEM_ROLL_T, _sessions };
