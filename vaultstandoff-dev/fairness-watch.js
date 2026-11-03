#!/usr/bin/env node
// ============================================================================
// Vault Standoff — FAIRNESS WATCHER (independent, read-only, public-data-only)
// ----------------------------------------------------------------------------
// Purpose: detect a RIGGED OUTCOME DISTRIBUTION — whether from a rogue operator
// biasing who wins, or an agent/bot grinding EV off human players — using ONLY
// trustless on-chain data (who bought how many tickets per round, who the
// winner was, the pot and rake). It does NOT need the seed, the picks, or any
// server-provided proof, so it cannot be fed false inputs by a compromised
// server. It shares NO code with the game engine and changes NOTHING about
// gameplay; it is a pure after-the-fact monitor.
//
// The core idea: in a FAIR game, a wallet's probability of winning a round must
// equal its share of that round's tickets (ticket-weighted draw). Over many
// rounds, each wallet's ACTUAL wins must track its EXPECTED wins (the sum of its
// per-round ticket shares) within normal statistical noise. A wallet (or the
// house, via a favored wallet) that wins far MORE than its ticket share predicts
// — beyond a binomial confidence band, with a minimum sample — is the signature
// of rigging or an exploit. We also run an aggregate chi-square as a global
// tripwire, and assert the structural invariants (winner was a participant; rake
// ~= configured bps) that the contract already enforces, as a belt-and-braces.
//
// Usage:
//   node fairness-watch.js --self-test          # synthetic fair + rigged proof
//   node fairness-watch.js --rounds rounds.json # analyze a rounds array
// Round shape: { roundId, participants:{ key: ticketCount, ... }, winner: key|null,
//               potWei?:string, rakeWei?:string }   (key = lowercased wallet addr)
// ============================================================================
'use strict';

const RAKE_BPS = 500;            // expected rake (5%); invariant check tolerance below
const Z_FLAG = 3.5;              // per-wallet z-score to flag over-winning (3.5 not 3.0: with many wallets the family-wise false-positive rate compounds; 3.5 keeps it ~1% even at 50 wallets)
const MIN_EXPECTED = 5;          // need at least this many expected wins before judging a wallet
const CHI_P_FLAG = 0.001;        // aggregate chi-square p-value tripwire

// ---- statistics (no deps) ---------------------------------------------------
// Normal upper-tail approximation (Abramowitz & Stegun 7.1.26) for a z-score -> p.
function zToP(z){ // one-sided P(Z > z)
  if(z < 0) return 1 - zToP(-z);
  const t = 1/(1+0.2316419*z);
  const d = 0.3989422804014327*Math.exp(-z*z/2);
  const p = d*t*(0.319381530+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));
  return p;
}
// Wilson/normal binomial z: actual vs expected successes given per-trial probs.
// expected = sum(p_i), variance = sum(p_i*(1-p_i)) (Poisson-binomial), z = (actual-exp)/sd.
function poissonBinomial(actual, probs){
  const exp = probs.reduce((a,p)=>a+p, 0);
  const varr = probs.reduce((a,p)=>a+p*(1-p), 0);
  const sd = Math.sqrt(varr) || 1e-9;
  return { exp, sd, z: (actual - exp)/sd };
}

