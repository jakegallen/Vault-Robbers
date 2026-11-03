// THE VAULT STANDOFF, Phase 1 MVP (server-authoritative, in-memory, FAKE CHIPS, no chain).
// Two cadence engines:
//   FILL (default) = demand-driven. Seats fill toward a cap; once the majority threshold is
//                    crossed a fuse arms; when the fuse ends (or the cap fills) the heist runs
//                    with whoever bought in. Runs more games, feels alive.
//   CLOCK          = fixed schedule (dev fast / compressed daily / real daily), switchable.
// Final chamber = THE SPLIT. Persistent login, prechoose (buy in, set path, leave, come back), chat.
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');   // real-time push layer (additive; the HTTP poll stays the fallback)
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { verifyMessage, keccak256, toUtf8Bytes, formatUnits } = require('ethers');   // H7: server-side wallet-signature (SIWE-style) verification
const escrow = require('./escrow');            // on-chain buy-in escrow + settlement (Option D); inert unless VS_ESCROW=on
const robbers = require('./robbers');          // Vault Robbers NFT utility: per-heist airdrop TBA reads + claim calldata (read-only; owner signs)
const app = express();

// ---- VERIFIABILITY CORE ----------------------------------------------------------------------------------
// Every outcome-affecting random draw is a PURE function of the round's committed seed. The seed is generated
// and committed (its keccak256 hash) BEFORE the round plays; at settle the seed is revealed so anyone can
// recompute the whole game: keccak256(seed, roundId, step) -> a deterministic 2^53 stream. No Math.random
// ever touches an outcome. The same derivation runs in the browser (api/round/:id/proof + the Verify button),
// so the published result is independently reproducible from on-chain data + the revealed seed.
//
// prng(seed, roundId, label) returns a function yielding floats in [0,1). `label` namespaces a draw so two
// independent draws in the same chamber (e.g. forced-bust vs bot-pick) never share a stream.
function prng(seed, roundId, label){
  let ctr = 0;
  const base = String(seed) + ':' + String(roundId) + ':' + String(label);
  let pool = Buffer.alloc(0), off = 0;
  function refill(){ pool = Buffer.from(keccak256(toUtf8Bytes(base + ':' + (ctr++))).slice(2), 'hex'); off = 0; }
  return function(){
    if(off + 6 > pool.length) refill();
    // 48 bits of entropy -> a double in [0,1); plenty for door counts / coin flips.
    let v = 0; for(let i=0;i<6;i++){ v = v * 256 + pool[off+i]; }
    off += 6;
    return v / 281474976710656; // 2^48
  };
}
// Durable store (disk, git-excluded via .gitignore): committed seeds survive a restart so an orphaned round
// can still settle (no stuck pot), and settled-round proofs are append-only and publicly replayable.
const STORE_DIR = path.join(__dirname, '.vs-store');
const SEED_FILE = path.join(STORE_DIR, 'seeds.json');       // { [roundId]: { seed, hash } }  (seed kept until reveal at settle)
const PICKS_FILE = path.join(STORE_DIR, 'picks.jsonl');     // append-only: one JSON line per logged pick
const PROOF_FILE = path.join(STORE_DIR, 'proofs.json');     // { [roundId]: { seed, tickets, picks, bustedByChamber, winner, ts } }
// H-3/M-4: the store holds committed seeds, gate sessions, and auto-buy metadata — create it OWNER-ONLY (0700)
// so other local users can't list or read these files.
try { fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 }); } catch(_){}
function loadJson(f, fb){ try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch(_){ return fb; } }
// H-3/M-4: every persisted store file is written mode 0600 (owner read/write only). The chmod runs AFTER the
// atomic rename and is wrapped so a chmod failure (e.g. a filesystem that doesn't support it) never crashes a save.
function saveJsonAtomic(f, obj){ try { const t=f+'.tmp'; fs.writeFileSync(t, JSON.stringify(obj), { mode: 0o600 }); fs.renameSync(t, f); try { fs.chmodSync(f, 0o600); } catch(_){} } catch(_){} }
// WRITE COALESCING (efficiency): some stores call saveJsonAtomic on EVERY mutation (write amplification on the hot
// 1s loop). For NON-money-critical stores (autoplay prechoices, win-streak optics) a short debounce coalesces a
// burst of mutations into one disk write. We DELIBERATELY do NOT debounce the money-critical stores (payout queue,
// auto-buy authorizations, seeds, rmround counter, config) — those stay fully durable (synchronous write per
// mutation) so a crash can never lose an entry mid-window. `flushFn` reads the live store at flush time, so the
// debounced write always persists the MOST RECENT state. A process-exit flush (below) guarantees no pending
// debounced write is lost on a clean shutdown. Worst case on a hard crash: the last <=delay ms of autoplay/streak
// mutations are lost, which is acceptable per the hardening brief (advisory/optics data, self-heals next round).
const _debouncers=[];
function makeDebouncedSaver(flushFn, delayMs){ let t=null; const d=()=>{ if(t) return; t=setTimeout(()=>{ t=null; try{ flushFn(); }catch(_){} }, delayMs); }; d._flush=()=>{ if(t){ clearTimeout(t); t=null; } try{ flushFn(); }catch(_){} }; _debouncers.push(d); return d; }
function flushAllDebounced(){ for(const d of _debouncers){ try{ d._flush(); }catch(_){} } }
try{ process.on('exit', ()=>{ flushAllDebounced(); }); }catch(_){}
['SIGINT','SIGTERM'].forEach(ev=>{ try{ process.on(ev, ()=>{ flushAllDebounced(); process.exit(0); }); }catch(_){} });
// SEED-AT-REST ENCRYPTION (SEC fix): a round's committed seed determines every outcome and MUST stay secret until
// it is revealed at settle. Held in memory in plaintext for the running game, but PERSISTED ENCRYPTED (AES-256-GCM)
// so reading seeds.json off disk/backup alone cannot reveal a not-yet-settled round. Key is DERIVED from a sealed
// env secret (VS_SEED_KEY, else escrow signer key, else admin token) with a domain tag; NEVER written to disk. The
// public `hash` (on-chain commit) stays plaintext. Legacy plaintext entries are re-encrypted on boot.
function _seedKeyMaterial(){ return String(process.env.VS_SEED_KEY||process.env.VS_ESCROW_SIGNER_PK||process.env.VS_ADMIN_TOKEN||''); }
let _seedEncKey=null;
function seedEncKey(){ if(_seedEncKey) return _seedEncKey; _seedEncKey=crypto.createHash('sha256').update(_seedKeyMaterial()+':vs-seed-at-rest-v1').digest(); return _seedEncKey; }
function encryptSeed(seed){ try{ const iv=crypto.randomBytes(12); const c=crypto.createCipheriv('aes-256-gcm',seedEncKey(),iv); const ct=Buffer.concat([c.update(String(seed),'utf8'),c.final()]); return 'v1:'+iv.toString('hex')+':'+ct.toString('hex')+':'+c.getAuthTag().toString('hex'); }catch(_){ return null; } }
function decryptSeed(enc){ try{ if(typeof enc!=='string'||enc.slice(0,3)!=='v1:') return null; const p=enc.split(':'); const d=crypto.createDecipheriv('aes-256-gcm',seedEncKey(),Buffer.from(p[1],'hex')); d.setAuthTag(Buffer.from(p[3],'hex')); return Buffer.concat([d.update(Buffer.from(p[2],'hex')),d.final()]).toString('utf8'); }catch(_){ return null; } }
function _seedDiskSnapshot(){ const out={}; for(const k in SEED_STORE){ const r=SEED_STORE[k]; if(!r) continue; const enc=(r.seed!=null)?encryptSeed(r.seed):(r.encSeed||null); out[k]=enc?{encSeed:enc,hash:r.hash}:{hash:r.hash}; } return out; }
function saveSeeds(){ saveJsonAtomic(SEED_FILE, _seedDiskSnapshot()); }
const _SEED_RAW = loadJson(SEED_FILE, {});
const SEED_STORE = {};
(function _loadSeeds(){ let hadPlain=false; for(const k in _SEED_RAW){ const r=_SEED_RAW[k]; if(!r) continue;
  if(r.seed!=null){ SEED_STORE[k]={seed:r.seed,hash:r.hash}; hadPlain=true; }
  else if(r.encSeed){ const s=decryptSeed(r.encSeed); if(s==null) console.error('[vaultstandoff-dev] WARN: seed decrypt FAILED for round '+k+' (encryption key material changed?) — this round can no longer settle and will VOID/refund; verify VS_SEED_KEY/VS_ESCROW_SIGNER_PK/VS_ADMIN_TOKEN are stable'); SEED_STORE[k]={seed:(s!=null?s:null),hash:r.hash}; }
  else { SEED_STORE[k]={seed:null,hash:r.hash}; } }
  if(hadPlain){ try{ saveSeeds(); console.log('[vaultstandoff-dev] migrated plaintext seeds.json -> encrypted-at-rest'); }catch(_){} }
})();
const PROOF_STORE = loadJson(PROOF_FILE, {});   // persisted settled-round proofs
function persistSeed(roundId, seed, hash){ SEED_STORE[String(roundId)] = { seed, hash }; saveSeeds(); }
function getSeed(roundId){ const r = SEED_STORE[String(roundId)]; return r ? r.seed : null; }
// Return (generating + persisting once) the committed {seed,hash} for a round. This is the SINGLE source of
// truth for a round's seed: the game is driven by `seed` and the on-chain commit uses `hash`, so the revealed
// seed at settle always matches the committed hash. Persisted (encrypted) to disk so a restart can still settle.
function ensureRoundSeed(roundId){ const k=String(roundId); let r=SEED_STORE[k]; if(!r){ const s=escrow.newSeed(); r={seed:s.seed,hash:s.hash}; SEED_STORE[k]=r; saveSeeds(); } return r; }
// pick log: hash the player's token so a raw token is NEVER written to disk or exposed; door + ts are plain.
function tokenHash(tok){ return tok ? keccak256(toUtf8Bytes('vs-pick:' + String(tok))).slice(2,18) : null; }
function logPick(roundId, tok, chamber, door){
  try { fs.appendFileSync(PICKS_FILE, JSON.stringify({ roundId:String(roundId), th:tokenHash(tok), ch:chamber, door, ts:Date.now() }) + '\n'); } catch(_){}
}
function picksForRound(roundId){
  const out=[]; const rid=String(roundId);
  try { const lines=fs.readFileSync(PICKS_FILE,'utf8').split('\n'); for(const ln of lines){ if(!ln)continue; try{ const o=JSON.parse(ln); if(o.roundId===rid) out.push(o); }catch(_){} } } catch(_){}
  return out;
}
function persistProof(roundId, proof){ PROOF_STORE[String(roundId)] = proof; saveJsonAtomic(PROOF_FILE, PROOF_STORE); }

// ---- V2 DURABLE STORES (features 2-3) --------------------------------------------------------------------
// HOLDER DISCOUNT (2026-10-10): the holder discount is now applied ON-CHAIN at buy time by the V4 contract
// (entryPriceFor halves the per-ticket price for a Vault Robbers NFT holder). The old off-chain TREASURY REBATE
// ledger that assumed the pot received FULL entry has been REMOVED to avoid double-counting the discount. The
// contract (escrow.entryPriceFor / escrow.requiredRvltWei / escrow.isHolder) is the ONLY source of truth.
// FEATURE 2 — recurring auto-play strategy + durable autoplay flag, keyed by player token (w:addr or u_...).
// Survives restart so an away player keeps playing with their chosen doors each new round.
const AUTOPLAY_FILE = path.join(STORE_DIR, 'autoplay.json');   // { [token]: { on:bool, pre:[doors|null], ts } }
const AUTOPLAY_STORE = loadJson(AUTOPLAY_FILE, {});
// DEBOUNCED (efficiency): autoplay prechoices are re-applied every round boundary and toggled by player action; a
// 2s debounce coalesces bursts. Non-money-critical (worst case: a prechoice set <2s before a hard crash is re-entered
// by the player next round), so a short debounce is safe here per the hardening brief.
const _saveAutoplay=makeDebouncedSaver(()=>saveJsonAtomic(AUTOPLAY_FILE, AUTOPLAY_STORE), 2000);
function saveAutoplay(){ _saveAutoplay(); }
// FEATURE 2 — active auto-buy authorizations (EIP-712 AutoBuy), keyed by lowercased player address. Each entry
// is a bounded, replay-safe authorization the relayer may submit once per round until budget/expiry is spent.
const AUTOBUY_FILE = path.join(STORE_DIR, 'autobuy.json');   // { [addr]: { player, maxTickets, perRound, maxEntry, deadline, auths:[{roundId,nonce,sig:null-on-disk,spent}], roundsLeft, spent:[ids], lastRoundId } } — raw sigs are MEMORY-ONLY (L-2)
const AUTOBUY_STORE = loadJson(AUTOBUY_FILE, {});
// ANTI-WHALE LIMITER: consecutive-win cooldown. A wallet that WINS `STREAK_FREEZE_AT` games IN A ROW is frozen from
// buying into new rounds for `STREAK_COOLDOWN_MS`. Streak resets to 0 the moment that wallet plays a round and does
// NOT win. MUST persist (a restart must not wipe an active 24h freeze, else the limiter is trivially bypassed).
// Keyed by lowercase wallet address. { [addr]: { streak, frozenUntil } }. Note: a determined player can Sybil to a
// fresh wallet (same as the per-wallet seat cap); this is a fairness/optics guard, paired with that cap.
const STREAK_FREEZE_AT = 3;
const STREAK_COOLDOWN_MS = 24 * 3600 * 1000;   // 24h
const CHALLENGE_SEC = 300;                     // contract challenge window (matches deploy ESCROW_CHALLENGE); keeper gates on-chain anyway
const WINSTREAK_FILE = path.join(STORE_DIR, 'winstreak.json');
const WIN_STREAK = loadJson(WINSTREAK_FILE, {});
// DEBOUNCED (efficiency): recordWinStreak writes the whole map at every game-end. That is once per game (NOT the hot
// 1s loop), so the amplification is mild; a SHORT 1s debounce coalesces the per-game batch (every participant's
// streak reset + the winner's bump) into one write. The streak freeze is a fairness/optics lever (the hard anti-whale
// guard is the on-chain maxTicketsPerWallet cap), and the exit-flush persists any pending write on a clean shutdown,
// so the only loss window is the last <=1s before a HARD crash — acceptable per the hardening brief.
const _saveWinStreak=makeDebouncedSaver(()=>saveJsonAtomic(WINSTREAK_FILE, WIN_STREAK), 1000);
function saveWinStreak(){ _saveWinStreak(); }
function isFrozen(addr){ if(!addr) return 0; const w=WIN_STREAK[String(addr).toLowerCase()]; return (w && w.frozenUntil && Date.now()<w.frozenUntil) ? w.frozenUntil : 0; }
// AUTO-PAYOUT keeper queue: rounds settled this session awaiting a post-challenge-window push to winners (auto-send,
// so nobody clicks "collect"). PERSISTED to disk (reliability fix) so a restart mid-window does not silently drop
// the auto-send; claim() remains the on-chain fallback. { id: {winners,after,tries,winnersPaid,rakePaid,rakeTries} }
const PAYOUT_FILE = path.join(STORE_DIR, 'payout-queue.json');
const PAYOUT_QUEUE = loadJson(PAYOUT_FILE, {});
function savePayoutQueue(){ saveJsonAtomic(PAYOUT_FILE, PAYOUT_QUEUE); }
// #222 ROSTER-RECOVERY (settle survives restart): persist the DECIDED champion ADDRESSES per round id. The dangerous
// window is "engine decided a winner" -> "settleEqualSplit mined": a restart in that gap wipes in-memory G.champ, and
// the settle-watcher cannot rebuild the winner from the public proof (which stores token HASHES, not addresses, by
// design) so it VOIDS the round and refunds instead of paying the winner. Persisting the resolved winner addresses
// lets the watcher SETTLE to the real winner across a restart (still re-validated on-chain via isParticipant before
// any settle). Stored in the OWNER-ONLY (0700) store dir, never served; these are winner addresses of a finished
// round that the on-chain settle reveals anyway, so no door-choice edge is leaked. { [roundId]: { addrs:[0x..], ts } }
const CHAMP_FILE = path.join(STORE_DIR, 'champ-recovery.json');
const CHAMP_STORE = loadJson(CHAMP_FILE, {});
function saveChampStore(){ try{ saveJsonAtomic(CHAMP_FILE, CHAMP_STORE); }catch(_){} }
function persistChamp(id, addrs){ try{
  const a=[...new Set((addrs||[]).map(x=>String(x).toLowerCase()).filter(x=>/^0x[0-9a-f]{40}$/.test(x)))]; if(!a.length) return;
  const k=String(id), prev=CHAMP_STORE[k];
  if(prev && Array.isArray(prev.addrs) && prev.addrs.length===a.length && prev.addrs.every((v,i)=>v===a[i])) return;  // unchanged -> no write
  CHAMP_STORE[k]={ addrs:a, ts:Date.now() };
  const cut=Date.now()-6*3600*1000; for(const kk of Object.keys(CHAMP_STORE)){ if((CHAMP_STORE[kk].ts||0)<cut) delete CHAMP_STORE[kk]; }  // bounded: drop entries older than 6h (>> the 1h challenge window)
  saveChampStore();
}catch(_){} }
// PAYOUT KEEPER TELEMETRY (MED-2): in-memory only, surfaced on the admin dashboard so a stranded winner payout or
// rake sweep is visible instead of dying in a console.error. PAYOUT_ALERTS keeps the last ~20 drops; PAYOUT_STATS
// tracks the most recent per-attempt failure. All writes are defensive and never throw back into the keeper.
const PAYOUT_ALERTS = [];
const PAYOUT_STATS = { lastError:null, lastErrorTs:0, drops:0 };
function recordPayoutFail(err){ try{ PAYOUT_STATS.lastError = String(err && (err.shortMessage||err.message) || err || 'unknown').slice(0,240); PAYOUT_STATS.lastErrorTs = Date.now(); }catch(_){} }
function recordPayoutDrop(roundId, kind, attempts, lastError){ try{ PAYOUT_ALERTS.push({ roundId:String(roundId), kind, attempts, ts:Date.now(), lastError:(lastError==null?null:String(lastError).slice(0,240)) }); while(PAYOUT_ALERTS.length>20) PAYOUT_ALERTS.shift(); PAYOUT_STATS.drops++; }catch(_){} }
// AUTO-PAYOUT schedule: read the ACTUAL on-chain claimAt (settle time + whatever challenge the contract is configured
// with) so the keeper waits the real window regardless of its value. On-chain challenge is currently 3600s on mainnet
// but 300s on testnet; hardcoding CHALLENGE_SEC would make the keeper give up before a longer window elapses. Fall back
// to the CHALLENGE_SEC estimate if the read fails (keeper also re-reads/backs-off, so a wrong estimate still recovers).
async function schedulePayout(id, addrs){
  if(!addrs||!addrs.length) return;
  let after = Date.now() + CHALLENGE_SEC*1000 + 15000;
  try{ const ca = await escrow.claimAtOf(id); if(ca>0) after = ca*1000 + 15000; }catch(_){}
  PAYOUT_QUEUE[String(id)]={ winners:addrs.slice(), after, tries:0, winnersPaid:false, rakePaid:false, rakeTries:0 };
  savePayoutQueue();
}
let JACKPOT_RVLT = 0;   // last-read progressive jackpot (human RVLT), refreshed on the throttled escrow sync; shown in /api/state
// `_inflight` is a TRANSIENT in-memory lock (buyInFor mining in progress); never persist it, and clear any that
// a crash left behind on load, so a restart never leaves an authorization permanently blocked from relaying.
// MIGRATION (HIGH-1): older records persisted a single {nonce,sig}; wrap them into the new ordered auths[] array
// so the array-driven autoBuyTick treats a legacy one-shot auth as a one-element budget.
Object.keys(AUTOBUY_STORE).forEach(k=>{ const a=AUTOBUY_STORE[k]; if(!a) return; delete a._inflight;
  // HIGH-4: a legacy record may carry a top-level `sig` (a bearer secret). NULL it immediately on load so it can
  // never surface via admin metrics or an interim read before the migration's `delete a.sig` / the next saveAutobuy.
  if('sig' in a) a.sig=null;
  // RANGE-REPLAY (LOW): a V6 range record's rangeSpent is the OFF-CHAIN per-round replay guard, persisted by
  // saveAutobuy and reloaded here, so a restart can NEVER replay a round already relayed for the range. Guarantee it
  // is an array after load (a corrupt/absent value must not read as undefined and let the relayer re-submit). The
  // memory-only range sig is null on disk, so autoBuyTick stays inert until the player re-arms; the re-arm path
  // (/api/autobuy) carries this rangeSpent forward when the same range is re-armed.
  if(a.range && !Array.isArray(a.rangeSpent)) a.rangeSpent=[];
  if(!Array.isArray(a.auths)){
    // A legacy single-{nonce,sig} record had no bound roundId stored. If it was already spent, migrate it as a
    // retired one-element history. If it was UNSPENT we can't know which round its signature was bound to (the
    // on-chain struct signs over roundId), so we RETIRE it rather than risk submitting into the wrong round — the
    // player simply re-authorizes under the new array API. This only affects in-flight pre-signed testnet auths.
    const spentSingle=(Array.isArray(a.spent)&&a.spent.length>0);
    a.auths=[{ roundId:String(a.lastRoundId||'0'), nonce:(typeof a.nonce==='number'?a.nonce:parseInt(a.nonce,10)||0), sig:null, spent:true, spentRound:(a.lastRoundId||null), tx:a.lastTx||null }];
    a.startNonce=a.auths[0].nonce;
    a.roundsLeft=0;
    a.retiredReason=a.retiredReason||(spentSingle?'legacy single-auth (spent)':'legacy single-auth migrated to array API; re-authorize to continue');
    delete a.nonce; delete a.sig;
  }
});
function saveAutobuy(){
  // L-2: raw EIP-712 signatures are a bearer secret (they authorize spending the player's bounded RVLT allowance
  // until consumed). Keep them IN MEMORY ONLY — persist just the non-secret metadata. On a restart the loaded
  // auths carry sig:null, and _nextUnspentAuth() already treats a null-sig entry as unusable, so pending
  // authorizations are harmlessly dropped and the player simply re-arms. Already-spent auths persist as history.
  const snap={};
  for(const k in AUTOBUY_STORE){
    const o=Object.assign({}, AUTOBUY_STORE[k]); delete o._inflight;
    if(Array.isArray(o.auths)) o.auths=o.auths.map(x=>Object.assign({}, x, { sig:null }));   // never write a live sig to disk
    if(o.range) o.range=Object.assign({}, o.range, { sig:null });   // V6: range sig is MEMORY-ONLY too (restart drops it -> player re-arms)
    snap[k]=o;
  }
  saveJsonAtomic(AUTOBUY_FILE, snap);
}

