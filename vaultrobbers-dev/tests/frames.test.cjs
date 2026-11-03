// Frame-transport invariants: frameCount is a stable non-negative integer, client-drawn families serve 0 server frames,
// and getFrame never throws in range / out of range. Pure (startSession/getFrame/frameCount only; no network). Run via `npm test`.
const assert = require('node:assert');
const sg = require('../skillgames.js');
const v4 = require('../skillv4.js');
const GAMES = sg.GAMES;

const servable = new Set();
for (const k of ['luck', 'skill', 'perception', 'dexterity', 'memory']) for (let l = 1; l <= 10; l++) { try { (v4.kindPoolFor(k, l) || []).forEach(g => servable.add(g)); } catch (e) {} }
const SERV = [...servable];

T('frameCount is a deterministic non-negative integer for every live game', () => {
  for (const k of SERV) for (const lvl of [1, 5, 10]) {
    const b = GAMES[k].build('fc|' + k, lvl);
    const a = v4.frameCount(k, b), c = v4.frameCount(k, b);
    assert.ok(Number.isInteger(a) && a >= 0, 'frameCount not a non-neg int: ' + k + '@' + lvl + ' => ' + a);
    assert.strictEqual(a, c, 'frameCount not deterministic: ' + k);
  }
});

T('fate (luck) + dexterity games are client-drawn (0 server frames)', () => {
  const clientDrawn = new Set();
  for (const kind of ['luck', 'dexterity']) for (let l = 1; l <= 10; l++) (v4.kindPoolFor(kind, l) || []).forEach(g => clientDrawn.add(g));
  for (const k of clientDrawn) {
    const fc = v4.frameCount(k, GAMES[k].build('cd|' + k, 5));
    assert.strictEqual(fc, 0, k + ' (client-drawn family) should serve 0 server frames, got ' + fc);
  }
});

T('getFrame never throws (in range or out of range) for every live game', () => {
  for (const k of SERV) {
    let s; try { s = v4.startSession({ gameKey: k, level: 5, seed: 'gf|' + k }); } catch (e) { assert.fail('startSession threw: ' + k + ' :: ' + e.message); }
    assert.ok(s && s.sid, 'no sid: ' + k);
    const fc = 3;
    for (let i = -1; i <= fc + 5; i++) assert.doesNotThrow(() => v4.getFrame(s.sid, i), 'getFrame threw: ' + k + ' i=' + i);
  }
});

T('getFrame on an unknown session id returns falsy, never throws', () => {
  let r; assert.doesNotThrow(() => { r = v4.getFrame('nonexistent-sid-xyz', 0); });
  assert.ok(!r || typeof r === 'object' || typeof r === 'number', 'unexpected getFrame return for unknown sid');
});
