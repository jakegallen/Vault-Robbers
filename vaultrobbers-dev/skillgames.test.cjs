'use strict';
const { GAMES, renderSafe, dOf, LEVELS } = require('./skillgames.js');
const BAR=[0.10,0.24,0.40,0.55,0.68,0.74,0.80,0.86,0.91,0.95];
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const N=(m,s)=>{let u=0,v=0;while(!u)u=Math.random();while(!v)v=Math.random();return m+s*Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);};

// ---- 1) LEAK ASSERTION: no answer key may appear anywhere in the shippable render payload ----
const ANSWER_KEYS=['seq','odd','ans','targets','nums','cells','iv'];
let leaks=0;
for(const k of Object.keys(GAMES)){ for(let l=1;l<=LEVELS;l++){ const b=GAMES[k].build('leaktest'+l,l); const wire=JSON.stringify(renderSafe(k,b));
  for(const ak of ANSWER_KEYS){ if(new RegExp('"'+ak+'"').test(wire)){ console.log('LEAK: '+k+' L'+l+' exposes "'+ak+'" in data'); leaks++; } } } }
console.log('LEAK CHECK: '+(leaks===0?'PASS — no answer field ever ships in `data`':(leaks+' LEAKS')));

// ---- 2) win-rate sim: real build()+grade(), human vs payload-reading bot (sees data only, no pixels) ----
const T=20000;
function human(k,b,lvl){ const g=GAMES[k], hp=g.humanP(lvl), ev=[];
  if(k==='lineup'){ const cap=hp.p; for(let i=0;i<b.data.count;i++){ const rec=clamp(1-Math.max(0,(i+1)-cap)*0.33,0.35,0.995); ev.push({type:'pick',idx: Math.random()<rec? b.secret.seq[i] : (b.secret.seq[i]+1)%b.data.palette}); } }
  else if(k==='oddone'){ for(let i=0;i<b.data.rounds;i++){ ev.push({type:'pick',idx: Math.random()<hp.p? b.secret.odd[i] : (b.secret.odd[i]+1)%b.data.tiles}); } }
  else if(k==='combo'){ ev.push({type:'answer',value: Math.random()<hp.p? b.secret.ans : b.secret.ans+1}); }
  else if(k==='dial'){ for(let i=0;i<b.secret.targets.length;i++){ const inWin=Math.random()<hp.p; const a=b.secret.targets[i]+ (inWin? N(0,b.secret.arcW*0.45) : N(0,1.4)); ev.push({type:'lock',a}); } }
  return g.grade(b,lvl,ev);
}
function bot(k,b,lvl){ const g=GAMES[k], ev=[];   // BOT reads b.data ONLY (no pixels/secret) — must guess
  if(k==='lineup'){ for(let i=0;i<b.data.count;i++) ev.push({type:'pick',idx: Math.floor(Math.random()*b.data.palette)}); }
  else if(k==='oddone'){ for(let i=0;i<b.data.rounds;i++) ev.push({type:'pick',idx: Math.floor(Math.random()*b.data.tiles)}); }
  else if(k==='combo'){ const g2=Math.round(4.9*b.data.count); ev.push({type:'answer',value: b.data.rule==='sum'?g2:(b.data.rule==='sumEven'||b.data.rule==='sumOdd')?Math.round(g2/2):5}); }
  else if(k==='dial'){ for(let i=0;i<b.data.stops;i++) ev.push({type:'lock',a:Math.random()*Math.PI*2}); }
  return g.grade(b,lvl,ev);
}
const pct=x=>(''+Math.round(x*100)).padStart(4);
console.log('\nWIN% by chamber  (H=human, B=payload bot).  win = score >= bar');
for(const k of Object.keys(GAMES)){
  console.log('\n== '+k.toUpperCase()+'  ['+GAMES[k].family+'] ==');
  let hd='  ch: ';for(let l=1;l<=10;l++)hd+=(''+l).padStart(4);console.log(hd);
  for(const who of ['H','B']){ let row='  '+who+':  ';
    for(let l=1;l<=10;l++){ let w=0; for(let t=0;t<T;t++){ const b=GAMES[k].build(who+'_'+l+'_'+t,l); const sc=(who==='H'?human:bot)(k,b,l); if(sc>=BAR[l-1])w++; } row+=pct(w/T); }
    console.log(row);
  }
}
console.log('\nbars:  '+BAR.map(x=>(''+Math.round(x*100)).padStart(4)).join(''));
