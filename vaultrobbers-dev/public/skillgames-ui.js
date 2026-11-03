/* Vault Robbers — SKILL ENGINE v4 CLIENT (renderers + input capture). Detached; drives the seed-not-answer games.
 *
 * Contract: window.RTV_SKILL.play(canvas, spec) -> Promise<{events, localScore}>
 *   spec = { gameKey, data, reveal, accent } where:
 *     data   = the answer-free render params from /api/mini/start (counts, dims, timings)
 *     reveal = the perceived content. IN PRODUCTION this is decoded from server-rendered image frames
 *              (a JSON/step bot never gets it as data). IN THE DEV HARNESS it is passed directly so the
 *              renderers/UX can be verified. The renderer treats it as "what the human sees on screen".
 *   Renderers emit input EVENTS only; the SERVER grades them. localScore is for the dev harness display.
 */
(function () {
  'use strict';
  const TAU = Math.PI * 2, clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const SHAPES = ['circle', 'square', 'triangle', 'diamond', 'star', 'hex', 'cross', 'ring', 'wedge', 'bolt'];

  function fit(canvas) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 360, h = canvas.clientHeight || 360;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }
  function drawShape(g, kind, x, y, r, fill, stroke) {
    g.save(); g.translate(x, y); g.beginPath();
    if (kind === 'circle' || kind === 'ring') g.arc(0, 0, r, 0, TAU);
    else if (kind === 'square') g.rect(-r, -r, r * 2, r * 2);
    else if (kind === 'triangle') { g.moveTo(0, -r); g.lineTo(r, r); g.lineTo(-r, r); g.closePath(); }
    else if (kind === 'diamond') { g.moveTo(0, -r); g.lineTo(r, 0); g.lineTo(0, r); g.lineTo(-r, 0); g.closePath(); }
    else if (kind === 'hex') { for (let i = 0; i < 6; i++) { const a = i / 6 * TAU - Math.PI / 2; g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); }
    else if (kind === 'cross') { const t = r * 0.42; g.rect(-t, -r, t * 2, r * 2); g.rect(-r, -t, r * 2, t * 2); }
    else if (kind === 'wedge') { g.moveTo(0, 0); g.arc(0, 0, r, -0.5, 1.6); g.closePath(); }
    else if (kind === 'bolt') { g.moveTo(-r * 0.3, -r); g.lineTo(r * 0.5, -r * 0.1); g.lineTo(0, 0); g.lineTo(r * 0.3, r); g.lineTo(-r * 0.5, r * 0.1); g.lineTo(0, 0); g.closePath(); }
    else { for (let i = 0; i < 10; i++) { const a = i / 10 * TAU - Math.PI / 2, rr = i % 2 ? r * 0.45 : r; g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rr, Math.sin(a) * rr); } g.closePath(); }
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.lineWidth = 2; g.strokeStyle = stroke; g.stroke(); }
    if (kind === 'ring') { g.beginPath(); g.arc(0, 0, r * 0.5, 0, TAU); g.fillStyle = '#0b1410'; g.fill(); }
    g.restore();
  }
  function bg(g, w, h, accent) {
    g.clearRect(0, 0, w, h); g.fillStyle = '#0a1410'; g.fillRect(0, 0, w, h);
    g.save(); g.globalAlpha = 0.08; g.strokeStyle = accent; g.lineWidth = 1;
    for (let x = 0; x < w; x += 26) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y < h; y += 26) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    g.restore();
  }
  function banner(g, w, txt, accent) {
    g.save(); g.textAlign = 'center'; g.fillStyle = accent; g.font = "700 15px 'Chakra Petch',sans-serif";
    g.fillText(txt, w / 2, 26); g.restore();
  }

  // ── ODD-ONE-OUT (perception). reveal={odd:[idx per round], salience}. Emits {type:'pick',idx} per round.
  async function oddone(canvas, spec) {
    const { g, w, h } = fit(canvas); const acc = spec.accent || '#3dff8f';
    const { rounds, tiles, salience } = spec.data; const events = []; let score = 0;
    const cols = Math.ceil(Math.sqrt(tiles)), rows = Math.ceil(tiles / cols);
    const pad = 16, gw = w - pad * 2, gh = h - 54, cw = gw / cols, chh = gh / rows;
    for (let r = 0; r < rounds; r++) {
      const odd = spec.reveal.odd[r];
      const baseHue = 150, baseL = 46, offL = baseL + (10 + salience * 30);  // odd tile brighter by `salience`
      await new Promise(resolve => {
        function render(hi) {
          bg(g, w, h, acc); banner(g, w, 'FIND THE ODD TILE  ·  ' + (r + 1) + '/' + rounds, acc);
          for (let i = 0; i < tiles; i++) {
            const cx = pad + (i % cols) * cw + cw / 2, cy = 44 + Math.floor(i / cols) * chh + chh / 2;
            const rad = Math.min(cw, chh) * 0.36;
            const L = (i === odd) ? offL : baseL;
            drawShape(g, 'square', cx, cy, rad, `hsl(${baseHue} 45% ${L}%)`, hi === i ? '#fff' : 'rgba(0,0,0,.3)');
          }
        }
        render(-1);
        function hit(ev) {
          const rect = canvas.getBoundingClientRect(); const px = (ev.clientX - rect.left), py = (ev.clientY - rect.top);
          const col = Math.floor((px - pad) / cw), row = Math.floor((py - 44) / chh); const idx = row * cols + col;
          if (idx < 0 || idx >= tiles || col < 0 || col >= cols) return;
          events.push({ type: 'pick', idx }); if (idx === odd) score++;
          render(idx); canvas.removeEventListener('pointerdown', hit); setTimeout(resolve, 140);
        }
        canvas.addEventListener('pointerdown', hit);
      });
    }
    return { events, localScore: score / rounds };
  }

  // ── SPATIAL RECALL (memory). reveal={cells:[grid idx in order]}. Flash the path, then player taps cells in order.
  async function spatial(canvas, spec) {
    const { g, w, h } = fit(canvas); const acc = spec.accent || '#3dff8f';
    const { grid, count, flashMs } = spec.data; const side = Math.sqrt(grid) | 0;
    const pad = 20, gw = Math.min(w, h - 54) - pad * 2, cell = gw / side, ox = (w - gw) / 2, oy = 48;
    const cellRect = (i) => ({ x: ox + (i % side) * cell, y: oy + Math.floor(i / side) * cell });
    function grid_(lit) {
      bg(g, w, h, acc); banner(g, w, lit >= 0 ? 'WATCH' : 'REPEAT THE PATH', acc);
      for (let i = 0; i < grid; i++) { const c = cellRect(i); g.fillStyle = (i === lit) ? acc : 'rgba(61,255,143,.10)'; g.fillRect(c.x + 3, c.y + 3, cell - 6, cell - 6); g.strokeStyle = 'rgba(61,255,143,.25)'; g.strokeRect(c.x + 3, c.y + 3, cell - 6, cell - 6); }
    }
    grid_(-1); await wait(500);
    for (const cidx of spec.reveal.cells) { grid_(cidx); await wait(flashMs); grid_(-1); await wait(140); }
    const events = []; let ok = 0;
    for (let n = 0; n < count; n++) {
      await new Promise(resolve => {
        function hit(ev) {
          const rect = canvas.getBoundingClientRect(); const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
          const col = Math.floor((px - ox) / cell), row = Math.floor((py - oy) / cell); const idx = row * side + col;
          if (col < 0 || col >= side || row < 0 || idx >= grid) return;
          events.push({ type: 'pick', cell: idx }); if (idx === spec.reveal.cells[n]) ok++;
          const c = cellRect(idx); g.fillStyle = acc; g.fillRect(c.x + 3, c.y + 3, cell - 6, cell - 6);
          canvas.removeEventListener('pointerdown', hit); setTimeout(resolve, 110);
        }
        canvas.addEventListener('pointerdown', hit);
      });
    }
    return { events, localScore: ok / count };
  }

  // ── MENTAL COMBO (compute). reveal={nums:[...]}. Flash numbers + rule, then a keypad to enter the answer.
  async function combo(canvas, spec) {
    const { g, w, h } = fit(canvas); const acc = spec.accent || '#3dff8f';
    const { count, rule, flashMs } = spec.data; const nums = spec.reveal.nums;
    const RULE = { sum: 'ADD THEM ALL', max: 'LARGEST', min: 'SMALLEST', sumEven: 'ADD THE EVENS', sumOdd: 'ADD THE ODDS' }[rule] || 'ADD THEM ALL';
    bg(g, w, h, acc); banner(g, w, 'MEMORISE', acc);
    g.save(); g.textAlign = 'center'; g.fillStyle = acc; g.font = "700 14px 'Chakra Petch',sans-serif"; g.fillText(RULE, w / 2, h - 20);
    g.fillStyle = '#eafff3'; g.font = "800 40px 'Space Mono',monospace";
    for (let i = 0; i < nums.length; i++) g.fillText(String(nums[i]), w / 2 - (nums.length - 1) * 26 + i * 52, h / 2);
    g.restore(); await wait(flashMs + count * 120);
    // keypad
    let entry = '';
    return await new Promise(resolve => {
      const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'];
      function draw() {
        bg(g, w, h, acc); banner(g, w, RULE + '  =  ?', acc);
        g.save(); g.textAlign = 'center'; g.fillStyle = '#eafff3'; g.font = "800 34px 'Space Mono',monospace"; g.fillText(entry || '_', w / 2, 78);
        const kw = (w - 40) / 3, kh = (h - 100) / 4;
        keys.forEach((k, i) => { const x = 20 + (i % 3) * kw, y = 92 + Math.floor(i / 3) * kh; g.fillStyle = 'rgba(61,255,143,.08)'; g.fillRect(x + 3, y + 3, kw - 6, kh - 6); g.strokeStyle = 'rgba(61,255,143,.3)'; g.strokeRect(x + 3, y + 3, kw - 6, kh - 6); g.fillStyle = k === 'OK' ? acc : '#cdead9'; g.font = "700 20px 'Chakra Petch',sans-serif"; g.fillText(k, x + kw / 2, y + kh / 2 + 7); });
        g.restore();
      }
      draw();
      canvas.addEventListener('pointerdown', function hit(ev) {
        const rect = canvas.getBoundingClientRect(); const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
        const kw = (w - 40) / 3, kh = (h - 100) / 4; const col = Math.floor((px - 20) / kw), row = Math.floor((py - 92) / kh); const i = row * 3 + col;
        if (i < 0 || i >= keys.length || col < 0 || col > 2) return; const k = keys[i];
        if (k === 'C') entry = ''; else if (k === 'OK') { canvas.removeEventListener('pointerdown', hit); const val = parseInt(entry || '-1', 10); resolve({ events: [{ type: 'answer', value: val }], localScore: null }); return; }
        else if (entry.length < 3) entry += k;
        draw();
      });
    });
  }

  // UNIFIED ENGINE (Jake 2026-09-14): route through index.html's ONE premium AudioContext+master so this legacy shell obeys the
  // single mute/volume control and shares the heist palette. The old local raw-sine oscillator (own _ac, ignored volume entirely)
  // survives only as a standalone fallback when index's engine is absent.
  let _ac; function beep(f){ try{ if (window.RTV_BEEP) { window.RTV_BEEP(f || 440, true); return; } }catch(e){}
    try{ _ac = _ac || new (window.AudioContext || window.webkitAudioContext)(); const o = _ac.createOscillator(), gg = _ac.createGain(); o.frequency.value = f || 440; gg.gain.value = 0.0001; gg.gain.linearRampToValueAtTime(0.16, _ac.currentTime + 0.01); gg.gain.exponentialRampToValueAtTime(0.0001, _ac.currentTime + 0.14); o.connect(gg); gg.connect(_ac.destination); o.start(); o.stop(_ac.currentTime + 0.16); } catch (e) {} }

  // ── LINEUP (memory): flash a sequence of shapes, then tap them back in order from the shape tray.
  async function lineup(canvas, spec) {
    const { g, w, h } = fit(canvas); const acc = spec.accent || '#3dff8f';
    const { count, palette, flashMs } = spec.data; const seq = spec.reveal.seq; const events = []; let ok = 0;
    for (let i = 0; i < seq.length; i++) { bg(g, w, h, acc); banner(g, w, 'MEMORISE  ' + (i + 1) + '/' + count, acc); drawShape(g, SHAPES[seq[i]] || SHAPES[0], w / 2, h / 2 + 8, Math.min(w, h) * 0.2, acc, '#eafff3'); await wait(flashMs); bg(g, w, h, acc); banner(g, w, 'MEMORISE', acc); await wait(150); }
    const cols = 5, rows = Math.ceil(palette / cols), pad = 14, tw = (w - pad * 2) / cols, thh = (h - 66) / rows;
    function tray(hl, prog) { bg(g, w, h, acc); banner(g, w, 'REPEAT THE ORDER  ' + prog + '/' + count, acc); for (let i = 0; i < palette; i++) { const cx = pad + (i % cols) * tw + tw / 2, cy = 54 + Math.floor(i / cols) * thh + thh / 2; drawShape(g, SHAPES[i], cx, cy, Math.min(tw, thh) * 0.3, i === hl ? acc : 'rgba(61,255,143,.12)', 'rgba(61,255,143,.4)'); } }
    for (let n = 0; n < count; n++) { tray(-1, n); await new Promise(res => { function hit(ev) { const rect = canvas.getBoundingClientRect(); const px = ev.clientX - rect.left, py = ev.clientY - rect.top; const col = Math.floor((px - pad) / tw), row = Math.floor((py - 54) / thh); const idx = row * cols + col; if (col < 0 || col >= cols || idx < 0 || idx >= palette) return; events.push({ type: 'pick', idx }); if (idx === seq[n]) ok++; tray(idx, n + 1); canvas.removeEventListener('pointerdown', hit); setTimeout(res, 110); } canvas.addEventListener('pointerdown', hit); }); }
    return { events, localScore: ok / count };
  }

  // ── SHADE (perception): match a slider to the TARGET swatch's lightness. Target is pixels-only in prod.
  async function shade(canvas, spec) {
    const { g, w, h } = fit(canvas); const acc = spec.accent || '#3dff8f'; const { rounds, tol } = spec.data; const events = []; let s = 0;
    for (let r = 0; r < rounds; r++) { const target = spec.reveal.targets[r]; let v = 0.5;
      await new Promise(res => {
        function draw() { bg(g, w, h, acc); banner(g, w, 'MATCH THE SHADE  ' + (r + 1) + '/' + rounds, acc);
          g.textAlign = 'center'; g.fillStyle = '#7fae93'; g.font = "600 11px 'Chakra Petch',sans-serif"; g.fillText('TARGET', w / 2, 46);
          g.fillStyle = 'hsl(150 45% ' + Math.round(20 + target * 60) + '%)'; g.fillRect(w / 2 - 62, 52, 124, 64); g.strokeStyle = '#eafff3'; g.strokeRect(w / 2 - 62, 52, 124, 64);
          g.fillStyle = '#7fae93'; g.fillText('YOURS', w / 2, 138); g.fillStyle = 'hsl(150 45% ' + Math.round(20 + v * 60) + '%)'; g.fillRect(w / 2 - 62, 144, 124, 64); g.strokeStyle = 'rgba(61,255,143,.5)'; g.strokeRect(w / 2 - 62, 144, 124, 64);
          const bx = 28, bw = w - 56, by = h - 74; const grad = g.createLinearGradient(bx, 0, bx + bw, 0); grad.addColorStop(0, 'hsl(150 45% 20%)'); grad.addColorStop(1, 'hsl(150 45% 80%)'); g.fillStyle = grad; g.fillRect(bx, by, bw, 16); g.fillStyle = '#fff'; g.fillRect(bx + v * bw - 3, by - 6, 6, 28);
          g.fillStyle = acc; g.fillRect(w / 2 - 52, h - 36, 104, 27); g.fillStyle = '#02140b'; g.font = "700 13px 'Chakra Petch',sans-serif"; g.fillText('MATCH', w / 2, h - 17); }
        draw();
        function setV(px) { const bx = 28, bw = w - 56; v = clamp((px - bx) / bw, 0, 1); draw(); }
        function down(ev) { const rect = canvas.getBoundingClientRect(); const px = ev.clientX - rect.left, py = ev.clientY - rect.top; if (py > h - 40 && Math.abs(px - w / 2) < 54) { const err = Math.abs(v - target); if (err <= tol) s += clamp(1 - err / tol, 0, 1); events.push({ type: 'match', v }); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', mv); setTimeout(res, 120); return; } if (py > h - 96) setV(px); }
        const mv = (ev) => { if (ev.buttons) { const rect = canvas.getBoundingClientRect(); setV(ev.clientX - rect.left); } };
        canvas.addEventListener('pointermove', mv); canvas.addEventListener('pointerdown', down);
      });
    }
    return { events, localScore: s / rounds };
  }

  // ── DIAL (timing): a line sweeps the ring; tap when it crosses the glowing arc. Emits the tap TIME; the
  //    server derives the locked angle (client can't spoof it, and the arc is pixels-only in prod).
  async function dial(canvas, spec) {
    const { g, w, h } = fit(canvas); const acc = spec.accent || '#3dff8f';
    const { stops, speed, arcW, start } = spec.data; const targets = spec.reveal.targets; const events = [];
    const cx = w / 2, cy = h / 2 + 10, R = Math.min(w, h) * 0.33; let stop = 0; const t0 = performance.now();
    return await new Promise(resolve => {
      let raf; function frame() { const t = (performance.now() - t0) / 1000, a = (start + speed * t) % TAU;
        bg(g, w, h, acc); banner(g, w, 'LOCK THE DIAL  ' + stop + '/' + stops, acc);
        g.strokeStyle = 'rgba(61,255,143,.22)'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.stroke();
        const tg = targets[stop]; g.strokeStyle = acc; g.lineWidth = 7; g.beginPath(); g.arc(cx, cy, R, tg - arcW, tg + arcW); g.stroke();
        g.strokeStyle = '#fff'; g.lineWidth = 3; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke();
        g.fillStyle = acc; g.beginPath(); g.arc(cx, cy, 5, 0, TAU); g.fill();
        g.textAlign = 'center'; g.fillStyle = '#7fae93'; g.font = "600 12px 'Chakra Petch',sans-serif"; g.fillText('TAP when the line hits the arc', cx, h - 14);
        raf = requestAnimationFrame(frame); }
      frame();
      function hit() { const t = (performance.now() - t0) / 1000; events.push({ type: 'lock', t: Math.round(t * 1000) }); try { beep(660); } catch (e) {} stop++;
        if (stop >= stops) { cancelAnimationFrame(raf); canvas.removeEventListener('pointerdown', hit); let sc = 0; for (let i = 0; i < stops; i++) { const a = (start + speed * (events[i].t / 1000)) % TAU; let err = Math.abs(((a - targets[i] + Math.PI * 3) % TAU) - Math.PI); sc += clamp(1 - err / (arcW * 2.2), 0, 1); } resolve({ events, localScore: sc / stops }); } }
      canvas.addEventListener('pointerdown', hit);
    });
  }

  // ── RHYTHM: a beat pattern plays (pulse + tone); reproduce it by tapping. Graded on relative intervals.
  async function rhythm(canvas, spec) {
    const { g, w, h } = fit(canvas); const acc = spec.accent || '#3dff8f'; const { beats, tol } = spec.data; const iv = spec.reveal.iv;
    const pulse = (on, label) => { bg(g, w, h, acc); banner(g, w, label, acc); g.fillStyle = on ? acc : 'rgba(61,255,143,.15)'; g.beginPath(); g.arc(w / 2, h / 2, on ? 74 : 52, 0, TAU); g.fill(); };
    pulse(false, 'LISTEN'); await wait(500); pulse(true, 'LISTEN'); beep(520); await wait(120); pulse(false, 'LISTEN');
    for (const gap of iv) { await wait(Math.max(60, gap - 120)); pulse(true, 'LISTEN'); beep(520); await wait(120); pulse(false, 'LISTEN'); }
    await wait(350); const taps = []; const events = []; const t0 = performance.now(); pulse(false, 'NOW TAP IT  ·  ' + beats + ' beats');
    return await new Promise(resolve => {
      function hit() { const t = performance.now() - t0; taps.push(t); events.push({ type: 'beat', t }); beep(700); pulse(true, 'TAP  ' + taps.length + '/' + beats);
        if (taps.length >= beats) { canvas.removeEventListener('pointerdown', hit); const piv = []; for (let i = 1; i < taps.length; i++) piv.push(taps[i] - taps[i - 1]); const norm = a => { const s = a.reduce((x, y) => x + y, 0) || 1; return a.map(x => x / s); }; const P = norm(piv), S = norm(iv); let e = 0; for (let i = 0; i < S.length; i++) e += Math.abs(P[i] - (S[i] || 0)); resolve({ events, localScore: clamp(1 - (e / (S.length || 1)) / (tol || 0.15), 0, 1) }); }
        else setTimeout(() => pulse(false, 'TAP  ' + taps.length + '/' + beats), 90); }
      canvas.addEventListener('pointerdown', hit);
    });
  }

  const RENDER = { oddone, spatial, combo, lineup, shade, dial, rhythm };
  window.RTV_SKILL = {
    play(canvas, spec) { const fn = RENDER[spec.gameKey]; if (!fn) return Promise.reject(new Error('no renderer: ' + spec.gameKey)); return fn(canvas, spec); },
    games: Object.keys(RENDER), SHAPES
  };
})();
