/* Vault Robbers V2 — Casino rooms (client). Self-contained: window.RTV_CASINO.open({player, wager, onSettle}).
   Talks ONLY to the server's provably-fair /api/casino/* routes (relative paths). RVLT is the base token. The server decides
   every outcome; this file is presentation + juice. Aesthetic: dark vault, emerald neon + gold, matches the main game. */
(function () {
  'use strict';
  const API = 'api/casino';
  const $ = (s, r) => (r || document).querySelector(s);
  const el = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const post = (u, b) => fetch(API + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.assign(STATE.runId ? { runId: STATE.runId } : {}, b || {})) }).then(r => r.json());   // auto-attach the owning run so bets fold into the cash-out
  const get = (u) => fetch(API + u).then(r => r.json());
  let CFG = null, STATE = { player: 'anon', wager: 100, net: 0, onSettle: null, runId: '' };

  // ---- one-time styles ----
  function injectCss() {
    if ($('#rcv-css')) return;
    const s = el('style'); s.id = 'rcv-css';
    s.textContent = `
    #rcvWrap{position:fixed;inset:0;z-index:9000;display:none;align-items:center;justify-content:center;background:radial-gradient(120% 120% at 50% 0%,rgba(10,20,16,.86),rgba(3,6,8,.96));backdrop-filter:blur(6px);font-family:'Chakra Petch',system-ui,sans-serif}
    #rcvWrap.on{display:flex}
    .rcv-panel{width:min(680px,94vw);max-height:92vh;overflow:auto;background:linear-gradient(180deg,#0b1418,#070d10);border:1px solid rgba(61,255,143,.28);border-radius:16px;box-shadow:0 30px 80px rgba(2,6,10,.6),0 0 0 1px rgba(0,0,0,.4);padding:18px 18px 22px}
    .rcv-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
    .rcv-title{font-family:'Cinzel',Georgia,serif;font-weight:900;color:#e8c66a;font-size:20px;letter-spacing:.02em}
    .rcv-x{cursor:pointer;color:#a9c4b6;background:none;border:1px solid rgba(169,196,182,.22);border-radius:10px;padding:8px 13px;font-size:14px}
    .rcv-x:hover{color:#fff;border-color:rgba(255,255,255,.3)}
    .rcv-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
    .rcv-tab{flex:1;min-width:72px;text-align:center;cursor:pointer;padding:10px 8px;border-radius:10px;border:1px solid rgba(61,255,143,.14);color:#a9c4b6;font-size:12.5px;letter-spacing:.04em;text-transform:uppercase;background:rgba(255,255,255,.02);transition:.15s}
    .rcv-tab.on{color:#02140b;background:linear-gradient(180deg,#3dff8f,#1c8a52);border-color:transparent;font-weight:700}
    .rcv-wager{display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap}
    .rcv-wager label{color:#7fae93;font-size:12px;letter-spacing:.02em}
    .rcv-wager input{width:120px;background:#05090b;border:1px solid rgba(61,255,143,.3);border-radius:10px;color:#eafff3;padding:9px 10px;font-family:inherit;font-size:15px}
    .rcv-chip{cursor:pointer;color:#cdead9;background:rgba(61,255,143,.08);border:1px solid rgba(61,255,143,.25);border-radius:8px;padding:9px 12px;font-size:12px}
    .rcv-chip:hover{background:rgba(61,255,143,.16)}
    .rcv-stage{min-height:240px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#05090b;border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:16px;position:relative;overflow:hidden}
    .rcv-btn{cursor:pointer;border:none;border-radius:12px;padding:14px 28px;font-family:'Chakra Petch',sans-serif;font-weight:700;font-size:15px;letter-spacing:.03em;color:#02140b;background:linear-gradient(180deg,#3dff8f,#1c8a52);box-shadow:0 8px 24px rgba(61,255,143,.28)}
    .rcv-btn:disabled{opacity:.45;cursor:default;box-shadow:none}
    .rcv-btn.cash{background:linear-gradient(180deg,#e8c66a,#b5872f);color:#1a1206;box-shadow:0 8px 24px rgba(232,198,106,.3)}
    .rcv-btn.danger{background:linear-gradient(180deg,#ff7a86,#ff4d5e);color:#1a0605}
    .rcv-res{font-family:'Cinzel',serif;font-size:22px;font-weight:900;min-height:26px;text-align:center}
    .rcv-win{color:#7dffb2}.rcv-lose{color:#ff7a86}
    .rcv-sub{color:#7fae93;font-size:11.5px;text-align:center;line-height:1.5}
    .rcv-fair{color:#9fb4ab;font-size:11px;word-break:break-all;text-align:center;margin-top:8px}
    .rcv-fair a{color:#3dff8f;cursor:pointer}
    /* dice */
    .rcv-track{position:relative;width:100%;height:16px;border-radius:9px;background:linear-gradient(90deg,#ff4d5e 0 var(--t,50%),#3dff8f var(--t,50%) 100%);margin:8px 0}
    .rcv-marker{position:absolute;top:-7px;width:4px;height:30px;background:#fff;border-radius:3px;left:0;transition:left .35s cubic-bezier(.2,.8,.2,1);box-shadow:0 0 10px #fff}
    .rcv-slider{width:100%}
    /* mines */
    .rcv-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:7px;width:100%;max-width:320px}
    .rcv-cell{aspect-ratio:1;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:#0c1519;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:20px;transition:.12s}
    .rcv-cell:hover{border-color:rgba(61,255,143,.5);background:#10201a}
    .rcv-cell.safe{background:radial-gradient(circle,#134d33,#0a2a1e);border-color:#3dff8f}
    .rcv-cell.bomb{background:radial-gradient(circle,#5a1414,#2a0a0a);border-color:#ff4d5e}
    .rcv-cell.dis{pointer-events:none;opacity:.85}
    /* wheel */
    .rcv-wheel{width:210px;height:210px;border-radius:50%;position:relative;transition:transform 3.6s cubic-bezier(.15,.85,.15,1);border:6px solid #0c1519;box-shadow:0 0 0 3px rgba(232,198,106,.35),inset 0 0 30px rgba(0,0,0,.5)}
    .rcv-wheelptr{position:absolute;top:-6px;left:50%;transform:translateX(-50%);border-left:11px solid transparent;border-right:11px solid transparent;border-top:20px solid #e8c66a;z-index:2;filter:drop-shadow(0 2px 3px rgba(0,0,0,.6))}
    .rcv-canvas{width:100%;max-width:420px;border-radius:10px;background:#05090b;display:block}
    @media (max-width:560px){ .rcv-panel{padding:14px 12px 18px;border-radius:14px} .rcv-title{font-size:18px} .rcv-x{padding:10px 14px;min-height:44px} .rcv-tab{min-width:0;flex:1 1 30%;padding:12px 6px;min-height:44px} .rcv-wager{gap:6px} .rcv-wager input{width:100%;flex:1 1 100%;order:3} .rcv-chip{padding:11px 12px;min-height:44px} .rcv-btn{width:100%;padding:15px 20px;min-height:48px} }
    `;
    document.head.appendChild(s);
  }

  // ---- shell ----
  let wrap, stage, tabsEl, wagerInput, resEl, fairEl, activeGame = 'crash';
  function build() {
    injectCss();
    wrap = el('div'); wrap.id = 'rcvWrap';
    const panel = el('div', 'rcv-panel');
    const top = el('div', 'rcv-top');
    top.appendChild(el('div', 'rcv-title', 'THE VAULT FLOOR'));
    const x = el('button', 'rcv-x', 'Close'); x.onclick = close; top.appendChild(x);
    panel.appendChild(top);
    panel.appendChild(el('div', 'rcv-sub', 'Provably fair. Every result is committed and verifiable. RVLT is the house token.'));
    tabsEl = el('div', 'rcv-tabs'); panel.appendChild(tabsEl);
    const wg = el('div', 'rcv-wager');
    wg.innerHTML = '<label>Wager</label>';
    wagerInput = el('input'); wagerInput.type = 'number'; wagerInput.value = STATE.wager; wagerInput.min = 1;
    wagerInput.oninput = () => { STATE.wager = Math.max(1, Math.round(+wagerInput.value || 0)); };
    wg.appendChild(wagerInput);
    ['½', '2x', 'Max'].forEach(lbl => { const c = el('button', 'rcv-chip', lbl); c.onclick = () => { let w = STATE.wager; if (lbl === '½') w = Math.max(1, Math.floor(w / 2)); else if (lbl === '2x') w = w * 2; else w = (CFG && CFG.maxWager) || 100000; STATE.wager = w; wagerInput.value = w; }; wg.appendChild(c); });
    wg.appendChild(el('span', 'rcv-sub', 'RVLT'));
    panel.appendChild(wg);
    stage = el('div', 'rcv-stage'); panel.appendChild(stage);
    resEl = el('div', 'rcv-res'); panel.appendChild(resEl);
    fairEl = el('div', 'rcv-fair'); panel.appendChild(fairEl);
    wrap.appendChild(panel);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    document.body.appendChild(wrap);
    const games = [['crash', 'Crash'], ['mines', 'Mines'], ['plinko', 'Plinko'], ['dice', 'Dice'], ['wheel', 'Wheel']];
    games.forEach(([k, name]) => { const t = el('div', 'rcv-tab' + (k === activeGame ? ' on' : ''), name); t.dataset.g = k; t.onclick = () => selectGame(k); tabsEl.appendChild(t); });
  }
  function selectGame(k) { activeGame = k; Array.prototype.forEach.call(tabsEl.children, t => t.classList.toggle('on', t.dataset.g === k)); resEl.textContent = ''; resEl.className = 'rcv-res'; fairEl.innerHTML = ''; RENDER[k](); }
  function setRes(txt, win) { resEl.textContent = txt; resEl.className = 'rcv-res ' + (win ? 'rcv-win' : 'rcv-lose'); }
  function settle(net) { STATE.net += net; if (typeof STATE.onSettle === 'function') { try { STATE.onSettle(net, STATE.net); } catch (_) {} } }
  function showFair(o) { if (!o) return; fairEl.innerHTML = 'server hash ' + String(o.serverSeedHash || o.server_hash || '').slice(0, 18) + '… ' + (o.betId ? '<a data-b="' + o.betId + '">verify</a>' : ''); const a = $('a', fairEl); if (a) a.onclick = async () => { const v = await get('/verify?betId=' + a.dataset.b); alert('Revealed server seed:\n' + v.server_seed + '\n\nclient seed: ' + v.client_seed + '\nRecompute the result to verify.'); }; }

  // ---- games ----
  const RENDER = {};

  // DICE
  RENDER.dice = function () {
    stage.innerHTML = '';
    let target = 50;
    const track = el('div', 'rcv-track'); const marker = el('div', 'rcv-marker'); track.appendChild(marker); track.style.setProperty('--t', target + '%');
    const info = el('div', 'rcv-sub', ''); const upd = () => { info.innerHTML = 'Roll <b style="color:#3dff8f">under ' + target + '</b> to win &nbsp;·&nbsp; payout <b style="color:#e8c66a">' + (0.97 * 100 / target).toFixed(2) + 'x</b>'; };
    const sl = el('input', 'rcv-slider'); sl.type = 'range'; sl.min = 2; sl.max = 98; sl.value = target; sl.oninput = () => { target = +sl.value; track.style.setProperty('--t', target + '%'); upd(); };
    const btn = el('button', 'rcv-btn', 'Roll'); upd();
    btn.onclick = async () => { btn.disabled = true; const r = await post('/play', { player: STATE.player, game: 'dice', wager: STATE.wager, target }); if (r.error) { setRes(r.error, false); btn.disabled = false; return; } marker.style.left = Math.min(100, r.roll) + '%'; setTimeout(() => { if (r.win) { setRes('Rolled ' + r.roll.toFixed(2) + ' · +' + fmt(r.payout - r.wager) + ' RVLT', true); } else setRes('Rolled ' + r.roll.toFixed(2) + ' · -' + fmt(r.wager), false); settle(r.net); showFair(r); btn.disabled = false; }, 380); };
    stage.append(track, sl, info, btn);
  };

  // WHEEL
  RENDER.wheel = function () {
    stage.innerHTML = '';
    const segs = (CFG && CFG.wheel) || [0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 5];
    const n = segs.length, per = 360 / n;
    const grad = segs.map((v, i) => { const col = v <= 0 ? '#161f22' : (v >= 3 ? '#e8c66a' : v >= 2 ? '#3dff8f' : '#2f6f52'); return col + ' ' + (i * per) + 'deg ' + ((i + 1) * per) + 'deg'; }).join(',');
    const holder = el('div'); holder.style.cssText = 'position:relative;width:210px;height:210px';
    const ptr = el('div', 'rcv-wheelptr');
    const wheel = el('div', 'rcv-wheel'); wheel.style.background = 'conic-gradient(' + grad + ')';
    holder.append(ptr, wheel);
    const btn = el('button', 'rcv-btn', 'Spin');
    let spins = 0;
    btn.onclick = async () => { btn.disabled = true; const r = await post('/play', { player: STATE.player, game: 'wheel', wager: STATE.wager }); if (r.error) { setRes(r.error, false); btn.disabled = false; return; } spins += 5; const mid = r.index * per + per / 2; const dest = spins * 360 - mid; wheel.style.transform = 'rotate(' + dest + 'deg)'; setTimeout(() => { if (r.mult > 0) setRes('Landed ' + r.mult + 'x · +' + fmt(r.payout - r.wager) + ' RVLT', true); else setRes('Landed a blank · -' + fmt(r.wager), false); settle(r.net); showFair(r); btn.disabled = false; }, 3700); };
    stage.append(holder, btn, el('div', 'rcv-sub', 'Sixteen segments. Gold is the big one.'));
  };

  // PLINKO
  RENDER.plinko = function () {
    stage.innerHTML = '';
    let rows = 12;
    const cv = el('canvas', 'rcv-canvas'); cv.width = 420; cv.height = 300; const ctx = cv.getContext('2d');
    const table = (CFG && CFG.plinko && CFG.plinko[rows]) || [];
    function drawPegs(path, ballX, ballY, landed) {
      ctx.clearRect(0, 0, cv.width, cv.height); const top = 26, gapY = (cv.height - 70) / rows;
      for (let r = 0; r <= rows; r++) { for (let c = 0; c <= r; c++) { const x = cv.width / 2 + (c - r / 2) * 26; const y = top + r * gapY; ctx.beginPath(); ctx.arc(x, y, 2.4, 0, 7); ctx.fillStyle = 'rgba(180,220,205,.5)'; ctx.fill(); } }
      const bw = cv.width / table.length;
      for (let i = 0; i < table.length; i++) { const v = table[i]; ctx.fillStyle = v >= 3 ? 'rgba(232,198,106,.9)' : v >= 1 ? 'rgba(61,255,143,.75)' : 'rgba(120,150,140,.5)'; if (landed === i) ctx.fillStyle = '#fff'; ctx.fillRect(i * bw + 2, cv.height - 34, bw - 4, 30); ctx.fillStyle = '#02140b'; ctx.font = 'bold 10px Space Mono'; ctx.textAlign = 'center'; ctx.fillText(v + 'x', i * bw + bw / 2, cv.height - 15); }
      if (ballX != null) { ctx.beginPath(); ctx.arc(ballX, ballY, 5.5, 0, 7); ctx.fillStyle = '#ffd76a'; ctx.shadowColor = '#ffd76a'; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0; }
    }
    drawPegs();
    const btn = el('button', 'rcv-btn', 'Drop');
    btn.onclick = async () => { btn.disabled = true; const r = await post('/play', { player: STATE.player, game: 'plinko', wager: STATE.wager, rows }); if (r.error) { setRes(r.error, false); btn.disabled = false; return; } const top = 26, gapY = (cv.height - 70) / rows; let c = 0; let step = 0; const path = r.path || []; const anim = () => { const rr = step; const x = cv.width / 2 + (c - rr / 2) * 26; const y = top + rr * gapY; drawPegs(path, x, y); if (step < rows) { if (path[step]) c++; step++; setTimeout(anim, 55); } else { const bw = cv.width / table.length; drawPegs(path, r.bucket * bw + bw / 2, cv.height - 46, r.bucket); if (r.mult >= 1) setRes(r.mult + 'x · ' + (r.payout - r.wager >= 0 ? '+' : '') + fmt(r.payout - r.wager) + ' RVLT', r.payout >= r.wager); else setRes(r.mult + 'x · -' + fmt(r.wager - r.payout), false); settle(r.net); showFair(r); btn.disabled = false; } }; anim(); };
    stage.append(cv, btn, el('div', 'rcv-sub', 'Center is cold. The edges are where the loot is.'));
  };

  // MINES
  RENDER.mines = function () {
    stage.innerHTML = '';
    let mines = 3, bet = null, revealed = 0;
    const ctl = el('div', 'rcv-wager'); ctl.innerHTML = '<label>Mines</label>';
    const msel = el('input'); msel.type = 'number'; msel.min = 1; msel.max = 24; msel.value = mines; msel.style.width = '70px'; msel.oninput = () => { mines = Math.max(1, Math.min(24, +msel.value || 3)); }; ctl.appendChild(msel);
    const grid = el('div', 'rcv-grid');
    const cells = [];
    for (let i = 0; i < 25; i++) { const c = el('button', 'rcv-cell', ''); c.dataset.i = i; c.onclick = () => pick(i); grid.appendChild(c); cells.push(c); }
    const start = el('button', 'rcv-btn', 'Start'); const cash = el('button', 'rcv-btn cash', 'Cash out'); cash.style.display = 'none';
    const status = el('div', 'rcv-sub', 'Pick tiles. Every safe crack lifts your take. One alarm and it is gone.');
    function reset() { cells.forEach(c => { c.className = 'rcv-cell'; c.textContent = ''; }); bet = null; revealed = 0; start.style.display = ''; cash.style.display = 'none'; msel.disabled = false; }
    start.onclick = async () => { start.disabled = true; const r = await post('/mines/start', { player: STATE.player, wager: STATE.wager, mines }); start.disabled = false; if (r.error) { setRes(r.error, false); return; } bet = r; revealed = 0; msel.disabled = true; start.style.display = 'none'; cash.style.display = ''; cash.textContent = 'Cash out'; resEl.textContent = ''; status.innerHTML = 'Next safe tile: <b style="color:#3dff8f">' + r.next + 'x</b>'; showFair(r); };
    async function pick(i) { if (!bet) return; const c = cells[i]; if (c.classList.contains('dis') || c.classList.contains('safe') || c.classList.contains('bomb')) return; const r = await post('/mines/pick', { betId: bet.betId, tile: i }); if (r.error) { setRes(r.error, false); return; } if (r.hit) { c.className = 'rcv-cell bomb'; c.textContent = '💥'; (r.bombs || []).forEach(b => { if (b !== i) { cells[b].className = 'rcv-cell bomb dis'; cells[b].textContent = '💣'; } }); setRes('Alarm tripped · -' + fmt(bet.wager), false); settle(-bet.wager); reset(); return; } c.className = 'rcv-cell safe'; c.textContent = '💎'; revealed++; if (r.status === 'cashed') { setRes('Cleared the room · +' + fmt(r.payout - bet.wager) + ' RVLT', true); settle(r.payout - bet.wager); reset(); return; } cash.textContent = 'Cash out ' + r.mult + 'x (' + fmt(bet.wager * r.mult) + ')'; status.innerHTML = 'Next safe tile: <b style="color:#3dff8f">' + r.next + 'x</b> · ' + r.safeLeft + ' safe left'; }
    cash.onclick = async () => { if (!bet) return; const r = await post('/mines/cashout', { betId: bet.betId }); if (r.error) { setRes(r.error, false); return; } setRes('Banked ' + r.mult + 'x · +' + fmt(r.payout - bet.wager) + ' RVLT', true); settle(r.payout - bet.wager); reset(); };
    stage.append(ctl, grid, cash, start, status);
  };

  // CRASH
  RENDER.crash = function () {
    stage.innerHTML = '';
    const cv = el('canvas', 'rcv-canvas'); cv.width = 420; cv.height = 220; const ctx = cv.getContext('2d');
    const big = el('div'); big.style.cssText = 'font-family:Cinzel,serif;font-weight:900;font-size:40px;color:#3dff8f;margin-top:4px'; big.textContent = '1.00x';
    const btn = el('button', 'rcv-btn', 'Launch'); const cash = el('button', 'rcv-btn cash', 'Cash out'); cash.style.display = 'none';
    let bet = null, raf = 0, startT = 0, crashed = false;
    const K = (CFG && CFG.crashK) || (Math.log(2) / 4500);
    function draw(mult, dead) {
      ctx.clearRect(0, 0, cv.width, cv.height); ctx.strokeStyle = dead ? '#ff5a5a' : '#3dff8f'; ctx.lineWidth = 3; ctx.beginPath();
      const maxT = Math.max(1500, Math.log(Math.max(1.2, mult)) / K); const pts = 60;
      for (let i = 0; i <= pts; i++) { const t = (i / pts) * maxT; const m = Math.exp(K * t); const x = (i / pts) * (cv.width - 20) + 10; const y = cv.height - 14 - Math.min(cv.height - 30, (m - 1) * (cv.height - 40) / (mult - 1 + .0001)); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
    }
    draw(1);
    btn.onclick = async () => { btn.disabled = true; const r = await post('/crash/start', { player: STATE.player, wager: STATE.wager }); btn.disabled = false; if (r.error) { setRes(r.error, false); return; } bet = r; crashed = false; startT = Date.now(); btn.style.display = 'none'; cash.style.display = ''; resEl.textContent = ''; showFair(r); loop(); };
    function loop() { if (!bet || crashed) return; const ms = Date.now() - startT; const mult = Math.max(1, Math.exp(K * ms)); big.textContent = mult.toFixed(2) + 'x'; draw(mult); if (mult >= 60) { doCash(true); return; } raf = requestAnimationFrame(loop); }
    async function doCash(auto) { if (!bet || crashed) return; crashed = true; cancelAnimationFrame(raf); const r = await post('/crash/cashout', { betId: bet.betId }); cash.style.display = 'none'; btn.style.display = ''; if (r.error) { setRes(r.error, false); bet = null; return; } if (r.status === 'cashed') { big.style.color = '#3dff8f'; big.textContent = r.mult.toFixed(2) + 'x'; draw(r.mult); setRes('Bailed at ' + r.mult + 'x · +' + fmt(r.payout - bet.wager) + ' RVLT', true); settle(r.payout - bet.wager); } else { big.style.color = '#ff5a5a'; big.textContent = 'BLEW at ' + r.crashPoint + 'x'; draw(r.crashPoint, true); setRes('Too greedy · -' + fmt(bet.wager), false); settle(-bet.wager); } bet = null; }
    cash.onclick = () => doCash(false);
    stage.append(cv, big, cash, btn, el('div', 'rcv-sub', 'The meltdown climbs. Bail before it blows.'));
  };

  // ---- public ----
  async function open(opts) {
    opts = opts || {};
    STATE.player = opts.player || STATE.player || 'anon';
    STATE.wager = opts.wager || STATE.wager || 100;
    STATE.onSettle = opts.onSettle || null;
    STATE.runId = opts.runId || '';   // when opened inside a run, bets fold into that run's cash-out
    if (!wrap) build();
    if (!CFG) { try { CFG = await get('/config'); } catch (_) { CFG = {}; } }
    wagerInput.value = STATE.wager;
    wrap.classList.add('on');
    selectGame(activeGame);
  }
  function close() { if (wrap) wrap.classList.remove('on'); }
  window.RTV_CASINO = { open, close, get net() { return STATE.net; } };
})();
