/* Vault Robbers — SKILL ENGINE v4 REMOTE client. Runs the games on the REAL secure transport:
 * fetch answer-free descriptor from /api/skill/start, render server PNG frames (/api/skill/frame) and
 * rhythm WAV (/api/skill/audio), capture input, and grade server-side (/api/skill/grade). The browser
 * NEVER receives the answer as data — only pixels/audio. Presenters overlay hit-zones computed from `data`.
 *
 *   window.RTV_SKILL_REMOTE.run(canvas, {seed?, level, gameKey?}) -> Promise<gradeResult>
 */
(function () {
  'use strict';
  const TAU = Math.PI * 2, SZ = 300, ACC = '#ffd24a', GRN = '#3dff8f', STL = '#7d94a6';   // V2 restyle (Jake 2026-09-10): chrome accent = GOLD. STL = steel = the "hold/less/safe" side of a two-choice button; ACC gold = the "go/more/risk" side. GRN kept for semantic pass/win only.
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json());
  const loadImg = (url) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
  function fit(canvas) { const dpr = Math.min(2, devicePixelRatio || 1); const w = canvas.clientWidth || 320, h = canvas.clientHeight || 320; canvas.width = w * dpr | 0; canvas.height = h * dpr | 0; const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); return { g, w, h }; }
  const toL = (canvas, ev) => { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left) / r.width * SZ, y: (ev.clientY - r.top) / r.height * SZ }; };  // pointer -> 300-logical space (matches render.js)
  const gridDims = (n) => { const cols = Math.ceil(Math.sqrt(n)); return { cols, rows: Math.ceil(n / cols) }; };
  function bg(g, w, h) {
    // V2 "heist instrument panel": a machined gunmetal wall the device is mounted to — NOT the old Tron grid.
    const grad = g.createRadialGradient(w / 2, h * 0.4, 20, w / 2, h * 0.5, Math.max(w, h) * 0.9);
    grad.addColorStop(0, '#1c1a16'); grad.addColorStop(0.5, '#131211'); grad.addColorStop(1, '#050505'); g.fillStyle = grad; g.fillRect(0, 0, w, h);
    // brushed vertical sheen bands (subtle, warm) — reads as milled metal
    g.save(); g.globalAlpha = 0.05; const sheen = g.createLinearGradient(0, 0, w, 0); sheen.addColorStop(0, '#000'); sheen.addColorStop(.28, '#8a7a52'); sheen.addColorStop(.5, '#000'); sheen.addColorStop(.72, '#6a5c3a'); sheen.addColorStop(1, '#000'); g.fillStyle = sheen; g.fillRect(0, 0, w, h); g.restore();
    // faint rivet seams top & bottom of the panel
    g.save(); g.globalAlpha = 0.5; for (const yy of [40, h - 12]) { for (let x = 18; x < w - 8; x += 34) { const rg = g.createRadialGradient(x, yy, 0, x, yy, 3.2); rg.addColorStop(0, 'rgba(255,235,170,.5)'); rg.addColorStop(.5, 'rgba(120,100,60,.5)'); rg.addColorStop(1, 'rgba(0,0,0,.4)'); g.fillStyle = rg; g.beginPath(); g.arc(x, yy, 3.2, 0, TAU); g.fill(); } } g.restore();
    // warm rim-light glow along the top (the "monitor" backlight)
    g.save(); g.globalAlpha = 0.5; const rl = g.createLinearGradient(0, 30, 0, 96); rl.addColorStop(0, 'rgba(255,200,90,.18)'); rl.addColorStop(1, 'rgba(255,200,90,0)'); g.fillStyle = rl; g.fillRect(0, 30, w, 66); g.restore();
    // very subtle scanlines for the CRT-instrument read
    g.save(); g.globalAlpha = 0.03; g.fillStyle = '#ffedb0'; for (let y = 34; y < h; y += 3) g.fillRect(0, y, w, 1); g.restore();
  }
  function banner(g, w, txt) {
    g.save(); g.textAlign = 'center'; g.font = "700 14px 'Chakra Petch',sans-serif"; g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 10; g.fillText(txt, w / 2, 22);
    g.shadowBlur = 0; const tw = g.measureText(txt).width, x0 = w / 2 - tw / 2 - 13, x1 = w / 2 + tw / 2 + 13;
    g.strokeStyle = 'rgba(255,210,74,.6)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x0, 14); g.lineTo(x0, 27); g.moveTo(x1, 14); g.lineTo(x1, 27); g.stroke();   // HUD side brackets
    g.globalAlpha = 0.4; g.beginPath(); g.moveTo(w * 0.13, 29); g.lineTo(w * 0.87, 29); g.stroke();   // underline rule
    g.restore();
  }
  // ── FX KIT (V2 "heist instrument" material layer) ───────────────────────────
  // Shared premium-render helpers so every game reads as a machined device, not flat vector art:
  // brushed-metal discs, beveled rims, engraved ticks, glass sheen, depth vignette, soft contact shadow.
  const easeOutExpo = (x) => x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
  const easeOutBack = (x) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
  const lerp = (a, b, t) => a + (b - a) * t;
  function roundRectPath(g, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  const fx = {
    // depth vignette over the whole play area — cheap, huge readability + "photographed" feel
    vignette(g, w, h) { g.save(); const v = g.createRadialGradient(w / 2, h * 0.52, Math.min(w, h) * 0.28, w / 2, h * 0.52, Math.max(w, h) * 0.72); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,.55)'); g.fillStyle = v; g.fillRect(0, 0, w, h); g.restore(); },
    // soft elliptical contact shadow beneath a device so it sits IN the scene
    contact(g, cx, cy, rx, ry) { g.save(); g.globalAlpha = 0.5; const s = g.createRadialGradient(cx, cy, 0, cx, cy, rx); s.addColorStop(0, 'rgba(0,0,0,.7)'); s.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = s; g.save(); g.translate(cx, cy); g.scale(1, ry / rx); g.beginPath(); g.arc(0, 0, rx, 0, TAU); g.fill(); g.restore(); g.restore(); },
    // brushed-metal disc: warm gunmetal base, directional sheen from top-left, fine concentric grain
    metalDisc(g, cx, cy, r, warm) {
      g.save(); const lg = g.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      if (warm) { lg.addColorStop(0, '#5a4a24'); lg.addColorStop(.28, '#3a2f16'); lg.addColorStop(.5, '#241d0e'); lg.addColorStop(.72, '#3a2f16'); lg.addColorStop(1, '#181307'); }
      else { lg.addColorStop(0, '#3b4148'); lg.addColorStop(.3, '#262b30'); lg.addColorStop(.5, '#171a1e'); lg.addColorStop(.72, '#22272c'); lg.addColorStop(1, '#0e1013'); }
      g.fillStyle = lg; g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
      g.globalAlpha = 0.06; g.strokeStyle = '#ffffff'; for (let rr = r - 3; rr > r * 0.2; rr -= 4) { g.lineWidth = 0.6; g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.stroke(); }  // concentric grain
      g.restore();
    },
    // raised bevel ring: bright top-left arc + dark bottom-right arc → convex machined edge
    bevelRing(g, cx, cy, r, thick, tint) {
      g.save(); g.lineWidth = thick;
      g.strokeStyle = 'rgba(255,255,255,.30)'; g.beginPath(); g.arc(cx, cy, r, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
      g.strokeStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.arc(cx, cy, r, Math.PI * 0.05, Math.PI * 0.95); g.stroke();
      if (tint) { g.globalAlpha = 0.5; g.lineWidth = thick * 0.5; g.strokeStyle = tint; g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.stroke(); }
      g.restore();
    },
    // engraved tick ring: each tick is a dark groove with a 1px light highlight → cut into the metal
    ticks(g, cx, cy, r, n, majorEvery) {
      g.save(); for (let k = 0; k < n; k++) { const a = k / n * TAU - Math.PI / 2; const major = majorEvery && k % majorEvery === 0; const inr = major ? r - 15 : r - 8; const c = Math.cos(a), s = Math.sin(a);
        g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = major ? 3 : 1.4; g.beginPath(); g.moveTo(cx + c * inr, cy + s * inr); g.lineTo(cx + c * (r - 2), cy + s * (r - 2)); g.stroke();
        g.strokeStyle = 'rgba(255,240,200,.35)'; g.lineWidth = major ? 1.2 : 0.7; g.beginPath(); g.moveTo(cx + c * inr + 1, cy + s * inr + 1); g.lineTo(cx + c * (r - 2) + 1, cy + s * (r - 2) + 1); g.stroke(); }
      g.restore();
    },
    // glass sheen: soft specular highlight over the top-left, as if under a curved crystal
    glass(g, cx, cy, r) { g.save(); g.globalCompositeOperation = 'screen'; const gs = g.createRadialGradient(cx - r * 0.4, cy - r * 0.5, r * 0.05, cx - r * 0.4, cy - r * 0.5, r * 1.1); gs.addColorStop(0, 'rgba(255,255,255,.22)'); gs.addColorStop(.4, 'rgba(255,255,255,.05)'); gs.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gs; g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill(); g.restore(); },
    // machined center hub cap
    hub(g, cx, cy, r) { fx.metalDisc(g, cx, cy, r); fx.bevelRing(g, cx, cy, r - 1, 2.5); g.save(); g.fillStyle = 'rgba(0,0,0,.5)'; g.beginPath(); g.arc(cx, cy, r * 0.35, 0, TAU); g.fill(); g.restore(); },
    // beveled panel tile (for grids/keys/trays): glossy top, dark base, gold rim when active
    tile(g, x, y, w, h, r, opt) { opt = opt || {}; g.save(); if (opt.shadow !== false) { g.shadowColor = 'rgba(0,0,0,.5)'; g.shadowBlur = 8; g.shadowOffsetY = 3; } roundRectPath(g, x, y, w, h, r); const base = opt.active ? g.createLinearGradient(x, y, x, y + h) : g.createLinearGradient(x, y, x, y + h); if (opt.active) { base.addColorStop(0, 'rgba(255,220,120,.34)'); base.addColorStop(1, 'rgba(150,110,30,.22)'); } else { base.addColorStop(0, 'rgba(70,78,86,.5)'); base.addColorStop(1, 'rgba(20,24,28,.6)'); } g.fillStyle = base; g.fill(); g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
      roundRectPath(g, x + 1, y + 1, w - 2, h * 0.5, r); g.fillStyle = 'rgba(255,255,255,.08)'; g.fill();  // top gloss
      roundRectPath(g, x + .5, y + .5, w - 1, h - 1, r); g.lineWidth = 1.2; g.strokeStyle = opt.active ? 'rgba(255,214,90,.9)' : 'rgba(255,255,255,.14)'; g.stroke();
      if (opt.active) { g.shadowColor = ACC; g.shadowBlur = 12; g.stroke(); }
      g.restore(); },
    // glowing readout digits (nixie/segment feel) — replaces blocky pixel numbers
    readout(g, txt, cx, cy, size, col) { col = col || '#ffce5a'; g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = "800 " + size + "px 'Chakra Petch','Space Mono',monospace"; g.fillStyle = 'rgba(0,0,0,.5)'; g.fillText(txt, cx + 2, cy + 3); g.shadowColor = col; g.shadowBlur = size * 0.7; g.fillStyle = col; g.fillText(txt, cx, cy); g.shadowBlur = size * 0.3; g.fillStyle = '#fff7e0'; g.globalAlpha = 0.85; g.fillText(txt, cx, cy); g.restore(); },
  };
  const _sparks = [];
  function burst(x, y, col) { for (let i = 0; i < 14; i++) { const a = Math.random() * TAU, sp = 1.5 + Math.random() * 3.5; _sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, col: col || ACC }); } }
  function drawSparks(g) { for (let i = _sparks.length - 1; i >= 0; i--) { const p = _sparks[i]; p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.life -= 0.045; if (p.life <= 0) { _sparks.splice(i, 1); continue; } g.save(); g.globalAlpha = Math.max(0, p.life); g.fillStyle = p.col; g.beginPath(); g.arc(p.x, p.y, 2.4, 0, TAU); g.fill(); g.restore(); } }
  function shake(canvas, mag) { const s = performance.now(); (function d() { const p = (performance.now() - s) / 260; if (p >= 1) { canvas.style.transform = ''; return; } const m = (mag || 8) * (1 - p); canvas.style.transform = 'translate(' + ((Math.random() - .5) * 2 * m).toFixed(1) + 'px,' + ((Math.random() - .5) * 2 * m).toFixed(1) + 'px)'; requestAnimationFrame(d); })(); }
  // draw a server frame image to fill the play area (below the banner)
  function drawFrame(g, img, w, h) { g.drawImage(img, 0, 30, w, h - 30); }
  let _ac; function beep(f) { try { _ac = _ac || new (window.AudioContext || window.webkitAudioContext)(); const o = _ac.createOscillator(), gg = _ac.createGain(); o.frequency.value = f || 700; gg.gain.value = 0.0001; gg.gain.linearRampToValueAtTime(0.16, _ac.currentTime + 0.01); gg.gain.exponentialRampToValueAtTime(0.0001, _ac.currentTime + 0.14); o.connect(gg); gg.connect(_ac.destination); o.start(); o.stop(_ac.currentTime + 0.16); } catch (e) {} }
  // ── SFX KIT: short tactile heist sounds (Web Audio; no assets). One-shot tones with shaped envelopes. ──
  function _tone(freq, dur, type, vol, slideTo) { try { _ac = _ac || new (window.AudioContext || window.webkitAudioContext)(); const t = _ac.currentTime, o = _ac.createOscillator(), gg = _ac.createGain(); o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t); if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur); gg.gain.setValueAtTime(0.0001, t); gg.gain.exponentialRampToValueAtTime(vol || 0.12, t + 0.008); gg.gain.exponentialRampToValueAtTime(0.0001, t + dur); o.connect(gg); gg.connect(_ac.destination); o.start(t); o.stop(t + dur + 0.02); } catch (e) {} }
  const sfx = {
    click() { _tone(880, 0.05, 'square', 0.06); },                                  // tap/pick — crisp
    lock() { _tone(520, 0.09, 'triangle', 0.12); setTimeout(() => _tone(340, 0.12, 'sine', 0.1), 40); },   // mechanism engages
    thunk() { _tone(200, 0.18, 'sine', 0.16, 90); },                                // bank / heavy set
    win() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => _tone(f, 0.16, 'triangle', 0.13), i * 70)); },  // rising chime
    bust() { _tone(180, 0.5, 'sawtooth', 0.16, 55); },                              // fail — descending buzz
    whir() { _tone(140, 0.28, 'sawtooth', 0.05, 420); },                            // spin/charge
  };
  const frameURL = (sid, i) => 'api/skill/frame?sid=' + encodeURIComponent(sid) + '&i=' + i;
  const FU = (st, i) => st.frameURL ? st.frameURL(i) : frameURL(st.sid, i);   // run path passes st.frameURL (run-scoped); arcade uses the /api/skill/frame route keyed by sid

  // ── presenters: each returns the events array; the SERVER grades ──
  async function pOddone(canvas, st) {
    const { g, w, h } = fit(canvas); const { cols, rows } = gridDims(st.data.tiles); const ev = [];
    for (let r = 0; r < st.frames; r++) {
      const img = await loadImg(FU(st, r)); bg(g, w, h); banner(g, w, 'FIND THE ODD TILE  ' + (r + 1) + '/' + st.frames); drawFrame(g, img, w, h);
      await new Promise(res => { function hit(e) { const p = toL(canvas, e); const pad = 14, cw = (SZ - 28) / cols, ch = (SZ - 28) / rows; const gx = (p.x) - pad, gy = (p.y * (SZ / SZ)) - pad; const col = Math.floor(gx / cw), row = Math.floor((p.y - pad) / ch); const idx = row * cols + col; if (col < 0 || col >= cols || idx < 0 || idx >= st.data.tiles) return; ev.push({ type: 'pick', idx }); canvas.removeEventListener('pointerdown', hit); setTimeout(res, 120); } canvas.addEventListener('pointerdown', hit); });
    }
    return ev;
  }
  async function pSpatial(canvas, st) {
    const { g, w, h } = fit(canvas); const side = Math.sqrt(st.data.grid) | 0; const ev = []; const flash = st.flashMs || 500;
    for (let i = 0; i < st.frames; i++) { const img = await loadImg(FU(st, i)); bg(g, w, h); banner(g, w, 'WATCH'); drawFrame(g, img, w, h); await wait(flash); bg(g, w, h); banner(g, w, 'WATCH'); await wait(140); }
    // proportional grid that fits the play area (w × h-30) so ALL side*side cells show (was width-square → deep rows clipped); mirrors the stretched flash so recall lines up with what lit
    const gPadX = 30 / SZ * w, gPadY = 30 / SZ * (h - 30), gCW = (w - gPadX * 2) / side, gCH = ((h - 30) - gPadY * 2) / side, gOY = 30 + gPadY;
    function drawGrid() { bg(g, w, h); banner(g, w, 'REPEAT THE PATH'); for (let c = 0; c < st.data.grid; c++) { const x = gPadX + (c % side) * gCW, y = gOY + Math.floor(c / side) * gCH; fx.tile(g, x + 3, y + 3, gCW - 6, gCH - 6, 7, {}); } }
    drawGrid();
    for (let n = 0; n < st.frames; n++) { await new Promise(res => { function hit(e) { const r = canvas.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w, py = (e.clientY - r.top) / r.height * h; const col = Math.floor((px - gPadX) / gCW), row = Math.floor((py - gOY) / gCH); const idx = row * side + col; if (col < 0 || col >= side || row < 0 || idx < 0 || idx >= st.data.grid) return; ev.push({ type: 'pick', cell: idx }); canvas.removeEventListener('pointerdown', hit); setTimeout(res, 100); } canvas.addEventListener('pointerdown', hit); }); }
    return ev;
  }
  async function pCombo(canvas, st) {
    const { g, w, h } = fit(canvas); const img = await loadImg(FU(st, 0)); const RULE = { sum: 'ADD THEM ALL', max: 'LARGEST', min: 'SMALLEST', sumEven: 'ADD THE EVENS', sumOdd: 'ADD THE ODDS' }[st.data.rule] || 'ADD THEM ALL';
    bg(g, w, h); banner(g, w, 'MEMORISE'); drawFrame(g, img, w, h); g.fillStyle = ACC; g.textAlign = 'center'; g.font = "700 13px 'Chakra Petch',sans-serif"; g.fillText(RULE, w / 2, h - 12);
    await wait((st.flashMs || 900) + st.data.count * 120);
    let entry = ''; const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'];
    return await new Promise(res => {
      function draw() { bg(g, w, h); banner(g, w, RULE + '  =  ?'); fx.readout(g, entry || '_', w / 2, 60, 30, '#ffce5a'); const kw = (w - 40) / 3, kh = (h - 90) / 4; keys.forEach((k, i) => { const x = 20 + (i % 3) * kw, y = 84 + ((i / 3) | 0) * kh; fx.tile(g, x + 3, y + 3, kw - 6, kh - 6, 7, { active: k === 'OK' }); g.fillStyle = k === 'OK' ? '#1a1206' : '#e6ddc8'; g.textAlign = 'center'; g.font = "700 19px 'Chakra Petch',sans-serif"; g.fillText(k, x + kw / 2, y + kh / 2 + 7); }); fx.vignette(g, w, h); }
      draw(); canvas.addEventListener('pointerdown', function hit(e) { const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; const kw = r.width / 3 - 40 / 3, KW = (r.width - 40) / 3, KH = (r.height - 90) / 4; const col = Math.floor((px - 20) / KW), row = Math.floor((py - 84) / KH); const i = row * 3 + col; if (col < 0 || col > 2 || i < 0 || i >= keys.length) return; const k = keys[i]; if (k === 'C') entry = ''; else if (k === 'OK') { canvas.removeEventListener('pointerdown', hit); res([{ type: 'answer', value: parseInt(entry || '-1', 10) }]); return; } else if (entry.length < 3) entry += k; draw(); });
    });
  }
  // shared glyph drawer — mirrors render.js shape() 10 glyphs so recall trays show the SAME shapes that were flashed (not numbers)
  function drawGlyph(gg, idx, cx, cy, rr) { gg.save(); gg.fillStyle = ACC; gg.strokeStyle = ACC; gg.shadowColor = ACC; gg.shadowBlur = 8; switch (idx % 10) { case 0: gg.beginPath(); gg.arc(cx, cy, rr, 0, TAU); gg.fill(); break; case 1: gg.fillRect(cx - rr, cy - rr, rr * 2, rr * 2); break; case 2: gg.beginPath(); gg.moveTo(cx, cy - rr); gg.lineTo(cx + rr, cy + rr); gg.lineTo(cx - rr, cy + rr); gg.closePath(); gg.fill(); break; case 3: gg.beginPath(); gg.moveTo(cx, cy - rr); gg.lineTo(cx + rr, cy); gg.lineTo(cx, cy + rr); gg.lineTo(cx - rr, cy); gg.closePath(); gg.fill(); break; case 4: gg.lineWidth = Math.max(3, rr * 0.32); gg.beginPath(); gg.arc(cx, cy, rr - gg.lineWidth / 2, 0, TAU); gg.stroke(); break; case 5: gg.fillRect(cx - rr * 0.35, cy - rr, rr * 0.7, rr * 2); gg.fillRect(cx - rr, cy - rr * 0.35, rr * 2, rr * 0.7); break; case 6: for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; gg.beginPath(); gg.arc(cx + Math.cos(a) * rr * 0.6, cy + Math.sin(a) * rr * 0.6, Math.max(2, rr * 0.28), 0, TAU); gg.fill(); } break; case 7: gg.beginPath(); gg.arc(cx, cy, rr * 0.6, 0, TAU); gg.fill(); break; case 8: gg.beginPath(); gg.moveTo(cx, cy); gg.arc(cx, cy, rr, -0.5, 1.7); gg.closePath(); gg.fill(); break; default: gg.fillRect(cx - rr * 0.25, cy - rr, rr * 0.5, rr); gg.fillRect(cx - rr, cy, rr * 0.5, rr); break; } gg.restore(); }
  async function pLineup(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = [];
    for (let i = 0; i < st.frames; i++) { const img = await loadImg(FU(st, i)); bg(g, w, h); banner(g, w, 'MEMORISE  ' + (i + 1) + '/' + st.frames); drawFrame(g, img, w, h); await wait(st.flashMs || 700); bg(g, w, h); banner(g, w, 'MEMORISE'); await wait(150); }
    // tray = the 10 option shapes rendered by a static server tray frame index = frames (see render note) — fallback: numbered buttons
    const palette = st.data.palette || 10, cols = 5, rows = Math.ceil(palette / cols);
    const trayCue = (st.data && st.data.transform === 'sort') ? 'TAP LOW \u2192 HIGH  ' : (st.data && st.data.reverse) ? 'TAP IN REVERSE  ' : 'REPEAT THE ORDER  ';
    // SHUFFLE the palette's screen positions once per recall — screen cell p shows option order[p]. Defeats fixed-coordinate replay
    // (a captured run must re-locate each option in the current layout) + adds variety. Grade still keyed on the option idx.
    const order = Array.from({ length: palette }, (_, i) => i); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[order[i], order[j]] = [order[j], order[i]]; }
    function tray(prog) { bg(g, w, h); banner(g, w, trayCue + prog + '/' + st.frames); const pad = 14, tw = (w - pad * 2) / cols, thh = (h - 60) / rows; for (let p = 0; p < palette; p++) { const x = pad + (p % cols) * tw, y = 50 + ((p / cols) | 0) * thh, opt = order[p]; fx.tile(g, x + 3, y + 3, tw - 6, thh - 6, 7, {}); if (st.data && st.data.digits) fx.readout(g, String(opt), x + tw / 2, y + thh / 2, 16, '#ffce5a'); else drawGlyph(g, opt, (x + tw / 2) | 0, (y + thh / 2) | 0, Math.min(tw, thh) * 0.24 | 0); } fx.vignette(g, w, h); }
    for (let n = 0; n < st.frames; n++) { tray(n); await new Promise(res => { function hit(e) { const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; const tw = r.width / cols, thh = (r.height - 60) / rows; const col = Math.floor(px / tw), row = Math.floor((py - 50) / thh); const p = row * cols + col; if (col < 0 || col >= cols || p < 0 || p >= palette) return; ev.push({ type: 'pick', idx: order[p] }); canvas.removeEventListener('pointerdown', hit); setTimeout(res, 100); } canvas.addEventListener('pointerdown', hit); }); }
    return ev;
  }
  // NEW V2 memory presenters (flash server frames -> themed recall tray -> {pick,idx}; server grades)
  async function pColorlock(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = [];
    for (let i = 0; i < st.frames; i++) { const img = await loadImg(FU(st, i)); bg(g, w, h); banner(g, w, 'MEMORISE  ' + (i + 1) + '/' + st.frames); drawFrame(g, img, w, h); await wait(st.flashMs || 700); bg(g, w, h); banner(g, w, 'MEMORISE'); await wait(150); }
    const CL = ['#3dff8f', '#36d0e0', '#ffd24a', '#ff7a59', '#b98cff', '#ff5a8c'], palette = st.data.palette || 6, cols = 3, rows = Math.ceil(palette / cols);
    function tray(prog) { bg(g, w, h); banner(g, w, ((st.data && st.data.transform === 'shift') ? 'SHIFT +' + (st.data.shift || 1) + ' \u2192 NEXT  ' : 'REPEAT THE COLOURS  ') + prog + '/' + st.frames); const pad = 14, tw = (w - pad * 2) / cols, thh = (h - 60) / rows; for (let i = 0; i < palette; i++) { const x = pad + (i % cols) * tw, y = 50 + ((i / cols) | 0) * thh; g.fillStyle = CL[i % CL.length]; g.fillRect(x + 6, y + 6, tw - 12, thh - 12); } }
    for (let n = 0; n < st.frames; n++) { tray(n); await new Promise(res => { function hit(e) { const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; const tw = r.width / cols, thh = (r.height - 60) / rows; const col = Math.floor(px / tw), row = Math.floor((py - 50) / thh); const idx = row * cols + col; if (col < 0 || col >= cols || idx < 0 || idx >= palette) return; ev.push({ type: 'pick', idx }); burst(px, py, CL[idx % CL.length]); canvas.removeEventListener('pointerdown', hit); setTimeout(res, 110); } canvas.addEventListener('pointerdown', hit); }); }
    return ev;
  }
  async function pBearing(canvas, st) {
    // Dead Reckoning: N heading arrows flash one at a time; recall the ONE net/overall direction of the whole path.
    const { g, w, h } = fit(canvas);
    for (let i = 0; i < st.frames; i++) { const img = await loadImg(FU(st, i)); bg(g, w, h); banner(g, w, 'TRACK THE PATH  ' + (i + 1) + '/' + st.frames); drawFrame(g, img, w, h); await wait(st.flashMs || 700); bg(g, w, h); banner(g, w, 'TRACK THE PATH'); await wait(150); }
    const AR = ['↑', '→', '↓', '←'], cols = 4;
    return await new Promise(res => {
      bg(g, w, h); banner(g, w, 'WHICH WAY OVERALL?'); const pad = 14, tw = (w - pad * 2) / cols, thh = (h - 120); for (let i = 0; i < 4; i++) { const x = pad + i * tw, y = 66; fx.tile(g, x + 5, y + 5, tw - 10, thh - 10, 8, {}); g.save(); g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 10; g.textAlign = 'center'; g.font = '700 40px sans-serif'; g.fillText(AR[i], x + tw / 2, y + thh / 2 + 16); g.restore(); } g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('Net direction of the whole path', w / 2, h - 24); fx.vignette(g, w, h);
      canvas.addEventListener('pointerdown', function hit(e) { const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left; const tw = r.width / cols; const idx = Math.floor(px / tw); if (idx < 0 || idx >= 4) return; canvas.removeEventListener('pointerdown', hit); burst(px, r.height / 2, ACC); try { sfx.lock(); } catch (e2) {} setTimeout(() => res([{ type: 'pick', idx }]), 200); });
    });
  }
  async function pDenoms(canvas, st) {
    // Vault Weigh: N coin values flash one at a time; recall their TOTAL via keypad (capture != answer).
    const { g, w, h } = fit(canvas);
    for (let i = 0; i < st.frames; i++) { const img = await loadImg(FU(st, i)); bg(g, w, h); banner(g, w, 'ADD IT UP  ' + (i + 1) + '/' + st.frames); drawFrame(g, img, w, h); await wait(st.flashMs || 800); bg(g, w, h); banner(g, w, 'ADD IT UP'); await wait(150); }
    let entry = ''; const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'];
    return await new Promise(res => {
      function draw() { bg(g, w, h); banner(g, w, 'TOTAL VALUE = ?'); g.fillStyle = '#eafff3'; g.textAlign = 'center'; g.font = "800 30px 'Space Mono',monospace"; g.fillText(entry || '_', w / 2, 70); const kw = (w - 40) / 3, kh = (h - 90) / 4; keys.forEach((k, i) => { const x = 20 + (i % 3) * kw, y = 84 + ((i / 3) | 0) * kh; fx.tile(g, x + 3, y + 3, kw - 6, kh - 6, 7, { active: k === 'OK' }); g.fillStyle = k === 'OK' ? '#1a1206' : '#e6ddc8'; g.font = "700 19px 'Chakra Petch',sans-serif"; g.fillText(k, x + kw / 2, y + kh / 2 + 7); }); }
      draw(); canvas.addEventListener('pointerdown', function hit(e) { const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; const KW = (r.width - 40) / 3, KH = (r.height - 90) / 4; const col = Math.floor((px - 20) / KW), row = Math.floor((py - 84) / KH); const i = row * 3 + col; if (col < 0 || col > 2 || i < 0 || i >= keys.length) return; const k = keys[i]; if (k === 'C') entry = ''; else if (k === 'OK') { canvas.removeEventListener('pointerdown', hit); res([{ type: 'answer', value: parseInt(entry || '-1', 10) }]); return; } else if (entry.length < 5) entry += k; draw(); });
    });
  }
  async function pGlyphset(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = [];
    const img = await loadImg(FU(st, 0)); bg(g, w, h); banner(g, w, 'MEMORISE THE SET'); drawFrame(g, img, w, h); await wait(st.flashMs || 1000);
    const palette = st.data.palette || 10, cols = 5, rows = 2, K = st.data.k || 3; const picked = new Set();
    const sgGlyph = (gg, idx, cx, cy, rr) => { gg.save(); gg.fillStyle = ACC; gg.strokeStyle = ACC; switch (idx % 10) { case 0: gg.beginPath(); gg.arc(cx, cy, rr, 0, TAU); gg.fill(); break; case 1: gg.fillRect(cx - rr, cy - rr, rr * 2, rr * 2); break; case 2: gg.beginPath(); gg.moveTo(cx, cy - rr); gg.lineTo(cx + rr, cy + rr); gg.lineTo(cx - rr, cy + rr); gg.closePath(); gg.fill(); break; case 3: gg.beginPath(); gg.moveTo(cx, cy - rr); gg.lineTo(cx + rr, cy); gg.lineTo(cx, cy + rr); gg.lineTo(cx - rr, cy); gg.closePath(); gg.fill(); break; case 4: gg.lineWidth = Math.max(3, rr * 0.32); gg.beginPath(); gg.arc(cx, cy, rr - gg.lineWidth / 2, 0, TAU); gg.stroke(); break; case 5: gg.fillRect(cx - rr * 0.35, cy - rr, rr * 0.7, rr * 2); gg.fillRect(cx - rr, cy - rr * 0.35, rr * 2, rr * 0.7); break; case 6: for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; gg.beginPath(); gg.arc(cx + Math.cos(a) * rr * 0.6, cy + Math.sin(a) * rr * 0.6, Math.max(2, rr * 0.28), 0, TAU); gg.fill(); } break; case 7: gg.beginPath(); gg.arc(cx, cy, rr * 0.6, 0, TAU); gg.fill(); break; case 8: gg.beginPath(); gg.moveTo(cx, cy); gg.arc(cx, cy, rr, -0.5, 1.7); gg.closePath(); gg.fill(); break; default: gg.fillRect(cx - rr * 0.25, cy - rr, rr * 0.5, rr); gg.fillRect(cx - rr, cy, rr * 0.5, rr); break; } gg.restore(); };
    function tray() { bg(g, w, h); banner(g, w, 'PICK THE ' + K + ' YOU SAW  (' + picked.size + '/' + K + ')'); const pad = 12, tw = (w - pad * 2) / cols, thh = (h - 110) / rows; for (let i = 0; i < palette; i++) { const x = pad + (i % cols) * tw, y = 50 + ((i / cols) | 0) * thh; fx.tile(g, x + 3, y + 3, tw - 6, thh - 6, 8, { active: picked.has(i) }); sgGlyph(g, i, (x + tw / 2) | 0, (y + thh / 2) | 0, Math.min(tw, thh) * 0.26 | 0); } fx.tile(g, pad, h - 52, w - pad * 2, 40, 9, { active: true }); g.fillStyle = '#1a1206'; g.textAlign = 'center'; g.font = "800 15px 'Chakra Petch',sans-serif"; g.fillText('DONE', w / 2, h - 27); fx.vignette(g, w, h); }
    tray();
    await new Promise(res => { function hit(e) { const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; if (py >= r.height - 58) { canvas.removeEventListener('pointerdown', hit); res(); return; } const tw = r.width / cols, thh = (r.height - 110) / rows; const col = Math.floor(px / tw), row = Math.floor((py - 50) / thh); const idx = row * cols + col; if (col < 0 || col >= cols || idx < 0 || idx >= palette) return; if (picked.has(idx)) { picked.delete(idx); } else if (picked.size < K) { picked.add(idx); ev.push({ type: 'pick', idx }); } burst(px, py, ACC); tray(); if (picked.size >= K) { canvas.removeEventListener('pointerdown', hit); setTimeout(res, 320); } } canvas.addEventListener('pointerdown', hit); });
    return ev;
  }
  // NEW V2 skill presenters: one animated marker over the server target frame; one tap -> {tap,t}. Motion uses st.data (speed/
  // start/etc.) so what the player sees is exactly what the server regrades from tap.t. Geometry mirrors pDial's centered square.
  function skMap(w, h) { const S = h - 30, ox = (w - S) / 2, oy = 30, sc = S / 300; return { S, ox, oy, MX: v => ox + v * sc, MY: v => oy + v * sc, R: v => v * sc }; }
  async function pTapTimed(canvas, st, drawMarker, cue) {
    const { g, w, h } = fit(canvas); const ev = []; const t0 = performance.now(); const M = skMap(w, h); const img = await loadImg(FU(st, 0));
    return await new Promise(resolve => {
      let raf, done = false;
      function frame() { const t = (performance.now() - t0) / 1000; bg(g, w, h); banner(g, w, cue);
        // recessed sensor panel the target sits in → depth
        g.save(); g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 12; g.shadowOffsetY = 4; roundRectPath(g, M.ox - 6, M.oy - 6, M.S + 12, M.S + 12, 12); const pg = g.createLinearGradient(0, M.oy, 0, M.oy + M.S); pg.addColorStop(0, '#14161a'); pg.addColorStop(1, '#0a0b0d'); g.fillStyle = pg; g.fill(); g.restore();
        g.save(); roundRectPath(g, M.ox - 6, M.oy - 6, M.S + 12, M.S + 12, 12); g.clip(); g.drawImage(img, M.ox, M.oy, M.S, M.S); g.restore();
        g.save(); roundRectPath(g, M.ox - 5.5, M.oy - 5.5, M.S + 11, M.S + 11, 12); g.lineWidth = 1.3; g.strokeStyle = 'rgba(255,255,255,.12)'; g.stroke(); g.restore();  // rim highlight
        try { drawMarker(g, M, st.data, t); } catch (e) {} fx.vignette(g, w, h); drawSparks(g); if (!done) raf = requestAnimationFrame(frame); }
      frame();
      function hit() { if (done) return; done = true; const t = Math.round(performance.now() - t0); ev.push({ type: 'tap', t }); try { sfx.lock(); } catch (e) {} shake(canvas, 4); cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); setTimeout(() => resolve(ev), 160); }
      canvas.addEventListener('pointerdown', hit);
    });
  }
  async function pPendulum(canvas, st) { return pTapTimed(canvas, st, (g, M, d, t) => { const p = 0.5 + 0.5 * Math.sin(d.speed * t); const x = M.MX(30 + p * 240), y = M.MY(150); g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 16; g.beginPath(); g.arc(x, y, 10, 0, TAU); g.fill(); g.shadowBlur = 0; }, 'TAP IN THE SAFE BAND'); }
  async function pSlider(canvas, st) { return pTapTimed(canvas, st, (g, M, d, t) => { const p = (d.speed * t) % 1; const x = M.MX(30 + p * 240), y = M.MY(150); g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 16; g.fillRect(x - 3, y - 16, 6, 32); g.shadowBlur = 0; }, 'STOP ON THE NOTCH'); }
  async function pOrbit(canvas, st) { return pTapTimed(canvas, st, (g, M, d, t) => { const a = d.start + d.speed * t, cx = M.MX(150), cy = M.MY(150), R = M.R(100), x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R; g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 16; g.beginPath(); g.arc(x, y, 9, 0, TAU); g.fill(); g.shadowBlur = 0; }, 'TAP ON THE MARK'); }
  async function pCrosshair(canvas, st) { return pTapTimed(canvas, st, (g, M, d, t) => { const x = 0.5 + 0.5 * Math.sin(d.sx * t), y = 0.5 + 0.5 * Math.sin(d.sy * t + 1.7), X = M.MX(30 + x * 240), Y = M.MY(30 + y * 240); const R = 15;
    g.save(); g.translate(X, Y); g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 14; g.lineWidth = 2.2;
    g.beginPath(); g.arc(0, 0, R, 0, TAU); g.stroke();                                    // outer ring
    g.lineWidth = 1.2; g.beginPath(); g.arc(0, 0, R + 4, -0.5, 0.5); g.arc(0, 0, R + 4, Math.PI - 0.5, Math.PI + 0.5); g.stroke();  // side lock ticks
    g.lineWidth = 2; g.beginPath(); g.moveTo(-R - 6, 0); g.lineTo(-5, 0); g.moveTo(5, 0); g.lineTo(R + 6, 0); g.moveTo(0, -R - 6); g.lineTo(0, -5); g.moveTo(0, 5); g.lineTo(0, R + 6); g.stroke();  // gapped hairs
    g.shadowBlur = 0; g.fillStyle = '#fff7e0'; g.beginPath(); g.arc(0, 0, 2.2, 0, TAU); g.fill();  // center dot
    g.restore(); }, 'TAP IN THE BOX'); }
  async function pAlign3(canvas, st) { return pTapTimed(canvas, st, (g, M, d, t) => { const cx = M.MX(150), cy = M.MY(150), radii = [55, 82, 110], rings = d.rings || []; for (let k = 0; k < 3; k++) { const rg = rings[k] || { speed: 1, start: 0 }; const a = rg.start + rg.speed * t, R = M.R(radii[k]), x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R; g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 12; g.beginPath(); g.arc(x, y, 7, 0, TAU); g.fill(); g.shadowBlur = 0; } }, 'ALIGN ALL THREE'); }
  async function pPulse(canvas, st) { return pTapTimed(canvas, st, (g, M, d, t) => { const cx = M.MX(150), cy = M.MY(150), rad = (d.speed * t) % 1, R = M.R(rad * 120); g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 14; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, Math.max(2, R), 0, TAU); g.stroke(); g.shadowBlur = 0; }, 'TAP AT THE TARGET RING'); }
  async function pSimon(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = [];
    const COL = ['#ff4d5e', '#3db4ff', '#ffd147', '#3dff8f'], DIM = ['#5a2129', '#153f57', '#5a4a1a', '#155a33'];
    for (let i = 0; i < st.frames; i++) { const img = await loadImg(FU(st, i)); bg(g, w, h); banner(g, w, 'WATCH  ' + (i + 1) + '/' + st.frames); drawFrame(g, img, w, h); await wait(st.flashMs || 480); bg(g, w, h); banner(g, w, 'WATCH'); await wait(120); }
    const top = 38, gp = 8, cw = (w - gp * 3) / 2, ch = (h - top - gp * 2) / 2;
    const rectOf = (q) => ({ x: gp + (q % 2) * (cw + gp), y: top + gp + ((q / 2 | 0)) * (ch + gp), w: cw, h: ch });
    function board(prog, fq) { bg(g, w, h); banner(g, w, 'REPEAT THE SEQUENCE  ' + prog + '/' + st.frames);
      for (let q = 0; q < 4; q++) { const R = rectOf(q), lit = fq === q; g.save();
        if (lit) { g.shadowColor = COL[q]; g.shadowBlur = 30; }
        roundRectPath(g, R.x, R.y, R.w, R.h, 14); const gr = g.createLinearGradient(R.x, R.y, R.x, R.y + R.h); gr.addColorStop(0, lit ? COL[q] : DIM[q]); gr.addColorStop(1, lit ? DIM[q] : '#0e1012'); g.fillStyle = gr; g.fill(); g.shadowBlur = 0;
        roundRectPath(g, R.x + 4, R.y + 4, R.w - 8, R.h * 0.42, 11); g.fillStyle = lit ? 'rgba(255,255,255,.30)' : 'rgba(255,255,255,.05)'; g.fill();   // top gloss
        roundRectPath(g, R.x + 1, R.y + 1, R.w - 2, R.h - 2, 13); g.lineWidth = 1.5; g.strokeStyle = lit ? '#fff' : 'rgba(255,255,255,.12)'; g.stroke();   // rim
        g.restore(); }
      fx.vignette(g, w, h); }
    for (let n = 0; n < st.frames; n++) { board(n); await new Promise(res => { function hit(e) { const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; let pad = -1; for (let q = 0; q < 4; q++) { const R = rectOf(q); if (px >= R.x && px <= R.x + R.w && py >= R.y && py <= R.y + R.h) { pad = q; break; } } if (pad < 0) return; ev.push({ type: 'pad', pad }); board(n + 1, pad); canvas.removeEventListener('pointerdown', hit); setTimeout(res, 150); } canvas.addEventListener('pointerdown', hit); }); }
    return ev;
  }
  async function pGridRecall(canvas, st) {
    const { g, w, h } = fit(canvas); const side = Math.sqrt(st.data.grid) | 0; const ev = []; const need = st.data.count;
    const img = await loadImg(FU(st, 0)); bg(g, w, h); banner(g, w, 'MEMORISE THE LIT CELLS'); drawFrame(g, img, w, h); await wait(st.flashMs || 900);
    const bt = 34, pad = 12, cell = Math.min((w - pad * 2) / side, (h - bt - pad) / side), ox = (w - cell * side) / 2, oy = bt, picked = new Set();
    function draw() { bg(g, w, h); banner(g, w, 'TAP THE ' + need + ' CELLS  ' + picked.size + '/' + need); for (let c = 0; c < st.data.grid; c++) { const x = ox + (c % side) * cell, y = oy + ((c / side) | 0) * cell; const on = picked.has(c); fx.tile(g, x + 3, y + 3, cell - 6, cell - 6, 7, { active: on }); } }
    draw();
    return await new Promise(res => { function hit(e) { const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; const col = Math.floor((px - ox) / cell), row = Math.floor((py - oy) / cell); const idx = row * side + col; if (col < 0 || col >= side || idx < 0 || idx >= st.data.grid) return; if (!picked.has(idx)) { picked.add(idx); ev.push({ type: 'cell', cell: idx }); draw(); if (picked.size >= need) { canvas.removeEventListener('pointerdown', hit); setTimeout(() => res(ev), 170); } } } canvas.addEventListener('pointerdown', hit); });
  }
  async function pHeatmap(canvas, st) {
    const { g, w, h } = fit(canvas); const side = Math.sqrt(st.data.grid) | 0; const ev = []; const need = st.data.count;
    const img = await loadImg(FU(st, 0)); bg(g, w, h); banner(g, w, 'SPOT THE HOTTEST CELLS'); drawFrame(g, img, w, h); await wait(st.flashMs || 900);
    const bt = 34, pad = 12, cell = Math.min((w - pad * 2) / side, (h - bt - pad) / side), ox = (w - cell * side) / 2, oy = bt, picked = new Set();
    function draw() { bg(g, w, h); banner(g, w, 'TAP THE ' + need + ' HOTTEST  ' + picked.size + '/' + need); for (let c = 0; c < st.data.grid; c++) { const x = ox + (c % side) * cell, y = oy + ((c / side) | 0) * cell; const on = picked.has(c); fx.tile(g, x + 3, y + 3, cell - 6, cell - 6, 7, { active: on }); } }
    draw();
    return await new Promise(res => { function hit(e) { const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; const col = Math.floor((px - ox) / cell), row = Math.floor((py - oy) / cell); const idx = row * side + col; if (col < 0 || col >= side || idx < 0 || idx >= st.data.grid) return; if (!picked.has(idx)) { picked.add(idx); ev.push({ type: 'cell', cell: idx }); draw(); if (picked.size >= need) { canvas.removeEventListener('pointerdown', hit); setTimeout(() => res(ev), 170); } } } canvas.addEventListener('pointerdown', hit); });
  }
  async function pPairs(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const cells = st.data.cells; const cols = Math.ceil(Math.sqrt(cells)), rows = Math.ceil(cells / cols);
    const img0 = await loadImg(FU(st, 0)); bg(g, w, h); banner(g, w, 'MEMORISE THE PAIRS'); drawFrame(g, img0, w, h); await wait(st.flashMs || 1300); bg(g, w, h); banner(g, w, 'MEMORISE'); await wait(180);
    const bt = 56, pad = 12, cw = (w - pad * 2) / cols, ch = (h - bt - pad) / rows;
    const rectOf = (idx) => ({ x: pad + (idx % cols) * cw, y: bt + Math.floor(idx / cols) * ch, w: cw, h: ch });
    for (let n = 0; n < st.frames - 1; n++) {
      const qimg = await loadImg(FU(st, n + 1));
      function draw() { bg(g, w, h); banner(g, w, 'FIND ITS TWIN  ' + (n + 1) + '/' + (st.frames - 1)); g.drawImage(qimg, w / 2 - 26, 28, 52, 52); for (let t = 0; t < cells; t++) { const R = rectOf(t); fx.tile(g, R.x + 3, R.y + 3, R.w - 6, R.h - 6, 7, {}); } }
      draw();
      await new Promise(res => { function hit(e) { const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; const col = Math.floor((px - pad) / cw), row = Math.floor((py - bt) / ch); const idx = row * cols + col; if (col < 0 || col >= cols || idx < 0 || idx >= cells) return; ev.push({ type: 'match', cell: idx }); canvas.removeEventListener('pointerdown', hit); setTimeout(res, 140); } canvas.addEventListener('pointerdown', hit); });
    }
    return ev;
  }
  async function pNback(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const N = st.data.N, step = st.data.stepMs || 1000;
    for (let i = 0; i < st.frames; i++) {
      const img = await loadImg(FU(st, i)); let tapped = false;
      function draw(flash) { bg(g, w, h); banner(g, w, N + '-BACK   MATCH ' + N + ' AGO?'); g.drawImage(img, 0, 30, w, h - 100); const by = h - 46; g.fillStyle = flash ? ACC : 'rgba(255,210,74,.15)'; g.fillRect(w / 2 - 74, by, 148, 36); g.strokeStyle = ACC; g.strokeRect(w / 2 - 74, by, 148, 36); g.fillStyle = flash ? '#02140b' : ACC; g.textAlign = 'center'; g.font = "700 16px 'Chakra Petch',sans-serif"; g.fillText('MATCH', w / 2, by + 24); }
      draw(false);
      await new Promise(resolve => { let done = false; const finish = () => { if (done) return; done = true; clearTimeout(to); canvas.removeEventListener('pointerdown', hit); resolve(); }; function hit(e) { const r = canvas.getBoundingClientRect(); const py = e.clientY - r.top; if (py < h - 60) return; if (!tapped) { tapped = true; ev.push({ type: 'nback', pos: i, hit: true }); draw(true); } } const to = setTimeout(finish, step); canvas.addEventListener('pointerdown', hit); });
    }
    return ev;
  }
  async function pCountflash(canvas, st) {
    const { g, w, h } = fit(canvas); const max = st.data.max || st.frames;
    for (let i = 0; i < st.frames; i++) { const img = await loadImg(FU(st, i)); bg(g, w, h); banner(g, w, 'COUNT THE GEMS'); drawFrame(g, img, w, h); await wait(st.flashMs || 400); bg(g, w, h); banner(g, w, 'COUNT THE GEMS'); await wait(90); }
    let entry = ''; const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'];
    return await new Promise(res => {
      function draw() { bg(g, w, h); banner(g, w, 'HOW MANY GEMS?'); g.fillStyle = '#eafff3'; g.textAlign = 'center'; g.font = "800 30px 'Space Mono',monospace"; g.fillText(entry || '_', w / 2, 70); const kw = (w - 40) / 3, kh = (h - 90) / 4; keys.forEach((k, i) => { const x = 20 + (i % 3) * kw, y = 84 + ((i / 3) | 0) * kh; fx.tile(g, x + 3, y + 3, kw - 6, kh - 6, 7, { active: k === 'OK' }); g.fillStyle = k === 'OK' ? '#1a1206' : '#e6ddc8'; g.font = "700 19px 'Chakra Petch',sans-serif"; g.fillText(k, x + kw / 2, y + kh / 2 + 7); }); }
      draw(); canvas.addEventListener('pointerdown', function hit(e) { const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; const KW = (r.width - 40) / 3, KH = (r.height - 90) / 4; const col = Math.floor((px - 20) / KW), row = Math.floor((py - 84) / KH); const i = row * 3 + col; if (col < 0 || col > 2 || i < 0 || i >= keys.length) return; const k = keys[i]; if (k === 'C') entry = ''; else if (k === 'OK') { canvas.removeEventListener('pointerdown', hit); res([{ type: 'answer', value: parseInt(entry || '-1', 10) }]); return; } else if (entry.length < 2) entry += k; draw(); });
    });
  }
  async function pWhatChanged(canvas, st) {
    const { g, w, h } = fit(canvas); const side = Math.sqrt(st.data.grid) | 0; const ev = [];
    const a = await loadImg(FU(st, 0)); bg(g, w, h); banner(g, w, 'STUDY THE VAULT'); drawFrame(g, a, w, h); await wait(st.flashMs || 1000);
    bg(g, w, h); banner(g, w, '. . .'); await wait(340);
    const b = await loadImg(FU(st, 1)); bg(g, w, h); banner(g, w, 'TAP WHAT CHANGED'); drawFrame(g, b, w, h);
    return await new Promise(res => { function hit(e) { const p = toL(canvas, e); const pad = 20, cw = (SZ - pad * 2) / side; const col = Math.floor((p.x - pad) / cw), row = Math.floor((p.y - pad) / cw); const idx = row * side + col; if (col < 0 || col >= side || idx < 0 || idx >= st.data.grid) return; ev.push({ type: 'cell', cell: idx }); canvas.removeEventListener('pointerdown', hit); setTimeout(() => res(ev), 150); } canvas.addEventListener('pointerdown', hit); });
  }
  async function pShade(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = [];
    for (let r = 0; r < st.frames; r++) { const img = await loadImg(FU(st, r)); let v = 0.5;
      await new Promise(res => {
        function draw() { bg(g, w, h); banner(g, w, 'MATCH THE SHADE  ' + (r + 1) + '/' + st.frames); g.drawImage(img, w / 2 - 60, 34, 120, 70); g.textAlign = 'center'; g.fillStyle = '#7fae93'; g.font = "600 11px 'Chakra Petch',sans-serif"; g.fillText('TARGET', w / 2, 32);
          g.fillStyle = 'hsl(150 45% ' + Math.round(20 + v * 60) + '%)'; g.fillRect(w / 2 - 60, 128, 120, 60); g.fillStyle = '#7fae93'; g.fillText('YOURS', w / 2, 122);
          const bx = 28, bw = w - 56, by = h - 70; const grad = g.createLinearGradient(bx, 0, bx + bw, 0); grad.addColorStop(0, 'hsl(150 45% 20%)'); grad.addColorStop(1, 'hsl(150 45% 80%)'); g.fillStyle = grad; g.fillRect(bx, by, bw, 16); g.fillStyle = '#fff'; g.fillRect(bx + v * bw - 3, by - 6, 6, 28);
          g.fillStyle = ACC; g.fillRect(w / 2 - 52, h - 34, 104, 26); g.fillStyle = '#02140b'; g.font = "700 13px 'Chakra Petch',sans-serif"; g.fillText('MATCH', w / 2, h - 16); }
        draw(); function setV(px) { const bx = 28, bw = w - 56; v = clamp((px - bx) / bw, 0, 1); draw(); }
        function down(e) { const rect = canvas.getBoundingClientRect(); const px = e.clientX - rect.left, py = e.clientY - rect.top; if (py > h - 40 && Math.abs(px - w / 2) < 54) { ev.push({ type: 'match', v }); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', mv); setTimeout(res, 120); return; } if (py > h - 96) setV(px); }
        const mv = (e) => { if (e.buttons) { const rect = canvas.getBoundingClientRect(); setV(e.clientX - rect.left); } };
        canvas.addEventListener('pointermove', mv); canvas.addEventListener('pointerdown', down);
      });
    }
    return ev;
  }
  async function pDial(canvas, st) {
    const { g, w, h } = fit(canvas); const { speed, start } = st.data; const ev = []; let stop = 0; const t0 = performance.now();
    const imgs = []; for (let i = 0; i < st.frames; i++) imgs.push(await loadImg(FU(st, i)));
    const cx = w / 2, cy = 30 + (h - 30) / 2, R = (h - 30) * 0.37;
    return await new Promise(resolve => {
      let raf; function frame() { const t = (performance.now() - t0) / 1000, a = (start + speed * t) % TAU;
        bg(g, w, h); banner(g, w, 'LOCK THE DIAL  ' + stop + '/' + st.frames);
        fx.contact(g, cx, cy + R * 0.62, R * 1.15, R * 0.4);                          // sits on the panel
        fx.metalDisc(g, cx, cy, R + 16, false);                                        // outer housing (brushed gunmetal)
        fx.bevelRing(g, cx, cy, R + 15, 5);                                            // machined outer edge
        // recessed dial face
        g.save(); const face = g.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R + 4); face.addColorStop(0, '#20221f'); face.addColorStop(.7, '#121311'); face.addColorStop(1, '#0a0b09'); g.fillStyle = face; g.beginPath(); g.arc(cx, cy, R + 4, 0, TAU); g.fill(); g.restore();
        fx.bevelRing(g, cx, cy, R + 3, 3);                                             // inner lip (inverted-ish)
        fx.ticks(g, cx, cy, R - 2, 60, 5);                                             // engraved graduations
        g.save(); g.globalAlpha = 0.9; g.drawImage(imgs[stop], (w - (h - 30)) / 2, 30, h - 30, h - 30); g.restore();  // hidden target-arc glow (server pixels)
        // gold needle with layered shadow → depth
        const nx = cx + Math.cos(a) * R, ny = cy + Math.sin(a) * R, bx = cx - Math.cos(a) * R * 0.16, by = cy - Math.sin(a) * R * 0.16;
        g.save(); g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 6; g.lineCap = 'round'; g.beginPath(); g.moveTo(bx + 2, by + 3); g.lineTo(nx + 2, ny + 3); g.stroke();  // drop shadow
        const ng = g.createLinearGradient(bx, by, nx, ny); ng.addColorStop(0, '#8a6a1e'); ng.addColorStop(.5, '#ffd863'); ng.addColorStop(1, '#fff0b0'); g.strokeStyle = ng; g.shadowColor = ACC; g.shadowBlur = 14; g.lineWidth = 4.5; g.beginPath(); g.moveTo(bx, by); g.lineTo(nx, ny); g.stroke();
        g.shadowBlur = 0; g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(bx, by - .5); g.lineTo(nx, ny - .5); g.stroke(); g.restore();  // specular
        fx.hub(g, cx, cy, 11);                                                         // machined center cap
        fx.glass(g, cx, cy, R + 4);                                                    // crystal sheen
        fx.vignette(g, w, h);
        drawSparks(g); raf = requestAnimationFrame(frame); }
      frame(); function hit() { const t = Math.round(performance.now() - t0); ev.push({ type: 'lock', t }); const a = (start + speed * (t / 1000)) % TAU; burst(cx + Math.cos(a) * R, cy + Math.sin(a) * R, ACC); beep(660); shake(canvas, 4); stop++; if (stop >= st.frames) { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); resolve(ev); } }
      canvas.addEventListener('pointerdown', hit);
    });
  }
  async function pWirecut(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const img = await loadImg(FU(st, 0)); const travel = st.data.travelMs; const fuseY = 30 + (h - 30) * 0.5;
    return await new Promise(res => {
      let raf; const t0 = performance.now(); let cutX = null;
      function fr() {
        const t = performance.now() - t0; const f = Math.min(1.08, t / travel);
        bg(g, w, h); banner(g, w, 'CUT THE WIRE');
        g.save(); g.strokeStyle = '#6b5a3a'; g.lineWidth = 9; g.beginPath(); g.moveTo(14, fuseY); g.lineTo(w - 14, fuseY); g.stroke(); g.strokeStyle = '#39301f'; g.lineWidth = 3; g.beginPath(); g.moveTo(14, fuseY); g.lineTo(w - 14, fuseY); g.stroke(); g.restore();
        g.drawImage(img, 0, 30, w, h - 30);   // transparent safe-zone glow (server pixels; hidden position)
        const sx = (20 + f * (SZ - 40)) / SZ * w;
        g.save(); g.strokeStyle = '#150f0a'; g.lineWidth = 9; g.beginPath(); g.moveTo(14, fuseY); g.lineTo(sx, fuseY); g.stroke(); g.restore();   // burnt trail
        if (cutX == null && Math.random() < 0.7) _sparks.push({ x: sx, y: fuseY, vx: (Math.random() - .5) * 2.4, vy: -(0.6 + Math.random() * 2.4), life: 1, col: '#ffcf4a' });
        drawSparks(g);
        g.save(); g.shadowColor = '#ffcf4a'; g.shadowBlur = 22; g.fillStyle = '#ffe9a8'; g.beginPath(); g.arc(sx, fuseY, 7, 0, TAU); g.fill(); g.restore();
        if (cutX != null) { g.save(); g.strokeStyle = '#eafff3'; g.shadowColor = ACC; g.shadowBlur = 18; g.lineWidth = 3; g.beginPath(); g.moveTo(cutX, fuseY - 24); g.lineTo(cutX, fuseY + 24); g.stroke(); g.restore(); }
        if (f >= 1.08 && cutX == null) { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); ev.push({ type: 'cut', t: travel * 1.2 }); setTimeout(() => res(ev), 300); return; }
        raf = requestAnimationFrame(fr);
      }
      fr();
      function hit() { if (cutX != null) return; const t = performance.now() - t0; ev.push({ type: 'cut', t: Math.round(t) }); cutX = (20 + Math.min(1.08, t / travel) * (SZ - 40)) / SZ * w; beep(520); shake(canvas, 6); burst(cutX, fuseY, ACC); setTimeout(() => { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); res(ev); }, 380); }
      canvas.addEventListener('pointerdown', hit);
    });
  }
  async function pRhythm(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; bg(g, w, h); banner(g, w, 'LISTEN');
    try { const a = new Audio(st.audioURL || ('api/skill/audio?sid=' + encodeURIComponent(st.sid))); await a.play().catch(() => {}); } catch (e) {}
    // approximate playback length wait via beats*avg gap already handled by audio; give a short buffer
    await wait(300 + (st.data.beats || 5) * 550);
    bg(g, w, h); banner(g, w, 'NOW TAP IT  ·  ' + st.data.beats + ' beats'); g.fillStyle = 'rgba(255,205,90,.2)'; g.beginPath(); g.arc(w / 2, h / 2, 60, 0, TAU); g.fill();
    const t0 = performance.now();
    return await new Promise(resolve => { function hit() { ev.push({ type: 'beat', t: performance.now() - t0 }); beep(700); bg(g, w, h); banner(g, w, 'TAP  ' + ev.length + '/' + st.data.beats); g.fillStyle = ACC; g.beginPath(); g.arc(w / 2, h / 2, 70, 0, TAU); g.fill(); if (ev.length >= st.data.beats) { canvas.removeEventListener('pointerdown', hit); resolve(ev); } else setTimeout(() => { bg(g, w, h); banner(g, w, 'TAP  ' + ev.length + '/' + st.data.beats); g.fillStyle = 'rgba(255,205,90,.2)'; g.beginPath(); g.arc(w / 2, h / 2, 60, 0, TAU); g.fill(); }, 80); } canvas.addEventListener('pointerdown', hit); });
  }
  async function pBeam(canvas, st) {
    // Original "Beat the Beam" look: a thin glowing red laser (broken at the gap) + a slim green safe-gap box, both from the
    // server overlay (answer stays in pixels), with a ▼ marker gliding across on the perspective grid. No fat lane, no top banner.
    const { g, w, h } = fit(canvas); const speed = st.data.speed; const ev = [];
    const beamY = 30 + (h - 30) * 0.5;   // matches the server overlay's centre line (SZ/2)
    for (let r = 0; r < st.frames; r++) {
      const img = await loadImg(FU(st, r));
      await new Promise(res => {
        let raf; const t0 = performance.now();
        function fr() {
          const t = (performance.now() - t0) / 1000; const ph = ((speed * t) % 2 + 2) % 2; const pos = ph < 1 ? ph : 2 - ph;
          bg(g, w, h);
          g.drawImage(img, 0, 30, w, h - 30);   // server pixels: the red beam (broken at the gap) + green safe-gap box (hidden position)
          const mx = (20 + pos * (SZ - 40)) / SZ * w;   // ping-pong marker, same mapping the server grades against
          g.save(); g.fillStyle = '#eafff3'; g.shadowColor = ACC; g.shadowBlur = 12;   // ▼ marker gliding above the beam
          g.beginPath(); g.moveTo(mx, beamY - 13); g.lineTo(mx - 8, beamY - 27); g.lineTo(mx + 8, beamY - 27); g.closePath(); g.fill(); g.restore();
          g.fillStyle = '#6f8479'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('PASS ' + (r + 1) + ' / ' + st.frames + '  ·  TAP IN THE GAP', w / 2, h - 14);
          drawSparks(g); raf = requestAnimationFrame(fr);
        }
        fr();
        function hit() { const t = Math.round(performance.now() - t0); ev.push({ type: 'tap', t }); const ph = ((speed * (t / 1000)) % 2 + 2) % 2, pos = ph < 1 ? ph : 2 - ph; burst((20 + pos * (SZ - 40)) / SZ * w, beamY, ACC); beep(660); shake(canvas, 4); cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); setTimeout(res, 180); }
        canvas.addEventListener('pointerdown', hit);
      });
    }
    return ev;
  }
  async function pTorque(canvas, st) {
    // Torque Wrench: a needle oscillates up a vertical gauge; tap when it sits in the gold band. The band (answer) is the
    // server overlay — visible pixels, not data. Distinct from every dial (vertical, not round).
    const { g, w, h } = fit(canvas); const speed = st.data.speed; const ev = []; const img = await loadImg(FU(st, 0));
    const gx = 116 / SZ * w, gw = 68 / SZ * w; const yOf = (pos) => 30 + ((260 - pos * 220) / SZ) * (h - 30);
    return await new Promise(res => {
      let raf; const t0 = performance.now();
      function fr() {
        const t = (performance.now() - t0) / 1000; const ph = ((speed * t) % 2 + 2) % 2, pos = ph < 1 ? ph : 2 - ph;
        bg(g, w, h); banner(g, w, 'TORQUE WRENCH');
        g.save(); g.fillStyle = 'rgba(10,20,16,.6)'; g.fillRect(gx, yOf(1), gw, yOf(0) - yOf(1)); g.strokeStyle = 'rgba(159,180,171,.5)'; g.lineWidth = 2; g.strokeRect(gx, yOf(1), gw, yOf(0) - yOf(1)); g.restore();
        g.drawImage(img, 0, 30, w, h - 30);   // hidden green safe band (server pixels)
        const ny = yOf(pos); g.save(); g.strokeStyle = '#eafff3'; g.shadowColor = ACC; g.shadowBlur = 12; g.lineWidth = 4; g.beginPath(); g.moveTo(gx - 8, ny); g.lineTo(gx + gw + 8, ny); g.stroke(); g.restore();
        g.fillStyle = ACC; g.beginPath(); g.moveTo(gx - 8, ny); g.lineTo(gx - 19, ny - 6); g.lineTo(gx - 19, ny + 6); g.closePath(); g.fill();
        g.fillStyle = '#6f8479'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('TAP IN THE GOLD', w / 2, h - 14);
        drawSparks(g); raf = requestAnimationFrame(fr);
      }
      fr();
      function hit() { const t = Math.round(performance.now() - t0); ev.push({ type: 'tap', t }); const ph = ((speed * (t / 1000)) % 2 + 2) % 2, pos = ph < 1 ? ph : 2 - ph; burst(w / 2, yOf(pos), ACC); beep(660); shake(canvas, 4); cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); setTimeout(() => res(ev), 180); }
      canvas.addEventListener('pointerdown', hit);
    });
  }
  async function pKeypad(canvas, st) {
    // Keypad Breach: watch the flashed code (server digit frames), then key it back on a 1-9 pad. Answer lives in the frames.
    const { g, w, h } = fit(canvas); const ev = []; const flash = st.data.flashMs || 600; const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    for (let i = 0; i < st.frames; i++) { const img = await loadImg(FU(st, i)); bg(g, w, h); banner(g, w, 'MEMORISE  ' + (i + 1) + '/' + st.frames); g.drawImage(img, 0, 30, w, h - 30); await wait(flash); bg(g, w, h); banner(g, w, 'MEMORISE'); await wait(160); }
    const cols = 3, rows = 3;
    function draw(pressed) { bg(g, w, h); banner(g, w, 'ENTER THE CODE  ' + ev.length + '/' + st.data.len); const kw = (w - 40) / cols, kh = (h - 70) / rows; keys.forEach((k, i) => { const x = 20 + (i % cols) * kw, y = 56 + ((i / cols | 0)) * kh; const on = i === pressed; fx.tile(g, x + (on ? 5 : 3), y + (on ? 5 : 3), kw - (on ? 10 : 6), kh - (on ? 10 : 6), 7, { active: on }); g.fillStyle = on ? '#1a1206' : '#e6ddc8'; g.font = "700 20px 'Chakra Petch',sans-serif"; g.textAlign = 'center'; g.fillText(k, x + kw / 2, y + kh / 2 + 7); }); fx.vignette(g, w, h); }
    return await new Promise(res => {
      draw();
      function hit(e) { const r = canvas.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w, py = (e.clientY - r.top) / r.height * h; const kw = (w - 40) / cols, kh = (h - 70) / rows; const col = Math.floor((px - 20) / kw), row = Math.floor((py - 56) / kh); const i = row * cols + col; if (col < 0 || col >= cols || i < 0 || i >= keys.length) return; ev.push({ type: 'key', d: i + 1 }); beep(560 + i * 26); try { navigator.vibrate && navigator.vibrate(8); } catch (e2) {} draw(i); const done = ev.length >= st.data.len; setTimeout(() => { if (done) { canvas.removeEventListener('pointerdown', hit); res(ev); } else draw(); }, 130); }   // flash the pressed key (indent + gold) so the tap visibly registers
      canvas.addEventListener('pointerdown', hit);
    });
  }
  async function pHotwire(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const img = await loadImg(FU(st, 0)); const travel = st.data.travelMs; const wy = 30 + (h - 30) * 0.5;
    return await new Promise(res => {
      let raf; const t0 = performance.now(); let cutX = null;
      function fr() {
        const t = performance.now() - t0; const f = Math.min(1.08, t / travel); bg(g, w, h); banner(g, w, 'HOTWIRE');
        g.save(); g.strokeStyle = '#33506b'; g.lineWidth = 8; g.beginPath(); g.moveTo(14, wy); g.lineTo(w - 14, wy); g.stroke(); g.strokeStyle = '#1a2a38'; g.lineWidth = 3; g.beginPath(); g.moveTo(14, wy); g.lineTo(w - 14, wy); g.stroke(); g.restore();
        g.drawImage(img, 0, 30, w, h - 30);   // hidden safe gap (server pixels)
        const sx = (20 + f * (SZ - 40)) / SZ * w;
        if (cutX == null && Math.random() < 0.8) _sparks.push({ x: sx, y: wy, vx: (Math.random() - .5) * 2.6, vy: -(0.5 + Math.random() * 2.4), life: 1, col: '#8fd7ff' });
        drawSparks(g);
        g.save(); g.shadowColor = '#8fd7ff'; g.shadowBlur = 20; g.strokeStyle = '#eaffff'; g.lineWidth = 3; g.beginPath(); g.moveTo(sx - 6, wy - 8); g.lineTo(sx + 2, wy + 6); g.lineTo(sx - 2, wy - 2); g.lineTo(sx + 6, wy + 8); g.stroke(); g.restore();
        if (cutX != null) { g.save(); g.strokeStyle = '#eafff3'; g.shadowColor = ACC; g.shadowBlur = 18; g.lineWidth = 3; g.beginPath(); g.moveTo(cutX, wy - 24); g.lineTo(cutX, wy + 24); g.stroke(); g.restore(); }
        if (f >= 1.08 && cutX == null) { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); ev.push({ type: 'cut', t: travel * 1.2 }); setTimeout(() => res(ev), 300); return; }
        raf = requestAnimationFrame(fr);
      }
      fr();
      function hit() { if (cutX != null) return; const t = performance.now() - t0; ev.push({ type: 'cut', t: Math.round(t) }); cutX = (20 + Math.min(1.08, t / travel) * (SZ - 40)) / SZ * w; beep(520); shake(canvas, 6); burst(cutX, wy, '#8fd7ff'); setTimeout(() => { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); res(ev); }, 360); }
      canvas.addEventListener('pointerdown', hit);
    });
  }
  async function pSonic(canvas, st) {
    const { g, w, h } = fit(canvas); const speed = st.data.speed; const ev = []; const midY = 30 + (h - 30) * 0.5;
    for (let r = 0; r < st.frames; r++) {
      const img = await loadImg(FU(st, r));
      await new Promise(res => {
        let raf; const t0 = performance.now();
        function fr() {
          const t = (performance.now() - t0) / 1000; const ph = ((speed * t) % 2 + 2) % 2, pos = ph < 1 ? ph : 2 - ph;
          bg(g, w, h); banner(g, w, 'SONIC CRACK  ' + (r + 1) + '/' + st.frames);
          g.save(); g.strokeStyle = 'rgba(255,205,90,.5)'; g.lineWidth = 2; g.beginPath(); for (let x = 14; x <= w - 14; x += 4) { const yy = midY + Math.sin((x / w) * Math.PI * 10 + t * 4) * ((h - 30) * 0.16); if (x === 14) g.moveTo(x, yy); else g.lineTo(x, yy); } g.stroke(); g.restore();
          g.drawImage(img, 0, 30, w, h - 30);   // hidden target column (server pixels)
          const mx = (20 + pos * (SZ - 40)) / SZ * w; g.save(); g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 16; g.lineWidth = 3; g.beginPath(); g.moveTo(mx, 44); g.lineTo(mx, h - 44); g.stroke(); g.restore();
          drawSparks(g); raf = requestAnimationFrame(fr);
        }
        fr();
        function hit() { const t = Math.round(performance.now() - t0); ev.push({ type: 'tap', t }); const ph = ((speed * (t / 1000)) % 2 + 2) % 2, pos = ph < 1 ? ph : 2 - ph; burst((20 + pos * (SZ - 40)) / SZ * w, midY, ACC); beep(720); shake(canvas, 4); cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); setTimeout(res, 180); }
        canvas.addEventListener('pointerdown', hit);
      });
    }
    return ev;
  }
  async function pDialCombo(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const speed = st.data.speed; const starts = st.data.starts || []; const cx = w / 2, cy = 30 + (h - 30) / 2, R = (h - 30) * 0.37;
    const imgs = []; for (let i = 0; i < st.frames; i++) imgs.push(await loadImg(FU(st, i)));
    let round = 0;
    return await new Promise(resolve => {
      let raf; let t0 = performance.now();
      function frame() {
        const dir = round % 2 === 0 ? 1 : -1; const t = (performance.now() - t0) / 1000; const a = (((starts[round] || 0) + dir * speed * t) % TAU + TAU) % TAU;
        bg(g, w, h); banner(g, w, 'COMBO DIAL  ' + round + '/' + st.frames);
        const rg = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.15); rg.addColorStop(0, '#14201b'); rg.addColorStop(1, '#0a1410'); g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, R + 18, 0, TAU); g.fill();
        g.strokeStyle = 'rgba(255,210,74,.22)'; g.lineWidth = 10; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
        g.save(); g.strokeStyle = 'rgba(180,220,200,.5)'; for (let k = 0; k < 36; k++) { const ta = k / 36 * TAU; const r0 = (k % 9 === 0) ? R - 14 : R - 8; g.lineWidth = (k % 9 === 0) ? 2.5 : 1; g.beginPath(); g.moveTo(cx + Math.cos(ta) * r0, cy + Math.sin(ta) * r0); g.lineTo(cx + Math.cos(ta) * (R - 2), cy + Math.sin(ta) * (R - 2)); g.stroke(); } g.restore();
        g.drawImage(imgs[round], (w - (h - 30)) / 2, 30, h - 30, h - 30);
        g.save(); g.fillStyle = 'rgba(61,255,143,.75)'; g.font = "700 12px 'Chakra Petch',sans-serif"; g.textAlign = 'center'; g.fillText(dir > 0 ? 'CW  →' : '←  CCW', cx, cy - R - 8); g.restore();
        g.save(); g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 18; g.lineWidth = 4; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke(); g.restore();
        g.fillStyle = '#eafff3'; g.beginPath(); g.arc(cx, cy, 6, 0, TAU); g.fill(); drawSparks(g); raf = requestAnimationFrame(frame);
      }
      frame();
      function hit() { const t = Math.round(performance.now() - t0); ev.push({ type: 'lock', t }); const dir = round % 2 === 0 ? 1 : -1; const a = (((starts[round] || 0) + dir * speed * (t / 1000)) % TAU + TAU) % TAU; burst(cx + Math.cos(a) * R, cy + Math.sin(a) * R, ACC); beep(640); shake(canvas, 4); round++; if (round >= st.frames) { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); setTimeout(() => resolve(ev), 160); } else { t0 = performance.now(); } }
      canvas.addEventListener('pointerdown', hit);
    });
  }
  async function pTumbler(canvas, st) {
    const { g, w, h } = fit(canvas); const speed = st.data.speed; const ev = []; const img = await loadImg(FU(st, 0));
    const gx = 106 / SZ * w, gw = 88 / SZ * w; const yOf = (pos) => 30 + ((260 - pos * 220) / SZ) * (h - 30);
    return await new Promise(res => {
      let raf; const t0 = performance.now();
      function fr() {
        const t = (performance.now() - t0) / 1000; const ph = ((speed * t) % 2 + 2) % 2, pos = ph < 1 ? ph : 2 - ph;
        bg(g, w, h); banner(g, w, 'TUMBLER DROP');
        g.save(); g.fillStyle = 'rgba(10,20,16,.6)'; g.fillRect(gx, yOf(1), gw, yOf(0) - yOf(1)); g.strokeStyle = 'rgba(159,180,171,.4)'; g.lineWidth = 2; g.strokeRect(gx, yOf(1), gw, yOf(0) - yOf(1)); g.restore();
        g.drawImage(img, 0, 30, w, h - 30);   // hidden shear line (server pixels)
        const ny = yOf(pos); g.save(); g.fillStyle = '#cfe0d8'; g.shadowColor = ACC; g.shadowBlur = 10; g.fillRect(gx - 6, ny - 4, gw + 12, 8); g.restore();
        g.fillStyle = ACC; g.beginPath(); g.moveTo(gx + gw + 6, ny); g.lineTo(gx + gw + 16, ny - 6); g.lineTo(gx + gw + 16, ny + 6); g.closePath(); g.fill();
        g.fillStyle = '#6f8479'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('TAP AT THE SHEAR LINE', w / 2, h - 14);
        drawSparks(g); raf = requestAnimationFrame(fr);
      }
      fr();
      function hit() { const t = Math.round(performance.now() - t0); ev.push({ type: 'tap', t }); const ph = ((speed * (t / 1000)) % 2 + 2) % 2, pos = ph < 1 ? ph : 2 - ph; burst(w / 2, yOf(pos), ACC); beep(600); shake(canvas, 4); cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); setTimeout(() => res(ev), 180); }
      canvas.addEventListener('pointerdown', hit);
    });
  }
  async function pPressure(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const img = await loadImg(FU(st, 0)); const span = st.data.span || 4000; const seen = new Set();
    const cell = (k) => ({ x: (0.09 + (k % 3) * 0.30) * w, y: 30 + (0.10 + ((k / 3) | 0) * 0.30) * (h - 30), w: 0.24 * w, h: 0.24 * (h - 30) });
    return await new Promise(res => {
      let raf; const t0 = performance.now();
      function fr() {
        const el = performance.now() - t0, left = Math.max(0, 1 - el / span); bg(g, w, h); banner(g, w, 'PRESSURE PLATES  ' + seen.size + '/' + st.data.greens);
        g.drawImage(img, 0, 30, w, h - 30);   // green/red plate tints (server pixels; hidden layout)
        for (let k = 0; k < 9; k++) { const c = cell(k); g.strokeStyle = 'rgba(200,220,212,.35)'; g.lineWidth = 2; g.strokeRect(c.x, c.y, c.w, c.h); if (seen.has(k)) { g.save(); g.strokeStyle = ACC; g.lineWidth = 3; g.strokeRect(c.x + 2, c.y + 2, c.w - 4, c.h - 4); g.restore(); } }
        g.fillStyle = 'rgba(255,120,130,.25)'; g.fillRect(0, h - 6, w, 6); g.fillStyle = left < 0.25 ? '#ff7a86' : ACC; g.fillRect(0, h - 6, w * left, 6);
        drawSparks(g);
        if (el >= span) { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); setTimeout(() => res(ev), 250); return; }
        raf = requestAnimationFrame(fr);
      }
      fr();
      function hit(e) { const r = canvas.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w, py = (e.clientY - r.top) / r.height * h; for (let k = 0; k < 9; k++) { const c = cell(k); if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) { if (!seen.has(k)) { seen.add(k); ev.push({ type: 'plate', idx: k }); burst(c.x + c.w / 2, c.y + c.h / 2, ACC); beep(600); } break; } } }
      canvas.addEventListener('pointerdown', hit);
    });
  }
  async function pReflex(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const greenAt = st.data.greenAt || 1200; const cx = w / 2, cy = 30 + (h - 30) * 0.45;
    return await new Promise(res => {
      let raf; const t0 = performance.now(); let tapped = false;
      function fr() { const t = performance.now() - t0; const green = t >= greenAt; bg(g, w, h); banner(g, w, 'TRIP THE WIRE');
        g.save(); g.fillStyle = green ? 'rgba(61,255,143,.9)' : 'rgba(255,77,94,.75)'; g.shadowColor = green ? ACC : '#ff4d5e'; g.shadowBlur = green ? 24 : 0; g.beginPath(); g.arc(cx, cy, 46, 0, TAU); g.fill(); g.restore();
        g.fillStyle = '#03110a'; g.font = "700 16px 'Chakra Petch',sans-serif"; g.textAlign = 'center'; g.fillText(green ? 'TAP!' : 'WAIT', cx, cy + 5);
        g.fillStyle = '#6f8479'; g.font = "12px 'Space Mono',monospace"; g.fillText(tapped ? '' : 'tap the instant it turns green', cx, h - 16);
        drawSparks(g); if (!tapped) raf = requestAnimationFrame(fr); }
      fr();
      function hit() { if (tapped) return; tapped = true; const t = Math.round(performance.now() - t0); ev.push({ type: 'tap', t }); const good = t >= greenAt; burst(cx, cy, good ? ACC : '#ff4d5e'); beep(good ? 680 : 300); if (!good) shake(canvas, 6); cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); setTimeout(() => res(ev), 260); }
      canvas.addEventListener('pointerdown', hit);
      setTimeout(() => { if (!tapped) { tapped = true; cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); res(ev); } }, greenAt + 2600);
    });
  }
  async function pMash(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const need = st.data.need || 16, win = st.data.win || 3000;
    return await new Promise(res => {
      let raf; const t0 = performance.now(); let ended = false, taps = 0;
      function fr() { const el = performance.now() - t0, left = Math.max(0, win - el); bg(g, w, h); banner(g, w, 'FORCE THE DOOR');
        const bx = 40, bw = w - 80, by = 30 + (h - 30) * 0.5 - 16; g.strokeStyle = 'rgba(255,205,90,.5)'; g.lineWidth = 2; g.strokeRect(bx, by, bw, 32); g.fillStyle = ACC; g.fillRect(bx, by, bw * clamp(taps / need, 0, 1), 32);
        g.fillStyle = '#eafff3'; g.font = "16px 'Space Mono',monospace"; g.textAlign = 'center'; g.fillText(taps + ' / ' + need, w / 2, by - 14); g.fillStyle = '#ffd24a'; g.fillText((left / 1000).toFixed(1) + 's', w / 2, by + 58);
        g.fillStyle = '#6f8479'; g.font = "12px 'Space Mono',monospace"; g.fillText('HAMMER', w / 2, h - 14); drawSparks(g);
        if (!ended && (el >= win || taps >= need)) { ended = true; cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); setTimeout(() => res(ev), 200); return; }
        raf = requestAnimationFrame(fr); }
      fr();
      function hit() { if (ended) return; taps++; ev.push({ type: 'tap', t: Math.round(performance.now() - t0) }); beep(500 + Math.min(taps, 20) * 12); }
      canvas.addEventListener('pointerdown', hit);
    });
  }
  async function pSilent(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const greenAt = st.data.greenAt || 1400; const cx = w / 2, cy = 30 + (h - 30) * 0.45;
    return await new Promise(res => {
      let raf; const t0 = performance.now(); let tapped = false;
      function fr() { const t = performance.now() - t0; const green = t >= greenAt; bg(g, w, h); banner(g, w, 'SILENT ALARM');
        g.save(); g.fillStyle = green ? 'rgba(61,255,143,.9)' : 'rgba(255,77,94,.75)'; g.shadowColor = green ? ACC : '#ff4d5e'; g.shadowBlur = green ? 24 : 6; g.beginPath(); g.arc(cx, cy, 46, 0, TAU); g.fill(); g.restore();
        g.fillStyle = '#03110a'; g.font = "700 15px 'Chakra Petch',sans-serif"; g.textAlign = 'center'; g.fillText(green ? 'GO!' : 'HOLD', cx, cy + 5);
        g.fillStyle = '#6f8479'; g.font = "12px 'Space Mono',monospace"; g.fillText(tapped ? '' : 'tap on green — never on red', cx, h - 16);
        drawSparks(g); if (!tapped) raf = requestAnimationFrame(fr); }
      fr();
      function hit() { if (tapped) return; tapped = true; const t = Math.round(performance.now() - t0); ev.push({ type: 'tap', t }); const good = t >= greenAt; burst(cx, cy, good ? ACC : '#ff4d5e'); beep(good ? 700 : 280); if (!good) shake(canvas, 7); cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); setTimeout(() => res(ev), 260); }
      canvas.addEventListener('pointerdown', hit);
      setTimeout(() => { if (!tapped) { tapped = true; cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); res(ev); } }, greenAt + 2800);
    });
  }
  // ── LUCK "fate" presenters: outcome-AGNOSTIC theatre on the shared shell. Never claim a result — the real outcome is the
  //    provably-fair roll shown on the end screen (in the arcade there are no stakes). This is what "luck on the same system" means.
  async function pCoinflip(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const cx = w / 2, cyBase = 30 + (h - 30) * 0.5;
    return await new Promise(res => {
      let raf; let flipping = false, t0 = 0, ph = 0, done = false;
      function fr() {
        bg(g, w, h); banner(g, w, 'COIN TOSS');
        let lift = 0; if (flipping) { const p = Math.min(1, (performance.now() - t0) / 1200); lift = Math.sin(p * Math.PI) * (h * 0.22); ph += 0.5; }
        const cy = cyBase - lift;
        g.save(); g.globalAlpha = 0.28; g.fillStyle = '#000'; g.beginPath(); g.ellipse(cx, cyBase + 34, 34 * (1 - lift / (h * 0.4)), 7, 0, 0, TAU); g.fill(); g.restore();
        const sc = Math.max(0.08, Math.abs(Math.cos(ph))); g.save(); g.translate(cx, cy); g.scale(1, sc);
        g.fillStyle = '#ffd24a'; g.strokeStyle = '#a5851f'; g.lineWidth = 3; g.shadowColor = '#ffd24a'; g.shadowBlur = 16; g.beginPath(); g.arc(0, 0, 44, 0, TAU); g.fill(); g.stroke(); g.shadowBlur = 0;
        g.fillStyle = '#7a5f14'; g.font = '800 30px "Cinzel",serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(Math.cos(ph) >= 0 ? 'R' : 'V', 0, 0); g.textBaseline = 'alphabetic'; g.restore();
        if (!flipping && !done) { g.fillStyle = '#6f8479'; g.font = "12px 'Space Mono',monospace"; g.textAlign = 'center'; g.fillText('TAP TO FLIP', cx, h - 14); }
        if (flipping && performance.now() - t0 >= 1200) { flipping = false; done = true; burst(cx, cyBase, '#ffd24a'); try { sfx.lock(); } catch (e) {} shake(canvas, 5); cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); setTimeout(() => res(ev), 420); return; }
        drawSparks(g); raf = requestAnimationFrame(fr);
      }
      fr();
      function hit() { if (flipping || done) return; flipping = true; t0 = performance.now(); ev.push({ type: 'flip', t: 0 }); }
      canvas.addEventListener('pointerdown', hit);
    });
  }
  // ── LUCK fate runner: tap to trigger, ~1.3s signature motion, neutral burst. NO outcome claim (real result = end screen). ──
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function dpips(g, n, cx, cy, s) { const o = s * 0.26, P = { 1: [[0, 0]], 2: [[-o, -o], [o, o]], 3: [[-o, -o], [0, 0], [o, o]], 4: [[-o, -o], [o, -o], [-o, o], [o, o]], 5: [[-o, -o], [o, -o], [0, 0], [-o, o], [o, o]], 6: [[-o, -o], [o, -o], [-o, 0], [o, 0], [-o, o], [o, o]] }; (P[n] || P[1]).forEach(function (p) { g.beginPath(); g.arc(cx + p[0], cy + p[1], s * 0.08, 0, TAU); g.fill(); }); }
  const _ez = (p) => 1 - Math.pow(1 - p, 3);
  // per-game payoff sound, keyed by the (static, unique) banner title — gives each fate game its own voice with zero per-presenter wiring
  const _cascade = () => { [0, 60, 120, 180].forEach((d, i) => setTimeout(() => { try { _tone(680 + i * 90, 0.04, 'square', 0.05); } catch (e) {} }, d)); };
  const _boom = () => { try { _tone(70, 0.5, 'sawtooth', 0.22, 40); } catch (e) {} };
  const _clunk = () => { try { sfx.thunk(); } catch (e) {} setTimeout(() => { try { sfx.lock(); } catch (e) {} }, 120); };
  const FATE_SND = {
    'FORTUNE WHEEL': () => sfx.win(), 'ONE-ARMED BANDIT': () => sfx.win(), 'LUCKY NUMBERS': () => sfx.win(), 'FUSE RACE': () => sfx.win(),
    'BONE ROLL': () => sfx.thunk(), 'ROULETTE': () => sfx.thunk(), 'GRAB A BAR': () => sfx.thunk(),
    'CARD FLIP': () => sfx.lock(), 'SHELL GAME': () => sfx.lock(), 'HIGH CARD': () => sfx.lock(), 'SCRATCH CARD': () => sfx.click(),
    'PLINKO DROP': _cascade, 'DETONATOR': _boom, 'VAULT LEVER': _clunk,
  };
  function fateGame(canvas, opts) {
    const { g, w, h } = fit(canvas); const ev = []; const cx = w / 2, cy = 30 + (h - 30) * 0.5, dur = opts.dur || 1300;
    // bake the static backdrop + banner once (was redrawn every frame ~90x per play) — CPU/battery win on mobile
    let _bgc = null; try { _bgc = document.createElement('canvas'); _bgc.width = w; _bgc.height = h; const bc = _bgc.getContext('2d'); bg(bc, w, h); banner(bc, w, opts.title); } catch (e) { _bgc = null; }
    const _snd = FATE_SND[opts.title] || (() => sfx.win());
    return new Promise(res => {
      let raf, started = false, t0 = 0, done = false;
      function fr() {
        const ph = started ? Math.min(1, (performance.now() - t0) / dur) : 0;
        if (_bgc) { g.drawImage(_bgc, 0, 0); } else { bg(g, w, h); banner(g, w, opts.title); }
        try { opts.draw(g, w, h, ph, started, cx, cy); } catch (e) {}
        fx.vignette(g, w, h);
        if (!started && !done) { g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText(opts.tap || 'TAP TO PLAY', cx, h - 14); }
        drawSparks(g);
        if (started && ph >= 1 && !done) { done = true; burst(cx, cy, opts.col || '#ffd24a'); try { _snd(); } catch (e) {} shake(canvas, opts.title === 'DETONATOR' ? 9 : 5); cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); setTimeout(() => res(ev), 380); return; }
        raf = requestAnimationFrame(fr);
      }
      fr();
      function hit() { if (started || done) return; started = true; t0 = performance.now(); ev.push({ type: 'pick', t: 0 }); try { (opts.tapsnd || sfx.whir)(); } catch (e) {} }
      canvas.addEventListener('pointerdown', hit);
    });
  }
  function pWheel(canvas) { const SY = ['💎', '🔑', '💰', '🍒', '7', '★', '🪙', '◆']; return fateGame(canvas, { title: 'FORTUNE WHEEL', tap: 'TAP TO SPIN', dur: 1600, draw(g, w, h, ph, s, cx, cy) { const R = Math.min(w, h - 30) * 0.32, ang = _ez(ph) * Math.PI * 9;
    fx.contact(g, cx, cy + R * 0.7, R * 1.1, R * 0.35);
    fx.metalDisc(g, cx, cy, R + 12, true); fx.bevelRing(g, cx, cy, R + 11, 5, ACC);   // machined gold rim
    for (let i = 0; i < 8; i++) { const a0 = ang + i / 8 * TAU, a1 = ang + (i + 1) / 8 * TAU, am = (a0 + a1) / 2; g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a0, a1); g.closePath(); const wedge = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R); if (i % 2) { wedge.addColorStop(0, '#3a2c0e'); wedge.addColorStop(1, '#7a5e1e'); } else { wedge.addColorStop(0, '#171512'); wedge.addColorStop(1, '#0c0b09'); } g.fillStyle = wedge; g.fill(); g.strokeStyle = 'rgba(255,210,74,.5)'; g.lineWidth = 1.2; g.stroke(); g.save(); g.translate(cx + Math.cos(am) * R * 0.66, cy + Math.sin(am) * R * 0.66); g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '16px serif'; g.fillText(SY[i], 0, 0); g.restore(); } g.textBaseline = 'alphabetic';
    g.save(); g.shadowColor = '#000'; g.shadowBlur = 6; g.fillStyle = '#ffe08a'; g.beginPath(); g.moveTo(cx + R + 2, cy); g.lineTo(cx + R + 19, cy - 8); g.lineTo(cx + R + 19, cy + 8); g.closePath(); g.fill(); g.restore();   // pointer
    fx.hub(g, cx, cy, 14); fx.glass(g, cx, cy, R); } }); }
  function pDice(canvas) { let a = 3, b = 4; return fateGame(canvas, { title: 'BONE ROLL', tap: 'TAP TO ROLL', col: '#eafff3', draw(g, w, h, ph, s, cx, cy) { if (s && ph < 0.82) { a = 1 + ((Math.random() * 6) | 0); b = 1 + ((Math.random() * 6) | 0); } const sz = Math.min(52, w / 5);[[cx - sz * 0.75, a], [cx + sz * 0.75, b]].forEach(function (d) { const jy = (s && ph < 0.82) ? (Math.random() - .5) * 12 : 0; g.save(); g.fillStyle = '#eafff3'; g.strokeStyle = '#a9c2b6'; g.lineWidth = 2; roundRect(g, d[0] - sz / 2, cy - sz / 2 + jy, sz, sz, 9); g.fill(); g.stroke(); g.fillStyle = '#0a1710'; dpips(g, d[1], d[0], cy + jy, sz); g.restore(); }); } }); }
  function pCardflip(canvas) { const FACE = ['◆', '★', '7', '♠', '♥', '♦', '♣', 'K', 'A', '💎']; let fi = 0; return fateGame(canvas, { title: 'CARD FLIP', tap: 'TAP TO DRAW', dur: 1100, draw(g, w, h, ph, s, cx, cy) { const rot = s ? ph * Math.PI * 2.5 : 0, fl = Math.abs(Math.cos(rot)), cw = Math.min(96, w * 0.32), chh = cw * 1.4, face = s && Math.cos(rot) < 0; if (s && face) fi = Math.min(FACE.length - 1, (ph * FACE.length * 1.3) | 0) % FACE.length; g.save(); g.translate(cx, cy); g.scale(Math.max(0.05, fl), 1); const grd = g.createLinearGradient(-cw / 2, -chh / 2, cw / 2, chh / 2); if (face) { grd.addColorStop(0, '#241d10'); grd.addColorStop(1, '#3a2c0e'); } else { grd.addColorStop(0, '#17140d'); grd.addColorStop(1, '#0d0b08'); } g.fillStyle = grd; g.strokeStyle = face ? ACC : 'rgba(255,205,90,.5)'; g.lineWidth = 2; roundRect(g, -cw / 2, -chh / 2, cw, chh, 8); g.fill(); g.stroke(); g.textAlign = 'center'; g.textBaseline = 'middle'; if (face) { g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 14; g.font = '800 40px serif'; g.fillText(FACE[fi], 0, 0); g.shadowBlur = 0; } else { g.fillStyle = 'rgba(255,205,90,.5)'; g.font = '700 24px "Cinzel",serif'; g.fillText('RV', 0, 0); } g.textBaseline = 'alphabetic'; g.restore(); } }); }
  function pSlots(canvas) { const SY = ['◆', '◇', '★', '●', '▲', '7']; let r = [0, 2, 4]; return fateGame(canvas, { title: 'ONE-ARMED BANDIT', tap: 'PULL', draw(g, w, h, ph, s, cx, cy) { const bw = Math.min(w * 0.72, 220), rw = bw / 3, ry = cy - 34, rh = 68, x0 = cx - bw / 2; for (let i = 0; i < 3; i++) { if (s && ph < 0.55 + i * 0.15) r[i] = (Math.random() * SY.length) | 0; g.fillStyle = 'rgba(8,18,13,.8)'; g.fillRect(x0 + i * rw + 3, ry, rw - 6, rh); g.strokeStyle = 'rgba(255,205,90,.4)'; g.lineWidth = 2; g.strokeRect(x0 + i * rw + 3, ry, rw - 6, rh); g.fillStyle = '#eafff3'; g.font = '26px serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(SY[r[i] % SY.length], x0 + i * rw + rw / 2, cy); } g.textBaseline = 'alphabetic'; } }); }
  function pRoulette(canvas) { return fateGame(canvas, { title: 'ROULETTE', tap: 'DROP THE BALL', dur: 1600, draw(g, w, h, ph, s, cx, cy) { const R = Math.min(w, h - 30) * 0.32; for (let i = 0; i < 16; i++) { const a = i / 16 * TAU + _ez(s ? ph : 0) * 2; g.fillStyle = i % 2 ? 'rgba(255,205,90,.2)' : 'rgba(255,77,94,.2)'; g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a, a + TAU / 16); g.closePath(); g.fill(); } g.strokeStyle = 'rgba(255,205,90,.4)'; g.lineWidth = 4; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke(); const ba = s ? ph * 16 : 0, br = s ? R * (1 - 0.45 * _ez(ph)) : R; g.save(); g.shadowColor = '#fff'; g.shadowBlur = 10; g.fillStyle = '#eafff3'; g.beginPath(); g.arc(cx + Math.cos(ba) * br, cy + Math.sin(ba) * br, 5, 0, TAU); g.fill(); g.restore(); g.fillStyle = '#0a1710'; g.beginPath(); g.arc(cx, cy, 13, 0, TAU); g.fill(); g.strokeStyle = ACC; g.lineWidth = 2; g.stroke(); } }); }
  function pShells(canvas) { return fateGame(canvas, { title: 'SHELL GAME', tap: 'TAP TO SHUFFLE', draw(g, w, h, ph, s, cx, cy) { const gap = Math.min(w * 0.26, 86), xs = [cx - gap, cx, cx + gap], sw = Math.min(56, gap * 0.8); for (let i = 0; i < 3; i++) { const sway = s && ph < 0.9 ? Math.sin(ph * 20 + i * 2) * gap * 0.5 : 0, lift = (s && ph >= 0.9 && i === 1) ? -24 : 0, x = xs[i] + sway; g.save(); g.fillStyle = '#6b4f2a'; g.strokeStyle = '#c79a55'; g.lineWidth = 2; g.beginPath(); g.moveTo(x - sw / 2, cy + 28 + lift); g.quadraticCurveTo(x, cy - 34 + lift, x + sw / 2, cy + 28 + lift); g.closePath(); g.fill(); g.stroke(); g.restore(); } } }); }
  function pScratch(canvas) { return fateGame(canvas, { title: 'SCRATCH CARD', tap: 'TAP TO SCRATCH', draw(g, w, h, ph, s, cx, cy) { const cw = Math.min(w * 0.6, 220), chh = 90, x0 = cx - cw / 2, y0 = cy - chh / 2; g.fillStyle = '#12241c'; roundRect(g, x0, y0, cw, chh, 10); g.fill(); if (s) { g.save(); g.fillStyle = 'rgba(255,210,74,.16)'; const rev = cw * _ez(ph); roundRect(g, x0, y0, Math.max(1, rev), chh, 10); g.fill(); for (let i = 0; i < 20; i++) { g.fillStyle = 'rgba(234,255,243,' + (0.2 + Math.random() * 0.3) + ')'; g.fillRect(x0 + Math.random() * rev, y0 + Math.random() * chh, 2, 2); } g.restore(); } g.strokeStyle = '#c0a24a'; g.lineWidth = 2; roundRect(g, x0, y0, cw, chh, 10); g.stroke(); if (!s) { g.fillStyle = '#8a7a45'; g.textAlign = 'center'; g.font = '700 13px "Chakra Petch",sans-serif'; g.fillText('SCRATCH TO REVEAL', cx, cy + 4); } } }); }
  function pPlinko(canvas) { return fateGame(canvas, { title: 'PLINKO DROP', tap: 'DROP THE CHIP', dur: 1500, draw(g, w, h, ph, s, cx, cy) { const top = 44, bot = h - 22; g.fillStyle = 'rgba(255,205,90,.5)'; for (let row = 0; row < 5; row++) { const yy = top + row * ((bot - top) / 6), cnt = row + 2; for (let c = 0; c < cnt; c++) { g.beginPath(); g.arc(cx + (c - (cnt - 1) / 2) * 28, yy, 3, 0, TAU); g.fill(); } } if (s) { const yy = top + _ez(ph) * (bot - top), bx = Math.sin(ph * 18) * ph * 40; g.save(); g.shadowColor = '#ffd24a'; g.shadowBlur = 12; g.fillStyle = '#ffd24a'; g.beginPath(); g.arc(cx + bx, yy, 8, 0, TAU); g.fill(); g.restore(); } } }); }
  function pKeno(canvas) { const lit = []; return fateGame(canvas, { title: 'LUCKY NUMBERS', tap: 'TAP TO DRAW', dur: 1600, draw(g, w, h, ph, s, cx, cy) { const cols = 5, rows = 4, cw = Math.min(w * 0.7, 240) / cols, ch = (h - 82) / rows, x0 = cx - cw * cols / 2, y0 = 48, n = Math.floor(ph * 8); while (s && lit.length < n) lit.push((Math.random() * 20) | 0); for (let k = 0; k < 20; k++) { const x = x0 + (k % cols) * cw, y = y0 + ((k / cols) | 0) * ch, on = lit.indexOf(k) >= 0; fx.tile(g, x + 2, y + 2, cw - 4, ch - 4, 6, { active: on, shadow: on }); if (on) { fx.readout(g, String(k + 1), x + cw / 2, y + ch / 2, 15, '#ffce5a'); } else { g.fillStyle = '#5a6b60'; g.font = '700 13px "Chakra Petch",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(k + 1), x + cw / 2, y + ch / 2); g.textBaseline = 'alphabetic'; } } } }); }
  function pGoldbar(canvas) { return fateGame(canvas, { title: 'GRAB A BAR', tap: 'DROP THE CLAW', dur: 1500, draw(g, w, h, ph, s, cx, cy) { const top = 40, reach = cy + 24 - top, down = s ? Math.sin(Math.min(ph, 0.5) / 0.5 * Math.PI / 2) : 0, up = s && ph > 0.5 ? (ph - 0.5) / 0.5 : 0, y2 = top + reach * down - up * reach; g.strokeStyle = '#9fb4ab'; g.lineWidth = 3; g.beginPath(); g.moveTo(cx, top); g.lineTo(cx, y2); g.stroke(); g.fillStyle = '#cfe0d8'; g.beginPath(); g.moveTo(cx - 10, y2); g.lineTo(cx, y2 + 12); g.lineTo(cx + 10, y2); g.closePath(); g.fill(); if (s && ph > 0.5) { g.fillStyle = '#ffd24a'; g.strokeStyle = '#a5851f'; g.lineWidth = 2; roundRect(g, cx - 22, y2 + 10, 44, 18, 4); g.fill(); g.stroke(); } } }); }
  function pMagnetgrab(canvas) { return fateGame(canvas, { title: 'DETONATOR', tap: 'SLAM THE PLUNGER', dur: 1300, col: '#ffb347', draw(g, w, h, ph, s, cx, cy) { const boxW = 78, boxH = 58, by = cy + 30; const press = s ? Math.min(1, ph / 0.32) : 0, topY = by - boxH / 2 - 46 + press * 30; g.strokeStyle = '#9fb4ab'; g.lineWidth = 6; g.beginPath(); g.moveTo(cx, topY); g.lineTo(cx, by - boxH / 2); g.stroke(); g.fillStyle = '#e64a3b'; roundRect(g, cx - 26, topY - 11, 52, 14, 5); g.fill(); g.fillStyle = '#2a2318'; g.strokeStyle = '#c0a24a'; g.lineWidth = 2; roundRect(g, cx - boxW / 2, by - boxH / 2, boxW, boxH, 7); g.fill(); g.stroke(); g.fillStyle = '#c9a34a'; g.font = '800 13px "Chakra Petch",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('T·N·T', cx, by); g.textBaseline = 'alphabetic'; if (s && ph > 0.4) { const bp = (ph - 0.4) / 0.6, R = bp * Math.min(w, h) * 0.6, oy = by - boxH; g.save(); g.globalAlpha = Math.max(0, 1 - bp); const rg = g.createRadialGradient(cx, oy, R * 0.15, cx, oy, R); rg.addColorStop(0, '#fff2c4'); rg.addColorStop(0.45, '#ffb347'); rg.addColorStop(1, 'rgba(255,77,60,0)'); g.fillStyle = rg; g.beginPath(); g.arc(cx, oy, R, 0, TAU); g.fill(); g.restore(); for (let i = 0; i < 11; i++) { const a = i / 11 * TAU, rr = bp * 96; g.fillStyle = 'rgba(255,214,120,' + Math.max(0, 1 - bp) + ')'; g.beginPath(); g.arc(cx + Math.cos(a) * rr, oy + Math.sin(a) * rr, 3.2, 0, TAU); g.fill(); } } } }); }
  function pFuserace(canvas) { return fateGame(canvas, { title: 'FUSE RACE', tap: 'LIGHT THE FUSE', dur: 1500, draw(g, w, h, ph, s, cx, cy) {[cy - 24, cy + 24].forEach(function (yy, idx) { g.strokeStyle = '#6b5a3a'; g.lineWidth = 6; g.beginPath(); g.moveTo(20, yy); g.lineTo(w - 32, yy); g.stroke(); const sx = 20 + _ez(s ? ph * (idx === 0 ? 1 : 0.92) : 0) * (w - 52); g.strokeStyle = '#150f0a'; g.lineWidth = 6; g.beginPath(); g.moveTo(20, yy); g.lineTo(sx, yy); g.stroke(); if (s) { g.save(); g.shadowColor = '#ffcf4a'; g.shadowBlur = 16; g.fillStyle = '#ffe9a8'; g.beginPath(); g.arc(sx, yy, 5, 0, TAU); g.fill(); g.restore(); } g.font = '15px serif'; g.textAlign = 'center'; g.fillText('🧨', w - 26, yy + 5); }); } }); }
  function pElevator(canvas) { const RANK = ['A', 'K', 'Q', 'J', '10', '9', '◆', '★']; let ri = 0; return fateGame(canvas, { title: 'HIGH CARD', tap: 'CUT THE DECK', dur: 1200, draw(g, w, h, ph, s, cx, cy) { const cw = Math.min(72, w * 0.24), chh = cw * 1.42, deckX = cx - cw / 2 - 46; for (let i = 0; i < 5; i++) { g.fillStyle = i % 2 ? '#17140d' : '#1d190f'; g.strokeStyle = 'rgba(255,210,74,.32)'; g.lineWidth = 1.5; roundRect(g, deckX - i * 1.6, cy - chh / 2 + i * 1.6, cw, chh, 7); g.fill(); g.stroke(); } const cut = s ? _ez(Math.min(1, ph / 0.4)) : 0, drawnX = deckX + cut * 96; const flipPh = s ? Math.max(0, (ph - 0.4) / 0.6) : 0, rot = flipPh * Math.PI, fl = Math.abs(Math.cos(rot)), faceUp = flipPh > 0 && Math.cos(rot) < 0; if (s && faceUp) ri = Math.min(RANK.length - 1, (flipPh * RANK.length) | 0); g.save(); g.translate(drawnX + cw / 2, cy); g.scale(Math.max(0.06, fl), 1); const grd = g.createLinearGradient(-cw / 2, -chh / 2, cw / 2, chh / 2); if (faceUp) { grd.addColorStop(0, '#241d10'); grd.addColorStop(1, '#3a2c0e'); } else { grd.addColorStop(0, '#17140d'); grd.addColorStop(1, '#0d0b08'); } g.fillStyle = grd; g.strokeStyle = faceUp ? ACC : 'rgba(255,210,74,.5)'; g.lineWidth = 2; roundRect(g, -cw / 2, -chh / 2, cw, chh, 7); g.fill(); g.stroke(); g.textAlign = 'center'; g.textBaseline = 'middle'; if (faceUp) { g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 12; g.font = '800 32px "Cinzel",serif'; g.fillText(RANK[ri], 0, 0); g.shadowBlur = 0; } else { g.fillStyle = 'rgba(255,205,90,.5)'; g.font = '700 20px "Cinzel",serif'; g.fillText('RV', 0, 0); } g.textBaseline = 'alphabetic'; g.restore(); } }); }
  function pSafedial(canvas) { return fateGame(canvas, { title: 'VAULT LEVER', tap: 'THROW THE LEVER', dur: 1300, draw(g, w, h, ph, s, cx, cy) { const doorCx = cx - 22, R = Math.min(w, h - 30) * 0.29; g.fillStyle = '#0c0b09'; g.beginPath(); g.arc(doorCx, cy, R + 8, 0, TAU); g.fill(); const open = s ? _ez(Math.max(0, (ph - 0.35) / 0.65)) : 0; if (open > 0) { g.save(); g.globalAlpha = open; const rg = g.createRadialGradient(doorCx, cy, 4, doorCx, cy, R); rg.addColorStop(0, '#fff2c4'); rg.addColorStop(0.5, '#ffce5a'); rg.addColorStop(1, 'rgba(255,180,60,0)'); g.fillStyle = rg; g.beginPath(); g.arc(doorCx, cy, R, 0, TAU); g.fill(); g.restore(); } g.save(); g.translate(doorCx, cy); g.scale(Math.max(0.05, 1 - open * 0.92), 1); g.translate(-open * R * 0.5, 0); fx.metalDisc(g, 0, 0, R, true); fx.bevelRing(g, 0, 0, R, 5, ACC); for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; g.fillStyle = '#8a949a'; g.beginPath(); g.arc(Math.cos(a) * (R - 14), Math.sin(a) * (R - 14), 4, 0, TAU); g.fill(); } fx.hub(g, 0, 0, 12); g.restore(); const lx = cx + Math.min(w * 0.3, R + 42), base = cy + 22, th = s ? _ez(Math.min(1, ph / 0.35)) : 0, ang = -0.95 + th * 1.75; g.fillStyle = '#3a3126'; roundRect(g, lx - 7, base - 6, 14, 16, 3); g.fill(); g.save(); g.translate(lx, base); g.rotate(ang); g.strokeStyle = '#c9d6cf'; g.lineWidth = 7; g.lineCap = 'round'; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -46); g.stroke(); g.fillStyle = '#e64a3b'; g.beginPath(); g.arc(0, -48, 9, 0, TAU); g.fill(); g.restore(); } }); }
  // ── SKILL V3 presenters (Jake 2026-09-11): client-drawn, tap emits {type:'tap',t}; server grades vs hidden tolerance ──
  function skClock(g, w, st, t, longer){ const lv=(st&&st.level)||1; const dur=(st&&st.data&&st.data.timeMs)||(longer?Math.max(8000,14000-lv*500):Math.max(5000,9000-lv*400)); const tl=clamp(1-t/dur,0,1); const bw=Math.min(w*0.6,280), bx=(w-bw)/2, by=30; g.fillStyle="rgba(8,12,10,.8)"; roundRect(g,bx,by,bw,6,3); g.fill(); g.save(); g.fillStyle=tl<0.28?"#ff5a3c":(tl<0.55?"#ffce5a":"#7fe86a"); if(tl<0.28){g.shadowColor="#ff5a3c";g.shadowBlur=8;} roundRect(g,bx,by,bw*tl,6,3); g.fill(); g.restore(); return t>=dur; }
  function pSkPend(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const om = st.data.omega || 0.005, cx = w / 2, pivotY = 46, L = h - 118;
    return new Promise(res => {
      let raf, t0 = performance.now(), done = false;
      function fr() {
        const t = performance.now() - t0, th = 0.55 * Math.cos(om * t); bg(g, w, h); banner(g, w, 'WRECKING BALL'); if (skClock(g, w, st, t, false) && !done) { done = true; try { sfx.bust(); } catch (_e) {} cleanup(); setTimeout(() => res(ev), 200); return; }
        const bx = cx + Math.sin(th) * L, by = pivotY + Math.cos(th) * L;
        g.strokeStyle = 'rgba(127,232,106,.45)'; g.setLineDash([4, 5]); g.lineWidth = 2; g.beginPath(); g.moveTo(cx, pivotY); g.lineTo(cx, pivotY + L + 20); g.stroke(); g.setLineDash([]);
        g.strokeStyle = 'rgba(200,220,212,.55)'; g.lineWidth = 3; g.beginPath(); g.moveTo(cx, pivotY); g.lineTo(bx, by); g.stroke();
        g.fillStyle = '#9fb4ab'; g.beginPath(); g.arc(cx, pivotY, 5, 0, TAU); g.fill();
        g.save(); g.shadowColor = ACC; g.shadowBlur = 14; g.fillStyle = ACC; g.strokeStyle = '#a5851f'; g.lineWidth = 2; g.beginPath(); g.arc(bx, by, 16, 0, TAU); g.fill(); g.stroke(); g.restore();
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('TAP AT THE BOTTOM', cx, h - 14);
        fx.vignette(g, w, h); if (!done) raf = requestAnimationFrame(fr);
      }
      function tap() { if (done) return; const t = Math.round(performance.now() - t0); if (t < 250) return; done = true; ev.push({ type: 'tap', t }); try { sfx.lock(); } catch (e) {} burst(cx, pivotY + L, ACC); shake(canvas, 4); cleanup(); setTimeout(() => res(ev), 260); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr();
    });
  }
  function pSkOrbit(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const om = st.data.omega || 0.004, cx = w / 2, cy = 30 + (h - 30) * 0.5, R = Math.min(w, h - 30) * 0.3;
    return new Promise(res => {
      let raf, t0 = performance.now(), done = false;
      function fr() {
        const t = performance.now() - t0, a = om * t; bg(g, w, h); banner(g, w, 'SATELLITE LOCK'); if (skClock(g, w, st, t, false) && !done) { done = true; try { sfx.bust(); } catch (_e) {} cleanup(); setTimeout(() => res(ev), 200); return; }
        g.strokeStyle = 'rgba(255,210,74,.3)'; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
        fx.hub(g, cx, cy, 12);
        const mx = cx, my = cy - R; g.save(); g.shadowColor = '#7fe86a'; g.shadowBlur = 10; g.fillStyle = '#7fe86a'; g.beginPath(); g.moveTo(mx, my - 12); g.lineTo(mx - 8, my - 24); g.lineTo(mx + 8, my - 24); g.closePath(); g.fill(); g.restore();
        const dx = cx + Math.cos(a) * R, dy = cy + Math.sin(a) * R; g.save(); g.shadowColor = ACC; g.shadowBlur = 12; g.fillStyle = ACC; g.beginPath(); g.arc(dx, dy, 9, 0, TAU); g.fill(); g.restore();
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('TAP AT THE TOP MARKER', cx, h - 14);
        fx.vignette(g, w, h); if (!done) raf = requestAnimationFrame(fr);
      }
      function tap() { if (done) return; const t = Math.round(performance.now() - t0); if (t < 250) return; done = true; ev.push({ type: 'tap', t }); try { sfx.lock(); } catch (e) {} burst(cx, cy - R, ACC); shake(canvas, 4); cleanup(); setTimeout(() => res(ev), 260); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr();
    });
  }
  function pSkSlider(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const om = st.data.omega || 0.004, cx = w / 2, cy = 30 + (h - 30) * 0.5, half = Math.min(w * 0.4, 180);
    return new Promise(res => {
      let raf, t0 = performance.now(), done = false;
      function fr() {
        const t = performance.now() - t0, x = cx + Math.sin(om * t) * half; bg(g, w, h); banner(g, w, 'RAIL BRAKE'); if (skClock(g, w, st, t, false) && !done) { done = true; try { sfx.bust(); } catch (_e) {} cleanup(); setTimeout(() => res(ev), 200); return; }
        g.strokeStyle = 'rgba(200,220,212,.5)'; g.lineWidth = 4; g.beginPath(); g.moveTo(cx - half, cy); g.lineTo(cx + half, cy); g.stroke();
        g.strokeStyle = 'rgba(127,232,106,.55)'; g.setLineDash([4, 5]); g.lineWidth = 2; g.beginPath(); g.moveTo(cx, cy - 34); g.lineTo(cx, cy + 34); g.stroke(); g.setLineDash([]);
        g.save(); g.shadowColor = ACC; g.shadowBlur = 12; g.fillStyle = ACC; g.strokeStyle = '#a5851f'; g.lineWidth = 2; roundRect(g, x - 16, cy - 12, 32, 24, 5); g.fill(); g.stroke(); g.restore();
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('BRAKE ON THE CENTRE RAIL', cx, h - 14);
        fx.vignette(g, w, h); if (!done) raf = requestAnimationFrame(fr);
      }
      function tap() { if (done) return; const t = Math.round(performance.now() - t0); if (t < 250) return; done = true; ev.push({ type: 'tap', t }); try { sfx.lock(); } catch (e) {} burst(cx, cy, ACC); shake(canvas, 4); cleanup(); setTimeout(() => res(ev), 260); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr();
    });
  }
  async function pSkPulse(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const cycle = st.data.cycle || 1200;
    const M = skMap(w, h), cx = M.MX(150), cy = M.MY(150), Rmax = M.R(120);   // target ring radius = the PNG (rT no longer shipped in data)
    const img = await loadImg(FU(st, 0)).catch(() => null);
    return await new Promise(res => {
      let raf, t0 = performance.now(), done = false;
      function fr() {
        const t = performance.now() - t0, r = (t % cycle) / cycle; bg(g, w, h); banner(g, w, 'SHOCKWAVE'); if (skClock(g, w, st, t, false) && !done) { done = true; try { sfx.bust(); } catch (_e) {} cleanup(); setTimeout(() => res(ev), 200); return; }
        if (img) g.drawImage(img, M.ox, M.oy, M.S, M.S);   // TARGET RING overlay (server PNG)
        fx.hub(g, cx, cy, 8);
        g.save(); g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 12; g.lineWidth = 3; g.globalAlpha = 0.9; g.beginPath(); g.arc(cx, cy, Math.max(2, r * Rmax), 0, TAU); g.stroke(); g.restore();
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('TAP WHEN THE WAVE HITS THE RING', cx, h - 14);
        fx.vignette(g, w, h); if (!done) raf = requestAnimationFrame(fr);
      }
      function tap() { if (done) return; const t = Math.round(performance.now() - t0); if (t < 200) return; done = true; ev.push({ type: 'tap', t }); try { sfx.lock(); } catch (e) {} burst(cx, cy, ACC); shake(canvas, 4); cleanup(); setTimeout(() => res(ev), 260); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr();
    });
  }
  function pSkAim(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const omx = st.data.omx || 0.003, omy = st.data.omy || 0.004, cx = w / 2, cy = 30 + (h - 30) * 0.5, R = Math.min(w, h - 30) * 0.36;
    return new Promise(res => {
      let raf, t0 = performance.now(), done = false;
      function fr() {
        const t = performance.now() - t0; bg(g, w, h); banner(g, w, 'SNIPER WINDOW'); if (skClock(g, w, st, t, false) && !done) { done = true; try { sfx.bust(); } catch (_e) {} cleanup(); setTimeout(() => res(ev), 200); return; }
        g.strokeStyle = 'rgba(127,232,106,.6)'; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, 16, 0, TAU); g.stroke(); g.fillStyle = '#7fe86a'; g.beginPath(); g.arc(cx, cy, 4, 0, TAU); g.fill();
        const rx = cx + Math.sin(omx * t) * R, ry = cy + Math.sin(omy * t) * R;
        g.save(); g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 10; g.lineWidth = 2; g.beginPath(); g.arc(rx, ry, 14, 0, TAU); g.moveTo(rx - 20, ry); g.lineTo(rx + 20, ry); g.moveTo(rx, ry - 20); g.lineTo(rx, ry + 20); g.stroke(); g.restore();
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('FIRE ON THE BULLSEYE', cx, h - 14);
        fx.vignette(g, w, h); if (!done) raf = requestAnimationFrame(fr);
      }
      function tap() { if (done) return; const t = Math.round(performance.now() - t0); if (t < 250) return; done = true; ev.push({ type: 'tap', t }); try { sfx.lock(); } catch (e) {} burst(cx, cy, ACC); shake(canvas, 4); cleanup(); setTimeout(() => res(ev), 260); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr();
    });
  }
  async function pSkDial(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const v0 = st.data.v0 || 0.01, a = st.data.a || 0.000004, tStop = v0 / a;
    const M = skMap(w, h), cx = M.MX(150), cy = M.MY(150), R = M.R(96);   // green notch = the target, comes from the served PNG only (no data leak)
    const img = await loadImg(FU(st, 0)).catch(() => null);
    return await new Promise(res => {
      let raf, t0 = performance.now(), done = false;
      function fr() {
        let t = performance.now() - t0; if (t > tStop) t = tStop; const th = v0 * t - 0.5 * a * t * t; bg(g, w, h); banner(g, w, 'SAFE DIAL'); if (skClock(g, w, st, t, false) && !done) { done = true; try { sfx.bust(); } catch (_e) {} cleanup(); setTimeout(() => res(ev), 200); return; }
        fx.metalDisc(g, cx, cy, R, true); fx.bevelRing(g, cx, cy, R, 4, ACC);
        for (let k = 0; k < 24; k++) { const ang = k / 24 * TAU; g.strokeStyle = 'rgba(200,220,212,.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(cx + Math.cos(ang) * (R - 8), cy + Math.sin(ang) * (R - 8)); g.lineTo(cx + Math.cos(ang) * (R - 2), cy + Math.sin(ang) * (R - 2)); g.stroke(); }
        if (img) { g.save(); g.shadowColor = '#7fe86a'; g.shadowBlur = 10; g.drawImage(img, M.ox, M.oy, M.S, M.S); g.restore(); }   // TARGET NOTCH overlay (server PNG)
        g.save(); g.strokeStyle = '#cfe0d8'; g.lineWidth = 3; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(th) * R * 0.82, cy + Math.sin(th) * R * 0.82); g.stroke(); g.restore();
        fx.hub(g, cx, cy, 11);
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('LOCK IT ON THE GREEN NOTCH', cx, h - 14);
        fx.vignette(g, w, h); if (!done) raf = requestAnimationFrame(fr);
      }
      function tap() { if (done) return; const t = Math.round(performance.now() - t0); if (t < 250) return; done = true; ev.push({ type: 'tap', t }); try { sfx.lock(); } catch (e) {} burst(cx, cy, ACC); shake(canvas, 4); cleanup(); setTimeout(() => res(ev), 260); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr();
    });
  }
  function pSkTriple(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const pins = st.data.pins || [{ om: 0.004 }, { om: 0.005 }, { om: 0.006 }], cx = w / 2;
    return new Promise(res => {
      let raf, t0 = performance.now(), done = false, cur = 0;
      function fr() {
        const t = performance.now() - t0; bg(g, w, h); banner(g, w, 'TRIPLE TUMBLER'); if (skClock(g, w, st, t, true) && !done) { done = true; try { sfx.bust(); } catch (_e) {} cleanup(); setTimeout(() => res(ev), 200); return; }
        const gap = Math.min(w * 0.26, 96), xs = [cx - gap, cx, cx + gap], L = h - 150, pivotY = 54;
        for (let i = 0; i < 3; i++) { const th = 0.5 * Math.cos(pins[i].om * t), bx = xs[i] + Math.sin(th) * (L * 0.4), by = pivotY + Math.cos(th) * (L * 0.7), act = i === cur, dn = i < cur;
          g.strokeStyle = 'rgba(127,232,106,.4)'; g.setLineDash([3, 4]); g.beginPath(); g.moveTo(xs[i], pivotY); g.lineTo(xs[i], pivotY + L * 0.7 + 14); g.stroke(); g.setLineDash([]);
          g.strokeStyle = 'rgba(200,220,212,.5)'; g.lineWidth = 2; g.beginPath(); g.moveTo(xs[i], pivotY); g.lineTo(bx, by); g.stroke();
          g.save(); if (act) { g.shadowColor = ACC; g.shadowBlur = 12; } g.fillStyle = dn ? '#6ad07f' : (act ? ACC : '#5a6b60'); g.beginPath(); g.arc(bx, by, act ? 13 : 10, 0, TAU); g.fill(); g.restore();
        }
        fx.readout(g, cur + '/3', cx, 46, 16, ACC);
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('TAP EACH PIN AT ITS BOTTOM', cx, h - 14);
        fx.vignette(g, w, h); if (!done) raf = requestAnimationFrame(fr);
      }
      function tap() { if (done) return; const t = Math.round(performance.now() - t0); if (t < 200) return; ev.push({ type: 'tap', t }); try { sfx.lock(); } catch (e) {} cur++; if (cur >= 3) { done = true; burst(cx, h / 2, ACC); shake(canvas, 4); cleanup(); setTimeout(() => res(ev), 260); } }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr();
    });
  }
  function pSkAlign(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const arcs = st.data.arcs || [{ om: 0.002, ph: 0 }, { om: 0.003, ph: 1 }, { om: 0.004, ph: 2 }], cx = w / 2, cy = 30 + (h - 30) * 0.5, top = 3 * Math.PI / 2;
    return new Promise(res => {
      let raf, t0 = performance.now(), done = false;
      function fr() {
        const t = performance.now() - t0; bg(g, w, h); banner(g, w, 'TRIPLE ALIGN'); if (skClock(g, w, st, t, true) && !done) { done = true; try { sfx.bust(); } catch (_e) {} cleanup(); setTimeout(() => res(ev), 200); return; }
        g.save(); g.strokeStyle = 'rgba(127,232,106,.5)'; g.setLineDash([4, 5]); g.lineWidth = 2; g.beginPath(); g.moveTo(cx, cy - 10); g.lineTo(cx, 42); g.stroke(); g.setLineDash([]); g.restore();
        for (let i = 0; i < arcs.length; i++) { const R = 30 + i * 26, ang = arcs[i].om * t + arcs[i].ph; g.strokeStyle = 'rgba(255,210,74,.22)'; g.lineWidth = 6; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
          const near = Math.abs(((ang - top) % TAU + TAU) % TAU), aligned = Math.min(near, TAU - near) < 0.3;
          g.save(); g.strokeStyle = aligned ? '#7fe86a' : ACC; g.shadowColor = g.strokeStyle; g.shadowBlur = aligned ? 12 : 4; g.lineWidth = 6; g.beginPath(); g.arc(cx, cy, R, ang - 0.3, ang + 0.3); g.stroke(); g.restore();
        }
        fx.hub(g, cx, cy, 8);
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('FIRE WHEN ALL GAPS HIT THE TOP', cx, h - 14);
        fx.vignette(g, w, h); if (!done) raf = requestAnimationFrame(fr);
      }
      function tap() { if (done) return; const t = Math.round(performance.now() - t0); if (t < 250) return; done = true; ev.push({ type: 'tap', t }); try { sfx.lock(); } catch (e) {} burst(cx, cy, ACC); shake(canvas, 4); cleanup(); setTimeout(() => res(ev), 260); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr();
    });
  }
  async function pSkTorque(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const rate = st.data.rate || 0.7, cx = w / 2;   // green band = the target, from the served PNG (target no longer in data)
    const M = skMap(w, h); const gw = M.R(60), gx = M.MX(120), topY = M.MY(62), botY = M.MY(232), gaugeH = botY - topY;   // 300-space gauge: gx=120,top=62,bot=232 (mirrors render.js)
    const img = await loadImg(FU(st, 0)).catch(() => null);
    return await new Promise(res => {
      let raf, t0 = performance.now(), done = false, holding = false, holdStart = 0;
      function fr() {
        const hold = holding ? (performance.now() - holdStart) : 0; const v = clamp(rate * hold / 1000, 0, 1); bg(g, w, h); banner(g, w, 'TORQUE WRENCH');
        g.fillStyle = 'rgba(8,12,10,.85)'; roundRect(g, gx, topY, gw, gaugeH, 8); g.fill();
        if (img) g.drawImage(img, M.ox, M.oy, M.S, M.S);   // GREEN TOLERANCE BAND overlay (server PNG)
        const fy = botY - v * gaugeH; g.save(); g.fillStyle = ACC; g.shadowColor = g.fillStyle; g.shadowBlur = 12; g.fillRect(gx + 3, fy, gw - 6, botY - fy); g.restore();
        g.fillStyle = '#fff'; g.fillRect(gx, fy - 1, gw, 2);
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText(holding ? 'RELEASE IN THE GREEN' : 'HOLD TO BUILD TORQUE', cx, h - 14);
        fx.vignette(g, w, h); if (!done) raf = requestAnimationFrame(fr);
      }
      function down() { if (holding || done) return; holding = true; holdStart = performance.now(); ev.push({ type: 'down', t: Math.round(holdStart - t0) }); try { sfx.whir(); } catch (e) {} }
      function up() { if (!holding || done) return; holding = false; done = true; ev.push({ type: 'up', t: Math.round(performance.now() - t0) }); try { sfx.lock(); } catch (e) {} burst(cx, h / 2, ACC); shake(canvas, 4); cleanup(); setTimeout(() => res(ev), 260); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointerleave', up); }
      canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointerleave', up); fr();
    });
  }
  async function pSkShear(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const om = st.data.omega || 0.004, cx = w / 2;   // shear line = the target, from the served PNG (shear no longer in data)
    const M = skMap(w, h); const cw = M.R(66), cx0 = M.MX(150) - cw / 2, topY = M.MY(60), botY = M.MY(240), chH = botY - topY;   // 300-space channel: top=60,bot=240 (mirrors render.js)
    const img = await loadImg(FU(st, 0)).catch(() => null);
    return await new Promise(res => {
      let raf, t0 = performance.now(), done = false;
      function fr() {
        const t = performance.now() - t0, pos = 0.5 + 0.5 * Math.sin(om * t); bg(g, w, h); banner(g, w, 'SHEAR LINE'); if (skClock(g, w, st, t, false) && !done) { done = true; try { sfx.bust(); } catch (_e) {} cleanup(); setTimeout(() => res(ev), 200); return; }
        g.fillStyle = 'rgba(8,12,10,.8)'; roundRect(g, cx0, topY, cw, chH, 6); g.fill(); g.strokeStyle = 'rgba(255,210,74,.3)'; g.lineWidth = 1.5; g.strokeRect(cx0, topY, cw, chH);
        if (img) g.drawImage(img, M.ox, M.oy, M.S, M.S);   // SHEAR LINE overlay (server PNG)
        const py = topY + pos * chH; g.save(); g.fillStyle = ACC; g.strokeStyle = '#a5851f'; g.lineWidth = 2; g.shadowColor = ACC; g.shadowBlur = 10; roundRect(g, cx0 + 6, py - 8, cw - 12, 16, 4); g.fill(); g.stroke(); g.restore();
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('TAP ON THE SHEAR LINE', cx, h - 14);
        fx.vignette(g, w, h); if (!done) raf = requestAnimationFrame(fr);
      }
      function tap() { if (done) return; const t = Math.round(performance.now() - t0); if (t < 250) return; done = true; ev.push({ type: 'tap', t }); try { sfx.lock(); } catch (e) {} burst(cx, h / 2, ACC); shake(canvas, 4); cleanup(); setTimeout(() => res(ev), 260); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr();
    });
  }
  async function pSkTimer(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const period = st.data.period || 1200, cx = w / 2;   // mark = the target, from the served PNG (mark no longer in data)
    const M = skMap(w, h), cy = M.MY(150); const bw = M.R(240), bx = M.MX(30), by = M.MY(140);   // 300-space bar: x 30..270, y=150 (mirrors render.js)
    const img = await loadImg(FU(st, 0)).catch(() => null);
    return await new Promise(res => {
      let raf, t0 = performance.now(), done = false;
      function fr() {
        const t = performance.now() - t0, pos = (t % period) / period; bg(g, w, h); banner(g, w, 'DETONATOR TIMER');
        g.fillStyle = 'rgba(8,12,10,.85)'; roundRect(g, bx, by, bw, 20, 8); g.fill(); g.strokeStyle = 'rgba(255,210,74,.3)'; g.lineWidth = 1.5; g.strokeRect(bx, by, bw, 20);
        if (img) g.drawImage(img, M.ox, M.oy, M.S, M.S);   // MARK overlay (server PNG)
        const px = bx + pos * bw; g.save(); g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 10; g.fillRect(px - 2, by, 4, 20); g.restore();
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('TAP EXACTLY ON THE MARK', cx, h - 14);
        fx.vignette(g, w, h); if (!done) raf = requestAnimationFrame(fr);
      }
      function tap() { if (done) return; const t = Math.round(performance.now() - t0); if (t < 150) return; done = true; ev.push({ type: 'tap', t }); try { sfx.lock(); } catch (e) {} burst(cx, cy, ACC); shake(canvas, 4); cleanup(); setTimeout(() => res(ev), 260); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr();
    });
  }
  function pSkBeam(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const oma = st.data.oma || 0.003, omb = st.data.omb || 0.002, cx = w / 2, cy = 30 + (h - 30) * 0.5, x0 = 34, x1 = w - 34;
    return new Promise(res => {
      let raf, t0 = performance.now(), done = false;
      function fr() {
        const t = performance.now() - t0, ba = (1 + Math.sin(oma * t)) / 2, gp = (1 + Math.sin(omb * t)) / 2; bg(g, w, h); banner(g, w, 'TRIP BEAM');
        g.strokeStyle = 'rgba(200,220,212,.4)'; g.lineWidth = 2; g.beginPath(); g.moveTo(x0, cy); g.lineTo(x1, cy); g.stroke();
        const gx = x0 + gp * (x1 - x0); g.save(); g.strokeStyle = '#7fe86a'; g.shadowColor = '#7fe86a'; g.shadowBlur = 8; g.lineWidth = 3; g.strokeRect(gx - 16, cy - 16, 32, 32); g.restore();
        const bx = x0 + ba * (x1 - x0); g.save(); g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 12; g.beginPath(); g.arc(bx, cy, 8, 0, TAU); g.fill(); g.restore();
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('CUT WHEN THE BEAM HITS THE GAP', cx, h - 14);
        fx.vignette(g, w, h); if (!done) raf = requestAnimationFrame(fr);
      }
      function tap() { if (done) return; const t = Math.round(performance.now() - t0); if (t < 250) return; done = true; ev.push({ type: 'tap', t }); try { sfx.lock(); } catch (e) {} burst(cx, cy, ACC); shake(canvas, 4); cleanup(); setTimeout(() => res(ev), 260); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr();
    });
  }
  function pSkDrag(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const amp = st.data.amp || 0.2, fx2 = st.data.fx || 6, x0 = 24, x1 = w - 24, y0 = 40, yh = h - 60;
    const dur = st.data.timeMs || Math.max(3200, 6000 - ((st.level || 1) * 280));
    const wireY = (nx) => y0 + (0.5 + amp * Math.sin(fx2 * nx)) * yh;
    const devCol = (dv) => dv < 0.05 ? '#3dff8f' : (dv < 0.11 ? '#ffd24a' : '#ff5a3c');
    return new Promise(res => {
      let raf, t0 = performance.now(), done = false, dragging = false, lastT = 0, trail = [], curDev = 0;
      function fr() {
        bg(g, w, h); banner(g, w, 'STEADY HAND');
        const _t = performance.now() - t0, _tl = clamp(1 - _t / dur, 0, 1);
        { const cbw = Math.min(w * 0.6, 280), cbx = (w - cbw) / 2, cby = 30; g.fillStyle = 'rgba(8,12,10,.8)'; roundRect(g, cbx, cby, cbw, 6, 3); g.fill(); g.save(); g.fillStyle = _tl < 0.28 ? '#ff5a3c' : (_tl < 0.55 ? '#ffce5a' : '#7fe86a'); if (_tl < 0.28) { g.shadowColor = '#ff5a3c'; g.shadowBlur = 8; } roundRect(g, cbx, cby, cbw * _tl, 6, 3); g.fill(); g.restore(); }
        if (_t >= dur && !done) { done = true; try { sfx.bust(); } catch (e) {} shake(canvas, 7); cleanup(); setTimeout(() => res(ev.length ? ev : [{ type: 'timeout' }]), 300); return; }
        g.strokeStyle = 'rgba(255,210,74,.5)'; g.lineWidth = 4; g.lineCap = 'round'; g.beginPath(); for (let i = 0; i <= 48; i++) { const nx = i / 48, X = x0 + nx * (x1 - x0), Y = wireY(nx); i ? g.lineTo(X, Y) : g.moveTo(X, Y); } g.stroke();
        for (let i = 1; i < trail.length; i++) { const a = trail[i - 1], b = trail[i]; g.save(); g.strokeStyle = devCol(b.dev); g.shadowColor = g.strokeStyle; g.shadowBlur = 6; g.lineWidth = 5; g.beginPath(); g.moveTo(a.X, a.Y); g.lineTo(b.X, b.Y); g.stroke(); g.restore(); }
        if (trail.length) { const p = trail[trail.length - 1], wy = wireY((p.X - x0) / (x1 - x0)); g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 1; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(p.X, p.Y); g.lineTo(p.X, wy); g.stroke(); g.setLineDash([]); g.save(); g.fillStyle = devCol(p.dev); g.shadowColor = g.fillStyle; g.shadowBlur = 12; g.beginPath(); g.arc(p.X, p.Y, 7, 0, TAU); g.fill(); g.restore(); }
        fx.readout(g, dragging ? ('OFF ' + Math.round(curDev * 100) + '%') : '', w / 2, 54, 15, devCol(curDev));
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText(dragging ? 'STAY ON THE WIRE' : 'TRACE THE WIRE BEFORE TIME RUNS OUT', w / 2, h - 14);
        fx.vignette(g, w, h); if (!done) raf = requestAnimationFrame(fr);
      }
      function pos(e) { const rect = canvas.getBoundingClientRect(); return { x: (e.clientX - rect.left) * (w / rect.width), y: (e.clientY - rect.top) * (h / rect.height) }; }
      function down(e) { if (done) return; dragging = true; trail = []; sample(e); }
      function move(e) { if (!dragging || done) return; const t = performance.now() - t0; if (t - lastT < 30) return; lastT = t; sample(e); }
      function sample(e) { const p = pos(e); const nx = clamp((p.x - x0) / (x1 - x0), 0, 1), ny = clamp((p.y - y0) / yh, 0, 1); const dev = Math.abs(ny - (0.5 + amp * Math.sin(fx2 * nx))); curDev = dev; ev.push({ type: 'pt', x: +nx.toFixed(3), y: +ny.toFixed(3) }); trail.push({ X: x0 + nx * (x1 - x0), Y: y0 + ny * yh, dev: dev }); }
      function up() { if (done || !dragging) return; done = true; try { sfx.lock(); } catch (e) {} cleanup(); setTimeout(() => res(ev), 320); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointerleave', up); }
      canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointerleave', up); fr();
    });
  }
  async function pSkMatch(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const speed = st.data.speed || 0.6, cx = w / 2;   // target LINE = the served PNG (target no longer in data)
    const M = skMap(w, h); const gw = M.R(60), gx = M.MX(120), topY = M.MY(60), botY = M.MY(240), gaugeH = botY - topY;   // 300-space gauge: gx=120,top=60,bot=240 (mirrors render.js)
    const img = await loadImg(FU(st, 0)).catch(() => null);
    return await new Promise(res => {
      let raf, t0 = performance.now(), done = false;
      function fr() {
        const t = performance.now() - t0, bar = clamp(speed * t / 1000, 0, 1); bg(g, w, h); banner(g, w, 'SURGE MATCH');
        g.fillStyle = 'rgba(8,12,10,.85)'; roundRect(g, gx, topY, gw, gaugeH, 8); g.fill();
        if (img) g.drawImage(img, M.ox, M.oy, M.S, M.S);   // TARGET LINE overlay (server PNG)
        const by = botY - bar * gaugeH; g.save(); g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 12; g.fillRect(gx + 3, by, gw - 6, botY - by); g.restore(); g.fillStyle = '#fff'; g.fillRect(gx, by - 1, gw, 2);
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('TAP WHEN THE SURGE MEETS THE LINE', cx, h - 14);
        fx.vignette(g, w, h); if (!done) raf = requestAnimationFrame(fr);
      }
      function tap() { if (done) return; const t = Math.round(performance.now() - t0); if (t < 150) return; done = true; ev.push({ type: 'tap', t }); try { sfx.lock(); } catch (e) {} burst(cx, h / 2, ACC); shake(canvas, 4); cleanup(); setTimeout(() => res(ev), 260); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr();
    });
  }
  function pSkGrid(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = []; const cells = st.data.cells || [], n = st.data.n || cells.length, dur = st.data.dur || 5000, x0 = 30, y0 = 44, aw = w - 60, ah = h - 90;
    return new Promise(res => {
      let raf, t0 = performance.now(), done = false, hit = new Array(n).fill(false);
      function fr() {
        const t = performance.now() - t0; bg(g, w, h); banner(g, w, 'REFLEX GRID'); let got = 0;
        for (let i = 0; i < n; i++) { const c = cells[i], cxp = x0 + c.x * aw, cyp = y0 + c.y * ah, lit = t >= c.s && t <= c.e && !hit[i];
          g.save(); if (lit) { g.shadowColor = ACC; g.shadowBlur = 16; g.fillStyle = ACC; } else if (hit[i]) { g.fillStyle = '#6ad07f'; } else { g.fillStyle = 'rgba(60,60,60,.5)'; } g.beginPath(); g.arc(cxp, cyp, 20, 0, TAU); g.fill(); g.restore(); if (hit[i]) got++; }
        fx.readout(g, got + '/' + n, w / 2, 44, 16, ACC);
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('TAP EACH TARGET WHILE IT GLOWS', w / 2, h - 14);
        fx.vignette(g, w, h);
        if (t > dur && !done) { done = true; cleanup(); setTimeout(() => res(ev), 200); return; }
        if (!done) raf = requestAnimationFrame(fr);
      }
      function tap(e) { if (done) return; const rect = canvas.getBoundingClientRect(), px = (e.clientX - rect.left) * (w / rect.width), py = (e.clientY - rect.top) * (h / rect.height), t = Math.round(performance.now() - t0);
        for (let i = 0; i < n; i++) { const c = cells[i], cxp = x0 + c.x * aw, cyp = y0 + c.y * ah; if (!hit[i] && Math.hypot(px - cxp, py - cyp) <= 26 && t >= c.s - 60 && t <= c.e + 60) { hit[i] = true; ev.push({ type: 'hit', i: i, t }); try { sfx.lock(); } catch (e2) {} break; } } }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr();
    });
  }
  // ── NEW (V2 Finance theme): watch deposits (green +) and withdrawals (red -) flash one at a time, recall the final balance.
  async function pLedger(canvas, st) {
    const { g, w, h } = fit(canvas);
    for (let i = 0; i < st.frames; i++) { const img = await loadImg(FU(st, i)); bg(g, w, h); banner(g, w, 'TRACK THE BALANCE  ' + (i + 1) + '/' + st.frames); drawFrame(g, img, w, h); await wait(st.flashMs || 900); bg(g, w, h); banner(g, w, 'TRACK THE BALANCE'); await wait(160); }
    let entry = ''; const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'];
    return await new Promise(res => {
      function draw() { bg(g, w, h); banner(g, w, 'FINAL BALANCE = ?'); g.fillStyle = '#eafff3'; g.textAlign = 'center'; g.font = "800 30px 'Space Mono',monospace"; g.fillText(entry || '_', w / 2, 70); const kw = (w - 40) / 3, kh = (h - 90) / 4; keys.forEach((k, i) => { const x = 20 + (i % 3) * kw, y = 84 + ((i / 3) | 0) * kh; fx.tile(g, x + 3, y + 3, kw - 6, kh - 6, 7, { active: k === 'OK' }); g.fillStyle = k === 'OK' ? '#1a1206' : '#e6ddc8'; g.font = "700 19px 'Chakra Petch',sans-serif"; g.fillText(k, x + kw / 2, y + kh / 2 + 7); }); }
      draw(); canvas.addEventListener('pointerdown', function hit(e) { const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left, py = e.clientY - r.top; const KW = (r.width - 40) / 3, KH = (r.height - 90) / 4; const col = Math.floor((px - 20) / KW), row = Math.floor((py - 84) / KH); const i = row * 3 + col; if (col < 0 || col > 2 || i < 0 || i >= keys.length) return; const k = keys[i]; if (k === 'C') entry = ''; else if (k === 'OK') { canvas.removeEventListener('pointerdown', hit); res([{ type: 'answer', value: parseInt(entry || '-1', 10) }]); return; } else if (entry.length < 5) entry += k; draw(); });
    });
  }
  // ── NEW (V2 Tech): tap the track to match a target voltage tick that lives only in the served pixels.
  async function pVoltage(canvas, st) {
    const { g, w, h } = fit(canvas); const ev = [];
    for (let i = 0; i < st.frames; i++) {
      const img = await loadImg(FU(st, i)); bg(g, w, h); banner(g, w, 'MATCH THE VOLTAGE  ' + (i + 1) + '/' + st.frames); drawFrame(g, img, w, h);
      g.fillStyle = ACC; g.textAlign = 'center'; g.font = "700 12px 'Chakra Petch',sans-serif"; g.fillText('tap the track on the bright mark', w / 2, h - 16);
      await new Promise(res => { function hit(e) { const p = toL(canvas, e); let pos = (p.x - 30) / (SZ - 60); pos = Math.max(0, Math.min(1, pos)); ev.push({ type: 'lock', pos }); canvas.removeEventListener('pointerdown', hit); setTimeout(res, 130); } canvas.addEventListener('pointerdown', hit); });
    }
    return ev;
  }
  const P = { ledger: pLedger, heatmap: pHeatmap, voltage: pSkMatch, oddone: pOddone, spatial: pSpatial, combo: pCombo, lineup: pLineup, reverse: pLineup, safecombo: pLineup, colorlock: pColorlock, bearing: pBearing, denoms: pDenoms, glyphset: pGlyphset, simon: pSimon, gridrecall: pGridRecall, pairs: pPairs, nback: pNback, countflash: pCountflash, whatchanged: pWhatChanged, journey: pSpatial, shade: pShade, dial: pSkDial, rhythm: pRhythm, beam: pSkBeam, wirecut: pSkDrag, stopwatch: pSkTimer, targets: pTargets, sort: pSort, torque: pSkTorque, pendulum: pSkPend, crosshair: pSkAim, orbit: pSkOrbit, slider: pSkSlider, align3: pSkAlign, pulse: pSkPulse, keypad: pSkGrid, hotwire: pHotwire, sonicrack: pSonic, dialcombo: pSkTriple, tumbler: pSkShear, pressureplates: pPressure, reflex: pReflex, mash: pMash, silentalarm: pSilent, coinflip: pCoinflip, wheel: pWheel, dice: pDice, cardflip: pCardflip, slots: pSlots, roulette: pRoulette, shells: pShells, scratch: pScratch, plinko: pPlinko, keno: pKeno, goldbar: pGoldbar, magnetgrab: pMagnetgrab, fuserace: pFuserace, elevatorroulette: pElevator, safedial: pSafedial, appraise: pPercept, counttake: pPercept, forgery: pPercept, balance: pPercept, sigil: pPercept, oddglyph: pPercept, readdial: pPercept, peephole: pPercept, shaderank: pPercept, shadowmatch: pPercept, muller: pPercept, ponzo: pPercept, simcontrast: pPercept, camobreak: pPercept, figurenoise: pPercept };   // PERCEPTION: all 15 route the one server-PNG-stimulus judgment presenter (branches on data.kind); +5 illusion games

  // ── Per-game "how it works" directions (simple, 2 lines each) + family fallbacks ──────────────────────────────────────────
  const _LUCK = ['coinflip','wheel','dice','cardflip','slots','roulette','shells','scratch','plinko','keno','goldbar','magnetgrab','fuserace','elevatorroulette','safedial'];
  const _MEM = ['lineup','reverse','simon','spatial','gridrecall','pairs','nback','journey','ledger','heatmap','safecombo','colorlock','bearing','denoms','glyphset'];
  const DIR = {
    beam: { t: 'Trip Beam', d: ['A beam and a gap sweep the rail.', 'Cut when the beam hits the gap.'] },
    wirecut: { t: 'Steady Hand', d: ['Drag the cutter along the wire.', 'Stay on the line the whole way.'] },
    dial: { t: 'Safe Dial', d: ['A dial spins and slows.', 'Lock it on the green notch.'] },
    stopwatch: { t: 'Detonator Timer', d: ['A sweep runs the bar.', 'Tap exactly on the mark.'] },
    torque: { t: 'Torque Wrench', d: ['Hold to build torque.', 'Release inside the green band.'] },
    dialcombo: { t: 'Triple Tumbler', d: ['Three pins swing.', 'Tap each at its bottom in turn.'] },
    tumbler: { t: 'Shear Line', d: ['A pin rides up and down.', 'Tap it on the shear line.'] },
    keypad: { t: 'Reflex Grid', d: ['Targets glow one by one.', 'Tap each while it glows.'] },
    voltage: { t: 'Surge Match', d: ['The surge rises.', 'Tap when it meets the target line.'] },
    pendulum: { t: 'Wrecking Ball', d: ['A ball swings on a chain.', 'Tap as it passes through the bottom.'] },
    crosshair: { t: 'Sniper Window', d: ['A reticle traces a figure-8.', 'Fire on the bullseye.'] },
    orbit: { t: 'Satellite Lock', d: ['A satellite circles the ring.', 'Tap as it crosses the top marker.'] },
    slider: { t: 'Rail Brake', d: ['A cart slides along the rail.', 'Brake it on the centre mark.'] },
    align3: { t: 'Triple Align', d: ['Three rings spin.', 'Fire when all gaps hit the top.'] },
    pulse: { t: 'Shockwave', d: ['A wave expands on a loop.', 'Tap when it reaches the ring.'] },
    lineup: { t: 'Lineup', d: ['Shapes flash one at a time.', 'Repeat them in order on the pad.'] },
    reverse: { t: 'Reverse', d: ['Shapes flash in order.', 'Repeat them in REVERSE order.'] },
    simon: { t: 'Simon', d: ['Pads light in a sequence.', 'Repeat the sequence.'] },
    spatial: { t: 'Spatial Recall', d: ['Cells light on a grid.', 'Tap them back in the same order.'] },
    gridrecall: { t: 'Grid Recall', d: ['A pattern of cells lights up.', 'Tap all the cells you saw.'] },
    pairs: { t: 'Pairs', d: ['Study the pairs.', 'Match each prompt to its partner.'] },
    nback: { t: 'N-Back', d: ['Shapes stream past.', 'Flag when one repeats from N steps back.'] },
    journey: { t: 'Journey', d: ['A path lights across the grid.', 'Retrace the path in order.'] },
    ledger: { t: 'The Ledger', d: ['Deposits and withdrawals flash.', 'Track the running total, enter the final.'] },
    heatmap: { t: 'Heat Map', d: ['Hot cells flash briefly.', 'Tap all the hot cells.'] },
    safecombo: { t: 'Sorted Combo', d: ['Digits flash one at a time.', 'Tap them back from lowest to highest.'] },
    colorlock: { t: 'Shift Lock', d: ['Colours flash with a shift number.', 'Tap each colour shifted forward by that many.'] },
    bearing: { t: 'Bearing', d: ['Directions flash in order.', 'Repeat the path (up/right/down/left) in order.'] },
    denoms: { t: 'The Count', d: ['Bill values flash in order.', 'Repeat the values in order.'] },
    glyphset: { t: 'Shortlist', d: ['A set of shapes appears together.', 'Pick the shapes you saw, then press Done.'] },
    appraise: { t: 'Appraise the Haul', d: ['Two loot piles flash.', 'Pick the more valuable — beat the clock.'] },
    counttake: { t: 'Count the Take', d: ['A scatter of gems appears.', 'Estimate how many, fast.'] },
    forgery: { t: 'Spot the Forgery', d: ['A grid of gold bars.', 'Tap the one with the off shade.'] },
    balance: { t: 'Balance the Safes', d: ['Two safes on a beam.', 'Tap the heavier side.'] },
    sigil: { t: 'Match the Sigil', d: ['A target glyph up top.', 'Tap its twin in the lineup.'] },
    oddglyph: { t: 'Odd Glyph Out', d: ['A grid of one glyph.', 'Tap the one that differs.'] },
    readdial: { t: 'Read the Dial', d: ['A needle points at a value.', 'Pick the range it lands in.'] },
    peephole: { t: 'Through the Peephole', d: ['A blurred item up top.', 'Tap which option it is.'] },
    shaderank: { t: 'Shade Rank', d: ['A row of near-identical shades.', 'Tap the lightest.'] },
    shadowmatch: { t: 'Shadow Match', d: ['A silhouette up top.', 'Tap the object that casts it.'] },
    muller: { t: 'Longer Line', d: ['Two lines, one wears misleading fins.', 'Pick the truly longer one.'] },
    ponzo: { t: 'True Size', d: ['Two bars between converging rails.', 'Pick the truly wider one.'] },
    simcontrast: { t: 'True Shade', d: ['Swatches on tricky backgrounds.', 'Tap the one that truly matches.'] },
    camobreak: { t: 'Break the Camo', d: ['A camouflaged grid.', 'Tap the tile that breaks the pattern.'] },
    figurenoise: { t: 'Hidden Figure', d: ['A shape buried in noise.', 'Tap which clean shape it is.'] },
  };
  function directions(k) { if (DIR[k]) return DIR[k]; if (_LUCK.includes(k)) return { t: 'Luck', d: ['Pure chance decides this one.', 'Tap to play your fate.'] }; if (_MEM.includes(k)) return { t: 'Memory', d: ['Watch what flashes.', 'Then repeat it from memory.'] }; return { t: 'Skill', d: ['Time it right.', 'Tap the moment the marker hits the target.'] }; }
  // ── shared pre-game countdown (3-2-1-GO) ──
  async function countdown(canvas, title) {
    const { g, w, h } = fit(canvas); const seq = ['3', '2', '1', 'GO'];
    for (let i = 0; i < seq.length; i++) { bg(g, w, h); banner(g, w, title || 'GET READY'); g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 26; g.font = '800 ' + Math.round((h - 30) * 0.4) + "px 'Chakra Petch',sans-serif"; g.fillText(seq[i], w / 2, 30 + (h - 30) / 2); g.restore(); try { beep(i === seq.length - 1 ? 880 : 520); } catch (e) {} await wait(i === seq.length - 1 ? 430 : 620); }
  }
  // ── HOW IT WORKS: definition + a looping ILLUSTRATIVE demo of the mechanic, resolves on tap.
  // SECURITY: the demo is entirely self-contained — it draws its OWN fixed example and a scripted tap. It never starts a
  // real session, never reads `secret`/`pixels`, and contains NO solving logic. A "watch it win the real board" demo would be
  // exactly the client-side oracle that beat V1; this teaches the mechanic without shipping anything an attacker could extract.
  // map each game to the demo SHAPE that mirrors its actual presenter (so How It Works == the game, not a generic stand-in)
  function demoShape(k) {
    if (_LUCK.includes(k)) return 'fate';
    if (k === 'glyphset') return 'set';
    if (['spatial', 'journey', 'gridrecall', 'heatmap', 'pairs'].includes(k)) return 'grid';
    if (_MEM.includes(k)) return 'span';
    if (['dial', 'dialcombo', 'stopwatch'].includes(k)) return 'rotary';
    if (['torque', 'voltage', 'tumbler'].includes(k)) return 'vertical';
    if (['beam', 'sonicrack'].includes(k)) return 'beam';
    if (k === 'orbit') return 'orbit';
    if (k === 'crosshair') return 'crosshair';
    if (k === 'pulse') return 'pulse';
    if (k === 'align3') return 'triplering';
    if (k === 'keypad') return 'keypad';
    return 'band';   // slider / pendulum / wirecut / hotwire (horizontal sweep into a band)
  }
  // draw the looping illustrative demo for a shape. C = {bx0,bx1,by0,by1,bcx,bcy,bw,bh,t}. Self-contained: no session, no secret.
  function drawDemo(shape, g, C) {
    const { bx0, bx1, by0, by1, bcx, bcy, bw, bh, t } = C; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    const tapText = (x, y) => { g.fillStyle = ACC; g.font = "800 15px 'Chakra Petch',sans-serif"; g.fillText('TAP!', x, y); };
    if (shape === 'rotary') {
      const R = Math.min(bw, bh) * 0.34, cx = bcx, cy = bcy, dp = (t % 2.6) / 2.6, ta = -Math.PI * 0.5;
      fx.metalDisc(g, cx, cy, R + 10, false); fx.bevelRing(g, cx, cy, R + 9, 4);
      g.save(); const face = g.createRadialGradient(cx - R * .3, cy - R * .3, R * .1, cx, cy, R); face.addColorStop(0, '#20221f'); face.addColorStop(1, '#0c0d0b'); g.fillStyle = face; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill(); g.restore();
      fx.ticks(g, cx, cy, R - 2, 48, 4);
      g.save(); g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 12; g.lineWidth = 6; g.beginPath(); g.arc(cx, cy, R - 8, ta - 0.22, ta + 0.22); g.stroke(); g.restore();
      const a = dp < 0.5 ? (ta + easeOutExpo(dp / 0.5) * TAU * 1.1) : ta, nx = cx + Math.cos(a) * (R - 6), ny = cy + Math.sin(a) * (R - 6);
      g.save(); g.strokeStyle = 'rgba(0,0,0,.5)'; g.lineWidth = 6; g.lineCap = 'round'; g.beginPath(); g.moveTo(cx + 2, cy + 3); g.lineTo(nx + 2, ny + 3); g.stroke();
      const ng = g.createLinearGradient(cx, cy, nx, ny); ng.addColorStop(0, '#8a6a1e'); ng.addColorStop(1, '#fff0b0'); g.strokeStyle = ng; g.shadowColor = ACC; g.shadowBlur = 14; g.lineWidth = 4; g.beginPath(); g.moveTo(cx, cy); g.lineTo(nx, ny); g.stroke(); g.restore();
      fx.hub(g, cx, cy, 9); fx.glass(g, cx, cy, R);
      if (dp >= 0.5) { g.fillStyle = ACC; g.font = "800 13px 'Chakra Petch',sans-serif"; g.fillText('LOCKED', cx, by1 - 2); }
    } else if (shape === 'band') {
      const dp = (t % 2.4) / 2.4, mx = bx0 + dp * bw, band = bw * 0.13, inb = Math.abs(mx - bcx) < band / 2;
      g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 2; g.beginPath(); g.moveTo(bx0, bcy); g.lineTo(bx1, bcy); g.stroke();
      g.fillStyle = inb ? 'rgba(255,214,90,.4)' : 'rgba(255,214,90,.2)'; g.fillRect(bcx - band / 2, bcy - 22, band, 44); g.strokeStyle = ACC; g.lineWidth = 1.5; g.strokeRect(bcx - band / 2, bcy - 22, band, 44);
      g.save(); g.fillStyle = inb ? '#fff' : ACC; g.shadowColor = ACC; g.shadowBlur = inb ? 20 : 10; g.beginPath(); g.arc(mx, bcy, inb ? 11 : 8, 0, TAU); g.fill(); g.restore();
      if (inb) tapText(bcx, by0 + 22);
    } else if (shape === 'beam') {
      const dp = (t % 2.4) / 2.4, mx = bx0 + dp * bw, gap = bw * 0.16, inb = Math.abs(mx - bcx) < gap / 2;
      g.save(); g.strokeStyle = '#ff5a4a'; g.shadowColor = '#ff5a4a'; g.shadowBlur = 8; g.lineWidth = 4; g.beginPath(); g.moveTo(bx0, bcy); g.lineTo(bcx - gap / 2, bcy); g.stroke(); g.beginPath(); g.moveTo(bcx + gap / 2, bcy); g.lineTo(bx1, bcy); g.stroke(); g.restore();
      g.fillStyle = inb ? 'rgba(255,214,90,.35)' : 'rgba(255,214,90,.18)'; g.fillRect(bcx - gap / 2, bcy - 20, gap, 40); g.strokeStyle = ACC; g.lineWidth = 1.5; g.strokeRect(bcx - gap / 2, bcy - 20, gap, 40);
      g.save(); g.fillStyle = inb ? '#fff' : '#ffe9a8'; g.shadowColor = ACC; g.shadowBlur = 12; g.beginPath(); g.moveTo(mx, bcy - 14); g.lineTo(mx - 8, bcy - 28); g.lineTo(mx + 8, bcy - 28); g.closePath(); g.fill(); g.restore();
      if (inb) tapText(bcx, by0 + 22);
    } else if (shape === 'vertical') {
      const dp = (t % 2.4) / 2.4, ph = (dp * 2) % 2, pos = ph < 1 ? ph : 2 - ph, gx = bcx, my = by1 - pos * (by1 - by0), band = bh * 0.18, inb = Math.abs(my - bcy) < band / 2;
      g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 2; g.beginPath(); g.moveTo(gx, by0); g.lineTo(gx, by1); g.stroke();
      g.fillStyle = inb ? 'rgba(255,214,90,.4)' : 'rgba(255,214,90,.2)'; g.fillRect(gx - 32, bcy - band / 2, 64, band); g.strokeStyle = ACC; g.lineWidth = 1.5; g.strokeRect(gx - 32, bcy - band / 2, 64, band);
      g.save(); g.strokeStyle = '#fff'; g.shadowColor = ACC; g.shadowBlur = 12; g.lineWidth = 4; g.beginPath(); g.moveTo(gx - 36, my); g.lineTo(gx + 36, my); g.stroke(); g.restore();
      if (inb) tapText(bcx, by0 + 16);
    } else if (shape === 'orbit') {
      const R = Math.min(bw, bh) * 0.32, dp = (t % 2.6) / 2.6, ta = -Math.PI * 0.5, a = dp < 0.85 ? (ta + easeOutExpo(dp / 0.85) * TAU * 2) : ta;
      g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 3; g.beginPath(); g.arc(bcx, bcy, R, 0, TAU); g.stroke();
      g.save(); g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 12; g.lineWidth = 6; g.beginPath(); g.arc(bcx, bcy, R, ta - 0.25, ta + 0.25); g.stroke(); g.restore();
      const dx = bcx + Math.cos(a) * R, dy = bcy + Math.sin(a) * R; g.save(); g.fillStyle = '#fff'; g.shadowColor = ACC; g.shadowBlur = 14; g.beginPath(); g.arc(dx, dy, 8, 0, TAU); g.fill(); g.restore(); fx.hub(g, bcx, bcy, 6);
    } else if (shape === 'crosshair') {
      const dp = (t % 2.6) / 2.6, box = Math.min(bw, bh) * 0.24, k = dp < 0.8 ? (1 - dp / 0.8) : 0;
      g.strokeStyle = ACC; g.lineWidth = 1.5; g.strokeRect(bcx - box / 2, bcy - box / 2, box, box); g.fillStyle = 'rgba(255,214,90,.14)'; g.fillRect(bcx - box / 2, bcy - box / 2, box, box);
      const rx = bcx + Math.cos(dp * TAU) * bw * 0.28 * k, ry = bcy + Math.sin(dp * TAU * 1.3) * bh * 0.24 * k, R = 14;
      g.save(); g.translate(rx, ry); g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 12; g.lineWidth = 2; g.beginPath(); g.arc(0, 0, R, 0, TAU); g.stroke(); g.beginPath(); g.moveTo(-R - 5, 0); g.lineTo(-4, 0); g.moveTo(4, 0); g.lineTo(R + 5, 0); g.moveTo(0, -R - 5); g.lineTo(0, -4); g.moveTo(0, 4); g.lineTo(0, R + 5); g.stroke(); g.fillStyle = '#fff'; g.beginPath(); g.arc(0, 0, 2, 0, TAU); g.fill(); g.restore();
      if (k < 0.05) tapText(bcx, by0 + 16);
    } else if (shape === 'pulse') {
      const dp = (t % 2.0) / 2.0, Rt = Math.min(bw, bh) * 0.3, R = dp * Rt / 0.85, hit = Math.abs(R - Rt) < 9;
      g.save(); g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 10; g.lineWidth = 4; g.beginPath(); g.arc(bcx, bcy, Rt, 0, TAU); g.stroke(); g.restore();
      g.save(); g.globalAlpha = Math.max(0, 1 - dp); g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.arc(bcx, bcy, Math.max(2, Math.min(R, Rt + 6)), 0, TAU); g.stroke(); g.restore(); fx.hub(g, bcx, bcy, 5);
      if (hit) tapText(bcx, by0 + 16);
    } else if (shape === 'triplering') {
      const dp = (t % 3) / 3, radii = [0.16, 0.24, 0.32].map(f => Math.min(bw, bh) * f), ta = -Math.PI / 2;
      for (let i = 0; i < 3; i++) { const R = radii[i]; g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 2; g.beginPath(); g.arc(bcx, bcy, R, 0, TAU); g.stroke();
        g.save(); g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 8; g.lineWidth = 4; g.beginPath(); g.arc(bcx, bcy, R, ta - 0.2, ta + 0.2); g.stroke(); g.restore();
        const a = dp < 0.85 ? (ta + easeOutExpo(dp / 0.85) * TAU * (1.4 + i * 0.5)) : ta, dx = bcx + Math.cos(a) * R, dy = bcy + Math.sin(a) * R;
        g.save(); g.fillStyle = '#fff'; g.shadowColor = ACC; g.shadowBlur = 10; g.beginPath(); g.arc(dx, dy, 6, 0, TAU); g.fill(); g.restore(); }
      fx.hub(g, bcx, bcy, 5); if (dp >= 0.85) { g.fillStyle = ACC; g.font = "800 13px 'Chakra Petch',sans-serif"; g.fillText('ALIGNED', bcx, by1 - 2); }
    } else if (shape === 'keypad') {
      const dp = (t % 3.2) / 3.2;
      if (dp < 0.4) { fx.readout(g, ['4', '7', '2'][Math.floor(dp / 0.4 * 3) % 3], bcx, bcy, 46, '#ffce5a'); g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText('WATCH', bcx, by1 - 2); }
      else { const kw = Math.min(52, bw / 4), kh = Math.min(40, bh / 4), gx = bcx - 3 * kw / 2, gy = bcy - 3 * kh / 2, press = Math.floor((dp - 0.4) / 0.6 * 9); for (let i = 0; i < 9; i++) { const x = gx + (i % 3) * kw, y = gy + ((i / 3 | 0)) * kh; fx.tile(g, x + 2, y + 2, kw - 4, kh - 4, 6, { active: i === press }); g.fillStyle = i === press ? '#1a1206' : '#e6ddc8'; g.font = "700 15px 'Chakra Petch',sans-serif"; g.fillText(String(i + 1), x + kw / 2, y + kh / 2 + 5); } g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText('ENTER THE CODE', bcx, by1 - 2); }
    } else if (shape === 'span' || shape === 'set' || shape === 'grid') {
      const isGrid = shape === 'grid', n = shape === 'set' ? 6 : (isGrid ? 9 : 4), cols = shape === 'set' ? 3 : (isGrid ? 3 : 4), rows = Math.ceil(n / cols);
      const tw = Math.min(isGrid ? 46 : 64, (bw - 20) / cols), th = Math.min(isGrid ? 46 : 52, (bh - 10) / rows), gx = bcx - (cols * tw) / 2, gy = bcy - (rows * th) / 2, show = isGrid ? [0, 4, 8, 5] : [0, 1, 2];
      const dp = (t % 3.4) / 3.4; let lit = -1, done = [];
      if (shape === 'set') { if (dp < 0.45) lit = -2; else { const kk = Math.floor((dp - 0.45) / 0.55 * show.length); done = show.slice(0, Math.min(show.length, kk + 1)); } }
      else { if (dp < 0.5) lit = show[Math.floor(dp / 0.5 * show.length) % show.length]; else { const kk = Math.floor((dp - 0.5) / 0.5 * show.length); done = show.slice(0, Math.min(show.length, kk + 1)); } }
      for (let i = 0; i < n; i++) { const x = gx + (i % cols) * tw, y = gy + ((i / cols) | 0) * th, on = (lit === i) || (lit === -2 && show.includes(i)) || done.includes(i); fx.tile(g, x + 3, y + 3, tw - 6, th - 6, 7, { active: on, shadow: on }); if (done.includes(i)) { g.fillStyle = GRN; g.font = "800 18px 'Chakra Petch',sans-serif"; g.fillText('✓', x + tw / 2, y + th / 2 + 6); } else if (shape === 'span' && show.includes(i) && on) { fx.readout(g, String(show.indexOf(i) + 1), x + tw / 2, y + th / 2, 15, '#ffce5a'); } }
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText(dp < (shape === 'set' ? 0.45 : 0.5) ? 'WATCH' : (shape === 'set' ? 'PICK THE SET' : 'REPEAT'), bcx, by1 + 4);
    } else {   // fate
      const dp = (t % 2.6) / 2.6, spin = easeOutExpo(Math.min(1, dp / 0.8)) * TAU * 6, R = Math.min(bw, bh) * 0.32;
      fx.metalDisc(g, bcx, bcy, R + 8, true); fx.bevelRing(g, bcx, bcy, R + 7, 4, ACC);
      for (let i = 0; i < 8; i++) { const a0 = spin + i / 8 * TAU, a1 = spin + (i + 1) / 8 * TAU; g.beginPath(); g.moveTo(bcx, bcy); g.arc(bcx, bcy, R, a0, a1); g.closePath(); g.fillStyle = i % 2 ? 'rgba(122,94,30,.9)' : 'rgba(20,18,14,.9)'; g.fill(); }
      fx.hub(g, bcx, bcy, 10); g.fillStyle = '#ffe08a'; g.beginPath(); g.moveTo(bcx + R + 2, bcy); g.lineTo(bcx + R + 15, bcy - 7); g.lineTo(bcx + R + 15, bcy + 7); g.closePath(); g.fill();
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText(dp > 0.85 ? 'LUCK DECIDES' : '', bcx, by1 + 2);
    }
  }
  async function howto(canvas, gameKey) {
    const { g, w, h } = fit(canvas); const dir = directions(gameKey); const shape = demoShape(gameKey); let stop = false; const t0 = performance.now();
    const bx0 = 34, bx1 = w - 34, by0 = 132, by1 = h - 62, bw = bx1 - bx0, bh = by1 - by0, bcx = (bx0 + bx1) / 2, bcy = (by0 + by1) / 2;
    return await new Promise(resolve => {
      let raf; function frame() {
        const t = (performance.now() - t0) / 1000; bg(g, w, h); banner(g, w, 'HOW IT WORKS');
        // definition
        g.save(); g.textAlign = 'center'; g.fillStyle = '#ffe9a8'; g.shadowColor = 'rgba(255,180,60,.5)'; g.shadowBlur = 12; g.font = "800 19px 'Chakra Petch',sans-serif"; g.fillText(dir.t, w / 2, 60); g.shadowBlur = 0;
        g.fillStyle = '#cbbf9e'; g.font = "500 13px 'Chakra Petch',sans-serif"; dir.d.forEach((line, i) => g.fillText(line, w / 2, 90 + i * 22)); g.restore();
        // recessed demo panel
        g.save(); roundRectPath(g, bx0 - 6, by0 - 6, bw + 12, bh + 12, 12); const pg = g.createLinearGradient(0, by0, 0, by1); pg.addColorStop(0, '#14161a'); pg.addColorStop(1, '#0a0b0d'); g.fillStyle = pg; g.fill(); g.lineWidth = 1.2; g.strokeStyle = 'rgba(255,255,255,.1)'; g.stroke(); g.restore();
        g.save(); roundRectPath(g, bx0 - 6, by0 - 6, bw + 12, bh + 12, 12); g.clip();
        try { drawDemo(shape, g, { bx0, bx1, by0, by1, bcx, bcy, bw, bh, t }); } catch (e) {}
        g.restore();
        const pr = 5 + 2 * Math.abs(Math.sin(t * 3)); g.save(); g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 12; g.beginPath(); g.arc(w / 2 - 74, h - 26, pr, 0, TAU); g.fill(); g.restore();
        g.fillStyle = '#ffe9a8'; g.textAlign = 'center'; g.font = "700 13px 'Chakra Petch',sans-serif"; g.fillText('TAP TO PLAY', w / 2, h - 22);
        fx.vignette(g, w, h); if (!stop) raf = requestAnimationFrame(frame);
      }
      frame(); function hit() { stop = true; cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); resolve(); } canvas.addEventListener('pointerdown', hit);
    });
  }
  // gBtn: shared button helper (used by the kept Plinko/Roulette luck presenters + the Perception presenter).
  function gBtn(g, x, y, bw, bh, fill, ink, label, on) { g.save(); g.globalAlpha = on === false ? 0.4 : 1; g.fillStyle = fill; roundRectPath(g, x, y, bw, bh, 10); g.fill(); g.restore(); g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.font = "800 15px 'Chakra Petch',sans-serif"; g.fillText(label, x + bw / 2, y + bh / 2 + 5); }
  async function pPlinko(canvas, st) {
    const { g, w, h } = fit(canvas); const rows = st.data.rows, slots = st.data.slots, vals = st.data.vals, maxV = st.data.maxV || 1;
    const top = 30 + 24, boardH = (h - 30) * 0.62, pegGapY = boardH / rows, cxs = (c) => 24 + (w - 48) * (c + 0.5) / slots;
    let chosen = -1;
    function drawBoard(ballX, ballY) { bg(g, w, h); banner(g, w, 'PLINKO DROP');
      for (let r = 0; r <= rows; r++) { const y = top + r * pegGapY; const cnt = r + 1; for (let c = 0; c < cnt; c++) { const x = w / 2 + (c - r / 2) * ((w - 60) / slots); g.fillStyle = 'rgba(255,240,200,.4)'; g.beginPath(); g.arc(x, y, 2.6, 0, TAU); g.fill(); } }
      const sy = top + boardH + 6, sh = 30; for (let i = 0; i < slots; i++) { const x = 24 + (w - 48) * i / slots, ww = (w - 48) / slots; const f = (vals[i] || 0) / maxV; g.fillStyle = f >= 0.75 ? 'rgba(255,210,74,.85)' : f >= 0.4 ? 'rgba(255,165,58,.7)' : 'rgba(90,100,120,.5)'; roundRectPath(g, x + 1, sy, ww - 2, sh, 4); g.fill(); g.fillStyle = '#0c0f14'; g.textAlign = 'center'; g.font = "700 10px 'Space Mono',monospace"; g.fillText((vals[i] || 0) + 'x', x + ww / 2, sy + 19); if (i === chosen) { g.strokeStyle = ACC; g.lineWidth = 2; g.beginPath(); g.moveTo(x + ww / 2, top - 16); g.lineTo(x + ww / 2, top - 4); g.stroke(); } }
      if (ballX != null) { g.save(); g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 12; g.beginPath(); g.arc(ballX, ballY, 6, 0, TAU); g.fill(); g.restore(); }
      if (chosen < 0) { g.fillStyle = '#ffe9a8'; g.textAlign = 'center'; g.font = "700 12px 'Chakra Petch',sans-serif"; g.fillText('TAP A COLUMN TO DROP', w / 2, h - 20); } fx.vignette(g, w, h); }
    const events = await new Promise(resolve => { drawBoard(); function hit(e) { const r = canvas.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; chosen = clamp(Math.floor((px - 24) / ((w - 48) / slots)), 0, slots - 1); drawBoard(); try { sfx.click(); } catch (e2) {} canvas.removeEventListener('pointerdown', hit); setTimeout(() => resolve([{ type: 'drop', col: chosen }]), 120); } canvas.addEventListener('pointerdown', hit); });
    const finish = async (res) => { const bounces = (res && res.reveal && res.reveal.bounces) || [], slot = (res && res.reveal && res.reveal.slot) || 0;
      let x = cxs(chosen), pos = chosen; for (let r = 0; r < rows; r++) { const step = (res.reveal ? bounces[r] : 0) || 0; const ny = top + r * pegGapY; await new Promise(rr => { const s0 = performance.now(); (function an() { const p = Math.min(1, (performance.now() - s0) / 90); drawBoard(x, ny + p * pegGapY); if (p >= 1) rr(); else requestAnimationFrame(an); })(); }); x += step * ((w - 60) / slots) / 2; }
      const fx2 = 24 + (w - 48) * (slot + 0.5) / slots; drawBoard(fx2, top + boardH + 10); const v = vals[slot] || 0; try { v >= 1 ? sfx.win() : sfx.bust(); } catch (e) {} fx.readout(g, v + 'x', w / 2, h - 16, 20, v >= 1 ? GRN : '#ff9a6a'); await wait(650); };
    return { events, finish };
  }

  async function pRoulette(canvas, st) {
    const { g, w, h } = fit(canvas); const N = st.data.N, opts = st.data.options, arc = TAU / N;
    const cx = w / 2, cy = 30 + (h - 30) * 0.4, R = Math.min(w, h - 30) * 0.3; let opt = 0, anchor = -1, ang = 0, om = 7, spinning = false, landed = false, raf;
    function draw() { bg(g, w, h); banner(g, w, 'SAFE ROULETTE');
      g.save(); g.translate(cx, cy); g.rotate(ang); for (let i = 0; i < N; i++) { const a0 = i * arc; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R, a0, a0 + arc); g.closePath(); const covered = anchor >= 0 && (() => { for (let k = 0; k < opts[opt].cover; k++) if (((anchor + k) % N) === i) return true; return false; })(); g.fillStyle = covered ? 'rgba(255,210,74,.8)' : (i % 2 ? '#232a36' : '#1a2029'); g.fill(); g.strokeStyle = 'rgba(0,0,0,.4)'; g.stroke(); g.save(); g.rotate(a0 + arc / 2); g.fillStyle = covered ? '#1a1206' : '#8a93a0'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = "700 11px 'Space Mono',monospace"; g.fillText(String(i), R * 0.72, 0); g.restore(); } g.restore(); fx.hub(g, cx, cy, 13);
      g.save(); g.fillStyle = ACC; g.beginPath(); g.moveTo(cx, cy - R + 4); g.lineTo(cx - 8, cy - R - 12); g.lineTo(cx + 8, cy - R - 12); g.closePath(); g.fill(); g.restore();
      const bw = (w - 48 - 16) / 3; opts.forEach((o, i) => { const x = 24 + i * (bw + 8), y = h - 96; gBtn(g, x, y, bw, 34, i === opt ? '#ffd24a' : 'rgba(70,78,90,.6)', i === opt ? '#1a1206' : '#d8cfb8', o.k.toUpperCase(), true); });
      g.fillStyle = '#ffe9a8'; g.textAlign = 'center'; g.font = "700 12px 'Chakra Petch',sans-serif"; g.fillText(anchor < 0 ? 'PICK A BET, THEN TAP THE WHEEL' : 'TAP WHEEL TO SPIN', w / 2, h - 44); fx.vignette(g, w, h); }
    const events = await new Promise(resolve => { draw(); function hit(e) { if (spinning) return; const r = canvas.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w, py = (e.clientY - r.top) / r.height * h; if (py >= h - 100 && py <= h - 62) { opt = clamp(Math.floor((px - 24) / (((w - 48 - 16) / 3) + 8)), 0, opts.length - 1); draw(); try { sfx.click(); } catch (e2) {} return; } const dx = px - cx, dy = py - cy; if (Math.hypot(dx, dy) <= R + 12) { let a = Math.atan2(dy, dx) - ang + Math.PI / 2; a = ((a % TAU) + TAU) % TAU; anchor = Math.floor(a / arc) % N; draw(); if (anchor >= 0) { spinning = true; canvas.removeEventListener('pointerdown', hit); resolve([{ type: 'bet', opt: opt, anchor: anchor }]); } } } canvas.addEventListener('pointerdown', hit); });
    const finish = async (res) => { const landing = (res && res.reveal && res.reveal.landing) || 0; const target = -(landing * arc + arc / 2) - Math.PI / 2; let goal = ang - (ang % TAU) + TAU * 3 + ((target % TAU) + TAU) % TAU; while (goal < ang + TAU * 2) goal += TAU; const s0 = performance.now(), a0 = ang; landed = true;
      await new Promise(r => { (function an() { const p = Math.min(1, (performance.now() - s0) / 1500); ang = a0 + (goal - a0) * (1 - Math.pow(1 - p, 3)); draw(); if (p >= 1) r(); else requestAnimationFrame(an); })(); }); const won = res && res.pass; try { won ? sfx.win() : sfx.bust(); } catch (e) {} fx.readout(g, 'LANDED ' + landing, cx, cy + R + 30, 18, won ? GRN : '#ff6a6a'); await wait(650); };
    return { events, finish };
  }
  // ── PERCEPTION presenter (Jake 2026-09-11): one-shot server PNG stimulus (answer in pixels) + a deadline. Branches on data.kind:
  //    'choose' = client option buttons; 'tapgrid' = tap a cell over the grid; 'taprow' = tap an option in the bottom row.
  //    Layout fractions mirror render.js (PNG maps into the play area 30..h): grid PAD=0.09, taprow band y∈[0.58,0.96].
  async function pPercept(canvas, st) {
    const { g, w, h } = fit(canvas); const playH = h - 30;
    const rounds = (st.data && st.data.rounds) || [st.data];   // Lever 1: multi-round GATE — one pick per round; the server requires EVERY round correct
    const K = rounds.length; const events = [];
    for (let k = 0; k < K; k++) {
      const rd = rounds[k] || {}; const kind = rd.kind, prompt = rd.prompt || 'JUDGE', dl = rd.deadlineMs || 5000;
      const cols = rd.cols || (rd.labels ? rd.labels.length : 2), rows = rd.rows || 1, labels = rd.labels || [];
      const head = K > 1 ? (prompt + '   ' + (k + 1) + '/' + K) : prompt;
      bg(g, w, h); banner(g, w, head);   // paint before awaiting the PNG so there is no blank/stale flash
      const img = await loadImg(FU(st, k)).catch(() => null);
      const idx = await new Promise(resolve => {
        let raf, done = false; const t0 = performance.now();
        function drawButtons() { const n = labels.length, by = h - 52, bh = 40, gap = 8, bw = (w - 40 - gap * (n - 1)) / n; for (let i = 0; i < n; i++) gBtn(g, 20 + i * (bw + gap), by, bw, bh, ACC, '#1a1206', labels[i], true); }
        function fr() { const el = performance.now() - t0, rem = clamp(1 - el / dl, 0, 1); bg(g, w, h); banner(g, w, head); if (img) drawFrame(g, img, w, h); if (kind === 'choose') drawButtons(); g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(20, h - 9, w - 40, 4); g.fillStyle = rem < 0.3 ? '#ff6a6a' : ACC; g.fillRect(20, h - 9, (w - 40) * rem, 4);
          if (el >= dl && !done) { done = true; cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); try { sfx.bust(); } catch (e) {} resolve(-1); return; } if (!done) raf = requestAnimationFrame(fr); }
        function hit(e) { if (done) return; const r = canvas.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w, py = (e.clientY - r.top) / r.height * h; let idx = -1;
          if (kind === 'choose') { const n = labels.length, by = h - 52, bh = 40, gap = 8, bw = (w - 40 - gap * (n - 1)) / n; if (py >= by && py <= by + bh) for (let i = 0; i < n; i++) { const x = 20 + i * (bw + gap); if (px >= x && px <= x + bw) { idx = i; break; } } }
          else if (kind === 'tapgrid') { const gx0 = 0.09 * w, gw = 0.82 * w, gy0 = 30 + 0.09 * playH, gh = 0.82 * playH; const cc = Math.floor((px - gx0) / (gw / cols)), rr = Math.floor((py - gy0) / (gh / rows)); if (cc >= 0 && cc < cols && rr >= 0 && rr < rows) idx = rr * cols + cc; }
          else { const ry0 = 30 + playH * 0.58, ry1 = 30 + playH * 0.96; if (py >= ry0 && py <= ry1) { const cc = Math.floor(px / (w / cols)); if (cc >= 0 && cc < cols) idx = cc; } }
          if (idx < 0) return; done = true; cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); try { sfx.click(); } catch (e2) {} burst(px, py, ACC); resolve(idx); }
        canvas.addEventListener('pointerdown', hit); fr();
      });
      events.push({ type: 'pick', round: k, idx: idx });
      if (idx < 0) break;   // timed out this round -> stop; missing later picks grade 0 (gate fails)
      if (k < K - 1) { bg(g, w, h); banner(g, w, 'ROUND ' + (k + 2) + ' / ' + K); await new Promise(r => setTimeout(r, 380)); }
    }
    return events;
  }
  async function run(canvas, opts) {
    const st = await post('api/skill/start', { seed: opts.seed, level: opts.level, gameKey: opts.gameKey });
    if (!st || !st.sid || !P[st.gameKey]) throw new Error('start failed');
    if (!opts.noCountdown) await countdown(canvas, directions(st.gameKey).t);   // 3-2-1-GO pre-roll before every game
    const out = await P[st.gameKey](canvas, st);
    const events = Array.isArray(out) ? out : (out && out.events) || [];   // some presenters may return {events, finish} so they can animate the server-picked reveal
    const res = await post('api/skill/grade', { sid: st.sid, events });   // { score, bar, pass, gameKey, level, reveal }
    if (out && !Array.isArray(out) && typeof out.finish === 'function') { try { await out.finish(res); } catch (e) {} }   // reveal animation (wheel/plinko/dice/blackjack/mines)
    try { if (res && res.pass) sfx.win(); else if (res && res.pass === false) sfx.bust(); } catch (e) {}   // outcome cue
    return res;
  }
  async function pStopwatch(canvas, st) {
    const { g, w, h } = fit(canvas); const { speed, start } = st.data; const ev = []; const img = await loadImg(FU(st, 0));
    const cx = w / 2, cy = 30 + (h - 30) / 2, R = (h - 30) * 0.37; const t0 = performance.now();
    return await new Promise(resolve => {
      // Stopwatch identity (distinct from the green safe-dial): CHROME bezel + top pusher, a central digital count-up readout,
      // 12/3/6/9 numerals, and a bold WHITE/AMBER second-hand. The dial stays green-banded; this reads as a real stopwatch.
      const CHR = '#9fb4ab', AMB = '#ffcf4a';
      let raf; function frame() { const t = (performance.now() - t0) / 1000, a = (start + speed * t) % TAU;
        bg(g, w, h); banner(g, w, 'TIME THE LOCK');
        g.save(); g.fillStyle = CHR; g.fillRect(cx - 9, cy - R - 24, 18, 12); g.beginPath(); g.arc(cx, cy - R - 24, 6, Math.PI, TAU); g.fill(); g.restore();   // top pusher button
        const rg = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.15); rg.addColorStop(0, '#101915'); rg.addColorStop(1, '#070d0b'); g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, R + 14, 0, TAU); g.fill();
        g.strokeStyle = CHR; g.lineWidth = 6; g.globalAlpha = 0.9; g.beginPath(); g.arc(cx, cy, R + 6, 0, TAU); g.stroke(); g.globalAlpha = 1;   // chrome bezel
        g.strokeStyle = 'rgba(159,180,171,.35)'; g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
        g.save(); g.strokeStyle = 'rgba(200,220,212,.6)'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = 'rgba(200,220,212,.7)'; g.font = "700 11px 'Chakra Petch',sans-serif";
        for (let k = 0; k < 12; k++) { const ta = k / 12 * TAU - Math.PI / 2; const maj = k % 3 === 0; g.lineWidth = maj ? 2.5 : 1.2; g.beginPath(); g.moveTo(cx + Math.cos(ta) * (R - (maj ? 12 : 7)), cy + Math.sin(ta) * (R - (maj ? 12 : 7))); g.lineTo(cx + Math.cos(ta) * (R - 2), cy + Math.sin(ta) * (R - 2)); g.stroke(); }
        ['12', '3', '6', '9'].forEach((n, idx) => { const ta = idx / 4 * TAU - Math.PI / 2; g.fillText(n, cx + Math.cos(ta) * (R - 24), cy + Math.sin(ta) * (R - 24)); }); g.restore();
        g.save(); g.fillStyle = AMB; g.font = "800 " + Math.round(R * 0.34) + "px 'Space Mono',monospace"; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(t.toFixed(2), cx, cy - R * 0.34); g.restore();   // digital count-up
        g.drawImage(img, (w - (h - 30)) / 2, 30, h - 30, h - 30);   // transparent mark overlay (server pixels; hidden target tick)
        g.save(); g.strokeStyle = '#eafff3'; g.shadowColor = AMB; g.shadowBlur = 14; g.lineWidth = 4; g.lineCap = 'round'; g.beginPath(); g.moveTo(cx - Math.cos(a) * 14, cy - Math.sin(a) * 14); g.lineTo(cx + Math.cos(a) * (R - 6), cy + Math.sin(a) * (R - 6)); g.stroke(); g.shadowBlur = 0; g.strokeStyle = AMB; g.lineWidth = 1.5; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (R - 6), cy + Math.sin(a) * (R - 6)); g.stroke(); g.restore();   // bold white second-hand w/ amber core
        g.fillStyle = AMB; g.beginPath(); g.arc(cx, cy, 5, 0, TAU); g.fill(); g.strokeStyle = '#eafff3'; g.lineWidth = 1.5; g.stroke();
        drawSparks(g); raf = requestAnimationFrame(frame); }
      frame();
      function hit() { const t = Math.round(performance.now() - t0); ev.push({ type: 'stop', t }); const a = (start + speed * (t / 1000)) % TAU; burst(cx + Math.cos(a) * R, cy + Math.sin(a) * R, ACC); beep(660); shake(canvas, 5); cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); setTimeout(() => resolve(ev), 200); }
      canvas.addEventListener('pointerdown', hit);
    });
  }
  async function pTargets(canvas, st) {
    // Snap the Locks: the locks are VISIBLE (positions in data), drawn client-side and CLEARED on tap — the original feel.
    // The server still grades by tap-vs-lock position; a bot that auto-snaps is caught by the humanness/rate anti-bot layer.
    const { g, w, h } = fit(canvas); const ev = []; const span = st.data.span; const tol = st.data.tol || 0.09; const t0 = performance.now();
    const locks = (st.data.pos || []).map(p => ({ x: p.x, y: p.y, hit: false, pop: 0 }));
    const XY = (l) => ({ x: l.x * w, y: 30 + l.y * (h - 30) });
    function drawLock(cx, cy) {
      g.save(); g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 10; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, 15, 0, TAU); g.stroke();   // shackle ring
      g.fillStyle = 'rgba(8,20,14,.85)'; g.beginPath(); g.arc(cx, cy, 12, 0, TAU); g.fill();
      g.fillStyle = ACC; g.beginPath(); g.arc(cx, cy - 2, 3.4, 0, TAU); g.fill(); g.fillRect(cx - 1.4, cy - 1, 2.8, 7);   // keyhole
      g.restore();
    }
    return await new Promise(res => {
      let raf; function fr() {
        const el = performance.now() - t0, left = Math.max(0, 1 - el / span), done = locks.filter(l => l.hit).length;
        bg(g, w, h); banner(g, w, 'SNAP THE LOCKS  ' + done + '/' + locks.length);
        for (const l of locks) { const c = XY(l); if (l.hit) { if (l.pop < 1) { l.pop += 0.12; g.save(); g.globalAlpha = Math.max(0, 1 - l.pop); g.strokeStyle = ACC; g.lineWidth = 3; g.beginPath(); g.arc(c.x, c.y, 15 + l.pop * 16, 0, TAU); g.stroke(); g.restore(); } } else drawLock(c.x, c.y); }
        g.fillStyle = 'rgba(255,120,130,.25)'; g.fillRect(0, h - 6, w, 6); g.fillStyle = left < 0.25 ? '#ff7a86' : ACC; g.fillRect(0, h - 6, w * left, 6);
        drawSparks(g);
        if (el >= span || locks.every(l => l.hit)) { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); setTimeout(() => res(ev), 300); return; }
        raf = requestAnimationFrame(fr);
      }
      fr();
      function hit(e) { const r = canvas.getBoundingClientRect(); const nx = (e.clientX - r.left) / r.width, ny = ((e.clientY - r.top) / r.height * h - 30) / (h - 30); if (ny < 0 || ny > 1) return; ev.push({ type: 'tap', x: nx, y: ny });
        let best = -1, bd = 1e9; for (let i = 0; i < locks.length; i++) { if (locks[i].hit) continue; const d = Math.hypot(locks[i].x - nx, locks[i].y - ny); if (d < bd) { bd = d; best = i; } }
        if (best >= 0 && bd <= tol) { locks[best].hit = true; const c = XY(locks[best]); burst(c.x, c.y, ACC); beep(680); shake(canvas, 3); } }
      canvas.addEventListener('pointerdown', hit);
    });
  }
  async function pSort(canvas, st) {
    const { g, w, h } = fit(canvas); const N = st.data.count; const ev = []; const img = await loadImg(FU(st, 0)); const picked = [];
    const pad0 = 20 / SZ * w, slotW = (SZ - 40) / N / SZ * w, slotY = 30 + (h - 30) * 0.36, slotH = (h - 30) * 0.28;
    function draw() {
      bg(g, w, h); banner(g, w, 'TAP IN ASCENDING ORDER  ' + picked.length + '/' + N);
      for (let k = 0; k < N; k++) { const x = pad0 + slotW * k; const done = picked.includes(k); g.fillStyle = done ? 'rgba(255,210,74,.18)' : 'rgba(10,20,16,.6)'; g.fillRect(x + 4, slotY, slotW - 8, slotH); g.strokeStyle = done ? ACC : 'rgba(255,205,90,.4)'; g.lineWidth = 2; g.strokeRect(x + 4, slotY, slotW - 8, slotH); if (done) { g.save(); g.fillStyle = ACC; g.font = "700 13px 'Chakra Petch',sans-serif"; g.textAlign = 'center'; g.fillText('#' + (picked.indexOf(k) + 1), x + slotW / 2, slotY + 16); g.restore(); } }
      g.drawImage(img, 0, 30, w, h - 30);   // the numbers (server pixels; hidden values)
    }
    return await new Promise(res => {
      draw();
      function hit(e) { const r = canvas.getBoundingClientRect(); const px = e.clientX - r.left; const k = Math.floor((px - pad0) / slotW); if (k < 0 || k >= N || picked.includes(k)) return; picked.push(k); ev.push({ type: 'order', idx: k }); beep(560 + picked.length * 40); draw(); if (picked.length >= N) { canvas.removeEventListener('pointerdown', hit); setTimeout(() => res(ev), 250); } }
      canvas.addEventListener('pointerdown', hit);
    });
  }
  async function playInto(canvas, st) { const fn = P[st.gameKey]; if (!fn) throw new Error('no renderer: ' + st.gameKey); const out = await fn(canvas, st); if (Array.isArray(out)) return out; if (out && out.finish) { try { st._finish = out.finish; } catch (e) {} }   // reveal games return {events,finish}; door path grades separately, so hand back just the events (finish stashed for optional reveal)
    return (out && out.events) || []; }
  // split-flow helpers so the game can run inside the legacy mini shell (title/badge/GO/How/Back):
  // start() fetches the answer-free descriptor (arcade route), then the shell plays it on GO and grades with grade().
  async function start(opts) { opts = opts || {}; return await post('api/skill/start', { seed: opts.seed, level: opts.level, gameKey: opts.gameKey }); }
  async function grade(sid, events) { return await post('api/skill/grade', { sid, events: events || [] }); }
  window.RTV_SKILL_REMOTE = { run, playInto, start, grade, countdown, howto, directions, games: Object.keys(P) };
})();
