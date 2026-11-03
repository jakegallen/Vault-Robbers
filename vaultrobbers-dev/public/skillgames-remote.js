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
    readout(g, txt, cx, cy, size, col) { col = col || '#ffce5a'; g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = "800 " + size + "px 'Chakra Petch','Space Mono',monospace"; g.fillStyle = 'rgba(0,0,0,.5)'; g.fillText(txt, cx + 2, cy + 3); g.shadowColor = col; g.shadowBlur = size * 0.7; g.fillStyle = col; g.fillText(txt, cx, cy); g.shadowBlur = size * 0.3; g.fillStyle = '#fff7e0'; g.globalAlpha = 0.85; g.fillText(txt, cx, cy); g.restore(); } };
  const _sparks = [];
  function burst(x, y, col) { for (let i = 0; i < 14; i++) { const a = Math.random() * TAU, sp = 1.5 + Math.random() * 3.5; _sparks.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, col: col || ACC }); } }
  function drawSparks(g) { for (let i = _sparks.length - 1; i >= 0; i--) { const p = _sparks[i]; p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.life -= 0.045; if (p.life <= 0) { _sparks.splice(i, 1); continue; } g.save(); g.globalAlpha = Math.max(0, p.life); g.fillStyle = p.col; g.beginPath(); g.arc(p.x, p.y, 2.4, 0, TAU); g.fill(); g.restore(); } }
  function shake(canvas, mag) { const s = performance.now(); (function d() { const p = (performance.now() - s) / 260; if (p >= 1) { canvas.style.transform = ''; return; } const m = (mag || 8) * (1 - p); canvas.style.transform = 'translate(' + ((Math.random() - .5) * 2 * m).toFixed(1) + 'px,' + ((Math.random() - .5) * 2 * m).toFixed(1) + 'px)'; requestAnimationFrame(d); })(); }
  // draw a server frame image to fill the play area (below the banner)
  function drawFrame(g, img, w, h) { g.drawImage(img, 0, 30, w, h - 30); }
  let _ac; function _ensureAC() { _ac = _ac || new (window.AudioContext || window.webkitAudioContext)(); if (_ac.state === 'suspended') { try { _ac.resume(); } catch (e) {} } return _ac; }
  // AUDIO UNLOCK (Jake 2026-09-13): browsers start an AudioContext SUSPENDED until a user gesture resumes it — that's why every
  // game was silent even with sound on. Resume on the first pointer/touch/key anywhere, and again inside every tone (most sfx fire
  // inside a tap handler, so resume() succeeds there). Idempotent + cheap.
  try { ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) { document.addEventListener(ev, function () { try { _ensureAC(); } catch (e) {} }, { passive: true }); }); } catch (e) {}
  // Shared volume/mute gate (Jake 2026-09-14 polish3): the single #volRange slider + mute button in index.html write
  // {muted,volume} to window.RTV_AUDIO. This module's own AudioContext (_ac) is separate from index's `master`, so its
  // local cues used to ignore the slider entirely. Every local cue now scales its gain by this factor so the ONE control
  // governs ALL in-game sound (0 when muted or slider at 0). Best-effort; defaults to full volume if state absent.
  function _shVol() { try { var A = window.RTV_AUDIO; if (A) { if (A.muted) return 0; return (typeof A.volume === 'number') ? Math.max(0, Math.min(1, A.volume)) : 1; } } catch (e) {} return 1; }
  // UNIFIED ENGINE (Jake 2026-09-14): route through index.html's ONE premium AudioContext+master (window.RTV_BEEP / RTV_TONE)
  // so every in-game cue shares the heist palette and obeys the single mute/volume control. The old local raw-sine oscillator
  // (its own _ac, straight to destination) was the "still-V1" flat beep; it now survives ONLY as a standalone fallback when the
  // shared engine is absent (module loaded without index.html). RTV_BEEP is a crisp metallic two-layer tick, not a bare sine.
  function beep(f) { try { if (window.RTV_BEEP) { window.RTV_BEEP(f || 700, true); return; } } catch (e) {}
    try { var vv = _shVol(); if (vv <= 0) return; _ensureAC(); const o = _ac.createOscillator(), gg = _ac.createGain(); o.frequency.value = f || 700; gg.gain.value = 0.0001; gg.gain.linearRampToValueAtTime(0.16 * vv, _ac.currentTime + 0.01); gg.gain.exponentialRampToValueAtTime(0.0001, _ac.currentTime + 0.14); o.connect(gg); gg.connect(_ac.destination); o.start(); o.stop(_ac.currentTime + 0.16); } catch (e) {} }
  // ── SFX KIT: short tactile heist sounds (Web Audio; no assets). One-shot tones with shaped envelopes. ──
  function _tone(freq, dur, type, vol, slideTo) { try { if (window.RTV_TONE) { window.RTV_TONE(freq, dur, type, vol, slideTo); return; } } catch (e) {}
    try { var vv = _shVol(); if (vv <= 0) return; _ensureAC(); const t = _ac.currentTime, o = _ac.createOscillator(), gg = _ac.createGain(); o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t); if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur); gg.gain.setValueAtTime(0.0001, t); gg.gain.exponentialRampToValueAtTime((vol || 0.12) * vv, t + 0.008); gg.gain.exponentialRampToValueAtTime(0.0001, t + dur); o.connect(gg); gg.connect(_ac.destination); o.start(t); o.stop(t + dur + 0.02); } catch (e) {} }
  // SFX (Jake 2026-09-14 polish2): delegate to the shared premium palette (window.RTV_SFX from index.html) so these in-game cues
  // route through the SAME master gain the mute/volume control drives. When the module is loaded standalone (no shared palette),
  // fall back to the local _tone kit below. `_S` picks the shared cue if present, else the local one. Cue-name mapping:
  //   click->click, lock->lockSkill/tick, thunk->coin, win->win, bust->bust, whir->whoosh.
  const _local = {
    click() { _tone(880, 0.05, 'square', 0.06); },
    lock() { _tone(520, 0.09, 'triangle', 0.12); setTimeout(() => _tone(340, 0.12, 'sine', 0.1), 40); },
    thunk() { _tone(200, 0.18, 'sine', 0.16, 90); },
    win() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => _tone(f, 0.16, 'triangle', 0.13), i * 70)); },
    bust() { _tone(180, 0.5, 'sawtooth', 0.16, 55); },
    whir() { _tone(140, 0.28, 'sawtooth', 0.05, 420); } };
  function _S(shared, local) { try { const S = window.RTV_SFX; if (S && typeof S[shared] === 'function') { S[shared](); return; } } catch (e) {} try { local(); } catch (e) {} }
  const sfx = {
    click() { _S('click', _local.click); },
    lock() { _S('lockSkill', _local.lock); },
    thunk() { _S('coin', _local.thunk); },
    win() { _S('win', _local.win); },
    bust() { _S('bust', _local.bust); },
    whir() { _S('whoosh', _local.whir); },
    // NEW event grammar (Jake 2026-09-14 Phase 1): route in-game correct/death/reveal into the shared premium engine.
    correct() { _S('correct', () => _tone(1046, 0.05, 'triangle', 0.12, 1560)); },   // rises with the streak (state lives in the engine)
    death() { _S('death', () => { _tone(1200, 0.06, 'sawtooth', 0.2, 180); _tone(120, 0.5, 'sawtooth', 0.2, 60); }); },
    reveal() { _S('reveal', () => _tone(300, 0.42, 'sine', 0.08, 1200)); },
    reset() { try { const S = window.RTV_SFX; if (S && S.reset) S.reset(); } catch (e) {} } };
  const frameURL = (sid, i) => 'api/skill/frame?sid=' + encodeURIComponent(sid) + '&i=' + i;
  const FU = (st, i) => st.frameURL ? st.frameURL(i) : frameURL(st.sid, i);   // run path passes st.frameURL (run-scoped); arcade uses the /api/skill/frame route keyed by sid
  // ANTI-LEAK (#11, 2026-09-14): recall answers (safeproc seq / lockorder order) no longer ride in st.data on the paid path. When the run
  // provides st.stepURL, stream the answer array one item at a time from the server (time-gated + one-shot); else (arcade/dev practice, which
  // is closed at launch) fall back to the in-descriptor copy. Returns a numeric array in order.
  // DEPRECATED (skill-harden 2026-09-14): the per-item step stream that once drove safeproc/lockorder. Replaced by the ROBUST one-shot server
  // PNG flash (pSafeProc/pLockOrder fetch a single v4frame image), because a failed per-item stream returned empty and bricked the game. Kept
  // only so any legacy caller degrades to the descriptor fallback instead of throwing; the live presenters no longer call it.
  async function stepSeq(st, n, dataArr) {
    const stepU = st.stepURL ? st.stepURL : (st.sid ? (i => 'api/skill/step?sid=' + encodeURIComponent(st.sid) + '&i=' + i) : null);   // run path: st.stepURL; arcade: sid-keyed practice route
    if (!stepU) return (dataArr || []).slice();   // last-resort fallback (only if a legacy descriptor still carries the array)
    const out = [];
    for (let i = 0; i < n; i++) {
      let pad = null;
      for (let tries = 0; tries < 40; tries++) {   // honor the server time-gate: a `wait` means the item's reveal instant hasn't arrived
        try { const r = await fetch(stepU(i)).then(x => x.json()); if (r && r.done) { return out; } if (r && r.wait) { await wait(70); continue; } if (r && typeof r.pad !== 'undefined') { pad = r.pad; break; } } catch (e) {}
        await wait(70);
      }
      if (pad == null) break; out.push(pad | 0);
    }
    return out;
  }

  // ── presenters: each returns the events array; the SERVER grades ──
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
  // pTapTimed + legacy skill-v3 presenters (pPendulum/pSlider/pOrbit/pCrosshair/pAlign3/pPulse) REMOVED 2026-09-15 — orphan
  // functions never registered in P (their game keys no longer exist in the v4 rosters). skMap above is kept (shared helper).
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
  // pWirecut (legacy skill-v3 orphan, never registered in P) REMOVED 2026-09-15.
  // pBeam + pTorque (legacy skill-v3 orphans, never registered in P) REMOVED 2026-09-15.
  // pKeypad (legacy skill-v3 orphan, never registered in P) REMOVED 2026-09-15.
  // ── Parked orphan presenters (pHotwire/pSonic/pPressure/pReflex/pMash/pSilent) WIPED 2026-09-12 — their game keys are gone (SKILL V4 rebuild).
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
    'PLINKO DROP': _cascade, 'DETONATOR': _boom, 'VAULT LEVER': _clunk };
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
  // DEAD STUB REMOVED (Jake 2026-09-13): a duplicate sync pRoulette(canvas) lived here, shadowed ONLY by hoisting order by the real interactive
  // async pRoulette(canvas, st) below (~line 778). A reorder would silently revert roulette to this broken empty board — deleted to remove the hazard.
  function pShells(canvas) { return fateGame(canvas, { title: 'SHELL GAME', tap: 'TAP TO SHUFFLE', draw(g, w, h, ph, s, cx, cy) { const gap = Math.min(w * 0.26, 86), xs = [cx - gap, cx, cx + gap], sw = Math.min(56, gap * 0.8); for (let i = 0; i < 3; i++) { const sway = s && ph < 0.9 ? Math.sin(ph * 20 + i * 2) * gap * 0.5 : 0, lift = (s && ph >= 0.9 && i === 1) ? -24 : 0, x = xs[i] + sway; g.save(); g.fillStyle = '#6b4f2a'; g.strokeStyle = '#c79a55'; g.lineWidth = 2; g.beginPath(); g.moveTo(x - sw / 2, cy + 28 + lift); g.quadraticCurveTo(x, cy - 34 + lift, x + sw / 2, cy + 28 + lift); g.closePath(); g.fill(); g.stroke(); g.restore(); } } }); }
  function pScratch(canvas) { return fateGame(canvas, { title: 'SCRATCH CARD', tap: 'TAP TO SCRATCH', draw(g, w, h, ph, s, cx, cy) { const cw = Math.min(w * 0.6, 220), chh = 90, x0 = cx - cw / 2, y0 = cy - chh / 2; g.fillStyle = '#12241c'; roundRect(g, x0, y0, cw, chh, 10); g.fill(); if (s) { g.save(); g.fillStyle = 'rgba(255,210,74,.16)'; const rev = cw * _ez(ph); roundRect(g, x0, y0, Math.max(1, rev), chh, 10); g.fill(); for (let i = 0; i < 20; i++) { g.fillStyle = 'rgba(234,255,243,' + (0.2 + Math.random() * 0.3) + ')'; g.fillRect(x0 + Math.random() * rev, y0 + Math.random() * chh, 2, 2); } g.restore(); } g.strokeStyle = '#c0a24a'; g.lineWidth = 2; roundRect(g, x0, y0, cw, chh, 10); g.stroke(); if (!s) { g.fillStyle = '#8a7a45'; g.textAlign = 'center'; g.font = '700 13px "Chakra Petch",sans-serif'; g.fillText('SCRATCH TO REVEAL', cx, cy + 4); } } }); }
  // DEAD STUB REMOVED (Jake 2026-09-13): a duplicate sync pPlinko(canvas) lived here, shadowed ONLY by hoisting order by the real interactive
  // async pPlinko(canvas, st) below (~line 760). A reorder would silently revert plinko to this broken empty board — deleted to remove the hazard.
  function pKeno(canvas) { const lit = []; return fateGame(canvas, { title: 'LUCKY NUMBERS', tap: 'TAP TO DRAW', dur: 1600, draw(g, w, h, ph, s, cx, cy) { const cols = 5, rows = 4, cw = Math.min(w * 0.7, 240) / cols, ch = (h - 82) / rows, x0 = cx - cw * cols / 2, y0 = 48, n = Math.floor(ph * 8); while (s && lit.length < n) lit.push((Math.random() * 20) | 0); for (let k = 0; k < 20; k++) { const x = x0 + (k % cols) * cw, y = y0 + ((k / cols) | 0) * ch, on = lit.indexOf(k) >= 0; fx.tile(g, x + 2, y + 2, cw - 4, ch - 4, 6, { active: on, shadow: on }); if (on) { fx.readout(g, String(k + 1), x + cw / 2, y + ch / 2, 15, '#ffce5a'); } else { g.fillStyle = '#5a6b60'; g.font = '700 13px "Chakra Petch",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(k + 1), x + cw / 2, y + ch / 2); g.textBaseline = 'alphabetic'; } } } }); }
  function pGoldbar(canvas) { let t0d = performance.now(), sweepX = null, lockX = null, gi = -1; return fateGame(canvas, { title: 'GRAB A BAR', tap: 'DROP THE CLAW', dur: 1500, draw(g, w, h, ph, s, cx, cy) {
    const top = 46, floorY = h - 34, barW = 40, barH = 15, gap = 22, n = 3, totalW = n * barW + (n - 1) * gap, startX = cx - totalW / 2;
    const barCx = []; for (let i = 0; i < n; i++) barCx.push(startX + i * (barW + gap) + barW / 2);
    // claw x: sweeps side-to-side before the drop (visible sideways motion), locks where it was when tapped
    let clawX;
    if (!s) { const tt = (performance.now() - t0d) / 1000; sweepX = cx + Math.sin(tt * 2.3) * (totalW / 2); clawX = sweepX; lockX = null; gi = -1; }
    else { if (lockX === null) { lockX = (sweepX == null ? cx : sweepX); let bd = 1e9; barCx.forEach((bxc, i) => { const d = Math.abs(bxc - lockX); if (d < bd) { bd = d; gi = i; } }); } clawX = lockX; }
    const down = s ? Math.sin(Math.min(ph, 0.5) / 0.5 * Math.PI / 2) : 0, up = s && ph > 0.5 ? (ph - 0.5) / 0.5 : 0, reach = floorY - barH - 14 - top, y2 = top + reach * down - up * reach;
    // top rail
    g.strokeStyle = 'rgba(159,180,171,.35)'; g.lineWidth = 2; g.beginPath(); g.moveTo(20, top - 8); g.lineTo(w - 20, top - 8); g.stroke();
    // gold bars on the floor (skip the one being lifted)
    g.strokeStyle = '#a5851f'; g.lineWidth = 2; for (let i = 0; i < n; i++) { if (s && ph > 0.5 && i === gi) continue; const bx = startX + i * (barW + gap); g.fillStyle = '#ffd24a'; roundRect(g, bx, floorY - barH, barW, barH, 4); g.fill(); g.stroke(); g.fillStyle = 'rgba(255,255,255,.28)'; g.fillRect(bx + 3, floorY - barH + 3, barW - 6, 3); }
    // cable + claw head
    g.strokeStyle = '#9fb4ab'; g.lineWidth = 3; g.beginPath(); g.moveTo(clawX, top - 8); g.lineTo(clawX, y2); g.stroke();
    g.fillStyle = '#cfe0d8'; g.beginPath(); g.moveTo(clawX - 11, y2); g.lineTo(clawX, y2 + 13); g.lineTo(clawX + 11, y2); g.closePath(); g.fill();
    // grabbed bar rides up with the claw
    if (s && ph > 0.5) { g.fillStyle = '#ffd24a'; g.strokeStyle = '#a5851f'; g.lineWidth = 2; roundRect(g, clawX - barW / 2, y2 + 11, barW, barH, 4); g.fill(); g.stroke(); }
  } }); }
  function pMagnetgrab(canvas) { return fateGame(canvas, { title: 'DETONATOR', tap: 'SLAM THE PLUNGER', dur: 1300, col: '#ffb347', draw(g, w, h, ph, s, cx, cy) { const boxW = 78, boxH = 58, by = cy + 30; const press = s ? Math.min(1, ph / 0.32) : 0, topY = by - boxH / 2 - 46 + press * 30; g.strokeStyle = '#9fb4ab'; g.lineWidth = 6; g.beginPath(); g.moveTo(cx, topY); g.lineTo(cx, by - boxH / 2); g.stroke(); g.fillStyle = '#e64a3b'; roundRect(g, cx - 26, topY - 11, 52, 14, 5); g.fill(); g.fillStyle = '#2a2318'; g.strokeStyle = '#c0a24a'; g.lineWidth = 2; roundRect(g, cx - boxW / 2, by - boxH / 2, boxW, boxH, 7); g.fill(); g.stroke(); g.fillStyle = '#c9a34a'; g.font = '800 13px "Chakra Petch",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('T·N·T', cx, by); g.textBaseline = 'alphabetic'; if (s && ph > 0.4) { const bp = (ph - 0.4) / 0.6, R = bp * Math.min(w, h) * 0.6, oy = by - boxH; g.save(); g.globalAlpha = Math.max(0, 1 - bp); const rg = g.createRadialGradient(cx, oy, R * 0.15, cx, oy, R); rg.addColorStop(0, '#fff2c4'); rg.addColorStop(0.45, '#ffb347'); rg.addColorStop(1, 'rgba(255,77,60,0)'); g.fillStyle = rg; g.beginPath(); g.arc(cx, oy, R, 0, TAU); g.fill(); g.restore(); for (let i = 0; i < 11; i++) { const a = i / 11 * TAU, rr = bp * 96; g.fillStyle = 'rgba(255,214,120,' + Math.max(0, 1 - bp) + ')'; g.beginPath(); g.arc(cx + Math.cos(a) * rr, oy + Math.sin(a) * rr, 3.2, 0, TAU); g.fill(); } } } }); }
  function pFuserace(canvas) { return fateGame(canvas, { title: 'FUSE RACE', tap: 'LIGHT THE FUSE', dur: 1500, draw(g, w, h, ph, s, cx, cy) {[cy - 24, cy + 24].forEach(function (yy, idx) { g.strokeStyle = '#6b5a3a'; g.lineWidth = 6; g.beginPath(); g.moveTo(20, yy); g.lineTo(w - 32, yy); g.stroke(); const sx = 20 + _ez(s ? ph * (idx === 0 ? 1 : 0.92) : 0) * (w - 52); g.strokeStyle = '#150f0a'; g.lineWidth = 6; g.beginPath(); g.moveTo(20, yy); g.lineTo(sx, yy); g.stroke(); if (s) { g.save(); g.shadowColor = '#ffcf4a'; g.shadowBlur = 16; g.fillStyle = '#ffe9a8'; g.beginPath(); g.arc(sx, yy, 5, 0, TAU); g.fill(); g.restore(); } g.font = '15px serif'; g.textAlign = 'center'; g.fillText('🧨', w - 26, yy + 5); }); } }); }
  function pElevator(canvas) { const RANK = ['A', 'K', 'Q', 'J', '10', '9', '◆', '★']; let ri = 0; return fateGame(canvas, { title: 'HIGH CARD', tap: 'CUT THE DECK', dur: 1200, draw(g, w, h, ph, s, cx, cy) { const cw = Math.min(72, w * 0.24), chh = cw * 1.42, deckX = cx - cw / 2 - 46; for (let i = 0; i < 5; i++) { g.fillStyle = i % 2 ? '#17140d' : '#1d190f'; g.strokeStyle = 'rgba(255,210,74,.32)'; g.lineWidth = 1.5; roundRect(g, deckX - i * 1.6, cy - chh / 2 + i * 1.6, cw, chh, 7); g.fill(); g.stroke(); } const cut = s ? _ez(Math.min(1, ph / 0.4)) : 0, drawnX = deckX + cut * 96; const flipPh = s ? Math.max(0, (ph - 0.4) / 0.6) : 0, rot = flipPh * Math.PI, fl = Math.abs(Math.cos(rot)), faceUp = flipPh > 0 && Math.cos(rot) < 0; if (s && faceUp) ri = Math.min(RANK.length - 1, (flipPh * RANK.length) | 0); g.save(); g.translate(drawnX + cw / 2, cy); g.scale(Math.max(0.06, fl), 1); const grd = g.createLinearGradient(-cw / 2, -chh / 2, cw / 2, chh / 2); if (faceUp) { grd.addColorStop(0, '#241d10'); grd.addColorStop(1, '#3a2c0e'); } else { grd.addColorStop(0, '#17140d'); grd.addColorStop(1, '#0d0b08'); } g.fillStyle = grd; g.strokeStyle = faceUp ? ACC : 'rgba(255,210,74,.5)'; g.lineWidth = 2; roundRect(g, -cw / 2, -chh / 2, cw, chh, 7); g.fill(); g.stroke(); g.textAlign = 'center'; g.textBaseline = 'middle'; if (faceUp) { g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 12; g.font = '800 32px "Cinzel",serif'; g.fillText(RANK[ri], 0, 0); g.shadowBlur = 0; } else { g.fillStyle = 'rgba(255,205,90,.5)'; g.font = '700 20px "Cinzel",serif'; g.fillText('RV', 0, 0); } g.textBaseline = 'alphabetic'; g.restore(); } }); }
  function pSafedial(canvas) { return fateGame(canvas, { title: 'VAULT LEVER', tap: 'THROW THE LEVER', dur: 1300, draw(g, w, h, ph, s, cx, cy) { const doorCx = cx - 22, R = Math.min(w, h - 30) * 0.29; g.fillStyle = '#0c0b09'; g.beginPath(); g.arc(doorCx, cy, R + 8, 0, TAU); g.fill(); const open = s ? _ez(Math.max(0, (ph - 0.35) / 0.65)) : 0; if (open > 0) { g.save(); g.globalAlpha = open; const rg = g.createRadialGradient(doorCx, cy, 4, doorCx, cy, R); rg.addColorStop(0, '#fff2c4'); rg.addColorStop(0.5, '#ffce5a'); rg.addColorStop(1, 'rgba(255,180,60,0)'); g.fillStyle = rg; g.beginPath(); g.arc(doorCx, cy, R, 0, TAU); g.fill(); g.restore(); } g.save(); g.translate(doorCx, cy); g.scale(Math.max(0.05, 1 - open * 0.92), 1); g.translate(-open * R * 0.5, 0); fx.metalDisc(g, 0, 0, R, true); fx.bevelRing(g, 0, 0, R, 5, ACC); for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; g.fillStyle = '#8a949a'; g.beginPath(); g.arc(Math.cos(a) * (R - 14), Math.sin(a) * (R - 14), 4, 0, TAU); g.fill(); } fx.hub(g, 0, 0, 12); g.restore(); const lx = cx + Math.min(w * 0.3, R + 42), base = cy + 22, th = s ? _ez(Math.min(1, ph / 0.35)) : 0, ang = -0.95 + th * 1.75; g.fillStyle = '#3a3126'; roundRect(g, lx - 7, base - 6, 14, 16, 3); g.fill(); g.save(); g.translate(lx, base); g.rotate(ang); g.strokeStyle = '#c9d6cf'; g.lineWidth = 7; g.lineCap = 'round'; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -46); g.stroke(); g.fillStyle = '#e64a3b'; g.beginPath(); g.arc(0, -48, 9, 0, TAU); g.fill(); g.restore(); } }); }
  // ── OLD SKILL V3 presenters (skClock + pSkPend/pSkOrbit/pSkSlider/pSkPulse/pSkAim/pSkDial/pSkTriple/pSkAlign/pSkTorque/pSkShear/pSkTimer/pSkBeam/pSkDrag/pSkMatch/pSkGrid) WIPED 2026-09-12 — replaced by the SKILL V4 reaction/sequence/charge presenters below.
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
  // pVoltage (legacy skill-v3 orphan, never registered in P) REMOVED 2026-09-15.
  // SKILL V4 (Jake 2026-09-12): the OLD skill presenters (pSkPend/pSkOrbit/pSkSlider/pSkPulse/pSkAim/pSkDial/pSkTriple/pSkAlign/
  // pSkTorque/pSkShear/pSkTimer/pSkBeam/pSkDrag/pSkMatch/pSkGrid) + parked orphans (pTargets/pSort/pHotwire/pSonic/pPressure/pReflex/
  // pMash/pSilent) are removed from the P map — their game keys no longer exist. The 15 new reaction/sequence/charge presenters are
  // registered further below (P.gonogo = ... etc.).
  const P = { ledger: pLedger, heatmap: pHeatmap,  spatial: pSpatial,  lineup: pLineup, reverse: pLineup, safecombo: pLineup, colorlock: pColorlock, bearing: pBearing, denoms: pDenoms, glyphset: pGlyphset, simon: pSimon, gridrecall: pGridRecall, pairs: pPairs, nback: pNback,   journey: pSpatial,   coinflip: pCoinflip, wheel: pWheel, dice: pDice, cardflip: pCardflip, slots: pSlots, roulette: pRoulette, shells: pShells, scratch: pScratch, plinko: pPlinko, keno: pKeno, goldbar: pGoldbar, magnetgrab: pMagnetgrab, fuserace: pFuserace, elevatorroulette: pElevator, safedial: pSafedial,   forgery: pPercept,    readdial: pPercept, peephole: pPercept, shaderank: pPercept,  muller: pPercept, ponzo: pPercept, simcontrast: pPercept, camobreak: pPercept, figurenoise: pPercept };   // PERCEPTION: all 15 route the one server-PNG-stimulus judgment presenter (branches on data.kind); +5 illusion games

  // ── Per-game "how it works" directions (simple, 2 lines each) + family fallbacks ──────────────────────────────────────────
  const _LUCK = ['coinflip','wheel','dice','cardflip','slots','roulette','shells','scratch','plinko','keno','goldbar','magnetgrab','fuserace','elevatorroulette','safedial'];
  const _MEM = ['lineup','reverse','simon','spatial','gridrecall','pairs','nback','journey','ledger','heatmap','safecombo','colorlock','bearing','denoms','glyphset'];
  const DIR = {
    // SKILL V4 (Jake 2026-09-12): reaction / reactive-sequence / charge-aim. Old deterministic single-tap-timing entries wiped.
    gonogo: { t: 'Go / No-Go', d: ['The whole board lights at once.', 'Tap ONLY the GO colour named up top, skip every other colour.'] },
    oddsignal: { t: 'Odd Signal', d: ['A field of near-identical marks appears.', 'Find the subtly odd one (shape, tilt or shade).'] },
    safeproc: { t: 'Safe Procedure', d: ['A short sequence flashes.', 'Punch it back in before time runs out.'] },
    lockorder: { t: 'Lock Order', d: ['A numbered lock order flashes.', 'Hit the locks in that order from memory.'] },
    counterrot: { t: 'Counter-Rotate', d: ['Tap the lit side, alternating left / right in order.', 'One wrong tap resets the chain to zero.'] },
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
    forgery: { t: 'Spot the Forgery', d: ['A grid of gold bars.', 'Tap the one with the off shade.'] },
    readdial: { t: 'Read the Dial', d: ['A needle points at a value.', 'Pick the range it lands in.'] },
    peephole: { t: 'Through the Peephole', d: ['A blurred item up top.', 'Tap which option it is.'] },
    shaderank: { t: 'Shade Rank', d: ['A row of near-identical shades.', 'Tap the lightest OR darkest, whichever the prompt asks.'] },
    muller: { t: 'Longer Line', d: ['Two lines, one wears misleading fins.', 'Pick the truly longer one.'] },
    ponzo: { t: 'True Size', d: ['Bars between converging rails.', 'Pick the truly widest one.'] },
    simcontrast: { t: 'True Shade', d: ['Swatches on tricky backgrounds.', 'Tap the one that truly matches.'] },
    camobreak: { t: 'Break the Camo', d: ['A camouflaged grid.', 'Tap the tile that breaks the pattern.'] },
    figurenoise: { t: 'Hidden Figure', d: ['A shape buried in noise.', 'Tap which clean shape it is.'] },
    // RHYTHM (15)
    // DEXTERITY (15)
    lasercorridor: { t: 'Laser Corridor', d: ['Lasers blink on and off.', 'Cross each one only while dark.', 'Click and hold to control.'] },
    coilunwind: { t: 'Coil Unwind', d: ['A spiral winds to the center.', 'Trace the WHOLE coil from the outer end all the way in.', 'Click and hold to control.'] },
    tiltbalance: { t: 'Tilt Balance', d: ['The green zone drifts across the beam.', 'Drag to keep the ball inside it as it moves.', 'Click and hold to control.'] },
    mazerun: { t: 'Maze Run', d: ['A maze from start to exit.', 'Drag through and stay inside the corridor the whole way — clipping the walls fails.', 'Click and hold to control.'] },
    orbitring: { t: 'Orbit Ring', d: ['A ring at a set radius.', 'Drag a full lap staying on it.', 'Click and hold to control.'] },
    cranklever: { t: 'Crank Lever', d: ['A crank needs winding.', 'Drag in circles to turn it round.', 'Click and hold to control.'] },
    tracechase: { t: 'Trace Chase', d: ['A target dot drifts around.', 'Keep your cursor on it.', 'Click and hold to control.'] },
    steadyhold: { t: 'Steady Hold', d: ['A drift pushes the dot; keep it in the center of the ring.', 'Touch the edge and it flashes red and costs you.', 'Click and hold to control.'] },
    // NEW DEXTERITY (4) — Jake 2026-09-14 (STAGED behind RTV_DEX_NEW)
    dialstop: { t: 'Dial Stop', d: ['Drag the dial around to rotate it.', 'Stop on each lit notch in order.', 'Click and hold to control.'] },
    undertow: { t: 'Undertow', d: ['A sideways current keeps shoving your token off course.', 'Hold and steer to counter it and stay inside the moving safe lane.', 'Ride the lane all the way up to the exit.'] },
    gaterunner: { t: 'Gate Runner', d: ['Gates rush toward you, one gap each.', 'Steer left/right into every gap.', 'Click and hold to control.'] },
    livewire: { t: 'Live Wire', d: ['A wire that moves while you trace it.', 'Track the live line without drifting off.', 'Click and hold to control.'] } };
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
  // FULL AUDIT (Jake 2026-09-14 polish3): every game now maps to a demo SHAPE that actually mirrors its presenter, or to null =
  // text-only (correct centred rules, NO demo) when no shape truly matches. A wrong demo is worse than no demo. The prior code
  // funnelled Perception, Rhythm, Dexterity and several Skill games into the generic 'band' slider — visually lying about the game.
  function demoShape(k) {
    // LUCK (15): pure chance — you commit, fate resolves. Split by mechanic family (Jake 2026-09-14) so each game shows its own
    // instrument instead of one wheel for all: spinners -> the fate wheel; coin/dice -> a toss; the rest -> pick-one-and-reveal.
    if (['wheel', 'roulette', 'elevatorroulette', 'safedial', 'fuserace'].includes(k)) return 'fate';
    if (['coinflip', 'dice'].includes(k)) return 'toss';
    if (_LUCK.includes(k)) return 'pick';   // cardflip / slots / shells / scratch / plinko / keno / goldbar / magnetgrab
    // MEMORY (15): pick-the-set, lit-grid recall, or watch-then-repeat span.
    if (k === 'glyphset') return 'set';
    if (['spatial', 'journey', 'gridrecall', 'heatmap', 'pairs'].includes(k)) return 'grid';
    if (_MEM.includes(k)) return 'span';
    // SKILL V4 (15):
    if (['powermeter', 'recoilctl', 'pressurevalve'].includes(k)) return 'vertical';   // hold/charge inside a moving band on a vertical gauge
    if (k === 'safeproc') return 'arrows';                                              // FAITHFUL: watch the arrow sequence, punch it back on the 4-arrow pad
    if (k === 'repeatcombo') return 'span';                                             // icon combo flashes, repeat in order
    if (k === 'lockorder') return 'lockorder';                                          // FAITHFUL: locks flash their tap-order (1..n), tap them in that order
    if (['anglelaunch', 'ricochet'].includes(k)) return 'crosshair';                   // aim a shot at a target
    // Jake 2026-09-14: reaction / discrimination games now get demos that match their REAL mechanic (were wrongly on the memory 'grid').
    if (k === 'gonogo') return 'discern';                                               // whole board lights at once -> tap true greens, skip the rest
    if (k === 'oddsignal') return 'oddout';                                             // a field of marks, one is subtly odd -> tap it
    if (['trapdoor', 'colourcall'].includes(k)) return 'matchpad';                     // a target colour is shown -> tap the pad that matches it
    if (k === 'overridegrid') return 'toggle';                                          // flip switches until the grid matches the target
    if (k === 'twitchrelease') return 'band';                                          // hold, release the sweeping marker inside the zone (HOLD verb)
    if (k === 'counterrot') return 'alternate';                                         // FAITHFUL: alternate LEFT/RIGHT taps, keep pace as cadence rises
    // PERCEPTION (15): one-shot "study the stimulus, pick the answer". Every game now gets a faithful, answer-safe demo (Jake 2026-09-14:
    // no more text-only screens). Blatant fake stimulus teaches the verb; the real round is subtle + server-generated so nothing leaks.
    if (['forgery', 'oddglyph', 'camobreak'].includes(k)) return 'oddout';             // grid, tap the tile that differs / breaks the pattern
    if (['sigil', 'shadowmatch'].includes(k)) return 'matchpad';                       // a target up top, tap its twin in the lineup
    if (k === 'readdial') return 'dial';                                               // read the gauge, tap the matching value chip
    if (k === 'counttake') return 'count';                                             // count the marks, tap the number
    if (['muller', 'ponzo'].includes(k)) return 'lines';                               // FAITHFUL: finned lines, tap the truly longer one
    if (['shaderank', 'simcontrast'].includes(k)) return 'shade';                      // FAITHFUL: brightness patches, tap the darkest
    if (['peephole', 'figurenoise'].includes(k)) return 'find';                        // FAITHFUL: spot the shape hidden in noise, tap it
    if (['appraise', 'balance'].includes(k)) return 'judge';                           // compare two, tap the greater (value / weight judgment)
    // RHYTHM (15): tap to a beat -> a pulsing ring you hit on the beat; the two watch-then-repeat ones read as a span.
    if (['echotap', 'echoreverse'].includes(k)) return 'span';
    if (['pulselock', 'beatrunner', 'metroswing', 'combochain', 'sustainhold', 'offbeat', 'accentonly', 'twinstrike', 'rampup', 'laneswitch', 'gatepulse', 'stepladder', 'heartbeat'].includes(k)) return 'pulse';
    // DEXTERITY (15): continuous-drag path games.
    if (['orbitring', 'cranklever', 'dialstop'].includes(k)) return 'orbit';            // drag a lap around a ring / rotate a dial
    if (['tracechase', 'steadyhold'].includes(k)) return 'crosshair';                   // keep the cursor on a drifting target
    if (k === 'coilunwind') return 'spiral';                                            // trace a spiral inward
    if (['wiretrace', 'gapthreader', 'lasercorridor', 'tiltbalance', 'mazerun', 'pinchgap', 'zigzag', 'threadneedle', 'dodgefall', 'swipegates', 'undertow', 'gaterunner', 'livewire'].includes(k)) return 'path';   // drag a dot along a winding path
    return null;   // anything unmapped -> honest text-only rules
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
      // safeproc (Jake 2026-09-14): show the 3x3 keypad the WHOLE time and light the sequence keys one at a time (WATCH), then
      // press them back (ENTER). Replaces the old giant single digit that flashed centre-panel and read like a glitch.
      const dp = (t % 3.4) / 3.4, seq = [3, 6, 1], kw = Math.min(52, bw / 4), kh = Math.min(40, bh / 4), gx = bcx - 3 * kw / 2, gy = bcy - 3 * kh / 2;
      const watch = dp < 0.5, phase = watch ? dp / 0.5 : (dp - 0.5) / 0.5, step = Math.min(seq.length - 1, Math.floor(phase * seq.length)), hi = seq[step];
      for (let i = 0; i < 9; i++) { const x = gx + (i % 3) * kw, y = gy + ((i / 3 | 0)) * kh, on = i === hi; fx.tile(g, x + 2, y + 2, kw - 4, kh - 4, 6, { active: on, shadow: on }); g.fillStyle = on ? '#1a1206' : '#e6ddc8'; g.font = "700 15px 'Chakra Petch',sans-serif"; g.fillText(String(i + 1), x + kw / 2, y + kh / 2 + 5); }
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText(watch ? 'WATCH THE CODE' : 'ENTER THE CODE', bcx, by1 + 2);
    } else if (shape === 'span' || shape === 'set' || shape === 'grid') {
      const isGrid = shape === 'grid', n = shape === 'set' ? 6 : (isGrid ? 9 : 4), cols = shape === 'set' ? 3 : (isGrid ? 3 : 4), rows = Math.ceil(n / cols);
      const tw = Math.min(isGrid ? 46 : 64, (bw - 20) / cols), th = Math.min(isGrid ? 46 : 52, (bh - 10) / rows), gx = bcx - (cols * tw) / 2, gy = bcy - (rows * th) / 2, show = isGrid ? [0, 4, 8, 5] : [0, 1, 2];
      const dp = (t % 3.4) / 3.4; let lit = -1, done = [];
      if (shape === 'set') { if (dp < 0.45) lit = -2; else { const kk = Math.floor((dp - 0.45) / 0.55 * show.length); done = show.slice(0, Math.min(show.length, kk + 1)); } }
      else { if (dp < 0.5) lit = show[Math.floor(dp / 0.5 * show.length) % show.length]; else { const kk = Math.floor((dp - 0.5) / 0.5 * show.length); done = show.slice(0, Math.min(show.length, kk + 1)); } }
      for (let i = 0; i < n; i++) { const x = gx + (i % cols) * tw, y = gy + ((i / cols) | 0) * th, on = (lit === i) || (lit === -2 && show.includes(i)) || done.includes(i); fx.tile(g, x + 3, y + 3, tw - 6, th - 6, 7, { active: on, shadow: on }); if (done.includes(i)) { g.fillStyle = GRN; g.font = "800 18px 'Chakra Petch',sans-serif"; g.fillText('✓', x + tw / 2, y + th / 2 + 6); } else if (shape === 'span' && show.includes(i) && on) { fx.readout(g, String(show.indexOf(i) + 1), x + tw / 2, y + th / 2, 15, '#ffce5a'); } }
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText(dp < (shape === 'set' ? 0.45 : 0.5) ? 'WATCH' : (shape === 'set' ? 'PICK THE SET' : 'REPEAT'), bcx, by1 + 4);
    } else if (shape === 'spiral') {
      // COIL UNWIND: a spiral winds to the centre; a dot traces it inward — matches the real drag-the-spiral game.
      const turns = 3.2, Rm = Math.min(bw, bh) * 0.42, dp = (t % 3.2) / 3.2;
      g.save(); g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 3; g.beginPath();
      for (let s = 0; s <= 1; s += 0.01) { const ang = s * turns * TAU, rr = Rm * (1 - s * 0.92), x = bcx + Math.cos(ang) * rr, y = bcy + Math.sin(ang) * rr; if (s === 0) g.moveTo(x, y); else g.lineTo(x, y); } g.stroke();
      // traced portion (gold) up to progress, then the moving dot
      g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 10; g.lineWidth = 4; g.beginPath();
      for (let s = 0; s <= dp; s += 0.01) { const ang = s * turns * TAU, rr = Rm * (1 - s * 0.92), x = bcx + Math.cos(ang) * rr, y = bcy + Math.sin(ang) * rr; if (s === 0) g.moveTo(x, y); else g.lineTo(x, y); } g.stroke(); g.restore();
      const ang = dp * turns * TAU, rr = Rm * (1 - dp * 0.92), dx = bcx + Math.cos(ang) * rr, dy = bcy + Math.sin(ang) * rr;
      g.save(); g.fillStyle = '#fff'; g.shadowColor = ACC; g.shadowBlur = 14; g.beginPath(); g.arc(dx, dy, 7, 0, TAU); g.fill(); g.restore();
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText('DRAG TO THE CENTRE', bcx, by1 + 2);
    } else if (shape === 'path') {
      // DRAG-PATH DEXTERITY (wire trace / maze / zigzag / thread needle ...): a winding path with a dot dragged along it.
      const dp = (t % 3.0) / 3.0, x0 = bx0 + 14, x1 = bx1 - 14, span = x1 - x0, amp = bh * 0.3;
      const yAt = (fx2) => bcy + Math.sin(fx2 * Math.PI * 3) * amp * Math.cos(fx2 * Math.PI);
      g.save(); g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 8; g.lineCap = 'round'; g.beginPath();
      for (let s = 0; s <= 1; s += 0.02) { const x = x0 + s * span, y = yAt(s); if (s === 0) g.moveTo(x, y); else g.lineTo(x, y); } g.stroke();
      g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 8; g.lineWidth = 4; g.beginPath();
      for (let s = 0; s <= dp; s += 0.02) { const x = x0 + s * span, y = yAt(s); if (s === 0) g.moveTo(x, y); else g.lineTo(x, y); } g.stroke(); g.restore();
      const px = x0 + dp * span, py = yAt(dp); g.save(); g.fillStyle = '#fff'; g.shadowColor = ACC; g.shadowBlur = 14; g.beginPath(); g.arc(px, py, 8, 0, TAU); g.fill(); g.restore();
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText('HOLD + DRAG ALONG THE PATH', bcx, by1 + 2);
    } else if (shape === 'discern') {
      // GO / NO-GO (Jake 2026-09-14): the whole board lights AT ONCE; tap the TRUE greens, skip the off-greens and reds.
      // (Was funnelled into the memory 'grid' demo, which showed watch-then-repeat — the wrong mechanic entirely.)
      const cols = 3, rows = 3, n = 9, tw = Math.min(52, (bw - 16) / cols), th = Math.min(46, (bh - 26) / rows), gx = bcx - (cols * tw) / 2, gy = bcy - (rows * th) / 2;
      const TRUE = [0, 4, 7], OFF = [2, 5], dp = (t % 3.2) / 3.2, doneCount = Math.min(TRUE.length, Math.floor(dp * (TRUE.length + 1)));
      for (let i = 0; i < n; i++) { const x = gx + (i % cols) * tw, y = gy + ((i / cols) | 0) * th, isTrue = TRUE.includes(i), isOff = OFF.includes(i);
        g.save(); roundRectPath(g, x + 3, y + 3, tw - 6, th - 6, 7); g.fillStyle = isTrue ? 'rgba(61,255,143,.9)' : (isOff ? 'rgba(120,140,60,.62)' : 'rgba(210,70,60,.72)'); g.shadowColor = isTrue ? 'rgba(61,255,143,.6)' : 'transparent'; g.shadowBlur = isTrue ? 10 : 0; g.fill(); g.restore();
        if (isTrue && TRUE.indexOf(i) < doneCount) { g.fillStyle = '#04120a'; g.font = "800 18px 'Chakra Petch',sans-serif"; g.fillText('✓', x + tw / 2, y + th / 2 + 6); } }
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText('TAP THE GO COLOUR, SKIP THE REST', bcx, by1 + 2);
    } else if (shape === 'oddout') {
      // FIND-THE-ODD-ONE (oddsignal / forgery / odd glyph / break-the-camo): a field of identical marks, one differs — tap it.
      const cols = 4, rows = 3, n = 12, tw = Math.min(46, (bw - 12) / cols), th = Math.min(40, (bh - 26) / rows), gx = bcx - (cols * tw) / 2, gy = bcy - (rows * th) / 2, odd = 6, dp = (t % 3.0) / 3.0;
      for (let i = 0; i < n; i++) { const x = gx + (i % cols) * tw + tw / 2, y = gy + ((i / cols) | 0) * th + th / 2, r = Math.min(tw, th) * 0.3;
        g.save(); g.beginPath(); g.arc(x, y, i === odd ? r * 1.04 : r, 0, TAU); g.fillStyle = i === odd ? 'rgba(255,210,74,.95)' : 'rgba(150,160,175,.8)'; g.fill(); g.restore(); }
      const ox = gx + (odd % cols) * tw + tw / 2, oy = gy + ((odd / cols) | 0) * th + th / 2, k = Math.min(1, dp / 0.8);
      const fx2 = (bx0 + 12) + (ox - (bx0 + 12)) * k, fy2 = (by0 + 12) + (oy - (by0 + 12)) * k;
      g.save(); g.fillStyle = '#fff'; g.shadowColor = ACC; g.shadowBlur = 14; g.beginPath(); g.arc(fx2, fy2, 7, 0, TAU); g.fill(); g.restore();
      if (dp > 0.8) { g.save(); g.strokeStyle = ACC; g.lineWidth = 2.5; g.beginPath(); g.arc(ox, oy, Math.min(tw, th) * 0.42, 0, TAU); g.stroke(); g.restore(); tapText(bcx, by0 + 14); }
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText('TAP THE ODD ONE OUT', bcx, by1 + 2);
    } else if (shape === 'matchpad') {
      // MATCH-THE-TARGET (trapdoor / colour call / match the sigil / shadow match): a target is shown up top; tap the pad that matches it.
      const dp = (t % 3.0) / 3.0, pal = ['#ff5a4a', '#3dff8f', '#ffd24a', '#5ab0ff'], targetIdx = 2;
      const tS = Math.min(46, bw * 0.16), tx = bcx - tS / 2, ty = by0 + 4;
      g.save(); roundRectPath(g, tx, ty, tS, tS, 8); g.fillStyle = pal[targetIdx]; g.fill(); g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.55)'; g.stroke(); g.restore();
      g.fillStyle = '#cbbf9e'; g.font = "600 10px 'Space Mono',monospace"; g.fillText('TARGET', bcx, ty + tS + 12);
      const n = 4, pw = Math.min(50, (bw - 24 - 24) / n), ph = Math.min(40, bh * 0.26), py = by1 - ph - 12, order = [0, 3, 2, 1], gx = bcx - (n * pw + (n - 1) * 8) / 2, matchPos = order.indexOf(targetIdx);
      for (let i = 0; i < n; i++) { const x = gx + i * (pw + 8); g.save(); roundRectPath(g, x, py, pw, ph, 8); g.fillStyle = pal[order[i]]; g.globalAlpha = 0.9; g.fill(); g.restore(); }
      const mx = gx + matchPos * (pw + 8) + pw / 2, my = py + ph / 2, sx = bcx, sy = ty + tS + 22, k = Math.min(1, dp / 0.8), fx2 = sx + (mx - sx) * k, fy2 = sy + (my - sy) * k;
      g.save(); g.fillStyle = '#fff'; g.shadowColor = ACC; g.shadowBlur = 14; g.beginPath(); g.arc(fx2, fy2, 7, 0, TAU); g.fill(); g.restore();
      if (dp > 0.8) { g.save(); g.strokeStyle = ACC; g.lineWidth = 3; roundRectPath(g, gx + matchPos * (pw + 8) - 3, py - 3, pw + 6, ph + 6, 10); g.stroke(); g.restore(); }
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText('TAP THE MATCHING PAD', bcx, by1 + 2);
    } else if (shape === 'toggle') {
      // OVERRIDE GRID: flip switches until the grid matches the target pattern (fewest moves, beat the clock).
      const dp = (t % 3.2) / 3.2, cols = 3, rows = 3, n = 9, target = [0, 2, 4, 6, 8];
      const ms = 9, mgx = bcx - (cols * ms) / 2, mgy = by0 + 4;
      for (let i = 0; i < n; i++) { const x = mgx + (i % cols) * ms, y = mgy + ((i / cols) | 0) * ms; g.fillStyle = target.includes(i) ? ACC : 'rgba(255,255,255,.16)'; g.fillRect(x, y, ms - 2, ms - 2); }
      g.fillStyle = '#cbbf9e'; g.font = "600 9px 'Space Mono',monospace"; g.fillText('TARGET', bcx, mgy + rows * ms + 9);
      const tw = Math.min(48, (bw - 16) / cols), th = Math.min(38, (bh - 52) / rows), gx = bcx - (cols * tw) / 2, gy = bcy - (rows * th) / 2 + 12, flipped = Math.floor(dp * (target.length + 1));
      for (let i = 0; i < n; i++) { const x = gx + (i % cols) * tw, y = gy + ((i / cols) | 0) * th, want = target.includes(i), on = want && target.indexOf(i) < flipped; fx.tile(g, x + 3, y + 3, tw - 6, th - 6, 7, { active: on, shadow: on }); }
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText('FLIP TO MATCH THE TARGET', bcx, by1 + 2);
    } else if (shape === 'judge') {
      // JUDGE-THEN-PICK (Jake 2026-09-14): size / shade / contrast / value illusions (muller, ponzo, shaderank, simcontrast, appraise,
      // balance, peephole, figurenoise). Two panels, one is clearly "more" -> tap it. Deliberately BLATANT (real rounds are subtle and
      // server-generated) so it teaches the compare-and-pick verb WITHOUT leaking any answer. Replaces the old text-only screens.
      const dp = (t % 3.0) / 3.0, pad = 20, pw = Math.min(104, (bw - pad * 3) / 2), ph = Math.min(bh * 0.52, 128), py = bcy - ph / 2;
      const panels = [{ x: bcx - pad / 2 - pw, val: 0.5, ans: false }, { x: bcx + pad / 2, val: 0.94, ans: true }];
      panels.forEach(p => {
        g.save(); roundRectPath(g, p.x, py, pw, ph, 10); g.fillStyle = 'rgba(255,255,255,.05)'; g.fill(); g.lineWidth = 1.2; g.strokeStyle = 'rgba(255,255,255,.14)'; g.stroke(); g.restore();
        const ih = (ph - 22) * p.val, iw = pw - 22, ix = p.x + 11, iy = py + ph - 11 - ih;
        g.save(); roundRectPath(g, ix, iy, iw, ih, 6); g.fillStyle = p.ans ? 'rgba(255,214,90,.92)' : 'rgba(150,160,175,.5)'; if (p.ans) { g.shadowColor = ACC; g.shadowBlur = 10; } g.fill(); g.restore();
      });
      const ans = panels[1], mx = ans.x + pw / 2, my = py + ph / 2, k = Math.min(1, dp / 0.8);
      const px2 = (bx0 + 16) + (mx - (bx0 + 16)) * k, py2 = (by1 - 16) + (my - (by1 - 16)) * k;
      g.save(); g.fillStyle = '#fff'; g.shadowColor = ACC; g.shadowBlur = 14; g.beginPath(); g.arc(px2, py2, 7, 0, TAU); g.fill(); g.restore();
      if (dp > 0.8) { g.save(); g.strokeStyle = ACC; g.lineWidth = 3; roundRectPath(g, ans.x - 3, py - 3, pw + 6, ph + 6, 12); g.stroke(); g.restore(); tapText(bcx, by0 + 14); }
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText('COMPARE - TAP THE ANSWER', bcx, by1 + 2);
    } else if (shape === 'count') {
      // COUNT-THEN-PICK (Jake 2026-09-14): count the marks -> choose the number (counttake). Blatant fixed count of 4; real rounds vary.
      const dp = (t % 3.2) / 3.2, watch = dp < 0.55, spots = [[0.26, 0.26], [0.60, 0.20], [0.40, 0.48], [0.72, 0.50]];
      for (let i = 0; i < spots.length; i++) { const x = bx0 + spots[i][0] * bw, y = by0 + spots[i][1] * (bh * 0.66); g.save(); g.fillStyle = 'rgba(255,214,90,.9)'; g.shadowColor = ACC; g.shadowBlur = 8; g.beginPath(); g.arc(x, y, 9, 0, TAU); g.fill(); g.restore(); }
      const chips = [3, 4, 5], cw = 42, gap = 12, tot = chips.length * cw + (chips.length - 1) * gap, cgx = bcx - tot / 2, cyy = by1 - 34, correct = 1;
      for (let i = 0; i < chips.length; i++) { const x = cgx + i * (cw + gap), on = !watch && i === correct; g.save(); roundRectPath(g, x, cyy, cw, 30, 8); g.fillStyle = on ? ACC : 'rgba(255,255,255,.08)'; g.fill(); g.lineWidth = 1.2; g.strokeStyle = on ? ACC : 'rgba(255,255,255,.16)'; g.stroke(); g.restore(); g.fillStyle = on ? '#1a1206' : '#e6ddc8'; g.font = "800 15px 'Chakra Petch',sans-serif"; g.fillText(String(chips[i]), x + cw / 2, cyy + 21); }
      if (!watch) { g.save(); g.strokeStyle = ACC; g.lineWidth = 3; roundRectPath(g, cgx + correct * (cw + gap) - 3, cyy - 3, cw + 6, 36, 10); g.stroke(); g.restore(); }
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText(watch ? 'COUNT THE MARKS' : 'TAP THE COUNT', bcx, by1 + 2);
    } else if (shape === 'dial') {
      // READ-THE-DIAL (Jake 2026-09-14): a gauge needle points to a reading; tap the chip that matches (readdial). Was text-only + earlier
      // showed "purple with no purple button" — now the demo shows the real read-then-match instrument with legible LOW/MID/HIGH chips.
      const dp = (t % 3.2) / 3.2, cx = bcx, cy = by0 + bh * 0.42, R = Math.min(bw, bh) * 0.28, A0 = Math.PI * 0.80, SWEEP = Math.PI * 1.40, v = 0.72, na = A0 + v * SWEEP;
      g.save(); g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 7; g.lineCap = 'round'; g.beginPath(); g.arc(cx, cy, R, A0, A0 + SWEEP); g.stroke();
      g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 10; g.beginPath(); g.arc(cx, cy, R, A0, na); g.stroke(); g.restore();
      for (let i = 0; i <= 8; i++) { const a = A0 + (i / 8) * SWEEP, x0 = cx + Math.cos(a) * (R - 10), y0 = cy + Math.sin(a) * (R - 10), x1 = cx + Math.cos(a) * (R - 2), y1 = cy + Math.sin(a) * (R - 2); g.strokeStyle = 'rgba(255,255,255,.3)'; g.lineWidth = 2; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); }
      const nx = cx + Math.cos(na) * (R - 6), ny = cy + Math.sin(na) * (R - 6);
      g.save(); g.strokeStyle = '#fff'; g.shadowColor = ACC; g.shadowBlur = 12; g.lineWidth = 4; g.lineCap = 'round'; g.beginPath(); g.moveTo(cx, cy); g.lineTo(nx, ny); g.stroke(); g.restore(); fx.hub(g, cx, cy, 7);
      const chips = ['LOW', 'MID', 'HIGH'], cw = 48, gap = 12, tot = chips.length * cw + (chips.length - 1) * gap, cgx = bcx - tot / 2, cyy = by1 - 32, correct = 2, on = dp > 0.55;
      for (let i = 0; i < chips.length; i++) { const x = cgx + i * (cw + gap), hi = on && i === correct; g.save(); roundRectPath(g, x, cyy, cw, 28, 8); g.fillStyle = hi ? ACC : 'rgba(255,255,255,.08)'; g.fill(); g.lineWidth = 1.2; g.strokeStyle = hi ? ACC : 'rgba(255,255,255,.16)'; g.stroke(); g.restore(); g.fillStyle = hi ? '#1a1206' : '#cbbf9e'; g.font = "800 12px 'Chakra Petch',sans-serif"; g.fillText(chips[i], x + cw / 2, cyy + 18); }
      if (on) { const mx = cgx + correct * (cw + gap) + cw / 2; g.save(); g.fillStyle = '#fff'; g.shadowColor = ACC; g.shadowBlur = 12; g.beginPath(); g.arc(mx, cyy + 14, 6, 0, TAU); g.fill(); g.restore(); }
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText('READ THE DIAL - TAP THE MATCH', bcx, by1 + 2);
    } else if (shape === 'toss') {
      // TOSS (Jake 2026-09-14): coin / dice luck — you commit, chance lands it. A coin flips up and settles.
      const dp = (t % 2.6) / 2.6, cx = bcx, R = Math.min(bw, bh) * 0.22, flying = dp < 0.7;
      const yLift = flying ? Math.sin(dp / 0.7 * Math.PI) * bh * 0.24 : 0, cy = bcy - yLift, sx = flying ? Math.max(0.12, Math.abs(Math.cos(dp * 20))) : 1;
      if (!flying) { g.save(); g.fillStyle = 'rgba(0,0,0,.32)'; g.beginPath(); g.ellipse(cx, bcy + R * 0.95, R * 0.85, R * 0.22, 0, 0, TAU); g.fill(); g.restore(); }
      g.save(); g.translate(cx, cy); g.scale(sx, 1); fx.metalDisc(g, 0, 0, R, true); fx.bevelRing(g, 0, 0, R, 3, ACC);
      if (sx > 0.55) { g.fillStyle = '#1a1206'; g.font = "800 " + Math.round(R * 0.9) + "px 'Chakra Petch',sans-serif"; g.textAlign = 'center'; g.fillText('$', 0, R * 0.32); } g.restore();
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.textAlign = 'center'; g.fillText(dp > 0.75 ? 'LUCK DECIDES' : 'TOSS...', bcx, by1 + 2);
    } else if (shape === 'pick') {
      // PICK-ONE (Jake 2026-09-14): shells / cards / keno / scratch / plinko / slots / gold bar / magnet grab — choose one, chance reveals.
      const dp = (t % 3.0) / 3.0, n = 3, tw = Math.min(64, (bw - 40) / n), th = Math.min(bh * 0.5, 84), gap = 16, tot = n * tw + (n - 1) * gap, gx = bcx - tot / 2, gy = bcy - th / 2, pickIdx = 1, revealing = dp > 0.62;
      for (let i = 0; i < n; i++) { const x = gx + i * (tw + gap), chosen = i === pickIdx, open = revealing && chosen;
        g.save(); roundRectPath(g, x, gy, tw, th, 10);
        if (open) { const grad = g.createLinearGradient(x, gy, x, gy + th); grad.addColorStop(0, '#3a2f12'); grad.addColorStop(1, '#141008'); g.fillStyle = grad; } else g.fillStyle = 'rgba(255,255,255,.07)';
        g.fill(); g.lineWidth = 1.4; g.strokeStyle = chosen ? ACC : 'rgba(255,255,255,.16)'; g.stroke(); g.restore();
        if (open) { g.save(); g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 14; g.beginPath(); g.arc(x + tw / 2, gy + th / 2, tw * 0.24, 0, TAU); g.fill(); g.restore(); g.fillStyle = '#1a1206'; g.font = "800 14px 'Chakra Petch',sans-serif"; g.textAlign = 'center'; g.fillText('$', x + tw / 2, gy + th / 2 + 5); }
        else { g.fillStyle = 'rgba(255,255,255,.3)'; g.font = "800 22px 'Chakra Petch',sans-serif"; g.textAlign = 'center'; g.fillText('?', x + tw / 2, gy + th / 2 + 8); } }
      if (!revealing) { const px = gx + pickIdx * (tw + gap) + tw / 2, k = Math.min(1, dp / 0.55), fromx = bcx, fromy = by1 - 16, ty = gy + th + 14; g.save(); g.fillStyle = '#fff'; g.shadowColor = ACC; g.shadowBlur = 12; g.beginPath(); g.arc(fromx + (px - fromx) * k, fromy + (ty - fromy) * k, 7, 0, TAU); g.fill(); g.restore(); }
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.textAlign = 'center'; g.fillText(revealing ? 'LUCK DECIDES' : 'PICK ONE', bcx, by1 + 2);
    } else if (shape === 'arrows') {
      // SAFE PROCEDURE (Jake 2026-09-14): FAITHFUL to the real game — an ARROW sequence flashes (WATCH), then you punch it back on the
      // 4-arrow pad (ENTER). Replaces the wrong number-keypad demo. Blatant fixed sequence; the real round's sequence is server-generated.
      const seq = [0, 2, 3], dp = (t % 3.4) / 3.4, watch = dp < 0.5;
      if (watch) { const step = Math.min(seq.length - 1, Math.floor(dp / 0.5 * seq.length));
        g.save(); g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 16; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = "800 " + Math.round(Math.min(bw, bh) * 0.34) + "px sans-serif"; g.fillText(_ARROW[seq[step]], bcx, bcy); g.restore(); g.textBaseline = 'alphabetic';
        g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.textAlign = 'center'; g.fillText('WATCH THE ARROWS', bcx, by1 + 2);
      } else { const ph = (dp - 0.5) / 0.5, lit = seq[Math.min(seq.length - 1, Math.floor(ph * seq.length))];
        const cx = bcx, cy = bcy, s = Math.min(bw, bh) * 0.27, hf = s * 0.42;
        const pad = [{ id: 0, x: cx, y: cy - s }, { id: 1, x: cx + s, y: cy }, { id: 2, x: cx, y: cy + s }, { id: 3, x: cx - s, y: cy }];
        pad.forEach(p => { const on = p.id === lit; g.save(); roundRectPath(g, p.x - hf, p.y - hf, hf * 2, hf * 2, 8); g.fillStyle = on ? 'rgba(255,214,90,.92)' : 'rgba(255,210,74,.12)'; if (on) { g.shadowColor = ACC; g.shadowBlur = 16; } g.fill(); g.lineWidth = 1.4; g.strokeStyle = 'rgba(255,210,74,.4)'; g.stroke(); g.restore(); g.fillStyle = on ? '#1a1206' : '#ffd9a0'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = "700 " + Math.round(hf * 1.15) + "px sans-serif"; g.fillText(_ARROW[p.id], p.x, p.y); g.textBaseline = 'alphabetic'; });
        g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.textAlign = 'center'; g.fillText('PUNCH IT BACK IN ORDER', bcx, by1 + 2);
      }
    } else if (shape === 'lines') {
      // LONGER LINE / length illusion (muller / ponzo) (Jake 2026-09-14): FAITHFUL — horizontal lines with misleading fins; the truly
      // longer one is highlighted + tapped. Replaces the generic two-bar 'judge'. Blatant here; the real round's gaps are subtle + server-set.
      const dp = (t % 3.0) / 3.0, rows = [{ y: bcy - bh * 0.24, len: 0.52, fin: 1 }, { y: bcy, len: 0.74, fin: -1, ans: true }, { y: bcy + bh * 0.24, len: 0.46, fin: 1 }], F = 10;
      rows.forEach(r => { const half = (bw * 0.34) * r.len, x0 = bcx - half, x1 = bcx + half, on = r.ans && dp > 0.55;
        g.save(); g.strokeStyle = on ? ACC : 'rgba(205,210,220,.82)'; g.shadowColor = on ? ACC : 'transparent'; g.shadowBlur = on ? 10 : 0; g.lineWidth = on ? 4 : 3; g.lineCap = 'round';
        g.beginPath(); g.moveTo(x0, r.y); g.lineTo(x1, r.y); g.stroke();
        g.beginPath(); g.moveTo(x0, r.y); g.lineTo(x0 + r.fin * F, r.y - F); g.moveTo(x0, r.y); g.lineTo(x0 + r.fin * F, r.y + F); g.moveTo(x1, r.y); g.lineTo(x1 - r.fin * F, r.y - F); g.moveTo(x1, r.y); g.lineTo(x1 - r.fin * F, r.y + F); g.stroke(); g.restore(); });
      const ans = rows[1], k = Math.min(1, dp / 0.8), fromx = bcx, fromy = by1 - 14;
      if (dp > 0.55) { g.save(); g.fillStyle = '#fff'; g.shadowColor = ACC; g.shadowBlur = 14; g.beginPath(); g.arc(fromx + (bcx - fromx) * k, fromy + (ans.y - fromy) * k, 7, 0, TAU); g.fill(); g.restore(); }
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.textAlign = 'center'; g.fillText('TAP THE TRULY LONGER LINE', bcx, by1 + 2);
    } else if (shape === 'lockorder') {
      // LOCK ORDER (Jake 2026-09-14): FAITHFUL — a row of locks flashes its tap-order (1..n), then you tap them in that order.
      const order = [2, 0, 3, 1], k = 4, dp = (t % 3.4) / 3.4, watch = dp < 0.5;
      const tw = Math.min(56, (bw - 24) / k), gap = 12, tot = k * tw + (k - 1) * gap, gx = bcx - tot / 2, ly = bcy;
      const stepW = watch ? Math.floor(dp / 0.5 * order.length) : -1, stepI = !watch ? Math.min(order.length - 1, Math.floor((dp - 0.5) / 0.5 * order.length)) : -1;
      for (let c = 0; c < k; c++) { const x = gx + c * (tw + gap), ordPos = order.indexOf(c), lit = !watch && order[stepI] === c;
        g.save(); roundRectPath(g, x, ly - tw / 2, tw, tw, 10); g.fillStyle = lit ? 'rgba(255,214,90,.9)' : 'rgba(255,210,74,.12)'; if (lit) { g.shadowColor = ACC; g.shadowBlur = 14; } g.fill(); g.lineWidth = 1.4; g.strokeStyle = 'rgba(255,210,74,.4)'; g.stroke(); g.restore();
        // keyhole (lock) glyph
        g.save(); g.fillStyle = lit ? '#1a1206' : '#ffd9a0'; g.beginPath(); g.arc(x + tw / 2, ly - 3, tw * 0.11, 0, TAU); g.fill(); g.beginPath(); g.moveTo(x + tw / 2 - tw * 0.07, ly - 3); g.lineTo(x + tw / 2 + tw * 0.07, ly - 3); g.lineTo(x + tw / 2 + tw * 0.03, ly + tw * 0.16); g.lineTo(x + tw / 2 - tw * 0.03, ly + tw * 0.16); g.closePath(); g.fill(); g.restore();
        if (watch && ordPos <= stepW) { g.save(); g.fillStyle = ACC; g.beginPath(); g.arc(x + tw - 9, ly - tw / 2 + 9, 9, 0, TAU); g.fill(); g.fillStyle = '#1a1206'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = "800 12px 'Chakra Petch',sans-serif"; g.fillText(String(ordPos + 1), x + tw - 9, ly - tw / 2 + 9); g.textBaseline = 'alphabetic'; g.restore(); }
      }
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.textAlign = 'center'; g.fillText(watch ? 'REMEMBER THE ORDER' : 'TAP THE LOCKS IN ORDER', bcx, by1 + 2);
    } else if (shape === 'alternate') {
      // COUNTER-ROTATE (Jake 2026-09-14): FAITHFUL — alternate LEFT / RIGHT taps, keeping pace as the cadence rises.
      const side = Math.floor(t / 0.6) % 2, pw = Math.min(bw * 0.34, 118), ph = Math.min(bh * 0.5, 118), py = bcy - ph / 2, lxx = bcx - pw - 12, rxx = bcx + 12;   // t is SECONDS: flip L/R every 0.6s (was /300 ms = frozen)
      [[lxx, 3, side === 0], [rxx, 1, side === 1]].forEach(function (p) { const x = p[0], arrow = p[1], on = p[2]; g.save(); roundRectPath(g, x, py, pw, ph, 12); g.fillStyle = on ? 'rgba(255,214,90,.9)' : 'rgba(255,210,74,.12)'; if (on) { g.shadowColor = ACC; g.shadowBlur = 16; } g.fill(); g.lineWidth = 1.5; g.strokeStyle = 'rgba(255,210,74,.4)'; g.stroke(); g.restore(); g.fillStyle = on ? '#1a1206' : '#ffd9a0'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = "800 " + Math.round(ph * 0.4) + "px sans-serif"; g.fillText(_ARROW[arrow], x + pw / 2, py + ph / 2); g.textBaseline = 'alphabetic'; });
      if ((t % 0.6) < 0.26) tapText(side === 0 ? lxx + pw / 2 : rxx + pw / 2, py - 6);
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.textAlign = 'center'; g.fillText('ALTERNATE LEFT / RIGHT IN ORDER', bcx, by1 + 2);
    } else if (shape === 'shade') {
      // SHADE / CONTRAST (shaderank / simcontrast) (Jake 2026-09-14): FAITHFUL — patches of different brightness, tap the darkest.
      const dp = (t % 3.0) / 3.0, n = 3, sw = Math.min(76, (bw - 44) / n), gap = 16, tot = n * sw + (n - 1) * gap, gx = bcx - tot / 2, sy = bcy - sw / 2, shades = [0.62, 0.26, 0.5], ansIdx = 1;
      for (let i = 0; i < n; i++) { const x = gx + i * (sw + gap), c = Math.round(55 + 155 * shades[i]), on = i === ansIdx && dp > 0.55; g.save(); roundRectPath(g, x, sy, sw, sw, 10); g.fillStyle = 'rgb(' + c + ',' + c + ',' + Math.round(c * 1.03) + ')'; g.fill(); if (on) { g.lineWidth = 3; g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 12; } else { g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,.14)'; } g.stroke(); g.restore(); }
      const ax = gx + ansIdx * (sw + gap) + sw / 2, k = Math.min(1, dp / 0.8), fromy = by1 - 14;
      if (dp > 0.55) { g.save(); g.fillStyle = '#fff'; g.shadowColor = ACC; g.shadowBlur = 14; g.beginPath(); g.arc(ax, (sy + sw / 2) * k + fromy * (1 - k), 7, 0, TAU); g.fill(); g.restore(); }
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.textAlign = 'center'; g.fillText('TAP THE LIGHTEST OR DARKEST', bcx, by1 + 2);
    } else if (shape === 'find') {
      // FIND THE FIGURE (peephole / figurenoise) (Jake 2026-09-14): a faint shape hides in a noise field — spot it and tap. Approximates the
      // identify-the-stimulus games (which render a server PNG). Blatant here (the ring brightens); the real round's figure stays subtle.
      const dp = (t % 3.0) / 3.0, fx3 = bcx + bw * 0.12, fy3 = bcy - bh * 0.04, R = Math.min(bw, bh) * 0.16;
      g.save(); roundRectPath(g, bx0 + 4, by0 + 4, bw - 8, bh - 8, 8); g.clip();
      for (let i = 0; i < 120; i++) { const x = bx0 + 6 + ((i * 97) % (bw - 12)), y = by0 + 6 + ((i * 173 + (i % 7) * 11) % (bh - 12)); g.globalAlpha = 0.12 + ((i * 53) % 30) / 100; g.fillStyle = (i % 5) ? '#8a94a2' : '#c4ccd6'; g.beginPath(); g.arc(x, y, 2.2, 0, TAU); g.fill(); }
      g.globalAlpha = 0.35 + 0.6 * Math.min(1, dp / 0.7); g.strokeStyle = ACC; g.shadowColor = ACC; g.shadowBlur = dp > 0.5 ? 12 : 4; g.lineWidth = 3; g.beginPath(); g.arc(fx3, fy3, R, 0, TAU); g.stroke(); g.restore();
      const k = Math.min(1, dp / 0.85); if (dp > 0.55) { g.save(); g.fillStyle = '#fff'; g.shadowColor = ACC; g.shadowBlur = 14; g.beginPath(); g.arc(bcx + (fx3 - bcx) * k, (by1 - 14) + (fy3 - (by1 - 14)) * k, 7, 0, TAU); g.fill(); g.restore(); }
      g.globalAlpha = 1; g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.textAlign = 'center'; g.fillText('SPOT THE HIDDEN SHAPE, TAP IT', bcx, by1 + 2);
    } else {   // fate
      const dp = (t % 2.6) / 2.6, spin = easeOutExpo(Math.min(1, dp / 0.8)) * TAU * 6, R = Math.min(bw, bh) * 0.32;
      fx.metalDisc(g, bcx, bcy, R + 8, true); fx.bevelRing(g, bcx, bcy, R + 7, 4, ACC);
      for (let i = 0; i < 8; i++) { const a0 = spin + i / 8 * TAU, a1 = spin + (i + 1) / 8 * TAU; g.beginPath(); g.moveTo(bcx, bcy); g.arc(bcx, bcy, R, a0, a1); g.closePath(); g.fillStyle = i % 2 ? 'rgba(122,94,30,.9)' : 'rgba(20,18,14,.9)'; g.fill(); }
      fx.hub(g, bcx, bcy, 10); g.fillStyle = '#ffe08a'; g.beginPath(); g.moveTo(bcx + R + 2, bcy); g.lineTo(bcx + R + 15, bcy - 7); g.lineTo(bcx + R + 15, bcy + 7); g.closePath(); g.fill();
      g.fillStyle = '#cbbf9e'; g.font = "600 11px 'Space Mono',monospace"; g.fillText(dp > 0.85 ? 'LUCK DECIDES' : '', bcx, by1 + 2);
    }
  }
  // Input verb per game (Jake 2026-09-14): the How-It-Works prompt should say how you actually PLAY it — drag / hold / tap — not a blanket "TAP TO PLAY".
  function playVerb(k) {
    const s = demoShape(k);
    if (s === 'path' || s === 'orbit' || s === 'spiral') return 'DRAG TO PLAY';
    if (['powermeter', 'recoilctl', 'pressurevalve', 'twitchrelease', 'sustainhold', 'anglelaunch'].includes(k)) return 'HOLD TO PLAY';
    return 'TAP TO PLAY';
  }
  async function howto(canvas, gameKey) {
    const { g, w, h } = fit(canvas); const dir = directions(gameKey); const shape = demoShape(gameKey); let stop = false; const t0 = performance.now();
    // LAYOUT FIX (Jake 2026-09-14): the demo panel was squeezed to ~50px under a tall title+rules header, so grids/shapes shrank to
    // near-invisible ("How It Works not showing"). The modal ALREADY prints the game name above the canvas, so drop the in-canvas title,
    // keep a slim rules strip, and give the demo the REST of the canvas.
    const nLines = (dir.d || []).length; const lineGap = 16; const topH = 30 + nLines * lineGap + 8;
    const bx0 = 26, bx1 = w - 26, by0 = topH, by1 = h - 34, bw = bx1 - bx0, bh = by1 - by0, bcx = (bx0 + bx1) / 2, bcy = (by0 + by1) / 2;
    return await new Promise(resolve => {
      let raf; function frame() {
        const t = (performance.now() - t0) / 1000; bg(g, w, h); banner(g, w, 'HOW IT WORKS');
        if (shape === null) {
          // TEXT-ONLY (Jake 2026-09-14 polish3): no demo shape reads true for this game, so show ONLY the accurate centred rules,
          // vertically balanced in the play area — a correct description beats a misleading animation. All text is centre-aligned.
          const midY = 30 + (h - 30) / 2, blockH = 34 + nLines * lineGap;
          g.save(); g.textAlign = 'center';
          g.fillStyle = '#ffe9a8'; g.shadowColor = 'rgba(255,180,60,.5)'; g.shadowBlur = 12; g.font = "800 22px 'Chakra Petch',sans-serif"; g.fillText(dir.t, w / 2, midY - blockH / 2 + 22); g.shadowBlur = 0;
          g.fillStyle = '#d8ccab'; g.font = "500 15px 'Chakra Petch',sans-serif"; dir.d.forEach((line, i) => g.fillText(line, w / 2, midY - blockH / 2 + 54 + i * (lineGap + 4))); g.restore();
        } else {
          // slim rules strip (no redundant in-canvas title — the modal already shows the game name above the canvas). Demo gets the rest.
          g.save(); g.textAlign = 'center'; g.fillStyle = '#cbbf9e'; g.font = "500 13px 'Chakra Petch',sans-serif"; (dir.d || []).forEach((line, i) => g.fillText(line, w / 2, 34 + i * lineGap)); g.restore();
          // recessed demo panel
          g.save(); roundRectPath(g, bx0 - 6, by0 - 6, bw + 12, bh + 12, 12); const pg = g.createLinearGradient(0, by0, 0, by1); pg.addColorStop(0, '#14161a'); pg.addColorStop(1, '#0a0b0d'); g.fillStyle = pg; g.fill(); g.lineWidth = 1.2; g.strokeStyle = 'rgba(255,255,255,.1)'; g.stroke(); g.restore();
          g.save(); roundRectPath(g, bx0 - 6, by0 - 6, bw + 12, bh + 12, 12); g.clip();
          try { drawDemo(shape, g, { bx0, bx1, by0, by1, bcx, bcy, bw, bh, t }); } catch (e) {}
          g.restore();
        }
        // Jake 2026-09-15: the demo panel already prints a faithful per-shape caption (e.g. "TAP TRUE GREEN, SKIP THE REST") at by1+2, so
        // the generic bottom "TAP TO PLAY" was a SECOND stacked prompt (the "shown twice" Jake flagged). Only draw the generic verb+dot for
        // text-only games (shape===null), which have no in-panel caption; otherwise the caption alone carries the instruction.
        if (shape === null) {
          const _pt = playVerb(gameKey); g.fillStyle = '#ffe9a8'; g.textAlign = 'center'; g.font = "700 13px 'Chakra Petch',sans-serif";
          const _ptw = g.measureText(_pt).width, pr = 4 + 2 * Math.abs(Math.sin(t * 3));
          g.save(); g.fillStyle = ACC; g.shadowColor = ACC; g.shadowBlur = 12; g.beginPath(); g.arc(w / 2 - _ptw / 2 - 13, h - 26, pr, 0, TAU); g.fill(); g.restore();
          g.fillStyle = '#ffe9a8'; g.fillText(_pt, w / 2, h - 22);
        }
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
    await new Promise(resolve => { drawBoard(); function hit(e) { const r = canvas.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; chosen = clamp(Math.floor((px - 24) / ((w - 48) / slots)), 0, slots - 1); drawBoard(); try { sfx.click(); } catch (e2) {} canvas.removeEventListener('pointerdown', hit); setTimeout(resolve, 120); } canvas.addEventListener('pointerdown', hit); });
    // Self-animated reveal so the chip ALWAYS drops (arena AND the real door path — the door flow never called the old finish()).
    // Pure theatre: the true outcome is the fate roll / crack, so a client-random fall is fine. (Jake 2026-09-13)
    const bounces = []; for (let r = 0; r < rows; r++) bounces.push(Math.random() < 0.5 ? -1 : 1);
    let x = cxs(chosen); for (let r = 0; r < rows; r++) { const step = bounces[r]; const ny = top + r * pegGapY; await new Promise(rr => { const s0 = performance.now(); (function an() { const p = Math.min(1, (performance.now() - s0) / 90); drawBoard(x, ny + p * pegGapY); if (p >= 1) rr(); else requestAnimationFrame(an); })(); }); x += step * ((w - 60) / slots) / 2; }
    const slot = clamp(Math.round((x - 24) / ((w - 48) / slots) - 0.5), 0, slots - 1); const fx2 = 24 + (w - 48) * (slot + 0.5) / slots; drawBoard(fx2, top + boardH + 10); const v = vals[slot] || 0; try { v >= 1 ? sfx.win() : sfx.bust(); } catch (e) {} fx.readout(g, v + 'x', w / 2, h - 16, 20, v >= 1 ? GRN : '#ff9a6a'); await wait(650);
    return [{ type: 'drop', col: chosen }];
  }

  async function pRoulette(canvas, st) {
    const { g, w, h } = fit(canvas); const N = st.data.N, opts = st.data.options, arc = TAU / N;
    const cx = w / 2, cy = 30 + (h - 30) * 0.4, R = Math.min(w, h - 30) * 0.3; let opt = 0, anchor = -1, ang = 0, om = 7, spinning = false, landed = false, raf;
    function draw() { bg(g, w, h); banner(g, w, 'SAFE ROULETTE');
      g.save(); g.translate(cx, cy); g.rotate(ang); for (let i = 0; i < N; i++) { const a0 = i * arc; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R, a0, a0 + arc); g.closePath(); const covered = anchor >= 0 && (() => { for (let k = 0; k < opts[opt].cover; k++) if (((anchor + k) % N) === i) return true; return false; })(); g.fillStyle = covered ? 'rgba(255,210,74,.8)' : (i % 2 ? '#232a36' : '#1a2029'); g.fill(); g.strokeStyle = 'rgba(0,0,0,.4)'; g.stroke(); g.save(); g.rotate(a0 + arc / 2); g.fillStyle = covered ? '#1a1206' : '#8a93a0'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = "700 11px 'Space Mono',monospace"; g.fillText(String(i), R * 0.72, 0); g.restore(); } g.restore(); fx.hub(g, cx, cy, 13);
      g.save(); g.fillStyle = ACC; g.beginPath(); g.moveTo(cx, cy - R + 4); g.lineTo(cx - 8, cy - R - 12); g.lineTo(cx + 8, cy - R - 12); g.closePath(); g.fill(); g.restore();
      const bw = (w - 48 - 16) / 3; opts.forEach((o, i) => { const x = 24 + i * (bw + 8), y = h - 96; gBtn(g, x, y, bw, 34, i === opt ? '#ffd24a' : 'rgba(70,78,90,.6)', i === opt ? '#1a1206' : '#d8cfb8', o.k.toUpperCase(), true); });
      g.fillStyle = '#ffe9a8'; g.textAlign = 'center'; g.font = "700 12px 'Chakra Petch',sans-serif"; g.fillText(anchor < 0 ? 'PICK A BET, THEN TAP THE WHEEL' : 'TAP WHEEL TO SPIN', w / 2, h - 44); fx.vignette(g, w, h); }
    const bet = await new Promise(resolve => { draw(); function hit(e) { if (spinning) return; const r = canvas.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w, py = (e.clientY - r.top) / r.height * h; if (py >= h - 100 && py <= h - 62) { opt = clamp(Math.floor((px - 24) / (((w - 48 - 16) / 3) + 8)), 0, opts.length - 1); draw(); try { sfx.click(); } catch (e2) {} return; } const dx = px - cx, dy = py - cy; if (Math.hypot(dx, dy) <= R + 12) { let a = Math.atan2(dy, dx) - ang + Math.PI / 2; a = ((a % TAU) + TAU) % TAU; anchor = Math.floor(a / arc) % N; draw(); if (anchor >= 0) { spinning = true; canvas.removeEventListener('pointerdown', hit); resolve({ opt: opt, anchor: anchor }); } } } canvas.addEventListener('pointerdown', hit); });
    // Self-animated spin so the wheel ALWAYS spins (arena AND the real door path — the door flow never called the old finish()).
    // Pure theatre: the true outcome is the fate roll / crack, so a client-random landing is fine. (Jake 2026-09-13)
    const landing = Math.floor(Math.random() * N); const target = -(landing * arc + arc / 2) - Math.PI / 2; let goal = ang - (ang % TAU) + TAU * 3 + ((target % TAU) + TAU) % TAU; while (goal < ang + TAU * 2) goal += TAU; const s0 = performance.now(), a0 = ang;
    await new Promise(r => { (function an() { const p = Math.min(1, (performance.now() - s0) / 1500); ang = a0 + (goal - a0) * (1 - Math.pow(1 - p, 3)); draw(); if (p >= 1) r(); else requestAnimationFrame(an); })(); });
    let won = false; for (let k = 0; k < opts[bet.opt].cover; k++) if (((bet.anchor + k) % N) === landing) won = true; try { won ? sfx.win() : sfx.bust(); } catch (e) {} fx.readout(g, 'LANDED ' + landing, cx, cy + R + 30, 18, won ? GRN : '#ff6a6a'); await wait(650);
    return [{ type: 'bet', opt: bet.opt, anchor: bet.anchor }];
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
        function drawButtons() { const n = labels.length, by = h - 52, bh = 40, gap = 8, bw = (w - 40 - gap * (n - 1)) / n;
          // READ THE DIAL (Jake 2026-09-14 polish3): colour EACH numeric-range button to match the arc band it maps to, for ANY n
          // (was 4 only, so the real 6-range board stayed uncoloured and the colour<->number link was invisible). The gauge arc runs
          // low=green -> high=red left to right and the labels ascend, so band i's hue spans green(140) -> red(0) by its value fraction.
          // This makes the mapping unambiguous even when the loss reveal names a colour: the matching-colour button is that range.
          const dialPal = (st.gameKey === 'readdial' && n >= 2) ? Array.from({ length: n }, function (_, i) { var hue = 140 * (1 - i / (n - 1)); return 'hsl(' + hue.toFixed(0) + ',85%,58%)'; }) : null;
          // Publish the colour<->range mapping so the loss reveal can translate a bare colour name into the matching numeric band.
          if (dialPal) { try { window.RTV_LAST_DIAL = { labels: labels.slice(), colours: ['green', 'lime', 'yellow', 'amber', 'orange', 'red'].slice(0, n), n: n }; } catch (e) {} }
          for (let i = 0; i < n; i++) gBtn(g, 20 + i * (bw + gap), by, bw, bh, dialPal ? dialPal[i] : ACC, '#04121a', labels[i], true); }
        function fr() { const el = performance.now() - t0, rem = clamp(1 - el / dl, 0, 1); bg(g, w, h); banner(g, w, head); if (img) drawFrame(g, img, w, h); if (kind === 'choose') drawButtons(); g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(20, h - 9, w - 40, 4); g.fillStyle = rem < 0.3 ? '#ff6a6a' : ACC; g.fillRect(20, h - 9, (w - 40) * rem, 4);
          if (el >= dl && !done) { done = true; cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); try { sfx.bust(); } catch (e) {} resolve(-1); return; } if (!done) raf = requestAnimationFrame(fr); }
        function hit(e) { if (done) return; const r = canvas.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w, py = (e.clientY - r.top) / r.height * h; let idx = -1;
          if (kind === 'choose') { const n = labels.length, by = h - 52, bh = 40, gap = 8, bw = (w - 40 - gap * (n - 1)) / n; if (py >= by && py <= by + bh) for (let i = 0; i < n; i++) { const x = 20 + i * (bw + gap); if (px >= x && px <= x + bw) { idx = i; break; } } }
          else if (kind === 'tapgrid') { const gx0 = 0.09 * w, gw = 0.82 * w, gy0 = 30 + 0.09 * playH, gh = 0.82 * playH; const cc = Math.floor((px - gx0) / (gw / cols)), rr = Math.floor((py - gy0) / (gh / rows)); if (cc >= 0 && cc < cols && rr >= 0 && rr < rows) idx = rr * cols + cc; }
          else { const ry0 = 30 + playH * 0.58, ry1 = 30 + playH * 0.96; if (py >= ry0 && py <= ry1) { const cc = Math.floor(px / (w / cols)); if (cc >= 0 && cc < cols) idx = cc; } }
          if (idx < 0) return; done = true; cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); try { sfx.click(); } catch (e2) {} burst(px, py, '#8aa0b8'); resolve(idx); }   // Jake 2026-09-15: neutral "registered" burst (not a green/gold success tint) — correctness stays secret until the run resolves
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
    try { sfx.reveal(); } catch (e) {}   // Phase-1 audio: anticipation riser as the game opens
    const out = await P[st.gameKey](canvas, st);
    const events = Array.isArray(out) ? out : (out && out.events) || [];   // some presenters may return {events, finish} so they can animate the server-picked reveal
    const res = await post('api/skill/grade', { sid: st.sid, events });   // { score, bar, pass, gameKey, level, reveal }
    if (out && !Array.isArray(out) && typeof out.finish === 'function') { try { await out.finish(res); } catch (e) {} }   // reveal animation (wheel/plinko/dice/blackjack/mines)
    try { if (res && res.pass) sfx.win(); else if (res && res.pass === false) sfx.bust(); } catch (e) {}   // outcome cue
    return res;
  }
  // ── Parked orphan presenters (pStopwatch/pTargets/pSort) WIPED 2026-09-12 — their game keys are gone (SKILL V4 rebuild).
  async function playInto(canvas, st) { const fn = P[st.gameKey]; if (!fn) throw new Error('no renderer: ' + st.gameKey); try { sfx.reveal(); } catch (e) {} const out = await fn(canvas, st); if (Array.isArray(out)) return out; if (out && out.finish) { try { st._finish = out.finish; } catch (e) {} }   // reveal games return {events,finish}; door path grades separately, so hand back just the events (finish stashed for optional reveal)
    return (out && out.events) || []; }
  // split-flow helpers so the game can run inside the legacy mini shell (title/badge/GO/How/Back):
  // start() fetches the answer-free descriptor (arcade route), then the shell plays it on GO and grades with grade().
  async function start(opts) { opts = opts || {}; return await post('api/skill/start', { seed: opts.seed, level: opts.level, gameKey: opts.gameKey }); }
  async function grade(sid, events) { return await post('api/skill/grade', { sid, events: events || [] }); }
  // ── RHYTHM + DEXTERITY presenters (Jake 2026-09-12 prototype). Visual-first (audio optional). Each returns an events array. ──
  function _ryBar(g, w, t, dur) { const bw = Math.min(w * 0.6, 280), bx = (w - bw) / 2, tl = clamp(1 - t / dur, 0, 1); g.fillStyle = 'rgba(8,12,10,.8)'; roundRect(g, bx, 26, bw, 6, 3); g.fill(); g.save(); g.fillStyle = tl < 0.28 ? '#ff5a3c' : (tl < 0.55 ? '#ffce5a' : '#7fe86a'); roundRect(g, bx, 26, bw * tl, 6, 3); g.fill(); g.restore(); }
  function _pos(canvas, w, h, e) { const r = canvas.getBoundingClientRect(); return { x: clamp((e.clientX - r.left) * (w / r.width) / w, 0, 1), y: clamp((e.clientY - r.top) * (h / r.height) / h, 0, 1) }; }






  function _dxDrag(canvas, st, label, sub, draw, dur, startPos) { const { g, w, h } = fit(canvas); const ev = []; let last = 0;
    // MOBILE OCCLUSION FIX (Jake 2026-09-14): on touch the fingertip covers the dot you steer (maze/wire/circle etc.). Lift the CONTROLLED
    // point a fixed amount ABOVE the finger so your thumb never hides it, and draw a faint tether from finger->dot so the offset is obvious.
    // The graded {pt} = the lifted dot (what you see + steer), so grading stays consistent. Desktop (fine pointer) is unchanged.
    const COARSE = (function () { try { return matchMedia('(pointer:coarse)').matches; } catch (e) { return false; } })(), TOUCH_DY = 0.24;   // Jake 2026-09-14: lift the dot HIGHER above the finger (0.14->0.24) — 0.14 was still under the fingertip on a phone
    // EDGE INSET (Jake 2026-09-15): every dexterity play field was drawn to the full canvas, so geometry like Orbit Ring kissed the screen edge
    // and a phone thumb couldn't reach the extreme points. Inset the DRAWING by (IX,IY) and INVERT the same inset on pointer capture — so a
    // finger on any drawn point still maps to the identical logical 0..1 coord the SERVER grades. Grading is untouched (it only ever sees logical
    // coords); only the visible field shrinks in from the edges. Applied centrally here so it covers ALL _dxDrag dexterity games at once.
    const IX = 0.10, IY = 0.06, SX = 1 - 2 * IX, SY = 1 - 2 * IY;
    return new Promise(res => { let raf, t0 = performance.now(), done = false, dragging = false, everHeld = false, touchPt = null, dead = false, deadT = 0, cur = startPos ? { x: startPos.x, y: startPos.y } : { x: 0.5, y: 0.5 };
      function fr() { const t = performance.now() - t0; bg(g, w, h); banner(g, w, label); _ryBar(g, w, t, dur); g.save(); g.translate(IX * w, IY * h); g.scale(SX, SY); const _kill = draw(g, w, h, t, cur, dragging); g.restore();
        // INSTANT-DEATH HOOK (Jake 2026-09-14): a draw callback that returns TRUE (e.g. laser corridor when the icon touches a live beam)
        // kills the run — freeze input, flash red "HIT!", then submit (the server grades that contact as 0). Games that return nothing are unaffected.
        if (_kill && !dead && dragging) { dead = true; deadT = t; dragging = false; ev.push({ type: 'dead', t: Math.round(t) }); try { sfx.death(); } catch (e) {} }
        if (dead) { g.save(); g.fillStyle = 'rgba(200,20,12,' + (0.22 + 0.16 * Math.abs(Math.sin(t / 70))) + ')'; g.fillRect(0, 0, w, h); g.restore(); g.fillStyle = '#fff'; g.textAlign = 'center'; g.shadowColor = '#ff2a1e'; g.shadowBlur = 20; g.font = "900 32px 'Chakra Petch',sans-serif"; g.fillText('HIT!', w / 2, h / 2 + 4); g.shadowBlur = 0; g.fillStyle = '#ffd7d2'; g.font = "700 13px 'Space Mono',monospace"; g.fillText('RUN OVER', w / 2, h / 2 + 30); if (t - deadT > 560 && !done) { done = true; cleanup(); setTimeout(() => res(ev.length ? ev : [{ type: 'dead' }]), 60); return; } if (!done) raf = requestAnimationFrame(fr); return; }
        if (COARSE && dragging && touchPt) { const dRX = (IX + cur.x * SX) * w, dRY = (IY + cur.y * SY) * h; g.save(); g.strokeStyle = 'rgba(255,255,255,.22)'; g.lineWidth = 2; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(touchPt.x * w, touchPt.y * h); g.lineTo(dRX, dRY); g.stroke(); g.setLineDash([]); g.globalAlpha = 0.5; g.fillStyle = 'rgba(255,255,255,.4)'; g.beginPath(); g.arc(touchPt.x * w, touchPt.y * h, 5, 0, TAU); g.fill(); g.restore(); }   // "finger here -> dot above" tether (dot mapped back through the inset)
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText(sub, w / 2, h - 12);
        if (!everHeld) { const pulse = 0.6 + 0.4 * Math.sin(t / 260); g.save(); g.globalAlpha = pulse; g.fillStyle = '#ffe9a8'; g.textAlign = 'center'; g.shadowColor = ACC; g.shadowBlur = 12; g.font = "800 15px 'Chakra Petch',sans-serif"; g.fillText(COARSE ? 'HOLD & DRAG — THE DOT SITS ABOVE YOUR FINGER' : 'CLICK & HOLD TO CONTROL', w / 2, h / 2 + 6); g.restore(); }
        if (t >= dur && !done) { done = true; cleanup(); setTimeout(() => res(ev.length ? ev : [{ type: 'timeout' }]), 260); return; } if (!done) raf = requestAnimationFrame(fr); }
      // VISUAL cursor updates on EVERY move (zero perceived lag); only the graded {pt} events keep the ~28ms throttle.
      function samp(e) { const p = _pos(canvas, w, h, e); touchPt = { x: p.x, y: p.y }; if (COARSE) p.y = clamp(p.y - TOUCH_DY, 0, 1); cur = p; const t = performance.now() - t0; if (t - last < 28) return; last = t; ev.push({ type: 'pt', x: +p.x.toFixed(3), y: +p.y.toFixed(3), t: Math.round(t) }); }
      function down(e) { if (done || dead) return; dragging = true; everHeld = true; ev.push({ type: 'lift', t: Math.round(performance.now() - t0) }); samp(e); }
      function move(e) { if (!dragging || done) return; if (e.cancelable) e.preventDefault(); samp(e); }
      function up() { if (dragging) ev.push({ type: 'lift', t: Math.round(performance.now() - t0) }); dragging = false; }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointerleave', up); }
      canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move, { passive: false }); canvas.addEventListener('pointerup', up); canvas.addEventListener('pointerleave', up); fr(); }); }

  // shared START/END path marker: a labelled ring at a path endpoint. `pulse` makes the START breathe until the player grabs it.
  function pathMark(g, x, y, label, col, t, pulse) { g.save(); const a = pulse ? (0.55 + 0.45 * Math.sin(t / 220)) : 0.9; g.globalAlpha = a; g.strokeStyle = col; g.fillStyle = col; g.shadowColor = col; g.shadowBlur = pulse ? 14 : 8; g.lineWidth = 3; g.beginPath(); g.arc(x, y, pulse ? 14 : 10, 0, TAU); g.stroke(); g.globalAlpha = a * 0.35; g.beginPath(); g.arc(x, y, pulse ? 14 : 10, 0, TAU); g.fill(); g.restore(); g.save(); g.fillStyle = col; g.textAlign = 'center'; g.font = "700 10px 'Space Mono',monospace"; g.fillText(label, x, y - (pulse ? 20 : 16)); g.restore(); }



  function pLaserCorridor(canvas, st) { const lasers = st.data.lasers || [], dur = st.data.dur || 6500;
    // STRICT DEATH (Jake 2026-09-14): one touch of a LIVE beam = instant death. The draw callback returns TRUE on contact so _dxDrag kills
    // the run (red flash + submit); the server independently grades any live-beam contact as 0. Only cross a laser while it is dark.
    // SAFE-ENTRY FIX (Jake 2026-09-16): "I clicked and instantly lost." The old game forced you to grab at wherever you tapped — tap on a lit
    // beam and both client + server scored 0 with no chance to enter. Now you ENTER from a guaranteed-safe strip at the far LEFT (x<ENTRY, left
    // of every beam — beams live at x=(i+1)/(n+1) >= ~0.14), the grab is pinned into that strip, and death only ARMS once you have driven the dot
    // PAST the entry strip (i.e. actually into the corridor). The server applies the IDENTICAL grace (ignores contacts while x<=ENTRY). A real
    // live-beam crossing after entry still kills — the anti-cheat "must cross every beam only while dark" contract is untouched.
    const ENTRY = 0.06;   // must match server grade's ENTRY constant (safe left strip; no beam can sit here)
    return _dxDrag(canvas, st, 'LASER CORRIDOR', 'START LEFT IN GREEN, THEN CROSS EACH BEAM ONLY WHILE DARK', function (g, w, h, t, cur, dragging) { const y0 = 50, yh = h - 96;
      // safe-entry strip (green) at the left — grabbing here is always safe; death is disarmed until the dot leaves it
      g.save(); g.fillStyle = 'rgba(61,255,143,.10)'; g.fillRect(0, y0, ENTRY * w, yh); g.strokeStyle = 'rgba(61,255,143,.5)'; g.setLineDash([5, 5]); g.lineWidth = 2; g.beginPath(); g.moveTo(ENTRY * w, y0); g.lineTo(ENTRY * w, y0 + yh); g.stroke(); g.setLineDash([]); g.fillStyle = 'rgba(61,255,143,.6)'; g.textAlign = 'center'; g.font = "700 9px 'Space Mono',monospace"; g.save(); g.translate(ENTRY * w / 2, y0 + yh / 2); g.rotate(-Math.PI / 2); g.fillText('ENTER HERE', 0, 0); g.restore(); g.restore();
      const dotX = cur.x * w; let onLaser = false;   // touching a LIT beam = death (server matches: HALF=0.035*w band)
      for (const L of lasers) { const on = (((t / L.period) + L.phase) % 1) < L.onFrac; const X = L.x * w; if (on && Math.abs(dotX - X) < w * 0.035 + 9) onLaser = true; g.save(); if (on) { g.strokeStyle = '#ff5a3c'; g.shadowColor = '#ff5a3c'; g.shadowBlur = 14; g.lineWidth = 4; } else { g.strokeStyle = 'rgba(120,130,120,.35)'; g.lineWidth = 2; } g.beginPath(); g.moveTo(X, y0); g.lineTo(X, y0 + yh); g.stroke(); g.restore(); }
      const armed = cur.x > ENTRY;   // death only counts once the dot has left the safe entry strip (matches server grace)
      if (dragging) { const X = cur.x * w, Y = y0 + cur.y * yh; const col = (onLaser && armed) ? '#ff2a1e' : '#3dff8f', blur = (onLaser && armed) ? 20 : 12; g.save(); g.fillStyle = col; g.shadowColor = col; g.shadowBlur = blur; g.beginPath(); g.arc(X, Y, (onLaser && armed) ? 11 : 9, 0, TAU); g.fill(); g.restore(); }
      return onLaser && armed && dragging; }, dur, { x: 0.02, y: 0.5 }); }

  function pCoilUnwind(canvas, st) { const turns = st.data.turns || 2, dir = st.data.dir || 1, flipX = st.data.flipX || 1, flipY = st.data.flipY || 1, dur = st.data.dur || 7000, wobA = st.data.wobA || 0, wobF = st.data.wobF || 0, wobP = st.data.wobP || 0;
    // Spiral drawn in per-axis normalized space (R0=0.36 => rad*w horizontal, rad*h vertical) centred exactly at (0.5,0.5),
    // so a trace on the drawn spiral matches the server's spiral reconstruction (hypot in normalized coords) at any aspect ratio.
    const R0 = 0.36;   // outer radius (f=0). Spiral starts OUTSIDE and winds IN — grade requires start radius >= 0.55*R0 then reach centre.
    // radW(f): the wobble-modulated radius the SERVER grades against (rad*(1+wobA*sin(f*wobF+wobP))). Draw & on-path check use it too.
    const radW = f => R0 * (1 - f) * (1 + wobA * Math.sin(f * wobF + wobP));
    return _dxDrag(canvas, st, 'COIL UNWIND', 'HOLD AT THE OUTER END, TRACE ALL THE WAY IN', function (g, w, h, t, cur, dragging) { const cx = w / 2, cy = h / 2, T = turns * TAU; const outX = cx + flipX * radW(0) * w, outY = cy;   // outer start point (f=0, ang=0)
      g.strokeStyle = 'rgba(255,210,74,.5)'; g.lineWidth = 4; g.beginPath(); for (let i = 0; i <= 160; i++) { const f = i / 160, ang = dir * f * T, rad = radW(f), X = cx + flipX * Math.cos(ang) * rad * w, Y = cy + flipY * Math.sin(ang) * rad * h; i ? g.lineTo(X, Y) : g.moveTo(X, Y); } g.stroke();
      // CENTER / GOAL marker
      g.save(); g.fillStyle = 'rgba(61,255,143,.85)'; g.shadowColor = '#3dff8f'; g.shadowBlur = 10; g.beginPath(); g.arc(cx, cy, 8, 0, TAU); g.fill(); g.restore(); g.fillStyle = '#3dff8f'; g.textAlign = 'center'; g.font = "700 10px 'Space Mono',monospace"; g.fillText('GOAL', cx, cy - 14);
      // START marker at the OUTER end of the spiral
      g.save(); const sp = 0.6 + 0.4 * Math.sin(t / 240); g.globalAlpha = dragging ? 0.5 : sp; g.strokeStyle = '#7fd0ff'; g.fillStyle = 'rgba(125,208,255,.35)'; g.shadowColor = '#7fd0ff'; g.shadowBlur = 12; g.lineWidth = 3; g.beginPath(); g.arc(outX, outY, 15, 0, TAU); g.fill(); g.stroke(); g.restore(); g.fillStyle = '#7fd0ff'; g.textAlign = 'center'; g.font = "700 10px 'Space Mono',monospace"; g.fillText('START', outX, outY - 22);
      if (dragging) { const X = cur.x * w, Y = cur.y * h; let md = 1e9; for (let i = 0; i <= 160; i++) { const f = i / 160, ang = dir * f * T, rad = radW(f); const nx = 0.5 + flipX * Math.cos(ang) * rad, ny = 0.5 + flipY * Math.sin(ang) * rad; md = Math.min(md, Math.hypot(cur.x - nx, cur.y - ny)); } const onPath = md < 0.06, col = onPath ? '#3dff8f' : '#ff5a3c'; g.save(); g.fillStyle = col; g.shadowColor = col; g.shadowBlur = onPath ? 12 : 12 + 8 * Math.abs(Math.sin(t / 90)); g.beginPath(); g.arc(X, Y, 8, 0, TAU); g.fill(); g.restore(); } }, dur, { x: 0.5 + flipX * radW(0), y: 0.5 }); }

  function pTiltBalance(canvas, st) { const { g, w, h } = fit(canvas); const ev = []; const dur = st.data.dur || 7000, tol = st.data.tol || 0.18, drift = st.data.drift || 0.0008, driftPhase = st.data.driftPhase || 0, driftFreq = st.data.driftFreq || 0.002, setAmp = st.data.setAmp || 0.16, setFx = st.data.setFx || 0.0005, setPhase = st.data.setPhase || 0; let bx = 0.5, tx = 0.5, last = 0, nextGap = 30, dragging = false, everHeld = false;
    return new Promise(res => { let raf, t0 = performance.now(), done = false;
      function fr() { const t = performance.now() - t0; bg(g, w, h); banner(g, w, 'TILT BALANCE'); _ryBar(g, w, t, dur);
        // DIRECT SLIDER CONTROL (Jake 2026-09-14): the ball position PROPORTIONALLY follows the drag handle (small move = small move, no
        // velocity/accel overshoot). The old tilt model maxed out each side on mobile and was twitchy on desktop. A gentle seed drift nudges
        // the ball when you are NOT holding, so idle still drifts off the green and it stays a real balance. Grade reads the same streamed ball-x.
        const sp = 0.5 + setAmp * Math.sin(t * setFx + setPhase);
        const driftA = Math.sin(t * driftFreq + driftPhase) + 0.5 * Math.sin(t * driftFreq * 2.3 + driftPhase * 1.7);
        if (dragging) bx += (tx - bx) * 0.42; else bx = clamp(bx + driftA * drift * 3, 0, 1);
        bx = clamp(bx, 0, 1);
        if (t - last > nextGap) { last = t; nextGap = 26 + Math.random() * 26; ev.push({ type: 'pt', x: +bx.toFixed(3), y: 0.5, t: Math.round(t) }); }   // JITTERED cadence (Jake 2026-09-14): the old fixed frame-driven 28ms read as machine-regular (constant_dt) and dexauth-false-flagged a real human; jitter (26-52ms) breaks that signature while the grade still integrates fine
        const cy = h / 2 + 2, pw = w - 60, px = 30;
        // beam + wandering green band + the ball it carries
        g.strokeStyle = 'rgba(255,210,74,.55)'; g.lineWidth = 5; g.beginPath(); g.moveTo(px, cy); g.lineTo(px + pw, cy); g.stroke();
        g.fillStyle = 'rgba(61,255,143,.16)'; g.fillRect(px + (sp - tol) * pw, cy - 26, tol * 2 * pw, 52); g.strokeStyle = 'rgba(61,255,143,.5)'; g.lineWidth = 1.5; g.strokeRect(px + (sp - tol) * pw, cy - 26, tol * 2 * pw, 52);
        const inZ = Math.abs(bx - sp) <= tol, ballX = px + bx * pw; g.save(); g.fillStyle = inZ ? '#3dff8f' : '#ff5a3c'; g.shadowColor = g.fillStyle; g.shadowBlur = 14; g.beginPath(); g.arc(ballX, cy, 13, 0, TAU); g.fill(); g.restore();
        // the SLIDER you actually drag (whole track is live; the knob mirrors the ball)
        const sy = h - 48; g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 8; g.lineCap = 'round'; g.beginPath(); g.moveTo(px, sy); g.lineTo(px + pw, sy); g.stroke(); g.lineCap = 'butt';
        const knobX = px + bx * pw; g.save(); g.fillStyle = dragging ? ACC : '#ffe9a8'; g.shadowColor = ACC; g.shadowBlur = dragging ? 16 : 8; g.beginPath(); g.arc(knobX, sy, 16, 0, TAU); g.fill(); g.restore(); g.fillStyle = '#04121a'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = "800 13px 'Space Mono',monospace"; g.fillText('| |', knobX, sy + 1); g.textBaseline = 'alphabetic';
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('DRAG THE SLIDER TO KEEP THE BALL IN THE GREEN', w / 2, h - 12);
        if (!everHeld) { const pulse = 0.6 + 0.4 * Math.sin(t / 260); g.save(); g.globalAlpha = pulse; g.fillStyle = '#ffe9a8'; g.textAlign = 'center'; g.shadowColor = ACC; g.shadowBlur = 12; g.font = "800 15px 'Chakra Petch',sans-serif"; g.fillText('DRAG THE SLIDER', w / 2, sy - 28); g.restore(); }
        if (t >= dur && !done) { done = true; cleanup(); setTimeout(() => res(ev), 260); return; } if (!done) raf = requestAnimationFrame(fr); }
      // Absolute proportional control: the whole width is the slider, handle x = pointer x. Drag anywhere; small move = small ball move.
      function set(e) { const r = canvas.getBoundingClientRect(); tx = clamp((e.clientX - r.left) / r.width, 0, 1); }
      function down(e) { if (done) return; dragging = true; everHeld = true; try { canvas.setPointerCapture(e.pointerId); } catch (e2) {} if (e.cancelable) e.preventDefault(); set(e); }
      function move(e) { if (done || !dragging) return; if (e.cancelable) e.preventDefault(); set(e); }
      function upp() { dragging = false; }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', upp); canvas.removeEventListener('pointerleave', upp); canvas.removeEventListener('pointercancel', upp); }
      canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move, { passive: false }); canvas.addEventListener('pointerup', upp); canvas.addEventListener('pointerleave', upp); canvas.addEventListener('pointercancel', upp); fr(); }); }

  // ── generic tap-timing presenter (reuse for beat-matching rhythm games): draws via `draw(g,w,h,t,near)`; captures taps ──
  function _ryTap(canvas, st, label, sub, beats, tol, draw, extraTap) { const { g, w, h } = fit(canvas); const ev = []; const dur = st.data.dur || 6000; const fl = [];
    return new Promise(res => { let raf, t0 = performance.now(), done = false;
      const near = t => { let d = 1e9; for (const b of beats) d = Math.min(d, Math.abs(b - t)); return d; };
      function fr() { const t = performance.now() - t0; bg(g, w, h); banner(g, w, label); _ryBar(g, w, t, dur); draw(g, w, h, t, near, fl);
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText(sub, w / 2, h - 12);
        if (t >= dur && !done) { done = true; cleanup(); setTimeout(() => res(ev), 240); return; } if (!done) raf = requestAnimationFrame(fr); }
      function tap(e) { if (done) return; const t = Math.round(performance.now() - t0); const push = { type: 'tap', t }; if (extraTap) extraTap(push, e, canvas, w, h); ev.push(push); const ok = near(t) <= tol; fl.push({ t: performance.now() - t0, ok }); try { ok ? sfx.lock() : sfx.bust(); } catch (e2) {} burst(w / 2, h / 2 + 6, ok ? '#3dff8f' : '#ff5a3c'); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr(); }); }
  function _flashes(g, cx, cy, t, fl, R) { for (let i = fl.length - 1; i >= 0; i--) { const a = 1 - (t - fl[i].t) / 400; if (a <= 0) { fl.splice(i, 1); continue; } g.save(); g.globalAlpha = a * 0.3; g.fillStyle = fl[i].ok ? '#3dff8f' : '#ff5a3c'; g.beginPath(); g.arc(cx, cy, R * (1 + (1 - a) * 0.5), 0, TAU); g.fill(); g.restore(); } }











  // ── NEW DEXTERITY (10) — drag games; reuse _dxDrag where the input is a continuous drag ──
  function pMazeRun(canvas, st) { const corr = st.data.corridors || [], start = st.data.start || { x: 0.1, y: 0.1 }, exit = st.data.exit || { x: 0.9, y: 0.9 }, dur = st.data.dur || 7000;
    // FRAME / MOBILE-SAFE region (matches build's SX/SY): every corridor + both endpoints are generated inside this box so a phone thumb can
    // always reach them (the graded dot rides above the finger). We draw the frame so the play area reads as a bounded field, not the raw canvas.
    const FX0 = 0.14, FX1 = 0.86, FY0 = 0.14, FY1 = 0.70;
    return _dxDrag(canvas, st, 'MAZE RUN', 'DRAG FROM START TO EXIT WITHOUT HITTING WALLS', function (g, w, h, t, cur, dragging) {
      // bounded play field + border so the reachable region is obvious and the maze always sits inside a phone-reachable frame
      g.save(); g.fillStyle = 'rgba(6,14,10,.35)'; g.fillRect(FX0 * w, FY0 * h, (FX1 - FX0) * w, (FY1 - FY0) * h); g.strokeStyle = 'rgba(255,210,74,.28)'; g.lineWidth = 2; g.setLineDash([6, 5]); g.strokeRect(FX0 * w, FY0 * h, (FX1 - FX0) * w, (FY1 - FY0) * h); g.setLineDash([]); g.restore();
      g.save(); g.fillStyle = 'rgba(61,255,143,.12)'; for (const c of corr) g.fillRect(c.x * w, c.y * h, c.w * w, c.h * h); g.restore();
      g.strokeStyle = 'rgba(255,210,74,.4)'; g.lineWidth = 2; for (const c of corr) g.strokeRect(c.x * w, c.y * h, c.w * w, c.h * h);
      pathMark(g, start.x * w, start.y * h, 'START', '#7fd0ff', t, !dragging); pathMark(g, exit.x * w, exit.y * h, 'EXIT', '#3dff8f', t, false);
      if (dragging) { const inside = corr.some(c => cur.x >= c.x && cur.x <= c.x + c.w && cur.y >= c.y && cur.y <= c.y + c.h); g.save(); g.fillStyle = inside ? '#3dff8f' : '#ff5a3c'; g.shadowColor = g.fillStyle; g.shadowBlur = inside ? 12 : 12 + 8 * Math.abs(Math.sin(t / 90)); g.beginPath(); g.arc(cur.x * w, cur.y * h, 8, 0, TAU); g.fill(); g.restore(); } }, dur); }

  function pOrbitRing(canvas, st) { const rad = st.data.rad || 0.3, dur = st.data.dur || 7000;
    // The ring is drawn as an ELLIPSE at rad*w (horizontal) and rad*h (vertical) centred exactly at (0.5,0.5) in normalized
    // space, so a cursor traced on the drawn ring yields hypot(cur.x-0.5, cur.y-0.5) === rad regardless of canvas aspect
    // ratio (grade measures in that same per-axis normalized space). No +6px offset — it would bias the graded radius.
    return _dxDrag(canvas, st, 'ORBIT RING', 'DRAG AROUND THE RING — KEEP ON THE PATH', function (g, w, h, t, cur, dragging) { const cx = w / 2, cy = h / 2;
      g.save(); g.strokeStyle = 'rgba(255,210,74,.5)'; g.lineWidth = 6; g.beginPath(); g.ellipse(cx, cy, rad * w, rad * h, 0, 0, TAU); g.stroke(); g.restore();
      g.save(); g.fillStyle = 'rgba(125,208,255,.6)'; g.beginPath(); g.arc(cx, cy, 5, 0, TAU); g.fill(); g.restore();
      if (dragging) { const dx = cur.x - 0.5, dy = cur.y - 0.5, rr = Math.hypot(dx, dy); const dev = Math.abs(rr - rad); g.save(); g.fillStyle = dev < 0.045 ? '#3dff8f' : (dev < 0.08 ? '#ffd24a' : '#ff5a3c'); g.shadowColor = g.fillStyle; g.shadowBlur = 12; g.beginPath(); g.arc(cur.x * w, cur.y * h, 9, 0, TAU); g.fill(); g.restore(); } }, dur); }


  function pCrankLever(canvas, st) { const turns = st.data.turns || 2, dir = st.data.dir || 1, dur = st.data.dur || 7000, rMin = st.data.rMin != null ? st.data.rMin : 0.05, rMax = st.data.rMax != null ? st.data.rMax : 1e9; let total = 0, prevA = null;
    // COORD FIX (Jake 2026-09-16): "the counter never leaves 0.0/N." The winding is measured (and SERVER-graded) around logical (0.5,0.5), but
    // the ring used to be drawn at cy=h/2+6 (logical 0.5+6/h) AND as pixel circles (arc R) which, once _dxDrag's anisotropic inset transform
    // (translate IX,IY + scale SX,SY) is applied, become an off-centre non-normalized ellipse. So a normal circular drag on the VISIBLE ring
    // circled a point that was NOT the winding origin -> atan2 scrubbed back and forth and netted ~0. FIX = mirror the PROVEN Orbit Ring geometry:
    // centre the ring at (w/2, h/2) == logical (0.5,0.5) (drop the +6px bias) and draw every ring/annulus as an ELLIPSE (r*w, r*h) so a trace on
    // the drawn ring yields a CONSTANT hypot(cur.x-0.5,cur.y-0.5) in the same per-axis normalized space the gate + grade use. The dot stays at
    // cur.x*w,cur.y*h. The SERVER grade (rMin/rMax/backPen/turns, winding around 0.5,0.5) is UNCHANGED — this only aligns the drawing to it.
    return _dxDrag(canvas, st, 'CRANK LEVER', 'DRAG BIG CIRCLES INSIDE THE RING TO CRANK IT ROUND', function (g, w, h, t, cur, dragging) { const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.3;
      // in-band grip only (matches grade's rMin/rMax annulus): a sample inside rMin or outside rMax breaks the angle chain.
      if (dragging) { const dx = cur.x - 0.5, dy = cur.y - 0.5, rr = Math.hypot(dx, dy); if (rr >= rMin && rr <= rMax) { const a = Math.atan2(dy, dx); if (prevA != null) { let da = a - prevA; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI; total += da * dir; } prevA = a; } else prevA = null; } else prevA = null;
      const turned = Math.max(0, total) / (2 * Math.PI), prog = clamp(turned / turns, 0, 1);
      // draw the target grip annulus (rMin..rMax) as ELLIPSES in the SAME normalized space the gate uses (rIn=rMin -> rMin*w,rMin*h etc.), so the
      // visible ring the player circles == the annulus that registers == what the server grades. rOut caps at 0.46 (a wide, forgiving target).
      const rInX = rMin * w, rInY = rMin * h, rOutN = (rMax < 1 ? rMax : 0.46), rOutX = rOutN * w, rOutY = rOutN * h;
      g.save(); g.beginPath(); g.ellipse(cx, cy, rOutX, rOutY, 0, 0, TAU); g.ellipse(cx, cy, rInX, rInY, 0, 0, TAU, true); g.fillStyle = 'rgba(125,208,255,.09)'; g.fill('evenodd'); g.restore();
      g.save(); g.strokeStyle = 'rgba(125,208,255,.55)'; g.setLineDash([5, 5]); g.lineWidth = 2; g.beginPath(); g.ellipse(cx, cy, rInX, rInY, 0, 0, TAU); g.stroke(); g.beginPath(); g.ellipse(cx, cy, rOutX, rOutY, 0, 0, TAU); g.stroke(); g.setLineDash([]); g.restore();
      g.save(); g.fillStyle = 'rgba(125,208,255,.5)'; g.textAlign = 'center'; g.font = "700 9px 'Space Mono',monospace"; g.fillText('SPIN INSIDE THIS RING', cx, cy - rOutY - 6); g.restore();
      // the mid-ring guide the player traces sits inside the annulus, drawn as an ellipse at the same normalized radius (mid of the band).
      const rMidN = clamp((rMin + rOutN) / 2, rMin + 0.02, rOutN - 0.02); g.strokeStyle = 'rgba(255,210,74,.25)'; g.lineWidth = 6; g.beginPath(); g.ellipse(cx, cy, rMidN * w, rMidN * h, 0, 0, TAU); g.stroke();
      g.save(); g.strokeStyle = prog >= 1 ? '#3dff8f' : '#ffd24a'; g.shadowColor = g.strokeStyle; g.shadowBlur = 12; g.lineWidth = 6; g.beginPath(); g.ellipse(cx, cy, rMidN * w, rMidN * h, 0, -Math.PI / 2, -Math.PI / 2 + prog * TAU); g.stroke(); g.restore();
      g.fillStyle = prog >= 1 ? '#3dff8f' : '#e6ddc8'; g.textAlign = 'center'; g.font = "700 20px 'Space Mono',monospace"; g.fillText(turned.toFixed(1) + '/' + turns, cx, cy + 7);
      if (dragging) { g.save(); g.fillStyle = '#7fd0ff'; g.shadowColor = '#7fd0ff'; g.shadowBlur = 10; g.beginPath(); g.arc(cur.x * w, cur.y * h, 8, 0, TAU); g.fill(); g.restore(); } }, dur); }

  function pTraceChase(canvas, st) { const path = st.data.path || [], dur = st.data.dur || 7000; const targetAt = t => { if (!path.length) return { x: 0.5, y: 0.5 }; if (t <= path[0].t) return path[0]; for (let i = 1; i < path.length; i++) { if (t <= path[i].t) { const a = path[i - 1], b = path[i], f = (t - a.t) / Math.max(1, b.t - a.t); return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }; } } return path[path.length - 1]; };
    return _dxDrag(canvas, st, 'TRACE CHASE', 'KEEP YOUR CURSOR ON THE MOVING TARGET', function (g, w, h, t, cur, dragging) { const tg = targetAt(t); g.save(); g.strokeStyle = 'rgba(255,210,74,.6)'; g.lineWidth = 3; g.beginPath(); g.arc(tg.x * w, tg.y * h, 18, 0, TAU); g.stroke(); g.fillStyle = 'rgba(255,210,74,.3)'; g.beginPath(); g.arc(tg.x * w, tg.y * h, 8, 0, TAU); g.fill(); g.restore();
      if (dragging) { const dist = Math.hypot(cur.x - tg.x, cur.y - tg.y); g.save(); g.fillStyle = dist < 0.09 ? '#3dff8f' : (dist < 0.16 ? '#ffd24a' : '#ff5a3c'); g.shadowColor = g.fillStyle; g.shadowBlur = 12; g.beginPath(); g.arc(cur.x * w, cur.y * h, 9, 0, TAU); g.fill(); g.restore(); } }, dur); }



  function pSteadyHold(canvas, st) { const zone = st.data.zone || 0.16, amp = st.data.amp || 0.12, fx = st.data.fx || 0.0006, fy = st.data.fy || 0.0005, px = st.data.px || 0, py = st.data.py || 0, dur = st.data.dur || 7000;
    // The hold zone slowly WANDERS on the same seed path the server grades against (tx,ty). Keep the dot in the CENTER; touching the rim is
    // a "hit" (Jake 2026-09-15): the ring + dot flash red, the whole panel shakes, a penalty pops and an EDGE HITS tally climbs — panic feedback
    // that mirrors the server's edge-touch deduction (>0.82 of the zone == rim contact).
    let edgeHits = 0, prevSafe = true, flashT = -1e9;
    return _dxDrag(canvas, st, 'STEADY HOLD', 'HOLD IN THE CENTER — DO NOT TOUCH THE EDGE', function (g, w, h, t, cur, dragging) { const tx = 0.5 + amp * Math.sin(t * fx + px), ty = 0.5 + amp * Math.sin(t * fy + py); const zx = tx * w, zy = ty * h;
      const r0 = dragging ? Math.hypot(cur.x - tx, cur.y - ty) / zone : 0, nearEdge = dragging && r0 >= 0.82;
      if (dragging) { const safe = r0 < 0.82; if (prevSafe && !safe) { edgeHits++; flashT = t; try { sfx.bust && sfx.bust(); } catch (e) {} } prevSafe = safe; } else prevSafe = true;
      const shake = nearEdge ? 3.2 : 0; g.save(); if (shake) g.translate((Math.random() - 0.5) * shake * 2, (Math.random() - 0.5) * shake * 2);
      g.save(); g.strokeStyle = nearEdge ? 'rgba(255,90,60,.95)' : 'rgba(61,255,143,.4)'; g.lineWidth = nearEdge ? 3 : 2; if (nearEdge) { g.shadowColor = '#ff5a3c'; g.shadowBlur = 16; } g.setLineDash([5, 4]); g.beginPath(); g.ellipse(zx, zy, zone * w, zone * h, 0, 0, TAU); g.stroke(); g.restore();
      g.save(); g.strokeStyle = 'rgba(61,255,143,.18)'; g.lineWidth = 1; g.beginPath(); g.ellipse(zx, zy, zone * 0.8 * w, zone * 0.8 * h, 0, 0, TAU); g.stroke(); g.restore();
      g.save(); g.fillStyle = 'rgba(61,255,143,.6)'; g.beginPath(); g.arc(zx, zy, 4, 0, TAU); g.fill(); g.restore();
      if (dragging) { const col = nearEdge ? '#ff5a3c' : (r0 < 0.8 ? '#3dff8f' : '#ffd24a'); g.save(); g.fillStyle = col; g.shadowColor = col; g.shadowBlur = nearEdge ? 18 : 14; g.beginPath(); g.arc(cur.x * w, cur.y * h, nearEdge ? 12 : 10, 0, TAU); g.fill(); g.restore(); }
      g.restore();
      if (t - flashT < 400) { g.save(); g.globalAlpha = Math.max(0, 1 - (t - flashT) / 400); g.fillStyle = '#ff5a3c'; g.textAlign = 'center'; g.font = "800 15px 'Chakra Petch',sans-serif"; g.fillText('EDGE!', cur.x * w, cur.y * h - 20); g.restore(); }
      if (edgeHits > 0) { g.save(); g.fillStyle = 'rgba(255,90,60,.9)'; g.textAlign = 'left'; g.font = "700 12px 'Space Mono',monospace"; g.fillText('EDGE HITS ' + edgeHits, 12, h - 12); g.restore(); } }, dur); }

  // Distinct from Gap Threader: SOLID blocks rain down in waves at scattered lanes; keep the dot in CLEAR space (not under any block).


  // ── NEW DEXTERITY (4) — Jake 2026-09-14 deep-chamber variety (STAGED behind RTV_DEX_NEW in skillv4.js). Drag games; reuse _dxDrag
  //    so the graded pt/lift stream matches the presenter EXACTLY. dialstop = the requested "safedial" mechanic (that key is a live LUCK game).
  function pDialStop(canvas, st) { const targets = st.data.targets || [], decoys = st.data.decoys || [], tol = st.data.tol || 0.3, dur = st.data.dur || 7000; let ti = 0, dwellFrom = null, dwellAng = 0;
    // hold + drag AROUND the dial to rotate; STOP (dwell) on each lit target notch in order. Draws notches at their angles; the live dot shows the current angle.
    return _dxDrag(canvas, st, 'DIAL STOP', 'DRAG THE DIAL, STOP ON EACH LIT NOTCH IN ORDER', function (g, w, h, t, cur, dragging) { const cx = w / 2, cy = h / 2 + 6, R = Math.min(w, h) * 0.32;
      g.save(); g.strokeStyle = 'rgba(255,210,74,.3)'; g.lineWidth = 6; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke(); g.restore();
      // decoy notches (baited, never advance)
      for (const a of decoys) { const nx = cx + Math.cos(a) * R, ny = cy + Math.sin(a) * R; g.save(); g.fillStyle = 'rgba(125,208,255,.35)'; g.beginPath(); g.arc(nx, ny, 7, 0, TAU); g.fill(); g.restore(); }
      // target notches: done=green, current=pulsing amber, upcoming=dim
      targets.forEach((a, i) => { const nx = cx + Math.cos(a) * R, ny = cy + Math.sin(a) * R; const done = i < ti, act = i === ti; g.save(); g.fillStyle = done ? '#3dff8f' : (act ? '#ffd24a' : 'rgba(255,210,74,.3)'); g.shadowColor = g.fillStyle; g.shadowBlur = act ? 14 : 0; g.beginPath(); g.arc(nx, ny, act ? 10 : 8, 0, TAU); g.fill(); g.restore(); });
      // live angle + dwell detection (mirrors grade: settle within tol*0.5 of a target for dwellMs)
      if (dragging) { const ang = Math.atan2(cur.y - 0.5, cur.x - 0.5); const dx2 = cx + Math.cos(ang) * R, dy2 = cy + Math.sin(ang) * R; g.save(); g.fillStyle = '#7fd0ff'; g.shadowColor = '#7fd0ff'; g.shadowBlur = 10; g.beginPath(); g.arc(dx2, dy2, 9, 0, TAU); g.fill(); g.restore();
        if (ti < targets.length) { let da = ang - targets[ti]; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI; if (Math.abs(da) <= tol) { if (dwellFrom == null) { dwellFrom = t; dwellAng = ang; } else if (t - dwellFrom >= (st.data.dwellMs || 200)) { ti++; dwellFrom = null; try { sfx.lock(); } catch (e) {} burst(dx2, dy2, '#3dff8f'); } } else dwellFrom = null; }
      } else dwellFrom = null;
      g.fillStyle = ti >= targets.length ? '#3dff8f' : '#e6ddc8'; g.textAlign = 'center'; g.font = "700 18px 'Space Mono',monospace"; g.fillText(ti + '/' + targets.length, cx, cy + 6); }, dur); }

  function pUndertow(canvas, st) { const cur = st.data.cur || 0.15, curFx = st.data.curFx || 0.002, curPhase = st.data.curPhase || 0, lane = st.data.lane || 0.18, ctr = st.data.ctr || [{ f: 0, x: 0.5 }, { f: 1, x: 0.5 }], dur = st.data.dur || 7000;
    const laneAt = f => { if (f <= ctr[0].f) return ctr[0].x; for (let i = 1; i < ctr.length; i++) { if (f <= ctr[i].f) { const a = ctr[i - 1], b = ctr[i], g = (f - a.f) / Math.max(1e-6, b.f - a.f); return a.x + (b.x - a.x) * g; } } return ctr[ctr.length - 1].x; };
    // token rises with time (y from bottom to top); your drag x steers it. A side-current arrow shows the push you must fight.
    return _dxDrag(canvas, st, 'UNDERTOW', 'HOLD + STEER: COUNTER THE CURRENT, STAY IN THE LANE', function (g, w, h, t, cx, dragging) { const y0 = 44, y1 = h - 56; const f = clamp(t / dur, 0, 1); const tokY = y1 - f * (y1 - y0);
      // draw the winding lane (safe corridor)
      g.save(); g.strokeStyle = 'rgba(61,255,143,.14)'; g.lineWidth = lane * 2 * w; g.lineCap = 'round'; g.beginPath(); for (let i = 0; i <= 40; i++) { const ff = i / 40, X = laneAt(ff) * w, Y = y1 - ff * (y1 - y0); i ? g.lineTo(X, Y) : g.moveTo(X, Y); } g.stroke(); g.restore();
      g.save(); g.strokeStyle = 'rgba(255,210,74,.45)'; g.lineWidth = 2; g.beginPath(); for (let i = 0; i <= 40; i++) { const ff = i / 40, X = laneAt(ff) * w, Y = y1 - ff * (y1 - y0); i ? g.lineTo(X, Y) : g.moveTo(X, Y); } g.stroke(); g.restore();
      pathMark(g, laneAt(1) * w, y0, 'EXIT', '#3dff8f', t, false);
      // current arrow (informational): direction of the sideways push at this moment
      const cc = cur * Math.sin(t * curFx + curPhase); const ax = w / 2, ay = y1 + 20, dir = cc >= 0 ? 1 : -1, mag = Math.min(40, Math.abs(cc) * 160); g.save(); g.strokeStyle = '#7fd0ff'; g.fillStyle = '#7fd0ff'; g.lineWidth = 3; g.beginPath(); g.moveTo(ax - dir * mag, ay); g.lineTo(ax + dir * mag, ay); g.stroke(); g.beginPath(); g.moveTo(ax + dir * mag, ay); g.lineTo(ax + dir * (mag - 8), ay - 5); g.lineTo(ax + dir * (mag - 8), ay + 5); g.closePath(); g.fill(); g.restore(); g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "11px 'Space Mono',monospace"; g.fillText('CURRENT', ax, ay + 18);
      const px = dragging ? cx.x : 0.5; const inLane = Math.abs(px - laneAt(f)) <= lane; g.save(); g.fillStyle = inLane ? '#3dff8f' : '#ff5a3c'; g.shadowColor = g.fillStyle; g.shadowBlur = inLane ? 12 : 12 + 8 * Math.abs(Math.sin(t / 90)); g.beginPath(); g.arc(px * w, tokY, 11, 0, TAU); g.fill(); g.restore(); }, dur); }

  function pGateRunner(canvas, st) { const gates = st.data.gates || [], dur = st.data.dur || 7000; const WALL = st.data.wall || [200, 90, 70], GAPF = st.data.gapf || [61, 255, 143], style = st.data.style | 0, VW = 0.62;
    const rgb = (a, al) => 'rgba(' + a[0] + ',' + a[1] + ',' + a[2] + (al != null ? ',' + al : '') + ')';
    // Gaps SLIDE from sx -> gx as they approach (arriving at gx, which the server samples). Per-run colour + wall style (0 solid, 1 hazard
    // chevrons, 2 rounded blocks). Faster cadence + more gates means several are on screen at once. (Jake 2026-09-15 facelift.)
    return _dxDrag(canvas, st, 'GATE RUNNER', 'STEER INTO THE GAP OF EACH ONCOMING GATE', function (g, w, h, t, cur, dragging) { const y0 = 44, markerY = h - 66, span = markerY - y0, barH = 16;
      for (const gt of gates) { const arriveT = gt.f * dur; const dt = arriveT - t; if (dt > dur * VW || dt < -600) continue; const prog = clamp(1 - dt / (dur * VW), 0, 1); const y = markerY - (dt / (dur * VW)) * span; const sx = (gt.sx != null ? gt.sx : gt.gx); const gcx = sx + (gt.gx - sx) * prog; const gxx = gcx * w, gww = gt.gw * w; const hot = Math.abs(dt) < 260; const wcol = hot ? rgb(WALL, 0.9) : rgb(WALL, 0.5);
        const drawWall = (x0, x1) => { if (x1 <= x0) return; if (style === 2) { g.fillStyle = wcol; roundRect(g, x0, y - barH / 2, x1 - x0, barH, 5); g.fill(); } else if (style === 1) { g.fillStyle = wcol; g.fillRect(x0, y - barH / 2, x1 - x0, barH); g.strokeStyle = rgb(WALL, 0.95); g.lineWidth = 2; for (let cxx = x0; cxx < x1; cxx += 12) { g.beginPath(); g.moveTo(cxx, y - barH / 2); g.lineTo(cxx + 6, y); g.lineTo(cxx, y + barH / 2); g.stroke(); } } else { g.fillStyle = wcol; g.fillRect(x0, y - barH / 2, x1 - x0, barH); } };
        g.save(); drawWall(0, gxx - gww); drawWall(gxx + gww, w); g.strokeStyle = hot ? rgb(GAPF) : rgb(GAPF, 0.55); g.lineWidth = hot ? 3 : 2; g.strokeRect(gxx - gww, y - barH / 2, gww * 2, barH); g.restore(); }
      const px = dragging ? cur.x : 0.5; let safe = true; for (const gt of gates) { const dt = gt.f * dur - t; if (Math.abs(dt) < 90) { if (Math.abs(px - gt.gx) > gt.gw) safe = false; } } const col = safe ? '#3dff8f' : '#ff5a3c'; g.save(); g.fillStyle = col; g.shadowColor = col; g.shadowBlur = safe ? 12 : 12 + 8 * Math.abs(Math.sin(t / 90)); g.beginPath(); g.arc(px * w, markerY, 11, 0, TAU); g.fill(); g.restore();
      g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "11px 'Space Mono',monospace"; g.fillText('MARKER', px * w, markerY + 24); }, dur); }

  function pLiveWire(canvas, st) { const amp = st.data.amp || 0.2, motion = st.data.motion || 0.002, waveF = st.data.waveF || 3, phase = st.data.phase || 0, dur = st.data.dur || 7000;
    const lineY = (x, t) => 0.5 + amp * Math.sin(waveF * Math.PI * x + t * motion + phase);
    // trace a wire that MOVES while you trace — the drawn line shifts in real time; track the live line left->right.
    return _dxDrag(canvas, st, 'LIVE WIRE', 'TRACE THE WIRE AS IT MOVES', function (g, w, h, t, cur, dragging) { const x0 = 20, x1 = w - 20, y0 = 44, yh = h - 88; const px = nx => x0 + nx * (x1 - x0), py = ny => y0 + ny * yh;
      g.save(); g.strokeStyle = 'rgba(255,210,74,.55)'; g.lineWidth = 5; g.lineCap = 'round'; g.beginPath(); for (let i = 0; i <= 80; i++) { const nx = i / 80, X = px(nx), Y = py(clamp(lineY(nx, t), 0, 1)); i ? g.lineTo(X, Y) : g.moveTo(X, Y); } g.stroke(); g.restore();
      pathMark(g, px(0), py(clamp(lineY(0, t), 0, 1)), 'START', '#7fd0ff', t, !dragging); pathMark(g, px(1), py(clamp(lineY(1, t), 0, 1)), 'END', '#3dff8f', t, false);
      if (dragging) { const tgt = lineY(cur.x, t), dev = Math.abs(cur.y - tgt); g.save(); g.fillStyle = dev < 0.06 ? '#3dff8f' : (dev < 0.09 ? '#ffd24a' : '#ff5a3c'); g.shadowColor = g.fillStyle; g.shadowBlur = 12; g.beginPath(); g.arc(px(cur.x), py(clamp(cur.y, 0, 1)), 9, 0, TAU); g.fill(); g.restore(); } }, dur); } P.lasercorridor = pLaserCorridor; P.coilunwind = pCoilUnwind; P.tiltbalance = pTiltBalance;
  // NEW RHYTHM (10) — Jake 2026-09-12 expansion
  // NEW DEXTERITY (10) — Jake 2026-09-12 expansion (drag games reuse _dxDrag)
  P.mazerun = pMazeRun; P.orbitring = pOrbitRing; P.cranklever = pCrankLever; P.tracechase = pTraceChase; P.steadyhold = pSteadyHold;
  // NEW DEXTERITY (4) — Jake 2026-09-14 deep-chamber variety (STAGED behind RTV_DEX_NEW; presenters always registered so they play the instant the flag flips)
  P.dialstop = pDialStop; P.undertow = pUndertow; P.gaterunner = pGateRunner; P.livewire = pLiveWire;

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  // ── SKILL V4 presenters (Jake 2026-09-12): PRECISE DISCRETE EXECUTION UNDER UNCERTAINTY. Client-drawn (no server PNG); each
  //    returns an events array the SERVER grades against its own secret. REACTION games reveal the go-cue at the server-random time
  //    shipped in data and the server rejects taps <110ms after it (pre-fire); SEQUENCE games react to presses; CHARGE/AIM commit
  //    a value under live feedback. Display data rides in `data` (mirrors the rhythm/dexterity presenters), grading keys in `secret`.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  const RXCOLD = '#7d94a6', RXHOT = '#3dff8f', RXRED = '#ff5a3c', RXAMB = '#ffd24a';
  function _rxTimeBar(g, w, t, dur) { const bw = Math.min(w * 0.6, 280), bx = (w - bw) / 2, tl = clamp(1 - t / dur, 0, 1); g.fillStyle = 'rgba(8,12,10,.8)'; roundRect(g, bx, 26, bw, 6, 3); g.fill(); g.save(); g.fillStyle = tl < 0.28 ? RXRED : (tl < 0.55 ? RXAMB : RXHOT); roundRect(g, bx, 26, bw * tl, 6, 3); g.fill(); g.restore(); }

  // grid geometry helper for the pad/glyph grids (gonogo/oddsignal). Returns {cellW,cellH,x0,y0,gx,gy,idxAt}.
  function _rxGrid(w, h, cols, rows) { const padX = 24, top = 96, bot = 44; const gw = w - padX * 2, gh = h - top - bot; const cellW = gw / cols, cellH = gh / rows;
    const gx = i => padX + (i % cols) * cellW + cellW / 2, gy = i => top + Math.floor(i / cols) * cellH + cellH / 2;
    const idxAt = (px, py) => { if (px < padX || px > w - padX || py < top || py > h - bot) return -1; const c = Math.floor((px - padX) / cellW), rIdx = Math.floor((py - top) / cellH); if (c < 0 || c >= cols || rIdx < 0 || rIdx >= rows) return -1; return rIdx * cols + c; };
    return { cellW, cellH, gx, gy, idxAt, r: Math.min(cellW, cellH) * 0.36 }; }
  // small glyph library for the visual-search game (drawn at (cx,cy), radius R, rotation quarter-turns).
  function _rxGlyph(g, cx, cy, R, shape, rot) { g.save(); g.translate(cx, cy); g.rotate(rot * Math.PI / 2); g.beginPath();
    switch (shape % 6) {
      case 0: g.moveTo(0, -R); g.lineTo(R, R); g.lineTo(-R, R); g.closePath(); break;                 // triangle
      case 1: g.rect(-R * 0.82, -R * 0.82, R * 1.64, R * 1.64); break;                                  // square
      case 2: g.arc(0, 0, R * 0.9, 0, TAU); break;                                                      // circle
      case 3: for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * TAU / 5; const fn = i ? 'lineTo' : 'moveTo'; g[fn](Math.cos(a) * R, Math.sin(a) * R); } g.closePath(); break;   // pentagon
      case 4: g.moveTo(0, -R); g.lineTo(R, 0); g.lineTo(0, R); g.lineTo(-R, 0); g.closePath(); break;   // diamond
      default: g.moveTo(-R, -R * 0.5); g.lineTo(R, -R * 0.5); g.lineTo(0, R); g.closePath(); break;      // wedge
    } g.fill(); g.restore(); }

  // ── REACTION anti-leak: 300-space layouts that MIRROR render.js (rxGridLayout / rxPadLayout). The served answer PNG is drawn full-bleed
  //    into the play area (0,30)-(w,h); a client tap is mapped back to 300-space so its cell/pad index matches the served pixel exactly.
  function _c2s(canvas, w, h, e) { const r = canvas.getBoundingClientRect(); const px = (e.clientX - r.left) * (w / r.width), py = (e.clientY - r.top) * (h / r.height); return { sx: px / w * 300, sy: (py - 30) / (h - 30) * 300, px, py }; }
  function rxGridLayout300(cols, rows) { const padX = 24, top = 40, bot = 30; const gw = 300 - padX * 2, gh = 300 - top - bot; const cellW = gw / cols, cellH = gh / rows;
    return { idxAt: (sx, sy) => { if (sx < padX || sx > 300 - padX || sy < top || sy > 300 - bot) return -1; const c = Math.floor((sx - padX) / cellW), rr = Math.floor((sy - top) / cellH); if (c < 0 || c >= cols || rr < 0 || rr >= rows) return -1; return rr * cols + c; } }; }
  function rxPadLayout300(pads) { const marginX = 20, ph = 64, y = 300 - 104, pwFull = (300 - marginX * 2) / pads; return { idxAt: (sx, sy) => { if (sy < y - 6 || sy > y + ph + 6) return -1; let idx = Math.floor((sx - marginX) / pwFull); return Math.max(0, Math.min(pads - 1, idx)); } }; }
  // draw the served answer frame full-bleed into the play area (matches drawFrame's (0,30) origin)
  function _drawServed(g, img, w, h) { g.drawImage(img, 0, 30, w, h - 30); }

  // 1) GO / NO-GO (INHIBITION) — the board lights at once (SERVED frame, answer never in data): tap every GREEN pad, never a red/off-green.
  function pGoNoGo(canvas, st) { const { g, w, h } = fit(canvas); const ev = []; const cols = st.data.cols || 3, rows = st.data.rows || 2, cells = st.data.cells || cols * rows, revealT = st.data.revealT || 1200, dur = st.data.dur || 5000; const needed = st.data.nGo || 1;
    const goName = st.data.goName || 'GREEN', goCol = st.data.goColor || [61, 255, 143], goCss = 'rgb(' + goCol[0] + ',' + goCol[1] + ',' + goCol[2] + ')';   // per-play GO colour (Jake 2026-09-15) — read the legend, do not autopilot
    const L = rxGridLayout300(cols, rows); const cellW = (300 - 48) / cols, cellH = (300 - 70) / rows, R = Math.min(cellW, cellH) * 0.36;
    const cx300 = (i) => 24 + (i % cols) * cellW + cellW / 2, cy300 = (i) => 40 + Math.floor(i / cols) * cellH + cellH / 2;
    // client<->300 mappers for burst placement
    const sx2c = (sx) => sx / 300 * w, sy2c = (sy) => 30 + sy / 300 * (h - 30);
    return new Promise(res => { let raf, t0 = performance.now(), done = false, finishAt = 0, resultTxt = '', boardImg = null, fetching = false; const tapped = new Set();
      function fr() { const t = performance.now() - t0; bg(g, w, h); banner(g, w, 'GO / NO-GO'); _rxTimeBar(g, w, t, dur); const shown = t >= revealT;
        { const ly = 30; g.save(); g.fillStyle = goCss; g.shadowColor = goCss; g.shadowBlur = 8; roundRect(g, w / 2 - 66, ly, 14, 14, 3); g.fill(); g.shadowBlur = 0; g.fillStyle = '#cbd8cf'; g.textAlign = 'left'; g.textBaseline = 'middle'; g.font = "700 12px 'Space Mono',monospace"; g.fillText('GO = ' + goName, w / 2 - 46, ly + 8); g.textBaseline = 'alphabetic'; g.restore(); }
        if (shown && !boardImg && !fetching) { fetching = true; loadImg(FU(st, 0)).then(im => { boardImg = im; }).catch(() => { fetching = false; }); }
        if (!shown || !boardImg) { for (let i = 0; i < cells; i++) { const cx = sx2c(cx300(i)), cy = sy2c(cy300(i)), Rr = R / 300 * w; g.save(); g.fillStyle = 'rgba(60,72,66,.45)'; roundRect(g, cx - Rr, cy - Rr, Rr * 2, Rr * 2, 10); g.fill(); g.restore(); } }
        else { _drawServed(g, boardImg, w, h); for (const i of tapped) { const cx = sx2c(cx300(i)), cy = sy2c(cy300(i)); g.save(); g.fillStyle = 'rgba(4,18,26,.55)'; const Rr = R / 300 * w; roundRect(g, cx - Rr, cy - Rr, Rr * 2, Rr * 2, 10); g.fill(); g.fillStyle = '#eafff3'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = "800 22px 'Chakra Petch',sans-serif"; g.fillText('✓', cx, cy); g.textBaseline = 'alphabetic'; g.restore(); } }
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText(shown ? ('TAP EVERY ' + goName + ' PAD — SKIP THE REST') : ('FIND EVERY ' + goName + ' PAD…'), w / 2, h - 14);
        if (resultTxt) { g.save(); g.fillStyle = resultTxt[0] === 'R' ? RXRED : RXHOT; g.shadowColor = g.fillStyle; g.shadowBlur = 16; g.textAlign = 'center'; g.font = "800 22px 'Chakra Petch',sans-serif"; g.fillText(resultTxt, w / 2, 58); g.restore(); }
        if (finishAt && t >= finishAt && !done) { done = true; cleanup(); res(ev); return; }
        if (t >= dur && !done) { done = true; cleanup(); setTimeout(() => res(ev), 220); return; } if (!done) raf = requestAnimationFrame(fr); }
      function tap(e) { if (done || finishAt) return; const t = Math.round(performance.now() - t0); const s = _c2s(canvas, w, h, e); const idx = L.idxAt(s.sx, s.sy); if (idx < 0) return; if (tapped.has(idx)) return; ev.push({ type: 'tap', t, idx });
        // client can't know green vs red (answer is server-only). Reflect a neutral tap; the SERVER grades. Once nGo distinct taps land, finish.
        tapped.add(idx); try { sfx.lock(); } catch (e2) {} burst(s.px, s.py, RXHOT); if (tapped.size >= needed) { resultTxt = 'LOCKED IN'; finishAt = (performance.now() - t0) + 460; } }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr(); }); }

  // 2) ODD SIGNAL (VISUAL SEARCH) — the glyph FIELD reveals (SERVED frame, answer never in data); find and tap the odd one out.
  function pOddSignal(canvas, st) { const { g, w, h } = fit(canvas); const ev = []; const cols = st.data.cols || 3, rows = st.data.rows || 3, revealT = st.data.revealT || 1200, dur = st.data.dur || 3000;
    const L = rxGridLayout300(cols, rows);
    return new Promise(res => { let raf, t0 = performance.now(), done = false, fieldImg = null, fetching = false;
      function fr() { const t = performance.now() - t0; bg(g, w, h); banner(g, w, 'ODD SIGNAL'); _rxTimeBar(g, w, t, dur); const shown = t >= revealT;
        if (shown && !fieldImg && !fetching) { fetching = true; loadImg(FU(st, 0)).then(im => { fieldImg = im; }).catch(() => { fetching = false; }); }
        if (shown && fieldImg) { _drawServed(g, fieldImg, w, h); } else { g.save(); g.fillStyle = 'rgba(60,72,66,.4)'; g.textAlign = 'center'; g.font = "700 16px 'Space Mono',monospace"; g.fillStyle = '#5a6b60'; g.fillText('WATCH THE FIELD…', w / 2, h / 2); g.restore(); }
        g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText(shown ? 'FIND AND TAP THE ODD ONE OUT' : 'WATCH THE FIELD…', w / 2, h - 14);
        if (t >= dur && !done) { done = true; cleanup(); setTimeout(() => res(ev), 220); return; } if (!done) raf = requestAnimationFrame(fr); }
      function tap(e) { if (done) return; const t = Math.round(performance.now() - t0); const s = _c2s(canvas, w, h, e); const idx = L.idxAt(s.sx, s.sy); if (idx < 0) return; ev.push({ type: 'tap', t, idx }); try { sfx.lock(); } catch (e2) {} burst(s.px, s.py, ACC); done = true; cleanup(); setTimeout(() => res(ev), 260); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr(); }); }

  // 3) TRAPDOOR (TARGET DISCRIMINATION) — a target swatch is shown; a row of coloured pads ARMS at a random instant; tap the pad matching
  //    the target. Tapping a decoy pad, or firing before the arm, fails. DEEP the round repeats (2-stage confirm) with a fresh target.
  const RXPAL = ['#ff5a3c', '#3dff8f', '#7fd0ff', '#ffd24a', '#c874ff'];   // pad colour palette (index -> hex)

  // 4) COLOUR CALL (FINE-SHADE) — a called colour swatch appears; hit the pad whose EXACT shade matches. One decoy pad is a near-match of
  //    the same hue family (subtly different shade) — read the shade, not just the coarse colour.
  // base hue families as RGB triples; a shade in [0..1] darkens (light -> deep) the family colour.

  // 5) TWITCH RELEASE (TRUE-CUE) — hold; the panel throws AMBER fake-out flashes; release only on the TRUE GREEN flip.

  // Shared 4-direction pad (up/right/down/left) for sequence games. onPress(id) called with 0..3.
  // Direction pad (Jake 2026-09-14): geometry is now parametrised (cy / s / half) so the caller can centre it in the space below the HUD and
  // shrink it on short panels. Spacing s>=44 with half=21 keeps the four keys from overlapping each other diagonally (was 52px cells at s=42,
  // which touched at the corners = part of the "crowding"). Each returned cell carries its own `half` so the hit-test matches exactly.
  function _dirPad(g, w, h, onGeom, opts) { opts = opts || {}; const cx = opts.cx != null ? opts.cx : w / 2, cy = opts.cy != null ? opts.cy : h - 118, s = opts.s != null ? opts.s : 50, half = opts.half != null ? opts.half : 21; const cells = [{ id: 0, x: cx, y: cy - s, ch: '↑', half }, { id: 1, x: cx + s, y: cy, ch: '→', half }, { id: 2, x: cx, y: cy + s, ch: '↓', half }, { id: 3, x: cx - s, y: cy, ch: '←', half }]; cells.forEach(c => { g.save(); g.fillStyle = 'rgba(255,210,74,.14)'; roundRect(g, c.x - half, c.y - half, half * 2, half * 2, 9); g.fill(); g.strokeStyle = 'rgba(255,210,74,.4)'; g.lineWidth = 1.5; roundRect(g, c.x - half, c.y - half, half * 2, half * 2, 9); g.stroke(); g.fillStyle = '#ffd9a0'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '700 23px sans-serif'; g.fillText(c.ch, c.x, c.y); g.restore(); }); g.textBaseline = 'alphabetic'; if (onGeom) onGeom(cells); return cells; }
  function _hitDirPad(canvas, w, h, e, cells) { const r = canvas.getBoundingClientRect(); const px = (e.clientX - r.left) * (w / r.width), py = (e.clientY - r.top) * (h / r.height); for (const c of cells) { const hf = (c.half || 24) + 4; if (px >= c.x - hf && px <= c.x + hf && py >= c.y - hf && py <= c.y + hf) return c.id; } return -1; }
  const _ARROW = ['↑', '→', '↓', '←'];

  // 6) SAFE PROCEDURE — a short directional sequence flashes, then input it under a deadline.
  async function pSafeProc(canvas, st) { const { g, w, h } = fit(canvas); const ev = []; try { sfx.reset && sfx.reset(); } catch (e) {} const n = st.data.n || 4; const showMs = st.data.showMs || 1500, deadline = st.data.deadline || 3000, decoys = st.data.decoys || []; const dur = st.data.dur || 5000;
    // ANTI-LEAK (skill-harden 2026-09-14): the arrow procedure is a SERVER PNG served ONCE via the v4frame one-shot transport (answer is
    // NEVER in st.data). Fetch it up front; the flash below draws the image. ROBUSTNESS: if it fails to load, `procImg` stays null and the
    // show phase falls back to a neutral "MEMORISE" prompt — the player still gets the full input phase and can attempt; we NEVER auto-zero.
    let procImg = null; try { procImg = await loadImg(FU(st, 0)); } catch (e) { procImg = null; }
    return new Promise(res => { let raf, t0 = performance.now(), done = false; let cells = []; let flash = { id: -1, t: -1e9 }; const entered = [];
      function fr() { const t = performance.now() - t0; bg(g, w, h); banner(g, w, 'SAFE PROCEDURE'); const showing = t < showMs;
        if (showing) { if (procImg) { drawFrame(g, procImg, w, h); } else { g.fillStyle = RXAMB; g.textAlign = 'center'; g.font = "700 22px 'Space Mono',monospace"; g.fillText('MEMORISE THE PROCEDURE', w / 2, h / 2); }
          // DECOY flashes (draw-only mislead): a stray arrow blips top/bottom for ~220ms, NOT part of the real procedure. Grade ignores these.
          for (const dc of decoys) { if (t >= dc.at && t < dc.at + 220) { const a = 1 - (t - dc.at) / 220; g.save(); g.globalAlpha = 0.5 * a; g.fillStyle = '#ff5a3c'; g.textAlign = 'center'; g.font = "700 30px sans-serif"; g.fillText(_ARROW[dc.id], w * (0.2 + 0.6 * ((dc.at % 100) / 100)), t % 2 ? h * 0.30 : h * 0.70); g.restore(); } }
          g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('MEMORISE THE PROCEDURE (IGNORE RED BLIPS)', w / 2, h - 14); }
        else {
          // CLEAN INPUT HUD (Jake 2026-09-14): compact top header (INPUT count + time bar + n step PIPS that fill as you enter) with the pad
          // CENTRED in the space below it. Removes the big entered-arrow string that overlapped the pad and the taps that "override" it.
          const el = t - showMs, rem = clamp(1 - el / deadline, 0, 1);
          g.fillStyle = RXHOT; g.textAlign = 'center'; g.font = "700 15px 'Space Mono',monospace"; g.fillText('ENTERED ' + ev.length + ' / ' + n, w / 2, 46);
          g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(20, 56, w - 40, 4); g.fillStyle = rem < 0.3 ? RXRED : RXHOT; g.fillRect(20, 56, (w - 40) * rem, 4);
          const pipGap = Math.min(22, (w - 60) / Math.max(1, n)), pipW = (n - 1) * pipGap, px0 = w / 2 - pipW / 2, pipY = 76;
          for (let i = 0; i < n; i++) { const on = i < ev.length; g.save(); g.beginPath(); g.arc(px0 + i * pipGap, pipY, 6, 0, TAU); if (on) { g.fillStyle = RXHOT; g.shadowColor = RXHOT; g.shadowBlur = 10; g.fill(); } else { g.fillStyle = 'rgba(255,255,255,.10)'; g.fill(); g.strokeStyle = 'rgba(255,210,74,.4)'; g.lineWidth = 1.5; g.stroke(); } g.restore(); }
          const padTop = 94, padBot = h - 30, padCy = (padTop + padBot) / 2, padS = clamp((padBot - padTop) / 2 - 24, 44, 54);
          cells = _dirPad(g, w, h, null, { cy: padCy, s: padS });
          for (const c of cells) { if (c.id === flash.id && t - flash.t < 260) { const a = 1 - (t - flash.t) / 260, hf = c.half || 21; g.save(); g.globalAlpha = 0.35 + 0.5 * a; g.fillStyle = RXHOT; g.shadowColor = RXHOT; g.shadowBlur = 20; roundRect(g, c.x - hf, c.y - hf, hf * 2, hf * 2, 9); g.fill(); g.restore(); } }
          g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('PUNCH IT BACK IN ORDER', w / 2, h - 12);
          if (el >= deadline && !done) { done = true; cleanup(); setTimeout(() => res(ev), 200); return; }
        }
        if (t >= dur && !done) { done = true; cleanup(); setTimeout(() => res(ev), 200); return; } if (!done) raf = requestAnimationFrame(fr); }
      function tap(e) { if (done) return; const t = performance.now() - t0; if (t < showMs) return; const id = _hitDirPad(canvas, w, h, e, cells); if (id < 0) return; ev.push({ type: 'press', id, t: Math.round(t) }); flash = { id, t }; entered.push(id); const cc = cells.find(c => c.id === id); if (cc) burst(cc.x, cc.y, RXHOT); try { sfx.click(); } catch (e2) {} if (ev.length >= n) { done = true; cleanup(); setTimeout(() => res(ev), 220); } }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr(); }); }

  // 7) LOCK ORDER — the arm-order flashes ONCE (server PNG), then hit the locks in that remembered order.
  // ANTI-LEAK + ROBUST redesign (skill-harden 2026-09-14): the answer `order` is NEVER in st.data. The full order flashes as a SERVER PNG
  // served ONCE via the v4frame one-shot transport (each lock stamped with its 1..n step badge). The player memorises it, then taps the k
  // locks in that order. This replaces the fragile reactive per-step stream that once returned empty and bricked the game. ROBUSTNESS: if the
  // flash frame fails to load, we still run the full input phase (player attempts from memory / degraded) — we NEVER auto-zero.
  async function pLockOrder(canvas, st) { const { g, w, h } = fit(canvas); const ev = []; const k = st.data.k || 5, n = st.data.n || 3, showMs = st.data.showMs || 1800, dur = st.data.dur || 6000;
    let ordImg = null; try { ordImg = await loadImg(FU(st, 0)); } catch (e) { ordImg = null; }
    return new Promise(res => { let raf, t0 = performance.now(), done = false; const y = h / 2 + 6, gap = Math.min((w - 40) / k, 84), x0 = (w - gap * (k - 1)) / 2; let flash = { id: -1, t: -1e9 }; const tapped = [];
      function fr() { const t = performance.now() - t0; bg(g, w, h); banner(g, w, 'LOCK ORDER'); const showing = t < showMs;
        if (showing) { if (ordImg) { drawFrame(g, ordImg, w, h); } else { g.fillStyle = RXAMB; g.textAlign = 'center'; g.font = "700 20px 'Space Mono',monospace"; g.fillText('MEMORISE THE ORDER', w / 2, h / 2); }
          const rem = clamp(1 - t / showMs, 0, 1); g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(20, 40, w - 40, 4); g.fillStyle = RXAMB; g.fillRect(20, 40, (w - 40) * rem, 4);
          g.fillStyle = '#8a9a8f'; g.textAlign = 'center'; g.font = "12px 'Space Mono',monospace"; g.fillText('REMEMBER THE NUMBERED ORDER', w / 2, h - 14); }
        else { const keep = st.data.keepShown && ordImg;
          if (keep) drawFrame(g, ordImg, w, h);   // SHALLOW on-ramp (Jake 2026-09-16): keep the numbered order visible during input so the player just taps 1,2,3 in order. Deep chambers stay hidden (memorise).
          for (let i = 0; i < k; i++) { const X = x0 + i * gap; const lit = i === flash.id && t - flash.t < 260;
            if (keep) { if (lit) { g.save(); g.strokeStyle = RXHOT; g.lineWidth = 4; g.shadowColor = RXHOT; g.shadowBlur = 20; g.beginPath(); g.arc(X, y, 30, 0, TAU); g.stroke(); g.restore(); } }
            else { g.save(); if (lit) { g.fillStyle = RXHOT; g.shadowColor = RXHOT; g.shadowBlur = 22; } else { g.fillStyle = RXCOLD; } g.beginPath(); g.arc(X, y, 26, 0, TAU); g.fill(); g.restore(); } }
          g.fillStyle = RXHOT; g.textAlign = 'center'; g.font = "700 14px 'Space Mono',monospace"; g.fillText('ENTERED ' + tapped.length + ' / ' + n, w / 2, 56);
          g.fillStyle = '#8a9a8f'; g.font = "12px 'Space Mono',monospace"; g.fillText(keep ? 'TAP THE LOCKS IN NUMBER ORDER' : 'HIT THE LOCKS IN THE ORDER YOU SAW', w / 2, h - 14); }
        if ((tapped.length >= n || t >= dur) && !done) { done = true; cleanup(); setTimeout(() => res(ev), 220); return; } if (!done) raf = requestAnimationFrame(fr); }
      function tap(e) { if (done) return; const t = Math.round(performance.now() - t0); if (t < showMs) return; if (tapped.length >= n) return; const r = canvas.getBoundingClientRect(), px = (e.clientX - r.left) * (w / r.width), py = (e.clientY - r.top) * (h / r.height); let idx = Math.round((px - x0) / gap); idx = Math.max(0, Math.min(k - 1, idx));
        if (Math.abs(px - (x0 + idx * gap)) > gap * 0.5 || Math.abs(py - y) > 48) return;   // Jake 2026-09-15: only register a tap that lands ON a lock (within half-gap of a centre + near the row) so a stray/mis-aimed tap never burns an order slot with the wrong lock id
        // Emit EVERY tap in order (client no longer knows `order`, so it can't self-validate). The SERVER grades the positional prefix; the
        // exact-count gate means we cap at n taps. flash the tapped lock so the player sees their input register.
        ev.push({ type: 'press', id: idx, t }); tapped.push(idx); flash = { id: idx, t: performance.now() - t0 }; try { sfx.lock(); } catch (e2) {} burst(x0 + idx * gap, y, RXHOT);
        if (tapped.length >= n) { done = true; cleanup(); setTimeout(() => res(ev), 260); } }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr(); }); }

  // 8) COUNTER-ROTATE — alternate LEFT/RIGHT taps as the cadence rises.
  function pCounterRot(canvas, st) { const { g, w, h } = fit(canvas); const ev = []; const target = st.data.target || 14, startSide = st.data.startSide | 0, dur = st.data.dur || 12000, wrongPen = st.data.wrongPen || 2;
    return new Promise(res => { let raf, t0 = performance.now(), done = false, streak = 0, side = startSide;
      function fr() { const t = performance.now() - t0; bg(g, w, h); banner(g, w, 'COUNTER-ROTATE'); _rxTimeBar(g, w, t, dur);
        const cy = h / 2 + 6; [0, 1].forEach(s => { const X = s === 0 ? w * 0.28 : w * 0.72; const nextSide = side; g.save(); g.fillStyle = s === nextSide ? RXHOT : RXCOLD; if (s === nextSide) { g.shadowColor = RXHOT; g.shadowBlur = 18; } g.beginPath(); g.arc(X, cy, 40, 0, TAU); g.fill(); g.restore(); g.fillStyle = '#04121a'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = '700 26px sans-serif'; g.fillText(s === 0 ? '←' : '→', X, cy); g.textBaseline = 'alphabetic'; });
        g.fillStyle = streak > 0 ? RXHOT : '#8a9a8f'; g.textAlign = 'center'; g.font = "700 26px 'Space Mono',monospace"; g.fillText(streak + '/' + target, w / 2, 62);
        g.fillStyle = '#8a9a8f'; g.font = "12px 'Space Mono',monospace"; g.fillText('ALTERNATE IN ORDER — ONE WRONG TAP RESETS TO ZERO', w / 2, h - 14);
        if ((streak >= target || t >= dur) && !done) { done = true; cleanup(); setTimeout(() => res(ev), 220); return; } if (!done) raf = requestAnimationFrame(fr); }
      let lastTap = -1e9;
      // Jake 2026-09-14: mirror the SERVER penalty grade — a wrong side (incl. a double-tap on the same pad, since it alternates) and an
      // over-click deduct instead of resetting, so the on-screen count tracks the real score and mistakes visibly cost you (harder + honest).
      function tap(e) { if (done) return; const t = Math.round(performance.now() - t0); const r = canvas.getBoundingClientRect(), px = (e.clientX - r.left) * (w / r.width); const id = px < w / 2 ? 0 : 1; ev.push({ type: 'press', id, t }); const dtp = t - lastTap; lastTap = t;
        if (id !== side) { streak = 0; side = startSide; try { sfx.bust(); } catch (e2) {} shake(canvas, 8); return; }   // wrong side -> RESET to zero (Jake 2026-09-15), matches server
        if (streak > 0 && dtp < 110) { streak = 0; side = startSide; try { sfx.bust(); } catch (e2) {} shake(canvas, 6); return; }   // spam -> reset to zero
        streak++; side = 1 - side; try { sfx.lock(); } catch (e2) {} burst(id === 0 ? w * 0.28 : w * 0.72, h / 2 + 6, RXHOT); }
      function cleanup() { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', tap); }
      canvas.addEventListener('pointerdown', tap); fr(); }); }

  // 9) REPEAT COMBO — an icon combo flashes; repeat it fast.

  // 10) OVERRIDE GRID — flip switches to match the target pattern in few moves under time.

  // 11) POWER METER — hold to charge to the target value, release.

  // 12) RECOIL CONTROL — value decays; tap to push it up; keep it in band.

  // 13) ANGLE LAUNCH — set an angle, then a power (two commits); land in the zone.

  // 14) PRESSURE VALVE — pressure rises; tap to vent; keep the needle in a MOVING band.

  // 15) RICOCHET — one drag-to-aim, release; bank the shot off the wall into the target.

  // SKILL V4 registrations (Jake 2026-09-12)
  P.gonogo = pGoNoGo; P.oddsignal = pOddSignal;
  P.safeproc = pSafeProc; P.lockorder = pLockOrder; P.counterrot = pCounterRot;

  window.RTV_SKILL_REMOTE = { run, playInto, start, grade, countdown, howto, directions, games: Object.keys(P) };
})();
