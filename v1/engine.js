/* Robbing the Vault V1 - static open-source engine (window.RTVEngineV1).
   The original V1 game was a server app: the browser streamed input events to the server, which built the
   mini-game challenge from a committed seed and scored it. This file runs that SAME logic in the browser with
   no server, no wallet, no money: free play, forever. Every pure function below (odds, gameForDoor,
   buildChallenge, scoreEvents, sanitizeParams, the crack resolution) is copied faithfully from the V1 server;
   only the DB, anti-bot voiding, and on-chain money paths are dropped (run state lives in localStorage).
   Frozen "original" odds model: ODDS_V2 and SKILL_V3 are OFF, matching the hosted free V1. */
(function (global) {
  "use strict";

  // ---------- sync HMAC-SHA256 (self-contained; need not match node byte-for-byte: seeds are fresh-random per run) ----------
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function sha256bytes(msg) {
    var H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var l=msg.length, withOne=l+1, padLen=(withOne%64<=56)?(56-withOne%64):(120-withOne%64);
    var total=l+1+padLen+8, buf=new Uint8Array(total); buf.set(msg,0); buf[l]=0x80;
    var bits=l*8; for(var i=0;i<8;i++) buf[total-1-i]=(bits/Math.pow(2,8*i))&0xff;
    var w=new Int32Array(64);
    for(var off=0;off<total;off+=64){
      for(var t=0;t<16;t++) w[t]=(buf[off+t*4]<<24)|(buf[off+t*4+1]<<16)|(buf[off+t*4+2]<<8)|(buf[off+t*4+3]);
      for(t=16;t<64;t++){ var x=w[t-15],y=w[t-2];
        var s0=((x>>>7)|(x<<25))^((x>>>18)|(x<<14))^(x>>>3);
        var s1=((y>>>17)|(y<<15))^((y>>>19)|(y<<13))^(y>>>10);
        w[t]=(w[t-16]+s0+w[t-7]+s1)|0; }
      var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
      for(t=0;t<64;t++){
        var S1=((e>>>6)|(e<<26))^((e>>>11)|(e<<21))^((e>>>25)|(e<<7));
        var ch=(e&f)^(~e&g); var t1=(h+S1+ch+K[t]+w[t])|0;
        var S0=((a>>>2)|(a<<30))^((a>>>13)|(a<<19))^((a>>>22)|(a<<10));
        var maj=(a&b)^(a&c)^(b&c); var t2=(S0+maj)|0;
        h=g;g=f;f=e;e=(d+t1)|0;d=c;c=b;b=a;a=(t1+t2)|0;
      }
      H[0]=(H[0]+a)|0;H[1]=(H[1]+b)|0;H[2]=(H[2]+c)|0;H[3]=(H[3]+d)|0;H[4]=(H[4]+e)|0;H[5]=(H[5]+f)|0;H[6]=(H[6]+g)|0;H[7]=(H[7]+h)|0;
    }
    var out=new Uint8Array(32); for(i=0;i<8;i++){ out[i*4]=(H[i]>>>24)&0xff;out[i*4+1]=(H[i]>>>16)&0xff;out[i*4+2]=(H[i]>>>8)&0xff;out[i*4+3]=H[i]&0xff; } return out;
  }
  function utf8(s){ if(typeof s!=='string') s=String(s); if(global.TextEncoder) return new global.TextEncoder().encode(s);
    var a=[],i,c; for(i=0;i<s.length;i++){ c=s.charCodeAt(i); if(c<128)a.push(c); else if(c<2048){a.push(192|c>>6);a.push(128|c&63);} else {a.push(224|c>>12);a.push(128|(c>>6)&63);a.push(128|c&63);} } return new Uint8Array(a); }
  function concat(x,y){ var z=new Uint8Array(x.length+y.length); z.set(x,0); z.set(y,x.length); return z; }
  function hmacBytes(keyStr, msgStr){
    var key=utf8(keyStr); if(key.length>64) key=sha256bytes(key);
    var ip=new Uint8Array(64), op=new Uint8Array(64);
    for(var i=0;i<64;i++){ var k=i<key.length?key[i]:0; ip[i]=k^0x36; op[i]=k^0x5c; }
    var inner=sha256bytes(concat(ip, utf8(msgStr)));
    return sha256bytes(concat(op, inner));
  }
  function toHex(b){ var s=''; for(var i=0;i<b.length;i++){ var h=b[i].toString(16); s+=h.length<2?'0'+h:h; } return s; }
  function hmacHex(keyStr,msgStr){ return toHex(hmacBytes(keyStr,msgStr)); }
  function u32be(b,o){ return ((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|(b[o+3]))>>>0; }
  function randHex(n){ var a=new Uint8Array(n); (global.crypto||{}).getRandomValues ? global.crypto.getRandomValues(a) : a.forEach(function(_,i){a[i]=Math.floor(Math.random()*256);}); return toHex(a); }
  function clamp(x,lo,hi){ return x<lo?lo:(x>hi?hi:x); }
  var num = function(v){ return (typeof v==='number'?v:parseFloat(v))||0; };

  // ---------- constants (copied verbatim from V1 server.js) ----------
  var P = [0.92,0.78,0.72,0.48,0.30,0.15,0.055,0.020,0.007,0.0022];
  var HOUSE_EDGE = 0.06, LEVELS = P.length, CASHOUT_MIN = 5;
  var POT_LADDER = { 5:0.01, 6:0.03, 7:0.10, 8:0.20, 9:0.30 };
  var potShareFor = function(depth){ return depth>=LEVELS?1.0:(POT_LADDER[depth]||0); };
  var DOORS = { left:{odds:1.22,tier:'cautious'}, center:{odds:1.0,tier:'standard'}, right:{odds:0.72,tier:'greedy'} };
  var baseOdds = function(lvl,door){ return Math.min(0.97, P[lvl-1]*((DOORS[door]||DOORS.center).odds)); };
  var stepReward = function(lvl,door){ return (1-HOUSE_EDGE)/baseOdds(lvl,door); };
  var skillBonusFor = function(lvl){ var b=0.25+((lvl-1)/(LEVELS-1))*0.75; return lvl>=6?b*0.5:b; };
  var effOdds = function(lvl,door,score){ return Math.min(0.985, baseOdds(lvl,door)*(1+Math.max(0,Math.min(1,score))*skillBonusFor(lvl))); };
  var difficultyFor = function(lvl){ return (lvl-1)/(LEVELS-1); };
  var SKILL_V3=false, ODDS_V2=false;   // FROZEN original model (matches hosted free V1)
  var advChance = function(kind,lvl,door,score){ return effOdds(lvl,door,score); };
  var SKILL_GAMES=['dial','lasers','sequence','reflex','wirecut','targets','stopwatch','mash','silentalarm','tumbler','torque','sonicrack','pressureplates','dialcombo','hotwire'];
  var LUCK_GAMES=['wheel','dice','cardflip','coinflip','slots','roulette','shells','scratch','plinko','keno','goldbar','magnetgrab','fuserace','elevatorroulette','safedial'];
  var NERVE_GAMES=['ladder','cascadelocks','vaultstack','dominoes','ziplinebail','minefield','defuse','heisttimer','crank','dive','thermite','staticcharge','crackdrill','nitro','guardsweep'];
  var POOL={ luck:LUCK_GAMES, skill:SKILL_GAMES, nerve:NERVE_GAMES };

  function chamberCategories(seed,level){ var kinds=['luck','skill','nerve'], b=hmacBytes(seed,'cat:'+level);
    var pick=function(i){ return kinds[Math.floor(u32be(b,(i%8)*4)/0xffffffff*3)%3]; }; return { left:pick(0), center:pick(1), right:pick(2) }; }
  function doorsLayout(seed,level){ var cat=chamberCategories(seed,level), out={};
    ['left','center','right'].forEach(function(side){ out[side]={ category:cat[side], tier:(DOORS[side]||{}).tier, odds:baseOdds(level,side), reward:stepReward(level,side) }; }); return out; }

  function roll(serverSeed, clientSeed, nonce){ var h=hmacHex(serverSeed, clientSeed+':'+nonce); return parseInt(h.slice(0,13),16)/0x10000000000000; }
  var _hb = function(seed,tag){ return hmacBytes(seed,tag); };
  var _u = function(buf,i){ return u32be(buf,(i%8)*4)/0xffffffff; };
  function gameForDoor(seed,level,door){ var kind=chamberCategories(seed,level)[door]||'skill'; var pool=POOL[kind]||SKILL_GAMES; var b=_hb(seed,'game:'+level+':'+door); var key=pool[Math.floor(_u(b,0)*pool.length)%pool.length]; return { kind:kind, gameKey:key }; }
  function buildChallenge(gameKey,level,door,seed){
    var d=difficultyFor(level), b=_hb(seed,'ch:'+level+':'+door); var dd=SKILL_V3?Math.pow(d,1.35):0;
    if(gameKey==='dial') return { speed:0.9+d*2.1+dd*1.5, arcW:0.9-d*0.6-dd*0.26, target:_u(b,0)*Math.PI*2, start:_u(b,1)*Math.PI*2, minMs:900 };
    if(gameKey==='lasers'||gameKey==='sonicrack'||gameKey==='dialcombo'||gameKey==='hotwire'){ var rounds=Math.round(2+d*3+dd*1),gaps=[]; for(var k=0;k<rounds;k++)gaps.push({pos:0.12+_u(b,k)*0.76,w:0.34-d*0.15-dd*0.12}); return { rounds:rounds, speed:1.1+d*1.9+dd*1.3, gaps:gaps, minMs:500+rounds*380 }; }
    if(gameKey==='sequence'){ var len=Math.round(3+d*5+dd*1),pads=9,seq=[]; for(var k2=0;k2<len;k2++)seq.push(Math.floor(_u(b,k2)*pads)%pads); return { seq:seq, pads:pads, flashMs:Math.round(600-d*230-dd*140), minMs:500+len*280 }; }
    if(gameKey==='reflex'||gameKey==='quickdraw'||gameKey==='silentalarm') return { greenAt:Math.round(700+_u(b,0)*1600), window:700-d*230-dd*170, minMs:400 };
    if(gameKey==='wirecut'){ var c=0.42+_u(b,0)*0.36; var hw=0.15-d*0.07-dd*0.05; return { travelMs:Math.round(2600-d*1100-dd*700), bandLo:c-hw, bandHi:c+hw, minMs:500 }; }
    if(gameKey==='targets'||gameKey==='catch'||gameKey==='pressureplates') return { n:Math.round(4+d*6+dd*2), span:Math.round(4200-d*1700-dd*900), minMs:800 };
    if(gameKey==='lockpins'){ var rn=Math.round(2+d*3+dd*1),gp=[]; for(var k3=0;k3<rn;k3++)gp.push({pos:0.12+_u(b,k3)*0.76,w:0.34-d*0.15-dd*0.12}); return { rounds:rn, speed:1.1+d*1.9+dd*1.3, gaps:gp, minMs:500+rn*380 }; }
    if(gameKey==='stopwatch'||gameKey==='tumbler') return { target:Math.round(1400+_u(b,0)*2200), tol:Math.round(760-d*360-dd*230), minMs:500 };
    if(gameKey==='mash'||gameKey==='drilldepth') return { need:Math.round(9+d*15+dd*6), win:Math.round(3200-d*1000-dd*700), minMs:700 };
    if(gameKey==='holddrill'||gameKey==='crank'||gameKey==='pressure'||gameKey==='overload'||gameKey==='dive'||gameKey==='thermite'||gameKey==='staticcharge'||gameKey==='crackdrill'||gameKey==='nitro'||gameKey==='guardsweep') return { maxMs:Math.round(3000-d*1400), danger:0.5+_u(b,0)*(0.45-d*0.1), warn:0.5, minMs:500 };
    if(gameKey==='ladder'||gameKey==='minefield'||gameKey==='cascadelocks'||gameKey==='ziplinebail'||gameKey==='defuse'||gameKey==='vaultstack'||gameKey==='heisttimer'||gameKey==='dominoes'){ var rungs=Math.round(5+d*5); return { rungs:rungs, fail:1+Math.floor(_u(b,0)*rungs), minMs:500 }; }
    if(gameKey==='tightrope'||gameKey==='torque'||gameKey==='coolant'||gameKey==='balancescale'||gameKey==='gripandpry'||gameKey==='rappel'||gameKey==='surge'){ var cc=0.35+_u(b,0)*0.4, hw2=0.15-d*0.06-dd*0.05; return { maxMs:Math.round(2800-d*1100-dd*750), lo:cc-hw2, hi:cc+hw2, minMs:500 }; }
    if(gameKey==='wheel') return { segments:8, minMs:900 };
    if(gameKey==='dice') return { minMs:800 };
    if(gameKey==='cardflip') return { cards:3, minMs:700 };
    if(gameKey==='coinflip') return { minMs:700 };
    if(gameKey==='slots') return { reels:3, minMs:900 };
    if(gameKey==='roulette') return { minMs:1000 };
    if(gameKey==='shells') return { cups:3, minMs:800 };
    if(gameKey==='scratch') return { cells:6, minMs:700 };
    if(gameKey==='plinko') return { rows:8, minMs:1100 };
    if(gameKey==='keno') return { cells:9, minMs:800 };
    if(gameKey==='colorbet') return { minMs:700 };
    if(gameKey==='goldbar') return { bars:5, minMs:800 };
    if(gameKey==='cookie') return { minMs:700 };
    if(gameKey==='drawstraw') return { straws:5, minMs:700 };
    return { options:3, minMs:700 };
  }
  function scoreEvents(gameKey,ch,events){
    var taps=(events||[]).filter(function(e){ return e&&isFinite(e.t); });
    if(gameKey==='dial'){ var lock=taps.find(function(e){return e.type==='lock';}); if(!lock)return 0; var a=(ch.start+ch.speed*(lock.t/1000))%(Math.PI*2); var dd=Math.abs(((a-ch.target+Math.PI*3)%(Math.PI*2))-Math.PI); return clamp(1-dd/(ch.arcW*2.2),0,1); }
    if(gameKey==='lasers'||gameKey==='lockpins'||gameKey==='sonicrack'||gameKey==='dialcombo'||gameKey==='hotwire'){ var hits=taps.filter(function(e){return e.type==='tap';}); if(hits.length<ch.rounds)return 0; var s=0; for(var k=0;k<ch.rounds;k++){ var e=hits[k]; if(!e)return 0; var m=Math.abs(((ch.speed*(e.t/1000))%2)-1); var g=ch.gaps[k]; var rs=clamp(1-Math.abs(m-g.pos)/(g.w*0.9),0,1); if(rs<=0)return 0; s+=rs; } return clamp(s/ch.rounds,0,1); }
    if(gameKey==='sequence'){ var picks=taps.filter(function(e){return e.type==='pad';}); var correct=0; for(var k2=0;k2<ch.seq.length;k2++){ if(picks[k2]&&picks[k2].idx===ch.seq[k2])correct++; else break; } return correct>=ch.seq.length?1:0; }
    if(gameKey==='holddrill'||gameKey==='crank'||gameKey==='pressure'||gameKey==='overload'||gameKey==='dive'||gameKey==='thermite'||gameKey==='staticcharge'||gameKey==='crackdrill'||gameKey==='nitro'||gameKey==='guardsweep'){ var stop=taps.find(function(e){return e.type==='stop';}); if(!stop)return 0; var f=clamp(stop.t/ch.maxMs,0,1); return f<=ch.danger?clamp(f/ch.danger,0,1):0; }
    if(gameKey==='reflex'||gameKey==='quickdraw'||gameKey==='silentalarm'){ var tap=taps.find(function(e){return e.type==='tap';}); if(!tap)return 0; if(tap.t<ch.greenAt)return 0; return clamp(1-(tap.t-ch.greenAt)/ch.window,0,1); }
    if(gameKey==='wirecut'){ var cc=taps.find(function(e){return e.type==='cut';}); if(!cc)return 0; var ff=cc.t/ch.travelMs; if(ff<ch.bandLo||ff>ch.bandHi)return 0; var mid=(ch.bandLo+ch.bandHi)/2,hw=(ch.bandHi-ch.bandLo)/2; return clamp(1-Math.abs(ff-mid)/hw,0,1); }
    if(gameKey==='targets'||gameKey==='catch'||gameKey==='pressureplates'){ var n=taps.filter(function(e){return e.type==='tap';}).length; return n>=ch.n?1:0; }
    if(gameKey==='stopwatch'||gameKey==='tumbler'){ var ss=taps.find(function(e){return e.type==='stop';}); if(!ss)return 0; return clamp(1-Math.abs(ss.t-ch.target)/ch.tol,0,1); }
    if(gameKey==='mash'||gameKey==='drilldepth'){ var nn=taps.filter(function(e){return e.type==='tap';}).length; return nn>=ch.need?1:0; }
    if(gameKey==='ladder'||gameKey==='minefield'||gameKey==='cascadelocks'||gameKey==='ziplinebail'||gameKey==='defuse'||gameKey==='vaultstack'||gameKey==='heisttimer'||gameKey==='dominoes'){ var c=Math.min(taps.filter(function(e){return e.type==='climb';}).length,ch.rungs); return c<ch.fail?clamp(c/ch.rungs,0,1):0; }
    if(gameKey==='tightrope'||gameKey==='torque'||gameKey==='coolant'||gameKey==='balancescale'||gameKey==='gripandpry'||gameKey==='rappel'||gameKey==='surge'){ var s2=taps.find(function(e){return e.type==='stop';}); if(!s2)return 0; var f2=clamp(s2.t/ch.maxMs,0,1); return (f2>=ch.lo&&f2<=ch.hi)?clamp(1-Math.abs(f2-(ch.lo+ch.hi)/2)/(((ch.hi-ch.lo)/2)||1),0,1):0; }
    return null;
  }
  function sanitizeParams(gameKey,ch){ var c={}; for(var k in ch) c[k]=ch[k]; delete c.danger; delete c.fail; if(gameKey!=='torque'){ delete c.lo; delete c.hi; } if(gameKey==='sequence'){ c.seqLen=(ch.seq||[]).length; delete c.seq; } return c; }

  // ---------- run state in localStorage ----------
  var LS=global.localStorage;
  function getRun(id){ try{ return JSON.parse(LS.getItem('rtv1_run_'+id)); }catch(e){ return null; } }
  function setRun(r){ try{ LS.setItem('rtv1_run_'+r.runId, JSON.stringify(r)); }catch(e){} return r; }
  var FEE=1000, BURN_SHARE=0.5, CHIPS=FEE*(1-BURN_SHARE), POT_SEED=250000;   // cosmetic free-play pot

  var CONFIG = { levels:LEVELS, doors:DOORS, categories:['luck','skill','nerve'], burnShare:BURN_SHARE, fee:0, chips:0,
    cashoutMin:CASHOUT_MIN, potLadder:POT_LADDER, token:null, pair:null, creatorBps:0, mintSpots:false, coreChoice:false,
    noMint:true, freeOnly:true, freePlay:true, testnet:true, openSource:true };

  var API = {
    config: function(){ return CONFIG; },
    state: function(){ return { jackpotEth:0, potRvlt:POT_SEED, burnedRvlt:0, plays:0, robs:0, jackpotUsd:0, recent:[], board:[] }; },
    recentWins: function(){ return { wins:[] }; },
    enter: function(body){
      var clientSeed=(body&&body.clientSeed)||randHex(8), serverSeed=randHex(32), runId=randHex(12);
      var serverHash=toHex(sha256bytes(utf8(serverSeed)));
      setRun({ runId:runId, serverSeed:serverSeed, serverHash:serverHash, clientSeed:clientSeed, nonce:0, depth:0, mult:1, status:'open', cur:null });
      return { runId:runId, serverHash:serverHash, clientSeed:clientSeed, fee:0, burned:0, chips:0, levels:LEVELS, doors:doorsLayout(serverSeed,1) };
    },
    miniStart: function(body){
      var run=getRun(body&&body.runId); if(!run||run.status!=='open') return { error:'no open run' };
      var door=['left','center','right'].indexOf(body&&body.door)>=0?body.door:'center';
      var level=num(run.depth)+1; if(level>LEVELS) return { error:'cleared' };
      var gd=gameForDoor(run.serverSeed,level,door), ch=buildChallenge(gd.gameKey,level,door,run.serverSeed);
      run.cur={ gameKey:gd.gameKey, kind:gd.kind, door:door, level:level, ch:ch, startTs:Date.now() }; setRun(run);
      var p=sanitizeParams(gd.gameKey,ch); p._rid=run.runId;
      return { gameKey:gd.gameKey, kind:gd.kind, door:door, level:level, tier:(DOORS[door]||{}).tier, minMs:ch.minMs, params:p };
    },
    miniStep: function(q){
      var run=getRun(q&&q.rid); if(!run||!run.cur||run.cur.gameKey!=='sequence') return { done:true };
      var seq=run.cur.ch.seq||[], i=Math.max(0,parseInt((q&&q.i)||0,10)); if(i>=seq.length) return { done:true };
      return { pad:seq[i], i:i };
    },
    crack: function(body){
      var run=getRun(body&&body.runId); if(!run||run.status!=='open') return { error:'no open run' };
      if(!run.cur) return { error:'no active challenge, step through a door first' };
      var act=run.cur; run.cur=null; var door=act.door, level=num(run.depth)+1;
      if(level>LEVELS) return { error:'cleared' };
      var events=Array.isArray(body&&body.events)?body.events.slice(0,400):[];
      var raw=scoreEvents(act.gameKey,act.ch,events);   // null for luck
      var human=1, flagged=false;
      var score=act.kind!=='luck'?Math.max(0,Math.min(1,raw||0)):0;
      var nonce=num(run.nonce)+1; var r=roll(run.serverSeed,run.clientSeed,nonce);
      var failedMini=act.kind!=='luck'&&!(score>0);
      var success=!failedMini && r<advChance(act.kind,level,door,score);
      if(success){
        run.depth=level; run.nonce=nonce; run.mult=(num(run.mult)||1)*stepReward(level,door);
        var robbed=level===LEVELS; setRun(run);
        var out={ success:true, level:level, door:door, gameKey:act.gameKey, kind:act.kind, score:score, human:human, flagged:flagged, potShare:potShareFor(level), robbed:robbed };
        if(robbed){ run.status='robbed'; setRun(run); out.serverSeed=run.serverSeed; out.jackpotEth=0; out.wonRvlt=POT_SEED; }
        else { out.doors=doorsLayout(run.serverSeed,level+1); }
        return out;
      } else {
        run.status='busted'; run.nonce=nonce; setRun(run);
        var reveal=null;
        if(failedMini){
          var CLIMB=['ladder','minefield','cascadelocks','ziplinebail','defuse','vaultstack','heisttimer','dominoes'];
          var GAUGE=['holddrill','crank','pressure','overload','dive','thermite','staticcharge','crackdrill','nitro','guardsweep'];
          if(CLIMB.indexOf(act.gameKey)>=0&&act.ch.fail!=null){ var c=events.filter(function(e){return e&&e.type==='climb';}).length; reveal={ mini:'climb', trap:act.ch.fail, reached:c, total:act.ch.rungs }; }
          else if(GAUGE.indexOf(act.gameKey)>=0&&act.ch.danger!=null){ var st=events.find(function(e){return e&&e.type==='stop';}); var f=st?Math.max(0,Math.min(1,st.t/act.ch.maxMs)):1; reveal={ mini:'gauge', line:Math.round(act.ch.danger*100), held:Math.round(f*100) }; }
        }
        return { success:false, level:level, door:door, gameKey:act.gameKey, kind:act.kind, score:score, human:human, flagged:flagged, serverSeed:run.serverSeed, reveal:reveal };
      }
    },
    cashout: function(body){
      var run=getRun(body&&body.runId); if(!run||run.status!=='open') return { error:'no open run' };
      var depth=num(run.depth); if(depth<CASHOUT_MIN) return { error:'cash-out unlocks at chamber '+CASHOUT_MIN };
      run.status='cashed'; setRun(run); var share=potShareFor(depth); var won=Math.max(0,Math.round(POT_SEED*share));
      return { won:won, depth:depth, potShare:share, serverSeed:run.serverSeed };
    },
    forfeit: function(body){ var run=getRun(body&&body.runId); if(run&&run.status==='open'){ run.status='busted'; setRun(run); } return { ok:true }; },
    runById: function(id){ var r=getRun(id); return r?{ runId:r.runId, depth:r.depth, mult:r.mult, status:r.status, serverHash:r.serverHash }:{ error:'not found' }; }
  };
  global.RTVEngineV1 = API;
})(typeof window!=='undefined'?window:this);
