'use strict';
/*
 * Vault Robbers — SECURE TRANSPORT: per-game frame rendering (Skill Engine v4).
 * Turns a built challenge's answer-bearing `pixels`/`secret` into opaque media the browser can only PERCEIVE:
 *   renderFrame(gameKey, built, i) -> PNG Buffer (the answer content for frame/round i), or null when done.
 *   renderAudio(gameKey, built)    -> WAV Buffer (rhythm beats), or null.
 * Layout is derived from `data` (counts/dims) with the SAME formulas the client uses, so the client can
 * overlay its interactive hit-zones exactly over the served image. The ANSWER (which tile/shade/cell/number/
 * shape/arc) exists only in these pixels — never in any JSON the client receives.
 */
const { Canvas, greenL } = require('./pnggen.js');
const SZ = 300;                                   // logical render size; client scales its canvas to match
const BG = [16, 14, 11], ACC = [255, 210, 74], WHITE = [234, 255, 243], GOLD = [255, 210, 74];   // V2: target/safe indicators unified to GOLD to match the How-It-Works look (was green). RED stays = genuine danger only.
const TAU = Math.PI * 2;

// shared layout helpers (client mirrors these)
const gridDims = (n) => { const cols = Math.ceil(Math.sqrt(n)); return { cols, rows: Math.ceil(n / cols) }; };

// ── REACTION-frame shared layout (Jake 2026-09-13): 300-space geometry MIRRORED EXACTLY by the client presenters (rxGridLayout300 /
//    rxPadLayout300 in skillgames-remote.js) so a tap lands on the served pixel it points at. The image is drawn full-bleed into the
//    client play area; the client maps a client-space tap back into this 300-space and reads the same cell/pad index.
const rxGridLayout = (cols, rows) => { const padX = 24, top = 40, bot = 30; const gw = SZ - padX * 2, gh = SZ - top - bot; const cellW = gw / cols, cellH = gh / rows;
  return { cellW, cellH, r: Math.min(cellW, cellH) * 0.36, cx: (i) => padX + (i % cols) * cellW + cellW / 2, cy: (i) => top + Math.floor(i / cols) * cellH + cellH / 2 }; };
const rxPadLayout = (pads) => { const marginX = 20, ph = 64, y = SZ - 104; const pw = (SZ - marginX * 2) / pads; return { pw: pw - 8, ph, y, x: (i) => marginX + i * pw + 4 }; };
// RXPAL as RGB triples (mirrors the client hex palette ['#ff5a3c','#3dff8f','#7fd0ff','#ffd24a','#c874ff'])
const RXPAL = [[255, 90, 60], [61, 255, 143], [127, 208, 255], [255, 210, 74], [200, 116, 255]];
const tol_solid = (rgb) => Array.isArray(rgb) ? rgb : rgb;   // pads are opaque
// colour-call family colours (mirror client CC_HUE + _ccColor shade darkening)
const CC_HUE = [[255, 90, 60], [61, 255, 143], [127, 208, 255], [255, 210, 74], [200, 116, 255]];
const ccColor = (hue, shade) => { const base = CC_HUE[((hue % CC_HUE.length) + CC_HUE.length) % CC_HUE.length]; const m = 1 - Math.max(0, Math.min(1, shade)) * 0.72; return [Math.round(base[0] * m), Math.round(base[1] * m), Math.round(base[2] * m)]; };
// odd-signal glyph drawer in 300-space (mirrors client _rxGlyph shape set; filled polygons via scanline)
function rxGlyph(c, cx, cy, R, shape, rot, col) {
  cx = cx | 0; cy = cy | 0; R = R | 0; const rr = ((rot % 4) + 4) % 4;
  // rotate a point (x,y) about origin by rr quarter-turns, then translate to (cx,cy)
  const rp = (x, y) => { let X = x, Y = y; for (let q = 0; q < rr; q++) { const nx = -Y, ny = X; X = nx; Y = ny; } return [cx + X, cy + Y]; };
  const poly = (pts) => fillPoly(c, pts.map(p => rp(p[0], p[1])), col);
  switch (((shape % 6) + 6) % 6) {
    case 0: poly([[0, -R], [R, R], [-R, R]]); break;                                   // triangle
    case 1: poly([[-R * 0.82, -R * 0.82], [R * 0.82, -R * 0.82], [R * 0.82, R * 0.82], [-R * 0.82, R * 0.82]]); break;   // square
    case 2: { if (rr % 2 === 0) c.circle(cx, cy, (R * 0.9) | 0, col); else c.circle(cx, cy, (R * 0.9) | 0, col); break; }   // circle (rotation-invariant)
    case 3: { const p = []; for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * TAU / 5; p.push([Math.cos(a) * R, Math.sin(a) * R]); } poly(p); break; }   // pentagon
    case 4: poly([[0, -R], [R, 0], [0, R], [-R, 0]]); break;                            // diamond
    default: poly([[-R, -R * 0.5], [R, -R * 0.5], [0, R]]); break;                      // wedge
  }
}
// generic convex/simple polygon scanline fill for the glyph frame
function fillPoly(c, pts, col) {
  let minY = Infinity, maxY = -Infinity; for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  minY = Math.floor(minY); maxY = Math.ceil(maxY);
  for (let y = minY; y <= maxY; y++) { const xs = [];
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b2 = pts[(i + 1) % pts.length]; const y0 = a[1], y1 = b2[1];
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) { const t = (y - y0) / (y1 - y0); xs.push(a[0] + t * (b2[0] - a[0])); } }
    xs.sort((p, q) => p - q); for (let k = 0; k + 1 < xs.length; k += 2) { const x0 = Math.round(xs[k]), x1 = Math.round(xs[k + 1]); for (let x = x0; x <= x1; x++) c.set(x, y, col); } }
}

