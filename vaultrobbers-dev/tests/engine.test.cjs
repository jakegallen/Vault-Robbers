// RVLT engine unit tests — pure, offline (no server boot, no DB, no network). Protects the seed-not-answer contract,
// the live roster, engine determinism, grade bounds, and the odds tables. Run via `npm test`.
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const sg = require('../skillgames.js');
const v4 = require('../skillv4.js');
const GAMES = sg.GAMES;

// ---- live servable roster (union of the real pools over all levels) ----
const KINDS = ['luck', 'skill', 'perception', 'dexterity', 'memory'];
const servable = new Set();
for (const k of KINDS) for (let l = 1; l <= 10; l++) { try { (v4.kindPoolFor(k, l) || []).forEach(g => servable.add(g)); } catch (e) {} }
const SERV = [...servable];
const LEVELS_T = [1, 5, 10];
// secrecy-defended games: those that produce server-PNG pixels (memory + perception) PLUS the 5 skill games whose answer lives in `secret`.
const SKILL_SECRET = ['safeproc', 'lockorder', 'counterrot', 'gonogo', 'oddsignal'];
const secrecyGames = SERV.filter(k => { try { const b = GAMES[k].build('probe', 3); return b.pixels && Object.keys(b.pixels).length > 0; } catch (e) { return false; } });
for (const k of SKILL_SECRET) if (servable.has(k) && !secrecyGames.includes(k)) secrecyGames.push(k);

// ---- presenter map keys (parse the browser bundle; it uses window globals so can't be required) ----
function presenterKeys() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'skillgames-remote.js'), 'utf8');
  const keys = new Set();
  for (const m of src.matchAll(/\bP\.([a-zA-Z0-9_]+)\s*=\s*p[A-Za-z0-9_]+/g)) keys.add(m[1]);
  const lit = src.match(/const P = \{[^\n]*\};/);
  if (lit) for (const m of lit[0].matchAll(/([a-zA-Z0-9_]+):\s*p[A-Za-z0-9_]+/g)) keys.add(m[1]);
  return keys;
}

// ===================== DETERMINISM =====================
T('build() is deterministic (same seed+level => byte-identical)', () => {
  for (const k of SERV) for (const lvl of LEVELS_T) {
    const a = GAMES[k].build('seedZ|' + k, lvl), b = GAMES[k].build('seedZ|' + k, lvl);
    assert.deepStrictEqual(a, b, 'nondeterministic build: ' + k + '@' + lvl);
  }
});
T('grade() is pure (repeatable + does not mutate built)', () => {
  for (const k of SERV) {
    const built = GAMES[k].build('gp|' + k, 5); const snap = JSON.stringify(built);
    const r1 = GAMES[k].grade(built, 5, []); const r2 = GAMES[k].grade(built, 5, []);
    assert.strictEqual(r1, r2, 'grade not repeatable: ' + k);
    assert.strictEqual(JSON.stringify(built), snap, 'grade mutated built: ' + k);
  }
});

// ===================== GRADE BOUNDS =====================
T('grade() in [0,1] for empty events, all servable games x levels', () => {
  for (const k of SERV) for (let lvl = 1; lvl <= 10; lvl++) {
    const s = GAMES[k].grade(GAMES[k].build('gb|' + k, lvl), lvl, []);
    assert.ok(s === null || (typeof s === 'number' && s >= 0 && s <= 1 && !Number.isNaN(s)), 'out of range: ' + k + '@' + lvl + ' => ' + s);
  }
});
T('grade() never throws on junk/hostile event payloads', () => {
  const junk = [[], [{}], [{ type: 'x' }], [{ type: 'tap', t: NaN }], [{ type: 'pick', idx: -1 }], [{ type: 'pick', idx: 999 }], [{ t: Infinity }], [{ type: 'down' }, { type: 'up' }]];
  for (const k of SERV) for (const ev of junk) {
    const built = GAMES[k].build('gj|' + k, 5);
    let s; assert.doesNotThrow(() => { s = GAMES[k].grade(built, 5, ev); }, k + ' threw on junk');
    assert.ok(s === null || (s >= 0 && s <= 1), k + ' junk out of range');
  }
});

