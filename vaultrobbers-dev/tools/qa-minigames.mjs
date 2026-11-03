// QA harness for all 45 mini-games. Drives the REAL challenge + scoring engine (via /api/mini/preview, /api/mini/step,
// /api/mini/preview/score) at levels 1/5/10, feeds each game an OPTIMAL input, and asserts: renders (params ok), scores
// (no error), correct category, and beatable (skill/nerve can score > 0). Luck games are expected to return passed=null.
// Run:  B=<base> P=<devpw> node tools/qa-minigames.mjs      (base = .../pub/main/robbing-the-vault-main)
const BASE = process.env.B, PW = process.env.P;
let COOKIE = '';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function j(path, body, method = 'POST') {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', 'Cookie': COOKIE, 'Accept': 'application/json' }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

const SKILL = ['dial','lasers','sequence','reflex','wirecut','targets','stopwatch','mash','silentalarm','tumbler','torque','sonicrack','pressureplates','dialcombo','hotwire'];
const LUCK  = ['wheel','dice','cardflip','coinflip','slots','roulette','shells','scratch','plinko','keno','goldbar','magnetgrab','fuserace','elevatorroulette','safedial'];
const NERVE = ['ladder','cascadelocks','vaultstack','dominoes','ziplinebail','minefield','defuse','heisttimer','crank','dive','thermite','staticcharge','crackdrill','nitro','guardsweep'];
const CAT = {}; SKILL.forEach(g=>CAT[g]='skill'); LUCK.forEach(g=>CAT[g]='luck'); NERVE.forEach(g=>CAT[g]='nerve');
const LASER = ['lasers','lockpins','sonicrack','dialcombo','hotwire'];
const REFLEXG = ['reflex','quickdraw','silentalarm'];
const GAUGE = ['crank','dive','thermite','staticcharge','crackdrill','nitro','guardsweep'];
const CLIMB = ['ladder','minefield','cascadelocks','ziplinebail','defuse','vaultstack','heisttimer','dominoes'];

// Build the OPTIMAL/winning event stream for a game given its (client-visible) params + pvid.
async function winningEvents(game, p, pvid) {
  if (game === 'dial') { const tw = ((((p.target - p.start) % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI)) / p.speed * 1000; return [{ type:'lock', t: tw + 40 }]; }
  if (LASER.includes(game)) return p.gaps.map((g,k) => ({ type:'tap', t: ((1-g.pos) + 2*(k+1)) / p.speed * 1000 }));   // exact hit, one full cycle later so no clamp is needed
  if (game === 'sequence') { const ev = []; for (let i = 0; i < (p.seqLen||4); i++) { if (i>0) await sleep((p.flashMs||500)); const s = await j('/api/mini/step?pvid='+pvid+'&i='+i, null, 'GET'); if (s.d && typeof s.d.pad === 'number') ev.push({ type:'pad', idx: s.d.pad, t: 200 + i*120 }); } return ev; }
  if (REFLEXG.includes(game)) return [{ type:'tap', t: p.greenAt + 120 }];
  if (game === 'wirecut') return [{ type:'cut', t: Math.round((p.bandLo + p.bandHi)/2 * p.travelMs) }];
  if (game === 'torque') return [{ type:'stop', t: Math.round((p.lo + p.hi)/2 * p.maxMs) }];
  if (game === 'stopwatch' || game === 'tumbler') return [{ type:'stop', t: p.target }];
  if (game === 'mash' || game === 'drilldepth') { const ev=[]; for (let i=0;i<(p.need||14);i++) ev.push({ type:'tap', t: 100 + i*60 }); return ev; }
  if (game === 'targets' || game === 'catch' || game === 'pressureplates') { const ev=[]; for (let i=0;i<(p.n||6);i++) ev.push({ type:'tap', t: 200 + i*150 }); return ev; }
  if (GAUGE.includes(game)) return [{ type:'stop', t: Math.round(0.45 * p.maxMs) }];   // f=0.45 < danger (>=0.5) always -> scores
  if (CLIMB.includes(game)) return [{ type:'climb', t: 300 }];   // 1 step: wins iff fail>1 (ret”ried by caller)
  return [];   // luck: no skill events
}

const results = [];
async function trial(game, level) {
  const pv = await j('/api/mini/preview?game='+game+'&level='+level, null, 'GET');
  if (!pv.d || pv.d.ok === false || !pv.d.pvid) { results.push({ game, level, ok:false, why:'preview failed: '+JSON.stringify(pv.d) }); return; }
  const p = pv.d.params, cat = CAT[game];
  // category check
  if (pv.d.kind !== cat) results.push({ game, level, ok:false, why:'category mismatch: server says '+pv.d.kind+', pool says '+cat });
  const ev = await winningEvents(game, p, pv.d.pvid);
  const s = await j('/api/mini/preview/score', { pvid: pv.d.pvid, events: ev });
  if (!s.d || s.d.ok === false) { results.push({ game, level, ok:false, why:'score failed: '+JSON.stringify(s.d) }); return; }
  if (cat === 'luck') { results.push({ game, level, ok: s.d.passed === null || s.d.kind === 'luck', beat:'n/a(luck)', why: (s.d.passed===null||s.d.kind==='luck')?'':'luck game returned a skill result: '+JSON.stringify(s.d) }); return; }
  results.push({ game, level, ok: true, beat: s.d.passed === true, score: s.d.score, _cat: cat });
}

(async () => {
  const g = await fetch(BASE + '/__enter', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ k: PW }) });
  COOKIE = (g.headers.get('set-cookie') || '').split(';')[0];
  if (!/rtv_gate/.test(COOKIE)) { console.log('AUTH FAILED (no gate cookie)'); return; }
  const all = [...SKILL, ...LUCK, ...NERVE];
  for (const game of all) for (const level of [1,5,10]) {
    try { await trial(game, level); }
    catch (e) { results.push({ game, level, ok:false, why:'threw: '+(e.message||e) }); }
  }
  // climb beatability: 1-step can bust when fail===1 (~1/rungs); retry unbeaten climb trials a few times before flagging
  for (const r of results) {
    if (r._cat === 'nerve' && CLIMB.includes(r.game) && r.beat === false) {
      let beat = false;
      for (let k = 0; k < 6 && !beat; k++) { const pv = await j('/api/mini/preview?game='+r.game+'&level='+r.level,null,'GET'); const s = await j('/api/mini/preview/score',{pvid:pv.d.pvid,events:[{type:'climb',t:300}]}); if (s.d && s.d.passed) beat = true; }
      r.beat = beat; if (!beat) r.retried = true;
    }
  }
  // report
  const fails = results.filter(r => !r.ok);
  const unbeat = results.filter(r => r.ok && r._cat && r.beat === false);
  console.log('=== MINI-GAME QA: '+results.length+' trials (45 games x 3 levels) ===');
  console.log('errors/mismatches: '+fails.length+'   unbeatable(skill/nerve): '+unbeat.length);
  if (fails.length) { console.log('\n-- FAILURES --'); fails.forEach(r => console.log('  '+r.game+' L'+r.level+': '+r.why)); }
  if (unbeat.length) { console.log('\n-- UNBEATABLE (optimal input still scored 0) --'); unbeat.forEach(r => console.log('  '+r.game+' L'+r.level+(r.retried?' (retried x6)':''))); }
  // per-category beat summary
  for (const c of ['skill','nerve']) { const rs = results.filter(r=>r._cat===c); const beat = rs.filter(r=>r.beat===true).length; console.log('\n'+c+': '+beat+'/'+rs.length+' trials winnable with optimal input'); }
  console.log('\n'+(fails.length===0 && unbeat.length===0 ? 'ALL CLEAR ✅' : 'ISSUES FOUND ⚠️'));
})();
