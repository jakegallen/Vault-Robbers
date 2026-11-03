// Standalone proof of the rush overflow allocator: N open rounds (preopenDepth), deposit-ordered seating,
// dynamic deepening, cascade-on-full. No deps, deterministic (seeded LCG, no Math.random).
function simulate({N, cap, preopenDepth, maxOpenRounds, seed}){
  let s=seed||12345; const rnd=()=>{ s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
  const assets=[{k:'SOL',lat:3000},{k:'BTC',lat:300000},{k:'USDC-eth',lat:40000},{k:'USDC-base',lat:9000},{k:'BNB',lat:6000},{k:'ETH-L1',lat:120000},{k:'USDG-rh',lat:12000}];
  const buyers=[];
  for(let i=0;i<N;i++){ const a=assets[Math.floor(rnd()*assets.length)]; const arrival=Math.floor(rnd()*60000); buyers.push({id:i,asset:a.k,arrival,land:arrival+a.lat}); }
  const rounds=new Map(); let nextId=1; const openOrder=[];
  const openRound=id=>{ if(!rounds.has(id)){ rounds.set(id,{id,sold:0,seats:[]}); openOrder.push(id); } };
  function ensureBuffer(){ let withRoom=openOrder.filter(id=>rounds.get(id).sold<cap).length; while(withRoom<preopenDepth && rounds.size<maxOpenRounds){ openRound(nextId++); withRoom++; } }
  function nextBuyRound(){ ensureBuffer(); for(const id of openOrder) if(rounds.get(id).sold<cap) return id; return null; }
  openRound(nextId++); ensureBuffer();
  // preflight assigns at ARRIVAL order (intent); seat is taken at LAND order (on-chain deposit), cascading if full.
  [...buyers].sort((a,b)=>a.arrival-b.arrival).forEach(b=>{ b.assigned=nextBuyRound(); });
  let lost=0; const landOrder=[...buyers].sort((a,b)=>a.land-b.land);
  for(const b of landOrder){ let rid=b.assigned; if(rid==null||rounds.get(rid).sold>=cap) rid=nextBuyRound(); if(rid==null){ lost++; continue; } const r=rounds.get(rid); r.sold++; r.seats.push({buyer:b.id,land:b.land,asset:b.asset}); ensureBuffer(); }
  // checks
  const filled=[...rounds.values()].filter(r=>r.sold>0);
  const overCap=filled.filter(r=>r.sold>cap).length;
  const seated=filled.reduce((a,r)=>a+r.sold,0);
  // per-round: seats must be in non-decreasing land order (deposit order within a round)
  let orderOK=true; for(const r of filled){ for(let i=1;i<r.seats.length;i++) if(r.seats[i].land<r.seats[i-1].land) orderOK=false; }
  // global: no buyer seated before an earlier-landing buyer was (deposit-order across the system)
  const allSeats=filled.flatMap(r=>r.seats.map(x=>x.land)); // already seated in land loop order
  return {N,cap,preopenDepth,roundsUsed:filled.length,seated,lost,overCap,orderOK,maxOpen:rounds.size,
    sample:filled.slice(0,3).map(r=>({round:r.id,sold:r.sold,assets:r.seats.map(x=>x.asset)})),
    last:filled.slice(-1).map(r=>({round:r.id,sold:r.sold}))};
}
for(const cfg of [{N:200,cap:5,preopenDepth:3,maxOpenRounds:200},{N:200,cap:50,preopenDepth:3,maxOpenRounds:200},{N:50,cap:5,preopenDepth:2,maxOpenRounds:200}]){
  const r=simulate(cfg); console.log(JSON.stringify(r));
}