// ---- dev password gate ----
// The password comes from VS_PASSWORD. A weak hardcoded default is allowed ONLY in a clearly non-production
// context (escrow off, or escrow on a non-mainnet chain); if real money is live on mainnet and VS_PASSWORD is
// unset, refuse to boot rather than ship a publicly-known password in front of a money app.
const _escCfg = escrow.config();
const _prodMoney = !!(escrow.isOn() && Number(_escCfg.chainId) === 4663);
if (_prodMoney && !process.env.VS_PASSWORD) {
  console.error('[vaultstandoff-dev] FATAL: real-money escrow on mainnet requires VS_PASSWORD (no default). Refusing to boot.');
  process.exit(1);
}
// HIGH-4: KEY-SEPARATION ENFORCEMENT. The settlement signer, auto-buy relayer, and owner/deployer
// roles must be DISTINCT keys so a single leak has a bounded blast radius. Enforced only when escrow is actually ON
// (fake-chip preview provisions no keys). On PROD (mainnet 4663) ANY collapse is FATAL — refuse to boot. On testnet
// (46630) a shared key stays allowed for the dry run but logs a LOUD, explicit warning naming the collapsed roles.
if (escrow.isOn()) {
  const sep = escrow.keySeparationReport();
  if (!sep.clean) {
    const list = sep.collisions.map(c => `${c.a}==${c.b} (${c.addr})`).join(', ');
    if (sep.prod) {
      console.error('[vaultstandoff-dev] FATAL: privileged key reuse on MAINNET (4663) — roles must be distinct keys. Collapsed: ' + list + '. Refusing to boot.');
      process.exit(1);
    } else {
      console.warn('[vaultstandoff-dev] WARNING (TESTNET 46630): privileged keys are COLLAPSED — ' + list + '. This is tolerated ONLY on testnet for the dry run. Mainnet go-live REQUIRES three distinct keys (settlement signer / auto-buy relayer / owner-deployer).');
    }
  }
}
const PW = process.env.VS_PASSWORD ;   // dev-only default; never reached in prod-money (guarded above)
function cookies(req){ const h=req.headers.cookie||'',o={}; h.split(';').forEach(p=>{const i=p.indexOf('=');if(i>0)o[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim());}); return o; }
// M-4: play-gate sessions are RANDOM, server-stored, revocable ids — NOT a password-derived constant. On a
// successful password POST we mint a fresh crypto.randomBytes session id with an expiry, persist it (in-memory
// Map + a disk file so a restart keeps logged-in players in), and validate each request by lookup. Changing
// VS_PASSWORD or clearing the store invalidates every live session (the old deterministic cookie no longer
// matches any stored id). The password itself is NEVER stored; we keep only a hash of the password that minted
// a session so that rotating VS_PASSWORD purges sessions created under the old password on next boot.
const GATE_FILE = path.join(STORE_DIR, 'gate-sessions.json');   // { [sid]: { exp, pwh } }
const GATE_TTL_MS = 30*24*3600*1000;                            // 30d, matches the old cookie Max-Age
const PW_HASH = crypto.createHash('sha256').update(PW + ':vs-gate').digest('hex');  // non-secret fingerprint of the active password
const GATE_SESSIONS = (function(){
  const raw = loadJson(GATE_FILE, {}); const now=Date.now(); const m=new Map();
  for(const sid in raw){ const s=raw[sid]; if(s && s.exp>now && s.pwh===PW_HASH) m.set(sid, s); }  // drop expired + password-rotated sessions
  return m;
})();
function saveGateSessions(){ const o={}; for(const [sid,s] of GATE_SESSIONS) o[sid]=s; saveJsonAtomic(GATE_FILE, o); }
function mintGateSession(){ const sid=crypto.randomBytes(32).toString('hex'); GATE_SESSIONS.set(sid,{ exp:Date.now()+GATE_TTL_MS, pwh:PW_HASH }); saveGateSessions(); return sid; }
function gateSessionValid(sid){ if(typeof sid!=='string'||!sid) return false; const s=GATE_SESSIONS.get(sid); if(!s){ return false; } if(s.exp<=Date.now()||s.pwh!==PW_HASH){ GATE_SESSIONS.delete(sid); saveGateSessions(); return false; } return true; }
function gateOk(req){
  // HUB REVERSE-PROXY BYPASS: this artifact is is_public=false and the Vault Robbers hub (vaultrobbers.com, itself
  // password-gated) reverse-proxies it under /play/v3, injecting the group's platform owner token server-side. A
  // request carrying that exact Bearer token therefore came through the trusted, already-gated hub — honor it so
  // there's no double password prompt, WITHOUT the hub holding this game's play password or any signing key. A
  // public token-less visitor can never reach here (dashboard 401s first), so this does not widen exposure.
  try{ const dt=process.env.DASHBOARD_TOKEN; const a=req&&req.headers&&req.headers.authorization; if(dt&&typeof a==='string'&&a==='Bearer '+dt) return true; }catch(_){}
  return gateSessionValid(cookies(req).vs_gate);
}
setInterval(()=>{ const now=Date.now(); let dirty=false; for(const [sid,s] of GATE_SESSIONS){ if(s.exp<=now){ GATE_SESSIONS.delete(sid); dirty=true; } } if(dirty) saveGateSessions(); }, 3600000);
const GATE='<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Vault Standoff</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3e3ca;font-family:ui-sans-serif}form{background:#fbfaf6;border:2.5px solid #17130d;border-radius:16px;box-shadow:6px 6px 0 #17130d;padding:26px;text-align:center}input,button{font-size:16px;padding:11px;border:2.5px solid #17130d;border-radius:11px;box-shadow:3px 3px 0 #17130d;width:220px;display:block;margin:8px auto}button{background:#6d84c6;color:#fbfaf6;cursor:pointer}</style><form onsubmit="event.preventDefault();fetch(location.href,{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({password:pw.value})}).then(r=>r.ok?location.reload():msg.textContent=\'Wrong password.\')"><h3>Vault Standoff</h3><input id=pw type=password placeholder=password autofocus><button>Enter</button><div id=msg></div></form>';
// M-1: SECURITY HEADERS. Applied to EVERY response before any route. Anti-clickjacking (frame-ancestors/
// X-Frame-Options), anti-MIME-sniffing, a tight referrer policy, and a CSP that blocks EXTERNAL script injection
// while still permitting the app's own large inline <script> + inline styles and its live connectivity (the game
// WebSocket over ws:/wss:, plus https: for RPC / Relay / wallet endpoints and data:/https: images). The CSP is
// deliberately permissive on 'unsafe-inline' for script/style because the app ships one big inline bundle.
// script-src: ZERO third-party script origins. Everything is vendored locally now — ethers (public/vendor/ethers-*.umd)
// and the Solana web3/spl bundles (public/vendor/solana-*.esm.js, esbuild + node polyfills). cdn.jsdelivr.net AND
// esm.sh are both gone; the unused Bitcoin (sats-connect) + Metaplex (mpl) loaders were neutralized in the connector.
// style-src + font-src allow Google Fonts (Londrina/Inter). connect-src MUST stay ws:/wss:/https: (socket + chain
// reads + Relay/RPC). If BTC pay or NFT-metadata is ever added to Standoff, vendor those libs the same way before use.
const CSP = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' ws: wss: https:;";
app.use((req,res,next)=>{
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','same-origin');
  res.setHeader('Content-Security-Policy',CSP);
  next();
});
app.use((req,res,next)=>{
  // the admin surface has its OWN (stronger) auth, so it bypasses the play-password gate. admin.html loads a
  // token login box; /api/admin/* each enforce adminGate. This lets an operator reach the dashboard without
  // also knowing the play password, while still being 401 without the admin token.
  if(req.path==='/admin.html' || req.path.indexOf('/api/admin/')===0) return next();
  if(gateOk(req)) return next();
  if(req.method==='POST'){ let b=''; req.on('data',d=>{b+=d;if(b.length>2048)req.destroy();}); req.on('end',()=>{ let pw='';try{pw=JSON.parse(b||'{}').password||'';}catch(_){ } if(crypto.createHash('sha256').update(pw+':vs-gate').digest('hex')===PW_HASH){const sid=mintGateSession();res.setHeader('Set-Cookie',`vs_gate=${sid}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);res.json({ok:true});}else res.status(401).json({ok:false}); }); return; }
  res.status(401).type('html').send(GATE);
});
app.use(express.json());

// ---- config ----
const DAY=86400000, H=3600000, M=60000;
const MODES={
  // demand-driven (fuse compressed for preview; prod bumps fuse to 3600000)
  fill:  { engine:'fill', threshold:50, cap:100, fuse:20000, resultMs:12000, choose:15000, blind:1000, reveal:5000, maxch:6, seedBots:10, armEvery:2500 },
  // clock engines
  dev:   { engine:'clock', interval:240000, lobby:80000, choose:19000, blind:1000, reveal:6000, maxch:6 },
  demo:  { engine:'clock', interval:15*M, unit:M, lobbyU:2, firstLockU:3, spacingU:2, blind:20000, reveal:15000, maxch:6 },
  daily: { engine:'clock', interval:DAY, unit:H, lobbyU:12, firstLockU:14, spacingU:2, blind:30*M, reveal:10*M, maxch:6 },
  // THRESHOLD-FILL real-money engine (Phase A). Demand-driven like `fill` but the on-chain escrow IS the driver:
  // a round OPENS with a far-future sentinel lockTime (buy-in stays open), players fill it, at threshold+grace
  // (or full) the SIGNER calls lockRound(id) on-chain to close buy-in, then commit, then the chambers play on a
  // RELATIVE clock, then settle/void. No dead time: the next round opens the instant this one locks. target /
  // thresholdPct / graceSec / otDoors / choose / reveal / maxch all come from the hot economy config at the
  // round boundary (applyCfgAtBoundary), so the literals here are only pre-config defaults. `cap`==`target` so
  // the shared seat-cap plumbing (C.cap guards in seatWalletCount) works unchanged.
  rmfill:{ engine:'rmfill', target:50, cap:50, thresholdPct:50, graceMs:600000, choose:19000, blind:1000, reveal:6000, maxch:6,
           minViable:2, sentinelSec:86400, playMarginSec:3600 }
};
let MODE = MODES[process.env.VS_MODE] ? process.env.VS_MODE : 'fill';
// real-money escrow rounds honor the escrow mode override. Both the fixed CLOCK cadence and the new threshold
// FILL cadence are valid real-money drivers (each maps lock/commit/settle to the contract); the fake-chip `fill`
// engine is NOT (it opens no on-chain rounds) and is refused below.
if (escrow.isOn() && MODES[escrow.modeOverride()] && (MODES[escrow.modeOverride()].engine === 'clock' || MODES[escrow.modeOverride()].engine === 'rmfill')) MODE = escrow.modeOverride();
let C = MODES[MODE];
// STARTUP ASSERTION: if escrow is live, the engine MUST be a real-money-capable cadence (clock OR rmfill). The
// fake-chip `fill` engine opens no on-chain rounds (realMoney() excludes it), so booting escrow-on + fill would
// take no money but also never seat wallets -> a dead real-money room. Refuse that configuration.
if (escrow.isOn() && C.engine !== 'clock' && C.engine !== 'rmfill') {
  console.error('[vaultstandoff-dev] FATAL: VS_ESCROW is on but mode "'+MODE+'" is not a real-money engine. Set VS_MODE/VS_MODE_ESCROW to dev|demo|daily (clock) or rmfill (threshold-fill). Refusing to boot.');
  process.exit(1);
}
const MINBOTS=12, FINAL_LABELS=['Split the vault','Take it all'], ENTRY=1000; // ENTRY = symbolic RVLT per buy-in (preview)
// ---- SYBIL POLICY (configurable) ----
// The economy is near-zero-sum (pot shared by survivors, minus rake), so a Sybil buying many wallets just buys
// a proportional share of a pot it also funded; it cannot drain the house. The real lever is concentration, so
// we expose a per-round per-wallet ticket cap. VS_MAX_TICKETS_PER_WALLET (default 10, clamp [1,100]) is the
// hard seat cap per wallet; VS_SYBIL_ENFORCE=on makes it a strict refusal rather than a silent clamp (surfaced
// to the client + modelled in sim.html). A distinct-wallet count flag is surfaced for ops visibility.
const MAX_TIX_WALLET = Math.max(1, Math.min(100, parseInt(process.env.VS_MAX_TICKETS_PER_WALLET||'10',10)||10));
const SYBIL_ENFORCE = process.env.VS_SYBIL_ENFORCE === 'on';

// ---- RUNTIME-EDITABLE ECONOMY CONFIG --------------------------------------------------------------------
// A persisted, hot-editable economy config (.vs-store/.vs-config.json). Defaults are derived from the values
// in effect at boot (the active mode `C` + the env-sourced constants above), so an ABSENT config file
// reproduces today's behavior EXACTLY. Edits NEVER apply mid-round: setCfg writes a PENDING config; the active
// config is swapped to pending only at a round boundary (clockNewGame / fillNewGame), so a live round always
// finishes under the terms it started with. All inputs are validated + range-clamped. No secrets live here.
const CONFIG_FILE = path.join(STORE_DIR, '.vs-config.json');
// seconds-form of the active mode's timers so the dashboard speaks in seconds, not ms. The dev clock mode uses
// `lobby`; the compressed/daily modes express the lobby in units, so fall back to a sane seconds value there.
function _lobbySecDefault(){ if(C.lobby!=null) return Math.round(C.lobby/1000); if(C.lobbyU!=null&&C.unit!=null) return Math.round((C.lobbyU*C.unit)/1000); return 80; }
const CFG_DEFAULTS = Object.freeze({
  entryUsd: 10,                                   // display/quote value; on-chain entryWei stays the source of truth for cost
  roundTarget: (C.cap!=null?C.cap:(C.threshold!=null?C.threshold:50)),   // target seats/round + fill-threshold base
  thresholdPct: 50,                               // fill arms at this % of roundTarget (matches fill.threshold=50 of cap=100)
  graceSec: 600,                                  // grace CEILING after threshold before the round locks (at threshold fill)
  // DYNAMIC GRACE (OFF-CHAIN TIMER ONLY): the arm/grace window shrinks as the round fills past threshold toward
  // target, so a near-full round starts fast while a just-armed one keeps the full ceiling. graceSec is the ceiling
  // (at threshold), graceFloorSec is the floor (at/above target); graceCurvePct bends the interpolation (100 = linear,
  // <100 drops faster early, >100 holds the ceiling longer). This ONLY re-computes the local G.graceEnds timestamp in
  // rmfillTick; it NEVER changes any on-chain call (lockRound/commit/settle still fire exactly when the engine's
  // phase transitions, see rmEscrowLifecycle). The existing minViable gate is untouched.
  graceFloorSec: 60,                              // grace FLOOR when the round is at/above target (fastest start)
  graceCurvePct: 100,                             // interpolation shaping (100 = linear threshold->target)
  maxTicketsPerWalletPct: 5,                      // per-wallet concentration cap, as a % of roundTarget (lowered 10->5, 2026-10-10)
  otDoors: Math.max(2, parseInt(process.env.VS_OT_DOORS||'2',10)||2),    // sudden-death doors (was env VS_OT_DOORS)
  otChooseSec: Math.max(1, parseInt(process.env.VS_OT_CHOOSE_SEC||'8',10)||8),   // real-time OVERTIME choose window (per OT round)
  otRevealSec: Math.max(1, parseInt(process.env.VS_OT_REVEAL_SEC||'4',10)||4),   // real-time OVERTIME reveal window (per OT round)
  minPresentPct: 0,                               // FEATURE 2: min % of target that must be actively-present (non-auto) humans before a round LOCKS (0 = off; anti all-bot erosion)
  // ANTI-WHALE circuit breaker (OPTICS, not security: the game is EV-negative via rake and cannot be farmed). A wallet
  // that wins streakFreezeAt games in a row is frozen from buying in for streakCooldownHrs. 0 = OFF (recommended default
  // keeps it on at 3/24h as a fairness lever; set streakFreezeAt 0 to disable entirely).
  streakFreezeAt: 3,
  streakCooldownHrs: 24,
  // PROGRESSIVE JACKPOT: final-vault standoff rollover. finalVaultDoors = OT round-0 door count (more = rarer rollover);
  // jackpotRollover 1=on/0=off. Rollover folds the busted pot into the ROBINVAULT pot (no separate label).
  finalVaultDoors: 5,
  jackpotRollover: 1,
  // RUSH OVERFLOW: how many rounds to keep buyable in parallel. 2 = classic behavior (current + one pre-open, the
  // historical model). >2 enables multi-game fill: buys cascade across the open window in on-chain-deposit order, and
  // the engine opens more games under load (up to maxOpenRounds) so a surge fills many games until roundTarget is the
  // only limit. See RUSH-OVERFLOW-DESIGN.md + overflow-sim.js. Default 2 keeps today's exact behavior (feature inert).
  preopenDepth: 2,
  maxOpenRounds: 20,
  // PRE-LAUNCH COUNTDOWN: launchGate 1 shows a full-screen "opens Halloween" countdown over the game until launchAtMs
  // (prod). Default 0 = OPEN (so dev/testnet keeps playing). launchAtMs defaults to Halloween 2026, 00:00 ET.
  launchGate: 0,
  launchAtMs: (Date.parse('2026-10-31T04:00:00Z') || 1793577600000),
  maxChambers: (C.maxch!=null?C.maxch:6),
  chooseSec: Math.round((C.choose!=null?C.choose:15000)/1000),
  revealSec: Math.round((C.reveal!=null?C.reveal:5000)/1000),
  lobbySec: _lobbySecDefault()
});
// validation ranges: [min, max]. Everything clamps into range; non-numeric falls back to the current value.
const CFG_RANGES = Object.freeze({
  entryUsd:[1,100000], roundTarget:[2,1000], thresholdPct:[1,100], graceSec:[0,86400],
  graceFloorSec:[0,86400], graceCurvePct:[10,400],
  maxTicketsPerWalletPct:[1,100], otDoors:[2,12], otChooseSec:[1,120], otRevealSec:[1,120], minPresentPct:[0,100],
  streakFreezeAt:[0,50], streakCooldownHrs:[1,720], finalVaultDoors:[2,12], jackpotRollover:[0,1],
  preopenDepth:[2,12], maxOpenRounds:[2,80],
  launchGate:[0,1], launchAtMs:[0,4102444800000],
  maxChambers:[1,20], chooseSec:[1,600], revealSec:[1,600], lobbySec:[1,86400]
});
function _clampCfg(src, base){
  const out = Object.assign({}, base);
  for(const k in CFG_DEFAULTS){
    let v = (src && src[k]!=null) ? Number(src[k]) : base[k];
    if(!Number.isFinite(v)) v = base[k];
    v = Math.round(v);                                           // all tunables are integers
    const [lo,hi] = CFG_RANGES[k]; v = Math.max(lo, Math.min(hi, v));
    out[k] = v;
  }
  // M-3: the grace FLOOR (fastest start, at/above target) must never exceed the grace CEILING (at threshold).
  // Clamp after both are resolved so the persisted/pending config always satisfies floor <= ceiling, and the
  // corrected value is exactly what the admin dashboard reads back.
  out.graceFloorSec = Math.min(out.graceFloorSec, out.graceSec);
  return out;
}
let ACTIVE_CFG = _clampCfg(loadJson(CONFIG_FILE, {}), CFG_DEFAULTS);   // in effect for the live round
let PENDING_CFG = null;                                                // staged; swaps in at the next round boundary
// if a file existed and was out-of-range, rewrite the clamped form so disk == memory
saveJsonAtomic(CONFIG_FILE, ACTIVE_CFG);
function getCfg(){ return ACTIVE_CFG; }

// ─── VAULT ROBBERS MINT WATCH → condition-driven auto-launch ──────────────────────────────────────────────
// Vault Standoff opens the instant the Vault Robbers NFT mint is FINALIZED: either it SELLS OUT (minted >= max)
// or the Halloween cutoff passes (the mint permanently closes then and whatever is minted becomes the full
// supply). So the launch gate needs NO manual flip. The mint contract is read-only + env-configured; until
// VS_MINT_ADDR is set the Halloween timestamp alone drives launch (which IS the mint's hard cutoff, so it's
// correct either way). Once the address is set, an early sell-out opens the game ahead of Halloween.
const _mintEthers = require('ethers');
const MINT = {
  // Vault Robbers NFT, confirmed on-chain 2026-10-14: "Vault Robbers" (ROBBERS) on Robinhood Chain, MAX_SUPPLY 1000,
  // minted-count getter is totalMinted(), owner = treasury Safe 0x3290…3665. Baked as defaults so the auto-launch is
  // live without extra env; override via VS_MINT_* if the contract ever changes.
  addr: (process.env.VS_MINT_ADDR || '0xABC6c4F5d1F31326b419c2645C981743a845313a').trim(),
  max: parseInt(process.env.VS_MINT_MAX || '1000', 10) || 1000,
  chain: parseInt(process.env.VS_MINT_CHAIN || '4663', 10) || 4663,
  rpc: process.env.VS_MINT_RPC || 'https://rpc.mainnet.chain.robinhood.com',
  method: process.env.VS_MINT_METHOD || 'totalMinted',   // minted-count getter (totalMinted on the ROBBERS contract)
  minted: null, soldOut: false, ts: 0, _prov: null
};
async function _mintRead(){
  if(!/^0x[0-9a-fA-F]{40}$/.test(MINT.addr)) return;        // no mint wired yet → Halloween cutoff drives launch
  if(Date.now() - MINT.ts < 45000) return;                  // 45s cache
  try{
    if(!MINT._prov) MINT._prov = new _mintEthers.JsonRpcProvider(MINT.rpc, MINT.chain);
    const c = new _mintEthers.Contract(MINT.addr, ['function ' + MINT.method + '() view returns (uint256)'], MINT._prov);
    const n = Number(await c[MINT.method]());
    if(Number.isFinite(n)){ MINT.minted = n; MINT.soldOut = n >= MINT.max; MINT.ts = Date.now(); }
  }catch(e){ /* RPC blip → keep last read; the Halloween cutoff still guarantees launch */ }
}
setInterval(() => { _mintRead().catch(()=>{}); }, 45000);
_mintRead().catch(()=>{});
// The launch block the client reads. open = the mint is finalized (sell-out OR Halloween), unless the gate is 0
// (dev/testnet = always open). `reason` is for display/telemetry; `mint` is null until a mint address is wired.
function launchState(){
  const cfg = getCfg();
  const atMs = Number(cfg.launchAtMs);
  const gated = Number(cfg.launchGate) === 1;
  const soldOut = !!MINT.soldOut;
  const halloween = Date.now() >= atMs;
  const open = !gated || soldOut || halloween;
  const reason = !gated ? 'open' : (soldOut ? 'mint-sold-out' : (halloween ? 'halloween' : 'pending'));
  const mint = /^0x[0-9a-fA-F]{40}$/.test(MINT.addr) ? { minted: MINT.minted, max: MINT.max, soldOut } : null;
  return { open, gate: cfg.launchGate, atMs, reason, mint };
}
function getPendingCfg(){ return PENDING_CFG; }
// stage a validated/clamped config; it becomes active at the next round boundary. Returns the clamped pending.
function setCfg(patch){ PENDING_CFG = _clampCfg(patch, ACTIVE_CFG); saveJsonAtomic(CONFIG_FILE+'.pending', PENDING_CFG); return PENDING_CFG; }
// called at every round boundary: promote a staged config to active (persist it, drop the pending file).
function applyPendingCfg(){ if(PENDING_CFG){ ACTIVE_CFG = PENDING_CFG; PENDING_CFG = null; saveJsonAtomic(CONFIG_FILE, ACTIVE_CFG); try{ fs.unlinkSync(CONFIG_FILE+'.pending'); }catch(_){} } }
// computed per-round absolute per-wallet cap = ceil(pct/100 * roundTarget), floored at 1.
function walletCap(){ return Math.max(1, Math.min(MAX_TIX_PER_GAME, Math.ceil(getCfg().maxTicketsPerWalletPct/100 * getCfg().roundTarget))); }   // AUDIT fix: clamp to the on-chain per-wallet cap (3) so a hot-config bump can't seat more off-chain than buyIn permits (would revert on-chain)
// ANTI-WHALE: update consecutive-win streaks at game end. `winnerAddrs` = the wallets that won this round (lowercased
// on compare). Every OTHER wallet that PLAYED this round has its streak reset to 0. A winner crossing STREAK_FREEZE_AT
// consecutive wins is frozen from buying in for STREAK_COOLDOWN_MS. Participants are the distinct non-bot owners seated
// in the current game G. Persisted so a freeze survives a restart.
function recordWinStreak(winnerAddrs){
  if(!G || !G.players) return;
  const winners = new Set((winnerAddrs||[]).map(a=>String(a).toLowerCase()));
  const parts = new Set();
  Object.keys(G.players).forEach(id=>{ const p=G.players[id]; if(p && !p.bot && p.owner){ const a=escrow.addrOfToken(p.owner); if(a) parts.add(String(a).toLowerCase()); } });
  if(!parts.size) return;
  const freezeAt = Number(getCfg().streakFreezeAt); const cooldownMs = Math.max(1,Number(getCfg().streakCooldownHrs)||24)*3600000;
  parts.forEach(a=>{
    const w = WIN_STREAK[a] || { streak:0, frozenUntil:0 };
    if(winners.has(a)){ w.streak=(w.streak||0)+1; if(freezeAt>0 && w.streak>=freezeAt){ w.frozenUntil=Date.now()+cooldownMs; w.streak=0; } }
    else { w.streak=0; }
    WIN_STREAK[a]=w;
  });
  saveWinStreak();
}
// AUTO-PAYOUT keeper: push settled winnings to winners once the on-chain challenge window has elapsed, so a winner
// never has to click "collect". The contract gates payWinners on the window (reverts "challenge window" if early), so
// we can be approximate and just retry. claim() remains the on-chain fallback if this drops (e.g. a mid-window restart).
let _payoutBusy=false;
async function payoutKeeper(){
  if(_payoutBusy) return; const ids=Object.keys(PAYOUT_QUEUE); if(!ids.length) return;
  _payoutBusy=true;
  try{
    for(const id of ids){
      const q=PAYOUT_QUEUE[id]; if(!q || Date.now()<q.after) continue;
      // STEP 1: push winnings to winners. Idempotent on-chain (per-winner), so a retry never double-pays.
      if(!q.winnersPaid){
        const ok=await escrow.payWinners(id, q.winners).catch((e)=>{ recordPayoutFail(e); return null; });
        if(ok){ q.winnersPaid=true; savePayoutQueue(); }
        else if((q.tries=(q.tries||0)+1)>=8){ recordPayoutDrop(id, 'winners', q.tries, PAYOUT_STATS.lastError); delete PAYOUT_QUEUE[id]; savePayoutQueue(); console.error('[vaultstandoff-dev] payWinners failed 8x for round '+id+' — winners can still claim() on-chain'); continue; }
        else { q.after=Date.now()+30000; savePayoutQueue(); continue; }   // back off (window maybe not elapsed) and retry
      }
      // STEP 2: RAKE AUTO-SWEEP to treasury + burn (was previously absent on dev). Idempotent ("rake paid" ==
      // success). Keep the entry until rake confirms so a restart/RPC blip cannot silently skip the sweep.
      if(q.winnersPaid && !q.rakePaid){
        const rk=await escrow.payRake(id).then(()=>true).catch(async(e)=>{
          if(/rake paid/i.test(String(e&&(e.shortMessage||e.message)||''))) return true;   // string-revert "rake paid" = already swept
          try{ if(await escrow.rakePaidOf(id)===true) return true; }catch(_){}               // AUDIT fix: custom-error reverts won't string-match, so confirm chain truth before treating as failure
          recordPayoutFail(e);                                                               // MED-2: real failure (not an already-swept revert), record for the dashboard
          return false;
        });
        if(rk){ q.rakePaid=true; delete PAYOUT_QUEUE[id]; savePayoutQueue(); }
        else if((q.rakeTries=(q.rakeTries||0)+1)>=8){ recordPayoutDrop(id, 'rake', q.rakeTries, PAYOUT_STATS.lastError); delete PAYOUT_QUEUE[id]; savePayoutQueue(); console.error('[vaultstandoff-dev] payRake failed 8x for round '+id+' — call payRake('+id+') manually'); }
        else { q.after=Date.now()+30000; savePayoutQueue(); }
      }
    }
  } finally { _payoutBusy=false; }
}

// HOLDER DISCOUNT NOTE (2026-10-10): the holder discount is charged ON-CHAIN at buy time (V4 entryPriceFor
// halves the per-ticket price for a Vault Robbers NFT holder). There is NO off-chain accrual/rebate step: the
// pot already receives the discounted amount, so the escrow contract is the single and only source of truth for
// the discount. Any settle-time rebate accrual would double-count and has been removed.
// restore a staged pending across restart so an operator's edit isn't lost by a redeploy before the boundary.
(function(){ const p = loadJson(CONFIG_FILE+'.pending', null); if(p) PENDING_CFG = _clampCfg(p, ACTIVE_CFG); })();
const R=['North Wing','East Vault','Service Shaft','Skylight','Sub-Basement'];
function routesFor(n){ return n>24?5:n>12?4:n>5?3:2; }
const BOTNAMES=['Ghost','Mask','Shadow','Nine','Vale','Crow','Slate','Ash','Rook','Fox','Wren','Kilo','Echo','Jax','Nyx','Onyx','Pike','Quill','Rue','Sable'];
// GAP-E (anon token entropy): 16 random bytes (128 bits) so an anon session id is not enumerable. The old 5-byte
// (20-bit) id was brute-forceable; widening it shrinks the blast radius of any residual guess attack.
function nid(){ return crypto.randomBytes(16).toString('hex'); }
// Read the player's session token as the SINGLE identity source for mutating / per-player endpoints. GAP-D:
// identity is taken from the x-vs-token HEADER ONLY (also set as a header shim by the WS hello handler + admin
// cookie paths). The req.body.token and ?token= query fallbacks are REMOVED: a query token leaks into access
// logs + the Referer header, and a body/query token let any gate-authed caller act on behalf of another seat
// (IDOR). The browser already sends x-vs-token on every authenticated api() call, so no legit flow depends on
// the body/query fallbacks for identity.
function reqToken(req){ const h=req.headers['x-vs-token']; return (typeof h==='string'&&h)?h:null; }
// admin gate for privileged control (mode switch): header-only, constant-time, fail-closed on short/absent token.
const VS_ADMIN=process.env.VS_ADMIN_TOKEN||'';
function vsAdminOk(req){ if(!VS_ADMIN||VS_ADMIN.length<16)return false; const g=req.headers['x-admin']; if(typeof g!=='string'||g.length!==VS_ADMIN.length)return false; try{return crypto.timingSafeEqual(Buffer.from(g),Buffer.from(VS_ADMIN));}catch(_){return false;} }
// lightweight per-key sliding-window rate limiter for mutating endpoints (anti-spam / anti-DoS)
// LOW fix (RL fail-open): the old guard checked Object.keys(_RL).length against a 50k cap and, when exceeded,
// FAIL-OPENED (returned true=allowed) for every NEW key until the 60s GC ran — so a Sybil flood that rotates
// keys (distinct IPs / token suffixes) could balloon the map and then bypass the limiter entirely. Hardened:
//   (1) live size is tracked in _RL_SIZE (no O(n) Object.keys scan on the hot path),
//   (2) on first touching the cap we run an INLINE sweep of expired keys so the cap reflects only LIVE keys
//       (key-rotation churn is reclaimed immediately, not 60s later),
//   (3) if we are STILL at/over the cap after that sweep (a genuine live flood), new keys FAIL-CLOSED
//       (return false = denied) instead of fail-open — under attack the safe default is to deny, not allow.
// Existing keys are always evaluated normally (their own window still bounds them), so legitimate repeat
// callers are never collateral. Normal load never reaches the cap, so behavior is unchanged there.
const _RL={}; let _RL_SIZE=0; const _RL_MAX_KEYS=50000;
function _rlSweep(now){ for(const k in _RL){ const a=_RL[k].filter(t=>now-t<120000); if(a.length) _RL[k]=a; else { delete _RL[k]; _RL_SIZE--; } } }
function rl(key,max,winMs){
  const now=Date.now();
  if(_RL[key]===undefined){
    if(_RL_SIZE>=_RL_MAX_KEYS){ _rlSweep(now); if(_RL_SIZE>=_RL_MAX_KEYS) return false; }   // inline GC, then fail-CLOSED if still flooded
    _RL[key]=[]; _RL_SIZE++;
  }
  const a=_RL[key].filter(t=>now-t<winMs);
  if(a.length>=max){ _RL[key]=a; return false; }
  a.push(now); _RL[key]=a; return true;
}
setInterval(()=>{ const now=Date.now(); _rlSweep(now); for(const a in SIWE){ if(now>SIWE[a].exp) delete SIWE[a]; } },60000);
// H-1/M-2: the rate-limit key's PRIMARY discriminator is the network identity (so a caller can't rotate a
// body token to mint fresh buckets, and GET requests no longer collapse everyone onto a shared 'anon' bucket).
// The HEADER token (x-vs-token) is a SECONDARY refinement only, appended when present; req.body.token is NEVER
// used as the key (it is fully caller-controlled). Works identically for GET and POST.
function rlKey(req,pfx){
  let ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'anon';
  if(typeof ip==='string' && ip.indexOf(',')>=0) ip = ip.split(',')[0].trim();   // first hop if a list
  let key = pfx+':'+ip;
  const h = req.headers['x-vs-token'];
  if(typeof h==='string' && h) key += ':'+h;                                      // secondary refinement only
  return key;
}
// H7: SIWE-style identity. A `w:<addr>` token is only trusted once the address proves control by signing a
// one-time nonce. Prevents spoofing someone else's address; the foundation for real-chip play + anti-Sybil.
const SIWE = {};   // addr(lowercased) -> { nonce, exp }
function siweMsg(addr, nonce){ return 'Vault Standoff\nSign in to prove you control this wallet. This does NOT authorize any transaction.\nAddress: ' + addr + '\nNonce: ' + nonce; }

// ---- ADMIN DASHBOARD AUTH (separate from the play gate + distinct from the settlement signer) ----
// The admin token controls the economy config + exposes ops metrics. It is a SEPARATE secret from the play
// gate (VS_PASSWORD) and NEVER the settlement signer key. Preference: env VS_ADMIN_TOKEN. If unset we derive a
// stable dev-only token and LOG it at boot (same spirit as the VS_PASSWORD dev default). Because this twin is
// testnet-scoped (escrow chain 46630), a dev default is acceptable; a real-money mainnet deployment should set
// VS_ADMIN_TOKEN in sealed env. Auth accepts a header (x-vs-admin) OR a cookie set by the admin login POST.
// NOTE: the pre-existing VS_ADMIN / x-admin / /api/mode path is left intact; this is an additive admin surface.
// L-1: on real-money MAINNET (escrow on + chainId 4663) the password-derived dev default is NOT acceptable — a
// predictable admin token in front of the economy config is a boot-time refusal. Require VS_ADMIN_TOKEN >= 32
// chars. On testnet the dev-default behavior is kept (logged at boot).
if(_prodMoney && !(process.env.VS_ADMIN_TOKEN && process.env.VS_ADMIN_TOKEN.length>=32)){
  console.error('[vaultstandoff-dev] FATAL: real-money escrow on mainnet (4663) requires VS_ADMIN_TOKEN >= 32 chars (no password-derived default). Refusing to boot.');
  process.exit(1);
}
// AUDIT L-1 HARDENING (defense-in-depth): the guard above is gated on _prodMoney (escrow ON *and* chainId 4663).
// If this process ever ran on the MAINNET chain with escrow momentarily OFF (e.g. VS_ESCROW=off for maintenance),
// _prodMoney would be false and the predictable password-derived admin fallback could silently apply on a mainnet
// box. The admin surface controls the live economy config, so a predictable token must NEVER exist on the mainnet
// chain regardless of the escrow switch. Refuse the dev default whenever the configured chain is 4663.
if(Number(_escCfg.chainId) === 4663 && !(process.env.VS_ADMIN_TOKEN && process.env.VS_ADMIN_TOKEN.length>=32)){
  console.error('[vaultstandoff-dev] FATAL: on the MAINNET chain (4663) VS_ADMIN_TOKEN >= 32 chars is required (no password-derived default), even when escrow is off. Refusing to boot.');
  process.exit(1);
}
const ADMIN_TOKEN = (process.env.VS_ADMIN_TOKEN && process.env.VS_ADMIN_TOKEN.length>=12)
  ? process.env.VS_ADMIN_TOKEN
  : ('vs-admin-' + crypto.createHash('sha256').update((PW||'dev')+':vs-admin-dev').digest('hex').slice(0,24));
if(!(process.env.VS_ADMIN_TOKEN && process.env.VS_ADMIN_TOKEN.length>=12)){
  // H-2: NEVER print the full admin token to the logs (log sinks are a leak surface). Surface only a short prefix
  // so an operator can recognize which dev-default token is live; the full value is derivable from env setup only.
  console.log('[vaultstandoff-dev] ADMIN token set (dev default, testnet). prefix='+ADMIN_TOKEN.slice(0,10)+'...  -> open /pub/main/vaultstandoff-dev/admin.html and paste the full token (see VS_ADMIN_TOKEN). Set VS_ADMIN_TOKEN in env to override.');
}
const ADMIN_COOKIE = crypto.createHash('sha256').update(ADMIN_TOKEN+':vs-admin-cookie').digest('hex');
function _ctEq(a,b){ if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length) return false; try{ return crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b)); }catch(_){ return false; } }
// admin request is authorized if it presents the raw token (header x-vs-admin) OR the derived admin cookie.
function adminOk(req){ const h=req.headers['x-vs-admin']; if(typeof h==='string'&&_ctEq(h,ADMIN_TOKEN)) return true; const c=cookies(req).vs_admin; return typeof c==='string'&&_ctEq(c,ADMIN_COOKIE); }

const REG={}, CHAT=[], HISTORY=[]; // HISTORY = past results only (public, no future/edge leak)
let G=null;
function recordHistory(){ if(!G||G.recorded)return; G.recorded=true; var ch=G.champ||{}; HISTORY.unshift({ roundId:(G&&G.roundId!=null)?String(G.roundId):null, name:ch.name||null, split:!!ch.split, none:!!ch.none, n: ch.split?(ch.winners?ch.winners.length:0):(ch.name?1:0), pot: realMoney()?(G._onchainPot||0):seatCount()*ENTRY, ts:Date.now() }); while(HISTORY.length>10)HISTORY.pop(); writeProof(); }
// Build + persist the public, replayable proof of the finished round: the revealed seed, the hashed ticket set
// (token hashes, never raw tokens), every logged pick, which door busted each chamber (and how many were caught),
// and the winner. Anyone can re-run prng(seed, roundId, label) against this to reproduce the outcome.
function writeProof(){
  if(!G||!G.roundId) return;
  var ch=G.champ||{};
  var tickets=Object.keys(G.players).filter(function(id){var p=G.players[id];return !p.bot&&!p.left;})
    .map(function(id){var p=G.players[id];return { th:tokenHash(p.owner||id), auto:!!p.auto };});
  var winner = ch.none ? { none:true } : { name:ch.name||null };
  var proof = { roundId:G.roundId, seed:G.seed, tickets:tickets, picks:picksForRound(G.roundId),
    bustedByChamber:(G.bustLog||[]), winner:winner,
    walletCap:(G._walletCap||walletCap()),   // persist THIS round's per-wallet Sybil cap as part of the public record
    realMoney:realMoney(), ts:Date.now() };
  persistProof(G.roundId, proof);
  // H-1: once the proof is written the round's seed is PUBLIC (it's in the proof), so there is no longer any
  // reason to keep it in seeds.json. Delete this round's seed entry and rewrite seeds.json atomically so the
  // window in which an un-revealed seed sits on disk is minimized. The floor-based GC in the engine lifecycles
  // stays as a backstop for any round that settled without a proof write.
  try { const k=String(G.roundId); if(SEED_STORE[k]!=null){ delete SEED_STORE[k]; saveSeeds(); } } catch(_){}
}

// ---- shared game helpers ----
// Attach the round's committed seed to the game. roundId = G.start for clock; a synthetic id for fill preview.
// Every outcome draw pulls from a labelled prng stream keyed off this seed, so the whole game replays from it.
function attachSeed(roundId){
  G.roundId = String(roundId);
  // ONE seed per round, from the durable store. For real-money rounds escCommitRound commits THIS seed's hash
  // on-chain, so the seed revealed at settle always matches the committed hash. For fill/preview it is purely
  // local. Generated-and-persisted on first touch (here or at escrow open), survives a restart.
  G.seed = ensureRoundSeed(roundId).seed;
}
// deterministic draw: a cached prng stream per (chamber, label). First use of a label in a chamber creates it.
function draw(label){
  if(!G.seed) attachSeed(G.roundId || (G.start!=null?G.start:'fill:'+(G.runStart||Date.now())));
  G._streams = G._streams || {};
  const key = (G.cur==null?'x':G.cur) + ':' + label;
  if(!G._streams[key]) G._streams[key] = prng(G.seed, G.roundId, key);
  return G._streams[key]();
}
function drandInt(label, n){ return Math.floor(draw(label) * n); }
function aliveList(){ return Object.entries(G.players).filter(([,p])=>p.alive&&!p.left); }
function aliveCount(){ return aliveList().length; }
function seatCount(){ return Object.values(G.players).filter(p=>!p.left).length; }
function countsNow(){ const c=(G.routes||[]).map(()=>0); aliveList().forEach(([,p])=>{ if(p.pick!=null&&p.pick<c.length)c[p.pick]++; }); return c; }
function player(tok){ return tok&&G&&G.players[tok]; }
// AWAY AUTOPILOT: a verified human is "present" while their tab polls /api/state (or they pick). If they go quiet for
// AWAY_MS (tab closed / walked off), we treat them as away and auto-play ALL their tickets (primary + extras) at random
// from the committed seed, so their entry still competes for the pot and the round never stalls. They resume manual
// control the instant they pick again. (Extras are always auto; this only adds the primary when the owner is away.)
const AWAY_MS=30000;
function stampSeen(tok){ if(tok&&REG[tok]) REG[tok].lastSeen=Date.now(); }
function isAway(tok){ const r=tok&&REG[tok]; if(!r) return false; const s=r.lastSeen||0; return s>0 && (Date.now()-s)>AWAY_MS; }
function seatBots(n){ const o={}; for(let i=0;i<n;i++){ const id='bot_'+nid(); o[id]={name:BOTNAMES[i%BOTNAMES.length],bot:true,auto:false,owner:null,alive:true,pick:null,pre:null,left:false,busted:false,win:false}; } return o; }
function addBot(){ const id='bot_'+nid(); const base=BOTNAMES[Math.floor(Math.random()*BOTNAMES.length)]; const nm=base+(Math.random()<0.35?('·'+Math.floor(10+Math.random()*89)):''); G.players[id]={name:nm,bot:true,auto:false,owner:null,alive:true,pick:null,pre:null,left:false,busted:false,win:false}; }
// HARD per-game ticket ceiling = 3 (product rule, Jake 2026-10-12). Was 10, which let the autobuy/autoplay UI
// request up to 10/game; 3 is the max everywhere now (UI, seating, and the on-chain maxTicketsPerWallet is set to 3).
const MAX_TIX_PER_GAME = 3;
function clampTickets(n){ n=parseInt(n,10); return (Number.isInteger(n)&&n>0)?Math.min(MAX_TIX_PER_GAME,n):1; }
function seatRegistered(players){ Object.keys(REG).forEach(tok=>{ if(!REG[tok].active)return; const n=clampTickets(REG[tok].tickets); for(let k=0;k<n;k++){ const id=k===0?tok:(tok+'#'+k); players[id]={name:REG[tok].name+(k?(' #'+(k+1)):''),bot:false,auto:k>0,owner:tok,alive:true,pick:null,pre:REG[tok].pre,left:false,busted:false,win:false}; } }); }
// live-seat/adjust a token's tickets in the current lobby (fill filling/armed or clock lobby), respecting cap
function seatToken(tok){ if(!G||!REG[tok])return; const want=clampTickets(REG[tok].tickets);
  for(let k=0;k<want;k++){ const id=k===0?tok:(tok+'#'+k); if(!G.players[id]){ if(C.cap&&seatCount()>=C.cap)break; G.players[id]={name:REG[tok].name+(k?(' #'+(k+1)):''),bot:false,auto:k>0,owner:tok,alive:true,pick:null,pre:REG[tok].pre,left:false,busted:false,win:false}; } }
  Object.keys(G.players).forEach(id=>{ if(G.players[id].owner===tok){ const k=id===tok?0:parseInt(id.split('#')[1],10); if(k>=want) delete G.players[id]; } });
}
// REAL-MONEY coupling: we're in a real-money round when the on-chain escrow is live AND the engine is a
// real-money-capable cadence (fixed CLOCK or threshold-fill RMFILL). Fake-chip `fill` preview stays off this path.
function realMoney(){ return escrow.isOn() && (C.engine==='clock' || C.engine==='rmfill'); }
// Seat EXACTLY n tickets for a wallet owner, where n is the count they actually bought ON-CHAIN (not REG.tickets).
// Mirrors seatToken but the seat count is authoritative from escrow, so a wallet can never play more than it paid for.
// ANTI-AGENT velocity flag (monitoring, NOT a block). A peer-pot heist with no cash-out and a 5% rake has no
// mechanical edge to grind, so a bot's only lever is tireless VOLUME — which the rake already makes EV-negative.
// We track distinct rounds each wallet ENTERS per rolling hour and WARN-log when one crosses a high threshold, so
// the ops/fairness layer has a signal. A legit high-roller is not an attacker, so we never auto-ban or alter play.
const VEL = { seen:new Set(), hits:Object.create(null), flagged:Object.create(null), WINDOW_MS:3600000, FLAG:40 };
function recordWalletEntry(addr, roundId){
  if(!addr || roundId==null) return; addr=String(addr).toLowerCase();
  const key=addr+':'+String(roundId); if(VEL.seen.has(key)) return; VEL.seen.add(key);
  if(VEL.seen.size>20000) VEL.seen.clear();                               // bound the per-round dedup set
  const now=Date.now(); const arr=(VEL.hits[addr]=(VEL.hits[addr]||[]).filter(t=>now-t<VEL.WINDOW_MS)); arr.push(now);
  if(arr.length>=VEL.FLAG && !VEL.flagged[addr]){ VEL.flagged[addr]=now;   // one WARN per wallet per window
    console.error('[vaultstandoff-dev] HIGH-VOLUME wallet '+addr+' entered '+arr.length+' rounds/hr (possible grinding agent; peer-pot+'+getCfg().rakeBps/100+'% rake keep it EV-negative — flagged for review, play unchanged)');
  } else if(arr.length<VEL.FLAG && VEL.flagged[addr] && (now-VEL.flagged[addr])>VEL.WINDOW_MS){ delete VEL.flagged[addr]; }
}
function velocityFlags(){ const now=Date.now(); const out=[]; for(const a in VEL.hits){ const n=VEL.hits[a].filter(t=>now-t<VEL.WINDOW_MS).length; if(n>=VEL.FLAG) out.push({wallet:a, roundsLastHour:n, since:VEL.flagged[a]||null}); } return out.sort((x,y)=>y.roundsLastHour-x.roundsLastHour); }
function seatWalletCount(tok,n){ if(!G||!REG[tok])return; n=Math.max(0,Math.min(G._walletCap||walletCap(),parseInt(n,10)||0));   // Sybil policy: hard per-wallet seat cap (computed ceil(pct% * roundTarget), fixed for the round)
  if(n>0){ try{ recordWalletEntry((REG[tok]&&REG[tok].address)||escrow.addrOfToken(tok), G.roundId); }catch(_){} }   // anti-agent: log distinct-round entry (deduped), monitoring only
  for(let k=0;k<n;k++){ const id=k===0?tok:(tok+'#'+k); if(!G.players[id]){ if(C.cap&&seatCount()>=C.cap)break; G.players[id]={name:REG[tok].name+(k?(' #'+(k+1)):''),bot:false,auto:k>0,owner:tok,alive:true,pick:null,pre:REG[tok].pre,left:false,busted:false,win:false}; } }
  Object.keys(G.players).forEach(id=>{ if(G.players[id].owner===tok){ const k=id===tok?0:parseInt(id.split('#')[1],10); if(k>=n) delete G.players[id]; } });
}
function resolve(c){
  G.resolved[c]=true;
  const av=aliveList();
  // a lone survivor reaching any chamber WINS outright (never self-bust)
  if(av.length<=1){ G.done=true; G.champ=av[0]?{name:av[0][1].name,you:!av[0][1].bot,owners:[av[0][1].owner].filter(Boolean)}:{none:true,owners:[]}; return; }
  // absent-player default door is deterministic: prechoice if set, else a seeded draw (NOT Math.random).
  av.forEach(([id,p])=>{ if(p.pick==null){ p.pick=(p.pre&&p.pre[c]!=null&&p.pre[c]<G.routes.length)?p.pre[c]:drandInt('default:'+id,G.routes.length); } });
  const cnt=countsNow();
  // deterministic tie-break for "most crowded": on a tie pick the lowest index (stable, replayable).
  let mx=0; for(let i=1;i<cnt.length;i++) if(cnt[i]>cnt[mx])mx=i;
  let n=0; av.forEach(([,p])=>{ if(p.pick===mx){ p.alive=false; p.busted=true; n++; } });
  // degenerate no-bust case (all on different doors): force one bust via a seeded draw, not Math.random.
  if(n===0 && av.length>1){ const v=av[drandInt('forcedbust',av.length)][1]; v.alive=false; v.busted=true; n=1; }
  // WINNER-TAKES-ALL: a chamber must NEVER wipe the whole field. If the doomed door caught everyone still in,
  // the seed spares exactly one (deterministic + replayable) so the round always yields a single champion.
  if(n>0 && aliveList().length===0){ const sp=av.filter(([,p])=>p.busted); const keep=sp[drandInt('spare:'+c,sp.length)][1]; keep.alive=true; keep.busted=false; n--; }
  G.counts=cnt; G.bust=mx; G.bustN=n;
  // proof trail: record ONLY which door busted + how many were caught per chamber (full per-door counts are
  // intentionally NOT persisted to the public proof, to deny a statistical edge; see reveal + /proof below).
  G.bustLog=G.bustLog||[]; G.bustLog.push({ chamber:c, door:mx, caught:n });
  const rem=aliveList();
  if(rem.length<=1){ G.done=true; G.champ=rem[0]?{name:rem[0][1].name,you:!rem[0][1].bot,owners:[rem[0][1].owner].filter(Boolean)}:{none:true,owners:[]}; }
}
function botPicks(){ // bots + a player's EXTRA (auto) tickets pick automatically; the player's primary is theirs
  // All auto/bot picks are SEEDED draws (keyed per ticket id) so the entire round replays from the committed
  // seed. In real-money rounds there are NO bots (clockNewGame seats zero), so this only drives a human's own
  // auto tickets there; bots exist solely for fake-chip liveliness.
  const c=countsNow(); let cold=0; for(let i=1;i<c.length;i++) if(c[i]<c[cold])cold=i;
  // FAIRNESS (2026-10-10): HOUSE BOTS keep the cold-lean (least-crowded door bias) for fake-chip liveliness/fill.
  // A PAYING PLAYER'S auto extra-ticket gets NO cold-lean edge: it plays the OWNER'S preset for this chamber if set
  // (pl.pre[c]), otherwise a PURE seeded random door. This removes the free door-spreading survival advantage that
  // paid extras used to get. Still fully seeded (keyed per ticket id) so the whole round replays from the seed.
  aliveList().forEach(([id,pl])=>{
    // AWAY AUTOPILOT: flag a human PRIMARY seat whose owner has gone quiet so it auto-plays like the extras. Cleared
    // the moment they pick again (/api/pick). Extras (pl.auto) and bots are always driven.
    if(!pl.bot && !pl.auto && pl.owner){ pl.away = isAway(pl.owner); }
    if(!(pl.bot||pl.auto||pl.away)) return;
    if(!(pl.pick==null||draw('jit:'+id)<0.3)) return;
    const c0=G.cur;
    if(pl.bot){
      // house bot: liveliness cold-lean preserved
      pl.pick=(draw('lean:'+id)<0.4?cold:drandInt('rnd:'+id,G.routes.length));
    } else {
      // paying player's auto extra: owner preset for this chamber if set, else PURE random (no cold-lean)
      pl.pick=(pl.pre&&c0!=null&&pl.pre[c0]!=null&&pl.pre[c0]<G.routes.length)?pl.pre[c0]:drandInt('rnd:'+id,G.routes.length);
    }
  });
}
// WINNER-TAKES-ALL (2026-10-09, Jake): the old chamber-6 "split/steal" finale is removed. Every chamber (incl.
// the last scheduled one) is now a normal herd-bust chamber; if >1 robber is still standing after the final
// scheduled chamber, sudden-death overtime (below) collapses the field to a single champion. No split, ever.
function enterChamber(c){ G.cur=c; G.routes=R.slice(0,routesFor(aliveCount())); aliveList().forEach(([,pl])=>{ pl.pick=null; });
  // ensure the round's committed seed is attached before any chamber draws from it (idempotent).
  if(!G.seed) attachSeed(G.start!=null?G.start:G.roundId); }
// SUDDEN-DEATH OVERTIME (winner-takes-all). If more than one robber survives all scheduled chambers, collapse to
// ONE champion with extra herd-bust rounds. Doors are kept LOW (VS_OT_DOORS, default 2) on purpose: fewer doors =
// more crowding = a bigger share caught each round = fewer rounds to a single winner (more doors would spread the
// field and DRAG it out, ~1 bust/round). Every door here is a SEEDED draw keyed to the round seed (round+id), so
// the whole overtime replays deterministically from the committed seed and lands in the public proof (ot:true).
function suddenDeath(){
  const OT_DOORS=Math.max(2, getCfg().otDoors||2);   // runtime-configurable (was env VS_OT_DOORS); fixed for the round at its boundary
  let round=0;
  while(aliveList().length>1 && round<64){
    const av=aliveList(), cnt=new Array(OT_DOORS).fill(0);
    av.forEach(([id,p])=>{ p.pick=drandInt('ot:'+round+':'+id,OT_DOORS); cnt[p.pick]++; });
    let mx=0; for(let i=1;i<OT_DOORS;i++) if(cnt[i]>cnt[mx])mx=i;
    let caught=av.filter(([,p])=>p.pick===mx);
    if(caught.length===av.length){ const sp=caught[drandInt('otspare:'+round,caught.length)]; caught=caught.filter(x=>x!==sp); }  // never zero-out: spare one
    if(caught.length===0){ caught=[av[drandInt('otforce:'+round,av.length)]]; }                                                 // spread field: force one bust so it always progresses
    caught.forEach(([,p])=>{ p.alive=false; p.busted=true; });
    (G.bustLog=G.bustLog||[]).push({ chamber:C.maxch+round, door:mx, caught:caught.length, ot:true });
    round++;
  }
}
function endGameFallback(){ if(!G.done){ if(aliveList().length>1) suddenDeath(); const rem=aliveList(); G.done=true; G.champ=rem.length?{name:rem[0][1].name,you:!rem[0][1].bot,owners:[rem[0][1].owner].filter(Boolean)}:{none:true,owners:[]}; } }

// ---- REAL-TIME SUDDEN-DEATH OVERTIME (live, playable) -----------------------------------------------------
// Instead of collapsing the surviving field instantly (suddenDeath, kept below as the synchronous fallback), the
// LIVE engines route a >1-survivor finish through here: a timed CHOOSE -> REVEAL loop, one real OT round at a
// time, so players actually PLAY each sudden-death round. The RESOLUTION math is IDENTICAL to suddenDeath() and
// to the scheduled-chamber resolve() rails (most-crowded door busts; spare-one-if-all-caught; force-one-if-none),
// and every door is the SAME seeded draw (label 'ot:<round>:<id>', 'otspare:<round>', 'otforce:<round>') keyed to
// the committed round seed, so the live overtime lands in the public proof and replays deterministically. Crowd
// picks stay HIDDEN (/api/state heat is null, no per-door counts) during OT choose exactly like a normal chamber.
function otDoorsN(){ return Math.max(2, getCfg().otDoors||2); }
// Enter overtime: snapshot the OT timers (config can't change a live OT) and arm the first CHOOSE phase. Called
// once, when the final scheduled chamber resolves with >1 survivor. Idempotent (no-op if already in OT or done).
function enterOvertime(now){
  if(!G || G.done || G.ot) return;
  if(aliveList().length<=1){ // degenerate: <=1 already standing -> finish normally, no overtime needed
    const rem=aliveList(); G.done=true; G.champ=rem.length?{name:rem[0][1].name,you:!rem[0][1].bot,owners:[rem[0][1].owner].filter(Boolean)}:{none:true,owners:[]}; return;
  }
  const cfg=getCfg();
  G.ot=true; G.otRound=0; G._hadOt=true;   // durable flag: this round reached overtime (ceremony marks it a near-miss)
  G.otDoorsN=otDoorsN();                                    // doors fixed for the whole overtime
  // V5 FINAL VAULT: OT round 0 is a wide-door STANDOFF. If the whole surviving crowd converges on one door, everybody
  // busts and the pot rolls into the progressive jackpot. More doors here => rollover is exciting-rare (~1/fvDoors for
  // a 2-player standoff), not a coin flip. Rounds >=1 fall back to the normal low-door collapse (always crowns a winner).
  G.fvDoors = Math.max(3, (getCfg().finalVaultDoors || 5));
  G.rolloverOn = (Number(getCfg().jackpotRollover) !== 0);  // 1=on (default), 0=off
  G.rollover = false;
  G.otChooseMs=Math.max(1000, (cfg.otChooseSec||8)*1000);   // snapshot timers so a mid-OT config edit can't warp it
  G.otRevealMs=Math.max(500,  (cfg.otRevealSec||4)*1000);
  G.otBust=null; G.otCaught=0; G.otRevealed=false; G.otSurvivors=0;
  G.otPhase='choose'; G.otPhaseEnds=now+G.otChooseMs;
  _otStartChoose();
}
// Begin a CHOOSE phase: reset every finalist's pick (so each OT round is a fresh decision). Humans may actively
// pick during the window (same pickDoor path as a scheduled chamber); absent/auto/bot tickets fall to the SEEDED
// default at resolve, exactly like resolve()'s absent-default. Routes are kept at the OT door count for the UI.
function _otStartChoose(){
  const dn = (G.otRound===0 && G.rolloverOn) ? (G.fvDoors || G.otDoorsN) : G.otDoorsN;   // Final Vault (round 0) is wider
  G.curOtDoors = dn;
  G.cur = C.maxch + G.otRound;                              // a synthetic chamber index past the scheduled ones (also what bustLog uses)
  G.routes = R.slice(0, dn);                                // round 0: wide standoff; later: low door count -> converges
  aliveList().forEach(([,pl])=>{ pl.pick=null; });
  G.otBust=null; G.otCaught=0; G.otRevealed=false;
}
// Resolve one OT round (end of its CHOOSE phase). Mirrors suddenDeath()'s per-round body AND resolve()'s rails,
// using the identical seeded labels so the live path and the fallback produce the same outcome from the same seed.
function _otResolveRound(){
  const r=G.otRound, OT=(r===0 && G.rolloverOn) ? (G.fvDoors||G.otDoorsN) : G.otDoorsN, av=aliveList(), cnt=new Array(OT).fill(0);
  // absent/auto/bot tickets use the seeded default (same label as suddenDeath); a human's own live pick is kept.
  av.forEach(([id,p])=>{ if(p.pick==null || p.pick>=OT) p.pick=drandInt('ot:'+r+':'+id,OT); cnt[p.pick]++; });
  let mx=0; for(let i=1;i<OT;i++) if(cnt[i]>cnt[mx])mx=i;                                   // most-crowded (low-index tie-break)
  let caught=av.filter(([,p])=>p.pick===mx);
  // V5 FINAL-VAULT ROLLOVER: OT round 0 only — if the WHOLE surviving crowd converged on ONE door, everybody busts and
  // there is no winner; the pot rolls into the progressive jackpot (rmEscSettleGame reads G.rollover). Rare by design
  // (wide fvDoors). Rounds >=1 fall through to the spare-one guard below and always crown a winner.
  // no-winner OT resolution rolls the pot over by design (operator-confirmed 2026-10-14)
  if(r===0 && G.rolloverOn && av.length>=2 && caught.length===av.length){
    caught.forEach(([,p])=>{ p.alive=false; p.busted=true; });
    G.rollover=true;
    G.otBust=mx; G.otCaught=caught.length; G.otSurvivors=0; G.otRevealed=true; G.otCounts=cnt.slice();
    (G.bustLog=G.bustLog||[]).push({ chamber:C.maxch+r, door:mx, caught:caught.length, ot:true, rollover:true });
    return;
  }
  if(caught.length===av.length){ const sp=caught[drandInt('otspare:'+r,caught.length)]; caught=caught.filter(x=>x!==sp); }   // never zero-out: spare one
  if(caught.length===0){ caught=[av[drandInt('otforce:'+r,av.length)]]; }                                                    // force one so it always progresses
  caught.forEach(([,p])=>{ p.alive=false; p.busted=true; });
  G.otBust=mx; G.otCaught=caught.length; G.otSurvivors=aliveList().length; G.otRevealed=true;
  // Persist the full per-door tally for this OT round so the reveal-only distribution bars can render it.
  // SAME anti-bot rule as normal chambers: this is surfaced ONLY during the OT reveal sub-phase (see
  // buildStatePayload's `sub==='reveal'` guard), never during an OT choose window.
  G.otCounts=cnt.slice();
  (G.bustLog=G.bustLog||[]).push({ chamber:C.maxch+r, door:mx, caught:caught.length, ot:true });   // SAME proof shape as suddenDeath
}
// OT tick, driven from each live engine's play loop. Advances the choose/reveal timers and either loops into the
// next OT round or, when <=1 finalist remains (or the 64-round hard cap is hit), crowns the winner-takes-all champ.
// Returns true while OT is active (the engine should NOT run its normal ended/fallback path while this owns the game).
function otTick(now){
  if(!G || !G.ot) return false;
  if(G.otPhase==='choose'){
    if(now < G.otPhaseEnds) return true;                    // still choosing
    _otResolveRound();                                      // choose window closed -> resolve this OT round
    G.otPhase='reveal'; G.otPhaseEnds=now+G.otRevealMs;
    return true;
  }
  // reveal phase
  if(now < G.otPhaseEnds) return true;                      // let the reveal breathe (the big moment)
  // reveal done: winner-takes-all if the field collapsed to one (or hit the safety cap), else next OT round.
  if(aliveList().length<=1 || G.otRound>=63){
    const rem=aliveList();
    G.done=true; G.ot=false;
    G.champ=rem.length?{name:rem[0][1].name,you:!rem[0][1].bot,owners:[rem[0][1].owner].filter(Boolean)}:{none:true,owners:[]};
    return false;                                           // OT finished; engine proceeds to its ended path
  }
  G.otRound++; G.otPhase='choose'; G.otPhaseEnds=now+G.otChooseMs; _otStartChoose();
  return true;
}

// ROUND-BOUNDARY config apply. Called at the start of every new game (clock or fill): promote any staged
// pending config to active, then overlay the active economy config onto the live engine params `C` and
// snapshot the per-round cap onto `G`. This is the ONLY place config takes effect, so a running round always
// finishes under the terms it started with. Timers are clamped so a bad combo can never stall the tick loop.
function applyCfgAtBoundary(){
  applyPendingCfg();
  applyAutoplayAtBoundary();   // FEATURE 2: re-apply durable autoplay pre-choices into REG for the new round
  const cfg=getCfg();
  C.maxch = cfg.maxChambers;
  C.choose = cfg.chooseSec*1000;
  C.reveal = cfg.revealSec*1000;
  if(C.lobby!=null) C.lobby = cfg.lobbySec*1000;        // dev clock uses a ms lobby directly
  if(C.cap!=null) C.cap = cfg.roundTarget;              // fill cap = round target
  if(C.threshold!=null) C.threshold = Math.max(1, Math.ceil(cfg.thresholdPct/100 * cfg.roundTarget));  // arm at thresholdPct of target
  // THRESHOLD-FILL: target + thresholdPct + grace come from the hot economy config at the boundary too, so an
  // operator tunes the fill cadence the same way as the clock timers. (cap already tracks target above.)
  if(C.engine==='rmfill'){ C.target = cfg.roundTarget; C.thresholdPct = cfg.thresholdPct; C.graceMs = cfg.graceSec*1000; }
  return cfg;
}
// ---- CLOCK engine ----
function alignStart(now){ return MODE==='daily' ? Math.floor(now/DAY)*DAY : Math.floor(now/C.interval)*C.interval; }
function buildSched(gs){
  const chooseStart=[], locks=[];
  if(MODE==='dev'){
    const lobbyEnd=gs+C.lobby; let t=lobbyEnd;
    for(let i=0;i<C.maxch;i++){ chooseStart[i]=t; locks[i]=t+C.choose; t=locks[i]+C.reveal; }
    return {gameStart:gs,lobbyEnd,chooseStart,locks,blind:C.blind,reveal:C.reveal,maxch:C.maxch,gameEnd:t,next:gs+C.interval};
  }
  const u=C.unit, lobbyEnd=gs+C.lobbyU*u;
  for(let i=0;i<C.maxch;i++){ locks[i]=gs+(C.firstLockU+i*C.spacingU)*u; chooseStart[i]= i===0?lobbyEnd:locks[i-1]+C.reveal; }
  return {gameStart:gs,lobbyEnd,chooseStart,locks,blind:C.blind,reveal:C.reveal,maxch:C.maxch,gameEnd:locks[C.maxch-1]+C.reveal,next:gs+C.interval};
}
function clockNewGame(gs){
  // real-money: ZERO bots. The round is funded and resolved purely by on-chain participants, so no house
  // bot ever influences countsNow / which-door-busts / the finale. Bots seat ONLY for fake-chip liveliness.
  // Wallets are seated by their on-chain buy-in (escrowLifecycle lobby-sync); off-chain preview seats regs.
  applyCfgAtBoundary();   // promote staged config + overlay onto C BEFORE the schedule is built off C.*
  const rm=realMoney();
  const players=rm?{}:seatBots(MINBOTS); if(!rm) seatRegistered(players);
  G={ engine:'clock', start:gs, sched:buildSched(gs), players, routes:R.slice(0,routesFor(Object.keys(players).length)), cur:-1, resolved:{}, done:false, champ:null, counts:null, bust:null, bustN:0, roundId:String(gs), bustLog:[], _walletCap:walletCap() };
  attachSeed(gs);   // bind the round's committed seed up front so settle can always reveal it
}
function clockPhaseAt(now){
  const gs=alignStart(now), cur=G&&G.start===gs, S=cur?G.sched:buildSched(gs);
  if(cur&&G.done) return {phase:'ended',S};
  if(now < S.chooseStart[0]) return {phase:'lobby',S};
  for(let c=0;c<S.maxch;c++){
    if(now < S.locks[c]){
      if(now < S.chooseStart[c]) return {phase:'reveal',chamber:c-1,S};
      return {phase:'choose',chamber:c,blind: now>=S.locks[c]-S.blind, lockIn:S.locks[c]-now, cwin:S.locks[c]-S.chooseStart[c], S};
    }
  }
  const last=S.maxch-1;
  if(now < S.locks[last]+S.reveal) return {phase:'reveal',chamber:last,S};
  return {phase:'ended',S};
}
function clockTick(){
  const now=Date.now(), gs=alignStart(now);
  if(!G||G.engine!=='clock'||G.start!==gs) clockNewGame(gs);
  const p=clockPhaseAt(now);
  if(p.phase==='choose'){ if(p.chamber!==G.cur) enterChamber(p.chamber); if(!p.blind) botPicks(); }
  else if(p.phase==='reveal' && p.chamber>=0){ if(!G.resolved[p.chamber]){ resolve(p.chamber); } }
  else if(p.phase==='ended'){ endGameFallback(); }
}

// ---- THRESHOLD-FILL real-money engine (Phase A) --------------------------------------------------------------
// Demand-driven cadence that IS the on-chain driver. Unlike the fake `fill` engine, there are NO bots and the
// pot/seats come straight from on-chain buy-ins. Round ids are a DISK-PERSISTED MONOTONIC COUNTER (not an aligned
// timestamp), so a restart resumes the sequence. One round is "current" (filling/playing); the rolling pre-open
// keeps the NEXT id open on-chain too, so buy-in is always available and there is zero dead time between games.
//
// State machine (per round, driven from the 1s tick via rmfillTick + rmEscrowLifecycle):
//   filling -> locking -> committed(play) -> ended -> (settle/void in rmEscrowLifecycle)
// The on-chain lifecycle (open sentinel round / lockRound at threshold / commit / settle-or-void) lives in
// rmEscrowLifecycle so the game loop never blocks on an RPC call, mirroring the clock path's escrowLifecycle.
const RMID_FILE = path.join(STORE_DIR, 'rmround.json');     // { nextId } monotonic round-id counter, survives restart
function rmLoadNextId(){ const o=loadJson(RMID_FILE, null); const n=(o&&Number.isInteger(o.nextId)&&o.nextId>0)?o.nextId:1; return n; }
function rmSaveNextId(n){ saveJsonAtomic(RMID_FILE, { nextId:n }); }
let RM_NEXT_ID = rmLoadNextId();
function rmAllocId(){ const id=RM_NEXT_ID; RM_NEXT_ID=id+1; rmSaveNextId(RM_NEXT_ID); return id; }
// Reserve an id in the persisted counter so a PRE-OPENED next round (cur+1) can never be handed out again after a
// restart. The engine opens BOTH cur and cur+1 on-chain, but rmAllocId only advances the counter by 1 per game, so
// without this the counter trails the highest on-chain id by one -- and after a restart it re-allocates that already
// opened+voided pre-open id, whose round reads not-Open, freezing the lobby at "buy-in has closed". (root-cause fix)
function rmReserve(minNext){ if(Number.isInteger(minNext) && minNext>RM_NEXT_ID){ RM_NEXT_ID=minNext; rmSaveNextId(RM_NEXT_ID); } }
// BOOT RECONCILE: walk the persisted nextId forward past any id already written on-chain (Open/Committed/Settled/
// Voided) to the first never-written (status None) slot, so a fresh game always opens on an open-able id. Guards:
// only runs when escrow is on; an RPC hiccup (readRound -> null) aborts and retries next tick rather than guessing.
let RM_RECONCILED=false, RM_RECONCILING=false;
async function rmReconcileNextId(){
  if(RM_RECONCILED || RM_RECONCILING) return;
  RM_RECONCILING=true;
  try{
    if(!escrow.isOn()){ RM_RECONCILED=true; return; }
    let id=RM_NEXT_ID, scanned=0;
    while(scanned<256){
      const r=await escrow.readRound(id).catch(()=>null);
      if(r===null) return;                 // RPC/contract read failed: do NOT guess; retry next tick
      if(Number(r.status)===0) break;       // first never-written slot: safe to open here
      id++; scanned++;
    }
    if(id!==RM_NEXT_ID){ RM_NEXT_ID=id; rmSaveNextId(RM_NEXT_ID); try{console.log('[vaultstandoff-dev] rmfill reconciled nextId ->', id);}catch(_){} }
    RM_RECONCILED=true;
  }catch(_){ /* leave unreconciled; retry next tick */ }
  finally{ RM_RECONCILING=false; }
}
// rmfill round bookkeeping (spans games, so module-scope). G holds the CURRENT round only.
let RM_CUR=null;            // the current round id (filling or playing); null before the first open
let RM_BUY=null;            // the round id a buy-in targets (the earliest still-Open round = the next pre-open)
let RM_OPEN=[];             // RUSH OVERFLOW (preopenDepth>2): ordered list of currently-open round ids in the window
let RM_SOLD={};             // RUSH OVERFLOW: id -> seats sold, refreshed each lifecycle tick from on-chain (depth>2)
const RM_SENTINEL={};       // id -> on-chain sentinel lockTime (for restart-resilient commit timing)

function rmThresholdTickets(){ return Math.max(1, Math.ceil((C.thresholdPct||50)/100 * (C.target||50))); }
// DYNAMIC GRACE (OFF-CHAIN). Given the number of tickets sold, return the grace window in ms: the ceiling
// (C.graceMs) at/below threshold, falling toward the floor (graceFloorSec) as fill climbs threshold->target. The
// curve knob (graceCurvePct) shapes how fast it drops (100 = linear). This is a PURE display/timer helper: callers
// only ever use it to set the LOCAL G.graceEnds timestamp, never to drive an on-chain call. Clamped so a bad config
// can't invert the window (floor is capped at the ceiling).
function rmGraceMsFor(sold){
  const ceil = Math.max(0, C.graceMs!=null?C.graceMs:600000);
  const floor = Math.min(ceil, Math.max(0, (getCfg().graceFloorSec||0)*1000));
  const thr = rmThresholdTickets(), target = (C.target||50);
  if(target<=thr) return ceil;                                  // no headroom to shrink across -> ceiling
  const t = Math.max(0, Math.min(1, ((sold||0)-thr)/(target-thr)));   // 0 at threshold, 1 at target
  const curve = Math.max(0.1, (getCfg().graceCurvePct||100)/100);
  const eased = Math.pow(t, curve);                             // >1 holds ceiling longer, <1 drops faster early
  return Math.round(ceil - (ceil-floor)*eased);
}
function rmNewGame(roundId){
  applyCfgAtBoundary();   // promote staged config + overlay onto C before seating/threshold use C.*
  // NO bots, ever: the round is funded + resolved purely by on-chain participants (same invariant as clockNewGame
  // real-money). Wallets are seated by rmEscrowLifecycle's lobby-sync from their on-chain buyIn count.
  G={ engine:'rmfill', roundId:String(roundId), rmId:roundId, phase:'filling', players:{}, roster:false,
      armedAt:null, graceEnds:null, runStart:null, routes:[], cur:-1, resolved:{}, done:false,
      champ:null, counts:null, bust:null, bustN:0, endedAt:null, ticketsSold:0, locked:false,
      _walletCap:walletCap() };
  attachSeed(roundId);   // bind + commit-at-open the round's durable seed so commit==reveal always holds
}
// Relative-clock play info (identical math to the fake fill engine's running phase; no wall grid).
function rmRunInfo(now){
  const rel=now-G.runStart, SLOT=C.choose+C.reveal, c=Math.floor(rel/SLOT), within=rel-c*SLOT;
  if(c>=C.maxch) return {phase:'ended'};
  if(within<C.choose) return {phase:'choose',chamber:c,blind:within>=C.choose-C.blind,lockIn:Math.max(0,Math.round((C.choose-within)/1000)),cwin:Math.round(C.choose/1000)};
  return {phase:'reveal',chamber:c};
}
// FILL VELOCITY (read-only liveness). A small ring of {ts, sold} samples on G lets the UI show a "filling fast"
// flag and a seats/min rate. Pure observation: it never gates a lock or touches escrow. recordFillSample is called
// whenever the fill count changes (rmfill: on each on-chain sync; fake fill: each bot-seat tick).
function recordFillSample(sold){
  if(!G) return;
  const now=Date.now(); G._fillSamples=G._fillSamples||[];
  const last=G._fillSamples[G._fillSamples.length-1];
  if(last && last.sold===sold){ last.ts=now; return; }   // coalesce no-change samples (keep the latest ts)
  G._fillSamples.push({ ts:now, sold:sold });
  while(G._fillSamples.length>24) G._fillSamples.shift();
}
// Recent fill rate in seats/min over the trailing window (default 30s), plus a "fast" flag. Returns {rate, fast}.
// "fast" means the recent rate implies the threshold's worth of seats would fill inside ~45s at this pace. Clamped
// and defensive so an empty/short sample history just reports rate 0 (not fast).
function fillVelocity(){
  const samples=(G&&G._fillSamples)||[]; if(samples.length<2) return { rate:0, fast:false };
  const now=Date.now(), WINDOW=30000;
  const recent=samples.filter(s=>now-s.ts<=WINDOW);
  const arr = recent.length>=2 ? recent : samples.slice(-2);
  const a=arr[0], b=arr[arr.length-1];
  const dt=(b.ts-a.ts)/1000; if(dt<=0) return { rate:0, fast:false };
  const rate=Math.max(0, (b.sold-a.sold)/dt*60);           // seats per minute
  const thr=(C.engine==='rmfill')?rmThresholdTickets():(C.threshold||50);
  // fast = at this pace a threshold's worth of seats lands within ~45s (a lively, "get in now" cadence)
  const fast = rate>0 && (thr/rate*60) <= 45;
  return { rate:Math.round(rate), fast:!!fast };
}
function rmfillTick(){
  const now=Date.now();
  // open the very first round if none exists yet (rmEscrowLifecycle opens it on-chain; here we build the game).
  if(!G || G.engine!=='rmfill'){
    if(RM_CUR==null){
      // On a real-money boot, reconcile the counter against on-chain state BEFORE opening the first round so we never
      // start a game on an already-voided/committed id (the "buy-in has closed" freeze). Wait (show forming) until done.
      if(escrow.isOn() && !RM_RECONCILED){ rmReconcileNextId(); return; }
      RM_CUR=rmAllocId();
    }
    rmNewGame(RM_CUR);
  }
  if(G.phase==='ended'){
    // ZERO DEAD TIME: the next round was already opened on-chain when THIS one locked, so just roll G onto it.
    // RM_CUR was advanced to the next id at lock-time (see 'locking' below); build its game now if not current.
    if(G.rmId!==RM_CUR) rmNewGame(RM_CUR);
    return;
  }
  if(G.phase==='filling'){
    // ticketsSold is synced from on-chain in rmEscrowLifecycle (G.ticketsSold). Arm the grace timer the first
    // time the pot crosses the threshold; lock immediately if the round is already full.
    const sold=G.ticketsSold||0, target=C.target||50, thr=rmThresholdTickets();
    // FEATURE 2 anti-all-bot-erosion: a round may only LOCK once enough actively-present (non-auto) humans are
    // seated. Default 0 (off). While unmet, we keep filling rather than locking into an all-autoplay room.
    const needPresent=minPresentRequired();
    const presentOk = needPresent<=0 || presentHumanCount()>=needPresent;
    if(sold>=target && presentOk){ G.phase='locking'; return; }          // full + present-gate ok -> immediate lock
    if(sold>=thr && G.graceEnds==null){ G.armedAt=now; G.graceEnds=now+rmGraceMsFor(sold); }
    // DYNAMIC GRACE (OFF-CHAIN ONLY): while armed, as more seats fill, shrink the remaining window toward the floor
    // so a near-full round starts fast. We only ever pull the deadline EARLIER (never push it out), measured from
    // the original arm time, so the countdown is monotonic and can't flap. This touches only the local G.graceEnds
    // timestamp; no on-chain call depends on it (lockRound/commit fire on the phase transition below, unchanged).
    if(G.graceEnds!=null && G.armedAt!=null){ const want=G.armedAt+rmGraceMsFor(sold); if(want<G.graceEnds) G.graceEnds=want; }
    if(G.graceEnds!=null && now>=G.graceEnds){                           // grace cap reached
      if(sold>=(C.minViable||2) && presentOk) G.phase='locking';         // enough to play + present-gate ok -> lock
      else G.graceEnds=null;                                            // under-fill OR present-gate unmet: disarm + keep filling (no dead time)
    }
    return;
  }
  if(G.phase==='locking'){
    // The on-chain lockRound + commit are fired by rmEscrowLifecycle (fire-and-forget, idempotent). The GAME
    // only starts the relative play clock once the round is committed on-chain (G.committed set by the lifecycle),
    // so commit==reveal holds and no chamber plays against a round whose buy-in is still open on-chain.
    if(G.committed){ G.phase='playing'; G.roster=true; G.runStart=Date.now(); G.cur=-1; }
    return;
  }
  if(G.phase==='playing'){
    // LIVE OVERTIME owns the game once armed (see fillTick). Its own timers drive it; the relative play clock is
    // bypassed until a single champion remains. On OT completion G.done is set and we fall through to 'ended'.
    if(G.ot){ if(otTick(now)) return; G.phase='ended'; G.endedAt=now; return; }
    const info=rmRunInfo(now);
    if(info.phase==='ended' || G.done){ endGameFallback(); G.phase='ended'; G.endedAt=now; return; }
    if(info.phase==='choose'){ const c=info.chamber; if(c!==G.cur) enterChamber(c); if(!info.blind) botPicks(); }
    else { const c=info.chamber; if(!G.resolved[c]){ resolve(c); if(!G.done && c>=C.maxch-1 && aliveList().length>1){ enterOvertime(now); return; } } if(G.done){ G.phase='ended'; G.endedAt=now; } }
  }
}

// ---- FILL engine (fake-chip preview ONLY; realMoney() requires the clock engine, so this path is never on-chain) ----
let FILL_SEQ=0;
function fillNewGame(){
  applyCfgAtBoundary();   // promote staged config + overlay onto C before seating/threshold use C.*
  const players=seatBots(C.seedBots); seatRegistered(players);
  const rid='fill:'+Date.now()+':'+(FILL_SEQ++);
  G={ engine:'fill', phase:'filling', players, roster:false, armedAt:null, fuseEnds:null, runStart:null, routes:[], cur:-1, resolved:{}, done:false, champ:null, counts:null, bust:null, bustN:0, endedAt:null, lastBot:Date.now(), roundId:rid, bustLog:[], _walletCap:walletCap() };
  attachSeed(rid);   // local (non-chain) committed seed so even the preview game is deterministic + loggable
}
function fillTick(){
  const now=Date.now();
  if(!G||G.engine!=='fill') fillNewGame();
  if(G.phase==='ended'){ if(now-G.endedAt>=C.resultMs) fillNewGame(); return; }
  if(G.phase==='filling'){
    // dev-preview trickle: ~1-2 buy-ins/sec so the threshold is reached in a lively ~30s
    if(seatCount()<C.threshold+2){ addBot(); if(Math.random()<0.6)addBot(); }
    recordFillSample(seatCount());   // read-only velocity sampling for the lobby "filling fast" flag
    if(seatCount()>=C.threshold){ G.phase='armed'; G.armedAt=now; G.fuseEnds=now+C.fuse; }
    return;
  }
  if(G.phase==='armed'){
    if(now-G.lastBot>=C.armEvery && seatCount()<C.cap){ addBot(); G.lastBot=now; }
    if(now>=G.fuseEnds || seatCount()>=C.cap){ G.phase='running'; G.roster=true; G.runStart=now; G.cur=-1; }
    return;
  }
  if(G.phase==='running'){
    // LIVE OVERTIME owns the game once armed: its own choose/reveal timers drive it, so the wall-clock slot math
    // below is bypassed until a single champion remains (or the OT path finishes and sets G.done).
    if(G.ot){ if(otTick(now)) return; G.phase='ended'; G.endedAt=now; return; }
    const rel=now-G.runStart, SLOT=C.choose+C.reveal, c=Math.floor(rel/SLOT), within=rel-c*SLOT;
    if(c>=C.maxch || G.done){ endGameFallback(); G.phase='ended'; G.endedAt=now; return; }
    if(within<C.choose){ if(c!==G.cur) enterChamber(c); if(within<C.choose-C.blind) botPicks(); }
    else { if(!G.resolved[c]){ resolve(c); if(!G.done && c>=C.maxch-1 && aliveList().length>1){ enterOvertime(now); return; } } if(G.done){ G.phase='ended'; G.endedAt=now; } }
  }
}
function fillRunInfo(now){
  const rel=now-G.runStart, SLOT=C.choose+C.reveal, c=Math.floor(rel/SLOT), within=rel-c*SLOT;
  if(c>=C.maxch) return {phase:'ended'};
  if(within<C.choose) return {phase:'choose',chamber:c,blind:within>=C.choose-C.blind,lockIn:Math.max(0,Math.round((C.choose-within)/1000)),cwin:Math.round(C.choose/1000)};
  return {phase:'reveal',chamber:c};
}

// ---- on-chain escrow lifecycle (Option D). Real-money rounds run on the CLOCK cadence, where lock/deadline
// times are deterministic and map cleanly to the contract. Idempotent + fire-and-forget + fully guarded so an
// RPC hiccup can never stall the 1s game loop, and a no-op entirely unless VS_ESCROW=on with VS_ENTRY_WEI set.
//
// ROLLING TWO-ROUND model: the CURRENT game's round AND the NEXT game's round are both kept open on-chain, so a
// spectator can pre-buy the upcoming heist while one is live, and be seated the instant the next lobby opens.
// Round tracking spans games, so it lives at module scope (G is recreated every game). ----
const ESC_OPENED=new Set(), ESC_COMMITTED=new Set(), ESC_SETTLED=new Set(), ESC_SEED={};
// CACHED RAKE RATE (read-only). The live on-chain rake rate, refreshed on the SAME throttled cadence as the pot
// reads below. buildStatePayload() is synchronous, so it cannot await escrow.rakeBps(); it reads this snapshot to
// surface the win-ceremony payout math (pot / rake / take). This is PURELY for display — the authoritative rake
// is the on-chain rakeBpsSnap captured when the round opened, and settlement money math is untouched. Null until
// the first successful read (the ceremony then falls back to pot-only copy).
// ===== USD-PEGGED ROUND ENTRY (Option 1: off-chain price, oracle-free contract) ==========================
// Each round's entry is set to $entryUsd worth of RVLT at OPEN. Hardened so a single manipulated source can't
// distort a round: MEDIAN of independent sources -> short rolling TWAP -> round-over-round CLAMP band. The money
// contract NEVER reads a price (zero on-chain oracle surface); per-round UNIFORM entries keep the peer pot
// symmetric so a wrong price can't be weaponized. MAINNET RVLT is always the priced asset (testnet RVLT has no
// market) so dev exercises the identical path; entry base-units are charged in the active escrow's RVLT (both
// 18-dec). ANY failure falls back to the static escrow.entryWei() so a round never opens on a broken price.
// This module is the single swappable price seam: to move toward an on-chain signed-price+TWAP guardrail later,
// only pegEntryWei() changes; the rest of the engine and the contract are untouched.
const PEG = { RVLT:'0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04', USDG:'0x5fc5360d0400a0fd4f2af552add042d716f1d168', CHAIN:4663,
  twap:[], TWAP_MS:10*60*1000, TWAP_MAX:40, lastWei:null, CLAMP_PCT:25, anchorWei:null, anchorTs:0, BAND_PCT:60, ANCHOR_TTL_MS:6*3600*1000, _memo:{ts:0,wei:null} };
// PEG COLD-START HARDENING (LOW): persist the last-known-good entry (lastWei + the 6h anchor) to disk so a RESTART
// does not reset the clamp/band to "unbounded". On boot we reload it into PEG so the FIRST round after a restart is
// already bounded by the prior good price (the ±CLAMP_PCT step + ±BAND_PCT anchor cap apply immediately), instead of
// opening at a fresh single-source read that a one-sided wash-trade could set. If the file is absent/corrupt we stay
// null and the single-source cold-start guard in usdToRvltWei falls back to the static entryWei (see below).
const PEG_FILE = path.join(STORE_DIR, 'peg-price.json');   // { lastWei:string, anchorWei:string, anchorTs:number }
function savePegPrice(){ try{ saveJsonAtomic(PEG_FILE, { lastWei:(PEG.lastWei!=null?PEG.lastWei.toString():null), anchorWei:(PEG.anchorWei!=null?PEG.anchorWei.toString():null), anchorTs:PEG.anchorTs||0 }); }catch(_){} }
(function _loadPegPrice(){ try{ const p=loadJson(PEG_FILE, null); if(!p) return;
  if(typeof p.lastWei==='string' && /^\d+$/.test(p.lastWei)){ const v=BigInt(p.lastWei); if(v>0n) PEG.lastWei=v; }
  if(typeof p.anchorWei==='string' && /^\d+$/.test(p.anchorWei)){ const v=BigInt(p.anchorWei); if(v>0n){ PEG.anchorWei=v; PEG.anchorTs=Number(p.anchorTs)||Date.now(); } }
  if(PEG.lastWei!=null||PEG.anchorWei!=null) console.log('[vaultstandoff-dev] PEG seeded from last-known-good price (restart cold-start bounded): lastWei='+(PEG.lastWei!=null?(PEG.lastWei/10n**18n)+' RVLT':'-'));
}catch(_){} })();
async function _pegGecko(){ try{ const r=await fetch('https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/'+PEG.RVLT,{headers:{accept:'application/json'},signal:AbortSignal.timeout(8000)}); if(!r.ok) return null; const j=await r.json(); const p=parseFloat(j&&j.data&&j.data.attributes&&j.data.attributes.price_usd); return (Number.isFinite(p)&&p>0)?p:null; }catch(_){ return null; } }
async function _pegRelay(usd){ try{ const amt=String(BigInt(Math.round(usd*1e6))); const body={ user:'0x000000000000000000000000000000000000dEaD', recipient:'0x000000000000000000000000000000000000dEaD', originChainId:PEG.CHAIN, destinationChainId:PEG.CHAIN, originCurrency:PEG.USDG, destinationCurrency:PEG.RVLT, amount:amt, tradeType:'EXACT_INPUT' }; const r=await fetch('https://api.relay.link/quote',{method:'POST',headers:{'Content-Type':'application/json',...(process.env.RELAY_API_KEY?{'x-api-key':process.env.RELAY_API_KEY}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)}); if(!r.ok) return null; const j=await r.json(); const outWei=(j&&j.details&&j.details.currencyOut&&j.details.currencyOut.amount)||(j&&j.currencyOut&&j.currencyOut.amount)||null; if(!outWei) return null; const rvlt=Number(BigInt(outWei))/1e18; return (rvlt>0)?(usd/rvlt):null; }catch(_){ return null; } }
function _pegMedian(a){ const s=a.filter(x=>Number.isFinite(x)&&x>0).sort((x,y)=>x-y); if(!s.length) return null; const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
// Returns { price, sources, samples }: the TWAP-window median price, how many INDEPENDENT live sources backed the
// latest sample (0/1/2), and how many samples are in the rolling TWAP window. The caller uses sources+samples to
// decide whether a cold-start price is trustworthy enough to open a round at (see usdToRvltWei).
async function pegPriceUsdPerRvlt(usd){ const [a,b]=await Promise.all([_pegGecko(), _pegRelay(usd)]); const fresh=[a,b].filter(x=>x!=null); const live=_pegMedian(fresh); const now=Date.now(); if(live!=null){ PEG.twap.push({ts:now,price:live}); while(PEG.twap.length>PEG.TWAP_MAX) PEG.twap.shift(); } const win=PEG.twap.filter(e=>now-e.ts<=PEG.TWAP_MS).map(e=>e.price); return { price:_pegMedian(win), sources:fresh.length, samples:win.length }; }
async function usdToRvltWei(usd){ if(PEG._memo.wei!=null && (Date.now()-PEG._memo.ts)<20000) return PEG._memo.wei;
  const q=await pegPriceUsdPerRvlt(usd); const price=q&&q.price; if(price==null||!(price>0)) return null;   // no live price at all -> caller (pegEntryWei) falls back to static entryWei
  // COLD-START GUARD (LOW): the clamp (±CLAMP_PCT vs PEG.lastWei) and the anchor band (±BAND_PCT vs PEG.anchorWei)
  // are what make a single manipulated read harmless. If NEITHER is seeded yet (truly cold — no disk seed, no prior
  // round this process) AND the price is backed by only ONE source with only ONE TWAP sample, there is nothing to
  // bound a one-sided manipulation, so we REFUSE to open at it and fall back to the static entryWei (return null).
  // Once a second source agrees (sources>=2) OR the TWAP has >=2 samples OR a disk-seeded anchor/last exists, the
  // normal clamp+band path runs. This only ever affects the first read(s) after a fresh boot with a flaky source.
  const seeded=(PEG.lastWei!=null || PEG.anchorWei!=null);
  if(!seeded && q.sources<2 && q.samples<2){ console.error('[vaultstandoff-dev] PEG cold-start: single-source price with no seed/TWAP — refusing to open at an unvalidated price; using static entryWei fallback this round'); return null; }
  let wei=BigInt(Math.round((usd/price)*1e6))*(10n**12n); if(PEG.lastWei){ const lo=PEG.lastWei*BigInt(100-PEG.CLAMP_PCT)/100n, hi=PEG.lastWei*BigInt(100+PEG.CLAMP_PCT)/100n; if(wei<lo)wei=lo; else if(wei>hi)wei=hi; }
  // AUDIT MED-2: absolute sanity band vs a TIME-GATED anchor. The per-round ±CLAMP_PCT clamp above bounds a single
  // step, but a sustained wash-trade of a price source could walk the entry CLAMP_PCT%/round over many rounds. A
  // self-following (EMA) anchor would just get dragged with it, so the anchor is RE-SNAPPED at most once per
  // ANCHOR_TTL_MS (6h). Within that window ±BAND_PCT is a HARD cap: an attacker must hold the manipulation for the
  // full window just to move the reference, and even then only to a band-limited value. Legit multi-day drift still
  // tracks on each re-snap. A band hit is logged as a manipulation smoke-alarm. (Note: entries are per-round uniform
  // in a peer pot, so a wrong entry is symmetric/non-extractive anyway; this bounds grief/UX, not theft.)
  if(PEG.anchorWei){ const alo=PEG.anchorWei*BigInt(100-PEG.BAND_PCT)/100n, ahi=PEG.anchorWei*BigInt(100+PEG.BAND_PCT)/100n;
    if(wei<alo || wei>ahi){ console.error('[vaultstandoff-dev] PEG band hit: $'+(getCfg().entryUsd||10)+' priced at '+(wei/10n**18n)+' RVLT, outside ±'+PEG.BAND_PCT+'% of the 6h anchor '+(PEG.anchorWei/10n**18n)+' — a price source may be manipulated; holding at the band edge'); wei = wei<alo?alo:ahi; } }
  { const now=Date.now(); if(PEG.anchorWei==null || (now-PEG.anchorTs)>PEG.ANCHOR_TTL_MS){ PEG.anchorWei=wei; PEG.anchorTs=now; } }
  PEG.lastWei=wei; PEG._memo={ts:Date.now(),wei}; savePegPrice(); return wei; }
async function pegEntryWei(){ try{ const w=await usdToRvltWei(Number(getCfg().entryUsd)||10); if(w&&w>0n) return w; }catch(_){} return BigInt(escrow.entryWei()||'0'); }
// ========================================================================================================
let _rakeBpsCache=null;
function cacheRakeBps(){ if(!escrow.isOn())return; escrow.rakeBps().then(b=>{ if(b!=null) _rakeBpsCache=b; }).catch(()=>{}); }
function escSched(gs){ return (G&&G.start===gs)?G.sched:buildSched(gs); }
async function escOpenRound(gs){
  if(ESC_OPENED.has(gs)) return;
  const entry=await pegEntryWei(); if(entry<=0n) return;   // USD-pegged round entry ($entryUsd worth of RVLT at open), static fallback inside pegEntryWei
  ensureRoundSeed(gs);                             // lock this round's seed at open so its later commit hash matches
  const s=escSched(gs); ESC_OPENED.add(gs);       // optimistic add so concurrent ticks don't double-open
  const ok=await escrow.openRound(gs, entry, Math.floor(s.chooseStart[0]/1000), Math.floor((s.gameEnd+3600000)/1000)).catch(()=>null);
  if(!ok){
    // RESTART-RESILIENCE (2026-10-09): a mid-round restart/deploy wipes the in-memory ESC_OPENED set, so this
    // re-open reverts "exists" for a round already open on-chain. Do NOT drop it in that case, or the round
    // orphans (stuck Open, never committed, never settled) until its deadline. Re-read on-chain: if it's already
    // Open (or further), KEEP it tracked so commit/settle still fire; mirror a prior Committed state too.
    const r=await escrow.readRound(gs).catch(()=>null);
    if(r && r.status>=1){ if(r.status>=2) ESC_COMMITTED.add(gs); }   // already live on-chain -> keep ESC_OPENED
    else ESC_OPENED.delete(gs);                                       // genuinely not open -> allow a clean retry
  }
}
async function escCommitRound(gs){
  if(ESC_COMMITTED.has(gs) || !ESC_OPENED.has(gs)) return;
  // commit the hash of the DURABLE seed (same seed the engine plays + reveals), so commit==reveal always holds.
  const s=ensureRoundSeed(gs); ESC_SEED[gs]=s.seed; ESC_COMMITTED.add(gs);
  const ok=await escrow.commit(gs, s.hash).catch(()=>null);
  if(!ok){ ESC_COMMITTED.delete(gs); /* keep the persisted seed: committing is retried next tick */ }
}
async function escSettleGame(){
  const gs=G.start;
  // seed comes from the durable store (ESC_SEED mirror OR disk), so a restart mid-round can still settle.
  const seed = ESC_SEED[gs] || getSeed(gs);
  if(!G.done || ESC_SETTLED.has(gs) || !ESC_COMMITTED.has(gs) || !seed) return;
  ESC_SETTLED.add(gs);
  const owners=(G.champ&&G.champ.owners)||[];
  const addrs=[...new Set(owners.map(escrow.addrOfToken).filter(Boolean))];
  const real=[]; for(const a of addrs){ if(await escrow.isParticipant(gs,a)) real.push(a); }
  if(real.length) persistChamp(gs, real);   // #222: durable roster BEFORE settle so a restart mid-settle still pays the winner
  const ok = real.length ? await escrow.settleEqualSplit(gs, seed, real).catch(()=>null)
                         : await escrow.voidRound(gs).catch(()=>null);   // no real winner -> refund the pot
  if(!ok){ ESC_SETTLED.delete(gs); return; }
  // Holder discount is applied ON-CHAIN at buy time (entryPriceFor); no off-chain rebate accrual at settle.
}
let _clockLifecycleBusy=false;
// AUDIT fix (HIGH-1): serialize the clock lifecycle like rmEscrowLifecycle. tick() calls this fire-and-forget
// every ~1s; now that round-open awaits the USD price fetch (up to ~12s), without this guard many concurrent
// passes could stack and fire duplicate open/settle RPC calls.
async function escrowLifecycle(){ if(_clockLifecycleBusy) return; _clockLifecycleBusy=true; try{ return await _escrowLifecycleInner(); } finally{ _clockLifecycleBusy=false; } }
async function _escrowLifecycleInner(){
  try{
    if(!G || C.engine!=='clock' || !G.sched) return;
    const now=Date.now(), cur=G.start, next=cur+C.interval;
    const entry=await pegEntryWei(); if(entry<=0n) return;   // no entry configured -> no real round (USD-pegged entry; static fallback inside pegEntryWei)
    // keep BOTH the current and next rounds open so buy-in is always available (current lobby, or pre-buy the next)
    await escOpenRound(cur);
    await escOpenRound(next);
    // commit the current round at its lock; settle/void once the game resolves
    if(now>=G.sched.chooseStart[0]) await escCommitRound(cur);
    if(G.done) await escSettleGame();
    // the round a buy-in targets: the current game while it's still in its lobby, otherwise the next game
    G._buyRound = (now < G.sched.chooseStart[0]) ? cur : next;
    // throttled reads (~3s): the live pot (current game), the pot you'd buy into, and seating for the current lobby
    if(!G._escSyncAt || now-G._escSyncAt>3000){
      G._escSyncAt=now; const rid=cur, bgs=G._buyRound, inLobby=(now < G.sched.chooseStart[0]);
      cacheRakeBps();
      escrow.potRvlt(cur).then(p=>{ if(G&&G.start===rid) G._onchainPot=p; }).catch(()=>{});
      escrow.potRvlt(bgs).then(p=>{ if(G&&G.start===rid) G._buyPot=p; }).catch(()=>{});
      // seat wallets ONLY during the lobby (before lock) so nobody is injected into a running, locked game
      if(inLobby) Object.keys(REG).forEach(tok=>{ if(REG[tok].active && tok.startsWith('w:')){ const a=escrow.addrOfToken(tok); if(!a)return;
        escrow.ticketsOf(rid,a).then(n=>{ if(G&&G.start===rid && n>0) seatWalletCount(tok,n); }).catch(()=>{}); } });
    }
    // prune bookkeeping for long-finished rounds so the sets don't grow forever
    const floor=cur-3*C.interval; [ESC_OPENED,ESC_COMMITTED,ESC_SETTLED].forEach(S=>{ S.forEach(v=>{ if(v<floor)S.delete(v); }); }); Object.keys(ESC_SEED).forEach(k=>{ if(Number(k)<floor)delete ESC_SEED[k]; });
    // durable seed store: a settled round's seed lives on inside its persisted proof, so once settled + past the
    // floor we drop it from seeds.json to keep that file bounded (the proof remains the permanent record).
    let dirty=false; Object.keys(SEED_STORE).forEach(k=>{ const n=Number(k); if(Number.isFinite(n) && n<floor && PROOF_STORE[k]){ delete SEED_STORE[k]; dirty=true; } }); if(dirty) saveSeeds();
  }catch(_){ /* escrow must never break the game */ }
}
// ---- THRESHOLD-FILL on-chain lifecycle (Phase A) ----------------------------------------------------------
// The rmfill analogue of escrowLifecycle. Reuses the same ESC_OPENED/ESC_COMMITTED/ESC_SETTLED/ESC_SEED sets
// (keyed by integer round id, which never collides with the clock engine's big-timestamp keys) and the same
// fire-and-forget + restart-resilience discipline. Differences from the clock path:
//   * openRound uses a FAR-FUTURE SENTINEL lockTime so buy-in stays open through the whole fill.
//   * buy-in is closed by an explicit on-chain lockRound(id) when the engine enters 'locking', NOT by the clock.
//   * commit fires only AFTER lockRound confirms (block.timestamp >= lockTime), then the engine starts play.
//   * the next round is pre-opened so there is zero dead time.
const RM_LOCKED=new Set();   // round ids we've already called lockRound on (idempotent guard)
async function rmEscOpenRound(id){
  if(ESC_OPENED.has(id)) return;
  const entry=await pegEntryWei(); if(entry<=0n) return;   // USD-pegged round entry ($entryUsd worth of RVLT at open), static fallback inside pegEntryWei
  ensureRoundSeed(id);                                    // lock the seed at open so the later commit hash matches
  const nowS=Math.floor(Date.now()/1000);
  const lockTs=nowS+(C.sentinelSec||86400);               // far-future sentinel: buy-in stays open until lockRound()
  const deadlineTs=lockTs+(C.playMarginSec||3600);        // void backstop comfortably after the sentinel
  RM_SENTINEL[id]=lockTs; ESC_OPENED.add(id);             // optimistic add so concurrent ticks don't double-open
  const ok=await escrow.openRound(id, entry, lockTs, deadlineTs).catch(()=>null);
  if(!ok){
    // RESTART-RESILIENCE: a redeploy wiped ESC_OPENED; the re-open reverts "exists" for an already-open round.
    // Re-read on-chain and keep it tracked (and mirror a later status) rather than orphaning it.
    const r=await escrow.readRound(id).catch(()=>null);
    if(r && r.status>=1){ RM_SENTINEL[id]=r.lockTime; if(r.status>=2){ ESC_COMMITTED.add(id); RM_LOCKED.add(id); } }
    else ESC_OPENED.delete(id);
  }
}
async function rmEscLockRound(id){
  if(RM_LOCKED.has(id) || !ESC_OPENED.has(id)) return;
  RM_LOCKED.add(id);                                      // optimistic
  const ok=await escrow.lockRound(id).catch(()=>null);
  if(!ok){
    // if it reverted because it's already locked/committed on-chain (restart), keep RM_LOCKED; else allow retry.
    const r=await escrow.readRound(id).catch(()=>null);
    const nowS=Math.floor(Date.now()/1000);
    if(!(r && r.status>=1 && r.lockTime<=nowS)) RM_LOCKED.delete(id);
  }
}
async function rmEscCommitRound(id){
  if(ESC_COMMITTED.has(id) || !ESC_OPENED.has(id) || !RM_LOCKED.has(id)) return;
  // only commit once lockTime has actually passed on-chain (lockRound mined), else the contract reverts "not locked".
  const r=await escrow.readRound(id).catch(()=>null);
  const nowS=Math.floor(Date.now()/1000);
  if(!r || r.status!==1 || r.lockTime>nowS) return;       // not Open-and-locked yet; retry next tick
  const s=ensureRoundSeed(id); ESC_SEED[id]=s.seed; ESC_COMMITTED.add(id);
  const ok=await escrow.commit(id, s.hash).catch(()=>null);
  if(!ok){ ESC_COMMITTED.delete(id); }                    // keep the persisted seed; retried next tick
}
async function rmEscSettleGame(id){
  const seed = ESC_SEED[id] || getSeed(id);
  if(!G || !G.done || ESC_SETTLED.has(id) || !ESC_COMMITTED.has(id) || !seed) return;
  ESC_SETTLED.add(id);
  // V5 ROLLOVER: a FINAL-VAULT mutual-bust (the whole surviving crowd converged on one door) has NO winner -> roll
  // the whole pot into the progressive jackpot (no refund; it seeds the next game). The engine sets G.rollover.
  if(G.rollover){
    const ok=await escrow.rolloverRound(id, seed).catch(()=>null);
    if(!ok){ ESC_SETTLED.delete(id); return; }
    recordWinStreak([]);   // nobody won: every participant's streak resets, no freeze
    return;
  }
  const owners=(G.champ&&G.champ.owners)||[];
  const addrs=[...new Set(owners.map(escrow.addrOfToken).filter(Boolean))];
  const real=[]; for(const a of addrs){ if(await escrow.isParticipant(id,a)) real.push(a); }
  if(real.length) persistChamp(id, real);   // #222: durable roster BEFORE settle so a restart mid-settle still pays the winner
  if(real.length){
    const ok=await escrow.settleEqualSplit(id, seed, real).catch(()=>null);
    if(!ok){ ESC_SETTLED.delete(id); return; }
    recordWinStreak(real);        // anti-whale: bump winners' streak, reset everyone else, freeze at the threshold
    await schedulePayout(id, real);  // AUTO-SEND: push winnings to the winner after the on-chain challenge window (no "collect" click)
    JACKPOT_RVLT=0;               // AUDIT L-4: settle just consumed the jackpot on-chain; zero the cache now so the win ceremony pot isn't briefly double-counted (resyncs on next tick)
  } else {
    const ok=await escrow.voidRound(id).catch(()=>null);   // no real winner -> refund the pot
    if(!ok){ ESC_SETTLED.delete(id); return; }
  }
  // Holder discount is applied ON-CHAIN at buy time (entryPriceFor); no off-chain rebate accrual at settle.
}
let _lifecycleBusy=false;
// Busy-guard (LOW fix): tick() calls this ~every 1s WITHOUT awaiting, so two passes could overlap and race the
// rush-overflow (preopenDepth>2) multi-round open/lock/commit loop. Serialize so only one pass runs at a time.
async function rmEscrowLifecycle(){ if(_lifecycleBusy) return; _lifecycleBusy=true; try{ return await _rmEscrowLifecycleInner(); } finally{ _lifecycleBusy=false; } }
async function _rmEscrowLifecycleInner(){
  try{
    if(!G || C.engine!=='rmfill') return;
    const entry=await pegEntryWei(); if(entry<=0n) return;   // USD-pegged round entry ($entryUsd worth of RVLT at open), static fallback inside pegEntryWei
    const now=Date.now(), cur=G.rmId;
    // ROLLING PRE-OPEN: keep the current round AND the next id open so buy-in is always available. RM_CUR is the
    // id whose game G currently runs; the pre-open id is RM_CUR+1. Both are opened with the sentinel lockTime.
    const _depth=Math.max(2, Math.min(12, (getCfg().preopenDepth)||2));
    if(_depth<=2){
      // CLASSIC (default): current round + ONE pre-open. Unchanged historical behavior.
      const nextId=cur+1;
      await rmEscOpenRound(cur);
      await rmEscOpenRound(nextId);
      rmReserve(nextId+1);                                 // the pre-open consumes nextId; never let the counter reuse it
      RM_BUY=cur;                                          // buy-ins target the current round while it fills...
      if(G.phase!=='filling') RM_BUY=nextId;              // ...once it locks/plays, pre-buy the next
      RM_OPEN=[cur, nextId];
    } else {
      // RUSH OVERFLOW (preopenDepth>2): keep `_depth` rounds WITH ROOM open in parallel, up to maxOpenRounds. Buyers
      // cascade to the first open round with room; the ON-CHAIN buyIn landing order is the seat order (deposit-ordered,
      // not purchase-time). More games open under load so a surge fills many games until roundTarget is the only limit.
      const target=C.target||50, maxOpen=Math.max(_depth, Math.min(80, (getCfg().maxOpenRounds)||20));
      const entryRvlt=Number(formatUnits(entry,18))||1;
      await rmEscOpenRound(cur);
      // current round seats: in-memory while filling; treat as full once it leaves 'filling' (locking/playing)
      RM_SOLD[cur]=(G.phase==='filling')?(G.ticketsSold||0):target;
      const open=[cur]; let id=cur+1; let roomCount=(RM_SOLD[cur]<target)?1:0;
      while(open.length<maxOpen && roomCount<_depth){
        await rmEscOpenRound(id);
        let s=0; try{ const ri=await escrow.roundInfo(id); s=ri?Math.max(0,Math.round((ri.pot||0)/entryRvlt)):0; }catch(e){ s=0; }
        RM_SOLD[id]=s; open.push(id); if(s<target) roomCount++; id++;
      }
      rmReserve(id);                                       // reserve the next untouched id so the counter never reuses it
      RM_OPEN=open;
      // prune stale sold entries for rounds no longer in the window
      for(const k of Object.keys(RM_SOLD)){ if(!open.includes(Number(k))) delete RM_SOLD[k]; }
      // RM_BUY = earliest open round with room (fill current first, then overflow to the next, then the next...)
      const firstOpen=open.find(rid=> (RM_SOLD[rid]||0) < target);
      RM_BUY = (firstOpen!=null) ? firstOpen : id;
    }
    // close buy-in on-chain when the engine decides to lock, then commit once the lock is mined
    if(G.phase==='locking'){
      await rmEscLockRound(cur);
      await rmEscCommitRound(cur);
      if(ESC_COMMITTED.has(cur)){
        G.committed=true;
        // ZERO DEAD TIME: the instant this round locks, advance the monotonic counter so the next round (already
        // open on-chain above) becomes current when G ends. Allocate it once.
        if(RM_CUR===cur){ RM_CUR=rmAllocId(); /* == nextId; persisted */ }
      }
    }
    if(G.done) await rmEscSettleGame(cur);
    // throttled reads (~3s): sync ticketsSold + pots + seat the current fillers from their on-chain buy-ins.
    if(!G._escSyncAt || now-G._escSyncAt>3000){
      G._escSyncAt=now; const rid=cur, bgs=RM_BUY, filling=(G.phase==='filling');
      cacheRakeBps();
      escrow.potRvlt(cur).then(p=>{ if(G&&G.rmId===rid) G._onchainPot=p; }).catch(()=>{});
      escrow.potRvlt(bgs).then(p=>{ if(G&&G.rmId===rid) G._buyPot=p; }).catch(()=>{});
      escrow.jackpotRvlt().then(j=>{ if(typeof j==='number') JACKPOT_RVLT=j; }).catch(()=>{});   // V5 progressive jackpot for the UI counter
      // total tickets sold this round drives the threshold/full decision. Sum the seated-wallet ticket counts
      // we already read for seating; also seat each verified wallet by its authoritative on-chain buyIn count.
      if(filling){
        let sold=0; const toCount=[];
        Object.keys(REG).forEach(tok=>{ if(REG[tok].active && tok.startsWith('w:')){ const a=escrow.addrOfToken(tok); if(a) toCount.push([tok,a]); } });
        Promise.all(toCount.map(([tok,a])=>escrow.ticketsOf(cur,a).then(n=>({tok,n})).catch(()=>({tok,n:0}))))
          .then(rows=>{ if(!(G&&G.rmId===rid&&G.phase==='filling'))return; sold=0; rows.forEach(({tok,n})=>{ if(n>0){ seatWalletCount(tok,n); sold+=n; /* THRESHOLD ACCOUNTING: count the ACTUAL on-chain tickets, NOT the capped value. seatWalletCount() still enforces the per-wallet SEAT cap (Sybil guard) separately; the threshold/full decision must reflect the real pot of tickets bought, otherwise a wallet above the cap would under-signal the fill and stall the lock. */ } }); G.ticketsSold=sold; recordFillSample(sold); }).catch(()=>{});
      }
    }
    // prune finished rounds (ids below a small trailing window) so the sets stay bounded.
    const floor=cur-5; [ESC_OPENED,ESC_COMMITTED,ESC_SETTLED,RM_LOCKED].forEach(S=>{ S.forEach(v=>{ if(typeof v==='number'&&v<floor)S.delete(v); }); });
    Object.keys(ESC_SEED).forEach(k=>{ const n=Number(k); if(Number.isInteger(n)&&n<floor)delete ESC_SEED[k]; });
    Object.keys(RM_SENTINEL).forEach(k=>{ const n=Number(k); if(Number.isInteger(n)&&n<floor)delete RM_SENTINEL[k]; });
  }catch(_){ /* escrow must never break the game */ }
}
// ---- FEATURE 2: AUTO-PLAY (recurring prechoose, durable) -------------------------------------------------
// A player can leave an AUTOPLAY strategy that persists across rounds + restarts: each new round their chosen
// door path is re-applied as their prechoice, so an away player keeps playing. The seeded absent-default already
// exists (resolve() falls back to pre, then a seeded draw), so autoplay simply keeps `pre` populated each round.
// Keyed by the player's token. On boot we merge the durable store back into REG.
function restoreAutoplayInto(tok){
  const ap=AUTOPLAY_STORE[tok]; if(!ap||!ap.on) return;
  REG[tok]=REG[tok]||{name:'Robber '+String(tok).slice(2,6),pre:null,active:true,tickets:1};
  REG[tok].pre = Array.isArray(ap.pre)?ap.pre.slice():REG[tok].pre;
  REG[tok].autoplay = true;
}
// Re-apply every durable autoplay pre-choice into REG at a round boundary so the new round seats with it.
function applyAutoplayAtBoundary(){ Object.keys(AUTOPLAY_STORE).forEach(tok=>{ if(AUTOPLAY_STORE[tok]&&AUTOPLAY_STORE[tok].on) restoreAutoplayInto(tok); }); }
// Count actively-present (NON-auto) human players in the current lobby: real tokens whose autoplay flag is off
// and who are active. Used for the anti-all-bot-erosion minimum-present gate (config minPresentPct, default 0).
function presentHumanCount(){
  let n=0; const seen=new Set();
  Object.keys(G?G.players:{}).forEach(id=>{ const p=G.players[id]; if(p.bot||p.left||!p.owner) return; const tok=p.owner; if(seen.has(tok))return; seen.add(tok);
    const ap=AUTOPLAY_STORE[tok]; if(!(ap&&ap.on)) n++; });   // present = not driven purely by autoplay
  return n;
}
// Minimum share of actively-present (non-auto) players required before a round may LOCK, as a % of target.
// Config-gated via minPresentPct (default 0 = OFF). Returns the absolute count required (0 when off).
function minPresentRequired(){ const pct=getCfg().minPresentPct||0; if(pct<=0) return 0; return Math.max(1, Math.ceil(pct/100*(getCfg().roundTarget||50))); }

// ---- FEATURE 2: AUTO-BUY (recurring, bounded, relayer-submitted) -----------------------------------------
// SECURITY SIGN-OFF REQUIRED BEFORE MAINNET (custody surface). HIGH-1: because the on-chain AutoBuy struct is
// bound to BOTH a specific roundId AND a per-player nonce (consumed per entry), ONE signature only ever enters
// ONE round. For a MULTI-ROUND budget the player pre-signs an ORDERED ARRAY of bounded authorizations over
// consecutive (roundId, nonce) pairs and approves the escrow for a BOUNDED allowance (never unlimited). Each new
// buy-open round this tick submits the one authorization whose nonce == the current on-chain autoBuyNonce AND
// whose bound roundId == the live buy-round, via a DEDICATED relayer key (VS_RELAY_PK; testnet falls back to
// DEPLOYER_PRIVATE_KEY with a warning; NEVER the settlement signer), retiring it as spent (and ZEROING its sig at
// rest, MED-5). Bounds enforced ON-CHAIN in buyInFor: roundId + nTickets<=maxTickets, entry<=maxEntry,
// now<=deadline, nonce==autoBuyNonce (replay-safe), ECDSA recover == player. When all pre-signed rounds are spent
// the player re-authorizes. The whole budget is capped off-chain by roundsLeft (== count of unspent auths).
let _autobuyBusy=false;
async function autoBuyTick(){
  try{
    if(_autobuyBusy) return;                               // never overlap async passes (reentrancy guard)
    if(!escrow.relayUsable()) return;                      // no relayer key -> feature inert
    const buyRound = (C.engine==='rmfill') ? RM_BUY : (G&&G._buyRound);
    if(buyRound==null) return;
    const rid=String(buyRound);
    // only act while buy-in is actually open for that round
    const buyOpen = (C.engine==='rmfill') ? (G&&G.phase==='filling') : realMoney();
    if(!buyOpen) return;
    // Idempotency is PER-(authorization, round) via a.spent[] (set on a confirmed buyInFor below), NOT a blanket
    // per-round throttle. A blanket "already processed this round" guard was removed: it silently dropped any
    // authorization stored AFTER the first tick pass for the current buy-round (e.g. a player who just POSTed
    // /api/autobuy mid-fill), so their entry never landed until the next round. The spent[] filter here already
    // prevents a double-submit for a round an auth was spent on.
    // V6 RANGE records (a.range) are submittable when the live buy-round falls inside the signed range and we have not
    // yet relayed it; legacy array records use the ordered-auth path. Both still gated by deadline + not-in-flight.
    const _rangeOK=(a)=>{ const r=a&&a.range; if(!r||!r.sig) return false; const n=Number(rid); return n>=Number(r.roundStart) && n<Number(r.roundStart)+Number(r.roundCount) && (a.rangeSpent||[]).indexOf(rid)<0 && (a.roundsLeft==null||a.roundsLeft>0); };
    const actives=Object.keys(AUTOBUY_STORE).filter(k=>{ const a=AUTOBUY_STORE[k]; if(!a||a._inflight||!(Date.now()<=a.deadline*1000)) return false; return a.range ? _rangeOK(a) : (a.roundsLeft>0 && a.spent.indexOf(rid)<0 && _nextUnspentAuth(a)); });
    if(!actives.length) return;
    _autobuyBusy=true;
    for(const key of actives){
      const a=AUTOBUY_STORE[key];
      // verify the player's on-chain nonce so we submit the authorization that matches the CURRENT on-chain nonce.
      const onchainNonce=await escrow.autoBuyNonce(a.player).catch(()=>null);
      if(onchainNonce==null) { a.lastError=Date.now(); saveAutobuy(); continue; }   // RPC blip: retry next tick, don't retire
      const onN=Number(onchainNonce);
      // ---- V6 RANGE path: ONE signature covers this whole range; relay buyInForRange for the live round. The range
      // nonce is NOT consumed on-chain (shared across the range), so onchainNonce stays == r.nonce until the player
      // invalidates (invalidateAutoBuy bumps it) -> we then retire the record. Per-round replay guarded by rangeSpent
      // (ours mirrors the contract's) + the _inflight lock. ----
      if(a.range){
        const r=a.range;
        // NONCE BUMPED (e.g. invalidateAutoBuy): the stored range sig is signed over r.nonce; once the on-chain
        // autoBuyNonce has moved past it, buyInForRange can NEVER succeed. RETIRE the record terminally (zero the
        // sig at rest, blank the range so _rangeOK excludes it forever) instead of re-fetching the nonce each tick.
        if(Number(r.nonce)!==onN){ a.retiredReason='authorization invalidated (on-chain nonce bumped past '+r.nonce+'; re-authorize to continue)'; a.roundsLeft=0; if(r.sig) r.sig=null; a.range=null; saveAutobuy(); continue; }
        a._inflight=true;
        try{
          const n=Math.max(1, Math.min(a.perRound||1, a.maxTickets));
          const hash=await escrow.buyInForRange(buyRound, a.player, n, r.roundStart, r.roundCount, a.maxTickets, a.maxEntry, r.nonce, a.deadline, r.sig).catch(()=>null);
          if(hash){
            a.rangeSpent=a.rangeSpent||[]; if(a.rangeSpent.indexOf(rid)<0) a.rangeSpent.push(rid);
            a.roundsLeft=Math.max(0, Number(r.roundCount)-a.rangeSpent.length);
            a.lastRoundId=rid; a.lastTx=hash;
            a.retiredReason = a.roundsLeft<=0 ? 'budget exhausted (re-authorize to continue)' : null;
            saveAutobuy();
            console.log('[vaultstandoff-dev] auto-buy RANGE relayed round='+rid+' player='+a.player+' tickets='+n+' tx='+hash);
          } else { a.lastError=Date.now(); saveAutobuy(); }
        } finally { a._inflight=false; }
        continue;
      }
      // Pick the earliest UNSPENT authorization. It is submittable now ONLY if its nonce == the current on-chain
      // nonce AND its bound roundId == the live buy-round (the AutoBuy struct is signed over BOTH, so buyInFor
      // would revert otherwise). Future-nonce / future-roundId auths wait their turn, consumed in order.
      const au=_nextUnspentAuth(a);
      if(!au){ continue; }                                                           // nothing left to spend
      // RECONCILE: retire any auth whose nonce is already < the on-chain nonce (its nonce can never be used again
      // — a prior buyInFor landed, possibly our own landed-late, or a manual/external entry). If our own entry for
      // THIS round's tickets is present, record a clean spend of this round; otherwise just retire the dead nonce.
      if(au.nonce<onN){
        let reconciled=false;
        for(const x of a.auths){ if(!x.spent && x.nonce<onN){
            x.spent=true; x.spentRound=(x.spentRound||rid); if(x.sig) x.sig=null;    // MED-5: zero the consumed sig at rest
            a.roundsLeft=Math.max(0,a.roundsLeft-1);
            const landed=(String(x.roundId)===rid)?await escrow.ticketsOf(buyRound, a.player).catch(()=>0):0;
            if(landed>0 && a.spent.indexOf(rid)<0){ a.spent.push(rid); if(a.spent.length>2000) a.spent=a.spent.slice(-2000); a.lastRoundId=rid; reconciled=true; }
        } }
        a.retiredReason = a.roundsLeft<=0 ? 'budget exhausted (re-authorize to continue)' : null;
        saveAutobuy();
        if(reconciled) console.log('[vaultstandoff-dev] auto-buy reconciled landed-late round='+rid+' player='+a.player);
        continue;
      }
      // not yet this auth's turn: either the on-chain nonce hasn't reached it, or its bound round isn't live yet.
      if(au.nonce!==onN || String(au.roundId)!==rid) continue;
      const n=Math.max(1, Math.min(a.perRound||1, a.maxTickets));
      // mark in-flight so a concurrent pass can't re-evaluate this auth while its buyInFor is mining (the real
      // source of the drift race). Cleared in all paths below.
      a._inflight=true;
      // KH-5: the in-flight lock MUST clear in all paths. buyInFor() already swallows its own errors (.catch ->
      // null), but a throw anywhere between setting and clearing _inflight (e.g. an OOM, or future code) would
      // strand this authorization permanently (every later tick skips _inflight entries). The try/finally
      // guarantees _inflight is reset even on an unexpected throw, so the auth can be retried next round.
      try {
        // Submit into the auth's BOUND roundId (== the live buy-round here), with the signed nonce + bounds.
        const hash=await escrow.buyInFor(au.roundId, { player:a.player, maxTickets:a.maxTickets, maxEntry:a.maxEntry, deadline:a.deadline, nonce:au.nonce, sig:au.sig }, n).catch(()=>null);
        if(hash){
          au.spent=true; au.spentRound=rid; au.tx=hash; au.sig=null;                   // MED-5: zero the spent sig so a disk leak can't replay it
          a.roundsLeft=Math.max(0,a.roundsLeft-1);
          if(a.spent.indexOf(rid)<0){ a.spent.push(rid); if(a.spent.length>2000) a.spent=a.spent.slice(-2000); }
          a.lastRoundId=rid; a.lastTx=hash;
          a.retiredReason = a.roundsLeft<=0 ? 'budget exhausted (re-authorize to continue)' : null;
          saveAutobuy();
          console.log('[vaultstandoff-dev] auto-buy relayed round='+rid+' player='+a.player+' tickets='+n+' nonce='+au.nonce+' tx='+hash);
        } else {
          // a single failure (gas, allowance revoked, cap hit) doesn't retire the auth; it retries next round.
          a.lastError=Date.now(); saveAutobuy();
        }
      } finally {
        a._inflight=false;
      }
    }
  }catch(_){ /* auto-buy must never break the loop */ }
  finally{ _autobuyBusy=false; }
}
// The earliest unspent authorization (lowest nonce) for a stored record, or null if all are spent. The ordered
// `auths[]` is consumed front-to-back; a consumed entry has spent:true and its sig zeroed (MED-5).
function _nextUnspentAuth(a){ if(!a||!Array.isArray(a.auths)) return null; for(const x of a.auths){ if(!x.spent && x.sig) return x; } return null; }

// ---- FEATURE 3: SETTLE-WATCHER (ops reliability) ---------------------------------------------------------
// An always-on backstop that GUARANTEES every round reaches a terminal state (Settled or Voided). The normal
// lifecycle (escrowLifecycle / rmEscrowLifecycle) settles a round as its game ends; but a crash, RPC outage, or
// a lost off-chain roster can leave an Open/Committed round stranded past its play window. This watcher scans a
// trailing window of round ids on a slow interval and, for any round that is Open/Committed and past the point
// where it should have resolved:
//   * if a champion is known (from the persisted proof) and its winners are on-chain participants -> settle;
//   * else -> void (opens refunds). Settling vs voiding uses the SAME contract paths as the normal lifecycle,
//     so no new trust is introduced (settlement-signer-only, winners-are-participants, sum == pot-rake).
// It also runs a BOUNDED CATCH-UP SWEEP on boot for orphaned rounds. Health (last tick, pending rounds, signer
// gas) is surfaced in /api/admin/metrics. Status codes: 1=Open 2=Committed 3=Settled 4=Voided.
const WATCH = { lastTickTs:0, lastActionTs:0, pending:[], actions:[], bootSweepDone:false, errors:0 };
function _watchLog(action, id, detail){
  WATCH.actions.unshift({ ts:Date.now(), action, id:String(id), detail:detail||null });
  while(WATCH.actions.length>50) WATCH.actions.pop();
  WATCH.lastActionTs=Date.now();
  console.log('[vaultstandoff-dev] settle-watcher '+action+' round='+id+(detail?(' '+detail):''));
}
// Build the candidate id window to scan. Clock ids are big aligned timestamps; rmfill ids are small integers.
// We scan the active engine's recent ids plus any round ids that appear in our in-memory escrow sets.
function _watchCandidateIds(){
  const ids=new Set();
  // in-memory tracked rounds (both engines share these sets, keyed by their own id space)
  ESC_OPENED.forEach(v=>ids.add(v)); ESC_COMMITTED.forEach(v=>ids.add(v));
  if(C.engine==='rmfill'){ const top=RM_NEXT_ID; for(let i=Math.max(1,top-24);i<=top;i++) ids.add(i); }   // widened 8->24: survive a longer restart/outage without stranding rounds outside the scan
  else if(C.engine==='clock'){ const gs=alignStart(Date.now()); for(let k=0;k<6;k++) ids.add(gs-k*C.interval); }
  return [...ids];
}
// Decide whether a round is "past its play window" and therefore eligible for a terminal action. For a Committed
// round we require that the on-chain lockTime + a generous play+challenge margin has elapsed (so we never settle
// a round that is legitimately still playing). For an Open round we require its on-chain deadline has passed
// (buy-in never locked / round abandoned) before voiding.
// M-3: the margin must also cover SUDDEN-DEATH OVERTIME. suddenDeath() can run up to 64 OT rounds (the hard loop
// bound in the engine) to collapse the field to one champion. The settle-watcher must never void/resolve a round
// that is still legitimately in OT, or the off-chain champion and the on-chain settle diverge (split-brain). We
// add a CONSERVATIVE over-estimate: 64 * the per-round wall-clock budget (chooseSec+revealSec). OT draws are in
// fact computed server-side in a single synchronous pass (near-zero wall time), so bounding each OT round by a
// full normal-chamber window is a deliberate, safe over-estimate.
const _MAX_OT_ROUNDS = 64;   // mirrors the `round<64` hard cap in suddenDeath()
function _watchPlayMarginSec(){
  const cfg=getCfg();
  const perRoundSec=(cfg.chooseSec||19)+(cfg.revealSec||6);
  const playSec=(cfg.maxChambers||6)*perRoundSec;                // generous upper bound on scheduled play time
  const otSec=_MAX_OT_ROUNDS*perRoundSec;                        // conservative bound on sudden-death overtime
  return playSec + otSec + 300;   // + 5 min slack so a live (or still-in-OT) round is never prematurely settled
}
// Attempt a terminal action for one stranded round. Returns 'settled' | 'voided' | 'pending' | 'none'.
async function _watchResolveRound(id){
  const r = await escrow.readRound(id).catch(()=>null);
  if(!r) return 'none';
  if(r.status>=3) return 'done';                      // already Settled(3) or Voided(4)
  const nowS=Math.floor(Date.now()/1000);
  if(r.status===1){
    // Open. If the on-chain deadline has passed, the round was abandoned (never locked/committed) -> void to
    // open refunds. (The normal lifecycle locks/commits live rounds; a stranded Open one past deadline is dead.)
    if(nowS >= r.deadline){
      const ok=await escrow.voidRound(id).catch(()=>null);
      if(ok){ ESC_SETTLED.add(id); _watchLog('void-open-expired', id, 'deadline passed, never committed'); return 'voided'; }
      return 'pending';
    }
    return 'pending';   // still within buy-in/lock window on-chain; not stranded yet
  }
  if(r.status===2){
    // Committed. If it's past lockTime + the play margin and still not settled, it's stranded. Try to settle
    // from the persisted proof's champion; if we can't, void so refunds open.
    if(nowS < r.lockTime + _watchPlayMarginSec()) return 'pending';   // legitimately still playing
    const seed = ESC_SEED[id] || getSeed(id);
    if(ESC_SETTLED.has(id)) return 'pending';
    const proof = PROOF_STORE[String(id)];
    let settled=false;
    if(seed && proof && proof.winner && !proof.winner.none){
      // Reconstruct winner addresses from the persisted proof is not possible (proof stores token HASHES, not
      // addresses, by design). The authoritative champion addresses live only in G.champ.owners for the LIVE
      // round. So the watcher can reliably settle ONLY the still-in-memory current round; any older stranded
      // Committed round whose roster is lost is VOIDED for a full refund (the documented safety net).
      const liveId = (C.engine==='rmfill') ? (G&&G.rmId) : (G&&G.start);
      // #222: winner addresses from the LIVE in-memory champion, else the durable roster recovered across a restart
      // (the public proof holds token HASHES only). Re-validated on-chain (isParticipant) before any settle.
      let candAddrs=null, recovered=false;
      if(String(liveId)===String(id) && G.champ && G.champ.owners && G.champ.owners.length){
        candAddrs=[...new Set(G.champ.owners.map(escrow.addrOfToken).filter(Boolean))];
      } else if(CHAMP_STORE[String(id)] && Array.isArray(CHAMP_STORE[String(id)].addrs) && CHAMP_STORE[String(id)].addrs.length){
        candAddrs=[...new Set(CHAMP_STORE[String(id)].addrs.filter(Boolean))]; recovered=true;
      }
      if(candAddrs && candAddrs.length){
        const real=[]; for(const a of candAddrs){ if(await escrow.isParticipant(id,a)) real.push(a); }
        if(real.length){
          const ok=await escrow.settleEqualSplit(id, seed, real).catch(()=>null);
          // Holder discount is applied ON-CHAIN at buy time (entryPriceFor); no off-chain rebate accrual here.
          if(ok){ ESC_SETTLED.add(id); _watchLog('settle', id, 'champ='+real.length+(recovered?' (roster recovered post-restart)':'')); settled=true; return 'settled'; }
        }
      }
    }
    if(!settled){
      const ok=await escrow.voidRound(id).catch(()=>null);
      if(ok){ ESC_SETTLED.add(id); _watchLog('void-stranded', id, 'no reconstructable champion -> refund'); return 'voided'; }
    }
    return 'pending';
  }
  return 'none';
}
let _watchBusy=false;
async function settleWatcher(){
  if(_watchBusy) return; _watchBusy=true;
  try{
    WATCH.lastTickTs=Date.now();
    if(!escrow.isOn()){ WATCH.pending=[]; return; }
    const ids=_watchCandidateIds();
    const pending=[];
    for(const id of ids){
      const r=await _watchResolveRound(id).catch(()=>{ WATCH.errors++; return 'none'; });
      if(r==='pending') pending.push(String(id));
    }
    WATCH.pending=pending;
  }catch(_){ WATCH.errors++; }
  finally{ _watchBusy=false; }
}
// Bounded catch-up sweep on boot: reads the recent id window from chain and resolves any orphan left by a prior
// crash BEFORE the normal loop takes over. Builds on the restart-resilience already in the lifecycle.
async function bootCatchupSweep(){
  try{
    if(!escrow.isOn()){ WATCH.bootSweepDone=true; return; }
    await settleWatcher();
    WATCH.bootSweepDone=true;
    console.log('[vaultstandoff-dev] settle-watcher boot catch-up sweep complete; pending='+WATCH.pending.length);
  }catch(_){ WATCH.bootSweepDone=true; }
}

function tick(){
  if(MODE==='fill') fillTick();
  else if(MODE && C.engine==='rmfill') rmfillTick();
  else clockTick();
  if(G&&G.done&&!G.recorded) recordHistory();
  if(escrow.isOn()){ if(C.engine==='rmfill') rmEscrowLifecycle(); else escrowLifecycle(); }
  // FEATURE 2: recurring auto-buy — relay bounded, player-signed authorizations into each new buy-open round.
  if(escrow.isOn()) autoBuyTick();
  // V5 AUTO-SEND: push settled winnings to winners once the challenge window elapses (self-throttled + busy-guarded).
  if(escrow.isOn()) payoutKeeper();
}
setInterval(tick,1000); tick();
// FEATURE 3: settle-watcher runs on a slow independent interval (every 30s) so it never piggybacks the hot 1s
// loop, plus a one-shot bounded catch-up sweep on boot for orphaned rounds.
const WATCH_INTERVAL_MS = Math.max(10000, parseInt(process.env.VS_WATCH_INTERVAL_MS||'30000',10)||30000);
setInterval(()=>{ settleWatcher(); }, WATCH_INTERVAL_MS);
setTimeout(bootCatchupSweep, 2500);   // let the first tick open/sync rounds before the sweep reads them

// ambient bot chatter
const BOT_LINES=['everyone go left, trust me 😏','skylight is a trap','I only take the quiet door','who’s banking at the last door?','got busted last time lol','follow me or lose','service shaft crew where you at','too many of you in east vault','🔥🔥','holding to the very end','new robbers get eaten first','watch the herd, not the door','north wing is cursed today','don’t overthink it','last one in takes it all','psh, amateurs','I never split. ever.','split with me and we both live','just bought in','fuse is lit, let’s go'];
let chatBeat=0;
setInterval(()=>{ if(!G)return; chatBeat++; if(chatBeat%2 && Math.random()<0.7){ const bots=Object.values(G.players).filter(p=>p.bot&&!p.left); if(!bots.length)return; const b=bots[Math.floor(Math.random()*bots.length)]; CHAT.push({name:b.name,text:BOT_LINES[Math.floor(Math.random()*BOT_LINES.length)],ts:Date.now(),th:null}); while(CHAT.length>80)CHAT.shift(); } },5000);

// ---- API ----
app.post('/api/join',(req,res)=>{
  if(!rl(rlKey(req,'join'),20,60000)) return res.status(429).json({error:'slow down'});
  if(!G)tick();
  let token=(req.body&&req.body.token)||('u_'+nid());
  // SESSION-FIXATION GUARD (GAP on /api/join): a `w:<addr>` wallet token is only controllable by a SIWE-verified
  // caller. If an unauthenticated caller supplies someone else's already-VERIFIED wallet token, DO NOT let them
  // rename / re-activate that seat (that would be account takeover). A caller counts as the owner of a verified
  // wallet token only if they present it in the x-vs-token header AND it is that same verified token. Anonymous
  // `u_` tokens (and brand-new/unverified `w:` tokens) keep working exactly as before.
  const existing=REG[token];
  const isVerifiedWallet=!!(existing&&existing.verified&&typeof token==='string'&&token.indexOf('w:')===0);
  if(isVerifiedWallet && reqToken(req)!==token){
    // Not the authenticated owner of this verified wallet: ignore the name/activation/tickets change and refuse
    // to hand back control. Spin them a fresh anonymous seat instead so legit play still works.
    token='u_'+nid();
  }
  const nm=(req.body&&req.body.name)?String(req.body.name).slice(0,14):((REG[token]&&REG[token].name)||('Robber '+token.slice(2,6)));
  REG[token]=REG[token]||{name:nm,pre:null,active:true,tickets:1}; REG[token].name=nm; REG[token].active=true;
  if(req.body&&req.body.tickets!=null) REG[token].tickets=clampTickets(req.body.tickets);
  let joinable;
  if(MODE==='fill'){ joinable = (G.phase==='filling'||G.phase==='armed') && seatCount()<C.cap; }
  else if(C.engine==='rmfill'){ joinable = (G.phase==='filling'); }   // real-money: registers only; the on-chain buy-in seats
  else { joinable = clockPhaseAt(Date.now()).phase==='lobby'; }
  // real-money: joining registers you but NEVER grants a free seat. Wallets are seated only by their on-chain
  // buy-in (escrowLifecycle lobby-sync); guests spectate until they buy in. Off-chain preview keeps free seating.
  if(joinable && !realMoney()) seatToken(token);   // seat/adjust this account's tickets in the current lobby
  else if(!joinable && !realMoney()){ Object.keys(G.players).forEach(id=>{ if(G.players[id].owner===token) G.players[id].left=false; }); } // running/ended: tickets pack the NEXT heist
  res.json({token,name:nm,tickets:clampTickets(REG[token].tickets)});
});
// JOIN-MY-HEIST REFERRAL (capture only; NO payout logic). A shareable deep-link carries ?ref=<referrer>. The
// client captures it to localStorage and reports it here once, so a future credit scheme has the raw attribution
// data. This endpoint ONLY appends a bounded in-memory record (referrer -> count + last referee hash); it opens no
// round, moves no money, and touches no escrow path. Rate-limited; both ids are length-clamped + sanitized.
const REFERRALS={};   // { referrerKey: { count, firstTs, lastTs } } — attribution tallies only, never money
app.post('/api/ref',(req,res)=>{
  if(!rl(rlKey(req,'ref'),10,60000)) return res.status(429).json({error:'slow down'});
  const b=req.body||{};
  const ref=String(b.ref||'').trim().slice(0,64).replace(/[^a-zA-Z0-9:_\-\.]/g,'');
  if(!ref) return res.status(400).json({error:'ref required'});
  const now=Date.now(); const r=REFERRALS[ref]||(REFERRALS[ref]={count:0,firstTs:now,lastTs:now});
  r.count++; r.lastTs=now;
  // keep the map bounded (drop the oldest if it grows past a sane cap) so a spammer can't balloon memory
  const keys=Object.keys(REFERRALS); if(keys.length>5000){ keys.sort((a,b)=>REFERRALS[a].lastTs-REFERRALS[b].lastTs).slice(0,500).forEach(k=>delete REFERRALS[k]); }
  res.json({ ok:true, ref, count:r.count });
});
app.get('/api/escrow/config',(req,res)=>{ if(!rl(rlKey(req,'escfg'),60,60000)) return res.status(429).json({error:'slow down'}); res.json(escrow.config()); });   // client discovers where to buy in on-chain
// PRACTICE (FREE) config, READ-ONLY, display-only. The free training mode is a SELF-CONTAINED CLIENT-SIDE
// simulation (no money, no escrow, no on-chain anything, no server game state): it reuses the SAME rules the
// live engine uses, so the lesson transfers. This endpoint exposes ONLY the rule parameters the client sim needs
// to faithfully mirror the live game (door-count thresholds, chamber count, sudden-death door count, room labels,
// bot names, a fake display pot). It opens NO round, seats NO player, touches NO escrow path, and reads NO per-
// player state, so a practice player is structurally isolated from fill/rmfill (they never call a game
// endpoint). Everything here is non-secret and matches what /api/state already exposes via `econ`/`maxChambers`.
app.get('/api/practice/config',(req,res)=>{
  const cfg=getCfg();
  res.json({
    maxChambers: C.maxch,                  // scheduled chambers before sudden-death overtime
    otDoors: Math.max(2, cfg.otDoors||2),  // sudden-death door count (low on purpose -> converges to one)
    routeThresholds: [5,12,24],            // routesFor(): >5=>3, >12=>4, >24=>5 doors (2 doors below 6 alive)
    rooms: R,                              // door/room labels, same ordering the live UI uses
    botNames: BOTNAMES,                    // name pool for simulated opponents
    chamberFlavor: 6,                      // number of CH_FLAVOR lines the client already holds
    entryUsd: cfg.entryUsd,                // display-only entry price to quote the funnel ("Play for real")
    fakePot: (cfg.roundTarget||50) * (cfg.entryUsd||10)  // display-only fake pot seed for the practice heist
  });
});
// The two always-open buy rounds (current + next). The RACE FALLBACK uses `next` to retarget a buyIn whose
// intended round locked during a swap, so freshly-swapped RVLT rolls into the next open round instead of
// stranding. Both engines keep two rounds open on-chain; this just names their ids for the client.
app.get('/api/escrow/buy-rounds',(req,res)=>{
  if(!escrow.isOn()) return res.json({ on:false, current:null, next:null });
  let current=currentBuyRoundId(), next=null;
  if(C.engine==='rmfill'){ if(RM_BUY!=null) next=String(Number(RM_BUY)+1); }
  else if(C.engine==='clock' && G){ const cur=G._buyRound||G.start; next=String(Number(cur)+C.interval); }
  // RUSH OVERFLOW observability: when preopenDepth>2, expose the full open window + per-round seats so the client
  // (and admin) can see the parallel games filling. openWindow is [] in classic mode.
  const openWindow = (C.engine==='rmfill' && Array.isArray(RM_OPEN) && RM_OPEN.length>2)
    ? RM_OPEN.map(id=>({ id:String(id), sold:(RM_SOLD[id]||0), target:(C.target||50) })) : [];
  res.json({ on:true, current:current!=null?String(current):null, next, engine:C.engine, openWindow });
});
// PUBLIC PROOF of a settled round: the revealed seed + hashed ticket set + every logged pick + which door
// busted each chamber (and how many were caught) + the winner. Anyone can replay prng(seed, roundId, label)
// against this to independently reproduce the outcome, and check the seed's keccak256 == the on-chain commit.
app.get('/api/round/:id/proof',(req,res)=>{
  if(!rl(rlKey(req,'proof'),60,60000)) return res.status(429).json({error:'slow down'});
  const id=String(req.params.id||''); const p=PROOF_STORE[id];
  if(!p) return res.status(404).json({error:'no proof for this round yet (not settled, or unknown round)'});
  res.json(p);
});
// list the most recent settled rounds (newest first) so the client can offer a "verify a recent round" picker.
app.get('/api/rounds/recent',(req,res)=>{
  if(!rl(rlKey(req,'recent'),30,10000)) return res.status(429).json({error:'slow down'});
  const ids=Object.keys(PROOF_STORE).sort((a,b)=>(PROOF_STORE[b].ts||0)-(PROOF_STORE[a].ts||0)).slice(0,12);
  res.json(ids.map(id=>({ roundId:id, ts:PROOF_STORE[id].ts, winner:PROOF_STORE[id].winner, realMoney:!!PROOF_STORE[id].realMoney })));
});

// ---- Relay (cross-chain) entry funding. A $10 entry can be paid in SOL / ETH / stablecoins from ANY chain:
// Relay routes the origin currency and delivers EXACT ROBINVAULT onto Robinhood (its routing IS the RVLT market-buy),
// which the player then buys into the pot. Server-side proxy so the browser never calls Relay directly and the
// delivered RVLT amount is server-computed from the round's on-chain entry (the client can't understate it).
// Inert unless escrow is on. Relay is mainnet-only, so this path is exercised at/after cutover, not on testnet. ----
const RELAY_API = 'https://api.relay.link';
const RELAY_HEADERS = () => ({ 'Content-Type': 'application/json', ...(process.env.RELAY_API_KEY ? { 'x-api-key': process.env.RELAY_API_KEY } : {}) });
app.get('/api/relay/chains', async (req,res)=>{
  if(!rl(rlKey(req,'relay'),30,60000)) return res.status(429).json({error:'slow down'});
  try{ const r=await fetch(`${RELAY_API}/chains`,{headers:RELAY_HEADERS(),signal:AbortSignal.timeout(12000)}); res.status(r.status).json(await r.json()); }
  catch(e){ res.status(502).json({error:'relay chains unavailable'}); }
});
// LOCKED-DOWN quote proxy (replaces the former open passthrough that forwarded ANY body to Relay, a free
// arbitrary-swap oracle for anyone with the URL). The connector's generic relayDeliver still calls this, but
// the DESTINATION is now forced server-side: it can ONLY ever deliver the escrow's RVLT token onto the escrow
// chain. Origin currency/chain are the player's choice; destination is not negotiable. Inert unless escrow is on.
app.post('/api/relay/quote', express.json({limit:'8kb'}), async (req,res)=>{
  if(!rl(rlKey(req,'relay'),30,60000)) return res.status(429).json({error:'slow down'});
  try{
    const cfg=escrow.config();
    if(!cfg.on) return res.status(409).json({error:'escrow not enabled'});
    const b=req.body||{};
    // pin destination to RVLT on the escrow chain; ignore any client-supplied destination entirely.
    const body={
      user: String(b.user||''),
      recipient: String(b.recipient||b.user||''),
      originChainId: parseInt(b.originChainId,10),
      originCurrency: String(b.originCurrency||'0x0000000000000000000000000000000000000000'),
      destinationChainId: cfg.chainId,
      destinationCurrency: cfg.rvlt,
      amount: String(b.amount||'0'),
      tradeType: (b.tradeType==='EXACT_INPUT'?'EXACT_INPUT':'EXACT_OUTPUT')
    };
    if(!/^0x[0-9a-fA-F]{40}$/.test(body.user)) return res.status(400).json({error:'valid user address required'});
    if(!body.originChainId) return res.status(400).json({error:'originChainId required'});
    if(!/^\d+$/.test(body.amount) || body.amount==='0') return res.status(400).json({error:'amount required'});
    // M-5: originCurrency must be a 20-byte EVM address (token) OR the native sentinel. Reject anything else so
    // an unvalidated client string can't be reflected into the Relay request. Destination stays pinned above.
    if(!/^0x[0-9a-fA-F]{40}$/.test(body.originCurrency)) return res.status(400).json({error:'originCurrency must be a 0x EVM token address or the native sentinel'});
    const r=await fetch(`${RELAY_API}/quote`,{method:'POST',headers:RELAY_HEADERS(),body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    res.status(r.status).json(await r.json());
  }catch(e){ res.status(502).json({error:'relay quote unavailable'}); }
});
app.get('/api/relay/status', async (req,res)=>{
  if(!rl(rlKey(req,'relay'),60,60000)) return res.status(429).json({error:'slow down'});
  try{ const rid=String(req.query.requestId||''); if(!/^[a-zA-Z0-9_\-]{1,128}$/.test(rid)) return res.status(400).json({error:'bad requestId'}); const r=await fetch(`${RELAY_API}/intents/status?requestId=${encodeURIComponent(rid)}`,{headers:RELAY_HEADERS(),signal:AbortSignal.timeout(12000)}); res.status(r.status).json(await r.json()); }
  catch(e){ res.status(502).json({error:'relay status unavailable'}); }
});
// Build the entry Relay quote: pay `fromCurrency` on `fromChainId` -> RVLT (entry x tickets, + configurable
// headroom) to the player on Robinhood. The player then buys into the round with the exact entry; dust stays
// with them. Headroom is VS_RELAY_HEADROOM_BPS (default 150 bps = 1.5%, wider than the old fixed 0.5% so a
// volatile route still lands the full entry); clamped to [50, 1000] bps. The response surfaces the required
// entry vs what will be delivered so the client can show the buffer + a "you hold RVLT, buy in or keep" path.
const RELAY_HEADROOM_BPS = Math.max(50, Math.min(1000, parseInt(process.env.VS_RELAY_HEADROOM_BPS||'150',10)||150));
// ---- BUY-BEFORE-SWAP SAFETY MARGINS ----------------------------------------------------------------------
// A Relay swap is irreversible (it market-buys RVLT onto Robinhood). We only let it start if the on-chain buyIn
// is essentially guaranteed to land AFTER the swap finishes. These margins reject a buy that is too close to the
// round's lock so a late race can't strand freshly-swapped RVLT. Small, env-tunable config constants:
//   PREFLIGHT_GRACE_MARGIN_SEC: for a threshold-FILL round whose grace fuse is armed, refuse if the grace timer
//     has fewer than this many seconds left (the round is about to lock).
//   PREFLIGHT_SEAT_MARGIN: refuse if the round is within this many seats of full (target) — it may fill+lock
//     before the swap confirms.
// A Relay cross-chain swap realistically takes tens of seconds; the default 90s grace / 3 seats leaves comfortable
// headroom for the swap to land AND the subsequent approve+buyIn to mine while buy-in is still open.
const PREFLIGHT_GRACE_MARGIN_SEC = Math.max(10, Math.min(3600, parseInt(process.env.VS_PREFLIGHT_GRACE_MARGIN_SEC||'90',10)||90));
const PREFLIGHT_SEAT_MARGIN = Math.max(0, Math.min(100, parseInt(process.env.VS_PREFLIGHT_SEAT_MARGIN||'3',10)||3));
// Resolve the round a buy-in CURRENTLY targets on-chain (the earliest still-Open round). Mirrors the id the
// /api/state `escrow.id` field advertises, so the client and the pre-flight agree on which round is being bought.
function currentBuyRoundId(){
  if(!escrow.isOn()) return null;
  if(C.engine==='rmfill') return (RM_BUY!=null) ? String(RM_BUY) : null;
  if(C.engine==='clock' && G) return String(G._buyRound||G.start);
  return null;
}
// Off-chain view of how close the TARGET buy-round is to locking, so the pre-flight can demand time/seat headroom
// BEFORE a swap. Returns null when the round isn't the live in-memory round (then on-chain state alone gates).
//   graceLeftSec: seconds left on an armed threshold-fill grace fuse (null = not armed / not a fill round)
//   seatsLeft:    target - ticketsSold (fill) OR null (clock lobby has a wall-clock, handled by lockInSec)
//   lockInSec:    seconds until the clock round leaves its lobby (clock engine only; null for fill)
//   buyOpen:      the round is still accepting buy-ins in memory
function buyRoundTiming(buyId){
  if(!G) return null;
  const now=Date.now();
  if(C.engine==='rmfill'){
    if(String(G.rmId)!==String(buyId)){
      // RUSH OVERFLOW (depth>2): a pre-opened round in the window gets its OWN seat headroom so pre-flight spreads
      // buyers + blocks oversell per round; otherwise (classic) a non-current round is treated as offRound (open).
      const _d=Math.max(2,Math.min(12,(getCfg().preopenDepth)||2));
      if(_d>2 && RM_OPEN.map(String).includes(String(buyId))){
        const target=C.target||50, sold=RM_SOLD[Number(buyId)]||0;
        return { buyOpen:true, graceLeftSec:null, seatsLeft:Math.max(0,target-sold), lockInSec:null, offRound:false };
      }
      return { buyOpen:true, graceLeftSec:null, seatsLeft:null, lockInSec:null, offRound:true };
    }
    // seatsLeft keys on G.ticketsSold, which (after the threshold-accounting fix in rmEscrowLifecycle) now sums the
    // ACTUAL on-chain tickets rather than the per-wallet-capped value — so target - sold reflects real remaining
    // capacity. seatCount() is intentionally NOT used here: in rmfill it is the per-wallet-capped seat-row count
    // (the same understatement), not the live ticket total. Math.max(0,...) keeps it non-negative; sold/target
    // both default so it is never NaN.
    const target=C.target||50, sold=G.ticketsSold||0;
    const graceLeftSec=(G.graceEnds!=null)?Math.max(0,Math.round((G.graceEnds-now)/1000)):null;
    return { buyOpen:(G.phase==='filling'), graceLeftSec, seatsLeft:Math.max(0,target-sold), lockInSec:null, offRound:false };
  }
  if(C.engine==='clock'){
    const p=clockPhaseAt(now), inLobby=(p.phase==='lobby');
    // if the buy targets the NEXT round, it's always in its (future) lobby -> ample headroom.
    if(String(G._buyRound||G.start)!==String(buyId)) return { buyOpen:true, graceLeftSec:null, seatsLeft:null, lockInSec:null, offRound:true };
    const lockInSec=inLobby?Math.max(0,Math.round((p.S.chooseStart[0]-now)/1000)):0;
    return { buyOpen:inLobby, graceLeftSec:null, seatsLeft:null, lockInSec, offRound:false };
  }
  return null;
}
// PRE-FLIGHT: validate that a buyIn for (buyId, qty) by `addr` will land, BEFORE any swap is committed. Returns
// { ok, reason, ... }. Checks (in order): escrow live -> round resolvable -> round Open on-chain -> comfortable
// lock headroom (time + seats) -> per-wallet cap (on-chain ticketsOf + cap) -> static buyIn simulation for any
// other state revert. reason is machine-readable: not_open | round_locking | round_full | cap_reached |
// bad_tickets | sim_revert | no_round | escrow_off. On ok it also returns the single-source-of-truth required /
// deliver amounts so the quote derives from the SAME number the cap/sim were checked against.
async function preflightBuy(buyId, qty, addr){
  if(!escrow.isOn()) return { ok:false, reason:'escrow_off' };
  if(buyId==null) return { ok:false, reason:'no_round' };
  // ANTI-WHALE: a wallet frozen for winning too many in a row cannot buy into a new round until the cooldown ends.
  const frz=isFrozen(addr);
  if(frz) return { ok:false, reason:'frozen', frozenUntil:frz };
  const tickets=Math.max(1,Math.min(MAX_TIX_PER_GAME,parseInt(qty,10)||1));
  // 1) on-chain round state (authoritative open/lock/cap)
  const st=await escrow.preflightState(buyId).catch(()=>null);
  if(!st) return { ok:false, reason:'no_round' };
  if(st.status!==1) return { ok:false, reason:'not_open' };                 // 1 = Open; anything else = locked/committed/settled/void
  const nowS=Math.floor(Date.now()/1000);
  if(st.deadline && nowS>=st.deadline) return { ok:false, reason:'not_open' };   // past its on-chain deadline
  if(st.lockTime && st.lockTime<=nowS) return { ok:false, reason:'round_locking' }; // lockTime already reached on-chain
  // 2) off-chain lock headroom (time + seats), so we never swap into a round about to fire
  const tm=buyRoundTiming(buyId);
  if(tm){
    if(!tm.buyOpen) return { ok:false, reason:'round_locking' };
    if(tm.graceLeftSec!=null && tm.graceLeftSec<PREFLIGHT_GRACE_MARGIN_SEC) return { ok:false, reason:'round_locking' };  // fill grace fuse about to fire
    if(tm.seatsLeft!=null && tm.seatsLeft<=0) return { ok:false, reason:'round_full' };
    // ADAPTIVE SEAT MARGIN: the fixed PREFLIGHT_SEAT_MARGIN (default 3) was tuned for ~50-seat launch rounds (refuse
    // only the final few seats so a Relay swap can't race a fill). For SMALL rounds (canary / low roundTarget) a fixed
    // 3 made EVERY round perma-"round_full" (a target-3 round starts at seatsLeft=3 <= 3). Cap the effective margin at
    // ~10% of the round target so small rounds stay Relay-buyable to the last seat; the client's buy-before-swap race
    // fallback (roll to next round / pay RVLT direct) still covers the rare fill-during-swap case.
    const _seatMargin = Math.min(PREFLIGHT_SEAT_MARGIN, Math.floor((Number(getCfg().roundTarget)||50)/10));
    if(tm.seatsLeft!=null && tm.seatsLeft>0 && tm.seatsLeft<=_seatMargin) return { ok:false, reason:'round_full' };       // within the (adaptive) seat margin of full
    if(tm.lockInSec!=null && tm.lockInSec<PREFLIGHT_GRACE_MARGIN_SEC) return { ok:false, reason:'round_locking' };        // clock lobby about to close
  }
  // 3) per-wallet cap: existing on-chain tickets + requested must fit under the round's cap. Use the on-chain cap
  // when the contract exposes one (>0), else the server's computed walletCap() for this round.
  const have=addr?await escrow.ticketsOf(buyId, addr).catch(()=>0):0;
  const cap=(st.walletCap>0)?st.walletCap:(G&&G._walletCap||walletCap());
  if(cap>0 && have+tickets>cap) return { ok:false, reason:'cap_reached', cap, have };
  // 4) static buyIn simulation (state reverts only; funding reverts are expected + treated as OK)
  const sim=await escrow.simulateBuyInState(buyId, tickets, addr).catch(()=>({ok:true,reason:'sim-threw'}));
  if(!sim.ok) return { ok:false, reason:sim.reason||'sim_revert' };
  // 5) single source of truth for the required RVLT (on-chain per-wallet price * tickets; holder-discount-aware).
  const costWei=await escrow.requiredRvltWei(buyId, tickets, addr);
  const deliverWei=(BigInt(costWei)*BigInt(10000+RELAY_HEADROOM_BPS)/10000n).toString();
  return { ok:true, reason:'ok', roundId:String(buyId), qty:tickets, cap, have, costWei, deliverWei, headroomBps:RELAY_HEADROOM_BPS };
}
// ---- BUY-BEFORE-SWAP PRE-FLIGHT. The client MUST call this and BLOCK the swap if ok:false, surfacing the
// reason to the player BEFORE they spend anything. It re-checks the identical gates the entry-quote applies, so
// a UI can show a clear reason up front without pricing. `buyId` optional: defaults to the current buy-round.
app.post('/api/relay/preflight', express.json({limit:'4kb'}), async (req,res)=>{
  if(!rl(rlKey(req,'relay'),60,60000)) return res.status(429).json({error:'slow down'});
  try{
    const cfg=escrow.config();
    if(!cfg.on) return res.json({ ok:false, reason:'escrow_off' });
    const qty=Math.max(1,Math.min(10,parseInt(req.body&&req.body.qty||'1',10)));
    const user=String(req.body&&req.body.user||'');
    if(user && !/^0x[0-9a-fA-F]{40}$/.test(user)) return res.status(400).json({ ok:false, reason:'bad_user' });
    const buyId=(req.body&&req.body.buyId!=null && /^\d+$/.test(String(req.body.buyId))) ? String(req.body.buyId) : currentBuyRoundId();
    const pf=await preflightBuy(buyId, qty, user||null);
    res.json(pf);
  }catch(e){ res.status(502).json({ ok:false, reason:'preflight_unavailable' }); }
});
app.post('/api/relay/entry-quote', express.json({limit:'8kb'}), async (req,res)=>{
  if(!rl(rlKey(req,'relay'),30,60000)) return res.status(429).json({error:'slow down'});
  try{
    const cfg=escrow.config();
    if(!cfg.on) return res.status(409).json({error:'escrow not enabled'});
    const entryWei=BigInt(cfg.entry||'0'); if(entryWei<=0n) return res.status(409).json({error:'no entry configured'});
    const qty=Math.max(1,Math.min(10,parseInt(req.body&&req.body.qty||'1',10)));
    const user=String(req.body&&req.body.user||'');
    const fromChainId=parseInt(req.body&&req.body.fromChainId,10);
    const fromCurrency=String(req.body&&req.body.fromCurrency||'0x0000000000000000000000000000000000000000');
    if(!/^0x[0-9a-fA-F]{40}$/.test(user)) return res.status(400).json({error:'valid user address required'});
    if(!fromChainId) return res.status(400).json({error:'fromChainId required'});
    // GATE THE SWAP: re-run the pre-flight here too (not just in the separate endpoint) so a client can never
    // skip it and price/swap into a round that won't accept the buy. buyId may be pinned by the client so the
    // quote, cap check and the later buyIn all target the SAME round.
    const buyId=(req.body&&req.body.buyId!=null && /^\d+$/.test(String(req.body.buyId))) ? String(req.body.buyId) : currentBuyRoundId();
    const pf=await preflightBuy(buyId, qty, user);
    if(!pf.ok) return res.status(409).json({ error:'preflight failed', reason:pf.reason, ok:false, buyId:buyId!=null?String(buyId):null });
    // SINGLE SOURCE OF TRUTH: the required (costWei) + delivered (deliverWei) amounts come straight from the
    // pre-flight, which derived them from the on-chain per-wallet price (holder-discount-aware). We do NOT
    // recompute entry*qty here, so the holder-discount change needs no edit on this path.
    const costWei=BigInt(pf.costWei), deliverWei=BigInt(pf.deliverWei);
    const body={ user, recipient:user, originChainId:fromChainId, originCurrency:fromCurrency,
      destinationChainId:cfg.chainId, destinationCurrency:cfg.rvlt, amount:deliverWei.toString(), tradeType:'EXACT_OUTPUT' };
    const r=await fetch(`${RELAY_API}/quote`,{method:'POST',headers:RELAY_HEADERS(),body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const quote=await r.json();
    res.status(r.status).json({ quote, entryWei:entryWei.toString(), costWei:costWei.toString(), deliverWei:deliverWei.toString(), headroomBps:RELAY_HEADROOM_BPS, qty, rvlt:cfg.rvlt, chainId:cfg.chainId, buyId:pf.roundId });
  }catch(e){ res.status(502).json({error:'entry quote unavailable'}); }
});
app.get('/api/siwe/nonce',(req,res)=>{
  // GAP-A: rate-limit nonce issuance. Without this an attacker can flood/overwrite a victim's pending nonce
  // (the SIWE map keys on address) to grief their sign-in, or hammer the endpoint as a cheap DoS.
  if(!rl(rlKey(req,'siwe-nonce'),5,60000)) return res.status(429).json({error:'slow down'});
  const a=String(req.query.address||'').toLowerCase();
  if(!/^0x[0-9a-fA-F]{40}$/.test(a)) return res.status(400).json({error:'valid address required'});
  const nonce=crypto.randomBytes(16).toString('hex'); SIWE[a]={nonce,exp:Date.now()+300000};
  res.json({nonce,message:siweMsg(a,nonce)});
});
app.post('/api/siwe/verify',(req,res)=>{
  if(!rl(rlKey(req,'siwe'),10,60000)) return res.status(429).json({error:'slow down'});
  try{
    const a=String(req.body&&req.body.address||'').toLowerCase();
    const sig=String(req.body&&req.body.signature||'');
    const rec=SIWE[a];
    if(!/^0x[0-9a-fA-F]{40}$/.test(a)||!rec||Date.now()>rec.exp) return res.status(400).json({error:'request a fresh nonce'});
    let who; try{ who=verifyMessage(siweMsg(a,rec.nonce),sig); }catch(_){ return res.status(400).json({error:'bad signature'}); }
    if(String(who).toLowerCase()!==a) return res.status(401).json({error:'signature does not match address'});
    delete SIWE[a];   // one-time use
    const token='w:'+a;
    REG[token]=REG[token]||{name:'Robber '+a.slice(2,6),pre:null,active:true,tickets:1};
    REG[token].verified=true; REG[token].address=a;
    res.json({ok:true,token,verified:true});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});
// IDOR fix: identity is the AUTHENTICATED token (x-vs-token header) only. A caller can only ever log out their
// own seat, never force-logout another player's token from the request body. Rate-limited to blunt abuse.
app.post('/api/logout',(req,res)=>{ if(!rl(rlKey(req,'logout'),20,60000)) return res.status(429).json({error:'slow down'}); const t=reqToken(req); if(t&&REG[t])REG[t].active=false; const pl=player(t); if(pl){pl.left=true;pl.alive=false;} res.json({ok:true}); });
// IDOR fix: pre-choice is set ONLY for the caller's own authenticated token (x-vs-token), never a body token.
// Routes are range-guarded the same way /api/autoplay does (0..maxch-1, else null) so a bad index can't slip in.
app.post('/api/prechoose',(req,res)=>{ if(!rl(rlKey(req,'pre'),15,60000)) return res.status(429).json({error:'slow down'}); const t=reqToken(req); if(!t||!REG[t])return res.status(400).json({error:'log in first'}); const mx=(C&&C.maxch)||8; const pre=(req.body.routes||[]).map(x=>x==null||x===''?null:parseInt(x,10)).map(x=>Number.isInteger(x)&&x>=0&&x<mx?x:null); REG[t].pre=pre; const pl=player(t); if(pl)pl.pre=pre; res.json({ok:true,pre}); });
// ---- HOLDER-AWARE PRICING (read-only; single source of truth = the on-chain per-ticket price) ----
// Returns the EXACT per-ticket + total RVLT this wallet is charged for `qty` tickets, straight from the
// contract's entryPriceFor (which halves on-chain for a Vault Robbers NFT holder once the Safe enables it).
// The client uses this to show the real price BEFORE a buy, so when the discount is still OFF on-chain
// (holderNft==0) everyone correctly sees full price. There is NO off-chain discount math here. `isHolder` and
// the on-chain discountBps are surfaced only for the UI badge; the CHARGE is always entryPriceFor.
app.get('/api/pricing',async (req,res)=>{
  if(!rl(rlKey(req,'pricing'),60,60000)) return res.status(429).json({error:'slow down'});
  const cfg=escrow.config();
  const qty=Math.max(1,Math.min(10,parseInt(req.query.qty||'1',10)||1));
  const entryUsd=getCfg().entryUsd;
  const tok=reqToken(req); const reg=tok&&REG[tok];
  // ADDRESS-ENUMERATION fix: holder status is private per-wallet, so we only resolve it for the caller's OWN
  // SIWE-verified address (reg.address, set at /api/siwe/verify). A `?address=` query is honored ONLY when it
  // matches that verified address; an arbitrary/unverified address is ignored (we fall back to full, non-holder
  // display pricing). This stops a caller from probing whether any address they name holds the NFT. Pre-verify
  // the client sends no verified address and simply sees full price, which is the correct display.
  const selfAddr=(reg&&reg.verified&&reg.address)?String(reg.address):'';
  const qAddr=(typeof req.query.address==='string')?req.query.address:'';
  const addr=(selfAddr && (!qAddr || qAddr.toLowerCase()===selfAddr.toLowerCase())) ? selfAddr : '';
  const hasAddr=/^0x[0-9a-fA-F]{40}$/.test(addr);
  // On-chain discount config (owner/Safe-set). enabled==false until the Safe sets holderNft+discountBps at staging.
  const disc=await escrow.holderDiscountConfig().catch(()=>({discountBps:0,enabled:false,matchesVsNft:null}));
  const isHolder = hasAddr ? await escrow.isHolder(addr).catch(()=>false) : false;
  // discount ACTUALLY APPLIES only when the contract has it enabled AND this wallet holds the NFT.
  const discountApplies = !!(disc.enabled && isHolder);
  const buyId=currentBuyRoundId();
  // Authoritative amounts from the contract (holder-discount-aware). If escrow is off / no round yet, fall back
  // to a display-only estimate from entryUsd so the sheet still shows a sensible number.
  let perTicketWei=null, totalWei=null;
  if(cfg.on && buyId!=null){
    try{ perTicketWei=await escrow.requiredRvltWei(buyId, 1, hasAddr?addr:null); }catch(_){}
    try{ totalWei=await escrow.requiredRvltWei(buyId, qty, hasAddr?addr:null); }catch(_){}
  }
  // per-ticket USD for the display: full entryUsd, halved only when the discount actually applies on-chain.
  const perTicketUsd = discountApplies ? Math.round(entryUsd*(1-disc.discountBps/10000)) : entryUsd;
  res.json({
    isHolder,
    discountBps: disc.enabled ? disc.discountBps : 0,   // 0 when the contract discount is OFF (not yet enabled)
    discountApplies,
    perTicketWei, totalWei, qty,
    perTicketUsd, fullPerTicketUsd: entryUsd,
    nft: escrow.holderConfig().nft,
    nftMatchesContract: disc.matchesVsNft,
    note: discountApplies ? 'Vault Robber holder price, charged on-chain at buy time'
                          : 'standard price (holder discount not currently enabled on-chain)'
  });
});

// ---- VAULT ROBBERS NFT UTILITY (per-heist airdrop). Read-only on-chain reads + claim calldata the OWNER signs.
// No keys server-side. All reads target Robinhood mainnet (where the NFT+RVLT+6551 live); inert/zero until the
// escrow is armed via setRobberConfig. ----
app.get('/api/robbers/config',(req,res)=>{ try{ res.json(Object.assign({}, robbers.config())); }catch(e){ res.status(500).json({error:'config'}); } });

app.get('/api/robbers/owned',async (req,res)=>{
  if(!rl(rlKey(req,'rob'),60,60000)) return res.status(429).json({error:'slow down'});
  // prefer the caller's SIWE-verified address; honor ?address= only if it matches (no owner enumeration surface)
  const tok=reqToken(req); const reg=tok&&REG[tok];
  const selfAddr=(reg&&reg.verified&&reg.address)?String(reg.address):'';
  const qAddr=(typeof req.query.address==='string')?req.query.address:'';
  const addr=(selfAddr && (!qAddr || qAddr.toLowerCase()===selfAddr.toLowerCase())) ? selfAddr : (qAddr||selfAddr);
  if(!/^0x[0-9a-fA-F]{40}$/.test(addr)) return res.json({address:addr,armed:false,robbers:[]});
  try{ res.json(await robbers.owned(addr)); }catch(e){ res.status(502).json({error:'owned lookup failed'}); }
});

app.get('/api/robbers/leaderboard',async (req,res)=>{
  if(!rl(rlKey(req,'rob'),30,60000)) return res.status(429).json({error:'slow down'});
  try{ res.json(await robbers.leaderboard(req.query.limit)); }catch(e){ res.status(502).json({error:'leaderboard failed'}); }
});

app.get('/api/robbers/feed',async (req,res)=>{
  if(!rl(rlKey(req,'rob'),60,60000)) return res.status(429).json({error:'slow down'});
  try{ res.json(await robbers.feed(req.query.limit)); }catch(e){ res.status(502).json({error:'feed failed'}); }
});

app.post('/api/robbers/claim-plan',express.json({limit:'4kb'}),async (req,res)=>{
  if(!rl(rlKey(req,'robclaim'),30,60000)) return res.status(429).json({error:'slow down'});
  const tok=reqToken(req); const reg=tok&&REG[tok];
  const selfAddr=(reg&&reg.verified&&reg.address)?String(reg.address):'';
  const owner=selfAddr || (typeof (req.body&&req.body.address)==='string'?req.body.address:'');
  const tokenId=parseInt((req.body&&req.body.tokenId),10);
  if(!/^0x[0-9a-fA-F]{40}$/.test(owner)) return res.status(400).json({error:'connect + verify your wallet first'});
  if(!Number.isInteger(tokenId)||tokenId<=0) return res.status(400).json({error:'bad tokenId'});
  // claimPlan enforces on-chain ownerOf(tokenId)==owner, so it can never build a sweep for a robber you do not own.
  try{ res.json(await robbers.claimPlan(tokenId, owner)); }catch(e){ res.status(400).json({error:String(e&&e.message||'claim plan failed')}); }
});

// ---- FEATURE 2: AUTO-PLAY (durable recurring prechoose). Set a persistent door strategy that re-applies every
// round until turned off. Survives restart. The seeded absent-default still covers any chamber left null. ----
app.post('/api/autoplay',(req,res)=>{
  if(!rl(rlKey(req,'autoplay'),20,60000)) return res.status(429).json({error:'slow down'});
  // IDOR fix: identity is the AUTHENTICATED token (x-vs-token header) only, never a body token. And, mirroring
  // /api/autobuy's ownership gate, the caller may only arm autoplay for their OWN SIWE-VERIFIED session — a bare
  // (unverified) registration can no longer persist autoplay for its u_ token.
  const tok=reqToken(req); const reg=tok&&REG[tok];
  if(!(reg&&reg.verified&&reg.address)) return res.status(401).json({error:'sign in with this wallet (SIWE) first'});
  const on=!!(req.body&&req.body.on);
  if(on){
    const pre=(req.body.routes||[]).map(x=>x==null||x===''?null:parseInt(x,10)).map(x=>Number.isInteger(x)&&x>=0&&x<8?x:null).slice(0,20);
    AUTOPLAY_STORE[tok]={ on:true, pre, ts:Date.now() };
    REG[tok].pre=pre.slice(); REG[tok].autoplay=true;
    const pl=player(tok); if(pl) pl.pre=pre.slice();
  } else {
    delete AUTOPLAY_STORE[tok]; if(REG[tok]) REG[tok].autoplay=false;
  }
  saveAutoplay();
  res.json({ ok:true, on, pre:(AUTOPLAY_STORE[tok]&&AUTOPLAY_STORE[tok].pre)||null });
});
app.get('/api/autoplay',(req,res)=>{ const tok=reqToken(req); const ap=tok&&AUTOPLAY_STORE[tok]; res.json({ on:!!(ap&&ap.on), pre:(ap&&ap.pre)||null }); });

// ---- FEATURE 2: AUTO-BUY (recurring, bounded). The CLIENT signs an EIP-712 AutoBuy authorization and approves
// the escrow for a BOUNDED allowance (NEVER unlimited). This stores the signed, bounded authorization; the
// relayer (dedicated key) submits buyInFor each new round until budget/expiry is spent. SECURITY SIGN-OFF
// REQUIRED BEFORE MAINNET. The server verifies nothing it can't: bounds are enforced ON-CHAIN in buyInFor. ----
// Surface the data the client needs to build a correct signature: the on-chain nonce + domain separator.
app.get('/api/autobuy/params',async (req,res)=>{
  if(!escrow.isOn()) return res.status(409).json({error:'escrow not enabled'});
  const tok=reqToken(req); const reg=tok&&REG[tok];
  // The auto-buy signing material is bound to the caller's OWN SIWE-verified wallet. A `?address=` query is
  // honored only when it matches that verified address, so this can't be used to enumerate arbitrary wallets.
  const selfAddr=(reg&&reg.verified&&reg.address)?String(reg.address):'';
  const qAddr=(typeof req.query.address==='string')?req.query.address:'';
  const addr=(selfAddr && (!qAddr || qAddr.toLowerCase()===selfAddr.toLowerCase())) ? selfAddr : '';
  if(!/^0x[0-9a-fA-F]{40}$/.test(addr)) return res.status(400).json({error:'verified wallet required'});
  const [nonce,domainSep,relayer]=await Promise.all([escrow.autoBuyNonce(addr),escrow.domainSeparator(),escrow.onchainRelayer()]);
  // Suggested consecutive roundIds to pre-sign for, starting at the current buy-round. clock ids advance by the
  // interval; rmfill ids advance by 1. The client signs {roundId, player, maxTickets, maxEntry, nonce, deadline}
  // with nonce = base nonce + k for the k-th roundId. The relayer submits each into its bound round, in order.
  const _wantN=Math.max(1,Math.min(50,parseInt(req.query.rounds,10)||5));
  const _baseRound=(C.engine==='rmfill') ? (RM_BUY!=null?RM_BUY:null) : (G?(G._buyRound||G.start):null);
  const suggestedRounds=[];
  if(_baseRound!=null){ for(let k=0;k<_wantN;k++){
    const r=(C.engine==='rmfill') ? (Number(_baseRound)+k) : (Number(_baseRound)+k*C.interval);
    suggestedRounds.push({ roundId:String(r), nonce:(Number(nonce)+k) });
  } }
  // Full EIP-712 signing material: a client calling signTypedData(domain,types,value) needs the structured
  // domain {name,version,chainId,verifyingContract} — the raw domainSeparator hash alone is NOT enough to sign.
  // The AutoBuy struct is BOUND TO A SPECIFIC roundId (first field), so the client must sign a fresh signature
  // per round it wants entered; the relayer submits buyInFor(roundId,...) with the matching signature.
  const domain=escrow.eip712Domain();
  res.json({
    nonce,
    domain,                                        // { name, version, chainId, verifyingContract } for signTypedData
    types:escrow.autobuyTypes(),                   // { AutoBuy: [...] } ethers-v6 typed-data (no EIP712Domain entry)
    primaryType:'AutoBuy',
    typehash:escrow.autobuyTypehash(),             // bytes32 keccak256 of the type string (on-chain AUTOBUY_TYPEHASH)
    typeString:escrow.autobuyTypeString(),         // the canonical struct type string
    domainSeparator:domainSep,                     // on-chain domainSeparatorV4() (for verification/debugging)
    fields:['roundId','player','maxTickets','maxEntry','nonce','deadline'],   // exact signing order
    // legacy alias kept so older clients that read `typehash` as the string don't break outright:
    typehashString:escrow.autobuyTypeString(),
    chainId:escrow.config().chainId, escrow:escrow.config().address, entryWei:escrow.entryWei(),
    // V6 RANGE signing material: sign ONE AutoBuyRange over [roundStart, roundStart+roundCount) to cover ALL heists with
    // a single signature. roundStart = the current buy-round, roundCount = how many heists, nonce = the base on-chain
    // nonce (shared across the range). POST { player, roundStart, roundCount, maxTickets, perRound, maxEntry, deadline,
    // nonce, sig }. This is the preferred path (1 approve + 1 signature regardless of game count).
    range: (_baseRound!=null) ? {
      rangeTypes: escrow.autobuyRangeTypes(),       // { AutoBuyRange:[...] } ethers-v6 typed-data (roundStart first)
      primaryType:'AutoBuyRange',
      roundStart:String(_baseRound), roundCount:_wantN, nonce:Number(nonce),
      fields:['roundStart','roundCount','player','maxTickets','maxEntry','nonce','deadline']
    } : null,
    suggestedRounds,                               // [{roundId,nonce}] consecutive pairs to pre-sign for a multi-round budget
    relayerOnchain:relayer, relayerServer:escrow.relayAddress(), relayerUsable:escrow.relayUsable(), relayerIsFallback:escrow.relayIsFallback(),
    // MULTI-ROUND (HIGH-1): to auto-enter N rounds, pre-sign N authorizations over CONSECUTIVE (roundId, nonce)
    // pairs starting at the current buy-round / `nonce` — all under the same maxTickets/maxEntry/deadline — and
    // POST them as auths:[{roundId,nonce,sig},...]. The relayer consumes them in order, one per buy-round. The
    // AutoBuy struct IS bound to roundId on-chain: AUTOBUY_TYPEHASH includes roundId as its FIRST field and
    // buyInFor enforces that the submitted round matches the signed roundId, so EACH signature is valid ONLY for
    // the exact round it was signed for (also bounded by nonce + maxTickets/maxEntry/deadline). roundId MUST be
    // included in the signed EIP-712 message.
    note:'Sign one AutoBuy per (roundId, nonce) pair via EIP-712 with the `domain` + `types` above (roundId is the FIRST signed field and is enforced on-chain). For a multi-round budget pre-sign consecutive (roundId, nonce) pairs and POST auths:[{roundId,nonce,sig},...]. Approve the escrow for a BOUNDED RVLT allowance covering all rounds (never unlimited).' });
});
// Store a MULTI-ROUND AutoBuy authorization as an ORDERED ARRAY of pre-signed, bounded EIP-712 authorizations.
// HIGH-1: the on-chain AutoBuy struct is BOUND to BOTH a specific roundId AND a per-player nonce, and buyInFor
// consumes the nonce on every entry — so ONE signature only ever enters the ONE round it was signed for. To
// auto-enter N consecutive rounds the client pre-signs N authorizations over consecutive (roundId, nonce) pairs
// [{roundId:R,nonce:N,sig},{roundId:R+1,nonce:N+1,sig},...] — all under the SAME bounds (maxTickets/maxEntry/
// deadline). We store the ordered list; autoBuyTick submits the entry whose nonce == the current on-chain
// autoBuyNonce(player) into its bound roundId when that roundId is the live buy-round, in order, retiring each as
// spent. Every on-chain bound (roundId/maxTickets/maxEntry/deadline/nonce + ECDSA recovery) is enforced inside
// buyInFor; this endpoint only validates shape + that nonces (and, when provided, roundIds) are strictly
// consecutive. Back-compat: a single {roundId,nonce,sig} body is accepted and wrapped into a one-element array.
app.post('/api/autobuy',express.json({limit:'32kb'}),async (req,res)=>{
  if(!rl(rlKey(req,'autobuy'),10,60000)) return res.status(429).json({error:'slow down'});
  if(!escrow.isOn()) return res.status(409).json({error:'escrow not enabled'});
  if(!escrow.relayUsable()) return res.status(409).json({error:'auto-buy relayer not provisioned (set VS_RELAY_PK)'});
  const b=req.body||{};
  const player=String(b.player||'').toLowerCase();
  if(!/^0x[0-9a-fA-F]{40}$/.test(player)) return res.status(400).json({error:'valid player address required'});
  // A verified SIWE session for this address is required so a stranger can't register an auth for someone else.
  const tok=reqToken(req); const reg=tok&&REG[tok];
  if(!(reg&&reg.verified&&reg.address&&reg.address.toLowerCase()===player)) return res.status(401).json({error:'sign in with this wallet (SIWE) first'});
  const maxTickets=Math.max(1,Math.min(100,parseInt(b.maxTickets,10)||0));
  const perRound=Math.max(1,Math.min(maxTickets,parseInt(b.perRound,10)||1));
  const maxEntry=String(b.maxEntry||'0'); if(!/^\d+$/.test(maxEntry)||maxEntry==='0') return res.status(400).json({error:'maxEntry (wei) required'});
  const deadline=parseInt(b.deadline,10); if(!deadline||deadline*1000<=Date.now()) return res.status(400).json({error:'future deadline (unix seconds) required'});
  // V6 RANGE AUTHORIZATION (preferred): ONE EIP-712 signature over [roundStart, roundStart+roundCount). The relayer
  // enters the player into each round of the range off this single sig (buyInForRange). This is what cuts a multi-game
  // deposit to one approve + one signature. On-chain bounds (range membership, maxTickets/maxEntry/deadline/nonce +
  // per-round rangeSpent + ECDSA recovery) are all enforced in buyInForRange; here we just validate shape + store it.
  if(b.roundStart!=null && b.roundCount!=null && b.sig!=null && !Array.isArray(b.auths)){
    const roundStart=String(b.roundStart); if(!/^\d+$/.test(roundStart)) return res.status(400).json({error:'bad roundStart'});
    const roundCount=parseInt(b.roundCount,10); if(!Number.isInteger(roundCount)||roundCount<1||roundCount>200) return res.status(400).json({error:'roundCount must be 1..200'});
    const nonce=parseInt(b.nonce,10); if(!Number.isInteger(nonce)||nonce<0) return res.status(400).json({error:'bad nonce'});
    const sig=String(b.sig||''); if(!/^0x[0-9a-fA-F]{130}$/.test(sig)) return res.status(400).json({error:'65-byte signature required'});
    // RANGE-REPLAY HARDENING (LOW): rangeSpent is the OFF-CHAIN per-round replay guard (the relayer skips a round
    // already relayed for this range). It is persisted to disk by saveAutobuy() and reloaded on boot, so a bare
    // process restart cannot replay. BUT the raw range sig is MEMORY-ONLY (nulled on disk), so after a restart the
    // player must RE-ARM with the same signature to resume — and a naive re-arm used to reset rangeSpent to [],
    // re-opening the replay window for rounds already entered before the restart. So: when the player re-arms the
    // IDENTICAL range (same roundStart + nonce), CARRY FORWARD the prior rangeSpent, and set roundsLeft net of it.
    // (The on-chain rangeSpent(address,uint256) mapping remains the ultimate hard guard — a replayed buyInForRange
    // reverts there regardless; this keeps our off-chain mirror honest so the relayer never even attempts a replay.)
    const _prev=AUTOBUY_STORE[player];
    const _sameRange=(_prev && _prev.range && String(_prev.range.roundStart)===roundStart && Number(_prev.range.nonce)===nonce && Array.isArray(_prev.rangeSpent));
    const carriedSpent=_sameRange ? _prev.rangeSpent.slice() : [];
    AUTOBUY_STORE[player]={ player, maxTickets, perRound, maxEntry, deadline,
      range:{ roundStart, roundCount, nonce, sig }, rangeSpent:carriedSpent, roundsLeft:Math.max(0, roundCount-carriedSpent.length), spent:[], lastRoundId:null, ts:Date.now(), retiredReason:null };
    saveAutobuy();
    return res.json({ ok:true, active:{ player, maxTickets, perRound, maxEntry, deadline, roundStart, roundCount, roundsLeft:Math.max(0, roundCount-carriedSpent.length) },
      note:'range auto-buy stored: ONE signature covers '+roundCount+' heist(s). Ensure you approved the escrow for a bounded allowance covering them. A deposit is final (revoke on-chain via invalidateAutoBuy()/approve(0) only).' });
  }
  // Accept EITHER an array of {roundId,nonce,sig} (preferred, multi-round) OR a single {roundId,nonce,sig} (back-compat).
  let rawAuths = Array.isArray(b.auths) ? b.auths
               : (b.nonce!=null && b.sig!=null) ? [{ roundId:b.roundId, nonce:b.nonce, sig:b.sig }]
               : null;
  if(!Array.isArray(rawAuths) || !rawAuths.length) return res.status(400).json({error:'auths[] (or roundId+nonce+sig) required'});
  if(rawAuths.length>100) return res.status(400).json({error:'too many authorizations (max 100)'});
  const auths=[];
  for(let i=0;i<rawAuths.length;i++){
    const e=rawAuths[i]||{};
    const rr=String(e.roundId==null?'':e.roundId); if(!/^\d+$/.test(rr)) return res.status(400).json({error:'bad roundId at index '+i});
    const nn=parseInt(e.nonce,10); if(!Number.isInteger(nn)||nn<0) return res.status(400).json({error:'bad nonce at index '+i});
    const ss=String(e.sig||''); if(!/^0x[0-9a-fA-F]{130}$/.test(ss)) return res.status(400).json({error:'65-byte signature required at index '+i});
    auths.push({ roundId:rr, nonce:nn, sig:ss, spent:false, spentRound:null, tx:null });
  }
  // nonces MUST be strictly consecutive ascending (N, N+1, ...): the exact order the contract consumes them in.
  // roundIds MUST be strictly increasing too (R < R+1 ...) so they map one-per-round into successive buy-rounds;
  // we don't require roundId==nonce+k (clock ids are big timestamps), only that both sequences advance in step.
  for(let i=1;i<auths.length;i++){
    if(auths[i].nonce!==auths[i-1].nonce+1) return res.status(400).json({error:'nonces must be strictly consecutive ascending'});
    if(!(BigInt(auths[i].roundId)>BigInt(auths[i-1].roundId))) return res.status(400).json({error:'roundIds must be strictly increasing'});
  }
  AUTOBUY_STORE[player]={ player, maxTickets, perRound, maxEntry, deadline,
    auths, startNonce:auths[0].nonce,
    roundsLeft:auths.length, spent:[], lastRoundId:null, ts:Date.now(), retiredReason:null };
  saveAutobuy();
  res.json({ ok:true, active:{ player, maxTickets, perRound, maxEntry, deadline, rounds:auths.map(a=>({ roundId:a.roundId, nonce:a.nonce })), roundsLeft:auths.length },
    note:'bounded multi-round auto-buy stored ('+auths.length+' pre-signed round(s)). Ensure you approved the escrow for a bounded allowance covering these rounds. Each round consumes one (roundId,nonce) in order; re-authorize when all are spent. Mainnet requires a security sign-off.' });
});
app.post('/api/autobuy/cancel',express.json({limit:'4kb'}),(req,res)=>{
  // H-2: require a valid play-gate session AND take the auth token from the x-vs-token HEADER ONLY (never the
  // request body — a body-supplied token could be forged independent of the gated session). The player address
  // is derived from the header-verified SIWE registration, not from req.body.player.
  if(!gateOk(req)) return res.status(401).json({error:'gate required'});
  const htok=req.headers['x-vs-token']; const tok=(typeof htok==='string'&&htok)?htok:null;
  const reg=tok&&REG[tok]; const player=(reg&&reg.address&&reg.address.toLowerCase())||'';
  if(!/^0x[0-9a-fA-F]{40}$/.test(player)) return res.status(400).json({error:'player address required'});
  if(!(reg&&reg.verified&&reg.address&&reg.address.toLowerCase()===player)) return res.status(401).json({error:'sign in with this wallet first'});
  if(AUTOBUY_STORE[player]){ delete AUTOBUY_STORE[player]; saveAutobuy(); }
  res.json({ ok:true, note:'auto-buy cancelled on the server. Also revoke the escrow allowance (approve(escrow,0)) for full off.' });
});
// ADDRESS-ENUMERATION fix: only ever return the CALLER'S OWN auto-buy, keyed off their SIWE-verified address
// (reqToken -> REG[tok].verified + .address). No `?address=` lookup, so a caller cannot probe another wallet's
// bounded auto-buy authorization.
app.get('/api/autobuy',(req,res)=>{ const tok=reqToken(req); const reg=tok&&REG[tok]; const player=(reg&&reg.verified&&reg.address&&reg.address.toLowerCase())||null; const a=player&&AUTOBUY_STORE[player];
  res.json(a?{ active:true, maxTickets:a.maxTickets, perRound:a.perRound, roundsLeft:a.roundsLeft, deadline:a.deadline, spent:a.spent.length, lastRoundId:a.lastRoundId||null, retiredReason:a.retiredReason||null,
    nonces:(Array.isArray(a.auths)?a.auths.map(x=>({ nonce:x.nonce, spent:!!x.spent, round:x.spentRound||null })):[]) }:{ active:false }); });

app.post('/api/pick',(req,res)=>{ if(!rl(rlKey(req,'pick'),5,10000)) return res.status(429).json({error:'slow down'});
  // IDOR fix: the acting player is the AUTHENTICATED token (x-vs-token header) only. Previously the seat was
  // read from req.body.token, letting any gate-authed caller pick a door for ANOTHER player's seat. Route
  // validation (Number.isInteger + range) below is unchanged.
  const _tok=reqToken(req); const pl=player(_tok);
  // LIVE OVERTIME: during an OT CHOOSE window a finalist picks against the OT doors (same endpoint, no blind phase).
  // This takes precedence over the per-engine run-info (which would read the wall clock as 'ended' past maxch).
  const info = (G&&G.ot) ? { phase:(G.otPhase==='choose'?'choose':'ot-'+G.otPhase), blind:false }
             : MODE==='fill' ? (G&&G.phase==='running'?fillRunInfo(Date.now()):{phase:G?G.phase:'?'})
             : C.engine==='rmfill' ? (G&&G.phase==='playing'?rmRunInfo(Date.now()):{phase:G?G.phase:'?'})
             : clockPhaseAt(Date.now());
  if(!pl||!pl.alive||info.phase!=='choose'||info.blind)return res.status(400).json({error:'cannot pick'}); const r=parseInt(req.body.route,10); if(!Number.isInteger(r)||r<0||r>=G.routes.length)return res.status(400).json({error:'bad route'}); pl.pick=r;
  stampSeen(_tok); pl.away=false;   // a manual pick means you're present: resume manual control, clear away autopilot
  // append-only pick log (token HASHED, never raw) keyed to the round + current chamber + chosen door, for the public proof.
  logPick(G.roundId, reqToken(req), G.cur!=null?G.cur:-1, r); res.json({ok:true}); try{global.__vsNudge&&global.__vsNudge();}catch(_){ } });
app.post('/api/chat',(req,res)=>{ if(!rl(rlKey(req,'chat'),6,10000)) return res.status(429).json({error:'slow down'}); const tok=reqToken(req); const pl=player(tok); const reg=REG[tok]; const text=req.body&&String(req.body.text||'').trim().slice(0,120); if(!text)return res.status(400).json({error:'empty'});
  // store ONLY an opaque token hash (never the raw token); /api/state turns it into a per-request `mine` flag.
  CHAT.push({name:(pl&&pl.name)||(reg&&reg.name)||'anon',text,ts:Date.now(),th:tokenHash(tok)}); while(CHAT.length>80)CHAT.shift(); res.json({ok:true}); try{global.__vsNudge&&global.__vsNudge();}catch(_){ } });
// Privileged: switching mode resets the live game, so it is admin-only (was unauthenticated). Fail-closed:
// with no VS_ADMIN_TOKEN provisioned, mode is locked to its configured value. ADDITIONALLY: a mode switch is
// REFUSED while a real-money round is committed-but-unsettled, because resetting G mid-round would orphan a
// funded on-chain pot (split-brain). The operator must let the live round settle (or void) first.
function realRoundInFlight(){ for(const gs of ESC_COMMITTED){ if(!ESC_SETTLED.has(gs)) return gs; } return null; }
app.post('/api/mode',(req,res)=>{ if(!vsAdminOk(req))return res.status(401).json({error:'unauthorized'}); const m=req.body&&req.body.mode; if(!MODES[m])return res.status(400).json({error:'bad mode'});
  if(escrow.isOn()){ const live=realRoundInFlight(); if(live!=null) return res.status(409).json({error:'a real-money round is live (round '+live+'); let it settle before switching mode'}); }
  MODE=m; C=MODES[m]; G=null; tick(); res.json({ok:true,mode:MODE}); });

// ---- ADMIN DASHBOARD API (gated by the admin token; rate-limited; config edits apply NEXT round) ----
// Admin login: exchange the raw admin token for an HttpOnly cookie so the dashboard doesn't keep the token in
// JS after the first call. Rate-limited to blunt brute force; fail-closed (401) on a wrong token.
app.post('/api/admin/login',(req,res)=>{
  if(!rl(rlKey(req,'admlogin'),10,60000)) return res.status(429).json({error:'slow down'});
  const t=req.body&&req.body.token;
  if(typeof t!=='string'||!_ctEq(t,ADMIN_TOKEN)) return res.status(401).json({error:'unauthorized'});
  res.setHeader('Set-Cookie',`vs_admin=${ADMIN_COOKIE}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`);
  res.json({ok:true});
});
app.post('/api/admin/logout',(req,res)=>{ if(!adminOk(req)) return res.status(401).json({error:'unauthorized'}); res.setHeader('Set-Cookie','vs_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'); res.json({ok:true}); });
// Gate for every other admin route: requires the token (header or cookie) + a rate limit, else 401.
function adminGate(req,res,next){ if(!rl(rlKey(req,'admin'),120,60000)) return res.status(429).json({error:'slow down'}); if(!adminOk(req)) return res.status(401).json({error:'unauthorized'}); next(); }
// Read the active + staged (pending) economy config, plus the computed per-wallet cap for each.
app.get('/api/admin/config', adminGate, (req,res)=>{
  const active=getCfg(), pending=getPendingCfg();
  const withCap=(c)=> c ? Object.assign({}, c, { _walletCapAbs: Math.max(1, Math.ceil(c.maxTicketsPerWalletPct/100 * c.roundTarget)) }) : null;
  res.json({ active:withCap(active), pending:withCap(pending), ranges:CFG_RANGES, appliesOn:'next round' });
});
// Stage a config edit: validated + clamped, persisted, applied at the NEXT round boundary (never mid-round).
app.post('/api/admin/config', adminGate, (req,res)=>{
  const raw=(req.body&&typeof req.body==='object')?req.body:{};
  // LOW: prototype-pollution guard. Build the patch from OWN enumerable keys only, dropping __proto__/constructor/
  // prototype so a crafted body can never walk the prototype chain inside _clampCfg/Object.assign. _clampCfg only
  // reads the known CFG_DEFAULTS keys anyway, but stripping here makes the guard explicit and defensive.
  const patch={};
  for(const k of Object.keys(raw)){ if(k==='__proto__'||k==='constructor'||k==='prototype') continue; patch[k]=raw[k]; }
  const pending=setCfg(patch);
  res.json({ ok:true, pending, active:getCfg(), appliesOn:'next round' });
});
// #223 ORPHAN CLEAR: resolve one stranded round on demand instead of waiting for the ~24h sentinel-deadline sweep.
// Reuses the EXACT settle-watcher logic (_watchResolveRound): it settles to the recovered champion if one exists,
// else voids a past-deadline round to open refunds. Still bound by the same on-chain rules — an Open round only
// voids once its deadline passed; a Committed round only settles/voids once past its play margin — so this can
// never force-close a round that is still legitimately live. Returns the terminal action taken.
app.post('/api/admin/resolve-round', adminGate, express.json({limit:'1kb'}), async (req,res)=>{
  const id = req.body && (req.body.id!=null ? String(req.body.id) : null);
  if(!id || !/^\d+$/.test(id)) return res.status(400).json({ error:'numeric round id required' });
  if(!escrow.isOn()) return res.status(400).json({ error:'escrow is off' });
  try{ const result=await _watchResolveRound(id); res.json({ ok:true, id, result }); }
  catch(e){ res.status(500).json({ error:String((e&&e.message)||e).slice(0,200) }); }
});
// (REMOVED 2026-10-10) The admin rebate-payout endpoint is gone: the holder discount is charged ON-CHAIN at buy
// time (entryPriceFor), so there is no off-chain treasury rebate to pay out. The pot already receives the
// discounted amount, which is the single source of truth.

// ---- metrics (cached ~5s): on-chain escrow context + round history + aggregate totals + the live round. ----
let _metricsCache=null, _metricsAt=0;
async function buildMetrics(){
  const cfg=escrow.config();
  const [gas, rbps, burnBps] = await Promise.all([ escrow.signerGasEth().catch(()=>null), escrow.rakeBps().catch(()=>null), escrow.burnShareBps().catch(()=>null) ]);
  // recent rounds from the persisted proof store (newest first); enrich real-money rounds with on-chain reads.
  const ids=Object.keys(PROOF_STORE).sort((a,b)=>(PROOF_STORE[b].ts||0)-(PROOF_STORE[a].ts||0)).slice(0,12);
  const base=cfg.on?`/pub/main/vaultstandoff-dev/`:``;
  let potSumRvlt=0, settled=0, voided=0;
  const recentRounds=[];
  for(const id of ids){
    const p=PROOF_STORE[id]; const w=p.winner||{};
    let status = w.none ? 'void' : (w.split ? 'split' : 'settled');
    if(w.none) voided++; else settled++;
    let pot=0, winner = w.none ? '(no winner, refunded)' : w.split ? ('split x'+(w.n||0)) : (w.name||'winner');
    if(p.realMoney){ const ri=await escrow.roundInfo(id).catch(()=>null); if(ri){ pot=ri.pot; if(ri.status===3) status='settled'; else if(ri.status===4) status='void'; } }
    potSumRvlt+=pot;
    recentRounds.push({ id, pot, status, winner, ts:p.ts||0, realMoney:!!p.realMoney, proofUrl:(base?base:'')+ 'api/round/'+encodeURIComponent(id)+'/proof' });
  }
  // rake split policy: treasury vs burn, derived from the LIVE on-chain burnShareBps (AD-1). burnShareBps is the
  // portion OF THE RAKE that is burned; the remainder goes to treasury. 0 == 100% treasury (the current mainnet
  // target), so the former hard-coded 50/50 split was inaccurate. Fall back to 0 (all-treasury) if the read fails.
  const rakePool = rbps!=null ? potSumRvlt * rbps/10000 : 0;
  const burnShareBps = (burnBps!=null) ? burnBps : 0;
  const rakeBurned = rakePool * burnShareBps/10000;
  const rakeToTreasury = rakePool - rakeBurned;
  const livePhase = G ? ((MODE==='fill'||C.engine==='rmfill') ? (G.phase||null) : clockPhaseAt(Date.now()).phase) : null;
  const live = G ? { phase:livePhase, seats:seatCount(), roundId:(G.roundId||null), pot: realMoney()?(G._onchainPot||0):seatCount()*ENTRY } : null;
  // HOLDER DISCOUNT: on-chain config (owner/Safe-set). enabled==false + discountBps==0 until the Safe turns it on
  // at staging; nftMatchesContract asserts the contract's holderNft equals VS_NFT_ADDR. No off-chain ledger.
  const holderDiscount = await escrow.holderDiscountConfig().catch(()=>({nft:null,discountBps:0,enabled:false,matchesVsNft:null}));
  // FEATURE 2: auto-buy / auto-play context.
  const relayGas = await escrow.relayGasEth().catch(()=>null);
  const autobuyActive=Object.values(AUTOBUY_STORE).filter(a=>a.roundsLeft>0&&Date.now()<=a.deadline*1000);
  const autobuy = { relayerServer:escrow.relayAddress(), relayerUsable:escrow.relayUsable(), relayerIsFallback:escrow.relayIsFallback(),
    relayerGasEth:relayGas, activeAuthorizations:autobuyActive.length, totalAuthorizations:Object.keys(AUTOBUY_STORE).length };
  const autoplay = { enabledTokens:Object.values(AUTOPLAY_STORE).filter(a=>a&&a.on).length, minPresentPct:getCfg().minPresentPct||0,
    presentHumans: G?presentHumanCount():0, minPresentRequired:minPresentRequired() };
  // FEATURE 3: settle-watcher health.
  const watcher = { lastTickTs:WATCH.lastTickTs, lastActionTs:WATCH.lastActionTs, bootSweepDone:WATCH.bootSweepDone,
    pendingRounds:WATCH.pending.slice(), errors:WATCH.errors, signerGasEth:gas, recentActions:WATCH.actions.slice(0,15),
    intervalMs:WATCH_INTERVAL_MS, stale:(WATCH.lastTickTs>0 && Date.now()-WATCH.lastTickTs > WATCH_INTERVAL_MS*3) };
  // MED-2: payout keeper health. Reuses the same signer gas read (`gas`) already fetched above, so no new on-chain
  // call. lowSignerGas flags a signer that may be unable to pay for the payWinners/payRake transactions.
  const payoutKeeper = { queueLen:Object.keys(PAYOUT_QUEUE).length, busy:_payoutBusy, signerGasEth:gas,
    lowSignerGas:(gas!=null && gas < 0.002), drops:PAYOUT_STATS.drops, lastError:PAYOUT_STATS.lastError,
    lastErrorTs:PAYOUT_STATS.lastErrorTs, alerts:PAYOUT_ALERTS.slice(-10) };
  return {
    escrow:{ on:cfg.on, chainId:cfg.chainId, address:cfg.address, rvlt:cfg.rvlt, entry:cfg.entry },
    signerAddress: escrow.signerAddress(), signerGasEth: gas, rakeBps: rbps,
    recentRounds,
    totals:{ rounds:ids.length, settled, voided, potSumRvlt, rakePool, burnShareBps, rakeToTreasury, rakeBurned },
    holderDiscount, autobuy, autoplay, watcher, payoutKeeper,
    // ANTI-AGENT: wallets entering an unusually high number of rounds/hr (monitoring signal only; play is never altered).
    velocityFlags: velocityFlags(), velocityWindowHrs: VEL.WINDOW_MS/3600000, velocityThreshold: VEL.FLAG,
    live, ts:Date.now()
  };
}
app.get('/api/admin/metrics', adminGate, async (req,res)=>{
  const now=Date.now();
  if(_metricsCache && now-_metricsAt<5000) return res.json(_metricsCache);
  try{ _metricsCache=await buildMetrics(); _metricsAt=now; res.json(_metricsCache); }
  catch(e){ res.status(502).json({error:'metrics unavailable'}); }
});

// --- STATE SERIALIZER (shared by the HTTP poll AND the WebSocket push) ---------------------------------------
// buildStatePayload(req) returns the EXACT object the /api/state poll returns. The only thing it reads off `req`
// is the viewer identity (reqToken) + the play-gate cookie (checked by the caller), so a WS connection can reuse
// it verbatim by passing a lightweight {headers, query} shim built from the upgrade request. This guarantees the
// pushed payload is byte-identical to the polled one — same fields, same anti-bot rules (heat null, crowd hidden
// during choose/OT, no per-door counts), same per-viewer flags (me / champion.you / ot.finalists[].you / chat.mine).
// LOBBY LIVENESS (read-only). Shared engagement fields for the filling/armed screens, derived from data already
// on G + the active config. NONE of this gates a lock or touches escrow; it is pure display:
//   seatsToThreshold : seats remaining to arm the fuse ("N to light the fuse")
//   velocity         : {rate seats/min, fast flag} from the trailing fill samples
//   odds/potAfterRake: a ROUGH, clearly-labelled win-chance + take estimate as the field is known so far. Win
//                      chance ~ 1/(seats so far) as a lower bound (the field only grows), take ~ pot minus rake.
//   myTickets        : how many seats the requester already holds (sharpens their own odds client-side)
function fillLobby(sold, target, pot, tok){
  const v=fillVelocity();
  const thr=(C.engine==='rmfill')?rmThresholdTickets():(C.threshold||0);
  const rakeBps=(_rakeBpsCache!=null)?_rakeBpsCache:500;   // display fallback 5% when the live rate isn't cached yet
  const field=Math.max(1, sold||0);                         // known field so far (a lower bound; it only grows)
  const myTickets = tok ? Object.keys((G&&G.players)||{}).filter(id=>G.players[id].owner===tok).length : 0;
  const potAfterRake=Math.max(0, Math.round((pot||0)*(10000-rakeBps)/10000));
  return {
    seatsToThreshold: Math.max(0, thr-(sold||0)),
    velocity: v,
    odds: {
      // rough single-ticket win chance given the field so far, and the requester's chance with all their tickets.
      winChance: 1/field,
      myWinChance: myTickets>0 ? Math.min(1, myTickets/field) : null,
      myTickets,
      potAfterRake, rakeBps,
      estimate: true                                         // ALWAYS label this an estimate in the UI
    }
  };
}
function buildStatePayload(req){
  // INVARIANT: the raw per-round seed (G.seed / SEED_STORE / ESC_SEED) is NEVER serialized into this payload, and
  // the pre-reveal per-door counts (G.otCounts) are attached ONLY in the OT reveal sub-phase (`sub==='reveal' &&
  // G.otRevealed`). Nothing in this object leaks the seed or pre-reveal door signal to clients.
  if(!G)tick(); const now=Date.now(),tok=reqToken(req),gp=player(tok),reg=REG[tok];
  const myTh=tokenHash(tok);   // used to flag the requester's own chat lines without ever echoing a raw token
  let phase, chamber=null, blind=false, lockIn=0, chooseWindow=19, reveal=null, champion=null, ot=null;
  let fill=null, schedule=null, nextGameIn=0, lobbyEndsIn=0;

  if(MODE==='fill'){
    if(G.phase==='running'){ const info=fillRunInfo(now); phase=info.phase; chamber=info.chamber!=null?info.chamber:null; blind=!!info.blind; lockIn=info.lockIn||0; chooseWindow=info.cwin||15; }
    else if(G.phase==='ended'){ phase='ended'; nextGameIn=Math.max(0,C.resultMs-(now-G.endedAt)); }
    else { phase='filling'; }
    var regTix=Object.keys(REG).reduce((a,t)=>a+(REG[t].active?clampTickets(REG[t].tickets):0),0);
    fill={ state:G.phase, seats:seatCount(), threshold:C.threshold, cap:C.cap, fuseIn:(G.phase==='armed')?Math.max(0,G.fuseEnds-now):null, nextPacking:C.seedBots+regTix,
           lobby: fillLobby(seatCount(), C.cap, seatCount()*ENTRY, tok) };
  } else if(C.engine==='rmfill'){
    // THRESHOLD-FILL: the UI shows fill progress (ticketsSold / target) + grace remaining instead of a wall clock.
    if(G.phase==='playing'){ const info=rmRunInfo(now); phase=info.phase; chamber=info.chamber!=null?info.chamber:null; blind=!!info.blind; lockIn=info.lockIn||0; chooseWindow=info.cwin||Math.round((C.choose||19000)/1000); }
    else if(G.phase==='ended'){ phase='ended'; }
    else if(G.phase==='locking'){ phase='locking'; }   // buy-in closing on-chain; chambers about to start
    else { phase='filling'; }
    fill={ state:G.phase, seats:seatCount(), ticketsSold:(G.ticketsSold||0), threshold:rmThresholdTickets(), target:(C.target||50), cap:C.cap,
           graceIn:(G.graceEnds!=null)?Math.max(0,G.graceEnds-now):null,
           // DYNAMIC GRACE surfaced for the UI: graceMax = the ceiling, graceNow = the (shrinking) window the current
           // fill maps to, so the lobby can show "the fuse burns faster as it fills". Display only; no on-chain tie.
           graceMax:Math.round((C.graceMs!=null?C.graceMs:600000)/1000), graceNow:Math.round(rmGraceMsFor(G.ticketsSold||0)/1000),
           lobby: fillLobby((G.ticketsSold||0), (C.target||50), (realMoney()?((G._onchainPot||0)+(Number(JACKPOT_RVLT)||0)):0), tok) };
  } else {
    const p=clockPhaseAt(now), S=p.S;
    phase=p.phase; chamber=(p.phase==='choose'||p.phase==='reveal')?p.chamber:null; blind=!!p.blind;
    lockIn=p.phase==='choose'?Math.max(0,Math.round(p.lockIn/1000)):0; chooseWindow=p.phase==='choose'?Math.round(p.cwin/1000):0;
    nextGameIn=Math.max(0,S.next-now); lobbyEndsIn=Math.max(0,S.chooseStart[0]-now);
    schedule={ locks:S.locks, chooseStart:S.chooseStart, lobbyEnd:S.chooseStart[0], gameEnd:S.gameEnd, next:S.next };
  }
  // LIVE SUDDEN-DEATH OVERTIME override (fill + rmfill; clock uses the synchronous fallback). When OT is armed the
  // game is a timed CHOOSE/REVEAL loop driven by G.ot* (see otTick). We surface a distinct `overtime` phase plus a
  // tiny `ot` payload: the round number, the live choose/reveal sub-phase + countdown, the OT door count, and the
  // remaining FINALISTS BY NAME. Revealing WHO is left (a handful of names) is intentional drama; it carries NO
  // door-level signal, so DURING AN OT CHOOSE WINDOW door picks stay hidden (heat null, crowd suppressed, no
  // per-door counts) exactly like a normal chamber. The per-door distribution (revealCounts) is attached ONLY in
  // the OT reveal sub-phase (sub==='reveal'), mirroring the normal-chamber reveal — picks are locked, so anti-bot holds.
  if(G && G.ot){
    const sub=G.otPhase||'choose';
    const cd=Math.max(0, Math.round(((G.otPhaseEnds||now)-now)/1000));
    // finalists by name (de-duped per ticket; a wallet with multiple tickets shows each surviving ticket's name).
    const finalists=aliveList().map(([,p])=>({ name:p.name, you:false }));
    // mark which finalists belong to the requester (so the client can spotlight "YOU")
    if(tok){ aliveList().forEach(([id,p],ix)=>{ if(p.owner===tok && finalists[ix]) finalists[ix].you=true; }); }
    phase='overtime'; chamber=null; blind=false;
    lockIn = sub==='choose'?cd:0;
    chooseWindow = Math.round((G.otChooseMs||8000)/1000);
    // during OT reveal, carry the bust so the client can play the big moment + climactic payoff.
    // OT reveal carries the same reveal-only per-door distribution as a normal chamber. The guard is the
    // `sub==='reveal'` check: during an OT CHOOSE window otReveal is null, so no per-door counts are sent.
    const otReveal = (sub==='reveal' && G.otRevealed)
      ? { bust:G.otBust, busted:G.otCaught, survived:(G.otSurvivors!=null?G.otSurvivors:aliveCount()), doors:G.otDoorsN, revealCounts:(G.otCounts||[]).slice() }
      : null;
    ot={ round:(G.otRound||0)+1, phase:sub, countdown:cd, doors:G.otDoorsN,
         chooseMs:G.otChooseMs, revealMs:G.otRevealMs,
         finalists, finalistCount:finalists.length, reveal:otReveal };
  }
  // per-requester champion (you = this account owns a winning ticket)
  if(phase==='ended' && G.champ){ champion=Object.assign({},G.champ,{you: !!(G.champ.owners && tok && G.champ.owners.indexOf(tok)>=0)}); }

  // ENDED-STATE PAYOUT MATH (read-only; surfaced so the win ceremony reads the REAL numbers, never invents them).
  // This mirrors the exact amounts the on-chain settle() uses: pot minus rake = winners' take, split equally among
  // winning tickets. It changes NO money logic — it only exposes values already determined on-chain so the UI can
  // render "Pot N, rake M, you take K" truthfully. `rm` marks whether there is anything to claim (real money vs
  // practice/fake-chip). `kind` tells the client which ceremony to play: win / loss / void / spectator.
  let ended=null;
  if(phase==='ended' && G.champ){
    const rm=realMoney();
    // DISPLAY-ONLY: JACKPOT_RVLT is the ~3s-stale cached jackpot (refreshed on the escrow lifecycle sync, zeroed at
    // settle). NOT refreshed per-request on purpose: buildStatePayload is synchronous and polled up to 120x/10s per
    // client, so an on-chain jackpotRvlt() read here would be hot-polling the RPC. The cache is authoritative enough
    // for the counter; the on-chain pot is the source of truth at settle (TASK 2c: left cached by design, no per-poll RPC).
    const pot = rm ? ((G._onchainPot||0)+(Number(JACKPOT_RVLT)||0)) : seatCount()*ENTRY;   // jackpot folds into the shown pot (no separate label)
    const rakeBps = (_rakeBpsCache!=null) ? _rakeBpsCache : null;
    const rake = (rakeBps!=null) ? pot*rakeBps/10000 : null;         // null => unknown rate; client shows pot-only copy
    const payout = (rake!=null) ? Math.max(0, pot-rake) : null;      // winners' total take (pot minus rake)
    const winnerTix = G.champ.split ? ((G.champ.winners&&G.champ.winners.length)||0) : (G.champ.name?1:0);
    const perWinner = (payout!=null && winnerTix>0) ? payout/winnerTix : payout; // equal split, as on-chain settle()
    const youWin = !!(G.champ.owners && tok && G.champ.owners.indexOf(tok)>=0);
    const voided = !!G.champ.none;                                   // no real winner -> round voids -> refund path
    const myTix = tok ? Object.keys(G.players).filter(id=>G.players[id].owner===tok) : [];
    const mine = myTix.length>0;   // the local viewer actually had a ticket in this round (not a spectator)
    const myAliveTix = myTix.filter(id=>{var p=G.players[id];return p.alive&&!p.left;}).length;
    const kind = voided ? 'void' : (youWin ? 'win' : (mine ? 'loss' : 'spectator'));
    ended={
      kind, realMoney:rm, pot, rakeBps, rake, payout, winnerTix,
      take: youWin ? perWinner : null,                               // what THIS viewer collects (equal split share)
      roundId:(G&&G.roundId)||null,
      // loss/near-miss context, read from the same per-door distribution the reveal already exposes:
      chambersCracked:(G&&G.resolved)?Object.keys(G.resolved).filter(k=>G.resolved[k]).length:0,
      maxChambers:C.maxch, wasOvertime:!!(G&&G._hadOt), myTickets:myTix.length, myAliveTix
    };
  }

  // AGENT-PROOFING (H6): NO per-door signal is ever exposed DURING THE PICK WINDOW. `heat` is all-null at every
  // phase (unchanged), and the only crowd figure during choose is the aggregate committed/alive counter below,
  // which carries no door-level information to optimize against. The per-door count VECTOR is withheld through
  // choose/blind and released ONLY at reveal (see the revealCounts block), by which point all picks are locked,
  // so it leaks nothing a headless client could act on. This keeps it genuinely person-vs-person.
  const heat=(G.routes||[]).map(()=>null);
  const crowd=(phase==='choose')?{committed:aliveList().filter(([,p])=>p.pick!=null).length,alive:aliveCount()}:null;
  // REVEAL (legibility, anti-bot-safe): expose which door busted + how many were caught + a survived aggregate,
  // PLUS the full per-door count vector (revealCounts) so a player can see WHY they lost. Safe because picks are
  // already locked before reveal; this branch is entered ONLY when phase==='reveal', never during choose/blind.
  if(phase==='reveal'&&G.resolved[chamber]){
    const survived=(G.counts||[]).reduce((a,c,i)=>a+(i===G.bust?0:c),0);
    // REVEAL-ONLY per-door distribution (legibility): the full count vector is exposed ONLY here, inside the
    // `phase==='reveal'` branch, so a player can see WHY they lost ("North Wing was packed, busted"). This is
    // anti-bot-safe because every pick is already LOCKED before the reveal phase begins, so the counts leak no
    // signal a headless client could act on. During choose/blind this branch is never entered, so revealCounts
    // stays null (see the top-level `let ... reveal=null`). `heat` remains all-null at every phase (unchanged).
    reveal={bust:G.bust,busted:G.bustN,survived:survived,doors:(G.routes||[]).length,revealCounts:(G.counts||[]).slice()};
  }

  return {
    now, mode:MODE, engine:C.engine, maxChambers:C.maxch, nextGameIn, lobbyEndsIn, fill, schedule,
    phase, chamber, blind, lockIn, chooseWindow, routes:G.routes||[], heat, crowd, ot,
    roundId:(G&&G.roundId)||null,   // current round id, so the client can offer to verify it once settled
    // Sybil policy (surfaced for the UI + sim): a hard per-wallet seat cap; the economy is near zero-sum so a
    // Sybil buys a proportional share of a pot it also funds (it cannot drain the house), the lever is concentration.
    sybil:{ maxTicketsPerWallet:(G&&G._walletCap)||walletCap(), enforce:SYBIL_ENFORCE },
    // runtime economy config surfaced to the UI: the display entry price + the computed per-wallet cap + target.
    econ:{ entryUsd:getCfg().entryUsd, roundTarget:getCfg().roundTarget, walletCap:(G&&G._walletCap)||walletCap() },
    jackpot: JACKPOT_RVLT,   // V5 progressive jackpot (human RVLT) for the UI counter; grows on final-vault rollovers
    rolledOver: !!(G&&G.rollover),   // this round ended in a mutual-bust rollover (client shows the "pot rolls over" ceremony)
    launch: launchState(),   // condition-driven: open === mint sold out OR Halloween cutoff (gate 1 = auto-gated; 0 = always open)
    alive:aliveCount(), total:seatCount(), pot: realMoney()?((G._onchainPot||0)+(Number(JACKPOT_RVLT)||0)):seatCount()*ENTRY,
    me: reg ? (function(){ var ids=tok?Object.keys(G.players).filter(id=>G.players[id].owner===tok):[]; var al=ids.filter(id=>{var p=G.players[id];return p.alive&&!p.left;}).length; var pr=G.players[tok];
      // CREW VIEW (own tickets ONLY): during the choose/blind/reveal window, surface where THIS caller's own EXTRA
      // tickets (the tok+'#k' entities, owner===tok, id!==tok) are currently sitting, so a multi-ticket player can
      // spread their manual pick. STRICT SCOPING: we read entities whose owner is exactly this request's token and
      // never any other player's; we emit only { ticket, door } for the caller's own extras. No other player's pick
      // is ever added to any payload, and this does NOT touch the per-door `heat`/`crowd` (still hidden). Only when
      // the caller owns >1 ticket, and capped at 3 entries (EV-neutral, matches the per-wallet extra model).
      var crew=null;
      if(tok && ids.length>1 && (phase==='choose'||phase==='reveal')){
        crew=[];
        ids.forEach(function(id){
          if(id===tok) return;                                  // skip ticket 1 (that is the player's own primary door = pick above)
          var p=G.players[id]; if(!p||p.owner!==tok) return;    // belt-and-suspenders: must be THIS token's own entity
          if(p.left) return;                                    // a withdrawn ticket is not on a door
          var k=parseInt(String(id).split('#')[1],10);          // entity index k (k>=1 for extras); human ticket label = k+1 (k=1 -> "#2")
          crew.push({ ticket:(Number.isInteger(k)?k+1:ids.indexOf(id)+1), door:(p.pick!=null?p.pick:null), alive:!!(p.alive&&!p.busted) });
        });
        crew.sort(function(a,b){ return a.ticket-b.ticket; });
        crew=crew.slice(0,3);                                   // cap at 3 (safe, EV-neutral)
        if(!crew.length) crew=null;
      }
      return { inGame:ids.length>0, alive:al>0, busted:ids.length>0&&al===0, pick:pr?pr.pick:null, spectator:ids.length===0, pre:reg.pre||null, name:reg.name, tickets:ids.length, ticketsAlive:al, wantTickets:clampTickets(reg.tickets), verified:!!reg.verified, away:!!(pr&&pr.away), crew:crew }; })() : null,
    reveal, champion, ended,
    // chat: strip the stored token hash; emit only a per-request `mine` boolean (no raw token ever leaves the server).
    chat:CHAT.slice(-24).map(m=>({ name:m.name, text:m.text, ts:m.ts, mine: !!(myTh && m.th===myTh) })), history:HISTORY.slice(0,3),
    // real-money context (only when escrow is enabled + on a clock round). buyOpen = the on-chain buy-in window (lobby).
    // Rolling buy-in: `id` is the round a buy-in targets (current lobby OR the next heist), so buy-in is always
    // open. `pot` is the pot you'd be joining; `live` = a heist is running now, so a buy-in pre-books the next one.
    // real-money context (escrow enabled). `id` is the round a buy-in targets so buy-in is always open:
    //   clock  -> current lobby OR next heist (G._buyRound)
    //   rmfill -> the current round while it fills, else the pre-opened next round (RM_BUY)
    // For rmfill there is no wall-clock `startsIn`; progress is ticketsSold/target (see the `fill` block above).
    escrow: escrow.isOn() ? (
      C.engine==='rmfill'
        ? { on:true, id:(G&&RM_BUY!=null?String(RM_BUY):null), entry:escrow.entryWei(),
            buyOpen:(G&&G.phase==='filling'), live:(phase!=='filling'), pot:(realMoney()?(G._buyPot||0):0),
            ticketsSold:(G&&G.ticketsSold||0), target:(C.target||50), graceIn:(G&&G.graceEnds!=null?Math.max(0,G.graceEnds-now):null),
            paid:(realMoney()?Object.values(G.players).filter(p=>!p.left&&typeof p.owner==='string'&&p.owner.startsWith('w:')).length:0) }
        : { on:true, id:(C.engine==='clock'&&G?String(G._buyRound||G.start):null), entry:escrow.entryWei(), buyOpen:realMoney(), live:(phase!=='lobby'), pot:(realMoney()?(G._buyPot||0):0), startsIn:(realMoney()&&G._buyRound?Math.max(0,G._buyRound-now):0), paid:(realMoney()?Object.values(G.players).filter(p=>!p.left&&typeof p.owner==='string'&&p.owner.startsWith('w:')).length:0) }
    ) : { on:false }
  };
}
// HTTP poll path — UNCHANGED behaviour: still gated upstream (the global play-gate middleware), still serves the
// identical JSON. This is the fallback the WS layer degrades to, so it must keep working exactly as before.
app.get('/api/state',(req,res)=>{ if(!rl(rlKey(req,'state'),120,10000)) return res.status(429).json({error:'slow down'}); try{ stampSeen(reqToken(req)); }catch(_){} res.json(buildStatePayload(req)); });
// Backup serve-guard (defense-in-depth): never ship a stray .bak/promote-bak/etc under a served dir to a browser.
const BAK_GUARD = /\.(bak|prexcp-bak|promote-bak|pre[-.][a-z0-9]*bak)(\b|$)/i;
app.use((req,res,next)=>{ const p=req.path||''; if(BAK_GUARD.test(p)||p.includes('bak-')||p.includes('_bak')) return res.status(404).end(); next(); });
app.use(express.static(path.join(__dirname,'public')));

// =============================================================================================================
// REAL-TIME PUSH LAYER (WebSocket) — ADDITIVE. The HTTP poll above is untouched and remains the fallback.
//
//  RULE 1 (skill): the WS server rides the SAME http server + process.env.PORT. We create ONE http.Server from
//  the Express app and attach the WebSocketServer to it (no second port — the platform proxy only knows the one
//  port it allocated, and forwards WS upgrades under /pub/{group}/{name}/ to it exactly like HTTP).
//
//  Path: the proxy forwards the upgrade with the /pub/main/vaultstandoff-dev/ prefix stripped, so from this
//  server's view the upgrade path is `/socket` (plus the ?token=... query the client appends). We accept any
//  path ending in `/socket` to be tolerant of how the proxy presents it (verify after restart — see report).
//
//  AUTH: a WS connection must clear the SAME play-gate as GET /api/state. The upgrade request carries the
//  browser's cookies (so the vs_gate cookie rides along) — we reuse gateOk(req) on the raw upgrade request and
//  reject (close 1008) anything that wouldn't have been allowed to poll. (M-1) The viewer token is NO LONGER on
//  the URL query (it leaked into logs); it arrives in the first {type:'hello', token} message, is stored on
//  ws._vsToken, and the per-viewer serializer reads it from there. Before hello we serve a public snapshot.
//
//  PER-PLAYER vs SHARED: the payload has per-viewer fields (me, champion.you, ot.finalists[].you, chat[].mine),
//  so a single shared snapshot can't be reused verbatim across viewers. Trade-off chosen: SERIALIZE PER
//  CONNECTION, but ONLY ON CHANGE. A cheap public "signature" (phase/chamber/OT round+subphase/pot/seats/
//  roundId/reveal/champion/chat-length) is diffed once per second; when it changes we re-serialize buildStatePayload
//  per connected client and push a {type:'state'} to each. Between changes we push a tiny shared {type:'tick'}
//  countdown so timers stay smooth without re-serializing the heavy state. Full re-serialization therefore only
//  happens on a real event, and scale here is tens of players per room, so per-connection serialize-on-change is
//  the simpler, obviously-correct option vs. a shared-snapshot + per-player-overlay merge.
// =============================================================================================================
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: undefined });   // we gate path ourselves in verifyClient-style handling below

// Build a minimal req-shim from a raw upgrade request so we can reuse reqToken()/gateOk() unchanged.
function wsReqShim(upgradeReq){
  let q={};
  try{ const u=new URL(upgradeReq.url, 'http://x'); u.searchParams.forEach((v,k)=>{ q[k]=v; }); }catch(_){ }
  return { headers: upgradeReq.headers || {}, query: q, body: null };
}

wss.on('connection', (ws, upgradeReq) => {
  const shim = wsReqShim(upgradeReq);
  // AUTH: same play-gate as the HTTP poll. The vs_gate COOKIE rides the upgrade request, so gateOk(shim) is the
  // sole authenticator here. If this viewer couldn't GET /api/state, they don't get a socket. (M-1: we no longer
  // read a viewer token off the URL query — it's not there anymore. The gate is unchanged/not weakened.)
  if(!gateOk(shim)){ try{ ws.close(1008,'gate required'); }catch(_){ } return; }
  ws._vsShim = shim;          // carries {headers(cookies)} only — the per-viewer token arrives via {type:'hello'}
  ws._vsToken = null;         // M-1: set from the {type:'hello'} message, NOT from the URL query
  ws._vsHello = false;        // until hello is processed we only send a public (no per-player) snapshot
  ws._vsAlive = true;
  ws._vsMsgWin = 0; ws._vsMsgCount = 0;   // M-2: per-socket sliding 1s message counter
  ws.on('pong', ()=>{ ws._vsAlive=true; });
  ws.on('message', (raw)=>{
    // M-2: PER-CONNECTION FLOOD LIMIT + MAX MESSAGE SIZE (pre-parse). The protocol messages (hello/resync/
    // subscribe) are tiny, so cap raw frames at 4 KB and reject bursts above ~10 msgs/sec per socket. A size
    // breach drops the frame silently; a sustained rate breach closes the socket (1008). This runs BEFORE
    // JSON.parse so a huge or rapid stream can never reach the parser. Unknown message types are still ignored.
    try { if(raw && raw.length>4096) return; } catch(_){ return; }   // oversized frame: drop, don't parse
    const nowMs=Date.now();
    if(nowMs - ws._vsMsgWin >= 1000){ ws._vsMsgWin=nowMs; ws._vsMsgCount=0; }
    if(++ws._vsMsgCount > 10){ try{ ws.close(1008,'rate'); }catch(_){ } return; }
    // Minimal protocol: the client sends {type:'hello', token} (also on every reconnect) / {type:'resync'} to
    // request an immediate full snapshot. The per-viewer token is carried in the hello message (M-1).
    let m=null; try{ m=JSON.parse(String(raw)); }catch(_){ return; }
    if(!m) return;
    if(m.type==='hello' || m.type==='resync' || m.type==='subscribe'){
      // WS HELLO TOKEN VALIDATION: a viewer may only request the private per-player view of a token they actually
      // own. Accept the token ONLY if it exists in REG, and for a `w:` wallet token ONLY if it is SIWE-verified;
      // otherwise treat this socket as an anonymous spectator (public snapshot, no per-player me/you fields). This
      // stops a socket from naming another player's token to read their private view.
      if(typeof m.token==='string' && m.token){
        const r=REG[m.token];
        const okWallet = (m.token.indexOf('w:')===0) ? !!(r&&r.verified) : true;
        if(r && okWallet){ ws._vsToken=m.token; ws._vsHello=true; }
        else { ws._vsToken=null; ws._vsHello=true; }   // identified but not valid -> public snapshot only
      } else { ws._vsToken=null; ws._vsHello=true; }
      sendStateTo(ws);
    }
  });
  ws.on('error', ()=>{});
  // On connect: immediate snapshot. Until hello arrives we withhold per-player fields (public snapshot only),
  // then the hello handler above pushes the full per-viewer state once the token is known.
  sendStateTo(ws);
});

// Serialize + send a {type:'state'} snapshot to a single connection. Per-viewer identity comes from ws._vsToken
// (delivered via {type:'hello'}); before hello we send a PUBLIC snapshot (no token) so per-player fields resolve
// only once the viewer has identified itself. The gate cookie on the upgrade already authorized the socket.
function sendStateTo(ws){
  if(!ws || ws.readyState!==ws.OPEN) return;
  const base = ws._vsShim || { headers:{} };
  // Build a shim whose token is the per-viewer hello token (or absent -> public snapshot). buildStatePayload
  // reads the viewer token via reqToken(), which checks the x-vs-token header, so we inject it there.
  const shim = { headers: Object.assign({}, base.headers||{}), query:{}, body:null };
  if(ws._vsHello && ws._vsToken){ shim.headers = Object.assign({}, shim.headers, { 'x-vs-token': ws._vsToken }); }
  else { if(shim.headers) delete shim.headers['x-vs-token']; }   // pre-hello: no per-player identity -> public
  let payload; try{ payload = buildStatePayload(shim); }catch(_){ return; }
  try{ ws.send(JSON.stringify({ type:'state', state:payload })); }catch(_){ }
}

// Broadcast a full state snapshot to every live client (re-serialized per connection — only called on change).
function broadcastState(){
  wss.clients.forEach(ws=>{ if(ws.readyState===ws.OPEN) sendStateTo(ws); });
}

// Cheap public signature of "something meaningful changed" — covers buy-ins (pot/seats), phase transitions
// (filling->armed->choose->reveal->overtime->ended), each chamber + OT round/subphase change, and round rollover.
// Reading these mirrors exactly what the serializer branches on, so any change it would render is caught here.
function stateSignature(){
  if(!G) return 'nog';
  const now=Date.now();
  let phase='', chamber='', ot='';
  try{
    if(MODE==='fill'){
      if(G.phase==='running'){ const i=fillRunInfo(now); phase='r:'+i.phase; chamber=String(i.chamber); }
      else phase=G.phase;
    } else if(C.engine==='rmfill'){
      if(G.phase==='playing'){ const i=rmRunInfo(now); phase='p:'+i.phase; chamber=String(i.chamber); }
      else phase=G.phase;
    } else {
      const p=clockPhaseAt(now); phase='c:'+p.phase; chamber=String(p.chamber!=null?p.chamber:'');
    }
  }catch(_){ phase='err'; }
  // L-1: include the OT round + per-door catch counts so two reveals that bust the same door with the same catch
  // count still change the signature (otherwise the distribution bars wouldn't re-render until the 10s poll).
  // INVARIANT: the raw seed (G.seed / SEED_STORE / ESC_SEED) is NEVER referenced here, and the per-door counts
  // (G.otCounts) are folded into the signature ONLY in the OT reveal sub-phase — mirroring buildStatePayload's
  // `sub==='reveal' && G.otRevealed` gate — so pre-reveal door signal can never influence a broadcast. The
  // choose->reveal transition still fires a push via the OT round, sub-phase, and otRevealed flag below.
  if(G.ot){
    const otSub=G.otPhase||'';
    const otReveal = (otSub==='reveal' && G.otRevealed);
    ot='ot:'+(G.otRound||0)+':'+otSub+':'+(G.otRevealed?1:0)+':'+(G.otBust!=null?G.otBust:'')+':'+(otReveal?((G.otCounts||[]).join(',')):'');
  }
  const pot = realMoney()?(G._onchainPot||G._buyPot||0):(seatCount()*ENTRY);
  const champ = (G.champ?('W'+((G.champ.owners&&G.champ.owners.length)||0)):'');
  const rev = (G.bust!=null?('b'+G.bust+':'+(G.bustN||0)):'');
  return [G.roundId, G.phase, phase, chamber, ot, seatCount(), (G.ticketsSold||0), pot, champ, rev, CHAT.length].join('|');
}

let _wsLastSig = null;
// Push loop: runs once per second AFTER the game tick. If the signature changed, push a heavy full state to all;
// otherwise push a tiny shared countdown tick so timers animate smoothly between real events. Fully isolated from
// the game loop — it only READS state, never mutates it, so it can't affect gameplay even if it throws.
function wsPushLoop(){
  try{
    if(!wss.clients.size) return;                 // no subscribers → nothing to do
    const sig = stateSignature();
    if(sig !== _wsLastSig){ _wsLastSig = sig; broadcastState(); }
    else {
      const tickMsg = JSON.stringify({ type:'tick', now:Date.now() });
      wss.clients.forEach(ws=>{ if(ws.readyState===ws.OPEN){ try{ ws.send(tickMsg); }catch(_){ } } });
    }
  }catch(_){ /* never let the push loop crash the process */ }
}
setInterval(wsPushLoop, 1000);

// Explicit immediate nudge for sub-second interactions that don't move the 1s signature but should feel instant:
// a new chat line and a door pick. Safe to call anywhere; it just re-broadcasts the current state on the next microtask.
let _nudgeQueued=false;
function nudgeState(){ if(_nudgeQueued)return; _nudgeQueued=true; setImmediate(()=>{ _nudgeQueued=false; _wsLastSig=stateSignature(); try{ broadcastState(); }catch(_){ } }); }
// expose for the few mutating endpoints that want instant feedback (chat/pick)
global.__vsNudge = nudgeState;

// Liveness: terminate dead sockets so clients list stays clean.
setInterval(()=>{ wss.clients.forEach(ws=>{ if(ws._vsAlive===false){ try{ws.terminate();}catch(_){ } return; } ws._vsAlive=false; try{ ws.ping(); }catch(_){ } }); }, 30000);

// Advertise our assigned loopback PORT to a sibling file so the Vault Robbers hub can reverse-proxy us under
// /play/v3 directly on loopback (no dashboard hop). Non-secret: just a port number in our own source dir.
try{ fs.writeFileSync(path.join(__dirname,'.vs-port'), String(process.env.PORT||'')); }catch(_){}
server.listen(process.env.PORT,()=>console.log('[vaultstandoff-dev] mode='+MODE+' on',process.env.PORT,'(+WS push)'));
// #224 PEG BOOT WARMUP: proactively prime the peg TWAP + memoized entry at startup (best-effort, bounded) so the
// FIRST real round after a (re)start prices off a warm multi-sample median instead of one cold quote. Two spaced
// samples feed the TWAP; the final usdToRvltWei memoizes the entry. Combined with the persisted last-known-good seed
// (PEG_FILE), this closes the cold-start pricing window. Fully non-fatal; the usual lazy per-round path still runs.
if(escrow.isOn()){ (async()=>{ try{
  const u=(getCfg().entryUsd)||10;
  await pegPriceUsdPerRvlt(u);
  await new Promise(r=>setTimeout(r,2500));
  await pegPriceUsdPerRvlt(u);
  const w=await usdToRvltWei(u);
  console.log('[vaultstandoff-dev] PEG boot warmup done (twap primed'+(w!=null?', entry='+(w/10n**18n)+' RVLT':'')+')');
}catch(_){} })(); }
// Boot assertion: the EIP-712 domain constants served by /api/autobuy/params must recompute to the on-chain
// domainSeparatorV4(). If they ever diverge (e.g. a redeploy under a different name/version), log it LOUDLY so
// the auto-buy signing material is never silently unsignable. Non-fatal (read-only, best-effort).
if (escrow.isOn()) { escrow.assertDomain().then(r => {
  if (r && r.ok) console.log('[vaultstandoff-dev] EIP-712 AutoBuy domain OK (name/version match on-chain domainSeparator).');
  else console.error('[vaultstandoff-dev] WARNING: EIP-712 AutoBuy domain MISMATCH — /api/autobuy/params may serve an unsignable domain. detail=', r);
}).catch(()=>{}); }
// GAP-B: ENV / ON-CHAIN PARITY SELF-CHECK. Mainnet-only (the escrow module no-ops on testnet). Once the contract
// is reachable, assert token()==configured RVLT and settlementSigner()==our signer, and log rake/cap for operator
// confirmation. A DEFINITIVE token/signer mismatch is fatal (exit 1) so the server never settles against the wrong
// token or with a key the contract won't accept; a transient RPC error only warns (so a network blip can't brick a
// restart); rake/cap differences are logged loudly but non-fatal.
if (escrow.isOn()) { escrow.parityCheck().then(r => {
  if (r && r.ok) {
    console.log('[vaultstandoff-dev] parity OK (token + settlementSigner match config). on-chain reads:', r.reads||{});
  } else if (r && r.fatal) {
    console.error('[vaultstandoff-dev] FATAL (GAP-B): env/on-chain parity MISMATCH — ' + (r.reason||'') + '. Refusing to go live.');
    process.exit(1);
  } else {
    console.warn('[vaultstandoff-dev] WARNING (GAP-B): parity not verified — ' + (r && r.reason || 'unknown') + '. Will proceed (non-fatal); re-check the environment.');
  }
}).catch(e => { console.warn('[vaultstandoff-dev] WARNING (GAP-B): parity check threw (non-fatal):', e && e.message || e); }); }