// 10 distinct shapes for lineup, from pnggen primitives + colour
function shape(c, idx, cx, cy, r, colOverride) {
  const col = colOverride || GOLD;
  if (c.soft) c.soft(cx, cy, (r + 8) | 0, [255, 190, 70], 0.22);   // warm glow behind the glyph → depth
  switch (idx % 10) {
    case 0: c.circle(cx, cy, r, col); break;
    case 1: c.fillRect(cx - r, cy - r, r * 2, r * 2, col); break;
    case 2: c.triangle(cx, cy, r, col); break;
    case 3: { for (let y = -r; y <= r; y++) { const wd = r - Math.abs(y); c.fillRect(cx - wd, cy + y, wd * 2, 1, col); } break; } // diamond
    case 4: c.ring(cx, cy, r, Math.max(3, r * 0.32) | 0, col); break;
    case 5: { const bh = Math.max(2, r * 0.3) | 0; c.fillRect(cx - r, cy - r, r * 2, bh, col); c.fillRect(cx - r, (cy - bh / 2) | 0, r * 2, bh, col); c.fillRect(cx - r, cy + r - bh, r * 2, bh, col); break; } // stacked bars (neutral — replaced the cross; no religious symbols in the glyph set)
    case 6: { for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; c.circle(cx + Math.cos(a) * r * 0.6 | 0, cy + Math.sin(a) * r * 0.6 | 0, Math.max(2, r * 0.28) | 0, col); } break; } // hex-dots
    case 7: c.circle(cx, cy, (r * 0.6) | 0, col); break;
    case 8: c.arcBand(cx, cy, r, Math.max(4, r * 0.5) | 0, -0.5, 1.7, col); break; // wedge
    default: { c.fillRect(cx - r * 0.25, cy - r, r * 0.5, r, col); c.fillRect(cx - r, cy, r * 0.5, r, col); break; } // bolt-ish
  }
}

// directional arrow glyph in 300-space (dir: 0=up 1=right 2=down 3=left) — a filled shaft + head, drawn via fillPoly so it reads at a glance.
function arrow(c, cx, cy, R, dir, col) {
  cx = cx | 0; cy = cy | 0; R = R | 0; col = col || GOLD; const d = ((dir % 4) + 4) % 4;
  // base points for an UP arrow, then rotate d quarter-turns clockwise to the requested heading
  const base = [[0, -R], [R * 0.66, -R * 0.1], [R * 0.28, -R * 0.1], [R * 0.28, R], [-R * 0.28, R], [-R * 0.28, -R * 0.1], [-R * 0.66, -R * 0.1]];
  const rp = (x, y) => { let X = x, Y = y; for (let q = 0; q < d; q++) { const nx = -Y, ny = X; X = nx; Y = ny; } return [cx + X, cy + Y]; };
  fillPoly(c, base.map(p => rp(p[0], p[1])), col);
}

// pad glyph for Go/No-Go (sh: 0 circle, 1 square, 2 triangle, 3 diamond) in the chosen colour — no warm glow so the hue reads true.
function padGlyph(c, sh, cx, cy, r, col) { cx = cx | 0; cy = cy | 0; r = r | 0; if (sh === 1) { c.fillRect(cx - r, cy - r, r * 2, r * 2, col); } else if (sh === 2) { c.triangle(cx, cy, r, col); } else if (sh === 3) { for (let y = -r; y <= r; y++) { const wd = r - Math.abs(y); c.fillRect(cx - wd, cy + y, wd * 2, 1, col); } } else { c.circle(cx, cy, r, col); } }

function banner(c) { c.fillRect(0, 0, SZ, 2, ACC); }

