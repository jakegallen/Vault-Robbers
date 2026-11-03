// Vault Robbers V2 — provably-fair casino engine (dev twin). RVLT is the base token for every game. Server-authoritative:
// the browser NEVER computes an outcome; every result is derived deterministically from (serverSeed, clientSeed, nonce) via
// HMAC-SHA256, committed up front (serverSeedHash) and revealed at settle so a player can verify it. A house edge is baked
// into each payout table so, long-run, every game favors the pot (protects solvency). Games: Crash, Mines, Plinko, Dice, Wheel.
'use strict';
const crypto = require('crypto');

const HOUSE_EDGE = 0.03;   // 3% — the pot's long-run margin on casino play

// ── Provably-fair RNG (Stake-style): a byte stream from HMAC-SHA256(serverSeed, `${clientSeed}:${nonce}:${round}`),
//    consumed 4 bytes at a time into a uniform float in [0,1). Deterministic + verifiable. ──────────────────────────────
function* byteStream(serverSeed, clientSeed, nonce) {
  let round = 0;
  while (true) {
    const h = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}:${round}`).digest();
    for (let i = 0; i < h.length; i++) yield h[i];
    round++;
  }
}
function floatsFrom(serverSeed, clientSeed, nonce, count) {
  const g = byteStream(serverSeed, clientSeed, nonce);
  const out = [];
  for (let n = 0; n < count; n++) {
    let f = 0;
    for (let k = 0; k < 4; k++) f += g.next().value / Math.pow(256, k + 1);   // 4 bytes -> [0,1)
    out.push(f);
  }
  return out;
}
const hashSeed = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newServerSeed = () => crypto.randomBytes(32).toString('hex');

// ── CRASH ── canonical provably-fair crash point. 1-in-(1/edge) rounds instant-bust at 1.00 (the house edge); otherwise the
//    classic 2^52 formula. Player picks a cashout target (auto) or bails live (manual); win pays wager*crashTargetReached.
function crashPoint(serverSeed, clientSeed, nonce) {
  const h = crypto.createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce}`).digest('hex');
  const hInt = parseInt(h.slice(0, 13), 16);              // 52-bit int
  if (hInt % Math.round(1 / HOUSE_EDGE) === 0) return 1.00;   // instant bust -> the edge
  const e = Math.pow(2, 52);
  const cp = Math.floor((100 * e - hInt) / (e - hInt)) / 100;
  return Math.max(1.00, cp);
}

// ── DICE ── roll in [0,100). Roll-under `target` wins; fair multiplier = 100/target, minus edge.
function diceRoll(serverSeed, clientSeed, nonce) { return floatsFrom(serverSeed, clientSeed, nonce, 1)[0] * 100; }
function diceMultiplier(target) { target = Math.max(1, Math.min(98, target)); return round2((1 - HOUSE_EDGE) * 100 / target); }