// ---- core analysis ----------------------------------------------------------
function analyze(rounds){
  const flags = [];
  const invariant = [];
  // per-wallet accumulators: actual wins + the list of per-round win probabilities
  const W = new Map(); // key -> { wins, probs:[], rounds, tickets }
  const touch = k => { if(!W.has(k)) W.set(k, { wins:0, probs:[], rounds:0, tickets:0 }); return W.get(k); };

  let settled = 0;
  for(const r of rounds){
    const parts = r.participants || {};
    const keys = Object.keys(parts);
    const total = keys.reduce((a,k)=>a+Number(parts[k]||0), 0);
    if(total <= 0) continue;
    // INVARIANT 1: winner (if any) must be a participant with >0 tickets
    if(r.winner != null){
      if(!(Number(parts[r.winner]||0) > 0)) invariant.push(`round ${r.roundId}: winner ${r.winner} not a participant`);
    }
    // INVARIANT 2: rake ~= RAKE_BPS of pot (chain-enforced; flag drift as tamper signal)
    if(r.potWei && r.rakeWei){
      try{ const pot=BigInt(r.potWei), rake=BigInt(r.rakeWei); if(pot>0n){ const bps=Number(rake*10000n/pot); if(Math.abs(bps-RAKE_BPS)>1) invariant.push(`round ${r.roundId}: rake ${bps}bps != ${RAKE_BPS}bps`); } }catch(_){}
    }
    for(const k of keys){
      const e = touch(k);
      e.rounds++; e.tickets += Number(parts[k]||0);
      e.probs.push(Number(parts[k]||0)/total);     // fair win prob this round
    }
    if(r.winner != null && W.has(r.winner)) W.get(r.winner).wins++;
    settled++;
  }

  // per-wallet over-winning test
  let chiStat = 0, chiDof = 0;
  for(const [k,e] of W){
    const { exp, sd, z } = poissonBinomial(e.wins, e.probs);
    if(exp >= 1){ chiStat += ((e.wins-exp)*(e.wins-exp))/(exp>0?exp:1); chiDof++; }
    const sole = e.probs.length>0 && e.probs.every(p=>p>0.99);   // was the lone participant in those rounds -> winning is legitimate, not a rig signal (suppress the z-flag; the participant invariant still covers it)
    if(exp >= MIN_EXPECTED && z >= Z_FLAG && !sole){
      flags.push({ wallet:k, rounds:e.rounds, tickets:e.tickets, actualWins:e.wins,
        expectedWins:+exp.toFixed(2), z:+z.toFixed(2), pValue:zToP(z).toExponential(2),
        note:'wins far above ticket-share expectation (rigging / EV-grind signature)' });
    }
  }
  // aggregate chi-square p (very rough, dof = distinct wallets with exp>=1)
  const chiP = chiDof>0 ? chiSquareP(chiStat, chiDof) : 1;

  return {
    settledRounds: settled,
    wallets: W.size,
    invariantViolations: invariant,
    overWinFlags: flags.sort((a,b)=>b.z-a.z),
    aggregate: { chiSquare:+chiStat.toFixed(2), dof:chiDof, pValue:+chiP.toExponential(3), tripwire: chiP < CHI_P_FLAG },
    verdict: (invariant.length===0 && flags.length===0 && chiP>=CHI_P_FLAG) ? 'FAIR (no anomaly)' : 'ANOMALY — investigate'
  };
}
// chi-square survival (upper tail) via regularized gamma Q, series/continued-fraction.
function chiSquareP(x, k){ if(x<=0) return 1; return gammaincQ(k/2, x/2); }
function gammaincQ(s, x){
  if(x < s+1){ // series for P, then Q=1-P
    let sum=1/s, term=1/s; for(let n=1;n<200;n++){ term*=x/(s+n); sum+=term; if(term<sum*1e-12)break; }
    return 1 - sum*Math.exp(-x + s*Math.log(x) - lgamma(s));
  } else {     // continued fraction for Q
    let b=x+1-s, c=1e300, d=1/b, h=d;
    for(let i=1;i<200;i++){ const an=-i*(i-s); b+=2; d=an*d+b; if(Math.abs(d)<1e-300)d=1e-300; c=b+an/c; if(Math.abs(c)<1e-300)c=1e-300; d=1/d; const del=d*c; h*=del; if(Math.abs(del-1)<1e-12)break; }
    return h*Math.exp(-x + s*Math.log(x) - lgamma(s));
  }
}
function lgamma(z){ const g=[76.18009172947146,-86.50532032941677,24.01409824083091,-1.231739572450155,0.1208650973866179e-2,-0.5395239384953e-5]; let x=z,y=z,tmp=x+5.5; tmp-=(x+0.5)*Math.log(tmp); let ser=1.000000000190015; for(let j=0;j<6;j++){ y++; ser+=g[j]/y; } return -tmp+Math.log(2.5066282746310005*ser/x); }

// ---- synthetic self-test ----------------------------------------------------
function rng(seed){ let s=seed>>>0; return ()=>{ s=(s*1664525+1013904223)>>>0; return s/4294967296; }; }
function makeRounds(n, wallets, rig, rnd){
  const rounds=[];
  for(let i=0;i<n;i++){
    const parts={}; let total=0;
    for(const w of wallets){ const t=1+Math.floor(rnd()*3); parts[w.k]=t; total+=t; }
    let winner;
    if(rig && rnd()<rig.rate){ winner=rig.k; }      // rigged: favored wallet wins `rate` of rounds outright
    else { let x=rnd()*total, acc=0; winner=wallets[0].k; for(const w of wallets){ acc+=parts[w.k]; if(x<=acc){ winner=w.k; break; } } }
    const pot=BigInt(total)*5000n*(10n**18n); const rake=pot*BigInt(RAKE_BPS)/10000n;
    rounds.push({ roundId:i+1, participants:parts, winner, potWei:pot.toString(), rakeWei:rake.toString() });
  }
  return rounds;
}
function selfTest(){
  const wallets=[{k:'0xaaa'},{k:'0xbbb'},{k:'0xccc'},{k:'0xddd'},{k:'0xeee'}];
  console.log('--- FAIR sample (300 rounds, ticket-weighted winners) ---');
  const fair=analyze(makeRounds(300, wallets, null, rng(12345)));
  console.log(JSON.stringify({verdict:fair.verdict, flags:fair.overWinFlags.length, chiP:fair.aggregate.pValue, inv:fair.invariantViolations.length}, null, 0));
  console.log('--- RIGGED sample (300 rounds, 0xccc wins 45% outright regardless of share) ---');
  const rigged=analyze(makeRounds(300, wallets, {k:'0xccc', rate:0.45}, rng(999)));
  console.log(JSON.stringify({verdict:rigged.verdict, flags:rigged.overWinFlags, chiP:rigged.aggregate.pValue}, null, 2));
  const ok = fair.verdict.startsWith('FAIR') && !rigged.verdict.startsWith('FAIR') && rigged.overWinFlags.some(f=>f.wallet==='0xccc');
  console.log('\nSELF-TEST', ok ? 'PASS (fair=clean, rigged=flagged 0xccc)' : 'FAIL');
  process.exit(ok?0:1);
}

if(require.main===module){
  const arg=process.argv[2];
  if(arg==='--self-test') return selfTest();
  if(arg==='--rounds'){ const rounds=JSON.parse(require('fs').readFileSync(process.argv[3],'utf8')); console.log(JSON.stringify(analyze(rounds), null, 2)); return; }
  console.log('usage: node fairness-watch.js --self-test | --rounds <rounds.json>');
}
module.exports = { analyze };