function renderFrame(gameKey, b, i) {
  i = i | 0; const c = new Canvas(SZ, SZ, BG); banner(c);
  // NERVE gauge render path removed 2026-09-12 (Nerve game permanently deleted).
  // ── SKILL V3 anti-cheat targets (Jake 2026-09-11): the RANDOM target for these 6 skill games lives ONLY here (was leaking in
  //    `data`). Transparent one-shot PNG; the presenter overlays it via skMap (300-space -> centered square) and draws the moving
  //    dial/marker from data motion. Geometry mirrors each presenter EXACTLY so the human sees the target in the same place.
  if (gameKey === 'spatial') {
    if (i >= b.secret.cells.length) return null; const side = Math.sqrt(b.data.grid) | 0; const pad = 30, cell = (SZ - pad * 2) / side; const lit = b.secret.cells[i];
    for (let g = 0; g < b.data.grid; g++) { const x = pad + (g % side) * cell, y = pad + Math.floor(g / side) * cell; c.fillRect((x + 3) | 0, (y + 3) | 0, (cell - 6) | 0, (cell - 6) | 0, g === lit ? ACC : [34, 32, 28]); }
    return c.png();
  }
  if (gameKey === 'lineup' || gameKey === 'reverse') { if (i >= b.secret.seq.length) return null; shape(c, b.secret.seq[i], SZ / 2 | 0, SZ / 2 | 0, 70); return c.png(); }
  if (gameKey === 'safecombo') { if (i >= b.secret.seq.length) return null; const num = b.secret.seq[i], sc = 26, wpx = String(num).length * 4 * sc; c.number(num, (SZ / 2 - wpx / 2) | 0, (SZ / 2 - 65) | 0, sc, WHITE); return c.png(); }
  if (gameKey === 'colorlock') { if (i >= b.secret.seq.length) return null; const CL = [[61, 255, 143], [54, 208, 224], [255, 210, 74], [255, 122, 89], [185, 140, 255], [255, 90, 140]]; const col = CL[b.secret.seq[i] % CL.length]; c.fillRect(66, 84, 168, 132, col); c.ring(SZ / 2 | 0, SZ / 2 | 0, 92, 4, [8, 14, 10]); return c.png(); }
  if (gameKey === 'bearing') { if (i >= b.secret.seq.length) return null; const dir = b.secret.seq[i], cx = SZ / 2 | 0, cy = SZ / 2 | 0, off = 78; const pts = [[cx, cy - off], [cx + off, cy], [cx, cy + off], [cx - off, cy]]; c.ring(cx, cy, 12, 3, [78, 72, 56]); const p = pts[dir % 4]; c.circle(p[0], p[1], 30, ACC); return c.png(); }
  if (gameKey === 'denoms') { if (i >= b.secret.seq.length) return null; const v = b.secret.seq[i], sc = 16, wpx = String(v).length * 4 * sc; c.number(v, (SZ / 2 - wpx / 2) | 0, (SZ / 2 - 40) | 0, sc, [255, 210, 74]); return c.png(); }
  if (gameKey === 'glyphset') { if (i > 0) return null; const set = b.pixels.set, cols = Math.ceil(Math.sqrt(set.length)), rows = Math.ceil(set.length / cols), pad = 44, cw = (SZ - pad * 2) / cols, ch = (SZ - pad * 2) / rows; for (let j = 0; j < set.length; j++) { const gx = pad + (j % cols) * cw + cw / 2, gy = pad + Math.floor(j / cols) * ch + ch / 2; shape(c, set[j], gx | 0, gy | 0, Math.min(cw, ch) * 0.3 | 0); } return c.png(); }
  if (gameKey === 'ledger') {
    if (i >= b.pixels.amts.length) return null; const a = b.pixels.amts[i], scale = 9, col = a.sign > 0 ? ACC : [255, 77, 94];
    const digits = String(a.v), wpx = digits.length * 4 * scale, totalw = 44 + wpx, x0 = ((SZ - totalw) / 2) | 0, cy = (SZ / 2 - 22) | 0;
    c.fillRect(x0, cy + 16, 28, 7, col); if (a.sign > 0) c.fillRect(x0 + 10, cy + 6, 7, 28, col);   // minus bar; a deposit adds the vertical stroke = plus
    c.number(a.v, x0 + 44, cy, scale, col);
    return c.png();
  }
  if (gameKey === 'simon') {
    if (i >= b.secret.seq.length) return null; const pad = b.secret.seq[i];
    const PADCOL = [[255, 77, 94], [61, 180, 255], [255, 209, 71], [61, 255, 143]];   // client mirrors these 4
    const g = 10, half = (SZ - g * 3) / 2, ox = g, oy = g;
    for (let q = 0; q < 4; q++) { const qx = ox + (q % 2) * (half + g), qy = oy + Math.floor(q / 2) * (half + g); const on = q === pad; const col = PADCOL[q]; const cc = on ? col : [(col[0] * 0.28) | 0, (col[1] * 0.28) | 0, (col[2] * 0.28) | 0]; c.fillRect(qx | 0, qy | 0, half | 0, half | 0, cc); if (on) { c.fillRect(qx | 0, qy | 0, half | 0, 3, WHITE); } }
    return c.png();
  }
  if (gameKey === 'pairs') {
    const cells = b.data.cells; const { cols, rows } = gridDims(cells); const pad = 14, cw = (SZ - pad * 2) / cols, ch = (SZ - pad * 2) / rows;
    const cc = (idx) => ({ cx: pad + (idx % cols) * cw + cw / 2, cy: pad + Math.floor(idx / cols) * ch + ch / 2, rad: Math.min(cw, ch) * 0.32 });
    if (i === 0) { for (let t = 0; t < cells; t++) { const p = cc(t); shape(c, b.secret.layout[t], p.cx | 0, p.cy | 0, p.rad | 0); } return c.png(); }
    const q = b.secret.queries[i - 1]; if (!q) return null; shape(c, q.sym, SZ / 2 | 0, SZ / 2 | 0, 60); return c.png();
  }
  if (gameKey === 'nback') { if (i >= b.secret.seq.length) return null; shape(c, b.secret.seq[i], SZ / 2 | 0, SZ / 2 | 0, 70); return c.png(); }
  if (gameKey === 'journey') {
    if (i >= b.secret.cells.length) return null; const side = Math.sqrt(b.data.grid) | 0; const pad = 30, cell = (SZ - pad * 2) / side;
    for (let g = 0; g < b.data.grid; g++) { const x = pad + (g % side) * cell, y = pad + Math.floor(g / side) * cell; c.fillRect((x + 3) | 0, (y + 3) | 0, (cell - 6) | 0, (cell - 6) | 0, [34, 32, 28]); }
    for (let k = 0; k <= i; k++) { const idx = b.secret.cells[k]; const x = pad + (idx % side) * cell, y = pad + Math.floor(idx / side) * cell; c.fillRect((x + 3) | 0, (y + 3) | 0, (cell - 6) | 0, (cell - 6) | 0, k === i ? ACC : [40, 120, 80]); }
    return c.png();
  }
  if (gameKey === 'heatmap') {
    if (i > 0) return null; const side = Math.sqrt(b.data.grid) | 0; const pad = 30, cell = (SZ - pad * 2) / side; const hot = new Set(b.pixels.hot), warm = new Set(b.pixels.warm);
    for (let gc = 0; gc < b.data.grid; gc++) { const x = pad + (gc % side) * cell, y = pad + Math.floor(gc / side) * cell; const col = hot.has(gc) ? greenL(0.80) : (warm.has(gc) ? greenL(0.44) : [34, 32, 28]); c.fillRect((x + 3) | 0, (y + 3) | 0, (cell - 6) | 0, (cell - 6) | 0, col); }
    return c.png();
  }
  if (gameKey === 'gridrecall') {
    if (i > 0) return null; const side = Math.sqrt(b.data.grid) | 0; const pad = 30, cell = (SZ - pad * 2) / side; const set = new Set(b.secret.cells);
    for (let gc = 0; gc < b.data.grid; gc++) { const x = pad + (gc % side) * cell, y = pad + Math.floor(gc / side) * cell; c.fillRect((x + 3) | 0, (y + 3) | 0, (cell - 6) | 0, (cell - 6) | 0, set.has(gc) ? ACC : [34, 32, 28]); }
    return c.png();
  }
  if (gameKey === 'pulse') {   // Shockwave: gold TARGET RING at radius rT*Rmax (mode skpulse)
    if (i > 0) return null; const t = new Canvas(SZ, SZ); const cx = SZ / 2 | 0, cy = SZ / 2 | 0, Rmax = 120; const R = (b.pixels.rT * Rmax) | 0;
    t.ring(cx, cy, Math.max(2, R), 2, [255, 210, 74, 235]);                       // target ring (answer pixels-only)
    return t.png();
  }
  // ── SEQUENCE anti-leak frames (skill-harden 2026-09-14): safeproc/lockorder used to ship their answer (seq/order) in `data`. Now the
  //    answer-bearing flash renders HERE (answer lives only in these pixels + secret) and is served ONCE via the /api/mini/v4frame one-shot
  //    transport. safeproc = the arrow procedure drawn in a single frame; lockorder = the k locks each stamped with its 1..n order badge.
  if (gameKey === 'safeproc') {
    if (i > 0) return null; const seq = (b.secret && b.secret.seq) || []; const n = seq.length || 1;
    // draw the directional procedure as a row of large gold arrows, left->right, exactly what the client's client-drawn pad uses (0=up 1=right 2=down 3=left)
    const cy = (SZ / 2) | 0; const cw = (SZ - 40) / n; const R = Math.max(14, Math.min(34, (cw * 0.34) | 0));
    for (let k = 0; k < n; k++) { const cx = (20 + cw * k + cw / 2) | 0; arrow(c, cx, cy, R, seq[k] & 3, GOLD); }
    return c.png();
  }
  if (gameKey === 'lockorder') {
    if (i > 0) return null; const s = b.secret || {}; const order = s.order || []; const k = s.k || 4;
    // k locks in a single centered row (mirrors the client's x0/gap layout); the ones in the answer path carry a bright order badge 1..n.
    const cy = (SZ / 2) | 0; const gap = Math.min((SZ - 40) / k, 84); const x0 = (SZ - gap * (k - 1)) / 2;
    // For EACH position in the order, stamp its step number (1..n) beside the lock. A lock can appear more than once (badges stack vertically),
    // so the FULL ordered path is legible in one flash. Digits only (the bitmap font is 0-9), so we draw each step number on its own line.
    const stepsFor = {}; for (let p = 0; p < order.length; p++) { (stepsFor[order[p]] = stepsFor[order[p]] || []).push(p + 1); }
    // LEGIBILITY (Jake 2026-09-15): bigger locks where the row has room, a BRIGHT rim on the numbered (answer-path) locks so they pop, and
    // larger digits (one big digit when a lock is used once; a touch smaller + stacked, ascending top->bottom, when a lock repeats).
    const R = Math.max(24, Math.min(40, (gap * 0.46) | 0));
    for (let lk = 0; lk < k; lk++) { const cx = (x0 + lk * gap) | 0; const steps = stepsFor[lk] || []; const on = steps.length > 0;
      c.circle(cx, cy, R, on ? ACC : [70, 66, 52]); c.ring(cx, cy, R, on ? 4 : 2, on ? [255, 250, 230] : [10, 16, 12]);
      // ONE big, BOLD, pure-black order digit per numbered lock (order is now DISTINCT so it never stacks). Sized to fill the disc + a
      // +1px faux-bold stamp for a heavy, legible glyph (Jake 2026-09-15 legibility fix). The stack path stays only as a defensive fallback.
      const sc = steps.length >= 2 ? 6 : Math.max(9, Math.min(13, (R * 0.32) | 0)), gh = 5 * sc + 3, blockH = steps.length * gh - 3, by0 = (cy - blockH / 2) | 0;
      for (let si = 0; si < steps.length; si++) { const num = steps[si], wpx = String(num).length * 4 * sc, dx = (cx - wpx / 2) | 0, dy = (by0 + si * gh) | 0; c.number(num, dx, dy, sc, [0, 0, 0]); c.number(num, dx + 1, dy, sc, [0, 0, 0]); } }
    return c.png();
  }
  // ── REACTION anti-leak frames (Jake 2026-09-13): gonogo/oddsignal/trapdoor/colourcall used to ship the answer in `data`. Now the
  //    answer-bearing board renders HERE (answer lives only in these pixels + secret) and the client overlays hit-zones on the SAME
  //    300-space layout (rxGridLayout / rxPadLayout below, mirrored client-side). getFrame time-gates these so they can't be pre-fetched.
  if (gameKey === 'gonogo') {
    if (i > 0) return null; const s = b.secret; const cols = s.cols, rows = s.rows, cells = s.cells;
    const L = rxGridLayout(cols, rows); const goSet = new Set(s.goSet), nearSet = new Set(s.nearSet), disSet = new Set(s.disSet || []);
    const dd = b.data || {}; const goC = dd.goColor || [61, 255, 143], noC = dd.noColor || [255, 90, 60], disC = dd.disColor || noC, padShape = dd.padShape | 0, jit = dd.sizeJit || [];
    const off = (s.nearHueOff != null ? s.nearHueOff : 0.3);
    const NEAR = [Math.round(61 + 150 * off), Math.round(255 - 70 * off), Math.round(143 - 90 * off)];
    for (let k = 0; k < cells; k++) { const cx = L.cx(k), cy = L.cy(k), R = L.r; const col = goSet.has(k) ? goC : (nearSet.has(k) ? NEAR : (disSet.has(k) ? disC : noC)); const rr = Math.max(6, (R * (jit[k] || 1)) | 0); padGlyph(c, padShape, cx, cy, rr, col); }
    return c.png();
  }
  if (gameKey === 'oddsignal') {
    if (i > 0) return null; const s = b.secret; const cols = s.cols || b.data.cols, rows = s.rows || b.data.rows, cells = s.cells;
    const L = rxGridLayout(cols, rows);
    for (let k = 0; k < cells; k++) { const isOdd = k === s.oddIdx; const shade = isOdd ? s.oddShade : s.baseShade; const m = Math.max(0, Math.min(1, shade));
      const col = [Math.round(80 + 100 * m), Math.round(110 + 90 * m), Math.round(130 + 90 * m)];
      rxGlyph(c, L.cx(k), L.cy(k), L.r * 0.8, isOdd ? s.oddGlyph : s.baseGlyph, isOdd ? s.oddRot : s.baseRot, col); }
    return c.png();
  }
  // ── PERCEPTION (Jake 2026-09-11): the judged stimulus renders here; the answer (which pile/tile/needle/shade) lives ONLY in
  //    these pixels. Client mirrors the layout fractions to overlay taps; choose-games read client buttons (image = stimulus).
  if (gameKey === 'forgery') { if (i > 0) return null; const cols = b.pixels.cols, PAD = 27, cw = (SZ - 2 * PAD) / cols; const jit = +b.pixels.jit || 0; for (let idx = 0; idx < cols * cols; idx++) { const col = idx % cols, row = (idx / cols) | 0, x = PAD + col * cw, y = PAD + row * cw; let L; if (idx === b.pixels.ans) L = b.pixels.oddL; else { const hgh = (((idx * 2654435761) >>> 0) % 1000) / 1000 - 0.5; L = b.pixels.baseL + hgh * 2 * jit; } c.fillRect((x + 3) | 0, (y + 3) | 0, (cw - 6) | 0, (cw - 6) | 0, greenL(L)); } return c.png(); }
  if (gameKey === 'readdial') { if (i > 0) return null; const cx = (SZ / 2) | 0, cy = (SZ * 0.56) | 0, R = 92, rot = +b.pixels.rot || 0, a0 = -Math.PI * 1.25 + rot, span = Math.PI * 1.5; const bins = (b.pixels.bins | 0) || 4;
    // FIX (Jake 2026-09-14): the arc bands MUST match the client's ascending green->red button palette (dialPal hue 140->0), so the needle's
    // band colour always maps to a real numbered button and the reveal's colour name exists. The old fixed rainbow `q` (green/cyan/yellow/
    // orange/purple/pink) put the needle on purple/cyan segments that had NO matching range button. Generate each band's colour from the SAME hue.
    const h2rgb = (h) => { const s = 0.85, l = 0.58, c1 = (1 - Math.abs(2 * l - 1)) * s, x = c1 * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c1 / 2; let r = 0, g = 0, bl = 0; if (h < 60) { r = c1; g = x; } else if (h < 120) { r = x; g = c1; } else if (h < 180) { g = c1; bl = x; } else if (h < 240) { g = x; bl = c1; } else if (h < 300) { r = x; bl = c1; } else { r = c1; bl = x; } return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((bl + m) * 255)]; };
    for (let k = 0; k < bins; k++) { const hue = 140 * (1 - (bins > 1 ? k / (bins - 1) : 0)); c.arcBand(cx, cy, R, 16, a0 + span * (k / bins), a0 + span * ((k + 1) / bins), h2rgb(hue)); } c.ring(cx, cy, R - 16, 2, [80, 74, 56]); const a = a0 + span * (b.pixels.value / 100); for (let t = 0; t < R - 24; t++) { c.set((cx + Math.cos(a) * t) | 0, (cy + Math.sin(a) * t) | 0, WHITE); c.set((cx + Math.cos(a) * t + 1) | 0, (cy + Math.sin(a) * t) | 0, WHITE); } c.circle(cx, cy, 7, WHITE); return c.png(); }
  if (gameKey === 'peephole') { if (i > 0) return null; const cx = (SZ / 2) | 0, cy = (SZ * 0.30) | 0; const tsz = b.pixels.tsz | 0 || 42; shape(c, b.pixels.target, cx, cy, tsz); const bl = b.pixels.blur; for (let p = 0; p < 3; p++) c.soft(cx, cy, 54, [255, 200, 90], 0.12 * bl + 0.05); c.blendRect(cx - 58, cy - 58, 116, 116, BG, Math.min(0.72, bl * 0.7)); c.fillRect(30, (SZ * 0.55) | 0, SZ - 60, 1, [80, 74, 56]); const cols = b.pixels.opts.length, cw = SZ / cols, oy = (SZ * 0.78) | 0, sz = Math.min(cw * 0.32, 34) | 0; for (let k = 0; k < cols; k++) shape(c, b.pixels.opts[k], (cw * (k + 0.5)) | 0, oy, sz);
    const onz = +b.pixels.optNoise || 0; if (onz > 0) { const oy0 = (SZ * 0.62) | 0, oy1 = (SZ * 0.94) | 0; for (let yy = oy0; yy < oy1; yy++) for (let xx = 8; xx < SZ - 8; xx++) { const hgh = (((xx * 40503341) ^ (yy * 55589779)) >>> 0) % 1000 / 1000; if (hgh < onz * 0.5) c.set(xx, yy, (((xx + yy) & 1) ? [26, 24, 16] : [180, 160, 96])); } }
    return c.png(); }
  if (gameKey === 'shaderank') { if (i > 0) return null; const N = b.pixels.shades.length, cw = SZ / N, y0 = (SZ * 0.6) | 0, hh = (SZ * 0.32) | 0; for (let k = 0; k < N; k++) c.fillRect((cw * k + 6) | 0, y0, (cw - 12) | 0, hh, greenL(b.pixels.shades[k])); return c.png(); }
  if (gameKey === 'muller') { if (i > 0) return null; const L = b.pixels.lens, FI = b.pixels.fins, N = L.length;
    // VARIETY + DEPTH (Jake 2026-09-16): each line now has its OWN length + THICKNESS + CURVATURE + ORIENTATION so the six asked attributes
    // (longest/shortest/thickest/thinnest/curviest/straightest) are all really present in the pixels. All draw-only; the true winner is secret.ans.
    const THK = b.pixels.thick || [], CRV = b.pixels.curv || [], orient = b.pixels.orient || 'h';
    const TILT = b.pixels.tilt || [], JIT = b.pixels.jit || [], HUE = b.pixels.hue || [], bgN = +b.pixels.bgNoise || 0;
    // grid geometry MUST match the client tapgrid hit-test (gx0=0.09*w, gw=0.82*w, gy=30+0.09*playH, gh=0.82*playH). Here playH == SZ-30 is baked
    // into the same fractions of SZ; a tap maps to its cell => the drawn line in that cell.
    const PAD = Math.round(SZ * 0.09), area = SZ - 2 * PAD;
    const LHUE = [[234, 255, 243], [255, 210, 140], [150, 210, 255], [200, 255, 190], [235, 180, 235]];
    if (bgN > 0) { for (let yy = PAD - 6; yy < SZ - PAD + 6; yy++) for (let xx = 12; xx < SZ - 12; xx++) { const hgh = (((xx * 73856093) ^ (yy * 19349663)) >>> 0) % 1000 / 1000; if (hgh < bgN * 0.22) c.set(xx, yy, (((xx + yy) & 1) ? [30, 28, 20] : [70, 66, 50])); } }
    // stamp a thick, possibly-curved dot at (x,y): a filled square of side ~thk following the line
    const stamp = (x, y, col, thk) => { const h = Math.max(1, thk >> 1); for (let ox = -h; ox <= h; ox++) for (let oy = -h; oy <= h; oy++) c.set((x + ox) | 0, (y + oy) | 0, col); };
    const FN = 14;
    // draw one line inside its cell. `cellMid` is the cross-axis centre; length runs along the MAIN axis (horizontal for 'h', vertical for 'v').
    const drawL = (idx, len, thk, crvAmp, fin, cellMid) => { const col = LHUE[(HUE[idx] || 0) % LHUE.length]; const tilt = TILT[idx] || 0, jitA = JIT[idx] || 0; const half = len / 2;
      if (orient === 'h') { const cxc = SZ / 2, x0f = cxc - half, x1f = cxc + half;
        for (let x = Math.round(x0f); x <= Math.round(x1f); x++) { const f = (x - x0f) / Math.max(1, (x1f - x0f)); const bow = crvAmp * Math.sin(f * Math.PI); const yTilt = (f - 0.5) * tilt, yJit = jitA * Math.sin(f * Math.PI * 3); stamp(x, cellMid + yTilt + yJit + bow, col, thk); }
        const od = (fin === 'out'); const y0 = cellMid - 0.5 * tilt, y1 = cellMid + 0.5 * tilt; const seg = (x, y, dir, up) => { for (let t = 0; t < FN; t++) { c.set((x + dir * t) | 0, (y + up * t) | 0, col); c.set((x + dir * t) | 0, (y + up * t + 1) | 0, col); } };
        seg(x0f | 0, y0 | 0, od ? -1 : 1, -1); seg(x0f | 0, y0 | 0, od ? -1 : 1, 1); seg(x1f | 0, y1 | 0, od ? 1 : -1, -1); seg(x1f | 0, y1 | 0, od ? 1 : -1, 1);
      } else { const cyc = SZ / 2, y0f = cyc - half, y1f = cyc + half;
        for (let y = Math.round(y0f); y <= Math.round(y1f); y++) { const f = (y - y0f) / Math.max(1, (y1f - y0f)); const bow = crvAmp * Math.sin(f * Math.PI); const xTilt = (f - 0.5) * tilt, xJit = jitA * Math.sin(f * Math.PI * 3); stamp(cellMid + xTilt + xJit + bow, y, col, thk); }
        const od = (fin === 'out'); const x0 = cellMid - 0.5 * tilt, x1 = cellMid + 0.5 * tilt; const seg = (x, y, up, dir) => { for (let t = 0; t < FN; t++) { c.set((x + dir * t) | 0, (y + up * t) | 0, col); c.set((x + dir * t + 1) | 0, (y + up * t) | 0, col); } };
        seg(x0 | 0, y0f | 0, od ? -1 : 1, -1); seg(x0 | 0, y0f | 0, od ? -1 : 1, 1); seg(x1 | 0, y1f | 0, od ? 1 : -1, -1); seg(x1 | 0, y1f | 0, od ? 1 : -1, 1);
      } };
    if (orient === 'h') { const rowH = area / N; for (let r2 = 0; r2 < N; r2++) drawL(r2, L[r2], THK[r2] || 4, CRV[r2] || 0, FI[r2], (PAD + r2 * rowH + rowH / 2) | 0); }
    else { const colW = area / N; for (let r2 = 0; r2 < N; r2++) drawL(r2, L[r2], THK[r2] || 4, CRV[r2] || 0, FI[r2], (PAD + r2 * colW + colW / 2) | 0); }
    return c.png(); }
  if (gameKey === 'ponzo') { if (i > 0) return null; const W = b.pixels.ws, N = W.length, PAD = 27, rowH = (SZ - 2 * PAD) / N, cxc = SZ / 2, topY = SZ * 0.14, botY = SZ * 0.92; for (let y = topY; y <= botY; y++) { const f = (y - topY) / (botY - topY), half = 22 + f * 96; for (const hx of [cxc - half, cxc + half]) { c.set(hx | 0, y | 0, [120, 110, 80]); c.set((hx + 1) | 0, y | 0, [120, 110, 80]); } } for (let r2 = 0; r2 < N; r2++) { const cy = (PAD + r2 * rowH + rowH / 2) | 0; c.fillRect((cxc - W[r2] / 2) | 0, cy - 6, W[r2] | 0, 12, GOLD); } return c.png(); }
  if (gameKey === 'simcontrast') { if (i > 0) return null;
    // VARIETY (Jake 2026-09-16): target COLOUR is per-seed hue (not always green), so a "match the value under this hue" read; textured backgrounds.
    const hue = (b.pixels.hue == null) ? null : (+b.pixels.hue % 360); const bgTex = +b.pixels.bgTex || 0;
    // value+hue -> RGB. When hue is null fall back to the legacy green tint so old callers are unaffected.
    const shadeCol = (v) => { if (hue == null) return greenL(v); const s = 0.7, l = Math.max(0.05, Math.min(0.95, 0.14 + v * 0.72)); const c1 = (1 - Math.abs(2 * l - 1)) * s, x = c1 * (1 - Math.abs(((hue / 60) % 2) - 1)), m = l - c1 / 2; let r = 0, g = 0, bl = 0; const h = hue; if (h < 60) { r = c1; g = x; } else if (h < 120) { r = x; g = c1; } else if (h < 180) { g = c1; bl = x; } else if (h < 240) { g = x; bl = c1; } else if (h < 300) { r = x; bl = c1; } else { r = c1; bl = x; } return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((bl + m) * 255)]; };
    c.fillRect((SZ * 0.5 - 52) | 0, (SZ * 0.12) | 0, 104, 66, [128, 128, 128]); c.fillRect((SZ * 0.5 - 23) | 0, (SZ * 0.14) | 0, 46, 46, shadeCol(b.pixels.target));
    const N = b.pixels.shades.length, cw = SZ / N, y0 = (SZ * 0.58) | 0, hh = (SZ * 0.34) | 0; for (let k = 0; k < N; k++) { const x = cw * k, g = (b.pixels.bgs[k] * 255) | 0; c.fillRect((x + 4) | 0, y0, (cw - 8) | 0, hh, [g, g, g]);
      // seed background TEXTURE: a faint checker/speckle over each bg so it isn't a flat field (deterministic hash, leaks nothing)
      if (bgTex > 0) { for (let yy = y0; yy < y0 + hh; yy++) for (let xx = (x + 4) | 0; xx < x + cw - 4; xx++) { const hgh = (((xx * 12820163) ^ (yy * 3145739)) >>> 0) % 1000 / 1000; if (hgh < bgTex * 0.3) { const t = Math.max(0, Math.min(255, g + (((xx + yy) & 1) ? -22 : 22))); c.set(xx, yy, [t, t, t]); } } }
      const s = Math.min(cw * 0.5, hh * 0.5) | 0; c.fillRect((x + cw / 2 - s / 2) | 0, (y0 + hh / 2 - s / 2) | 0, s, s, shadeCol(b.pixels.shades[k])); } return c.png(); }
  if (gameKey === 'camobreak') { if (i > 0) return null; const cols = b.pixels.cols, PAD = 27, cw = (SZ - 2 * PAD) / cols;
    // REBUILT (Jake 2026-09-14 audit): BOLD, COARSE, ANGLED stripes (period ~12-16px so they never downsample to a flat fill on mobile). The
    // odd tile breaks the pattern by stripe ANGLE (easy tiers, orientation reads at any scale) or PHASE (deep tiers). Higher-contrast palettes.
    const pal = b.pixels.pal | 0, period = (+b.pixels.period) || 14, baseAng = +b.pixels.baseAng || 0, oddAng = +b.pixels.oddAng || 0, oddPhase = +b.pixels.oddPhase || 0;
    const PALS = [[[210, 180, 92], [40, 34, 18]], [[120, 215, 160], [16, 44, 30]], [[160, 180, 235], [20, 30, 54]], [[225, 150, 160], [44, 22, 28]], [[212, 168, 222], [40, 26, 46]]];
    const onC = PALS[pal % PALS.length][0], offC = PALS[pal % PALS.length][1];
    for (let idx = 0; idx < cols * cols; idx++) { const col = idx % cols, row = (idx / cols) | 0, x0 = PAD + col * cw, y0 = PAD + row * cw; const isOdd = idx === b.pixels.ans, ang = isOdd ? oddAng : baseAng, ca = Math.cos(ang), sa = Math.sin(ang), ph = isOdd ? oddPhase : 0;
      for (let yy = 0; yy < cw - 6; yy++) for (let xx = 0; xx < cw - 6; xx++) { const proj = xx * ca + yy * sa + ph; const on = ((Math.floor(proj / period)) & 1) === 0; c.set((x0 + 3 + xx) | 0, (y0 + 3 + yy) | 0, on ? onC : offC); } } return c.png(); }
  if (gameKey === 'figurenoise') { if (i > 0) return null; const cx = (SZ / 2) | 0, cy = (SZ * 0.28) | 0; const tsz = b.pixels.tsz | 0 || 42; shape(c, b.pixels.target, cx, cy, tsz); const nz = b.pixels.noise; for (let yy = (SZ * 0.06) | 0; yy < SZ * 0.5; yy++) for (let xx = (SZ * 0.2) | 0; xx < SZ * 0.8; xx++) { const hgh = (((xx * 73856093) ^ (yy * 19349663)) >>> 0) % 1000 / 1000; if (hgh < nz) c.set(xx, yy, (((xx + yy) & 1) ? [22, 20, 13] : [210, 190, 110])); } c.fillRect(30, (SZ * 0.55) | 0, SZ - 60, 1, [80, 74, 56]); const cols = b.pixels.opts.length, cw = SZ / cols, oy = (SZ * 0.78) | 0, sz = Math.min(cw * 0.32, 34) | 0; for (let k = 0; k < cols; k++) shape(c, b.pixels.opts[k], (cw * (k + 0.5)) | 0, oy, sz);
    // OPTION NOISE (Jake 2026-09-13): a light speckle over the option row (draw-only; answer is still secret.ans). Uses the same hash field.
    const onz = +b.pixels.optNoise || 0; if (onz > 0) { const oy0 = (SZ * 0.62) | 0, oy1 = (SZ * 0.94) | 0; for (let yy = oy0; yy < oy1; yy++) for (let xx = 8; xx < SZ - 8; xx++) { const hgh = (((xx * 40503341) ^ (yy * 55589779)) >>> 0) % 1000 / 1000; if (hgh < onz * 0.5) c.set(xx, yy, (((xx + yy) & 1) ? [26, 24, 16] : [180, 160, 96])); } }
    return c.png(); }
  return null;
}

// PCM WAV (mono 8kHz) — rhythm beats. Timing (the answer) exists only as audio onsets.
function wavFromSamples(samples, rate) {
  const dl = samples.length * 2, buf = Buffer.alloc(44 + dl);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dl, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(dl, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, samples[i] | 0)), 44 + i * 2);
  return buf;
}
function renderAudio(gameKey, b) {
  if (gameKey !== 'rhythm') return null;
  const rate = 8000, iv = b.secret.iv, total = iv.reduce((a, x) => a + x, 0) + 500, n = Math.ceil(rate * total / 1000), s = new Float64Array(n);
  const beep = (ms) => { const st = Math.floor(rate * ms / 1000), dur = Math.floor(rate * 0.09); for (let k = 0; k < dur; k++) { const t = k / rate; s[st + k] += Math.sin(TAU * 520 * t) * 9000 * Math.exp(-t * 22); } };
  let t = 250; beep(t); for (const g of iv) { t += g; beep(t); }
  const out = new Int16Array(n); for (let k = 0; k < n; k++) out[k] = s[k];
  return wavFromSamples(out, rate);
}

module.exports = { renderFrame, renderAudio, SZ, gridDims };