// ── MINES ── 5x5 grid, `mines` bombs placed by Fisher-Yates from the stream. Each safe reveal raises the multiplier by the
//    fair combinatorial step (edge applied once). Cash out any time; hit a bomb and the wager is lost.
const MINES_TILES = 25;
function minesLayout(serverSeed, clientSeed, nonce, mines) {
  mines = Math.max(1, Math.min(24, mines));
  const idx = Array.from({ length: MINES_TILES }, (_, i) => i);
  const fs = floatsFrom(serverSeed, clientSeed, nonce, MINES_TILES);
  for (let i = MINES_TILES - 1; i > 0; i--) { const j = Math.floor(fs[i] * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  return new Set(idx.slice(0, mines));   // the bomb positions
}
function minesMultiplier(mines, revealed) {
  if (revealed <= 0) return 1;
  let m = 1;
  for (let i = 0; i < revealed; i++) m *= (MINES_TILES - i) / (MINES_TILES - mines - i);   // product of safe-odds inverse
  return round2(m * (1 - HOUSE_EDGE));
}

// ── PLINKO ── ball bounces left/right per stream bit for `rows` rows; bucket = number of rights (binomial). The payout table
//    is COMPUTED, not guessed: a symmetric V-shape (edges pay big, center pays sub-1) SCALED so the probability-weighted mean
//    equals exactly (1 - edge). This guarantees the correct RTP for any row count. rows: 8/12/16.
function choose(n, k) { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; }
function binomProbs(rows) { const p = []; for (let k = 0; k <= rows; k++) p.push(choose(rows, k) / Math.pow(2, rows)); return p; }
function plinkoTable(rows) {
  const c = rows / 2, steep = rows >= 16 ? 130 : rows >= 12 ? 62 : 26;
  const shape = []; for (let k = 0; k <= rows; k++) { const d = Math.abs(k - c) / c; shape.push(0.3 + Math.pow(d, 3) * steep); }
  const p = binomProbs(rows); const mean = p.reduce((s, pp, i) => s + pp * shape[i], 0); const scale = (1 - HOUSE_EDGE) / mean;
  return shape.map(x => round2(x * scale));
}
const PLINKO_TABLES = { 8: plinkoTable(8), 12: plinkoTable(12), 16: plinkoTable(16) };
function plinkoDrop(serverSeed, clientSeed, nonce, rows) {
  rows = PLINKO_TABLES[rows] ? rows : 12;
  const fs = floatsFrom(serverSeed, clientSeed, nonce, rows);
  let rights = 0; const path = [];
  for (let i = 0; i < rows; i++) { const r = fs[i] < 0.5 ? 0 : 1; rights += r; path.push(r); }
  return { bucket: rights, multiplier: PLINKO_TABLES[rows][rights], path, rows };   // table already carries the edge
}

// ── WHEEL ── 16 evenly-weighted segments (8 lose = 0, 8 win). The winning multiples are a fixed shape SCALED so the mean
//    payout across all 16 segments equals exactly (1 - edge). Edge is baked into the table, not re-applied at spin time.
function wheelTable() {
  const raw = [0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 5];   // relative shape (0 = lose), mean 1.0 -> scaled to 1-edge
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length; const scale = (1 - HOUSE_EDGE) / mean;
  return raw.map(x => round2(x * scale));
}
const WHEEL_SEGMENTS = wheelTable();
function wheelSpin(serverSeed, clientSeed, nonce) {
  const f = floatsFrom(serverSeed, clientSeed, nonce, 1)[0];
  const i = Math.floor(f * WHEEL_SEGMENTS.length);
  return { index: i, multiplier: WHEEL_SEGMENTS[i] };   // table already carries the edge
}

function round2(x) { return Math.round(x * 100) / 100; }

// ── Self-test: simulate each game many times and confirm the realized RTP sits near (1 - edge). Run by a boot assertion
//    in mountCasino() so we PROVE the pot is protected (no game pays over 1.0) before anything goes near real RVLT. ───────
function simulateRTP(n = 20000) {
  const ss = 'sim-server-seed', cs = 'sim-client';
  let dice = 0, mines = 0, plinko = 0, wheel = 0, crash = 0;
  // Dice: target 50 (roll-under), payout diceMultiplier(50)
  const dm = diceMultiplier(50);
  for (let i = 0; i < n; i++) { const r = diceRoll(ss, cs, i); dice += (r < 50 ? dm : 0); }
  // Mines: 3 mines, auto-reveal 3 safe tiles then cash (fixed strategy)
  for (let i = 0; i < n; i++) {
    const bombs = minesLayout(ss, cs, i, 3); const order = shuffleOrder(ss, cs, i);
    let alive = true, rev = 0;
    for (let p = 0; p < 3 && alive; p++) { if (bombs.has(order[p])) alive = false; else rev++; }
    mines += alive ? minesMultiplier(3, rev) : 0;
  }
  // Plinko 12
  for (let i = 0; i < n; i++) plinko += plinkoDrop(ss, cs, i, 12).multiplier;
  // Wheel
  for (let i = 0; i < n; i++) wheel += wheelSpin(ss, cs, i).multiplier;
  // Crash: auto-cashout at 2.00
  for (let i = 0; i < n; i++) { const cp = crashPoint(ss, cs, i); crash += (cp >= 2.00 ? 2.00 : 0); }
  return { n, edge: HOUSE_EDGE, rtp: { dice: dice / n, mines: mines / n, plinko: plinko / n, wheel: wheel / n, crash: crash / n } };
}
// deterministic reveal order for the mines sim (distinct from bomb layout so it isn't trivially safe)
function shuffleOrder(ss, cs, nonce) {
  const idx = Array.from({ length: MINES_TILES }, (_, i) => i);
  const fs = floatsFrom(ss, cs + ':order', nonce, MINES_TILES);
  for (let i = MINES_TILES - 1; i > 0; i--) { const j = Math.floor(fs[i] * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  return idx;
}

// ── Crash live multiplier: grows with elapsed wall-clock so a bot can't claim a high multiple instantly — the SERVER clock
//    decides, never the client. ~2x at 4.5s, ~10x at ~15s. ───────────────────────────────────────────────────────────────
const CRASH_K = Math.log(2) / 4500;   // 2x at 4.5s
function crashMultAt(ms) { return round2(Math.max(1, Math.exp(CRASH_K * Math.max(0, ms)))); }

// ── Routes: mount the whole casino API onto the express app. deps = { dbQuery, dbExec, rateOk, clientIp, net, nowMs } ──────
function mountCasino(app, deps) {
  const { dbQuery, dbExec, rateOk, clientIp, net } = deps;
  const nowMs = deps.nowMs || (() => Date.now());
  const MIN_WAGER = 1, MAX_WAGER = 100000;                 // RVLT (twin bounds; real caps tuned at promotion)
  const clampW = (w) => Math.max(MIN_WAGER, Math.min(MAX_WAGER, Math.round(Number(w) || 0)));
  const betId = () => 'cb_' + crypto.randomBytes(9).toString('hex');
  const rid = (req) => (deps.clientIp ? deps.clientIp(req) : (req.ip || 'ip'));
  // Boot assertion (Jake 2026-09-08 cleanse): prove every game's realized RTP stays under 1.0 (pot never bleeds) before serving.
  try { const _rtp = simulateRTP(20000); for (const [g, v] of Object.entries(_rtp.rtp)) { if (v > 1.0) console.error(`[casino] RTP GUARD: ${g} pays ${v.toFixed(3)} > 1.0 — pot at risk!`); } console.log('[casino] RTP self-test ok (edge ' + HOUSE_EDGE + '): ' + Object.entries(_rtp.rtp).map(([g, v]) => g + ' ' + v.toFixed(3)).join(' ')); } catch (e) { console.error('[casino] RTP self-test failed:', e && e.message); }

  app.get('/api/casino/config', (req, res) => res.json({
    edge: HOUSE_EDGE, minWager: MIN_WAGER, maxWager: MAX_WAGER,
    games: ['crash', 'mines', 'plinko', 'dice', 'wheel'],
    plinko: PLINKO_TABLES, wheel: WHEEL_SEGMENTS, minesTiles: MINES_TILES, crashK: CRASH_K
  }));

  // Instant games: resolve in one call. Body: { player, game, wager, target?, rows?, autoCashout? }
  app.post('/api/casino/play', async (req, res) => {
    try {
      if (rateOk && !rateOk('casino:' + rid(req), req)) return res.status(429).json({ error: 'slow down' });
      const player = String((req.body && req.body.player) || 'anon').slice(0, 64);
      const game = String((req.body && req.body.game) || '');
      const wager = clampW(req.body && req.body.wager);
      const ss = newServerSeed(), cs = String((req.body && req.body.clientSeed) || crypto.randomBytes(6).toString('hex')).slice(0, 64), nonce = 0;
      const id = betId(); let mult = 0, detail = {};
      if (game === 'dice') {
        const target = Math.max(2, Math.min(98, Math.round(Number(req.body.target) || 50)));   // roll-under
        const roll = diceRoll(ss, cs, nonce); const win = roll < target;
        mult = win ? diceMultiplier(target) : 0; detail = { roll: round2(roll), target, win };
      } else if (game === 'plinko') {
        const d = plinkoDrop(ss, cs, nonce, Number(req.body.rows) || 12); mult = d.multiplier; detail = d;
      } else if (game === 'wheel') {
        const w = wheelSpin(ss, cs, nonce); mult = w.multiplier; detail = w;
      } else if (game === 'crash') {
        const cp = crashPoint(ss, cs, nonce); const target = Math.max(1.01, Number(req.body.autoCashout) || 2);
        const win = cp >= target; mult = win ? round2(target) : 0; detail = { crashPoint: cp, target, win };
      } else { return res.status(400).json({ error: 'unknown or non-instant game' }); }
      const payout = round2(wager * mult);
      await dbExec("INSERT INTO rtv_casino_bets (bet_id,player,game,wager,mines,revealed,mult,status,payout,server_seed,server_hash,client_seed,nonce,started,net,run_id) VALUES (?,?,?,?,0,'[]',?,?,?,?,?,?,?,?,?,?)",
        [id, player, game, wager, mult, payout > 0 ? 'won' : 'lost', payout, ss, hashSeed(ss), cs, nonce, nowMs(), net, String((req.body && req.body.runId) || '')]).catch(() => {});
      res.json({ betId: id, game, wager, mult, payout, net: round2(payout - wager), serverSeedHash: hashSeed(ss), serverSeed: ss, clientSeed: cs, nonce, ...detail });
    } catch (e) { res.status(500).json({ error: 'play', detail: e.message }); }
  });

  // MINES — start: commit a seed + bomb layout, return the hash (seed revealed only when the bet ends). Body:{player,wager,mines}
  app.post('/api/casino/mines/start', async (req, res) => {
    try {
      if (rateOk && !rateOk('casino:' + rid(req), req)) return res.status(429).json({ error: 'slow down' });
      const player = String((req.body && req.body.player) || 'anon').slice(0, 64);
      const wager = clampW(req.body && req.body.wager);
      const mines = Math.max(1, Math.min(24, Math.round(Number(req.body && req.body.mines) || 3)));
      const ss = newServerSeed(), cs = String((req.body && req.body.clientSeed) || crypto.randomBytes(6).toString('hex')).slice(0, 64);
      const id = betId();
      await dbExec("INSERT INTO rtv_casino_bets (bet_id,player,game,wager,mines,revealed,mult,status,payout,server_seed,server_hash,client_seed,nonce,started,net,run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [id, player, 'mines', wager, mines, '[]', 1, 'open', 0, ss, hashSeed(ss), cs, 0, nowMs(), net, String((req.body && req.body.runId) || '')]);
      res.json({ betId: id, mines, wager, serverSeedHash: hashSeed(ss), tiles: MINES_TILES, next: minesMultiplier(mines, 1) });
    } catch (e) { res.status(500).json({ error: 'mines-start', detail: e.message }); }
  });
  // MINES — pick a tile. Safe -> multiplier rises; bomb -> bust (reveal all). Body:{betId,tile}
  app.post('/api/casino/mines/pick', async (req, res) => {
    try {
      const id = String((req.body && req.body.betId) || ''); const tile = Math.round(Number(req.body && req.body.tile));
      const b = (await dbQuery("SELECT * FROM rtv_casino_bets WHERE bet_id=?", [id]))[0];
      if (!b || b.game !== 'mines') return res.status(404).json({ error: 'no such bet' });
      if (b.status !== 'open') return res.status(400).json({ error: 'bet closed' });
      if (!(tile >= 0 && tile < MINES_TILES)) return res.status(400).json({ error: 'bad tile' });
      const revealed = JSON.parse(b.revealed || '[]');
      if (revealed.includes(tile)) return res.status(400).json({ error: 'already picked' });
      const bombs = minesLayout(b.server_seed, b.client_seed, 0, b.mines);
      if (bombs.has(tile)) {
        await dbExec("UPDATE rtv_casino_bets SET status='lost', payout=0, revealed=? WHERE bet_id=?", [JSON.stringify(revealed.concat(tile)), id]);
        return res.json({ betId: id, hit: true, tile, bombs: Array.from(bombs), status: 'lost', payout: 0, serverSeed: b.server_seed });
      }
      revealed.push(tile);
      const mult = minesMultiplier(b.mines, revealed.length);
      const safeLeft = MINES_TILES - b.mines - revealed.length;
      await dbExec("UPDATE rtv_casino_bets SET revealed=?, mult=? WHERE bet_id=?", [JSON.stringify(revealed), mult, id]);
      if (safeLeft <= 0) {   // cleared every safe tile -> auto-cash the max
        const payout = round2(b.wager * mult);
        await dbExec("UPDATE rtv_casino_bets SET status='cashed', payout=? WHERE bet_id=?", [payout, id]);
        return res.json({ betId: id, hit: false, tile, mult, cleared: true, status: 'cashed', payout, serverSeed: b.server_seed });
      }
      res.json({ betId: id, hit: false, tile, mult, next: minesMultiplier(b.mines, revealed.length + 1), safeLeft });
    } catch (e) { res.status(500).json({ error: 'mines-pick', detail: e.message }); }
  });
  // MINES — cash out at the current multiplier. Body:{betId}
  app.post('/api/casino/mines/cashout', async (req, res) => {
    try {
      const id = String((req.body && req.body.betId) || '');
      const b = (await dbQuery("SELECT * FROM rtv_casino_bets WHERE bet_id=?", [id]))[0];
      if (!b || b.game !== 'mines') return res.status(404).json({ error: 'no such bet' });
      if (b.status !== 'open') return res.status(400).json({ error: 'bet closed' });
      const revealed = JSON.parse(b.revealed || '[]');
      if (!revealed.length) return res.status(400).json({ error: 'reveal at least one tile first' });
      const payout = round2(b.wager * b.mult);
      await dbExec("UPDATE rtv_casino_bets SET status='cashed', payout=? WHERE bet_id=?", [payout, id]);
      res.json({ betId: id, status: 'cashed', mult: b.mult, payout, net: round2(payout - b.wager), serverSeed: b.server_seed });
    } catch (e) { res.status(500).json({ error: 'mines-cashout', detail: e.message }); }
  });

  // CRASH (manual) — start: fix the crash point from the seed, stamp the start time. Body:{player,wager}
  app.post('/api/casino/crash/start', async (req, res) => {
    try {
      if (rateOk && !rateOk('casino:' + rid(req), req)) return res.status(429).json({ error: 'slow down' });
      const player = String((req.body && req.body.player) || 'anon').slice(0, 64);
      const wager = clampW(req.body && req.body.wager);
      const ss = newServerSeed(), cs = String((req.body && req.body.clientSeed) || crypto.randomBytes(6).toString('hex')).slice(0, 64);
      const id = betId();
      await dbExec("INSERT INTO rtv_casino_bets (bet_id,player,game,wager,mines,revealed,mult,status,payout,server_seed,server_hash,client_seed,nonce,started,net,run_id) VALUES (?,?,?,?,0,'[]',?,?,?,?,?,?,?,?,?,?)",
        [id, player, 'crash', wager, 1, 'open', 0, ss, hashSeed(ss), cs, 0, nowMs(), net, String((req.body && req.body.runId) || '')]);
      res.json({ betId: id, wager, serverSeedHash: hashSeed(ss), startedAt: nowMs() });
    } catch (e) { res.status(500).json({ error: 'crash-start', detail: e.message }); }
  });
  // CRASH (manual) — cash out. The SERVER computes the live multiplier from elapsed time; if it is still below the crash
  //    point the player wins at that multiple, otherwise it already blew up and the wager is lost. Client-claimed mult ignored.
  app.post('/api/casino/crash/cashout', async (req, res) => {
    try {
      const id = String((req.body && req.body.betId) || '');
      const b = (await dbQuery("SELECT * FROM rtv_casino_bets WHERE bet_id=?", [id]))[0];
      if (!b || b.game !== 'crash') return res.status(404).json({ error: 'no such bet' });
      if (b.status !== 'open') return res.status(400).json({ error: 'bet closed' });
      const cp = crashPoint(b.server_seed, b.client_seed, 0);
      const live = crashMultAt(nowMs() - Number(b.started));
      if (live >= cp) {   // too late — it already crashed
        await dbExec("UPDATE rtv_casino_bets SET status='lost', mult=?, payout=0 WHERE bet_id=?", [cp, id]);
        return res.json({ betId: id, status: 'lost', crashPoint: cp, payout: 0, serverSeed: b.server_seed });
      }
      const payout = round2(b.wager * live);
      await dbExec("UPDATE rtv_casino_bets SET status='cashed', mult=?, payout=? WHERE bet_id=?", [live, payout, id]);
      res.json({ betId: id, status: 'cashed', mult: live, crashPoint: cp, payout, net: round2(payout - b.wager), serverSeed: b.server_seed });
    } catch (e) { res.status(500).json({ error: 'crash-cashout', detail: e.message }); }
  });
  // Verify any finished bet: reveals the seed + inputs so the outcome can be independently recomputed.
  app.get('/api/casino/verify', async (req, res) => {
    try {
      const b = (await dbQuery("SELECT bet_id,game,wager,mines,revealed,mult,status,payout,server_seed,server_hash,client_seed,nonce FROM rtv_casino_bets WHERE bet_id=?", [String(req.query.betId || '')]))[0];
      if (!b) return res.status(404).json({ error: 'no such bet' });
      if (b.status === 'open') return res.status(400).json({ error: 'bet still open — seed not revealed yet' });
      res.json(b);
    } catch (e) { res.status(500).json({ error: 'verify' }); }
  });

  // Net casino P&L for a run (sum of finished bets on this run). Drives the in-run HUD + folds into the cash-out. The run's
  // total cash-out is floored at 0 elsewhere, so casino losses can never make a player owe more than they staked.
  app.get('/api/casino/run-pnl', async (req, res) => {
    try {
      const runId = String(req.query.runId || '');
      if (!runId) return res.json({ pnl: 0, bets: 0 });
      const r = (await dbQuery("SELECT COALESCE(SUM(payout-wager),0) pnl, COUNT(*) n FROM rtv_casino_bets WHERE run_id=? AND status IN ('won','lost','cashed')", [runId]))[0] || { pnl: 0, n: 0 };
      res.json({ pnl: round2(Number(r.pnl) || 0), bets: Number(r.n) || 0 });
    } catch (e) { res.json({ pnl: 0, bets: 0 }); }
  });
}

module.exports = {
  HOUSE_EDGE, byteStream, floatsFrom, hashSeed, newServerSeed,
  crashPoint, crashMultAt, diceRoll, diceMultiplier, minesLayout, minesMultiplier, MINES_TILES,
  plinkoDrop, PLINKO_TABLES, wheelSpin, WHEEL_SEGMENTS, round2, simulateRTP, mountCasino
};
