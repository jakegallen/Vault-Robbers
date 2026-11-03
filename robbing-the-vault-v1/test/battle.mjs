import fs from 'fs'; import crypto from 'crypto';
const src = fs.readFileSync('/data/app-groups/main/robbing-the-vault-dev/server.js','utf8').split('\n');
// Extract the real pure logic from server.js (by symbol) so the battery tests SHIPPING code, re-runnable each build.
const singles=['const P = [0.90','const LEVELS = P.length','const DOORS = {','const baseOdds =','const skillBonusFor =','const effOdds =','const difficultyFor =','const POT_LADDER =','const potShareFor =','const SKILL_GAMES =','const LUCK_GAMES =','const NERVE_GAMES =','const POOL =','const num =','const clamp =','const _hb =','const _u ='];
const blocks=['function chamberCategories','function roll','function gameForDoor','function buildChallenge','function scoreEvents','function sanitizeParams','function humanScore'];
let out=[];
for(const s of singles){ const i=src.findIndex(l=>l.trim().startsWith(s)); if(i<0){console.error('MISSING single',s);process.exit(1);} out.push(src[i]); }
for(const b of blocks){ const i=src.findIndex(l=>l.trim().startsWith(b)); if(i<0){console.error('MISSING block',b);process.exit(1);} let j=i; while(j<src.length && src[j]!=='}') j++; out.push(src.slice(i,j+1).join('\n')); }
const code=out.join('\n')+'\n;return {buildChallenge,scoreEvents,roll,effOdds,baseOdds,skillBonusFor,sanitizeParams,humanScore,chamberCategories,gameForDoor,potShareFor,SKILL_GAMES,LUCK_GAMES,NERVE_GAMES,POOL,clamp,num,DOORS,P};';
const M=new Function('crypto',code)(crypto);
const ALL=[...M.SKILL_GAMES,...M.LUCK_GAMES,...M.NERVE_GAMES];
const skillnerve=[...M.SKILL_GAMES,...M.NERVE_GAMES];
let fails=[],checks=0;
const bad=v=>typeof v!=='number'||!isFinite(v);
function seedHex(i){return crypto.createHash('sha256').update('s'+i).digest('hex');}
// T1: buildChallenge validity across all games x levels x doors x seeds
for(const g of ALL) for(let lvl=1;lvl<=10;lvl++) for(const d of ['left','center','right']) for(let s=0;s<40;s++){
  checks++; let ch; try{ch=M.buildChallenge(g,lvl,d,seedHex(s));}catch(e){fails.push(`build ${g} L${lvl} ${d}: THREW ${e.message}`);continue;}
  if(!ch||bad(ch.minMs)||ch.minMs<=0)fails.push(`build ${g} L${lvl}: bad minMs`);
  for(const k of Object.keys(ch)){const v=ch[k]; if(typeof v==='number'&&bad(v))fails.push(`build ${g} L${lvl}: NaN field ${k}`);}
  if(ch.gaps){ if(ch.gaps.length!==ch.rounds)fails.push(`${g}: gaps!=rounds`); for(const gp of ch.gaps){if(bad(gp.pos)||gp.pos<0||gp.pos>1||bad(gp.w)||gp.w<=0)fails.push(`${g}: bad gap`);}}
  if(ch.danger!=null&&(ch.danger<=0||ch.danger>=1))fails.push(`${g} L${lvl}: danger out of range ${ch.danger}`);
  if(ch.fail!=null&&(ch.fail<1||ch.fail>ch.rungs))fails.push(`${g} L${lvl}: fail out of range`);
  if(ch.lo!=null&&(ch.lo>=ch.hi||ch.lo<-0.01))fails.push(`${g} L${lvl}: band lo>=hi (${ch.lo},${ch.hi})`);
  if(ch.target!=null&&bad(ch.target))fails.push(`${g}: bad target`);
}
// T2: scoreEvents robustness — empty, garbage; must be finite [0,1] or null(luck), never NaN/throw
const garbage=[[],null,undefined,[{},{t:-5},{type:'tap',t:NaN}],Array.from({length:600},(_,i)=>({type:'tap',t:i})),[{type:'lock',t:1e9}],[{type:'stop',t:-1}],[{type:'climb'}]];
for(const g of ALL) for(let lvl=1;lvl<=10;lvl++){ const ch=M.buildChallenge(g,lvl,'center',seedHex(1));
  for(const ev of garbage){ checks++; let sc; try{sc=M.scoreEvents(g,ch,ev);}catch(e){fails.push(`score ${g} garbage THREW ${e.message}`);continue;}
    if(M.LUCK_GAMES.includes(g)){ if(sc!==null)fails.push(`luck ${g} score!=null`); }
    else { if(sc===null){}else if(bad(sc)||sc<0||sc>1)fails.push(`score ${g} L${lvl}: out-of-range ${sc}`);} }
  // empty must be 0 for skill/nerve
  if(skillnerve.includes(g)){const z=M.scoreEvents(g,ch,[]); if(z!==0&&z!==null)fails.push(`score ${g}: empty!=0 (${z})`);}
}
// T3: correctness regression — a correct play must score high (invertible games)
{ const ch=M.buildChallenge('dial',3,'center',seedHex(2)); const t=(((ch.target-ch.start)%(2*Math.PI)+2*Math.PI)%(2*Math.PI))/ch.speed*1000; const sc=M.scoreEvents('dial',ch,[{type:'lock',t}]); checks++; if(!(sc>0.8))fails.push(`dial correct play scored ${sc} (<0.8)`);}
{ const ch=M.buildChallenge('stopwatch',3,'center',seedHex(3)); const sc=M.scoreEvents('stopwatch',ch,[{type:'stop',t:ch.target}]); checks++; if(!(sc>0.9))fails.push(`stopwatch perfect scored ${sc}`);}
{ const ch=M.buildChallenge('mash',3,'center',seedHex(4)); const evs=Array.from({length:ch.need},()=>({type:'tap',t:100})); const sc=M.scoreEvents('mash',ch,evs); checks++; if(!(sc>=0.99))fails.push(`mash full scored ${sc}`);}
// T4: roll determinism + uniformity
{ const a=M.roll('aa','bb',1),b=M.roll('aa','bb',1); checks++; if(a!==b)fails.push('roll not deterministic');
  let sum=0,mn=1,mx=0,N=200000; for(let i=0;i<N;i++){const r=M.roll('seed','cli',i); if(r<0||r>=1){fails.push('roll out of [0,1)');break;} sum+=r;mn=Math.min(mn,r);mx=Math.max(mx,r);} const mean=sum/N; checks++; if(Math.abs(mean-0.5)>0.01)fails.push(`roll mean ${mean.toFixed(4)}`);}