// ===================== LEAK GUARD (seed-not-answer) =====================
T('renderSafe() exposes ONLY {gameKey,data} — never secret/pixels', () => {
  for (const k of SERV) {
    const safe = sg.renderSafe(k, GAMES[k].build('ls|' + k, 5));
    assert.deepStrictEqual(Object.keys(safe).sort(), ['data', 'gameKey'], 'renderSafe leaked keys: ' + k + ' => ' + Object.keys(safe));
  }
});
T('no secret answer-container leaks into client data (secrecy games)', () => {
  for (const k of secrecyGames) for (const lvl of LEVELS_T) {
    const built = GAMES[k].build('lk|' + k, lvl);
    const dataStr = JSON.stringify(sg.renderSafe(k, built).data);
    for (const [sk, sv] of Object.entries(built.secret || {})) {
      if (sv && typeof sv === 'object') {           // arrays/objects = the answer material
        const needle = JSON.stringify(sv);
        if (needle.length > 2) assert.ok(!dataStr.includes(needle), 'ANSWER LEAK: ' + k + '@' + lvl + ' secret.' + sk + ' appears in client data');
      }
    }
  }
});
T('skill games keep their answer field in secret only', () => {
  const ANS = { safeproc: 'seq', lockorder: 'order', counterrot: 'target', gonogo: 'goSet', oddsignal: 'oddIdx' };
  for (const [k, field] of Object.entries(ANS)) {
    if (!servable.has(k)) continue;
    const built = GAMES[k].build('sk|' + k, 6);
    assert.ok(field in (built.secret || {}), k + ': answer field "' + field + '" missing from secret');
    const dataStr = JSON.stringify(sg.renderSafe(k, built).data);
    const v = built.secret[field];
    if (v && typeof v === 'object') assert.ok(!dataStr.includes(JSON.stringify(v)), k + ': answer "' + field + '" leaked into data');
  }
});

// ===================== POOL INTEGRITY (lock the 52-live roster) =====================
T('every servable game has a GAMES definition', () => {
  for (const k of SERV) assert.ok(GAMES[k] && typeof GAMES[k].build === 'function' && typeof GAMES[k].grade === 'function', 'servable game missing/invalid def: ' + k);
});
T('every servable game has a client presenter', () => {
  const P = presenterKeys();
  for (const k of SERV) assert.ok(P.has(k), 'servable game has NO presenter (would throw "no renderer" mid-run): ' + k);
});
T('live pool counts match the intended roster', () => {
  const cnt = kind => { const s = new Set(); for (let l = 1; l <= 10; l++) (v4.kindPoolFor(kind, l) || []).forEach(g => s.add(g)); return s.size; };
  assert.strictEqual(cnt('luck'), 15, 'luck count');
  assert.strictEqual(cnt('skill'), 5, 'skill count');
  assert.strictEqual(cnt('perception'), 9, 'perception count');
  assert.strictEqual(cnt('memory'), 15, 'memory count');
  const dex = cnt('dexterity');
  assert.ok(dex === 8 || dex === 12, 'dexterity count expected 8 (RTV_DEX_NEW off) or 12 (on), got ' + dex);
});
T('no dead presenter: every non-fate presenter key maps to a defined game or is a KNOWN staged/keep key', () => {
  // guards against re-introducing an unreachable presenter (the class we removed tonight)
  const P = presenterKeys();
  const STAGED = new Set(['dialstop', 'undertow', 'gaterunner', 'livewire']); // RTV_DEX_NEW staged, keep
  for (const key of P) {
    if (STAGED.has(key)) continue;
    assert.ok(GAMES[key], 'presenter for a non-existent game (dead): ' + key);
  }
});

// ===================== ODDS / BAR TABLES =====================
function monotoneNonDecreasing(arr) { for (let i = 1; i < arr.length; i++) if (arr[i] < arr[i - 1] - 1e-9) return false; return true; }
T('all bar/roll tables are length-10 per tier', () => {
  const tiered = { SKILL_BAR_T: v4.SKILL_BAR_T, SKILL_ROLL_T: v4.SKILL_ROLL_T, PERCEPTION_ROLL_T: v4.PERCEPTION_ROLL_T, DEXTERITY_BAR_T: v4.DEXTERITY_BAR_T, DEXTERITY_ROLL_T: v4.DEXTERITY_ROLL_T };
  for (const [name, tbl] of Object.entries(tiered)) {
    assert.ok(tbl, name + ' missing');
    for (const tier of ['left', 'center', 'right']) { assert.ok(Array.isArray(tbl[tier]) && tbl[tier].length === 10, name + '.' + tier + ' not length 10'); }
  }
  for (const name of ['PERCEPTION_BAR', 'MEMORY_BAR', 'BAR']) assert.ok(Array.isArray(v4[name]) && v4[name].length === 10, name + ' not length 10');
});
T('DET bar tables exist, length-10, and ramp non-decreasing per tier', () => {
  for (const name of ['DET_SKILL_BAR_T', 'DET_DEXTERITY_BAR_T', 'DET_PERCEPTION_BAR_T']) {
    const tbl = v4[name]; assert.ok(tbl, name + ' missing');
    for (const tier of ['left', 'center', 'right']) {
      const a = tbl[tier]; assert.ok(Array.isArray(a) && a.length === 10, name + '.' + tier + ' not length 10');
      assert.ok(monotoneNonDecreasing(a), name + '.' + tier + ' not monotone non-decreasing (deeper must be >= shallower)');
    }
  }
});
T('rhythm tables are GONE (deleted category stays deleted)', () => {
  for (const dead of ['RHYTHM_BAR', 'RHYTHM_BAR_T', 'RHYTHM_ROLL_T', 'RHYTHM_POOL', 'DET_RHYTHM_BAR_T']) {
    assert.ok(!(dead in v4), 'rhythm remnant re-appeared in skillv4 exports: ' + dead);
  }
});
