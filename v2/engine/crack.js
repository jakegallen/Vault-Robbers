/* Vault Robbers crack loop - the gameplay core of the server's /api/crack, ported to a pure, client-side function.
   Free-play / open-source build: the frozen config is DETERMINISTIC pure-skill (RTV_DETERMINISTIC on) with CURVE A odds,
   money/mint/onchain/anti-bot all OFF. Everything here is deterministic over (server_seed, client_seed, door, events), so the
   exact prod game plays with no server. The anti-bot monitors, db, run-tokens, honeypots, shadow-gate, dex-auth and onchain
   settlement of the original handler are intentionally dropped (nothing is at stake). Odds math + bars are copied verbatim. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('crypto'), require('./skillgames.js'), require('./skillv4.js'));
  else root.RTVCrack = factory(root.RTVCrypto, root.RTVGames, root.RTVSkillV4);
}(typeof self !== 'undefined' ? self : this, function (crypto, G, V4) {
  'use strict';
  var GAMES = G.GAMES;

  // ---- frozen constants (verbatim from server.js) ----
  var P = [0.86, 0.78, 0.66, 0.54, 0.46, 0.30, 0.185, 0.12, 0.095, 0.024];   // CURVE A backbone
  var LEVELS = P.length;                                                      // 10 chambers
  var HOUSE_EDGE = 0.06;
  var DOORS = { left: { odds: 1.22, tier: 'cautious' }, center: { odds: 1.0, tier: 'standard' }, right: { odds: 0.72, tier: 'greedy' } };
  var DETERMINISTIC = true;                                                   // frozen: pure-skill, no rarity roll on non-luck
  var DET_CLEAR = [0.77, 0.64, 0.56, 0.47, 0.33, 0.28, 0.16, 0.12, 0.09, 0.05];
  var _DET_BARVAR = [0.14, 0.12, 0.10, 0.08, 0.06, 0.03, 0.015, 0, 0, 0];
  var PERCEPTION_MULTI = true;
  var JACKPOT_SEED_ETH = 3.2, POT_SEED_RVLT = 250000;                         // cosmetic counters only

  // ---- seeded helpers (verbatim) ----
  function roll(serverSeed, clientSeed, nonce) {
    var h = crypto.createHmac('sha256', serverSeed).update(clientSeed + ':' + nonce).digest('hex');
    return parseInt(h.slice(0, 13), 16) / 0x10000000000000;
  }
  var _hb = function (seed, tag) { return crypto.createHmac('sha256', seed).update(tag).digest(); };
  var _u = function (buf, i) { return buf.readUInt32BE((i % 8) * 4) / 0xffffffff; };
  function doorTierMap(seed, level) {
    var pos = ['left', 'center', 'right'], pool = ['left', 'center', 'right'], out = {};
    for (var i = 0; i < pos.length; i++) { var u = _u(_hb(String(seed || 'x'), 'tiermap:' + level + ':' + i), 0); var j = Math.min(pool.length - 1, Math.floor(u * pool.length)); out[pos[i]] = pool.splice(j, 1)[0]; }
    return out;
  }
  var tierCol = function (seed, level, door) { var m = seed ? doorTierMap(seed, level) : null; return (m && m[door]) || door; };

  // door categories per chamber (verbatim; deterministic Fisher-Yates over the seed)
  function chamberCategories(seed, level) {
    var kinds = DETERMINISTIC ? (level >= 6 ? ['dexterity', 'luck'] : ['luck', 'skill', 'perception', 'dexterity']) : ['luck', 'skill', 'perception', 'dexterity'];
    var b = _hb(seed, 'cat:' + level), d3;
    if (kinds.length >= 3) {
      var arr = kinds.slice();
      for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(_u(b, i) * (i + 1)) % (i + 1); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
      d3 = [arr[0], arr[1], arr[2]];
    } else { d3 = [0, 1, 2].map(function (i) { return kinds[Math.floor(_u(b, i + 7) * kinds.length) % kinds.length]; }); }
    return { left: d3[0], center: d3[1], right: d3[2] };
  }
  function gameForDoor(seed, level, door) { return { kind: chamberCategories(seed, level)[door] || 'skill' }; }
  function doorsLayout(seed, level) { var cat = chamberCategories(seed, level), out = {}; ['left', 'center', 'right'].forEach(function (s) { out[s] = { category: cat[s] }; }); return out; }

  // deterministic effective bar for a door (verbatim)
  function detBar(kind, dt, lvl, door, seed) {
    var bar = kind === 'perception' ? ((V4.DET_PERCEPTION_BAR_T) ? V4.DET_PERCEPTION_BAR_T[dt][lvl - 1] : 0.5)
      : kind === 'dexterity' ? (V4.DET_DEXTERITY_BAR_T || V4.DEXTERITY_BAR_T)[dt][lvl - 1]
        : (V4.DET_SKILL_BAR_T || V4.SKILL_BAR_T)[dt][lvl - 1];
    if (kind === 'dexterity' || kind === 'skill') { var sp = _DET_BARVAR[lvl - 1] || 0; if (sp > 0) { var o = (_u(_hb(String(seed) + ':' + door + ':' + lvl, 'barvar'), 3) * 2 - 1) * sp; bar = Math.max(0.05, Math.min(0.97, bar + o)); } }
    return bar;
  }

  var baseOdds = function (lvl, door) { return Math.min(0.97, (DETERMINISTIC ? DET_CLEAR : P)[lvl - 1] * ((DOORS[door] || DOORS.center).odds)); };
  var stepReward = function (lvl, door) { return (1 - HOUSE_EDGE) / baseOdds(lvl, door); };
  var POT_LADDER = { 5: 0.01, 6: 0.03, 7: 0.10, 8: 0.20, 9: 0.30, 10: 1.0 };
  var potShareFor = function (level) { return POT_LADDER[level] || 0; };

  // rebuild the EXACT challenge for (seed, level, door) - mirror of server v4Challenge (perception multi-round aware)
  function v4Challenge(seed, level, door, kind) {
    var pool = V4.kindPoolFor(kind || 'skill', level);
    var h = crypto.createHash('sha256').update(seed + ':v4:' + door + ':' + level).digest();
    var gk = pool[h.readUInt32BE(0) % pool.length];
    var isPerc = GAMES[gk] && GAMES[gk].family === 'perception';
    if (isPerc && PERCEPTION_MULTI) {
      var K = V4.percRounds(level), eLvl = V4.percEffLevel(level), base = seed + ':' + door;
      var rounds = [], seen = {};
      for (var k = 0; k < K; k++) {
        var b, sig, salt = 0;
        do { b = GAMES[gk].build(base + ':pr' + k + (salt ? ':s' + salt : ''), eLvl); sig = gk + '|' + JSON.stringify(b.pixels || {}) + '|' + JSON.stringify(b.secret || {}); salt++; } while (seen[sig] && salt < 24);
        seen[sig] = 1; rounds.push({ gk: gk, built: b });
      }
      var first = rounds[0].built;
      var built = { data: { mode: 'perc', multi: true, K: K, deadlineMs: (first.data && first.data.deadlineMs) || 5000, rounds: rounds.map(function (rb) { return rb.built.data; }) }, secret: first.secret, _rounds: rounds };
      return { gk: gk, built: built };
    }
    return { gk: gk, built: GAMES[gk].build(seed + ':' + door, level) };
  }

  // grade (perception multi-round MIN gate; else single) - mirror of server
  function gradeV4(gk, built, level, events) {
    events = Array.isArray(events) ? events : [];
    if (built && built.data && built.data.multi && Array.isArray(built._rounds)) {
      var all = 1;
      for (var k = 0; k < built._rounds.length; k++) {
        var pick = events.find(function (e) { return e && e.type === 'pick' && (e.round | 0) === k; });
        var rs = GAMES[built._rounds[k].gk].grade(built._rounds[k].built, level, pick ? [{ type: 'pick', idx: pick.idx }] : []);
        if (rs < all) all = rs;
      }
      return all;
    }
    return GAMES[gk].grade(built, level, events);
  }

  // honest loss reveal (faithful, trimmed): teaches the push-your-luck lesson. Safe after grade.
  function lossReveal(kind, gk, level, score, built) {
    try {
      if (kind === 'perception') return { mini: 'perception', msg: 'Your read missed the mark. Look closer next time.' };
      if (kind === 'dexterity') { var db = (V4.DEXTERITY_BAR_T.center)[level - 1]; return (score >= db) ? { mini: 'dexterity', msg: 'Clean hands, unlucky vault. The line held this time.' } : { mini: 'dexterity', msg: 'The line got away from you. Steadier hands next time.' }; }
      if (kind === 'luck') return { mini: 'luck', msg: 'The tumblers did not fall your way. That is the chance you took.' };
      if (typeof GAMES[gk].reveal === 'function') { var rv = GAMES[gk].reveal(built, []); if (rv) return rv; }
      return { mini: 'skill', msg: 'So close. This deep the lock demands a near-flawless crack and you came up just short.' };
    } catch (e) { return null; }
  }

  // ---- public: enter + crack ----
  function enter(clientSeed) {
    var serverSeed = crypto.randomBytes(32).toString('hex');
    var serverHash = crypto.createHash('sha256').update(serverSeed).digest('hex');
    var cseed = String(clientSeed || crypto.randomBytes(8).toString('hex')).slice(0, 64);
    var runId = 'r' + crypto.randomBytes(12).toString('hex');
    var run = { runId: runId, server_seed: serverSeed, server_hash: serverHash, client_seed: cseed, nonce: 0, depth: 0, mult: 1, status: 'open' };
    return { run: run, resp: { runId: runId, serverHash: serverHash, clientSeed: cseed, runToken: '', fee: 0, burned: 0, chips: 0, holder: false, levels: LEVELS, doors: doorsLayout(serverSeed, 1) } };
  }

  // the door challenge to render (mini/start): rebuild + hand the client the answer-free descriptor
  function doorChallenge(run, door) {
    var level = (run.depth | 0) + 1; if (level > LEVELS) return null;
    var kind = gameForDoor(run.server_seed, level, door).kind;
    var vc = v4Challenge(run.server_seed, level, door, kind);
    var sbar = (kind === 'perception' ? V4.PERCEPTION_BAR : kind === 'dexterity' ? V4.DEXTERITY_BAR : V4.BAR)[level - 1];
    return { v4: true, gameKey: vc.gk, kind: kind, door: door, level: level, data: vc.built.data, frames: V4.frameCount(vc.gk, vc.built), hasAudio: false, flashMs: (vc.built.data && vc.built.data.flashMs) || 0, minMs: 0, bar: sbar, _built: vc.built };
  }

  function crack(run, door, events) {
    var level = (run.depth | 0) + 1;
    if (level > LEVELS) return { run: run, resp: { error: 'cleared' } };
    var seed = run.server_seed, cseed = run.client_seed;
    var kind = gameForDoor(seed, level, door).kind;
    var vc = v4Challenge(seed, level, door, kind);
    var gk = vc.gk, built = vc.built;
    var score = (kind === 'luck') ? 0 : Math.max(0, Math.min(1, gradeV4(gk, built, level, events) || 0));
    var col = tierCol(seed, level, door);
    var dt = (col && V4.SKILL_BAR_T[col]) ? col : 'center';
    var nonce = (run.nonce | 0) + 1;
    var r = roll(seed, cseed, nonce);
    var failedMini = kind !== 'luck' && !(score > 0);
    var success;
    if (kind === 'luck') success = r < baseOdds(level, door);
    else { var bar = detBar(kind, dt, level, door, seed); success = !failedMini && (score >= bar); }

    var run2 = { runId: run.runId, server_seed: seed, server_hash: run.server_hash, client_seed: cseed, nonce: nonce, depth: run.depth | 0, mult: run.mult || 1, status: 'open' };
    if (success) {
      run2.depth = level; run2.mult = (run.mult || 1) * stepReward(level, col);
      var robbed = level === LEVELS;
      if (robbed) run2.status = 'robbed';
      var resp = { success: true, level: level, door: door, gameKey: gk, kind: kind, score: score, potShare: potShareFor(level), robbed: robbed, doors: robbed ? undefined : doorsLayout(seed, level + 1), serverSeed: robbed ? seed : undefined, depth: level, mult: run2.mult };
      if (robbed) { resp.jackpotEth = JACKPOT_SEED_ETH; resp.won = { rvltWon: POT_SEED_RVLT }; }
      return { run: run2, resp: resp };
    }
    run2.status = 'busted';
    return { run: run2, resp: { success: false, level: level, door: door, gameKey: gk, kind: kind, score: score, serverSeed: seed, reveal: lossReveal(kind, gk, level, score, built), depth: run.depth | 0, busted: true } };
  }

  return { enter: enter, crack: crack, doorChallenge: doorChallenge, doorsLayout: doorsLayout, gameForDoor: gameForDoor, v4Challenge: v4Challenge, gradeV4: gradeV4, LEVELS: LEVELS, P: P, DET_CLEAR: DET_CLEAR, baseOdds: baseOdds, stepReward: stepReward, potShareFor: potShareFor, JACKPOT_SEED_ETH: JACKPOT_SEED_ETH, POT_SEED_RVLT: POT_SEED_RVLT };
}));