// T5: odds within caps
for(let lvl=1;lvl<=10;lvl++)for(const d of ['left','center','right'])for(const sk of [0,0.5,1]){checks++;const e=M.effOdds(lvl,d,sk);if(bad(e)||e<=0||e>0.985+1e-9)fails.push(`effOdds L${lvl} ${d} s${sk}=${e}`);}
// T6: sanitizeParams strips hidden answers, keeps render fields
{ const ch=M.buildChallenge('holddrill',6,'center',seedHex(5)); const s=M.sanitizeParams('holddrill',ch); checks++; if(s.danger!=null)fails.push('sanitize kept danger'); if(s.maxMs==null)fails.push('sanitize dropped maxMs');
  const ch2=M.buildChallenge('ladder',6,'center',seedHex(6)); const s2=M.sanitizeParams('ladder',ch2); checks++; if(s2.fail!=null)fails.push('sanitize kept fail'); if(s2.rungs==null)fails.push('sanitize dropped rungs');
  const ch3=M.buildChallenge('wirecut',6,'center',seedHex(7)); const s3=M.sanitizeParams('wirecut',ch3); checks++; if(s3.target!=null)fails.push('sanitize kept wirecut target'); if(s3.wires==null)fails.push('sanitize dropped wires');
  const ch4=M.buildChallenge('lasers',6,'center',seedHex(8)); const s4=M.sanitizeParams('lasers',ch4); checks++; if(s4.gaps==null)fails.push('sanitize dropped lasers gaps'); }
console.log(`RAN ${checks} checks across ${ALL.length} games x 10 levels x 3 doors x seeds`);
console.log(fails.length? ('FAILURES ('+fails.length+'):\n'+[...new Set(fails)].slice(0,40).join('\n')) : 'ALL PASS — no crashes, no NaN, scores in range, roll uniform+deterministic, odds capped, answers stripped');
