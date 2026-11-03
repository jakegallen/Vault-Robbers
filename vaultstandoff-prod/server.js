// THE VAULT STANDOFF, Phase 1 MVP (server-authoritative, in-memory, FAKE CHIPS, no chain).
// Two cadence engines:
//   FILL (default) = demand-driven. Seats fill toward a cap; once the majority threshold is
//                    crossed a fuse arms; when the fuse ends (or the cap fills) the heist runs
//                    with whoever bought in. Runs more games, feels alive.
//   CLOCK          = fixed schedule (dev fast / compressed daily / real daily), switchable.
// Final chamber = THE SPLIT. Persistent login, prechoose (buy in, set path, leave, come back), chat.
// DEFENSE-IN-DEPTH (prod-in-main): this artifact runs in the `main` group, whose env also holds unrelated privileged
// secrets. The game needs ONLY its own VS_* / STANDOFF_SIGNER / VS_RELAY_PK vars, so at the very first line we delete
// every other sensitive key from process.env — before escrow.js or any other module can read them. This shrinks the
// blast radius to the game's own bounded keys if the process were ever compromised. (The owner/deployer key was also
// removed from the group env; this is additive.)
// ALLOWLIST (not a denylist): delete EVERY env key the game does not explicitly need, so any secret ever added to the
// main group in future (DASHBOARD_TOKEN, new API keys, etc.) is removed on boot regardless of its name. Keeps only the
// game's own vars (VS_*, STANDOFF_SIGNER, RELAY_API_KEY) + standard runtime vars. Runs before require('./escrow').
(function(){
  const KEEP = new Set(['Helius','Alchemy','STANDOFF_SIGNER','RELAY_API_KEY','PORT','PATH','HOME','USER','LOGNAME','SHELL','PWD','OLDPWD','HOSTNAME','HOST','LANG','TERM','TZ','TMPDIR','TMP','TEMP','SHLVL','_','COLORTERM','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','http_proxy','https_proxy','no_proxy']);
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('VS_') || k.startsWith('NODE_') || k.startsWith('npm_') || k.startsWith('LC_') || KEEP.has(k)) continue;
    try { delete process.env[k]; } catch (_e) {}
  }
})();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');   // real-time push layer (additive; the HTTP poll stays the fallback)
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { verifyMessage, keccak256, toUtf8Bytes } = require('ethers');   // H7: server-side wallet-signature (SIWE-style) verification
const escrow = require('./escrow');            // on-chain buy-in escrow + settlement (Option D); inert unless VS_ESCROW=on
const robbers = require('./robbers');          // Vault Robbers NFT utility: per-heist airdrop TBA reads + claim calldata (read-only; owner signs)
const app = express();

// FIX 2: PROCESS-LEVEL ASYNC GUARDS. This is a LIVE real-money game; a single unhandled promise rejection or an
// uncaught synchronous throw from any background path (an RPC socket drop, a Relay fetch, a stray await) would
// otherwise crash the whole process mid-round (the same hardening vault-explorer got). LOG-AND-CONTINUE: we do NOT
// process.exit here — the game loop + the settle-watcher + the payout keeper are all restart-resilient (seeds, proofs,
// champions and auto-buy state are persisted), so exiting mid-round is strictly worse than logging and letting the
// existing per-tick try/catch guards recover. A genuinely fatal boot error still surfaces via its own explicit exit.
process.on('unhandledRejection', e => { try { console.error('[vault-standoff] unhandledRejection (logged, not fatal):', e && (e.stack || e.message || e)); } catch (_) {} });
process.on('uncaughtException', e => { try { console.error('[vault-standoff] uncaughtException (logged, not fatal):', e && (e.stack || e.message || e)); } catch (_) {} });

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
// On 'exit' (already-terminating) flush synchronously. On SIGINT/SIGTERM flush THEN re-raise the default behavior
// (process.exit) — a bare signal handler that only flushes would otherwise SUPPRESS the default termination, so we
// must exit explicitly. Only attach the signal handlers once; 'exit' alone can't run async but our flush is sync.
try{ process.on('exit', ()=>{ flushAllDebounced(); }); }catch(_){}
['SIGINT','SIGTERM'].forEach(ev=>{ try{ process.on(ev, ()=>{ flushAllDebounced(); process.exit(0); }); }catch(_){} });
// SEED-AT-REST ENCRYPTION (SEC fix): a round's committed seed determines every outcome and MUST stay secret until
// it is revealed at settle. It is held in memory in plaintext for the running game, but PERSISTED ENCRYPTED
// (AES-256-GCM) so that reading seeds.json off disk (or a backup) alone cannot reveal a not-yet-settled round's
// result. The encryption key is DERIVED from an existing sealed env secret (VS_SEED_KEY, else the escrow signer
// key, else the admin token) with a domain tag and is NEVER written to disk. The public `hash` (committed
// on-chain) stays plaintext. Any legacy plaintext `seed` entries are re-encrypted on boot. NOTE: the key must be
// stable across restarts (it is: all three sources are sealed env, constant per deploy); rotating that secret
// makes pre-rotation seeds undecryptable, acceptable since seeds are short-lived (settled within minutes).
function _seedKeyMaterial(){ return String(process.env.VS_SEED_KEY||process.env.VS_ESCROW_SIGNER_PK||process.env.VS_ADMIN_TOKEN||''); }
let _seedEncKey=null;
function seedEncKey(){ if(_seedEncKey) return _seedEncKey; _seedEncKey=crypto.createHash('sha256').update(_seedKeyMaterial()+':vs-seed-at-rest-v1').digest(); return _seedEncKey; }
function encryptSeed(seed){ try{ const iv=crypto.randomBytes(12); const c=crypto.createCipheriv('aes-256-gcm',seedEncKey(),iv); const ct=Buffer.concat([c.update(String(seed),'utf8'),c.final()]); return 'v1:'+iv.toString('hex')+':'+ct.toString('hex')+':'+c.getAuthTag().toString('hex'); }catch(_){ return null; } }
function decryptSeed(enc){ try{ if(typeof enc!=='string'||enc.slice(0,3)!=='v1:') return null; const p=enc.split(':'); const d=crypto.createDecipheriv('aes-256-gcm',seedEncKey(),Buffer.from(p[1],'hex')); d.setAuthTag(Buffer.from(p[3],'hex')); return Buffer.concat([d.update(Buffer.from(p[2],'hex')),d.final()]).toString('utf8'); }catch(_){ return null; } }
// On-disk shape is { [roundId]: { encSeed, hash } }; in-memory SEED_STORE holds { seed, hash } (plaintext seed is MEMORY-ONLY).
function _seedDiskSnapshot(){ const out={}; for(const k in SEED_STORE){ const r=SEED_STORE[k]; if(!r) continue; const enc=(r.seed!=null)?encryptSeed(r.seed):(r.encSeed||null); out[k]=enc?{encSeed:enc,hash:r.hash}:{hash:r.hash}; } return out; }
function saveSeeds(){ saveJsonAtomic(SEED_FILE, _seedDiskSnapshot()); }
const _SEED_RAW = loadJson(SEED_FILE, {});
const SEED_STORE = {};
(function _loadSeeds(){ let hadPlain=false; for(const k in _SEED_RAW){ const r=_SEED_RAW[k]; if(!r) continue;
  if(r.seed!=null){ SEED_STORE[k]={seed:r.seed,hash:r.hash}; hadPlain=true; }        // legacy plaintext -> re-encrypted on save below
  else if(r.encSeed){ const s=decryptSeed(r.encSeed); if(s==null) console.error('[vault-standoff] WARN: seed decrypt FAILED for round '+k+' (encryption key material changed?) — this round can no longer settle and will VOID/refund; verify VS_SEED_KEY/VS_ESCROW_SIGNER_PK/VS_ADMIN_TOKEN are stable'); SEED_STORE[k]={seed:(s!=null?s:null),hash:r.hash}; }
  else { SEED_STORE[k]={seed:null,hash:r.hash}; } }
  if(hadPlain){ try{ saveSeeds(); console.log('[vault-standoff] migrated plaintext seeds.json -> encrypted-at-rest'); }catch(_){} }
})();
const PROOF_STORE = loadJson(PROOF_FILE, {});   // persisted settled-round proofs
// SEC-1: OFF-CHAIN SIGNED SEED PRE-COMMIT store. The moment a round's seed is fixed at OPEN we create a ONE-TIME,
// idempotent signed commitment to keccak256(seed) + the server openedAt, BEFORE buy-in opens, so the operator is
// cryptographically bound to the seed before it can see the roster (closes the grind/re-roll-to-favor-a-wallet
// gap). Only the HASH + openedAt + signer + signature are stored here — NEVER the raw seed (the seed stays in the
// encrypted SEED_STORE and is revealed only at settle, exactly as before). Persisted to disk so the commitment
// survives a restart and can be served for past rounds. Shape: { [roundId]: { seedHash, openedAt, signer, sig,
// message, chainId, escrow } }. Non-money-critical to WRITE promptly (the binding is the signature over openedAt,
// which is fixed at first creation), but we persist synchronously so a restart never loses the only commitment.
const PRECOMMIT_FILE = path.join(STORE_DIR, 'precommit.json');
const PRECOMMIT_STORE = loadJson(PRECOMMIT_FILE, {});
function savePrecommit(){ saveJsonAtomic(PRECOMMIT_FILE, PRECOMMIT_STORE); }
function getPrecommit(roundId){ return PRECOMMIT_STORE[String(roundId)] || null; }
// Idempotent: create the signed pre-commit for a round EXACTLY ONCE (at open, when the seed is fixed), reusing the
// existing record on any later call (and across restarts). `hash` is keccak256(seed) — the SAME value committed
// on-chain at lock. Degrades gracefully: if signing is unavailable (no key on testnet), it logs once and returns
// null WITHOUT blocking the round (the seed + on-chain flow are untouched). Never logs the key or the raw seed.
async function ensurePrecommit(roundId, hash){
  const k=String(roundId);
  const existing=PRECOMMIT_STORE[k];
  if(existing && existing.sig) return existing;            // one binding commitment per round — never regenerate
  if(!hash) return null;
  // SAFETY ASSERT: if a pre-commit somehow exists for a DIFFERENT hash than the seed now being bound, that is a bug
  // or tamper (the seed must be immutable once fixed). Log loudly and keep the ORIGINAL commitment (never re-bind).
  if(existing && existing.seedHash && String(existing.seedHash).toLowerCase() !== String(hash).toLowerCase()){
    console.error('[vault-standoff] SEC-1 WARN: pre-commit seedHash mismatch for round '+k+' (stored '+existing.seedHash+' != current '+hash+') — keeping the original commitment, NOT re-binding');
    return existing;
  }
  const openedAt = (existing && existing.openedAt) ? existing.openedAt : Date.now();   // fix openedAt once; reuse on retry
  let pc=null;
  try { pc = await escrow.signPrecommit(k, hash, openedAt); } catch(_){ pc=null; }
  if(!pc){
    // Signing unavailable (e.g. no settlement key on a disabled testnet). Do NOT block the round; record only once
    // that the pre-commit is unavailable so the log isn't spammed every tick, and let the round open normally.
    if(!existing){ console.warn('[vault-standoff] SEC-1: seed pre-commit unavailable for round '+k+' (no signer key?) — round opens WITHOUT a published pre-commit (degraded, non-blocking)'); PRECOMMIT_STORE[k]={ seedHash:String(hash).toLowerCase(), openedAt, signer:null, sig:null, unavailable:true }; savePrecommit(); }
    return existing||PRECOMMIT_STORE[k];
  }
  PRECOMMIT_STORE[k]=pc; savePrecommit();                  // persist the signed binding BEFORE buy-in proceeds
  return pc;
}
function persistSeed(roundId, seed, hash){ SEED_STORE[String(roundId)] = { seed, hash }; saveSeeds(); }
function getSeed(roundId){ const r = SEED_STORE[String(roundId)]; return r ? r.seed : null; }
// Return (generating + persisting once) the committed {seed,hash} for a round. This is the SINGLE source of
// truth for a round's seed: the game is driven by `seed` and the on-chain commit uses `hash`, so the revealed
// seed at settle always matches the committed hash. Persisted (encrypted) to disk so a restart can still settle.
// SEC-1: the instant the seed is first fixed we also fire-and-forget the idempotent signed PRE-COMMIT (hash only),
// so /proof can publish the operator's binding to keccak256(seed) BEFORE any buy-in. ensurePrecommit is async +
// idempotent; we don't await it here (ensureRoundSeed is called from sync + hot paths), it self-persists and
// reuses on every subsequent call. Signing failure degrades gracefully inside ensurePrecommit (round still opens).
function ensureRoundSeed(roundId){ const k=String(roundId); let r=SEED_STORE[k]; if(!r){ const s=escrow.newSeed(); r={seed:s.seed,hash:s.hash}; SEED_STORE[k]=r; saveSeeds(); } if(!PRECOMMIT_STORE[k]){ Promise.resolve().then(()=>ensurePrecommit(k, r.hash)).catch(()=>{}); } return r; }
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
const CHALLENGE_SEC = 7200;                    // contract challenge window (mainnet ESCROW_CHALLENGE=7200s = 2h); keeper reads claimAtOf() authoritatively and this is only the fallback estimate when that read fails. Set to the real mainnet window so a transient RPC blip can never schedule an auto-payout early (was 3600, stale after the challenge window was raised to 2h)
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
// GAS DRIP LEDGER (money-path, anti-farming): records each wallet the relayer has dripped native 4663 gas to, so
// we refuse a second drip to the same wallet within a long window. Persisted (owner-only store) so a restart can't
// reset the ledger and let a wallet farm a second drip. { [addr(lower)]: { ts, wei, tx } }. Pruned to a bounded age.
const GASDRIP_FILE = path.join(STORE_DIR, 'gas-drip.json');
const GASDRIP_STORE = loadJson(GASDRIP_FILE, {});
function saveGasDrip(){ try{ saveJsonAtomic(GASDRIP_FILE, GASDRIP_STORE); }catch(_){} }
// GAS DRIP BUDGET (per wallet, rolling 24h). NOT a single-shot: a legit player who comes back later the same day and
// has already spent their tiny drip on an approve would otherwise be stuck at zero gas for 24h (the "worked before,
// not now" trap). Instead we allow repeat TOP-UPS (dripNativeTo already sends NOTHING when the wallet is still funded,
// so a drip only fires when genuinely short) but cap the TOTAL dripped per wallet per 24h + enforce a short minimum
// interval. Each drip is ~0.00002 native (~$0.05), so the daily cap is a few cents per wallet: cheap for players,
// bounded against farming. The global rolling-hour cap + per-IP limit + relayer reserve guard remain as outer bounds.
const GAS_DRIP_WINDOW_MS = 24*3600*1000;            // rolling budget window
const GAS_DRIP_MIN_INTERVAL_MS = 20*1000;           // anti double-submit (a real spend between drips takes far longer)
const GAS_DRIP_DAILY_MULT = Math.max(1, parseInt(process.env.VS_GAS_DRIP_DAILY_MULT||'60',10)||60);  // how many base drips/day/wallet (raised 12->60: owner subsidizes gas liberally; each drip ~$0.001, global/hr + reserve guards are the real ceiling)
function _dripBaseWei(){ try{ const c=escrow.gasDripConfig&&escrow.gasDripConfig(); if(c&&c.wei) return BigInt(c.wei); }catch(_){} return 20000000000000n; }  // fallback 0.00002
function _dripEvents(a){ const r=GASDRIP_STORE[a]; if(!r) return []; if(Array.isArray(r.events)) return r.events; return [{ts:r.ts||0, wei:r.wei||'0'}]; }  // back-compat w/ old {ts,wei,tx}
function _dripWindowWei(a){ const cut=Date.now()-GAS_DRIP_WINDOW_MS; let s=0n; for(const e of _dripEvents(a)){ if((e.ts||0)>=cut){ try{ s+=BigInt(e.wei||'0'); }catch(_){} } } return s; }
// Returns {ok:true} if another drip is allowed, else {ok:false, reason}. Only gates; the actual send is skipped by
// dripNativeTo when the wallet is already funded, so a funded caller never consumes budget (handler records nothing).
function gasDripCheck(addr){ try{
  const a=String(addr||'').toLowerCase(); const r=GASDRIP_STORE[a]; const now=Date.now();
  if(r && (now-(r.ts||0) < GAS_DRIP_MIN_INTERVAL_MS)) return { ok:false, reason:'just topped up, give it a few seconds then try again' };
  const used=_dripWindowWei(a); const cap=_dripBaseWei()*BigInt(GAS_DRIP_DAILY_MULT);
  if(used + _dripBaseWei() > cap) return { ok:false, reason:'daily gas top-up limit reached for this wallet, add a little Robinhood Chain gas manually' };
  return { ok:true };
}catch(_){ return { ok:true }; } }
function recordGasDrip(addr, wei, tx){ try{
  const a=String(addr||'').toLowerCase(); if(!/^0x[0-9a-f]{40}$/.test(a)) return;
  const prev=GASDRIP_STORE[a];
  let events = Array.isArray(prev&&prev.events) ? prev.events.slice() : (prev ? [{ts:prev.ts||0, wei:String(prev.wei||'0')}] : []);
  events.push({ ts:Date.now(), wei:String(wei||'0') });
  const wcut=Date.now()-GAS_DRIP_WINDOW_MS; events = events.filter(e=>(e.ts||0)>=wcut);   // keep only the rolling window
  GASDRIP_STORE[a]={ ts:Date.now(), wei:String(wei||''), tx:String(tx||''), events };
  const cut=Date.now()-7*24*3600*1000; for(const k of Object.keys(GASDRIP_STORE)){ if((GASDRIP_STORE[k].ts||0)<cut) delete GASDRIP_STORE[k]; }  // bounded: drop >7d old
  saveGasDrip();
}catch(_){} }
// GLOBAL drip cap (rolling hour): a hard ceiling on how many drips fire across ALL wallets, as a second line of
// defense on relayer drain even if per-wallet + per-IP limits were somehow evaded. Resets on the hour.
let _gasDripHour = { h: 0, n: 0 };
const GAS_DRIP_GLOBAL_PER_HOUR = Math.max(1, parseInt(process.env.VS_GAS_DRIP_GLOBAL_PER_HOUR||'200',10)||200);
function gasDripGlobalOk(){ const h=Math.floor(Date.now()/3600000); if(_gasDripHour.h!==h) _gasDripHour={h,n:0}; return _gasDripHour.n < GAS_DRIP_GLOBAL_PER_HOUR; }
function gasDripGlobalBump(){ const h=Math.floor(Date.now()/3600000); if(_gasDripHour.h!==h) _gasDripHour={h,n:0}; _gasDripHour.n++; }
// SEAT CANDIDATES (Item B): per-round set of buyer ADDRESSES that have signaled intent to pay this round (via
// /api/relay/preflight's `user`, /api/relay/entry-quote's `user`, or the post-buy /api/relay/seat call). This is
// ONLY a hint list of addresses to RE-CHECK on-chain; NOTHING is seated from it without escrow.ticketsOf>0. Persisted
// to disk so a restart can re-seat the live round's paid buyers (closes the restart-orphan gap). Bounded + pruned.
const SEATCAND_FILE = path.join(STORE_DIR, 'seat-candidates.json');   // { [roundId]: { addrs:[0x..lower], ts } }
const SEATCAND_STORE = loadJson(SEATCAND_FILE, {});
const _saveSeatCand = makeDebouncedSaver(()=>saveJsonAtomic(SEATCAND_FILE, SEATCAND_STORE), 1500);
// add a candidate buyer address for a round (lowercased, validated). No seating happens here - only a note to re-check.
function addSeatCandidate(roundId, addr){
  try{
    if(roundId==null) return; const a=String(addr||'').toLowerCase();
    if(!/^0x[0-9a-f]{40}$/.test(a)) return;
    const k=String(roundId); const rec=SEATCAND_STORE[k]||(SEATCAND_STORE[k]={addrs:[],ts:Date.now()});
    if(rec.addrs.indexOf(a)<0){ rec.addrs.push(a); if(rec.addrs.length>400) rec.addrs=rec.addrs.slice(-400); /* bound per round */ }
    rec.ts=Date.now();
    const cut=Date.now()-6*3600*1000; for(const kk of Object.keys(SEATCAND_STORE)){ if((SEATCAND_STORE[kk].ts||0)<cut) delete SEATCAND_STORE[kk]; }  // drop stale rounds (6h >> challenge window)
    _saveSeatCand();
  }catch(_){}
}

// ============================================================================================================
// PHASE 2 CHAT: message IDs + reactions (A), ENS names/avatars (B), persistent profiles + address-keyed art (C).
// All file-based in STORE_DIR (same in-memory map + atomic/debounced persist pattern as the stores above). None of
// this touches money/game/settle: it only decorates how chat + player names/avatars are DISPLAYED. ENS and profiles
// are display-only and NEVER a REG key or a settle identity.
// ------------------------------------------------------------------------------------------------------------
// (A) STABLE MESSAGE IDS. A monotonic per-process counter keeps same-ms messages distinct; the id is also persisted
// in chat-log.jsonl going forward. For legacy lines without an id, synthesizeId() derives a deterministic one from ts.
let _msgSeq=0;
function newMsgId(ts){ _msgSeq=(_msgSeq+1)%100000; return 't'+ts+'-'+_msgSeq; }
function synthesizeId(m){ return (m&&m.id) ? m.id : ('t'+(m&&m.ts!=null?m.ts:'0')); }
// (A) REACTION STORE: { [msgId]: { [emoji]: [tokenHash,...] } }. We store the reactor's tokenHash (not the raw token)
// so a user can toggle once and cannot double-count, and no raw identity ever lands on disk. Pruned to the chat window.
const REACT_FILE = path.join(STORE_DIR, 'reactions.json');
const REACT_STORE = loadJson(REACT_FILE, {});
const _saveReacts = makeDebouncedSaver(()=>saveJsonAtomic(REACT_FILE, REACT_STORE), 1500);
const ALLOWED_REACTIONS = ['❤️','🔥','😂','💀','👏'];
let _reactVer=0;   // bumped on every reaction change so stateSignature pushes updates sub-second
// Toggle one reaction (emoji) by tokenHash on a message. Returns the message's updated { rx:{emoji:count}, mine:[...] }.
function toggleReaction(msgId, emoji, th){
  if(!msgId || ALLOWED_REACTIONS.indexOf(emoji)<0 || !th) return null;
  const rec = REACT_STORE[msgId] || (REACT_STORE[msgId]={});
  const arr = rec[emoji] || (rec[emoji]=[]);
  const i = arr.indexOf(th);
  if(i>=0){ arr.splice(i,1); if(!arr.length) delete rec[emoji]; } else { arr.push(th); }
  if(!Object.keys(rec).length) delete REACT_STORE[msgId];
  _reactVer++; _saveReacts();
  return reactionSummary(msgId, th);
}
// Compact summary for a message: { rx:{emoji:count}, mine:[emoji...] } or null when it has no reactions. `myTh` is the
// requester's token hash so the client can highlight its own reactions. Only attach rx to messages that have any.
function reactionSummary(msgId, myTh){
  const rec = REACT_STORE[msgId]; if(!rec) return null;
  const rx={}; const mine=[]; let any=false;
  for(const e of Object.keys(rec)){ const n=(rec[e]||[]).length; if(n>0){ rx[e]=n; any=true; if(myTh && rec[e].indexOf(myTh)>=0) mine.push(e); } }
  return any ? { rx, mine } : null;
}
// Prune reaction entries whose message is older than the chat retention window so the store stays bounded. A msgId is
// `t<ts>-<seq>` or legacy `t<ts>`, so we can read the ts straight out of the id without holding every message.
const REACT_RETENTION_MS = 7*24*3600*1000;   // one week, comfortably longer than the chat scrollback window
function pruneReactions(){
  try{ const cut=Date.now()-REACT_RETENTION_MS; let dirty=false;
    for(const id of Object.keys(REACT_STORE)){ const m=/^t(\d+)/.exec(id); const ts=m?Number(m[1]):0; if(ts && ts<cut){ delete REACT_STORE[id]; dirty=true; } }
    if(dirty) _saveReacts();
  }catch(_){}
}
setInterval(pruneReactions, 3600*1000); pruneReactions();

// (C) PROFILE STORE: { [addrLower]: { address, name, avatar, createdAt, updatedAt } }. avatar is an emoji from the
// Phase-1 set OR the sentinel 'ens' meaning "use my ENS picture". Display only; the key is the lowercased EVM address,
// never a REG token. Survives restarts so a chosen name/avatar persists across sessions.
const PROFILE_FILE = path.join(STORE_DIR, 'profiles.json');
const PROFILE_STORE = loadJson(PROFILE_FILE, {});
const _saveProfiles = makeDebouncedSaver(()=>saveJsonAtomic(PROFILE_FILE, PROFILE_STORE), 1500);
const PROFILE_AVATAR_SET = ['🦝','🥷','🦊','🐺','🐱','🐻','🦉','🐭','🐯','🦇','🐰','🐗','🔥','💀','👑','💎','🎯','🧠'];  // chosen-emoji palette + 'ens'
function profileFor(addr){ if(!addr) return null; return PROFILE_STORE[String(addr).toLowerCase()]||null; }
function upsertProfile(addr, patch){
  const a=String(addr||'').toLowerCase(); if(!/^0x[0-9a-f]{40}$/.test(a)) return null;
  const now=Date.now(); const p = PROFILE_STORE[a] || (PROFILE_STORE[a]={ address:a, name:null, avatar:null, createdAt:now, updatedAt:now });
  if(patch && typeof patch.name==='string'){ const nm=moderateName(patch.name.trim().slice(0,20)).trim(); p.name = nm || null; }
  if(patch && typeof patch.avatar==='string'){ p.avatar = (patch.avatar==='ens' || PROFILE_AVATAR_SET.indexOf(patch.avatar)>=0) ? patch.avatar : p.avatar; }
  p.updatedAt=now; _saveProfiles(); try{ _indexAvatarForAddr(a); }catch(_){} return p;
}

// ============================================================================================================
// PHASE 3 MODERATION (server-side baseline). Display/ingest only: none of this touches money/game/settle. An open
// real-money chat is a phishing/abuse target, so chat text AND profile names pass through a profanity mask and a URL
// defang before they are ever stored or shown, repeated spam is suppressed, bad actors can be muted globally by ops,
// and anyone can report a message to a durable queue.
// ------------------------------------------------------------------------------------------------------------
// (1) PROFANITY FILTER. One maintainable wordlist, WHOLE-WORD matching only (word boundaries) so "Scunthorpe" and
// "assassin" are never caught. Hits are masked (first char + asterisks), not rejected, so a message still posts. For
// names we mask then fall back to the default if nothing usable remains. Conservative by design to avoid false hits.
const PROFANITY = ['fuck','fucking','fucker','shit','bitch','bastard','asshole','dickhead','cunt','nigger','nigga','faggot','fag','retard','whore','slut','motherfucker','cock','pussy','wanker','twat'];
const _profRe = new RegExp('\\b(' + PROFANITY.map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|') + ')\\b', 'gi');
function maskProfanity(text){
  try{ return String(text==null?'':text).replace(_profRe, m=>m[0] + '*'.repeat(Math.max(1, m.length-1))); }catch(_){ return text; }
}
// (2) URL / LINK NEUTRALIZATION. A money-game chat must never carry a clickable scam link. Defang any http(s):// URL
// and any bare domain (word.tld with a known-ish TLD, plus common drainer shorteners) by replacing the dots with
// "[.]" so it renders as inert plain text and is never auto-linkified. We never build an <a>; the client already
// escapes text, so this only has to make the string non-navigable and visually flagged as a stripped link.
const _urlRe = /((?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|xyz|app|fi|finance|co|me|gg|link|click|site|online|vip|top|live|fun|cash|money|wtf|lol|info|biz|dev|eth|crypto|exchange|wallet|claim|airdrop))(\/[\w\-./?%&=#:+@~]*)?/gi;
function defangLinks(text){
  try{
    return String(text==null?'':text).replace(_urlRe, (m)=>{
      // strip the scheme so nothing reads as a live URL, then neutralize every dot so it cannot be linkified or pasted-to-navigate.
      let out = m.replace(/^https?:\/\//i,'').replace(/\./g,'[.]');
      return '[link removed] '+out;
    });
  }catch(_){ return text; }
}
// Combined chat-text sanitizer: defang links first (so a profanity mask can't split a URL), then mask profanity.
function moderateChatText(text){ return maskProfanity(defangLinks(text)); }
// Profile-name sanitizer: mask profanity (names never contain URLs after the charset strip); caller falls back to the
// default when the result is empty/only-asterisks.
function moderateName(name){ const masked=maskProfanity(name); const bare=String(masked||'').replace(/[*\s]/g,''); return bare?masked:''; }

// (5) ANTI-SPAM beyond the 6/10s rate: suppress an IDENTICAL message from the same sender within a short window so a
// flooder can't paste the same line repeatedly. Keyed by token hash -> {text, ts}. Normal varied play is unaffected.
const _lastMsg = {};   // th -> { text, ts }
const DUP_WINDOW_MS = 30000;
function isDuplicateSpam(th, text){
  try{ if(!th) return false; const prev=_lastMsg[th]; const now=Date.now();
    if(prev && prev.text===text && (now-prev.ts)<DUP_WINDOW_MS){ prev.ts=now; return true; }
    _lastMsg[th]={ text, ts:now }; return false;
  }catch(_){ return false; }
}

// (6) ADMIN MUTE: an ops-muted address is suppressed at /api/chat INGEST for everyone (its lines never enter CHAT).
// File-based so a mute survives restart. Keyed by lowercased address; checked via the chatter's token-derived address.
const MUTE_FILE = path.join(STORE_DIR, 'muted.json');
const MUTE_STORE = loadJson(MUTE_FILE, {});   // { [addrLower]: ts }
const _saveMutes = makeDebouncedSaver(()=>saveJsonAtomic(MUTE_FILE, MUTE_STORE), 1000);
function isMutedAddr(addr){ try{ return !!(addr && MUTE_STORE[String(addr).toLowerCase()]); }catch(_){ return false; } }
function setMuted(addr, on){ const a=String(addr||'').toLowerCase(); if(!/^0x[0-9a-f]{40}$/.test(a)) return false; if(on) MUTE_STORE[a]=Date.now(); else delete MUTE_STORE[a]; _saveMutes(); return true; }

// (4) REPORT QUEUE: durable append for ops review. Stores the reporter's token hash (never the raw token), the target
// id/address, a snapshot of the reported message id + text, the reason, and ts. Bounded in memory + persisted.
const REPORT_FILE = path.join(STORE_DIR, 'reports.json');
const REPORT_STORE = (function(){ const v=loadJson(REPORT_FILE, []); return Array.isArray(v)?v:[]; })();
const _saveReports = makeDebouncedSaver(()=>saveJsonAtomic(REPORT_FILE, REPORT_STORE), 1000);
function addReport(rec){ try{ REPORT_STORE.push(rec); while(REPORT_STORE.length>500) REPORT_STORE.shift(); _saveReports(); }catch(_){} }

// (D) PER-USER STATS (OBSERVE-ONLY). { [addrLower]: { wins, games, biggestHeist, firstSeen, lastSeen } }. Written ONLY
// additively: games++ at seat (once per round per address), wins++ / biggestHeist at SETTLE but AFTER the existing
// payout path already decided and paid the winner. Nothing here reads or alters settle math; it only records an outcome
// that already happened, so it can never gate or change a payout. File-based, atomic/debounced like the other stores.
const STATS_FILE = path.join(STORE_DIR, 'stats.json');
const STATS_STORE = loadJson(STATS_FILE, {});
// ONE-TIME STATS RESET (self-removing): if a `.reset-stats` sentinel exists, zero the in-memory + on-disk per-player
// stats at boot. Required because the shutdown exit-flush would otherwise rewrite the pre-launch (testing) stats over
// any plain file clear. The pre-launch stats are archived under .vs-store/_archive-* for history. Re-create the
// sentinel file anytime to re-zero from a clean launch baseline.
try{ if(fs.existsSync(path.join(STORE_DIR,'.reset-stats'))){ for(const _k in STATS_STORE) delete STATS_STORE[_k]; saveJsonAtomic(STATS_FILE, STATS_STORE); fs.unlinkSync(path.join(STORE_DIR,'.reset-stats')); console.log('[vault-standoff] stats reset to zero (launch baseline)'); } }catch(_){}
const _saveStats = makeDebouncedSaver(()=>saveJsonAtomic(STATS_FILE, STATS_STORE), 1500);
const _statsGameSeen = {};   // `${addr}:${roundId}` -> 1, so games increments at most once per address per round
function _statFor(addr){ const a=String(addr||'').toLowerCase(); if(!/^0x[0-9a-f]{40}$/.test(a)) return null; return STATS_STORE[a]||null; }
function statRecordSeat(addr, roundId){
  try{ const a=String(addr||'').toLowerCase(); if(!/^0x[0-9a-f]{40}$/.test(a)) return; const now=Date.now();
    const s = STATS_STORE[a] || (STATS_STORE[a]={ wins:0, games:0, biggestHeist:0, firstSeen:now, lastSeen:now });
    s.lastSeen=now; if(!s.firstSeen) s.firstSeen=now;
    const key=a+':'+String(roundId); if(!_statsGameSeen[key]){ _statsGameSeen[key]=1; s.games=(s.games|0)+1; }
    _saveStats();
  }catch(_){}
}
// Called from the post-settle hook (after payout already decided). `winners` = addresses that WON; `heist` = the RVLT
// pot the winners took (already computed by the normal pot/rake path). Observe-only: increments wins + biggestHeist.
function statRecordWin(winners, heist){
  try{ const amt=Number(heist)||0; (winners||[]).forEach(function(addr){ const a=String(addr||'').toLowerCase(); if(!/^0x[0-9a-f]{40}$/.test(a)) return; const now=Date.now();
    const s = STATS_STORE[a] || (STATS_STORE[a]={ wins:0, games:0, biggestHeist:0, firstSeen:now, lastSeen:now });
    s.wins=(s.wins|0)+1; s.lastSeen=now; if(amt>(s.biggestHeist||0)) s.biggestHeist=amt;
  }); _saveStats(); }catch(_){}
}
// OBSERVE-ONLY post-settle hook. Reads the ALREADY-DECIDED winner addresses + the pot the normal path used, derives the
// winners' take with the cached rake (display parity with the win ceremony), and records it. Never touches settle/pay.
function statsPostSettle(winnerAddrs){
  try{
    if(!winnerAddrs || !winnerAddrs.length) return;   // void/rollover rounds have no winner to credit
    const pot = (Number(G&&G._onchainPot)||0) + (Number(JACKPOT_RVLT)||0);   // the pot shown in the UI (RVLT)
    const rakeBps = (_rakeBpsCache!=null) ? _rakeBpsCache : 500;             // display fallback 5% if not cached yet
    const take = Math.max(0, pot - pot*rakeBps/10000);                       // winners' total take (RVLT), as the UI shows
    statRecordWin(winnerAddrs, take);
  }catch(_){}
}

// (B) ENS CACHE: address -> { name, avatar, ts, neg }. Hard-cached in memory + persisted; 24h TTL on hits, shorter on
// a negative/failed lookup so a flaky RPC is not hammered. Resolution is ALWAYS lazy/async and best-effort: callers
// read the cache (or fall back to the base name) and never block on the network. ENS is ETH-mainnet only (chainId 1).
const ENS_FILE = path.join(STORE_DIR, 'ens-cache.json');
const ENS_CACHE = loadJson(ENS_FILE, {});
const _saveEns = makeDebouncedSaver(()=>saveJsonAtomic(ENS_FILE, ENS_CACHE), 2000);
const ENS_TTL_MS = 24*3600*1000;          // positive cache: one day
const ENS_NEG_TTL_MS = 30*60*1000;        // negative cache: 30 min (don't spam a failing lookup)
const _ensInflight = {};                   // address -> true while a resolution is running (dedupe concurrent lookups)
let _ensProvider=null;
function ensProvider(){
  if(_ensProvider!==null) return _ensProvider;   // cached (may be a provider or false)
  try{ const url=alchemyUrl(1); if(!url){ _ensProvider=false; return false; } _ensProvider=new (require('ethers').JsonRpcProvider)(url, 1); }
  catch(_){ _ensProvider=false; }
  return _ensProvider;
}
// Non-blocking resolve: if we have a fresh cache entry, do nothing; else kick an async lookup that fills the cache and
// writes the result onto REG[tok].ens / REG[tok].ensAvatar when it lands. Never throws, never retries in a tight loop.
function ensResolveLazy(addr, tok){
  try{
    const a=String(addr||'').toLowerCase(); if(!/^0x[0-9a-f]{40}$/.test(a)) return;
    const c=ENS_CACHE[a]; const now=Date.now();
    if(c){ const ttl=c.neg?ENS_NEG_TTL_MS:ENS_TTL_MS; if(now-(c.ts||0)<ttl){ if(tok&&REG[tok]&&c.name){ REG[tok].ens=c.name; if(c.avatar)REG[tok].ensAvatar=c.avatar; } return; } }
    if(_ensInflight[a]) return; const prov=ensProvider(); if(!prov) return;
    _ensInflight[a]=true;
    (async()=>{
      let name=null, avatar=null;
      try{ name = await prov.lookupAddress(require('ethers').getAddress(a)); }catch(_){ name=null; }
      if(name){ try{ avatar = await prov.getAvatar(name); }catch(_){ avatar=null; } }
      ENS_CACHE[a] = name ? { name, avatar:avatar||null, ts:Date.now() } : { name:null, avatar:null, ts:Date.now(), neg:true };
      _saveEns();
      if(name){ const t='w:'+a; if(REG[t]){ REG[t].ens=name; if(avatar)REG[t].ensAvatar=avatar; } if(tok&&REG[tok]){ REG[tok].ens=name; if(avatar)REG[tok].ensAvatar=avatar; } try{ _indexAvatarForAddr(a); }catch(_){} }
    })().catch(()=>{}).finally(()=>{ delete _ensInflight[a]; });
  }catch(_){}
}

// (C) DISPLAY NAME + AVATAR precedence (display only; never identity): profile name > ENS name > base 'Robber XXXX'.
// `base` is whatever the seat already shows (REG name). avatar precedence: chosen profile emoji > (profile says ens &&
// an ENS avatar exists) > null (client falls back to its address-keyed procedural emoji). Pure string/URL out.
function displayNameFor(tok, base){
  try{ const r=tok&&REG[tok]; const addr=r&&r.address; const p=addr?profileFor(addr):null;
    if(p&&p.name) return p.name;
    if(r&&r.ens) return r.ens;
    return base||(r&&r.name)||'anon';
  }catch(_){ return base||'anon'; }
}
function displayAvatarFor(tok){
  try{ const r=tok&&REG[tok]; const addr=r&&r.address; const p=addr?profileFor(addr):null;
    if(p&&p.avatar&&p.avatar!=='ens') return { emoji:p.avatar };
    if(p&&p.avatar==='ens' && r&&r.ensAvatar) return { img:r.ensAvatar };
    if(r&&r.ensAvatar && (!p||!p.avatar)) return { img:r.ensAvatar };   // default to ENS pic when set and no chosen emoji
    return null;
  }catch(_){ return null; }
}
// TH -> avatar override index: chat lines persist only a token hash (th), so to attach a per-message avatar override
// without exposing the address we index avatars by tokenHash('w:'+addr). Updated whenever a profile or ENS avatar is
// set for an address. Lookup returns { emoji } or { img } or null. Bounded by the number of distinct profiled wallets.
const TH_AVATAR={};
function _indexAvatarForAddr(addr){
  try{ const a=String(addr||'').toLowerCase(); if(!/^0x[0-9a-f]{40}$/.test(a)) return; const th=tokenHash('w:'+a);
    const p=profileFor(a); const tok='w:'+a; const r=REG[tok];
    let av=null;
    if(p&&p.avatar&&p.avatar!=='ens') av={ emoji:p.avatar };
    else if(p&&p.avatar==='ens' && r&&r.ensAvatar) av={ img:r.ensAvatar };
    else if(r&&r.ensAvatar && (!p||!p.avatar)) av={ img:r.ensAvatar };
    if(av) TH_AVATAR[th]=av; else delete TH_AVATAR[th];
  }catch(_){}
}
function avatarByTh(th){ return (th&&TH_AVATAR[th])||null; }
// (D) TH -> address reverse index so the public /api/u?aid=<tokenHash> card can resolve a chat line's author back to an
// address WITHOUT ever exposing the address in the chat payload. Only registered for known wallet addresses (seat / SIWE
// / profile), so a th maps to an address only once that wallet has acted. Display-only; leaks nothing the name does not.
const TH_ADDR={};
function registerThAddr(addr){ try{ const a=String(addr||'').toLowerCase(); if(!/^0x[0-9a-f]{40}$/.test(a)) return; TH_ADDR[tokenHash('w:'+a)]=a; }catch(_){} }
function addrByTh(th){ return (th&&TH_ADDR[th])||null; }
// Backfill the index for every profiled address on boot so existing chosen avatars attach to chat lines after a restart.
try{ for(const a of Object.keys(PROFILE_STORE)) _indexAvatarForAddr(a); }catch(_){}
// Backfill th->address for every address we already know a stat or profile for, so /api/u resolves them after a restart.
try{ for(const a of Object.keys(PROFILE_STORE)) registerThAddr(a); for(const a of Object.keys(STATS_STORE)) registerThAddr(a); }catch(_){}
function seatCandidatesFor(roundId){ try{ const r=SEATCAND_STORE[String(roundId)]; return (r&&Array.isArray(r.addrs))?r.addrs.slice():[]; }catch(_){ return []; } }
function pruneSeatCandidatesBelow(floorId){ try{ for(const k of Object.keys(SEATCAND_STORE)){ const n=Number(k); if(Number.isInteger(n)&&n<floorId){ delete SEATCAND_STORE[k]; } } _saveSeatCand(); }catch(_){} }
// SEAT A PAID ADDRESS (the single gate): read escrow.ticketsOf(round, addr); ONLY if n>0 upsert the REG w: token (same
// shape /api/siwe/verify produces, with the CHECKSUMMED address) and seatWalletCount so it counts toward the round.
// Returns {seated, tickets}. Never seats on ticketsOf==0 (so nobody who didn't pay can be seated). Does NOT touch any
// settle/winner logic - the seat just carries the real paid address so the existing isParticipant/payWinners path is
// unaffected. seatWalletCount is a no-op unless the address's round == the current game round.
async function seatPaidAddress(roundId, addr){
  try{
    if(!/^0x[0-9a-fA-F]{40}$/.test(String(addr||''))) return { seated:false, tickets:0 };
    let a; try{ a=require('ethers').getAddress(addr); }catch(_){ return { seated:false, tickets:0 }; }   // checksummed
    const n = await escrow.ticketsOf(roundId, a).catch(()=>0);
    if(!(n>0)) return { seated:false, tickets:0 };   // THE GATE: no on-chain tickets -> no seat, ever
    const tok='w:'+a.toLowerCase();
    REG[tok]=REG[tok]||{name:'Robber '+a.slice(2,6),pre:null,active:true,tickets:1};
    REG[tok].active=true; REG[tok].verified=true; REG[tok].address=a;   // checksummed paid address
    // (C) persisted profile name (display only) + (B) lazy ENS resolve when a paid address becomes known.
    try{ const p=profileFor(a); if(p&&p.name) REG[tok].name=p.name; }catch(_){}
    try{ ensResolveLazy(a, tok); }catch(_){}
    // ROSTER: place the paid buyer into the live roster so THEIR session resolves inGame. Seat while this is the live
    // round and it has not ended/settled yet (not only during 'filling'), so a seat call that lands after the lock flip
    // still rosters the buyer before chambers resolve. Adds an entity only; never touches ticketsSold or the settle gate.
    try{ if(G && String(G.rmId)===String(roundId) && !G.done && G.phase!=='ended') seatWalletCount(tok, n); }catch(_){}
    try{ statRecordSeat(a, roundId); }catch(_){}   // (D) OBSERVE-ONLY: games++ once per round per address; never gates seating
    try{ registerThAddr(a); }catch(_){}            // (D) map this wallet's token hash -> address for the public /api/u card
    return { seated:true, tickets:n };
  }catch(_){ return { seated:false, tickets:0 }; }
}
// PAYOUT KEEPER TELEMETRY (MED-2): in-memory only, surfaced on the admin dashboard so a stranded winner payout or
// rake sweep is visible instead of dying in a console.error. PAYOUT_ALERTS keeps the last ~20 drops; PAYOUT_STATS
// tracks the most recent per-attempt failure. All writes are defensive and never throw back into the keeper.
const PAYOUT_ALERTS = [];
const PAYOUT_STATS = { lastError:null, lastErrorTs:0, drops:0 };
// STRANDED-FILL TELEMETRY (#1): when a round's AUTHORITATIVE on-chain ticket count (pot/entry) exceeds the number of
// tickets the server has been able to ATTRIBUTE to a known/candidate address, the surplus is a paid-but-unattributed
// seat (e.g. a cross-chain buyIn whose /api/relay/seat call was lost and whose address was never recorded as a
// candidate). The round is still fully funded on-chain, so we still let it lock on the authoritative count, but we
// surface the shortfall here so ops can make the payer whole rather than silently folding their RVLT into someone
// else's pot. In-memory ring; also logged. Keyed per round so it does not spam each 3s sync.
const FILL_STRAND_ALERTS = [];
const _fillStrandSeen = {};   // roundId -> last-logged shortfall (coalesce repeats)
function recordFillStrand(roundId, onchainTotal, attributed){
  try{
    const key=String(roundId), shortfall=onchainTotal-attributed;
    if(!(shortfall>0)) return;
    if(_fillStrandSeen[key]===shortfall) return;   // already reported this exact shortfall for this round
    _fillStrandSeen[key]=shortfall;
    FILL_STRAND_ALERTS.push({ roundId:key, onchainTotal, attributed, shortfall, ts:Date.now() });
    while(FILL_STRAND_ALERTS.length>20) FILL_STRAND_ALERTS.shift();
    try{ console.warn('[vault-standoff] FILL STRAND round '+key+': on-chain tickets='+onchainTotal+' attributed='+attributed+' UNATTRIBUTED='+shortfall+' (paid buyer not seated; make-whole needed)'); }catch(_){}
  }catch(_){}
}
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
Object.keys(AUTOBUY_STORE).forEach(k=>{ const a=AUTOBUY_STORE[k]; if(!a) return; delete a._inflight; delete a._pendingRounds;
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
    const o=Object.assign({}, AUTOBUY_STORE[k]); delete o._inflight; delete o._pendingRounds;
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
  console.error('[vault-standoff] FATAL: real-money escrow on mainnet requires VS_PASSWORD (no default). Refusing to boot.');
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
      console.error('[vault-standoff] FATAL: privileged key reuse on MAINNET (4663) — roles must be distinct keys. Collapsed: ' + list + '. Refusing to boot.');
      process.exit(1);
    } else {
      console.warn('[vault-standoff] WARNING (TESTNET 46630): privileged keys are COLLAPSED — ' + list + '. This is tolerated ONLY on testnet for the dry run. Mainnet go-live REQUIRES three distinct keys (settlement signer / auto-buy relayer / owner-deployer).');
    }
  }
}
const PW = process.env.VS_PASSWORD ;   // dev-only default; never reached in prod-money (guarded above)
// PUBLIC LAUNCH (2026-10-30): the pre-launch shared-password front door is OPEN by default now that the Standoff is
// live to the public. The password was only ever a pre-launch access lock; the real protection is unchanged and still
// enforced regardless of this flag — admin via adminGate, every money/action route via its own SIWE/relayer/IDOR auth.
// To RE-LOCK behind the shared password (e.g. a future gated rehearsal), a human sets VS_GATE=on in the dashboard.
const VS_GATE_ON = process.env.VS_GATE === 'on';
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
// ---- WALLET AUTH SESSIONS (FIX P0: kill wallet impersonation) ----------------------------------------------
// The public `w:<addr>` token is NOT proof of control: the address is public on-chain, so the token is guessable.
// AUTHORITY (pick / prechoose / logout / autoplay / ready / autobuy-cancel, and the PRIVATE me.pick/me.pre view)
// now additionally requires a server-issued SECRET session minted ONLY after a valid SIWE signature. The secret
// rides the `x-vs-sess` header (never derivable from the address), so a forged `x-vs-token` is inert without it.
// The display-only `verified` flag is intentionally left untouched (it still drives badges, never authority now).
const AUTH_FILE = path.join(STORE_DIR, 'auth-sessions.json');   // { [sid]: { addr, exp } } persisted across restarts
const AUTH_TTL_MS = 7*24*3600*1000;                             // 7 days
const AUTH_SESSIONS = (function(){
  const raw = loadJson(AUTH_FILE, {}); const now=Date.now(); const m=new Map();
  for(const sid in raw){ const s=raw[sid]; if(s && s.exp>now && typeof s.addr==='string') m.set(sid, s); }
  return m;
})();
function saveAuthSessions(){ const o={}; for(const [sid,s] of AUTH_SESSIONS) o[sid]=s; saveJsonAtomic(AUTH_FILE, o); }
function mintSess(addr){ const sid=crypto.randomBytes(32).toString('hex'); AUTH_SESSIONS.set(sid,{ addr:String(addr).toLowerCase(), exp:Date.now()+AUTH_TTL_MS }); saveAuthSessions(); return sid; }
function sessAddr(sid){ if(typeof sid!=='string'||!sid) return null; const s=AUTH_SESSIONS.get(sid); if(!s) return null; if(s.exp<=Date.now()){ AUTH_SESSIONS.delete(sid); saveAuthSessions(); return null; } return s.addr||null; }
// The SIWE-proven lowercased wallet address for this request (x-vs-sess header), or null. This is the ONLY identity
// that confers authority; reqToken() remains the display/roster key but can no longer, by itself, act for a wallet.
function provenAddr(req){ try{ return sessAddr(req&&req.headers&&req.headers['x-vs-sess']); }catch(_){ return null; } }
// The proven wallet TOKEN ('w:'+addr) for this request, or null if the caller has not proven wallet control.
function reqAuthTok(req){ const pa=provenAddr(req); return pa ? ('w:'+pa) : null; }
setInterval(()=>{ const now=Date.now(); let dirty=false; for(const [sid,s] of AUTH_SESSIONS){ if(s.exp<=now){ AUTH_SESSIONS.delete(sid); dirty=true; } } if(dirty) saveAuthSessions(); }, 3600000);
// SEC (gate-bypass scoping): the money/action routes must NEVER be reachable on the platform owner token alone — each
// carries its own stronger auth (SIWE-verified wallet, relayer-slot gate, per-route IDOR guards), and the admin surface
// has adminGate. The DASHBOARD_TOKEN hub bypass is therefore restricted to READ-ONLY / DISPLAY routes (the global
// password layer only), and is explicitly refused on any money/action prefix below so a leaked/forwarded owner token
// can never drive a buy, a gas drip, a relay submission, a pick/prechoice, or an admin call. A request to one of those
// routes must present a real vs_gate session (plus the route's own auth). This is a prefix DENYLIST so new money routes
// fail closed by being added here; the default for an unlisted path is the (display-only) token bypass.
const _GATE_MONEY_PREFIXES = ['/api/autobuy','/api/gas-drip','/api/relay/','/api/pick','/api/prechoose','/api/admin/'];
function _gatePathOf(req){
  try{ if(req&&typeof req.path==='string'&&req.path) return req.path; }catch(_){}
  try{ const u=(req&&(req.url||req.originalUrl))||''; if(u){ const q=u.indexOf('?'); return q>=0?u.slice(0,q):u; } }catch(_){}
  return '';
}
function _gateIsMoneyRoute(req){ const p=_gatePathOf(req); if(!p) return false; for(const pre of _GATE_MONEY_PREFIXES){ if(p.indexOf(pre)===0) return true; } return false; }
function gateOk(req){
  // PUBLIC LAUNCH: when the shared-password gate is OFF (default), every request passes this layer. Admin and the
  // money/action routes are NOT affected — they carry their own stronger auth (adminGate / SIWE / relayer slot / IDOR
  // guards) further down and remain fully enforced. Only re-engaged when a human sets VS_GATE=on.
  if(!VS_GATE_ON) return true;
  // HUB REVERSE-PROXY BYPASS (DISPLAY ROUTES ONLY): this artifact is is_public=false and the Vault Robbers hub
  // (vaultrobbers.com, itself password-gated) reverse-proxies it under /play/v3, injecting the group's platform owner
  // token server-side. A request carrying that exact Bearer token came through the trusted, already-gated hub — honor
  // it on read-only/display routes so there's no double password prompt, WITHOUT the hub holding this game's play
  // password or any signing key. But SCOPE it: the token bypass is REFUSED on the money/action routes (buy/gas-drip/
  // relay/pick/prechoose/admin) so the owner token can never, by itself, drive an on-chain or player-state action —
  // those still require a real play-gate session (and each route's own SIWE/relayer/admin auth). A token-less public
  // visitor can never reach here (dashboard 401s first), so the display-route bypass does not widen exposure.
  try{ const dt=process.env.DASHBOARD_TOKEN; const a=req&&req.headers&&req.headers.authorization; if(dt&&typeof a==='string'&&a==='Bearer '+dt && !_gateIsMoneyRoute(req)) return true; }catch(_){}
  return gateSessionValid(cookies(req).vs_gate);
}
setInterval(()=>{ const now=Date.now(); let dirty=false; for(const [sid,s] of GATE_SESSIONS){ if(s.exp<=now){ GATE_SESSIONS.delete(sid); dirty=true; } } if(dirty) saveGateSessions(); }, 3600000);
// SOCIAL / FAVICON META (shared between the gate screen and index.html). Present on the GATE so a crawler hitting
// the password-locked URL still unfurls a branded card. og:image + favicon are served from the ungated whitelist
// below so the crawler can actually fetch them. All URLs ABSOLUTE for the production custom domain.
const VS_META = '<title>The Vault Standoff</title>'
  + '<meta name="description" content="Pick a door. The crowd gets caught. Last robber takes the vault.">'
  + '<link rel="icon" type="image/svg+xml" href="/favicon.svg">'
  + '<link rel="apple-touch-icon" href="/apple-touch-icon.png">'
  + '<meta property="og:type" content="website">'
  + '<meta property="og:site_name" content="Vault Robbers">'
  + '<meta property="og:title" content="The Vault Standoff">'
  + '<meta property="og:description" content="Pick a door. The crowd gets caught. Last robber takes the vault.">'
  + '<meta property="og:url" content="https://standoff.vaultrobbers.com/">'
  + '<meta property="og:image" content="https://standoff.vaultrobbers.com/og.png">'
  + '<meta property="og:image:width" content="1200">'
  + '<meta property="og:image:height" content="630">'
  + '<meta name="twitter:card" content="summary_large_image">'
  + '<meta name="twitter:title" content="The Vault Standoff">'
  + '<meta name="twitter:description" content="Pick a door. The crowd gets caught. Last robber takes the vault.">'
  + '<meta name="twitter:image" content="https://standoff.vaultrobbers.com/og.png">';
const GATE='<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">'+VS_META+'<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3e3ca;font-family:ui-sans-serif}form{background:#fbfaf6;border:2.5px solid #17130d;border-radius:16px;box-shadow:6px 6px 0 #17130d;padding:26px;text-align:center}input,button{font-size:16px;padding:11px;border:2.5px solid #17130d;border-radius:11px;box-shadow:3px 3px 0 #17130d;width:220px;display:block;margin:8px auto}button{background:#6d84c6;color:#fbfaf6;cursor:pointer}</style><form onsubmit="event.preventDefault();fetch(location.href,{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({password:pw.value})}).then(r=>r.ok?location.reload():msg.textContent=\'Wrong password.\')"><h3>Vault Standoff</h3><input id=pw type=password placeholder=password autofocus><button>Enter</button><div id=msg></div></form>';
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
// PUSH ASSETS, served PUBLICLY and EARLY (before the password gate + before express.static / any SPA fallback), with
// the correct JavaScript / manifest MIME types. A service worker is REJECTED by the browser unless served as a JS MIME
// type; the gate middleware below was serving the HTML lock page for /sw.js (it is not in the ungated whitelist), which
// is why registration failed. These two files contain nothing sensitive: the SW is push-only (no secrets), the manifest
// is PWA metadata. The browser chrome fetches the manifest and the SW fetches without necessarily carrying the gate
// cookie, so they MUST bypass the gate. The dashboard proxy maps /pub/main/vault-standoff/sw.js -> /sw.js, and the bare
// custom domain uses /sw.js directly, so matching req.path==='/sw.js' covers both origins. Registered here, ABOVE the
// gate middleware (line ~672) and ABOVE express.static / the SPA index fallback (line ~4760), so nothing intercepts them.
app.get('/sw.js',(req,res)=>{
  res.set('Content-Type','application/javascript');
  res.set('Service-Worker-Allowed','/');
  res.set('Cache-Control','no-cache');
  res.sendFile(path.join(__dirname,'public','sw.js'));
});
app.get('/manifest.webmanifest',(req,res)=>{
  res.set('Content-Type','application/manifest+json');
  res.set('Cache-Control','no-cache');
  res.sendFile(path.join(__dirname,'public','manifest.webmanifest'));
});
app.use((req,res,next)=>{
  // the admin surface has its OWN (stronger) auth, so it bypasses the play-password gate. admin.html loads a
  // token login box; /api/admin/* each enforce adminGate. This lets an operator reach the dashboard without
  // also knowing the play password, while still being 401 without the admin token.
  if(req.path==='/admin.html' || req.path.indexOf('/api/admin/')===0) return next();
  // PUBLIC (ungated) BRAND ASSETS: a social crawler must be able to fetch the OG image + favicons without the
  // password, or the link unfurl shows no image. These are static, non-sensitive files; letting them through does
  // NOT widen exposure to the app or any API. Everything else still hits the gate below.
  if(req.path==='/og.png' || req.path==='/favicon.svg' || req.path==='/apple-touch-icon.png') return next();
  if(gateOk(req)) return next();
  // Gate-password POST is brute-force-throttled. Keyed on the HARDENED rlKey (trusted-proxy real IP or the raw socket
  // peer — NOT the client-spoofable x-forwarded-for, which the old key used and which let a scanner rotate the header
  // to dodge the limit) at 8/min/identity, PLUS a global 120/min cap as defense-in-depth against a distributed /
  // IP-rotating guess flood. (Blast radius is only the pre-launch access gate — money + admin surfaces are separately
  // gated — but the gate must still not be trivially brute-forceable.)
  if(req.method==='POST'){ if(!rl(rlKey(req,'gatepw'),8,60000) || !rl('gatepw:__all',120,60000)){res.status(429).json({ok:false,error:'slow down'});return;} let b=''; req.on('data',d=>{b+=d;if(b.length>2048)req.destroy();}); req.on('end',()=>{ let pw='';try{pw=JSON.parse(b||'{}').password||'';}catch(_){ } if(crypto.createHash('sha256').update(pw+':vs-gate').digest('hex')===PW_HASH){const sid=mintGateSession();res.setHeader('Set-Cookie',`vs_gate=${sid}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`);res.json({ok:true});}else res.status(401).json({ok:false}); }); return; }
  // Serve the lock screen at 200 (was 401) so social crawlers read the OG tags and the platform health probe passes.
  // This is ONLY the password prompt + meta; the app, every API, and the WebSocket stay fully gated above.
  res.status(200).type('html').send(GATE);
});
app.use(express.json());

// ---- config ----
const DAY=86400000, H=3600000, M=60000;
const MODES={
  // demand-driven (fuse compressed for preview; prod bumps fuse to 3600000)
  fill:  { engine:'fill', threshold:50, cap:100, fuse:20000, resultMs:12000, choose:15000, blind:1000, reveal:5000, maxch:6, seedBots:10, armEvery:2500 },
  // clock engines
  dev:   { engine:'clock', interval:240000, lobby:80000, choose:30000, blind:1000, reveal:6000, maxch:6 },
  demo:  { engine:'clock', interval:15*M, unit:M, lobbyU:2, firstLockU:3, spacingU:2, blind:20000, reveal:15000, maxch:6 },
  daily: { engine:'clock', interval:DAY, unit:H, lobbyU:12, firstLockU:14, spacingU:2, blind:30*M, reveal:10*M, maxch:6 },
  // THRESHOLD-FILL real-money engine (Phase A). Demand-driven like `fill` but the on-chain escrow IS the driver:
  // a round OPENS with a far-future sentinel lockTime (buy-in stays open), players fill it, at threshold+grace
  // (or full) the SIGNER calls lockRound(id) on-chain to close buy-in, then commit, then the chambers play on a
  // RELATIVE clock, then settle/void. No dead time: the next round opens the instant this one locks. target /
  // thresholdPct / graceSec / otDoors / choose / reveal / maxch all come from the hot economy config at the
  // round boundary (applyCfgAtBoundary), so the literals here are only pre-config defaults. `cap`==`target` so
  // the shared seat-cap plumbing (C.cap guards in seatWalletCount) works unchanged.
  rmfill:{ engine:'rmfill', target:50, cap:50, thresholdPct:50, graceMs:600000, choose:30000, blind:1000, reveal:6000, maxch:6,
           minViable:2, sentinelSec:parseInt(process.env.VS_SENTINEL_SEC||'86400',10)||86400, playMarginSec:parseInt(process.env.VS_PLAY_MARGIN_SEC||'3600',10)||3600 }
           /* PROD VALUES (reverted for the Oct-31 public launch, 2026-10-27): 24h abandoned-round sentinel + 1h void margin so a SLOW-FILLING real round is NEVER force-voided prematurely (the old 1800/300 test values would self-void an unfilled round in ~35min — the "round got cancelled" symptom). Env VS_SENTINEL_SEC / VS_PLAY_MARGIN_SEC still override if ever needed. */
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
  console.error('[vault-standoff] FATAL: VS_ESCROW is on but mode "'+MODE+'" is not a real-money engine. Set VS_MODE/VS_MODE_ESCROW to dev|demo|daily (clock) or rmfill (threshold-fill). Refusing to boot.');
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
  minPresentPct: 15,                              // FEATURE 2: min % of target that must be actively-present (non-auto) humans before a round LOCKS (safe non-zero CODE DEFAULT so an all-autoplay/all-bot round can never lock to self-play; the go-live admin config may still override this, but the default is no longer 0). anti all-bot erosion
  // FIX 1 (DISTINCT-WALLET FLOOR, 2026-10-16, Jake): a round may NOT lock until at least this many DISTINCT funding
  // wallet ADDRESSES hold on-chain tickets in it. One wallet buying the whole target can never lock a round to
  // self-play; if the fill window ends below the floor the round VOIDS + REFUNDS (no self-win, no rake). Counts
  // distinct addresses from the attributed/reconciled seats, NOT ticket count. 2 = no solo play.
  minDistinctWallets: 2,
  // FIX 2 (THIN-ROUND DOOR FLOOR, 2026-10-16, Jake): 1 = raise the door count on small alive counts so one chamber
  // can't collapse the whole field in one step (doors ~= max(2, alive-1) for thin rounds: ~one bust/chamber, the
  // standoff plays several tense chambers). 0 = legacy routesFor only. KEEPS the larger-count scaling + deeper-
  // chamber tightening; the round still always converges to a single champion (see resolve()/overtime).
  thinDoorFloor: 1,
  // ANTI-WHALE circuit breaker (OPTICS, not security: the game is EV-negative via rake and cannot be farmed). A wallet
  // that wins streakFreezeAt games in a row is frozen from buying in for streakCooldownHrs. 0 = OFF (recommended default
  // keeps it on at 3/24h as a fairness lever; set streakFreezeAt 0 to disable entirely).
  streakFreezeAt: 3,
  streakCooldownHrs: 24,
  // PROGRESSIVE JACKPOT: final-vault standoff rollover. finalVaultDoors = OT round-0 door count (more = rarer rollover);
  // jackpotRollover 1=on/0=off. Rollover folds the busted pot into the ROBINVAULT pot (no separate label).
  finalVaultDoors: 5,
  jackpotRollover: 1,
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
  minDistinctWallets:[1,50], thinDoorFloor:[0,1],
  streakFreezeAt:[0,50], streakCooldownHrs:[1,720], finalVaultDoors:[2,12], jackpotRollover:[0,1],
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
// Vault Standoff (V3) opens the instant the Vault Robbers NFT mint is FINALIZED: SELLS OUT (minted >= max) or the
// Halloween cutoff passes (the mint permanently closes then and whatever is minted becomes the full supply). The
// mint contract is read-only + env-configured; until VS_MINT_ADDR is set the Halloween timestamp alone drives
// launch. launchState() is exposed in /api/state and drives the client launch overlay (no server-side round gate).
const _mintEthers = require('ethers');
const MINT = {
  // Vault Robbers NFT, confirmed on-chain 2026-10-14: "Vault Robbers" (ROBBERS) on Robinhood Chain, MAX_SUPPLY 1000,
  // minted-count getter totalMinted(), owner = treasury Safe 0x3290…3665. Baked as defaults; override via VS_MINT_*.
  addr: (process.env.VS_MINT_ADDR || '0xABC6c4F5d1F31326b419c2645C981743a845313a').trim(),
  max: parseInt(process.env.VS_MINT_MAX || '1000', 10) || 1000,
  chain: parseInt(process.env.VS_MINT_CHAIN || '4663', 10) || 4663,
  rpc: process.env.VS_MINT_RPC || 'https://rpc.mainnet.chain.robinhood.com',
  method: process.env.VS_MINT_METHOD || 'totalMinted',
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
        else if((q.tries=(q.tries||0)+1)>=8){ recordPayoutDrop(id, 'winners', q.tries, PAYOUT_STATS.lastError); delete PAYOUT_QUEUE[id]; savePayoutQueue(); console.error('[vault-standoff] payWinners failed 8x for round '+id+' — winners can still claim() on-chain'); continue; }
        else { q.after=Date.now()+30000; savePayoutQueue(); continue; }   // back off (window maybe not elapsed) and retry
      }
      // STEP 2: RAKE AUTO-SWEEP. Separate on-chain call; without it the rake just accrues as rakeOwed and the
      // treasury never receives it. Idempotent ("rake paid" revert treated as success). The queue entry is KEPT
      // until rake confirms so a restart or RPC blip can never silently skip the treasury sweep (LOW fix: was
      // previously fire-and-forget with the entry deleted on the first payWinners success).
      if(q.winnersPaid && !q.rakePaid){
        const rk=await escrow.payRake(id).then(()=>true).catch(async(e)=>{
          if(/rake paid/i.test(String(e&&(e.shortMessage||e.message)||''))) return true;   // string-revert "rake paid" = already swept
          try{ if(await escrow.rakePaidOf(id)===true) return true; }catch(_){}               // AUDIT fix: a CUSTOM-error revert won't string-match, so confirm chain truth before treating as failure
          recordPayoutFail(e);                                                               // MED-2: real failure (not an already-swept revert), record for the dashboard
          return false;
        });
        if(rk){ q.rakePaid=true; delete PAYOUT_QUEUE[id]; savePayoutQueue(); }
        else if((q.rakeTries=(q.rakeTries||0)+1)>=8){ recordPayoutDrop(id, 'rake', q.rakeTries, PAYOUT_STATS.lastError); delete PAYOUT_QUEUE[id]; savePayoutQueue(); console.error('[vault-standoff] payRake failed 8x for round '+id+' — rake still accrues on-chain as rakeOwed; call payRake('+id+') manually'); }
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
// FIX 2 (THIN-ROUND DOOR FLOOR): choose the door count for a chamber given the ALIVE robber count. For THIN fields
// the legacy routesFor() gives only 2 doors, so a single most-crowded door can wipe ~half the field in one chamber
// (e.g. 4 alive, 2 doors -> ~2 bust at once, resolves in ~1-2 chambers). We raise the floor to ~max(2, alive-1) so
// expected occupancy per door is ~alive/(alive-1) ~= 1: the most-crowded door catches ~1-2 robbers, the field
// shrinks GRADUALLY and the standoff plays SEVERAL tense chambers. Bounded by the 5 available route labels (R.length)
// and never BELOW the legacy routesFor(), so the larger-count scaling (3/4/5 door tiers) is preserved for big fields;
// above THIN_MAX we defer entirely to routesFor (a large field already crowds + collapses across many chambers, so
// it needs no stretch and we keep its faster legacy cadence). CONVERGENCE: resolve() always busts >=1 and never 0
// alive (forced-bust + winner-spare fallbacks), so ANY door count >=2 strictly shrinks the field by >=1 per chamber
// -> the round is GUARANTEED to reach a single champion; more doors only STRETCH it (never stall), and maxChambers +
// overtime (low otDoors, forces fast collapse) bound total length. Config thinDoorFloor (default 1=on); 0 = legacy.
function routesForAlive(n){
  const legacy=routesFor(n);
  try{ if(!(getCfg().thinDoorFloor)) return legacy; }catch(_){ return legacy; }
  const THIN_MAX=12;                                   // only stretch genuinely thin fields; larger fields keep legacy scaling
  if(n>THIN_MAX) return legacy;
  const floorDoors=Math.min(R.length, Math.max(2, n-1));   // ~one bust/chamber for thin rounds, capped at the 5 route labels
  return Math.max(legacy, floorDoors);                 // never fewer than legacy (keeps 3/4/5 tiers where they already apply)
}
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
// lightweight per-key sliding-window rate limiter for mutating endpoints (anti-spam / anti-DoS).
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
// LAUNCH HARDENING: per-player rate buckets behind the custom-domain proxy. The thin Cloudflare Worker that
// fronts standoff.vaultrobbers.com forwards the REAL client IP in x-vs-real-ip, authenticated by a shared
// secret (x-vs-proxy-auth). Without this every request through the proxy shares ONE bucket (the proxy's IP),
// so one player's burst throttles everyone. The secret gates trust so a caller hitting the origin DIRECTLY
// can't spoof x-vs-real-ip to mint fresh buckets. Secret is generated once, persisted, and baked into the Worker.
const PROXY_SECRET = (function(){
  const f = path.join(STORE_DIR, 'proxy-secret.json');
  let s = loadJson(f, null);
  if(!s || !s.secret){ s = { secret: crypto.randomBytes(24).toString('hex') }; saveJsonAtomic(f, s); }
  return s.secret;
})();
function rlKey(req,pfx){
  let ip;
  const pa = req.headers['x-vs-proxy-auth'];
  const rip = req.headers['x-vs-real-ip'];
  // FIX 5: constant-time compare of the proxy secret (was `pa===PROXY_SECRET`, byte-wise short-circuit -> timing oracle).
  // _ctEq is the existing timingSafeEqual helper used for the admin tokens; it also length-guards so unequal lengths fail fast-but-safe.
  if(typeof rip==='string' && rip && typeof pa==='string' && _ctEq(pa, PROXY_SECRET)){
    ip = rip.indexOf(',')>=0 ? rip.split(',')[0].trim() : rip;                    // trusted real client IP via the proxy
  } else {
    // FIX 4 (red-team): with NO valid trusted-proxy secret, `x-forwarded-for` / `x-vs-real-ip` are attacker-supplied
    // and spoofable — trusting them lets an attacker mint unlimited rate-limit buckets (or collapse everyone into one)
    // and defeat the limiter on expensive Relay/RPC routes. So we key ONLY on the real socket peer address here and
    // IGNORE the client-supplied forwarding headers entirely. The trusted-proxy branch above is unchanged.
    ip = req.socket?.remoteAddress || 'anon';
  }
  // FIX (red-team): key the limiter on the hardened real client IP ONLY. The former `x-vs-token` refinement was a
  // caller-CONTROLLED header, so rotating it minted unlimited rate-limit buckets (defeating every per-route limit) and
  // could fill the _RL map to its 50k cap and fail-closed-lock-out real users. NAT'd players share an IP bucket, but
  // the per-route limits are sized to tolerate that. Identity-scoped checks live in the routes (proven session), not here.
  return pfx+':'+ip;
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
  console.error('[vault-standoff] FATAL: real-money escrow on mainnet (4663) requires VS_ADMIN_TOKEN >= 32 chars (no password-derived default). Refusing to boot.');
  process.exit(1);
}
// AUDIT L-1 HARDENING (defense-in-depth): the guard above is gated on _prodMoney (escrow ON *and* chainId 4663).
// If this process ever ran on the MAINNET chain with escrow momentarily OFF (e.g. VS_ESCROW=off for maintenance),
// _prodMoney would be false and the predictable password-derived admin fallback could silently apply on a mainnet
// box. The admin surface controls the live economy config, so a predictable token must NEVER exist on the mainnet
// chain regardless of the escrow switch. Refuse the dev default whenever the configured chain is 4663.
if(Number(_escCfg.chainId) === 4663 && !(process.env.VS_ADMIN_TOKEN && process.env.VS_ADMIN_TOKEN.length>=32)){
  console.error('[vault-standoff] FATAL: on the MAINNET chain (4663) VS_ADMIN_TOKEN >= 32 chars is required (no password-derived default), even when escrow is off. Refusing to boot.');
  process.exit(1);
}
const ADMIN_TOKEN = (process.env.VS_ADMIN_TOKEN && process.env.VS_ADMIN_TOKEN.length>=12)
  ? process.env.VS_ADMIN_TOKEN
  : ('vs-admin-' + crypto.createHash('sha256').update((PW||'dev')+':vs-admin-dev').digest('hex').slice(0,24));
if(!(process.env.VS_ADMIN_TOKEN && process.env.VS_ADMIN_TOKEN.length>=12)){
  // H-2: NEVER print the full admin token to the logs (log sinks are a leak surface). Surface only a short prefix
  // so an operator can recognize which dev-default token is live; the full value is derivable from env setup only.
  console.log('[vault-standoff] ADMIN token set (dev default, testnet). prefix='+ADMIN_TOKEN.slice(0,10)+'...  -> open /pub/main/vaultstandoff-dev/admin.html and paste the full token (see VS_ADMIN_TOKEN). Set VS_ADMIN_TOKEN in env to override.');
}
const ADMIN_COOKIE = crypto.createHash('sha256').update(ADMIN_TOKEN+':vs-admin-cookie').digest('hex');
function _ctEq(a,b){ if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length) return false; try{ return crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b)); }catch(_){ return false; } }
// admin request is authorized if it presents the raw token (header x-vs-admin) OR the derived admin cookie.
function adminOk(req){ const h=req.headers['x-vs-admin']; if(typeof h==='string'&&_ctEq(h,ADMIN_TOKEN)) return true; const c=cookies(req).vs_admin; return typeof c==='string'&&_ctEq(c,ADMIN_COOKIE); }

// ============================================================================================================
// WEB PUSH (opt-in notifications). Fully ISOLATED from the money path: touches NO funds, NO escrow, NO settle, and no
// keys beyond a SELF-GENERATED VAPID keypair (persisted 0700 like proxy-secret.json; the private key is NEVER served).
// The round-state engine fires two kinds of push on the SAME moments as the in-tab notifications:
//   (a) BROADCAST "a new heist is forming/starting" to ALL opted-in subscribers when a fresh round opens (throttled).
//   (b) PERSONAL "you cracked the vault" to the winner's subscription(s) at settle, when the sub carries their address.
// web-push is required defensively: if the dep is ever missing, push silently no-ops and the in-tab path still works.
let webpush=null; try{ webpush=require('web-push'); }catch(_){ console.warn('[vault-standoff] web-push dep not installed; Web Push disabled (in-tab notifications still work).'); }
// VAPID keypair, self-bootstrapping (no env needed), persisted OWNER-ONLY. Same pattern as PROXY_SECRET above.
const VAPID = (function(){
  if(!webpush) return null;
  const f = path.join(STORE_DIR, 'vapid.json');
  let v = loadJson(f, null);
  if(!v || !v.publicKey || !v.privateKey){
    try{ v = webpush.generateVAPIDKeys(); saveJsonAtomic(f, v); }  // saveJsonAtomic writes 0600 inside the 0700 store dir
    catch(e){ console.error('[vault-standoff] VAPID keygen failed; Web Push disabled:', e&&e.message||e); return null; }
  }
  // VAPID "subject" must be a mailto: or https: URL; a stable https URL for this app is fine and non-secret.
  const SUBJECT = process.env.VS_VAPID_SUBJECT || 'https://standoff.vaultrobbers.com/';
  try{ webpush.setVapidDetails(SUBJECT, v.publicKey, v.privateKey); }catch(e){ console.error('[vault-standoff] setVapidDetails failed; Web Push disabled:', e&&e.message||e); return null; }
  console.log('[vault-standoff] Web Push ready (VAPID self-bootstrapped).');
  return v;
})();
// Subscription store: { [endpoint]: { sub:PushSubscription, addr:0x..lower|null, ts } }. Deduped by endpoint, pruned
// on a 404/410 send failure (the subscription expired / was revoked). Persisted like the other .vs-store JSON files.
const PUSHSUBS_FILE = path.join(STORE_DIR, 'push-subs.json');
const PUSH_SUBS = loadJson(PUSHSUBS_FILE, {});
let _pushSaveT=null;
function savePushSubs(){ if(_pushSaveT) return; _pushSaveT=setTimeout(()=>{ _pushSaveT=null; saveJsonAtomic(PUSHSUBS_FILE, PUSH_SUBS); }, 400); }
function pushEnabled(){ return !!(webpush && VAPID); }
// Add/refresh a subscription (dedupe by endpoint). addr is the caller's connected wallet (lowercased) or null.
function addPushSub(sub, addr){
  try{
    if(!sub || typeof sub.endpoint!=='string' || !/^https:\/\//.test(sub.endpoint)) return false;
    const a=(typeof addr==='string' && /^0x[0-9a-fA-F]{40}$/.test(addr)) ? addr.toLowerCase() : null;
    PUSH_SUBS[sub.endpoint] = { sub, addr:a, ts:Date.now() };
    // bound the store so a flood of stale endpoints can't grow it forever: keep the 5000 most recent.
    const keys=Object.keys(PUSH_SUBS);
    if(keys.length>5000){ keys.sort((x,y)=>(PUSH_SUBS[x].ts||0)-(PUSH_SUBS[y].ts||0)).slice(0, keys.length-5000).forEach(k=>delete PUSH_SUBS[k]); }
    savePushSubs(); return true;
  }catch(_){ return false; }
}
// Send one push to one stored record; prune the endpoint on a 404/410 (gone) so the store self-heals. Never throws.
async function _sendOne(endpoint, payloadStr){
  const rec=PUSH_SUBS[endpoint]; if(!rec||!rec.sub) return;
  try{ await webpush.sendNotification(rec.sub, payloadStr, { TTL: 1800 }); }
  catch(e){ const code=(e&&e.statusCode)||0; if(code===404||code===410){ delete PUSH_SUBS[endpoint]; savePushSubs(); } }
}
// BROADCAST to every opted-in subscriber, throttled per-subscriber so frequent rounds can't spam. Default: at most one
// broadcast per subscriber per ~10 min (VS_PUSH_BROADCAST_MIN_MS). Fire-and-forget; bounded fan-out, errors swallowed.
const PUSH_BROADCAST_MIN_MS = Math.max(60000, parseInt(process.env.VS_PUSH_BROADCAST_MIN_MS||'600000',10)||600000);
const _pushLastBroadcastTo={};   // endpoint -> last broadcast ms (throttle)
async function pushBroadcast(title, body, tag){
  if(!pushEnabled()) return;
  const now=Date.now();
  const payload=JSON.stringify({ title, body, tag:tag||'vs-heist', url:'./' });
  const jobs=[];
  for(const endpoint of Object.keys(PUSH_SUBS)){
    const last=_pushLastBroadcastTo[endpoint]||0;
    if(now-last < PUSH_BROADCAST_MIN_MS) continue;   // per-subscriber throttle
    _pushLastBroadcastTo[endpoint]=now;
    jobs.push(_sendOne(endpoint, payload));
    if(jobs.length>=500){ try{ await Promise.allSettled(jobs.splice(0)); }catch(_){} }   // bounded concurrency
  }
  if(jobs.length){ try{ await Promise.allSettled(jobs); }catch(_){} }
}
// PERSONAL push to the subscriptions that carry one of `addrs` (the round's winner addresses). NOT throttled (a win is
// rare + high-value). Fire-and-forget.
async function pushToAddresses(addrs, title, body, tag){
  if(!pushEnabled() || !Array.isArray(addrs) || !addrs.length) return;
  const want=new Set(addrs.map(a=>String(a||'').toLowerCase()).filter(a=>/^0x[0-9a-f]{40}$/.test(a)));
  if(!want.size) return;
  const payload=JSON.stringify({ title, body, tag:tag||'vs-win', url:'./' });
  const jobs=[];
  for(const endpoint of Object.keys(PUSH_SUBS)){ const rec=PUSH_SUBS[endpoint]; if(rec && rec.addr && want.has(rec.addr)) jobs.push(_sendOne(endpoint, payload)); }
  if(jobs.length){ try{ await Promise.allSettled(jobs); }catch(_){} }
}

const REG={}, CHAT=[], HISTORY=[]; // HISTORY = past results only (public, no future/edge leak)
// ---- DURABLE CHAT LOG (Telegram-style persistent, scrollable "taunt the crowd") ----------------------------------
// REAL human messages (from POST /api/chat) are appended to an APPEND-ONLY JSONL file so they survive restarts and can
// be paginated for infinite scrollback. We deliberately use append-only JSONL (one fs.appendFileSync line per message,
// O(1), no whole-file rewrite) rather than node:sqlite (experimental in this Node; would add a runtime warning + an
// unstable API to a money-adjacent process). AMBIENT BOT chatter is NEVER written here (it stays in-memory only), so
// the durable log is exclusively real humans. Each line: {name, text, ts, th} (th = token hash for best-effort "mine").
const CHAT_LOG_FILE = path.join(STORE_DIR, 'chat-log.jsonl');
const CHAT_BOOT_WINDOW = 100;   // most-recent N real messages reloaded into the live CHAT window on boot
function appendChatLog(rec){ try{ fs.appendFileSync(CHAT_LOG_FILE, JSON.stringify(rec)+'\n', { mode:0o600 }); }catch(_){} }
// Read the last `limit` JSONL lines with ts < before (default now). Scans from the end of the file so pagination stays
// efficient without parsing the whole log. Returns OLDEST-FIRST (ascending ts) so the client prepends a coherent page.
function readChatHistory(before, limit){
  limit = Math.max(1, Math.min(50, parseInt(limit,10)||50));
  const beforeTs = (before!=null && isFinite(before)) ? Number(before) : Infinity;
  let raw=''; try{ raw=fs.readFileSync(CHAT_LOG_FILE,'utf8'); }catch(_){ return []; }
  const lines=raw.split('\n'); const out=[];
  for(let i=lines.length-1; i>=0 && out.length<limit; i--){
    const ln=lines[i]; if(!ln) continue;
    let m; try{ m=JSON.parse(ln); }catch(_){ continue; }
    if(!m || typeof m.ts!=='number' || m.ts>=beforeTs) continue;
    out.push(m);
  }
  return out.reverse();   // oldest-first
}
// On boot, reload the most-recent real messages into the live CHAT window so the state payload + reconnects show
// history immediately (a restart no longer wipes the "taunt the crowd" feed).
(function _loadChatBootWindow(){ try{ const recent=readChatHistory(Infinity, CHAT_BOOT_WINDOW); recent.forEach(m=>CHAT.push(m)); if(recent.length) console.log('[vault-standoff] chat history reloaded ('+recent.length+' recent messages)'); }catch(_){} })();
// ---- DURABLE SYSTEM / ACTION LOG (game events in the chat feed, survive refresh) -----------------------------------
// The GAME/ACTION lines (buy-ins, chamber banners, breach results, winner) used to be generated CLIENT-SIDE from state
// diffs (sysline()), so they were ephemeral and lost on refresh. Here the SERVER is the single source of truth: each
// public post-fact is written into the SAME persisted chat store the human "taunt" messages use (CHAT window + the
// append-only JSONL), tagged `kind:'sys'` with an `evkind` badge hint. They then flow out via /api/state's chat
// window AND /api/chat/history, interleaved with human chat in ts order, so a refresh replays them exactly as live.
// ANTI-EDGE: only events that are ALREADY public (a pot after a buy-in, a chamber banner carrying NO door signal, a
// breach AFTER the reveal, a winner) are ever written. A live choose-phase pick or per-door crowd is NEVER persisted.
// A `_sysSeen` set de-dupes so one real event is logged exactly once even though the watcher polls once per second.
const _sysSeen = new Set();
function pushSysLog(text, evkind, dedupeKey){
  if(!text) return;
  const key = dedupeKey || (evkind||'sys')+'|'+text;
  if(_sysSeen.has(key)) return;             // one event -> one persisted line
  _sysSeen.add(key);
  if(_sysSeen.size>400){ const it=_sysSeen.values(); for(let i=0;i<100;i++){ const v=it.next(); if(v.done)break; _sysSeen.delete(v.value); } }
  const ts=Date.now();
  // kind:'sys' is what the client branches on to render the muted/italic action style; evkind picks the 🎟️/👑 badge.
  // th:null so it carries no author identity; name:'' so it renders as a pure system line (never attributed to a user).
  const rec={ id:newMsgId(ts), kind:'sys', evkind:evkind||null, name:'', text:String(text), ts, th:null };
  CHAT.push(rec); while(CHAT.length>80)CHAT.shift();
  appendChatLog(rec);                       // DURABLE: same append-only JSONL + retention/boot window as human chat
}
// SERVER-SIDE game-event watcher. Runs once per second (from wsPushLoop, read-only — never mutates G), diffs the
// authoritative PUBLIC facts against the previous tick, and persists a sys line for each newly-public event. This
// mirrors the exact strings the client used to compute locally, but now as one durable source of truth. Formats the
// pot with the same k-suffix the client's fmtK uses so the stored text reads identically to the old live line.
let _sysPrev = null;
function _fmtKsrv(n){ n=Number(n)||0; return n>=1000 ? ((n/1000).toFixed(n>=10000?0:1)+'k') : (''+n); }
function sysLogWatch(){
  try{
    if(!G){ _sysPrev=null; return; }
    const now=Date.now();
    const rid = (G.roundId!=null)?String(G.roundId):'?';
    // Authoritative public phase + chamber (mirrors buildStatePayload / stateSignature; no door signal read here).
    let phase=G.phase, chamber=null;
    try{
      if(MODE==='fill' && G.phase==='running'){ const i=fillRunInfo(now); phase=i.phase; chamber=(i.chamber!=null?i.chamber:null); }
      else if(C.engine==='rmfill' && G.phase==='playing'){ const i=rmRunInfo(now); phase=i.phase; chamber=(i.chamber!=null?i.chamber:null); }
    }catch(_){ }
    const pot = realMoney()?((G._onchainPot||0)+(Number(JACKPOT_RVLT)||0)):(seatCount()*ENTRY);
    const prev=_sysPrev;
    // (1) BUY-IN: the pot grew while the round is still open to buys -> "a robber bought in". Public post-fact (the pot
    //     total is already in /api/state). Scoped by roundId+pot so each distinct pot level logs once. Only while the
    //     round is still filling/locking (never on a settle-time pot read). Mirrors the old client 'buy' sysline.
    if(prev && prev.rid===rid && pot>prev.pot && (phase==='filling'||phase==='locking'||G.phase==='filling'||G.phase==='lobby')){
      pushSysLog('a robber bought in · pot '+_fmtKsrv(pot)+' RVLT', 'buy', 'buy|'+rid+'|'+pot);
    }
    // (2) CHAMBER BANNER: a new chamber's choose window opened. Carries NO door-level signal (just the chamber number),
    //     so it is safe to persist the instant choosing begins. Mirrors the old client chamber-transition sysline.
    if(phase==='choose' && chamber!=null){
      pushSysLog('Chamber '+(chamber+1)+'. Pick a door, the crowded one gets caught.', null, 'chamber|'+rid+'|'+chamber);
    }
    // (3) BREACH: logged ONLY at reveal, after every pick is locked (anti-edge: never during choose). G.bust is the
    //     busted door index, G.bustN the caught count, survived the remainder. Mirrors the old client 'Breach at' line.
    if(phase==='reveal' && chamber!=null && G.resolved && G.resolved[chamber] && G.bust!=null){
      const survived=(G.counts||[]).reduce((a,c,i)=>a+(i===G.bust?0:c),0);
      pushSysLog('Breach at '+((G.routes&&G.routes[G.bust]!=null)?G.routes[G.bust]:(G.bust+1))+'. '+(G.bustN||0)+' caught, '+survived+' slip through.', null, 'breach|'+rid+'|'+chamber+'|'+G.bust);
    }
    // (4) OVERTIME / SUDDEN DEATH breach: same post-reveal safety, mirrors the client OT breach sysline.
    if(G.ot && G.otPhase==='reveal' && G.otRevealed && G.otBust!=null){
      const otSurv=(G.otSurvivors!=null?G.otSurvivors:aliveCount());
      pushSysLog('Door '+((G.otBust||0)+1)+' blown, '+(G.otCaught||0)+' down, '+otSurv+' left.', null, 'otbreach|'+rid+'|'+(G.otRound||0)+'|'+G.otBust);
    }
    // (5) WINNER: the round ended with a champion resolved. Public final fact. Mirrors the old client 'win' sysline.
    if((G.phase==='ended'||phase==='ended'||G.done) && G.champ){
      if(G.champ.none){ pushSysLog('Vault sealed. Nobody walked.', null, 'win|'+rid+'|none'); }
      else if(G.champ.name){ pushSysLog(String(G.champ.name)+' took the vault.', 'win', 'win|'+rid+'|'+G.champ.name); }
    }
    _sysPrev = { rid, pot };
  }catch(_){ /* never let the watcher disturb the push loop */ }
}
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
  // FIX 4 (fairness): NAMESPACE every draw label by the round id (and the chamber, already folded in as G.cur). The
  // underlying prng() is already seeded with (seed, roundId, key), so cross-round collisions were not actually
  // reachable — but prefixing the CACHE KEY with the round id too makes each stream provably unique per round and
  // closes the door on any future refactor that reuses the per-round _streams map, or on a label (e.g. 'forcedbust')
  // repeating across rounds. Player/chamber scoping is carried in the label the caller passes (e.g. 'default:'+id,
  // 'ot:'+round+':'+id) and by G.cur; the round id prefix here guarantees the top-level stream identity is unique.
  const key = String(G.roundId) + '|' + (G.cur==null?'x':G.cur) + ':' + label;
  if(!G._streams[key]) G._streams[key] = prng(G.seed, G.roundId, key);
  return G._streams[key]();
}
function drandInt(label, n){ return Math.floor(draw(label) * n); }
function aliveList(){ return Object.entries(G.players).filter(([,p])=>p.alive&&!p.left); }
function aliveCount(){ return aliveList().length; }
function seatCount(){ return Object.values(G.players).filter(p=>!p.left).length; }
function countsNow(){ const c=(G.routes||[]).map(()=>0); aliveList().forEach(([,p])=>{ if(p.pick!=null&&p.pick<c.length)c[p.pick]++; }); return c; }
function player(tok){ return tok&&G&&G.players[tok]; }
// SEAT-TO-SESSION BINDING (critical fix). A paid player's roster entity (G.players[...]) is keyed by the token that
// seated it ('w:'+addr.toLowerCase()). A viewer's seat must resolve even if their exact session token is not that key
// (e.g. a case/strand drift), so we also match a roster entity whose OWNER maps to the SAME wallet ADDRESS as the
// viewer, but ONLY for a SIWE-VERIFIED session that has proven control of that address (never for an unproven token).
// Returns the array of roster entity ids this viewer owns. Never widens who can pick: it requires proof of the address.
function viewerAddr(tok){ const r=tok&&REG[tok]; return (r&&r.verified&&r.address)?String(r.address).toLowerCase():null; }
function seatIdsForViewer(tok){
  if(!tok||!G||!G.players) return [];
  const direct=Object.keys(G.players).filter(id=>G.players[id].owner===tok);
  if(direct.length) return direct;
  const a=viewerAddr(tok); if(!a) return [];   // address fallback requires a SIWE-verified session (proof of control)
  return Object.keys(G.players).filter(id=>{ const p=G.players[id]; if(!p||!p.owner) return false; const oa=escrow.addrOfToken(p.owner); return oa && oa.toLowerCase()===a; });
}
// The single roster entity a viewer picks against (their primary ticket). Resolves by exact token, then by proven
// address (seat-to-session binding), so a verified buyer can always pick their own seat even on a token-key drift.
function primarySeatForViewer(tok){ if(!tok||!G||!G.players) return null; if(G.players[tok]) return G.players[tok]; const ids=seatIdsForViewer(tok); if(!ids.length) return null; const prim=ids.find(id=>id===tok)||ids[0]; return G.players[prim]||null; }
// AWAY AUTOPILOT: a verified human is "present" while their tab polls /api/state (or they pick). If they go quiet for
// AWAY_MS (tab closed / walked off), we treat them as away and auto-play ALL their tickets (primary + extras) at random
// from the committed seed, so their entry still competes for the pot and the round never stalls. They resume manual
// control the instant they pick again. (Extras are always auto; this only adds the primary when the owner is away.)
const AWAY_MS=30000;
function stampSeen(tok){ if(tok&&REG[tok]) REG[tok].lastSeen=Date.now(); }
function isAway(tok){ const r=tok&&REG[tok]; if(!r) return false; const s=r.lastSeen||0; return s>0 && (Date.now()-s)>AWAY_MS; }
// FIX 3: SLOW PRUNE of the in-memory REG map. REG grows unbounded (one entry per guest/wallet session ever seen) and
// rmEscrowLifecycle iterates Object.keys(REG) firing an escrow.addrOfToken/ticketsOf read per w: entry every ~3s, so
// unbounded growth is also an RPC-cost amplifier. Conservatively drop ONLY entries that are clearly dead: lastSeen
// older than 2x AWAY_MS AND not seated in the live round AND not a verified wallet backing an active auto-buy. We NEVER
// drop a current-round participant or an entry with an armed auto-buy (both are load-bearing for settle/seat/relay).
// REG is purely in-memory (no persistence), so a pruned stale session simply re-registers on its next request.
const REG_PRUNE_MS=2*AWAY_MS;   // 60s idle floor before an unseated entry is eligible
function _liveRoundOwnerTokens(){
  const set=new Set();
  try{ if(G&&G.players){ for(const id in G.players){ const p=G.players[id]; if(p&&!p.bot&&!p.left&&p.owner) set.add(p.owner); } } }catch(_){}
  return set;
}
function pruneReg(){
  try{
    const now=Date.now();
    const liveOwners=_liveRoundOwnerTokens();
    // addresses with an active (not-expired, rounds-left) auto-buy: keep their w: token so the relayer path stays intact.
    const abAddrs=new Set();
    try{ for(const k in AUTOBUY_STORE){ const a=AUTOBUY_STORE[k]; if(a && (a.roundsLeft==null||a.roundsLeft>0) && (!a.deadline||now<=a.deadline*1000)) abAddrs.add(String(a.player||k).toLowerCase()); } }catch(_){}
    let dropped=0;
    for(const tok in REG){
      const r=REG[tok]; if(!r) continue;
      if(liveOwners.has(tok)) continue;                                   // seated in the live round -> never drop
      const seen=r.lastSeen||0;
      if(!(seen>0 && (now-seen)>REG_PRUNE_MS)) continue;                  // seen recently (or never stamped yet) -> keep
      const addr=(r.address?String(r.address).toLowerCase():(tok.indexOf&&tok.indexOf('w:')===0?tok.slice(2).toLowerCase():null));
      if(addr && abAddrs.has(addr)) continue;                            // backs an armed auto-buy -> keep
      delete REG[tok]; dropped++;
    }
    if(dropped) try{ console.log('[vault-standoff] REG prune: dropped '+dropped+' stale session(s); '+Object.keys(REG).length+' remain'); }catch(_){}
  }catch(_){ /* never let housekeeping throw */ }
}
setInterval(pruneReg, 60000);
// ---- READY-CHECK (hybrid presence classification; display + auto-play gate, NEVER settle/payout) ---------------
// CHECKIN maps a round id -> Set of checked-in seat-owner ADDRESSES (lowercased). A seated player is PRESENT for a round
// if they checked in (explicit button OR client auto-check-in when confident); otherwise AWAY -> auto-played from the
// committed seed at resolve (same seed mechanic as before, just gated on check-in instead of only lastSeen). We also
// KEEP the mid-game lastSeen safety: a checked-in player who then goes idle for a chamber still auto-plays that chamber
// so a mid-round disconnect never stalls the game. Low-stakes: not-checked-in only means seed-auto-play, no funds moved.
const CHECKIN={};   // { [roundId]: Set(addrLower) }
function _roundKey(){ try{ return (G && G.roundId!=null) ? String(G.roundId) : null; }catch(_){ return null; } }
function addrOfOwner(owner){ try{ if(!owner) return null; const r=REG[owner]; if(r&&r.address) return String(r.address).toLowerCase(); const a=escrow.addrOfToken(owner); return a?String(a).toLowerCase():null; }catch(_){ return null; } }
// STRANDED-FILL FIX (attribution independent of receipt timing + REG lifetime): every wallet that armed an AUTO-BUY
// is a KNOWN paid-or-paying wallet whose on-chain ticketsOf must always be attributed in the seat/reconcile passes,
// regardless of (a) when its relayer tx RECEIPT resolves (the parallel batch commits rangeSpent off the critical
// path, so a buyer can land on-chain BEFORE its REG seat is refreshed) or (b) whether pruneReg has dropped its REG
// w: session (an exhausted-budget record drops out of pruneReg's keep-set, de-enumerating the address the moment
// roundsLeft hits 0 on its LAST round — exactly the round-180 strand). Enumerating AUTOBUY_STORE here makes every
// auto-buy payer attributable by its ADDRESS alone, so the shortfall reconcile never counts a paid auto-buy ticket
// as unseated. Returns lowercased payer addresses for every stored auto-buy record (active OR just-exhausted — we
// still want to attribute the final round it just paid into). Seating is still gated on ticketsOf>0 at the call site,
// so a wallet that never actually paid is never seated by being listed here.
function autobuyPayerAddrs(){ const out=[]; try{ for(const k in AUTOBUY_STORE){ const a=AUTOBUY_STORE[k]; const addr=String((a&&a.player)||k||'').toLowerCase(); if(/^0x[0-9a-f]{40}$/.test(addr)) out.push(addr); } }catch(_){} return out; }
// FIX 2 (red-team): does this wallet have a GENUINE buy intent for the current/next round? Used to gate /api/gas-drip
// so the relayer only tops up gas for wallets actually about to play — not any SIWE-verified wallet (free-gas farming
// from many throwaway wallets). Intent = either (a) a persisted seat-candidate for a currently-relevant round
// (RM_CUR / RM_BUY for rmfill, or the live G round), reusing the existing seat-candidate machinery; OR (b) an active,
// non-expired, sig-verified auto-buy record (or one with a landed rangeSpent). Pure read over in-memory state.
function hasActiveBuyIntent(addr){
  try{
    const a=String(addr||'').toLowerCase();
    if(!/^0x[0-9a-f]{40}$/.test(a)) return false;
    // (a) seat candidate for a currently-relevant round
    const rounds=[];
    if(RM_CUR!=null) rounds.push(RM_CUR);
    if(RM_BUY!=null && RM_BUY!==RM_CUR) rounds.push(RM_BUY);
    if(G && G.rmId!=null && rounds.indexOf(G.rmId)<0) rounds.push(G.rmId);
    for(const rid of rounds){
      const cands=seatCandidatesFor(rid)||[];
      for(const c of cands){ if(String(c||'').toLowerCase()===a) return true; }
    }
    // (b) active sig-verified (or already-landed) auto-buy record for this wallet
    const rec=AUTOBUY_STORE[a];
    if(rec){
      const unexpired = !(rec.deadline) || (Date.now() <= rec.deadline*1000);
      const landed = Array.isArray(rec.rangeSpent) && rec.rangeSpent.length>0;
      const budgetLeft = (rec.roundsLeft==null || rec.roundsLeft>0);
      if(unexpired && budgetLeft && (rec.sigVerified===true || landed)) return true;
    }
    return false;
  }catch(_){ return false; }
}
function markCheckedIn(roundId, addr){ try{ const rk=String(roundId); const a=String(addr||'').toLowerCase(); if(!/^0x[0-9a-f]{40}$/.test(a)) return false; (CHECKIN[rk]||(CHECKIN[rk]=new Set())).add(a); return true; }catch(_){ return false; } }
function isCheckedIn(roundId, addr){ try{ const s=CHECKIN[String(roundId)]; const a=String(addr||'').toLowerCase(); return !!(s&&s.has(a)); }catch(_){ return false; } }
function pruneCheckins(){ try{ const keep=_roundKey(); for(const k of Object.keys(CHECKIN)){ if(k!==keep) delete CHECKIN[k]; } }catch(_){} }
// Is a SEATED primary seat PRESENT for the current round? Present = checked-in for this round AND not idle past AWAY_MS
// right now. Checked-in gives the explicit/auto confidence; the live lastSeen check keeps a mid-round disconnect from
// being treated as present for a chamber it has gone silent through.
function seatPresent(owner){ try{ if(!owner) return false; const rk=_roundKey(); if(!rk) return false; const a=addrOfOwner(owner); if(!a) return false; return isCheckedIn(rk, a) && !isAway(owner); }catch(_){ return false; } }
// ROSTER STATS (#6 / #3 display): a compact live breakdown of the ALIVE human robbers in the round. playing = present
// (checked-in + live); away = seated-but-auto (not present); locked = have a pick committed this chamber; total = alive
// human tickets. Bots are excluded (none in real-money rounds anyway). Display only; never touches settle/payout.
function rosterStats(){
  try{
    if(!G||!G.players) return null;
    let total=0, playing=0, away=0, locked=0;
    aliveList().forEach(([,p])=>{ if(p.bot||!p.owner) return; total++;
      if(seatPresent(p.owner)) playing++; else away++;
      if(p.pick!=null) locked++;
    });
    return { total, playing, away, locked };
  }catch(_){ return null; }
}
// CHOOSE ROSTER (names only, NO door): the alive robbers in the round by DISPLAY IDENTITY so the client can name
// EVERY robber in the chamber, not just the ones who have spoken in chat. ANTI-EDGE INVARIANT: this carries NO
// pick/door/per-door signal whatsoever — only {name, aid, av}. It is emitted ONLY in the choose-phase crowd block,
// never with any door data, so a headless client learns nothing it could optimize against. aid = tokenHash(owner)
// so it matches the viewer's own `me.aid` (client "you" highlight) and keys avatar/color on the author, not the name.
// Bots carry no owner -> aid falls back to a stable per-entity hash so duplicate bot names never collide. Capped so
// a huge field can't bloat the payload; the TRUE total rides alongside (see crowd.aliveTotal) so the count stays honest.
function chooseRoster(cap){
  cap = cap||60;
  try{
    if(!G||!G.players) return null;
    const out=[];
    const av=aliveList();
    for(let i=0;i<av.length && out.length<cap;i++){
      const id=av[i][0], p=av[i][1];
      const tok=p.owner||null;
      const aid = tok ? tokenHash(tok) : tokenHash('seat:'+id);   // stable per-author id; NEVER the raw token/address
      const name = tok ? displayNameFor(tok, p.name) : (p.name||'anon');
      const av2 = tok ? (displayAvatarFor(tok)||null) : null;
      const row = { name, aid };
      if(av2) row.av=av2;
      out.push(row);
    }
    return out;   // NO door/pick field is ever attached here (anti-edge)
  }catch(_){ return null; }
}
// REVEAL IDENTITIES (post-decision, anti-edge-safe): the per-player outcome for the JUST-RESOLVED chamber — who chose
// which door, who was caught vs survived. Emitted ONLY inside the reveal branch, by which point every pick is LOCKED,
// so exposing picks here leaks nothing a client could act on (mirrors the reveal-only revealCounts guarantee). A
// participant for chamber `c` is any non-withdrawn robber who was alive ENTERING this chamber: survivors are still
// alive now; the caught were stamped p.bustCh===c in resolve(). Prior-chamber casualties keep a stale bustCh!==c, so
// they are excluded. caught = stamped this chamber. Capped for payload size with totals retained by the caller.
function revealPlayers(c, cap){
  cap = cap||60;
  try{
    if(!G||!G.players) return null;
    const out=[];
    const ids=Object.keys(G.players);
    for(let i=0;i<ids.length && out.length<cap;i++){
      const id=ids[i], p=G.players[id];
      if(!p || p.left) continue;
      const caughtHere = (p.busted===true && p.bustCh===c);
      const survived = (p.alive===true);
      if(!caughtHere && !survived) continue;   // busted in a PRIOR chamber -> not a participant of THIS reveal
      if(p.pick==null) continue;               // no pick this chamber (shouldn't happen post-resolve) -> skip
      const tok=p.owner||null;
      const aid = tok ? tokenHash(tok) : tokenHash('seat:'+id);
      const name = tok ? displayNameFor(tok, p.name) : (p.name||'anon');
      const av2 = tok ? (displayAvatarFor(tok)||null) : null;
      const row = { name, aid, door:p.pick, caught:caughtHere };
      if(av2) row.av=av2;
      out.push(row);
    }
    return out;
  }catch(_){ return null; }
}
// #5 ONLINE COUNT: how many registered viewers were seen within the presence window. Cheap O(reg) scan over lastSeen
// (refreshed by the HTTP poll, picks, and the WS presence ping). Display only; it never gates play or settle.
const WATCH_WINDOW_MS=45000;
function watchingCount(){ let n=0; const now=Date.now(); for(const k in REG){ const r=REG[k]; if(r && r.lastSeen && (now-r.lastSeen)<WATCH_WINDOW_MS) n++; } return n; }
// #6 TYPING INDICATOR: a short-lived map of display name -> expiry ts. A client sends {type:'typing'} over the WS when
// it is composing; we record the sender's name for TYPING_TTL_MS. typingNames() returns the live (unexpired) names,
// excluding the caller's own, deduped, capped so the payload stays tiny. Pure chat sugar: no play/settle coupling.
const TYPING={}; const TYPING_TTL_MS=4000;
function noteTyping(name){ if(!name) return; const nm=String(name).slice(0,40); TYPING[nm]=Date.now()+TYPING_TTL_MS; }
function typingNames(exclude){ const now=Date.now(); const out=[]; for(const nm in TYPING){ if(TYPING[nm]<=now){ delete TYPING[nm]; continue; } if(exclude && nm===exclude) continue; out.push(nm); } return out.slice(0,5); }
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
// mechanical edge to grind, so a bot's only lever is tireless VOLUME (already EV-negative). Track distinct rounds
// each wallet ENTERS per rolling hour; WARN-log on a high threshold and surface in /api/admin/metrics. A legit
// high-roller is not an attacker, so we never auto-ban or alter play.
const VEL = { seen:new Set(), hits:Object.create(null), flagged:Object.create(null), WINDOW_MS:3600000, FLAG:40 };
function recordWalletEntry(addr, roundId){
  if(!addr || roundId==null) return; addr=String(addr).toLowerCase();
  const key=addr+':'+String(roundId); if(VEL.seen.has(key)) return; VEL.seen.add(key);
  if(VEL.seen.size>20000) VEL.seen.clear();
  const now=Date.now(); const arr=(VEL.hits[addr]=(VEL.hits[addr]||[]).filter(t=>now-t<VEL.WINDOW_MS)); arr.push(now);
  if(arr.length>=VEL.FLAG && !VEL.flagged[addr]){ VEL.flagged[addr]=now;
    console.error('[vault-standoff] HIGH-VOLUME wallet '+addr+' entered '+arr.length+' rounds/hr (possible grinding agent; peer-pot+5% rake keep it EV-negative — flagged for review, play unchanged)');
  } else if(arr.length<VEL.FLAG && VEL.flagged[addr] && (now-VEL.flagged[addr])>VEL.WINDOW_MS){ delete VEL.flagged[addr]; }
}
function velocityFlags(){ const now=Date.now(); const out=[]; for(const a in VEL.hits){ const n=VEL.hits[a].filter(t=>now-t<VEL.WINDOW_MS).length; if(n>=VEL.FLAG) out.push({wallet:a, roundsLastHour:n, since:VEL.flagged[a]||null}); } return out.sort((x,y)=>y.roundsLastHour-x.roundsLastHour); }
function seatWalletCount(tok,n){ if(!G||!REG[tok])return; n=Math.max(0,Math.min(G._walletCap||walletCap(),parseInt(n,10)||0));   // Sybil policy: hard per-wallet seat cap (computed ceil(pct% * roundTarget), fixed for the round)
  if(n>0){ try{ recordWalletEntry((REG[tok]&&REG[tok].address)||escrow.addrOfToken(tok), G.roundId); }catch(_){} }   // anti-agent: log distinct-round entry (deduped), monitoring only
  // B1 MONEY-SAFETY (real-money rmfill only): the on-chain buy-in stays OPEN until the signer's lockRound lands, so a
  // wallet whose buy confirms during the closing burst is CHARGED on-chain. The old ROUND-TOTAL cap (C.cap) stopped
  // seating at the target, leaving those paid tickets UNSEATED (they could never win; refund only on a voided round).
  // In rmfill we therefore LIFT the round-total cap so EVERY paid on-chain ticket is seated even past target (routesFor
  // + thinDoorFloor scale the field and resolve() still converges to a single champion; the lock-gate reconciles on the
  // real on-chain total vs summed ticketsOf, which still balances). The PER-WALLET cap above (n clamped to G._walletCap
  // /walletCap) is UNCHANGED, so the Sybil guard holds. Clock + fake-chip paths keep the round-total cap as before.
  const _rmUncapped = (C.engine==='rmfill');
  for(let k=0;k<n;k++){ const id=k===0?tok:(tok+'#'+k); if(!G.players[id]){ if(!_rmUncapped && C.cap&&seatCount()>=C.cap)break; G.players[id]={name:REG[tok].name+(k?(' #'+(k+1)):''),bot:false,auto:k>0,owner:tok,alive:true,pick:null,pre:REG[tok].pre,left:false,busted:false,win:false}; } }
  // PRUNE extras ABOVE the current count ONLY while still filling. Once the round locks the roster is frozen, so a later
  // re-seat (or a transient on-chain read) can never remove a live player's seat mid-game (the stuck-spectator guard).
  if(G.phase==='filling') Object.keys(G.players).forEach(id=>{ if(G.players[id].owner===tok){ const k=id===tok?0:parseInt(id.split('#')[1],10); if(k>=n) delete G.players[id]; } });
  // FIX 2: move the counter SYNCHRONOUSLY the instant a seat lands (don't wait for the 3s throttled on-chain sync).
  // Recompute ticketsSold = total seated tickets across all real w: wallets in this round. The throttled ticketsOf
  // sync then just reconciles. Only touch the counter while G is the filling round these seats belong to.
  try{
    if(G && G.phase==='filling'){
      var _sold=0; var _seen={}; Object.keys(G.players).forEach(function(pid){ var p=G.players[pid]; if(p&&!p.bot&&p.owner&&String(p.owner).indexOf('w:')===0){ _sold++; } });
      if(_sold>G.ticketsSold){ G.ticketsSold=_sold; try{ recordFillSample(_sold); }catch(_){} }
    }
  }catch(_){}
}
function resolve(c){
  G.resolved[c]=true;
  const av=aliveList();
  // a lone survivor reaching any chamber WINS outright (never self-bust)
  if(av.length<=1){ G.done=true; G.champ=av[0]?{name:av[0][1].name,you:!av[0][1].bot,owners:[av[0][1].owner].filter(Boolean)}:{none:true,owners:[]}; return; }
  // absent-player default door is deterministic: prechoice if set, else a seeded draw (NOT Math.random).
  av.forEach(([id,p])=>{ if(p.pick==null){ p.pick=(p.pre&&p.pre[c]!=null&&p.pre[c]<G.routes.length)?p.pre[c]:drandInt('default:'+id,G.routes.length); } });
  const cnt=countsNow();
  // FIX (anti-cheat): the busting ("most crowded") door is chosen by a SEEDED draw among ALL doors tied at the max
  // count, not the lowest index. The old low-index rule gave "always pick the highest door" a ~75% edge in thin fields;
  // now a tie is resolved uniformly from the committed seed (label 'tie:'+chamber), so it stays replayable but unbiased.
  let maxv=cnt[0]; for(let i=1;i<cnt.length;i++) if(cnt[i]>maxv)maxv=cnt[i];
  const _tied=[]; for(let i=0;i<cnt.length;i++) if(cnt[i]===maxv) _tied.push(i);
  let mx=(_tied.length>1)?_tied[drandInt('tie:'+c,_tied.length)]:_tied[0];
  let n=0; av.forEach(([,p])=>{ if(p.pick===mx){ p.alive=false; p.busted=true; p.bustCh=c; n++; } });
  // degenerate no-bust case (all on different doors): force one bust via a seeded draw, not Math.random.
  if(n===0 && av.length>1){ const v=av[drandInt('forcedbust',av.length)][1]; v.alive=false; v.busted=true; v.bustCh=c; n=1; }
  // WINNER-TAKES-ALL: a chamber must NEVER wipe the whole field. If the doomed door caught everyone still in,
  // the seed spares exactly one (deterministic + replayable) so the round always yields a single champion.
  if(n>0 && aliveList().length===0){ const sp=av.filter(([,p])=>p.busted); const keep=sp[drandInt('spare:'+c,sp.length)][1]; keep.alive=true; keep.busted=false; keep.bustCh=null; n--; }
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
    // READY-CHECK AUTOPILOT: a human PRIMARY seat is auto-played (from the seed) unless it is PRESENT for this round,
    // i.e. checked in (explicit button or client auto-check-in when confident) AND not idle past AWAY_MS right now. A
    // present player makes their own /api/pick; a not-checked-in or mid-round-idle seat auto-plays like the extras.
    // pl.away is the surfaced flag (true = being auto-played); cleared the instant they pick (/api/pick sets away=false).
    if(!pl.bot && !pl.auto && pl.owner){ pl.away = !seatPresent(pl.owner); }
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
function enterChamber(c){ G.cur=c; G.routes=R.slice(0,routesForAlive(aliveCount())); aliveList().forEach(([,pl])=>{ pl.pick=null; });
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
    // FIX (anti-cheat): seeded tie-break among max-count doors (was low-index).
    let maxv=cnt[0]; for(let i=1;i<OT_DOORS;i++) if(cnt[i]>maxv)maxv=cnt[i];
    const _tied=[]; for(let i=0;i<OT_DOORS;i++) if(cnt[i]===maxv) _tied.push(i);
    let mx=(_tied.length>1)?_tied[drandInt('ottie:'+round,_tied.length)]:_tied[0];
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
  // FIX (anti-cheat): seeded tie-break among max-count doors (was low-index 'most-crowded').
  let maxv=cnt[0]; for(let i=1;i<OT;i++) if(cnt[i]>maxv)maxv=cnt[i];
  const _tied=[]; for(let i=0;i<OT;i++) if(cnt[i]===maxv) _tied.push(i);
  let mx=(_tied.length>1)?_tied[drandInt('ottie:'+r,_tied.length)]:_tied[0];
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
// BOOT RECONCILE (money-critical): on restart, RESUME the live pot-holding round instead of skipping past it.
// The old logic only scanned FORWARD from the stored nextId to the first never-written (None) slot and opened there -
// which jumped PAST any already-Open round that held a pot (the orphaned-buy bug: paid round shows 0/3 forever and
// refunds at its ~23h deadline). Now we scan a bounded window that INCLUDES ids BELOW the stored nextId, classify each
// round, and if ANY Open-with-pot round is still within its on-chain deadline we RESUME the EARLIEST such round as the
// live round (set RM_CUR so the tick attaches G to it, never allocating a fresh empty id). Only when NO resumable
// Open-with-pot round exists do we fall back to the old behavior (open at the first never-written slot).
// Guards: escrow-on only; an RPC null aborts and retries next tick (never guesses); idempotent; never resumes a
// settled/void (status>=3) round or a past-deadline round (left to the settle-watcher to void/refund).
let RM_RECONCILED=false, RM_RECONCILING=false;
async function rmReconcileNextId(){
  if(RM_RECONCILED || RM_RECONCILING) return;
  RM_RECONCILING=true;
  try{
    if(!escrow.isOn()){ RM_RECONCILED=true; return; }
    const nowSec=Math.floor(Date.now()/1000);
    // window: include orphans below the stored nextId. From max(1, nextId-64) through nextId + a forward margin.
    const lo=Math.max(1, RM_NEXT_ID-64), hi=RM_NEXT_ID+8;
    let resumeId=null, resumeKnown=null;     // EARLIEST FULLY-ACCOUNTABLE Open-with-pot within deadline (+ its known seats)
    let firstNone=null;                      // EARLIEST never-written slot at/after lo (fallback open target)
    let maxWritten=0;                        // highest id with status!=0 (to keep nextId monotonic)
    let anyNull=false;
    // ACCOUNTABILITY: a round is resumable ONLY if the server KNOWS every buyer - i.e. the sum of on-chain ticketsOf
    // over the addresses we know for that round (persisted SEATCAND candidates + any REG w: entries) EQUALS the round's
    // on-chain total tickets (= round(pot / entry)). Resuming a round with an UNKNOWN buyer is unsafe: it shows pot-
    // without-count, can't fill cleanly, and at SETTLE the server can't pay a winner whose address it never captured.
    // Not-accountable open rounds are SKIPPED here and refund at their on-chain deadline (safe).
    const _candAddrsFor=(id)=>{ const set={}; try{ seatCandidatesFor(id).forEach(a=>{ if(/^0x[0-9a-f]{40}$/.test(String(a||'').toLowerCase())) set[String(a).toLowerCase()]=1; }); }catch(_){}
      try{ Object.keys(REG).forEach(tok=>{ if(tok.startsWith('w:')){ const a=escrow.addrOfToken(tok); if(a) set[a.toLowerCase()]=1; } }); }catch(_){}
      // STRANDED-FILL FIX: include every AUTO-BUY payer address in the boot accountability set so a round filled purely
      // by the relayer (whose REG sessions are gone after a restart) is still seen as fully accountable -> resumable
      // (play or deadline-void-refund) instead of SKIPPED. ticketsOf>0 is still required for a buyer to count.
      try{ autobuyPayerAddrs().forEach(a=>{ set[a]=1; }); }catch(_){} return Object.keys(set); };
    const _accountable=async(id, r)=>{
      // total tickets on-chain = round(pot / entry). Use the ROUND'S OWN entry (fixed at its open), not the live peg.
      let pot=0n, entry=0n; try{ pot=BigInt(r.pot||0); }catch(_){} try{ entry=BigInt(r.entry||0); }catch(_){}
      if(entry<=0n || pot<=0n) return { ok:false, total:0, known:0 };
      const total=Number(pot / entry);   // integer division; entry is the per-ticket RVLT, pot is total RVLT in the round
      if(!(total>0)) return { ok:false, total:0, known:0 };
      const addrs=_candAddrsFor(id);
      let known=0; const seats=[];
      for(const a of addrs){ let n=0; try{ n=Number(await escrow.ticketsOf(id, require('ethers').getAddress(a)).catch(()=>0)); }catch(_){ n=0; } if(n>0){ known+=n; seats.push({addr:a, n}); } }
      return { ok:(known===total), total, known, seats };
    };
    for(let id=lo; id<=hi; id++){
      const r=await escrow.readRound(id).catch(()=>null);
      if(r===null){ anyNull=true; continue; }               // tolerate a single bad read; don't let it hide a resumable round
      const st=Number(r.status);
      if(st!==0 && id>maxWritten) maxWritten=id;
      if(st===0){ if(firstNone==null && id>=RM_NEXT_ID) firstNone=id; continue; }   // never-written slot (only count fallback slots at/after nextId)
      if(st===1 && resumeId==null){                          // OPEN (earliest first)
        let pot=0n; try{ pot=BigInt(r.pot||0); }catch(_){ pot=0n; }
        const dl=Number(r.deadline||0);
        const alive=(dl===0) || (dl>nowSec);                 // within deadline (0 = no deadline set yet)
        if(pot>0n && alive){
          const acc=await _accountable(id, r);               // only resume if every buyer is known
          if(acc.ok){ resumeId=id; resumeKnown=acc; }
          else { try{ console.log('[vault-standoff] rmfill SKIP open round '+id+' (not accountable: known '+acc.known+' of '+acc.total+' tickets; unknown buyer); will refund at deadline'); }catch(_){} }
        }
      }
      // st>=2 (committed/settled/void): skip (committed is mid-play; settle-watcher handles it).
    }
    // if the scan hit a null AND found nothing resumable, don't finalize on possibly-incomplete data: retry next tick.
    if(resumeId==null && firstNone==null && anyNull) return;
    if(resumeId!=null){
      // RESUME the fully-accountable pot-holding round. Attach G here (tick skips rmAllocId because RM_CUR is set) and
      // make the lifecycle treat it as already-open so it can still lock/commit/settle normally.
      RM_CUR=resumeId;
      const want=Math.max(RM_NEXT_ID, maxWritten+1, resumeId+1);
      if(want!==RM_NEXT_ID){ RM_NEXT_ID=want; rmSaveNextId(RM_NEXT_ID); }
      ensureRoundSeed(resumeId);                             // bind the seed so a later commit hash matches
      ESC_OPENED.add(resumeId);                              // on-chain Open already -> mark opened so we don't re-open
      try{ const rr=await escrow.readRound(resumeId).catch(()=>null); if(rr && Number(rr.status)>=2){ ESC_COMMITTED.add(resumeId); RM_LOCKED.add(resumeId); } }catch(_){}
      rmNewGame(resumeId);                                   // G now attaches to the real pot-holding round
      try{ if(G) G._resumedAccountable=true; }catch(_){}     // tag: this resumed round's full roster is known (settle-safe)
      // SEAT its KNOWN buyers now so `sold` reflects the real on-chain count immediately (gated on ticketsOf>0 inside).
      try{ if(resumeKnown && resumeKnown.seats){ for(const s of resumeKnown.seats){ await seatPaidAddress(resumeId, require('ethers').getAddress(s.addr)); } } }catch(_){}
      try{ console.log('[vault-standoff] rmfill RESUMED live round '+resumeId+' (Open, accountable: '+resumeKnown.known+'/'+resumeKnown.total+' tickets known); nextId -> '+RM_NEXT_ID); }catch(_){}
      RM_RECONCILED=true; return;
    }
    // no resumable round -> open a FRESH round at the first never-written slot (stale orphans refund at their deadlines).
    let target=(firstNone!=null)?firstNone:Math.max(RM_NEXT_ID, maxWritten+1);
    if(target!==RM_NEXT_ID){ RM_NEXT_ID=target; rmSaveNextId(RM_NEXT_ID); try{console.log('[vault-standoff] rmfill reconciled nextId -> '+target+' (no resumable open-with-pot round)');}catch(_){} }
    RM_RECONCILED=true;
  }catch(_){ /* leave unreconciled; retry next tick */ }
  finally{ RM_RECONCILING=false; }
}
// rmfill round bookkeeping (spans games, so module-scope). G holds the CURRENT round only.
let RM_CUR=null;            // the current round id (filling or playing); null before the first open
let RM_BUY=null;            // the round id a buy-in targets (the earliest still-Open round = the next pre-open)
// ITEM C: cached fill (sold/target) of the PRE-OPENED NEXT round, read on the same ~3s sync cadence ONLY while the
// current game is playing (RM_BUY != RM_CUR). Lets the client show an active next-heist buy + progress bar mid-game
// WITHOUT a hot RPC loop. Keyed by id so a stale read is never shown after the rollover advances RM_BUY.
let RM_NEXT_FILL=null;      // { id, sold, target } or null when there is no separate next round to buy into
const RM_SENTINEL={};       // id -> on-chain sentinel lockTime (for restart-resilient commit timing)
let _rmPlaySeatFor=null;    // round id we've already fired the lock-boundary roster re-seat for (idempotent, once per round)

// ROSTER FINALIZATION AT LOCK. The throttled 3s filling-sync seats paid buyers into G.players, but on a small-target
// round the filling->locking flip can happen BEFORE the last sync's RPC reads resolve, so a buyer could be missing
// from the play roster (their pick screen never shows; the round resolves without them). This fires ONE extra seating
// pass the instant the round enters 'locking', re-reading every known REG w: wallet + every persisted seat-candidate
// for this round and seating each confirmed (ticketsOf>0) payer into G.players. It is same-round gated and runs only
// before the round ends, so it can never seat into the wrong round. It ADDS entities only; it never touches ticketsSold
// (frozen at lock) and never bypasses settle's on-chain isParticipant gate, so no non-payer can be paid. Idempotent.
function rmSeatRosterForPlay(id){
  try{
    if(_rmPlaySeatFor===id) return; _rmPlaySeatFor=id;
    if(!escrow.isOn()) return;
    const toCount=[]; const seen={};
    Object.keys(REG).forEach(tok=>{ if(REG[tok].active && tok.startsWith('w:')){ const a=escrow.addrOfToken(tok); if(a){ toCount.push([tok,a]); seen[a.toLowerCase()]=1; } } });
    seatCandidatesFor(id).forEach(a=>{ if(!/^0x[0-9a-f]{40}$/.test(a)) return; if(seen[a]) return; seen[a]=1;
      var ck; try{ ck=require('ethers').getAddress(a); }catch(_){ return; } toCount.push(['w:'+a, ck]); });
    // STRANDED-FILL FIX: also enumerate every AUTO-BUY payer address (independent of REG lifetime / receipt timing).
    autobuyPayerAddrs().forEach(a=>{ if(seen[a]) return; seen[a]=1; var ck; try{ ck=require('ethers').getAddress(a); }catch(_){ return; } toCount.push(['w:'+a, ck]); });
    Promise.all(toCount.map(([tok,a])=>escrow.ticketsOf(id,a).then(n=>({tok,a,n})).catch(()=>({tok,a,n:0}))))
      .then(rows=>{ if(!(G&&G.rmId===id&&!G.done&&G.phase!=='ended'))return; rows.forEach(({tok,a,n})=>{ if(n>0){
          if(!REG[tok]){ REG[tok]={ name:'Robber '+String(a).slice(2,6), pre:null, active:true, tickets:1, verified:true, address:a }; }
          else { REG[tok].active=true; if(!REG[tok].address) REG[tok].address=a; }
          seatWalletCount(tok,n); } }); }).catch(()=>{});
  }catch(_){}
}

function rmThresholdTickets(){ return Math.max(1, Math.ceil((C.thresholdPct||50)/100 * (C.target||50))); }
// COMMITTED AUTO-PLAY (chain-the-games accounting). Sum the tickets that WILL land for a given round from active,
// signed, unexpired, relayer-submittable auto-buy ranges that cover it and have NOT yet landed it. This is used ONLY
// to ARM the grace timer earlier (so a round backed by pre-committed auto-play stays filling long enough for the
// relayer to land those buys and the committed games run back-to-back) — it NEVER drives a lock. The actual
// filling->locking transition still requires the on-chain gate (rmfillLockGate: real tickets landed, shortfall<=0,
// >=minDistinctWallets), so committed-but-not-yet-mined tickets can never cause a premature lock or strand a payer.
function committedAutobuyTicketsFor(roundId){
  try{
    if(!escrow.relayUsable()) return 0;                    // no relayer -> nothing will land
    const n=Number(roundId); if(!isFinite(n)) return 0;
    const nowMs=Date.now(); let sum=0;
    for(const k in AUTOBUY_STORE){ const a=AUTOBUY_STORE[k]; const r=a&&a.range;
      if(!r||!r.sig) continue;                             // range records only (legacy ordered-auth excluded)
      // FIX 3 (red-team, defense-in-depth): only count records whose signature we actually PROVED (sigVerified) — OR
      // that already have a landed rangeSpent entry (legacy/in-flight records proven by a real on-chain buyInForRange).
      // This is what stops an unverified junk record from inflating this sum and arming the grace timer early, even if
      // the hard-verify above was ever skipped (e.g. an unresolved domain). An unverified record still rides in the
      // store so the relayer may attempt it; it just can't arm anything until a real buy lands for it.
      if(!(a.sigVerified===true || (Array.isArray(a.rangeSpent) && a.rangeSpent.length>0))) continue;
      if(!(nowMs<=a.deadline*1000)) continue;              // expired authorization won't land
      if(!(a.roundsLeft==null||a.roundsLeft>0)) continue;  // budget exhausted / retired
      if(n<Number(r.roundStart) || n>=Number(r.roundStart)+Number(r.roundCount)) continue; // round not covered
      if((a.rangeSpent||[]).indexOf(String(n))>=0) continue;                                // already landed this round
      sum += Math.max(1, Math.min(a.perRound||1, a.maxTickets||1));                          // tickets this record will buy
    }
    return sum;
  }catch(_){ return 0; }
}
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
  try{ pruneCheckins(); }catch(_){}   // drop prior rounds' ready-check sets; this round starts with a clean present set
  // WEB PUSH (broadcast, Part 2a): a fresh real-money heist is forming -> ping opted-in subscribers to come back. This is
  // the SAME moment as the client's in-tab "a new heist is forming" trigger. pushBroadcast is per-subscriber throttled
  // (~10 min), so rapid rounds + a resume-after-restart new game can't spam. Fire-and-forget; never blocks game setup.
  try{ if(realMoney()) pushBroadcast('A new heist is forming', 'Buy in now before the fuse lights.', 'vs-heist:'+roundId); }catch(_){}
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
    // FIX 1 + FIX 3 SAFETY GATE: before ANY filling->locking transition, require (a) >= minDistinctWallets DISTINCT
    // funding wallets and (b) NO unreconciled on-chain shortfall (every paid ticket is seated as a robber entity).
    // Both share this gate so they can't conflict; both fall back to the SAME void+refund at the hard deadline.
    const gate=rmfillLockGate();
    if(sold>=target && presentOk && gate.ok){ autobuyMissScanOnLock(G.rmId); G.phase='locking'; return; } // full + present-gate ok + SAFE -> immediate lock
    // CHAIN-THE-GAMES: arm the grace on (sold + committed auto-play that WILL land this round), not just sold. A round
    // backed by pre-committed auto-play then stays filling/armed long enough for the relayer to land those buys, so N
    // committed games run back-to-back instead of stalling under threshold. committed NEVER drives a lock: the real
    // filling->locking transitions below still gate on sold (immediate) and gate.ok (grace-end), both on-chain truth,
    // so committed-but-unmined tickets cannot cause a premature lock. If the committed buys never land, sold stays low
    // and the grace-end disarm (below) just keeps filling — self-correcting, no void, no strand.
    const armBasis = sold + committedAutobuyTicketsFor(G.rmId);
    if(armBasis>=thr && G.graceEnds==null){ G.armedAt=now; G.graceEnds=now+rmGraceMsFor(sold); }
    // DYNAMIC GRACE (OFF-CHAIN ONLY): while armed, as more seats fill, shrink the remaining window toward the floor
    // so a near-full round starts fast. We only ever pull the deadline EARLIER (never push it out), measured from
    // the original arm time, so the countdown is monotonic and can't flap. This touches only the local G.graceEnds
    // timestamp; no on-chain call depends on it (lockRound/commit fire on the phase transition below, unchanged).
    if(G.graceEnds!=null && G.armedAt!=null){ const want=G.armedAt+rmGraceMsFor(sold); if(want<G.graceEnds) G.graceEnds=want; }
    if(G.graceEnds!=null && now>=G.graceEnds){                           // grace cap reached
      if(sold<(C.minViable||2) || !presentOk){
        G.graceEnds=null;                                               // low demand / present-gate unmet: disarm + keep filling (no dead time; not a safety failure)
      } else if(gate.ok){
        autobuyMissScanOnLock(G.rmId);
        G.phase='locking';                                             // enough to play + present-gate ok + SAFE -> lock
      } else {
        // FUNDED ENOUGH TO PLAY BUT UNSAFE AT THE DEADLINE -> VOID + REFUND. This is the money-path fairness guard:
        //  * FIX 1: fewer than minDistinctWallets distinct wallets (e.g. one whale bought the whole target) will NEVER
        //    attract a second wallet by waiting, so we do not self-lock; we void so no solo self-win and NO rake.
        //  * FIX 3: an unreconciled shortfall (a paid ticket whose holder we can't identify/seat) persists past the
        //    deadline -> locking would strand that payer, so we void + refund EVERYONE rather than play phantom seats.
        // The shortfall already logged via recordFillStrand in the lift. RECONCILE-BEFORE-VOID: the throttled sync IS
        // the reconcile (each cycle re-reads ticketsOf over every known address + reseats). We give the failure at
        // most 2 extra cycles to clear before voiding, driven by WHICH gate failed:
        //  * SHORTFALL (FIX 3): a reconcile COULD still seat a late/raced buyer, so FORCE an immediate fresh read
        //    (reset the throttle + fire a roster reseat) and hold the deadline ~4s. Only void if the shortfall
        //    survives the fresh read — i.e. the payer is genuinely unidentifiable and would be stranded.
        //  * DISTINCT-WALLET (FIX 1): waiting can never CONJURE a second funding wallet, so once the read is fresh we
        //    void straight away (no point extending). If the read isn't fresh yet we still take one cycle to be sure.
        const shortfallFail = !(gate.shortfall<=0);
        const extable = (shortfallFail || !gate.fresh) && (G._voidDeadlineExt||0)<2;
        if(extable){
          G._voidDeadlineExt=(G._voidDeadlineExt||0)+1; G.graceEnds=now+4000;
          if(shortfallFail){ G._escSyncAt=0; try{ _rmPlaySeatFor=null; rmSeatRosterForPlay(G.rmId); }catch(_){} }   // force a fresh reconcile + reseat this cycle
        } else {
          G.voidReason = (gate.distinct<gate.need) ? 'distinct_wallets' : 'stranded_fill';
          G.voidDetail = (gate.distinct<gate.need)
            ? ('needs '+gate.need+' distinct wallets, had '+gate.distinct)
            : ('on-chain shortfall '+gate.shortfall+' (unreconciled payer)');
          try{ console.warn('[vault-standoff] FILL VOID round '+G.rmId+': '+G.voidReason+' — '+G.voidDetail+' (void+refund, no rake)'); }catch(_){}
          G.phase='voiding';
        }
      }
    }
    return;
  }
  if(G.phase==='voiding'){
    // FIX 1/FIX 3 terminal state: the on-chain void is fired by rmEscrowLifecycle (fire-and-forget, idempotent). Once
    // it confirms (G.voided), roll straight onto the next (already pre-opened) round with ZERO dead time — same shape
    // as the 'ended' path. No settle, no payout, no rake: voidRound refunds every payer their full entry on-chain.
    if(G.voided){ G.phase='ended'; G.endedAt=now; }
    return;
  }
  if(G.phase==='locking'){
    // ROSTER FINALIZATION: fire one lock-boundary re-seat so any buyer the throttled filling-sync hadn't placed yet
    // (its RPC read resolved after the flip) still lands in G.players before chambers resolve. Idempotent per round.
    rmSeatRosterForPlay(G.rmId);
    // The on-chain lockRound + commit are fired by rmEscrowLifecycle (fire-and-forget, idempotent). The GAME
    // only starts the relative play clock once the round is committed on-chain (G.committed set by the lifecycle),
    // so commit==reveal holds and no chamber plays against a round whose buy-in is still open on-chain.
    if(G.committed){ G.phase='playing'; G.roster=true; G.runStart=Date.now(); G.launchedAtMs=G.runStart; G.cur=-1; }   // stamp the authoritative locking->playing flip so the client fires the launch transition on the real edge
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
    if(now>=G.fuseEnds || seatCount()>=C.cap){ G.phase='running'; G.roster=true; G.runStart=now; G.launchedAtMs=now; G.cur=-1; }   // stamp the armed->running flip (fake-fill parity) so the client fires launch on the real edge
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
// Each round's entry is set to $entryUsd worth of RVLT at OPEN. MEDIAN of independent sources -> short rolling
// TWAP -> round-over-round CLAMP band -> time-gated anchor band. The money contract NEVER reads a price (zero
// on-chain oracle surface); per-round UNIFORM entries keep the peer pot symmetric so a wrong price can't be
// weaponized. ANY failure falls back to the static escrow.entryWei() so a round never opens on a broken price.
const PEG = { RVLT:'0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04', USDG:'0x5fc5360d0400a0fd4f2af552add042d716f1d168', CHAIN:4663,
  twap:[], TWAP_MS:10*60*1000, TWAP_MAX:40, lastWei:null, CLAMP_PCT:25, anchorWei:null, anchorTs:0, BAND_PCT:60, ANCHOR_TTL_MS:6*3600*1000, _memo:{ts:0,wei:null},
  // #224 PEG HEALTH (observability + fail-closed). lastLiveTs = wall-clock of the most recent sample backed by a
  // LIVE source read (not a memo/stale replay); STALE_MS = the hard max age past which we REFUSE to price a round
  // (fail closed to the static entryWei) even if a TWAP sample technically survives the window. It equals TWAP_MS
  // (10m) so it only ever rejects when EVERY live source has been down long enough that the whole window would be
  // stale anyway — it does not tighten the existing window, it just makes the refusal explicit. The counters feed
  // the admin peg-health endpoint; `last*` capture the most recent raw/used price + the last clamp/reject/lkg event.
  lastLiveTs:0, STALE_MS:10*60*1000, lastPriceUsdPerRvlt:null, lastSources:0, lastSamples:0,
  stats:{ clamps:0, bandHits:0, rejects:0, lkgFallbacks:0, staleRejects:0 }, lastEvent:null, lastEventTs:0 };
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
  if(PEG.lastWei!=null||PEG.anchorWei!=null) console.log('[vault-standoff] PEG seeded from last-known-good price (restart cold-start bounded): lastWei='+(PEG.lastWei!=null?(PEG.lastWei/10n**18n)+' RVLT':'-'));
}catch(_){} })();
async function _pegGecko(){ try{ const r=await fetch('https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/'+PEG.RVLT,{headers:{accept:'application/json'},signal:AbortSignal.timeout(8000)}); if(!r.ok) return null; const j=await r.json(); const p=parseFloat(j&&j.data&&j.data.attributes&&j.data.attributes.price_usd); return (Number.isFinite(p)&&p>0)?p:null; }catch(_){ return null; } }
async function _pegRelay(usd){ try{ const amt=String(BigInt(Math.round(usd*1e6))); const body={ user:'0x000000000000000000000000000000000000dEaD', recipient:'0x000000000000000000000000000000000000dEaD', originChainId:PEG.CHAIN, destinationChainId:PEG.CHAIN, originCurrency:PEG.USDG, destinationCurrency:PEG.RVLT, amount:amt, tradeType:'EXACT_INPUT' }; const r=await fetch('https://api.relay.link/quote',{method:'POST',headers:{'Content-Type':'application/json',...(process.env.RELAY_API_KEY?{'x-api-key':process.env.RELAY_API_KEY}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)}); if(!r.ok) return null; const j=await r.json(); const outWei=(j&&j.details&&j.details.currencyOut&&j.details.currencyOut.amount)||(j&&j.currencyOut&&j.currencyOut.amount)||null; if(!outWei) return null; const rvlt=Number(BigInt(outWei))/1e18; return (rvlt>0)?(usd/rvlt):null; }catch(_){ return null; } }
function _pegMedian(a){ const s=a.filter(x=>Number.isFinite(x)&&x>0).sort((x,y)=>x-y); if(!s.length) return null; const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
// Returns { price, sources, samples }: the TWAP-window median price, how many INDEPENDENT live sources backed the
// latest sample (0/1/2), and how many samples are in the rolling TWAP window. The caller uses sources+samples to
// decide whether a cold-start price is trustworthy enough to open a round at (see usdToRvltWei).
async function pegPriceUsdPerRvlt(usd){ const [a,b]=await Promise.all([_pegGecko(), _pegRelay(usd)]); const fresh=[a,b].filter(x=>x!=null); const live=_pegMedian(fresh); const now=Date.now(); if(live!=null){ PEG.twap.push({ts:now,price:live}); PEG.lastLiveTs=now; while(PEG.twap.length>PEG.TWAP_MAX) PEG.twap.shift(); } const win=PEG.twap.filter(e=>now-e.ts<=PEG.TWAP_MS).map(e=>e.price); const price=_pegMedian(win); PEG.lastPriceUsdPerRvlt=price; PEG.lastSources=fresh.length; PEG.lastSamples=win.length; return { price, sources:fresh.length, samples:win.length }; }
// #224 PEG bounds-event logger. Records the event name + raw/used wei + age for the admin endpoint AND emits the
// required `[peg] <event> raw=<x> used=<y> ageMs=<n>` line so drift is visible in the logs. Pure observability.
function _pegEvent(kind, rawWei, usedWei, ageMs){
  const STAT={ clamp:'clamps', bandHit:'bandHits', reject:'rejects', 'lkg-fallback':'lkgFallbacks' }[kind];
  if(STAT && PEG.stats[STAT]!=null) PEG.stats[STAT]++;
  PEG.lastEvent={ kind, raw:(rawWei!=null?String(rawWei):null), used:(usedWei!=null?String(usedWei):null), ageMs:(ageMs!=null?ageMs:null) };
  PEG.lastEventTs=Date.now();
  try{ console.warn('[peg] '+kind+' raw='+(rawWei!=null?rawWei:'-')+' used='+(usedWei!=null?usedWei:'-')+' ageMs='+(ageMs!=null?ageMs:'-')); }catch(_){}
}
async function usdToRvltWei(usd){ if(PEG._memo.wei!=null && (Date.now()-PEG._memo.ts)<20000) return PEG._memo.wei;
  const q=await pegPriceUsdPerRvlt(usd); const price=q&&q.price;
  // FAIL-CLOSED #1 (0/NaN price): no live price at all -> return null so pegEntryWei() uses the static escrow.entryWei()
  // fallback. A 0/NaN/negative price can NEVER become the entry wei; the round opens at the static entry instead.
  if(price==null||!(price>0)){ _pegEvent('reject', null, null, (PEG.lastLiveTs?Date.now()-PEG.lastLiveTs:null)); return null; }
  // FAIL-CLOSED #2 (stale price): the TWAP median could be backed only by samples from a window where EVERY live
  // source has since gone dark. If the freshest LIVE sample is older than STALE_MS, refuse to price this round and
  // fall back to the static entry (return null) rather than quote off a stale number. This is a hard age ceiling on
  // top of the existing TWAP window, not a change to the median math. (lastLiveTs==0 only before the very first live
  // read, where the cold-start single-source guard below already governs; so we only enforce staleness once primed.)
  if(PEG.lastLiveTs>0){ const ageMs=Date.now()-PEG.lastLiveTs; if(ageMs>PEG.STALE_MS){ PEG.stats.staleRejects++; _pegEvent('lkg-fallback', null, null, ageMs); return null; } }
  // COLD-START GUARD (LOW): the clamp (±CLAMP_PCT vs PEG.lastWei) and the anchor band (±BAND_PCT vs PEG.anchorWei)
  // are what make a single manipulated read harmless. If NEITHER is seeded yet (truly cold — no disk seed, no prior
  // round this process) AND the price is backed by only ONE source with only ONE TWAP sample, there is nothing to
  // bound a one-sided manipulation, so we REFUSE to open at it and fall back to the static entryWei (return null).
  // Once a second source agrees (sources>=2) OR the TWAP has >=2 samples OR a disk-seeded anchor/last exists, the
  // normal clamp+band path runs. This only ever affects the first read(s) after a fresh boot with a flaky source.
  const seeded=(PEG.lastWei!=null || PEG.anchorWei!=null);
  if(!seeded && q.sources<2 && q.samples<2){ console.error('[vault-standoff] PEG cold-start: single-source price with no seed/TWAP — refusing to open at an unvalidated price; using static entryWei fallback this round'); _pegEvent('reject', null, null, 0); return null; }
  const rawWei=BigInt(Math.round((usd/price)*1e6))*(10n**12n);   // the unclamped price-derived entry (for bounds logging only)
  let wei=rawWei; if(PEG.lastWei){ const lo=PEG.lastWei*BigInt(100-PEG.CLAMP_PCT)/100n, hi=PEG.lastWei*BigInt(100+PEG.CLAMP_PCT)/100n; if(wei<lo)wei=lo; else if(wei>hi)wei=hi; if(wei!==rawWei) _pegEvent('clamp', rawWei, wei, 0); }
  // COLD-START BAND WIDEN: on a seeded-but-single-source first read, keep the anchor band but there is no extra
  // widening needed — the seeded anchor already hard-caps the move to ±BAND_PCT, which is the intended safety.
  // TIME-GATED anchor band: the per-round ±CLAMP_PCT clamp bounds a single step, but a sustained wash-trade could
  // walk the entry over many rounds. A self-following (EMA) anchor would get dragged with it, so the anchor is
  // RE-SNAPPED at most once per ANCHOR_TTL_MS (6h); within that window ±BAND_PCT is a HARD cap. A band hit is a
  // manipulation smoke-alarm. (Entries are per-round uniform in a peer pot, so a wrong entry is symmetric anyway.)
  if(PEG.anchorWei){ const alo=PEG.anchorWei*BigInt(100-PEG.BAND_PCT)/100n, ahi=PEG.anchorWei*BigInt(100+PEG.BAND_PCT)/100n;
    if(wei<alo || wei>ahi){ const before=wei; console.error('[vault-standoff] PEG band hit: $'+(getCfg().entryUsd||10)+' priced at '+(wei/10n**18n)+' RVLT, outside ±'+PEG.BAND_PCT+'% of the 6h anchor '+(PEG.anchorWei/10n**18n)+' — a price source may be manipulated; holding at the band edge'); wei = wei<alo?alo:ahi; _pegEvent('bandHit', before, wei, 0); } }
  { const now=Date.now(); if(PEG.anchorWei==null || (now-PEG.anchorTs)>PEG.ANCHOR_TTL_MS){ PEG.anchorWei=wei; PEG.anchorTs=now; } }
  PEG.lastWei=wei; PEG._memo={ts:Date.now(),wei}; savePegPrice(); return wei; }
// #224 FAIL-CLOSED INVARIANT: usdToRvltWei returns EITHER a positive, clamped+band-bounded wei OR null (0/NaN price,
// stale beyond STALE_MS, or an unvalidated cold-start single-source read). It can NEVER return 0 or a bad number. On
// null we fall back to the STATIC escrow.entryWei() — a configured, non-price value. The caller (escOpenRound /
// rmEscOpenRound / each lifecycle) then enforces `if(entry<=0n) return`, so a round can NEVER open and a quote can
// NEVER be produced at a zero/stale/unvalidated price: the worst case is the static entry, never a bad peg number.
async function pegEntryWei(){ const w=await usdToRvltWei(Number(getCfg().entryUsd)||10).catch(()=>null);
  if(w!=null && w>0n) return w;                                   // live peg (clamped/banded) or null -> static fallback
  const stat=BigInt(escrow.entryWei()||'0');
  if(!(stat>0n)) console.error('[peg] FAIL-CLOSED: no valid peg price AND static entryWei is 0 — no round will open / no quote will be produced (configure VS_ENTRY_WEI or restore a price source)');
  return stat; }
// ========================================================================================================
let _rakeBpsCache=null;
function cacheRakeBps(){ if(!escrow.isOn())return; escrow.rakeBps().then(b=>{ if(b!=null) _rakeBpsCache=b; }).catch(()=>{}); }
function escSched(gs){ return (G&&G.start===gs)?G.sched:buildSched(gs); }
async function escOpenRound(gs){
  if(ESC_OPENED.has(gs)) return;
  const entry=await pegEntryWei(); if(entry<=0n) return;   // USD-pegged entry ($entryUsd of RVLT at open; static escrow.entryWei() fallback inside pegEntryWei)
  const _rs=ensureRoundSeed(gs);                   // lock this round's seed at open so its later commit hash matches
  // SEC-1: publish the SIGNED seed pre-commit (hash only) BEFORE the on-chain openRound makes buy-in live, so the
  // operator is cryptographically bound to this seed before anyone can buy in. Idempotent + persisted; graceful if
  // signing is unavailable (never blocks the open). Awaited here so the binding exists before buy-in goes live.
  try { await ensurePrecommit(gs, _rs.hash); } catch(_){}
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
  // SEC-1 CONSISTENCY: the hash committed on-chain at lock MUST equal the pre-committed seedHash published at open
  // (they are the same seed). A divergence indicates a bug or tamper; log loudly (do NOT block the commit — the
  // on-chain commit is the money-path source of truth and the public pre-commit is verifiable independently).
  { const pc=getPrecommit(gs); if(pc && pc.seedHash && String(pc.seedHash).toLowerCase()!==String(s.hash).toLowerCase()) console.error('[vault-standoff] SEC-1 ALERT: on-chain commit hash '+s.hash+' != pre-committed seedHash '+pc.seedHash+' for round '+gs+' — SEED CHANGED BETWEEN OPEN AND LOCK (bug/tamper)'); }
  const ok=await escrow.commit(gs, s.hash).catch(()=>null);
  if(!ok){ ESC_COMMITTED.delete(gs); /* keep the persisted seed: committing is retried next tick */ }
}
async function escSettleGame(){
  const gs=G.start;
  // seed comes from the durable store (ESC_SEED mirror OR disk), so a restart mid-round can still settle.
  // FIX 1: also fall back to the PROOF_STORE seed. writeProof() deletes the seed from SEED_STORE/seeds.json the instant
  // the proof is written (same tick the game resolves), so a restart in the proof-written-but-not-yet-settled window
  // leaves ESC_SEED + getSeed empty and the round would VOID (refund everyone, deny the real winner, no rake). The
  // proof seed is already PUBLIC (revealed at settle), so reading it back here leaks nothing and lets settle proceed.
  const seed = ESC_SEED[gs] || getSeed(gs) || (PROOF_STORE[String(gs)] && PROOF_STORE[String(gs)].seed) || null;
  if(!G.done || ESC_SETTLED.has(gs) || !ESC_COMMITTED.has(gs) || !seed) return;
  ESC_SETTLED.add(gs);
  const owners=(G.champ&&G.champ.owners)||[];
  const addrs=[...new Set(owners.map(escrow.addrOfToken).filter(Boolean))];
  const real=[]; for(const a of addrs){ if(await escrow.isParticipant(gs,a)) real.push(a); }
  if(real.length) persistChamp(gs, real);   // #222: durable roster BEFORE settle so a restart mid-settle still pays the winner
  const ok = real.length ? await escrow.settleEqualSplit(gs, seed, real).catch(()=>null)
                         : await escrow.voidRound(gs).catch(()=>null);   // no real winner -> refund the pot
  if(!ok){ ESC_SETTLED.delete(gs); return; }
  if(real.length) await schedulePayout(gs, real);   // AUTO-SEND winnings after the challenge window (parity with the rmfill path)
  try{ if(real.length) statsPostSettle(real); }catch(_){}   // (D) OBSERVE-ONLY: record the win AFTER payout is decided; never settle math
  // Holder discount is applied ON-CHAIN at buy time (entryPriceFor); no off-chain rebate accrual at settle.
}
// CONCURRENCY GUARD: the round-lifecycle runs off the 1s tick and awaits on-chain RPC calls, so a slow tick could
// re-enter before the prior invocation finished and race the open/lock/commit/settle sequence. Mirror the
// _payoutBusy / _watchBusy pattern: a single module-level in-flight flag skips the tick while one is already
// running. Shared across BOTH lifecycle entrypoints (only one engine's lifecycle runs per tick) so neither the
// clock nor the rmfill path can overlap itself.
let _lifecycleBusy=false;
async function escrowLifecycle(){
  if(_lifecycleBusy) return; _lifecycleBusy=true;
  try{
    if(!G || C.engine!=='clock' || !G.sched) return;
    const now=Date.now(), cur=G.start, next=cur+C.interval;
    const entry=await pegEntryWei(); if(entry<=0n) return;   // USD-pegged entry ($entryUsd of RVLT at open; static escrow.entryWei() fallback inside pegEntryWei)   // no entry configured -> no real round
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
  finally{ _lifecycleBusy=false; }
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
const RM_VOIDED=new Set();   // FIX 1/FIX 3: round ids the engine has voided-for-refund (distinct-wallet/stranded-fill guard; idempotent)
// SELF-HEAL VOID FLAG: ids the ENGINE decided must be void-refunded (stranded fill / too few distinct wallets) but
// whose on-chain voidRound it could not confirm inline (e.g. the lock tx is still mining). The always-on settle-
// watcher honors this set: it void-refunds a flagged round the moment buy-in is closed on-chain (lockTime passed),
// WITHOUT waiting the full ~25h sentinel deadline, so a flagged round is always made whole in bounded time. Persisted
// is unnecessary — on restart the boot reconcile re-derives a stranded round and the deadline-void backstop still
// covers it; this set only shortcuts the wait while the process stays up.
const RM_VOID_FLAG=new Set();
const VOID_MAX_TRIES=5;      // inline voidRound attempts (once/tick, ~1s each) before handing the round to the watcher
async function rmEscOpenRound(id){
  if(ESC_OPENED.has(id)) return;
  const entry=await pegEntryWei(); if(entry<=0n) return;   // USD-pegged entry ($entryUsd of RVLT at open; static escrow.entryWei() fallback inside pegEntryWei)
  const _rs=ensureRoundSeed(id);                          // lock the seed at open so the later commit hash matches
  // SEC-1: publish the SIGNED seed pre-commit (hash only) BEFORE the on-chain openRound makes buy-in live, binding
  // the operator to this seed before the roster is known. Idempotent + persisted; graceful if signing unavailable.
  try { await ensurePrecommit(id, _rs.hash); } catch(_){}
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
  // SEC-1 CONSISTENCY: on-chain commit hash MUST equal the pre-committed seedHash from open (same seed). Log loud on
  // any divergence (bug/tamper); non-blocking — the on-chain commit remains authoritative and independently verifiable.
  { const pc=getPrecommit(id); if(pc && pc.seedHash && String(pc.seedHash).toLowerCase()!==String(s.hash).toLowerCase()) console.error('[vault-standoff] SEC-1 ALERT: on-chain commit hash '+s.hash+' != pre-committed seedHash '+pc.seedHash+' for round '+id+' — SEED CHANGED BETWEEN OPEN AND LOCK (bug/tamper)'); }
  const ok=await escrow.commit(id, s.hash).catch(()=>null);
  if(!ok){ ESC_COMMITTED.delete(id); }                    // keep the persisted seed; retried next tick
}
async function rmEscSettleGame(id){
  // FIX 1: proof-store fallback so a restart in the proof-written-but-not-settled window can still settle (the public
  // revealed seed) instead of voiding the round. See escSettleGame for the full rationale.
  const seed = ESC_SEED[id] || getSeed(id) || (PROOF_STORE[String(id)] && PROOF_STORE[String(id)].seed) || null;
  if(!G || !G.done || ESC_SETTLED.has(id) || !ESC_COMMITTED.has(id) || !seed) return;
  ESC_SETTLED.add(id);
  // V5 ROLLOVER: a FINAL-VAULT mutual-bust (the whole surviving crowd converged on one door) has NO winner -> roll
  // the whole pot into the progressive jackpot (no refund; it seeds the next game). The engine sets G.rollover.
  if(G.rollover){
    const ok=await escrow.rolloverRound(id, seed).catch(()=>null);
    if(!ok){ ESC_SETTLED.delete(id); return; }
    recordWinStreak([]);   // nobody won: every participant's streak resets, no freeze
    // FIX 6 (reviewed): deliberately NO rake payout is scheduled for a rollover. The on-chain rolloverRound() takes
    // ZERO rake by design (StandoffEscrow.sol ~580: "no rake, no refund" — the WHOLE pot seeds the progressive jackpot
    // and is paid out to a FUTURE winner, so the house still never accrues a drainable pool). The round ends in status
    // RolledOver, while payRake() requires status==Settled AND reads rakeOwed (which rollover never sets) — so a
    // scheduled rake sweep here would revert "not settled" on every rollover and spam the payout-keeper drop log for
    // nothing. There is no stranded treasury rake on a rollover; the value is intact in the jackpot. (If a future
    // contract revision starts accruing rake on rollover, schedule a rake-only payout entry HERE at that time.)
    return;
  }
  const owners=(G.champ&&G.champ.owners)||[];
  const addrs=[...new Set(owners.map(escrow.addrOfToken).filter(Boolean))];
  // SETTLE SAFETY: only ever settle to addresses that are REAL on-chain participants (isParticipant). A resumed round
  // is only ever resumed when FULLY ACCOUNTABLE (every buyer known), so its winner's address is always known here; a
  // non-accountable orphan is never resumed, so it never reaches settle (it refunds at its on-chain deadline). If the
  // winner address is somehow unknown/unvalidated, `real` is empty and we VOID (refund) rather than pay a wrong address.
  const real=[]; for(const a of addrs){ if(await escrow.isParticipant(id,a)) real.push(a); }
  if(real.length) persistChamp(id, real);   // #222: durable roster BEFORE settle so a restart mid-settle still pays the winner
  if(real.length){
    const ok=await escrow.settleEqualSplit(id, seed, real).catch(()=>null);
    if(!ok){ ESC_SETTLED.delete(id); return; }
    recordWinStreak(real);        // anti-whale: bump winners' streak, reset everyone else, freeze at the threshold
    await schedulePayout(id, real);  // AUTO-SEND: push winnings to the winner after the on-chain challenge window (no "collect" click)
    try{ statsPostSettle(real); }catch(_){}   // (D) OBSERVE-ONLY: record the win AFTER payout is decided; reads the already-set pot, never settle math
    // WEB PUSH (personal, Part 2b): the SAME moment as the client's in-tab "you cracked the vault" trigger. Goes only to
    // subscriptions that carry a winner's address (set at subscribe-time when a wallet was connected). Fire-and-forget;
    // NO funds/keys touched (the payout above is the money path; this is just a notification).
    try{ pushToAddresses(real, 'You cracked the vault', 'Last robber standing. Your winnings are on the way to your wallet.', 'vs-win:'+id); }catch(_){}
    JACKPOT_RVLT=0;               // AUDIT L-4: settle just consumed the jackpot on-chain; zero the cache now so the win ceremony pot isn't briefly double-counted (resyncs on next tick)
  } else {
    const ok=await escrow.voidRound(id).catch(()=>null);   // no real winner -> refund the pot
    if(!ok){ ESC_SETTLED.delete(id); return; }
  }
  // Holder discount is applied ON-CHAIN at buy time (entryPriceFor); no off-chain rebate accrual at settle.
}
async function rmEscrowLifecycle(){
  if(_lifecycleBusy) return; _lifecycleBusy=true;
  try{
    if(!G || C.engine!=='rmfill') return;
    // Skip the boot placeholder (engine:'booting', rmId:null): it exists only to keep request handlers' G derefs safe
    // during the async-reconcile window. rmfillTick replaces it with the real reconciled round; until then there is no
    // real round id to open/sync on-chain, so acting here (rmEscOpenRound(null)) would be meaningless churn.
    if(G.booting || G.rmId==null) return;
    const entry=await pegEntryWei(); if(entry<=0n) return;   // USD-pegged entry ($entryUsd of RVLT at open; static escrow.entryWei() fallback inside pegEntryWei)
    const now=Date.now(), cur=G.rmId;
    // ROLLING PRE-OPEN: keep the current round AND the next id open so buy-in is always available. RM_CUR is the
    // id whose game G currently runs; the pre-open id is RM_CUR+1. Both are opened with the sentinel lockTime.
    const nextId=cur+1;
    await rmEscOpenRound(cur);
    await rmEscOpenRound(nextId);
    rmReserve(nextId+1);                                   // the pre-open consumes nextId; never let the counter reuse it
    RM_BUY=cur;                                            // buy-ins target the current round while it fills...
    if(G.phase!=='filling') RM_BUY=nextId;                 // ...once it locks/plays, pre-buy the next
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
    // FIX 1 / FIX 3 VOID: the engine decided this fill round must not lock (too few distinct wallets, or an
    // unreconciled on-chain shortfall would strand a payer). Void it on-chain to open refunds for EVERY payer — no
    // lock, no settle, no rake. Idempotent (RM_VOIDED guard + ESC_SETTLED add so the stranded-round watcher skips it),
    // fire-and-forget safe. Advance RM_CUR exactly like the lock path so the pre-opened next round becomes current
    // when G rolls to 'ended' (zero dead time).
    if(G.phase==='voiding' && !G.voided){
      if(RM_VOIDED.has(cur)){ G.voided=true; }
      else {
        // CONTRACT CONSTRAINT (proven by the settle-watcher + canary log): the escrow will NOT let the operator void a
        // still-Open round before its on-chain deadline (that pre-deadline window is the buy-in/lock window; the only
        // permitted Open-round void is the PUBLIC one AFTER the deadline). A filling round's deadline is ~25h out
        // (sentinel lockTime + playMargin), so a bare voidRound(cur) on an Open round REVERTS, G.voided never sets,
        // and the round freezes at 'voiding' forever (the round-180 freeze). To void NOW we must first CLOSE buy-in
        // on-chain with lockRound (moves lockTime to the current block; buyIn then reverts) — a locked round is
        // voidable. lockRound is signer-only + can only move the lock EARLIER, so this can never re-open or extend
        // buy-in. No rake, no settle: voidRound refunds EVERY on-chain payer their full entry.
        try{ await rmEscLockRound(cur); }catch(_){}
        const ok=await escrow.voidRound(cur).catch(()=>null);
        if(ok){ RM_VOIDED.add(cur); ESC_SETTLED.add(cur); G.voided=true;
          try{ console.warn('[vault-standoff] FILL VOID CONFIRMED round '+cur+' ('+(G.voidReason||'safety')+') — every payer refunded on-chain, no rake'); }catch(_){}
          if(RM_CUR===cur){ RM_CUR=rmAllocId(); /* == nextId; persisted */ }
        } else {
          // RESTART-RESILIENCE / already-voided-on-chain: if the round is no longer Open (status>=2 void/settle), treat
          // it as voided so we don't spin. Otherwise leave G.voided unset to retry next tick.
          const r=await escrow.readRound(cur).catch(()=>null);
          if(r && Number(r.status)>=3){ RM_VOIDED.add(cur); ESC_SETTLED.add(cur); G.voided=true; if(RM_CUR===cur) RM_CUR=rmAllocId(); }
          else {
            // SELF-HEAL / NEVER-FREEZE BACKSTOP (money-safe): the on-chain void still hasn't confirmed (lock mining
            // lag, or a contract rule we can't satisfy from here). Count bounded attempts; after VOID_MAX_TRIES the
            // engine must NOT keep the whole stage frozen on this one round. We advance the LOCAL lifecycle onto the
            // already-pre-opened next round (zero dead time) and HAND THE STRANDED ROUND to the always-on settle-
            // watcher, which is the proven path that voids+refunds it (it voids a locked/committed round directly, or
            // an Open one once its on-chain deadline passes — every payer still made whole, no rake). The ONLY state
            // we mutate here is the local engine cursor; the stranded round's id is left out of RM_VOIDED/ESC_SETTLED
            // so the watcher is the authority that finalizes its refund. This guarantees the stage never sits at
            // "NEXT HEIST 0s"/schedule:null again even if a void tx is momentarily unlandable.
            G._voidTries=(G._voidTries||0)+1;
            if(G._voidTries>=VOID_MAX_TRIES && RM_CUR===cur){
              try{ console.warn('[vault-standoff] FILL VOID round '+cur+' not confirmable on-chain after '+G._voidTries+' tries ('+(G.voidReason||'safety')+') — advancing engine to next round; settle-watcher will void+refund round '+cur+' (every payer, no rake)'); }catch(_){}
              RM_VOID_FLAG.add(cur);         // the watcher void-refunds this round once buy-in is closed on-chain (bounded)
              G.voided=true;                 // let rmfillTick roll 'voiding'->'ended' so the stage advances (local only)
              RM_CUR=rmAllocId();            // == nextId (already pre-opened on-chain); persisted. Stranded round -> watcher.
            }
          }
        }
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
      // ITEM C: while the current game is PLAYING, RM_BUY points at the PRE-OPENED NEXT round (!= cur). Read that round's
      // fill (sold = round(pot/entry), target = roundTarget) on this SAME throttle so the client can show an active
      // next-heist buy + progress bar. One extra bounded read, cached in RM_NEXT_FILL keyed by id (so a stale value is
      // never shown after the rollover makes the next round current). When buy targets the current round (filling), or
      // there is no separate next round, clear the cache so no stale next-fill leaks. Uses G._buyPot (already read above
      // for bgs==RM_BUY) to avoid a second RPC when possible; falls back to a direct potRvlt(bgs) read otherwise.
      if(bgs!=null && Number(bgs)!==Number(cur)){
        const _nid=Number(bgs), _target=(getCfg().roundTarget)||(C.target||50);
        let _entryRvlt=0; try{ _entryRvlt=Number(entry/10n**18n); }catch(_){ _entryRvlt=0; }   // entry is whole-RVLT wei (BigInt); integer-RVLT units for the sold estimate
        escrow.potRvlt(bgs).then(p=>{ const sold=(_entryRvlt>0)?Math.round((Number(p)||0)/_entryRvlt):0; RM_NEXT_FILL={ id:_nid, sold:Math.max(0,sold), target:_target }; }).catch(()=>{});
      } else {
        RM_NEXT_FILL=null;   // buying into the current (filling) round, or no distinct next round -> no separate next-fill
      }
      // total tickets sold this round drives the threshold/full decision. Sum the seated-wallet ticket counts
      // we already read for seating; also seat each verified wallet by its authoritative on-chain buyIn count.
      if(filling){
        let sold=0; const toCount=[]; const seenAddr={};
        // (a) the known REG w: wallets (SIWE-verified or already seated).
        Object.keys(REG).forEach(tok=>{ if(REG[tok].active && tok.startsWith('w:')){ const a=escrow.addrOfToken(tok); if(a){ toCount.push([tok,a]); seenAddr[a.toLowerCase()]=1; } } });
        // (b) Item B RECONCILIATION: also re-check every persisted CANDIDATE buyer address for this round (from
        // preflight / entry-quote / the post-buy seat call). Each is verified on-chain via ticketsOf below; a paid
        // buyer who never completed SIWE (or whose seat call raced, or who paid before a restart) is seated here.
        seatCandidatesFor(cur).forEach(a=>{ if(!/^0x[0-9a-f]{40}$/.test(a)) return; if(seenAddr[a]) return; seenAddr[a]=1;
          var ck; try{ ck=require('ethers').getAddress(a); }catch(_){ return; } toCount.push(['w:'+a, ck]); });
        // STRANDED-FILL FIX (round 180): enumerate every AUTO-BUY payer address so a wallet the relayer just bought in
        // for is attributed by ADDRESS regardless of when its parallel-batch receipt resolves or whether pruneReg has
        // dropped its REG w: session (exhausted-budget records fall out of the keep-set). Gated on ticketsOf>0 below,
        // so a listed-but-never-paid wallet is still never seated. This makes attribution independent of receipt timing.
        autobuyPayerAddrs().forEach(a=>{ if(seenAddr[a]) return; seenAddr[a]=1; var ck; try{ ck=require('ethers').getAddress(a); }catch(_){ return; } toCount.push(['w:'+a, ck]); });
        // AUTHORITATIVE ON-CHAIN TICKET TOTAL (#1 cross-chain fix): read the round struct so we know the TRUE ticket
        // count = round(pot / entry), independent of whether every buyer's address was attributed. A cross-chain buyIn
        // whose post-buy /api/relay/seat call was lost (tab closed, network error) and whose address never landed in the
        // candidate set would otherwise be invisible to the attributed sum below, stalling a fully-funded round forever
        // (exactly round 97: pot held 3 tickets, attributed sum stuck at 2). We read it in parallel with the seating.
        Promise.all([
          Promise.all(toCount.map(([tok,a])=>escrow.ticketsOf(cur,a).then(n=>({tok,a,n})).catch(()=>({tok,a,n:0})))),
          escrow.readRound(cur).catch(()=>null)
        ])
          // ROSTER-COMPLETENESS FIX: this seating pass is fired while the round is filling, but the ticketsOf RPCs can
          // resolve a tick or two LATER, by which point a small-target round may have already flipped filling->locking
          // ->playing. The old guard (phase==='filling') DISCARDED those seats, so a paid buyer whose read resolved
          // after the flip was NEVER placed into G.players: their client never satisfied me.inGame, the pick screen
          // never showed, their picks logged 0, and the round resolved among whatever stale seats existed. We now seat
          // for the SAME round as long as it has NOT ended/settled yet, so late-resolving paid seats still land in the
          // roster before any chamber resolves. Seating after lock is safe: seatWalletCount only ADDS entities, and the
          // on-chain settle still gates every payout on isParticipant, so no non-payer can ever be paid. The ticketsSold
          // counter is only re-committed while still filling (it drives the lock decision; once locked it is frozen).
          .then(([rows, rr])=>{ if(!(G&&G.rmId===rid&&!G.done&&G.phase!=='ended'))return; sold=0; rows.forEach(({tok,a,n})=>{ if(n>0){
              // UPSERT the REG seat for a candidate that isn't registered yet (same shape as /api/siwe/verify), with the
              // CHECKSUMMED paid address, so the seat carries the real payer for settle. THE GATE is this n>0 check.
              if(!REG[tok]){ REG[tok]={ name:'Robber '+String(a).slice(2,6), pre:null, active:true, tickets:1, verified:true, address:a }; }
              else { REG[tok].active=true; if(!REG[tok].address) REG[tok].address=a; }
              seatWalletCount(tok,n); sold+=n; /* THRESHOLD ACCOUNTING: count the ACTUAL on-chain tickets, NOT the capped value. seatWalletCount() still enforces the per-wallet SEAT cap (Sybil guard) separately; the threshold/full decision must reflect the real pot of tickets bought, otherwise a wallet above the cap would under-signal the fill and stall the lock. */
            } });
            // AUTHORITATIVE LIFT: the true on-chain ticket count is round(pot/entry). If it exceeds the attributed sum,
            // a paid buyer was not attributed (lost seat call + no candidate). The round is still FULLY FUNDED on-chain,
            // so the counter must reflect the real total or a funded round never locks. Lifting the COUNTER pays NObody
            // (settle still gates on isParticipant); it only lets the funded round proceed. The shortfall is recorded
            // as a stranded-fill alert so ops can make the unattributed payer whole rather than folding their RVLT in.
            let onchainTotal=0;
            try{ if(rr){ const pot=BigInt(rr.pot||0), entry=BigInt(rr.entry||0); if(entry>0n && pot>0n) onchainTotal=Number(pot/entry); } }catch(_){ onchainTotal=0; }
            if(onchainTotal>sold){ recordFillStrand(cur, onchainTotal, sold); }
            const authoritative=Math.max(sold, onchainTotal);
            // FIX 3 (stranded-fill) instrumentation: record BOTH the real on-chain total AND the attributed-seated
            // count on G so the fill->lock gate (rmfillLockGate) can refuse to lock on a phantom count. `sold` here is
            // the SUM of ticketsOf(cur,addr) over every KNOWN (REG w: + candidate) address that this pass could seat
            // as a real robber entity — i.e. the fully-reconciled attributed count. onchainTotal is round(pot/entry),
            // the TRUE paid ticket count. shortfall = onchainTotal - sold > 0 means a payer we can't identify exists,
            // so some on-chain ticket has no robber entity. The lock gate uses these to reconcile-then-void.
            G._onchainTicketTotal=onchainTotal; G._attributedReal=sold; G._fillReadAt=Date.now();
            // Only re-commit the fill COUNTER while still filling (it drives the lock decision). Once the round has
            // locked/is playing the count is frozen, but we STILL seated any late-resolving buyer into G.players above.
            if(G.phase==='filling'){ G.ticketsSold=authoritative; recordFillSample(authoritative); } }).catch(()=>{});
      }
    }
    // prune finished rounds (ids below a small trailing window) so the sets stay bounded.
    const floor=cur-5; [ESC_OPENED,ESC_COMMITTED,ESC_SETTLED,RM_LOCKED,RM_VOIDED].forEach(S=>{ S.forEach(v=>{ if(typeof v==='number'&&v<floor)S.delete(v); }); });
    Object.keys(ESC_SEED).forEach(k=>{ const n=Number(k); if(Number.isInteger(n)&&n<floor)delete ESC_SEED[k]; });
    Object.keys(RM_SENTINEL).forEach(k=>{ const n=Number(k); if(Number.isInteger(n)&&n<floor)delete RM_SENTINEL[k]; });
    pruneSeatCandidatesBelow(floor);   // Item B: drop candidate sets for rounds well below the live window
  }catch(_){ /* escrow must never break the game */ }
  finally{ _lifecycleBusy=false; }
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

// ---- FIX 1 + FIX 3: fill->lock SAFETY GATE ---------------------------------------------------------------
// FIX 1 (DISTINCT-WALLET FLOOR): count DISTINCT funding wallet ADDRESSES that hold on-chain tickets in the live
// round. We read it off the ATTRIBUTED ROBBER ENTITIES already seated in G.players — each real seat's owner is a
// w: token whose address is the on-chain payer (seatWalletCount only ever seats on ticketsOf>0, via the REG upsert
// in rmEscrowLifecycle / rmSeatRosterForPlay). So "distinct seated owner addresses" == "distinct on-chain funding
// wallets we have reconciled". We key on the resolved ADDRESS (lowercased), not the token, so a wallet that re-SIWEd
// under a fresh token still counts once. Ticket COUNT is irrelevant: 3 tickets from one wallet is still one wallet.
function rmDistinctWallets(){
  if(!G||!G.players) return 0;
  const set=new Set();
  Object.keys(G.players).forEach(id=>{ const p=G.players[id]; if(!p||p.bot||p.left||!p.owner) return;
    let a=null; try{ const reg=REG[p.owner]; a=(reg&&reg.address)||(typeof p.owner==='string'&&p.owner.indexOf('w:')===0?escrow.addrOfToken(p.owner):null); }catch(_){ a=null; }
    if(a) set.add(String(a).toLowerCase()); });
  return set.size;
}
// Minimum distinct funding wallets required before a round may LOCK. Config minDistinctWallets (default 2 = no
// solo self-play). Clamped >=1 so a mis-set 0 can never let an empty round "pass".
function minDistinctRequired(){ return Math.max(1, getCfg().minDistinctWallets||2); }
// FIX 3 (STRANDED-FILL): the shortfall = TRUE on-chain ticket count (round(pot/entry), read in the authoritative
// lift) minus the SEATED attributed count (sum of ticketsOf over every KNOWN address). shortfall>0 means a paid
// ticket exists whose payer we could NOT identify/seat as a robber entity -> locking would strand them. We read the
// values the throttled escrow sync already persisted on G (no new RPC on the hot path). Returns 0 when we have no
// read yet (treated as "not proven safe to lock" by the gate's freshness check below).
function rmFillShortfall(){ if(!G) return 0; const oc=G._onchainTicketTotal||0, at=G._attributedReal||0; return Math.max(0, oc-at); }
// THE UNIFIED LOCK GATE. Returns { ok, distinct, need, shortfall, fresh } describing whether the FILLING round may
// transition to LOCKING. Both FIX 1 and FIX 3 gate the SAME transition and, on a hard deadline failure, fall back to
// the SAME engine-driven void+refund (rmfillTick sets phase='voiding'). The gate NEVER weakens the on-chain seat
// gate (ticketsOf>0) or the isParticipant settle gate; it only decides whether a lock is allowed to proceed.
function rmfillLockGate(){
  const distinct=rmDistinctWallets(), need=minDistinctRequired(), shortfall=rmFillShortfall();
  // `fresh` = we have an on-chain read from the current sync cycle. If we've never read the round struct we don't yet
  // KNOW the true total, so we can't prove the shortfall is zero -> not ok (keep filling until a read lands).
  const fresh = (G && G._fillReadAt!=null);
  const ok = (distinct>=need) && (shortfall<=0) && fresh;
  return { ok, distinct, need, shortfall, fresh };
}

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
// PARALLELIZATION MISS METRIC (per-(player,round) covered-but-never-landed). When a round LOCKS, any active record
// whose signed range covers that (now-closed) round but whose rangeSpent does NOT include it is a buy that never
// landed (lost the lock race / dropped send). We RECORD it here (observability only — no auto-refund; the player's
// bounded authorization/allowance is simply unused) and surface the running count in /api/admin/metrics so a
// serialization/parallelization miss is visible instead of silent. Keyed per (player,round) so it reports once.
const AUTOBUY_MISS_ALERTS = [];
const _autobuyMissSeen = new Set();   // "player|rid" already recorded
let _autobuyMissCount = 0;
function recordAutobuyMiss(player, rid, detail){
  try{
    const key=String(player).toLowerCase()+'|'+String(rid);
    if(_autobuyMissSeen.has(key)) return;
    _autobuyMissSeen.add(key);
    if(_autobuyMissSeen.size>5000){ _autobuyMissSeen.clear(); }   // bound the memo set
    _autobuyMissCount++;
    AUTOBUY_MISS_ALERTS.push({ player:String(player), roundId:String(rid), detail:detail||null, ts:Date.now() });
    while(AUTOBUY_MISS_ALERTS.length>50) AUTOBUY_MISS_ALERTS.shift();
    console.warn('[vault-standoff] AUTO-BUY MISS round '+rid+' player='+player+' (covered by a signed range but the relayed buy never landed before lock)'+(detail?(' — '+detail):''));
  }catch(_){}
}
// Called from the engine the instant a round transitions OUT of the buy-open ('filling') phase. Scans every active
// auto-buy record whose signed range covers `rid` and, if it was neither spent nor still in-flight with a pending
// receipt, logs a miss. rangeSpent is the authoritative "it landed" marker (committed only on a confirmed receipt),
// so this correctly distinguishes a landed buy from one that lost the race. In-flight sends whose receipts have not
// yet resolved are given the benefit of the doubt (they may still confirm into the locked round) and are NOT counted.
function autobuyMissScanOnLock(roundId){
  try{
    const rid=String(roundId); const n=Number(rid);
    for(const k of Object.keys(AUTOBUY_STORE)){
      const a=AUTOBUY_STORE[k]; const r=a&&a.range; if(!r) continue;
      const covers = n>=Number(r.roundStart) && n<Number(r.roundStart)+Number(r.roundCount);
      if(!covers) continue;
      const spent = (a.rangeSpent||[]).indexOf(rid)>=0;
      // _pendingRounds: rounds this record has broadcast but whose receipts are still outstanding (see batch below).
      const pending = a._pendingRounds && a._pendingRounds.indexOf(rid)>=0;
      if(!spent && !pending) recordAutobuyMiss(a.player, rid);
    }
  }catch(_){}
}
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
    // IN-FLIGHT STALENESS GUARD (launch-rush robustness): a record is skipped while a relayed buy is in flight, but a
    // dropped/hung receipt (tx broadcast then never mined, so the off-critical-path tx.wait().finally never runs) would
    // leave _inflight stuck TRUE forever, permanently excluding the record until a server restart — the exact "auto-buy
    // stops landing until I restart" wedge. Treat an in-flight marker older than the TTL as STALE so the record retries.
    // MONEY-SAFE: the on-chain rangeSpent mapping hard-blocks any double-buy, so if the original slow tx later lands the
    // retry simply reverts on-chain (no double charge). The legacy path's try/finally already clears its own _inflight.
    const AUTOBUY_INFLIGHT_TTL=45000;
    const _inflightLive=(a)=>!!(a._inflight && (Date.now()-(a._inflightAt||0) < AUTOBUY_INFLIGHT_TTL));
    const actives=Object.keys(AUTOBUY_STORE).filter(k=>{ const a=AUTOBUY_STORE[k]; if(!a||_inflightLive(a)||!(Date.now()<=a.deadline*1000)) return false; return a.range ? _rangeOK(a) : (a.roundsLeft>0 && a.spent.indexOf(rid)<0 && _nextUnspentAuth(a)); });
    if(!actives.length) return;
    _autobuyBusy=true;
    // Split into the hot V6 RANGE batch (parallelized, managed nonces) and the legacy ordered-auth records (rare;
    // kept serial but still nonce-coordinated through the shared allocator so they never collide with a drip).
    const rangeKeys=[], legacyKeys=[];
    for(const key of actives){ (AUTOBUY_STORE[key].range ? rangeKeys : legacyKeys).push(key); }

    // ============================ V6 RANGE BATCH — PARALLEL BROADCAST, MANAGED NONCES ============================
    // The fix for the serialization miss: instead of awaiting each buyInForRange receipt one-at-a-time (~0.8s each,
    // so 30 players = ~24s, outrunning a fast lock window), we BROADCAST the whole batch in one burst and track the
    // receipts OFF the critical path. MONEY-SAFETY INVARIANTS:
    //   * explicit CONTIGUOUS nonces (base..base+N-1) from the shared allocator so concurrent sends don't collide;
    //   * rangeSpent[rid] is committed ONLY after that player's own tx RECEIPT confirms (a dropped/replaced tx never
    //     falsely marks the round spent; the on-chain rangeSpent mapping also hard-blocks any double-buy regardless);
    //   * per-player bounds (perRound<=maxTickets) are unchanged; the signed range + on-chain checks still govern;
    //   * a nonce error resets the allocator so the next tick reseeds from chain and retries (no double-spend — a
    //     rejected nonce means the tx never entered a block).
    if(rangeKeys.length){
      // First pass (awaited, cheap, read-only): verify each player's on-chain autoBuyNonce so we drop/retire any
      // record whose stored range sig has been invalidated BEFORE we reserve a tx nonce for it. This is the same
      // invalidation check the old serial path did; doing it up-front keeps the nonce block contiguous (no gaps).
      const toSend=[];
      for(const key of rangeKeys){
        const a=AUTOBUY_STORE[key];
        const onchainNonce=await escrow.autoBuyNonce(a.player).catch(()=>null);
        if(onchainNonce==null){ a.lastError=Date.now(); saveAutobuy(); continue; }   // RPC blip: retry next tick, don't retire
        const onN=Number(onchainNonce), r=a.range;
        // NONCE BUMPED (e.g. invalidateAutoBuy): the stored range sig is signed over r.nonce; once the on-chain
        // autoBuyNonce has moved past it, buyInForRange can NEVER succeed. RETIRE the record terminally.
        if(Number(r.nonce)!==onN){ a.retiredReason='authorization invalidated (on-chain nonce bumped past '+r.nonce+'; re-authorize to continue)'; a.roundsLeft=0; if(r.sig) r.sig=null; a.range=null; saveAutobuy(); continue; }
        toSend.push(key);
      }
      // RISK#2 BURST CAP (launch-rush robustness): never fire more than AUTOBUY_BATCH_MAX concurrent relayer sends per
      // tick. A huge simultaneous rush would otherwise broadcast hundreds of txs at once, rate-limiting the RPC and
      // causing partial rejections that open nonce gaps. The overflow rides the next 1s tick (a round fills over a few
      // ticks, well inside the grace window). Sliced-off records keep _inflight unset, so they are simply retried next tick.
      const AUTOBUY_BATCH_MAX=Math.max(1, parseInt(process.env.VS_AUTOBUY_BATCH_MAX||'12',10)||12);
      if(toSend.length>AUTOBUY_BATCH_MAX){ try{ console.log('[vault-standoff] auto-buy burst capped '+toSend.length+'->'+AUTOBUY_BATCH_MAX+' this tick (rest ride next tick)'); }catch(_){ } toSend.length=AUTOBUY_BATCH_MAX; }
      if(toSend.length){
        // Reserve a CONTIGUOUS nonce block for exactly the records we will broadcast. If the allocator can't read the
        // chain (RPC blip) it returns null — skip the whole batch this tick (never guess a nonce) and retry next tick.
        const nonces=await escrow.allocNonces(toSend.length).catch(()=>null);
        if(nonces && nonces.length===toSend.length){
          const sendProms=[];
          toSend.forEach((key, i)=>{
            const a=AUTOBUY_STORE[key], r=a.range, nonce=nonces[i];
            // Hold _inflight from BEFORE broadcast until the receipt resolves (below), so a later tick can't
            // re-submit this record for this round while its tx is still mining (the drift race the guard prevents).
            a._inflight=true; a._inflightAt=Date.now();
            a._pendingRounds=a._pendingRounds||[]; if(a._pendingRounds.indexOf(rid)<0) a._pendingRounds.push(rid);
            const n=Math.max(1, Math.min(a.perRound||1, a.maxTickets));
            // Broadcast only (noWait): returns { tx } (the ethers TransactionResponse). We await the SEND here (via
            // Promise.allSettled below), but the RECEIPT is tracked off the critical path so the batch doesn't serialize.
            const p=escrow.buyInForRange(buyRound, a.player, n, r.roundStart, r.roundCount, a.maxTickets, a.maxEntry, r.nonce, a.deadline, r.sig, { nonce, noWait:true })
              .then(resp=>({ key, n, nonce, resp }))
              .catch(err=>({ key, n, nonce, err }));
            sendProms.push(p);
          });
          // Await only the SENDS (broadcast acceptance), not the receipts. ~1 RPC round-trip for the whole burst.
          const sent=await Promise.allSettled(sendProms);
          // NONCE-GAP LEAK FIX (self-heal the relayer): this batch reserved a CONTIGUOUS nonce block (base..base+N-1)
          // and advanced the allocator cursor by N up-front. If ANY send in the middle of that block is REJECTED (for
          // ANY reason — gas, allowance revoked, per-wallet cap, as well as a nonce error), its reserved nonce is never
          // broadcast and becomes a PERMANENT GAP: every higher nonce already broadcast (and every future buy/drip)
          // can never mine, because Ethereum requires strictly sequential per-account nonces. That wedges the whole
          // relayer. So: if ANY send was rejected we FORCE the allocator to reseed from the chain's pending count on the
          // next allocation (resetRelayNonce). Reseeding is always money-safe — a rejected nonce never entered a block
          // (no double-spend), and the on-chain rangeSpent mapping is the ultimate hard guard against any replay. We
          // reset ONCE after processing all results (not per-rejection) so the next tick re-broadcasts the gap cleanly.
          let _anyRejected=false;
          sent.forEach(s=>{
            const v = s.status==='fulfilled' ? s.value : (s.reason||{});
            const key=v.key; if(!key) return; const a=AUTOBUY_STORE[key];
            const r=a&&a.range;
            if(v.err || !v.resp || !v.resp.tx){
              // SEND rejected (nonce too low/high, gas, allowance revoked, cap). Don't commit rangeSpent; clear the
              // in-flight + pending markers so this record retries next tick. ANY rejection means the reserved nonce
              // block now has a gap -> reseed the allocator (handled once, below) so a wedge can never persist.
              a._inflight=false;
              if(a._pendingRounds){ const ix=a._pendingRounds.indexOf(rid); if(ix>=0) a._pendingRounds.splice(ix,1); }
              a.lastError=Date.now();
              _anyRejected=true;
              try{ console.warn('[vault-standoff][autobuy-diag] SEND REJECTED round='+rid+' player='+(a.player||key)+' tickets='+(v.n||'?')+' nonce='+(v.nonce!=null?v.nonce:'?')+' err='+String((v.err&&(v.err.shortMessage||v.err.reason||v.err.info&&v.err.info.error&&v.err.info.error.message||v.err.message))||v.err||'unknown').slice(0,400)); }catch(_){ }
              saveAutobuy();
              return;
            }
            // SEND accepted. Track the RECEIPT off the critical path. rangeSpent is committed ONLY when the receipt
            // confirms — so a dropped/replaced tx cannot falsely mark this round spent. Preserve the .catch->lastError
            // retry-next-tick behavior on a failed receipt.
            const tx=v.resp.tx, n=v.n;
            tx.wait().then(rec=>{
              if(rec && (rec.status==null || rec.status===1)){
                a.rangeSpent=a.rangeSpent||[]; if(a.rangeSpent.indexOf(rid)<0) a.rangeSpent.push(rid);
                a.roundsLeft=Math.max(0, Number(r.roundCount)-a.rangeSpent.length);
                a.lastRoundId=rid; a.lastTx=(rec&&rec.hash)||tx.hash;
                a.retiredReason = a.roundsLeft<=0 ? 'budget exhausted (re-authorize to continue)' : null;
                console.log('[vault-standoff] auto-buy RANGE relayed round='+rid+' player='+a.player+' tickets='+n+' tx='+a.lastTx);
              } else {
                // receipt says reverted: do NOT mark spent; retry next tick (on-chain rangeSpent also blocks a dup).
                a.lastError=Date.now();
                try{ console.warn('[vault-standoff][autobuy-diag] RECEIPT REVERTED round='+rid+' player='+a.player+' tx='+((rec&&rec.hash)||tx.hash)); }catch(_){ }
              }
            }).catch(()=>{ a.lastError=Date.now(); })
              .finally(()=>{
                a._inflight=false;
                if(a._pendingRounds){ const ix=a._pendingRounds.indexOf(rid); if(ix>=0) a._pendingRounds.splice(ix,1); }
                saveAutobuy();
              });
          });
          // Any rejected send left a gap in the reserved contiguous nonce block -> force a chain reseed on the next
          // allocation so the relayer never wedges on an unbroadcast nonce (buys AND the shared gas-drip recover).
          if(_anyRejected){ try{ escrow.resetRelayNonceToLatest(); }catch(_){} }   // RISK#1: reseed from MINED nonce so a gapped (rejected, unbroadcast) nonce is re-broadcast, not skipped
          saveAutobuy();
        } else {
          // allocator unreadable (RPC blip): release the whole batch untouched; retry next tick. Nothing was sent.
          toSend.forEach(key=>{ const a=AUTOBUY_STORE[key]; if(a){ a.lastError=Date.now(); } });
          saveAutobuy();
        }
      }
    }

    // ============================ LEGACY ORDERED-AUTH PATH (serial, nonce-coordinated) ============================
    for(const key of legacyKeys){
      const a=AUTOBUY_STORE[key];
      // verify the player's on-chain nonce so we submit the authorization that matches the CURRENT on-chain nonce.
      const onchainNonce=await escrow.autoBuyNonce(a.player).catch(()=>null);
      if(onchainNonce==null) { a.lastError=Date.now(); saveAutobuy(); continue; }   // RPC blip: retry next tick, don't retire
      const onN=Number(onchainNonce);
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
        if(reconciled) console.log('[vault-standoff] auto-buy reconciled landed-late round='+rid+' player='+a.player);
        continue;
      }
      // not yet this auth's turn: either the on-chain nonce hasn't reached it, or its bound round isn't live yet.
      if(au.nonce!==onN || String(au.roundId)!==rid) continue;
      const n=Math.max(1, Math.min(a.perRound||1, a.maxTickets));
      // mark in-flight so a concurrent pass can't re-evaluate this auth while its buyInFor is mining (the real
      // source of the drift race). Cleared in all paths below.
      a._inflight=true; a._inflightAt=Date.now();
      // KH-5: the in-flight lock MUST clear in all paths. buyInFor() already swallows its own errors (.catch ->
      // null), but a throw anywhere between setting and clearing _inflight (e.g. an OOM, or future code) would
      // strand this authorization permanently (every later tick skips _inflight entries). The try/finally
      // guarantees _inflight is reset even on an unexpected throw, so the auth can be retried next round.
      try {
        // Submit into the auth's BOUND roundId (== the live buy-round here), with the signed nonce + bounds. Draw the
        // relayer tx nonce from the SAME shared allocator the range batch + drips use so a legacy send can't collide
        // with an in-flight buy or drip (null alloc -> ethers auto-nonce fallback, as before).
        const _na=await escrow.allocNonces(1).catch(()=>null);
        const _opts=(_na&&_na.length)?{ nonce:_na[0] }:undefined;
        const hash=await escrow.buyInFor(au.roundId, { player:a.player, maxTickets:a.maxTickets, maxEntry:a.maxEntry, deadline:a.deadline, nonce:au.nonce, sig:au.sig }, n, _opts).catch(()=>null);
        if(hash){
          au.spent=true; au.spentRound=rid; au.tx=hash; au.sig=null;                   // MED-5: zero the spent sig so a disk leak can't replay it
          a.roundsLeft=Math.max(0,a.roundsLeft-1);
          if(a.spent.indexOf(rid)<0){ a.spent.push(rid); if(a.spent.length>2000) a.spent=a.spent.slice(-2000); }
          a.lastRoundId=rid; a.lastTx=hash;
          a.retiredReason = a.roundsLeft<=0 ? 'budget exhausted (re-authorize to continue)' : null;
          saveAutobuy();
          console.log('[vault-standoff] auto-buy relayed round='+rid+' player='+a.player+' tickets='+n+' nonce='+au.nonce+' tx='+hash);
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
// #223 ORPHAN SWEEP (observability only — no new money path). ORPHAN_SWEPT guards the one-time `[orphan-sweep]`
// LOG per round id so a committed-but-unsettleable round (no recoverable seed, past its play+challenge deadline)
// is announced exactly once as it falls through to voidRound. This is a LOG/OBSERVABILITY wrapper around the
// EXISTING settle-watcher void-and-refund; it moves no funds, changes no refund amount, and never bypasses the
// on-chain deadline gate (an Open round still only voids past its deadline, a Committed round still only past its
// play margin). The actual void/refund remains escrow.voidRound(id), which refunds ALL on-chain payers their full
// entry, takes ZERO rake, and is idempotent on-chain (reverts if the round is already terminal). ESC_SETTLED (+ the
// RM_VOIDED set on the fill path) are the double-fire guards that stop a second voidRound from revert-storming.
const ORPHAN_SWEPT = new Set();   // round ids already logged as an actioned orphan (fire the [orphan-sweep] line once)
function _watchLog(action, id, detail){
  WATCH.actions.unshift({ ts:Date.now(), action, id:String(id), detail:detail||null });
  while(WATCH.actions.length>50) WATCH.actions.pop();
  WATCH.lastActionTs=Date.now();
  console.log('[vault-standoff] settle-watcher '+action+' round='+id+(detail?(' '+detail):''));
}
// Build the candidate id window to scan. Clock ids are big aligned timestamps; rmfill ids are small integers.
// We scan the active engine's recent ids plus any round ids that appear in our in-memory escrow sets.
function _watchCandidateIds(){
  const ids=new Set();
  // in-memory tracked rounds (both engines share these sets, keyed by their own id space)
  ESC_OPENED.forEach(v=>ids.add(v)); ESC_COMMITTED.forEach(v=>ids.add(v));
  if(C.engine==='rmfill'){ const top=RM_NEXT_ID; for(let i=Math.max(1,top-64);i<=top;i++) ids.add(i); }   // widened 8->24->64 (B-4): a deeper pending backlog can't escape the watcher sweep (matches the boot-reconcile window)
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
    // SELF-HEAL VOID (engine-flagged stranded fill): the engine decided this round must be void-refunded but could not
    // confirm voidRound inline. Void it here the moment buy-in is closed on-chain (lockTime has passed — the engine
    // calls lockRound before handing off), WITHOUT waiting the full sentinel deadline, so a flagged round is always
    // made whole in bounded time. If lockRound hasn't landed yet, close buy-in here first (idempotent, signer-only,
    // can only move the lock earlier). voidRound refunds EVERY on-chain payer their full entry; no settle, no rake.
    if(RM_VOID_FLAG.has(id) && !ESC_SETTLED.has(id)){
      if(nowS < r.lockTime){ try{ await escrow.lockRound(id); }catch(_){} return 'pending'; }   // ensure buy-in closed first
      if(!ORPHAN_SWEPT.has(id)){ ORPHAN_SWEPT.add(id);
        let payers=0; try{ const e=BigInt(r.entry||0), p=BigInt(r.pot||0); if(e>0n && p>0n) payers=Number(p/e); }catch(_){}
        console.warn('[orphan-sweep] round='+id+' reason=engine_flagged_void -> void-refund (payers='+payers+')'); }
      const ok=await escrow.voidRound(id).catch(()=>null);
      if(ok){ ESC_SETTLED.add(id); RM_VOIDED.add(id); RM_VOID_FLAG.delete(id); _watchLog('void-flagged', id, 'engine stranded-fill flag -> refund'); return 'voided'; }
      return 'pending';   // retry next watcher tick (still money-safe: nothing settled, every payer refundable)
    }
    // B-1 STALE-OPEN VOID (queue hygiene): a NON-current Open round that never reached threshold and has sat open past
    // the stale TTL is abandoned backlog (cold-start partials, test rounds, a rush spill that never filled). Void-refund
    // it early instead of parking it until the ~25h sentinel deadline, so the live queue never accumulates stale rounds.
    // HARD GUARDS: never the live round (RM_CUR) or the buy-target (RM_BUY); only sub-threshold; only after the TTL.
    // Money-safe: voidRound refunds every payer in full, no rake; lockRound only moves the lock earlier. Mirrors the
    // engine-flagged path (lock first, void next tick once buy-in is closed on-chain).
    if(Number(id)!==Number(RM_CUR) && Number(id)!==Number(RM_BUY) && !ESC_SETTLED.has(id) && !RM_VOID_FLAG.has(id)){
      const _cfgS=getCfg();
      const _openTs=Number(r.lockTime)-(Number(_cfgS.sentinelSec)||86400);
      const _ageSec=nowS-_openTs;
      const _staleTTL=Math.max(300, parseInt(process.env.VS_STALE_OPEN_VOID_SEC||'1200',10)||1200);   // ~20 min
      let _tix=0; try{ const e=BigInt(r.entry||0), p=BigInt(r.pot||0); if(e>0n && p>0n) _tix=Number(p/e); }catch(_){}
      if(_ageSec>_staleTTL && _tix<rmThresholdTickets()){
        if(nowS < r.lockTime){ try{ await escrow.lockRound(id); }catch(_){} return 'pending'; }   // close buy-in first, void next tick
        if(!ORPHAN_SWEPT.has(id)){ ORPHAN_SWEPT.add(id); console.warn('[orphan-sweep] round='+id+' reason=stale_open_subthreshold age='+_ageSec+'s tix='+_tix+' -> void-refund'); }
        const ok=await escrow.voidRound(id).catch(()=>null);
        if(ok){ ESC_SETTLED.add(id); RM_VOIDED.add(id); _watchLog('void-stale-open', id, 'stale sub-threshold open -> refund'); return 'voided'; }
        return 'pending';
      }
    }
    // Open. If the on-chain deadline has passed, the round was abandoned (never locked/committed) -> void to
    // open refunds. (The normal lifecycle locks/commits live rounds; a stranded Open one past deadline is dead.)
    if(nowS >= r.deadline){
      // #223 ORPHAN SWEEP: an Open round past its on-chain deadline was abandoned (never locked/committed). Announce
      // it once, then void-and-refund via the EXISTING path. Payer count = round(pot/entry) read above (display only;
      // the contract refunds each on-chain payer, not this number). ESC_SETTLED.add below is the double-fire guard.
      if(!ORPHAN_SWEPT.has(id)){ ORPHAN_SWEPT.add(id);
        let payers=0; try{ const e=BigInt(r.entry||0), p=BigInt(r.pot||0); if(e>0n && p>0n) payers=Number(p/e); }catch(_){}
        console.warn('[orphan-sweep] round='+id+' reason=past_deadline -> void-refund (payers='+payers+')'); }
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
    if(ESC_SETTLED.has(id)) return 'pending';
    const proof = PROOF_STORE[String(id)];
    // FIX 1: proof-store seed fallback so a stranded committed round survives a restart that wiped ESC_SEED/getSeed
    // (writeProof deletes the at-rest seed on resolve). The proof seed is public; this lets the watcher settle the real
    // winner instead of voiding. `proof` is read just above for the champion, so we reuse it for the seed too.
    const seed = ESC_SEED[id] || getSeed(id) || (proof && proof.seed) || null;
    let settled=false;
    if(seed && proof && proof.winner && !proof.winner.none){
      // The public proof stores token HASHES, not addresses, so the roster can't be rebuilt from it. Winner addresses
      // come from either the LIVE in-memory champion (if this IS the live round) OR the #222 durable roster persisted
      // at settle time (recovers a round whose G.champ was wiped by a restart). Either way it is RE-VALIDATED on-chain
      // (isParticipant) before any settle. Only a round with NO recoverable roster falls through to the void refund.
      const liveId = (C.engine==='rmfill') ? (G&&G.rmId) : (G&&G.start);
      let candAddrs=null, recovered=false;
      if(String(liveId)===String(id) && G.champ && G.champ.owners && G.champ.owners.length){
        candAddrs=[...new Set(G.champ.owners.map(escrow.addrOfToken).filter(Boolean))];
      } else if(CHAMP_STORE[String(id)] && Array.isArray(CHAMP_STORE[String(id)].addrs) && CHAMP_STORE[String(id)].addrs.length){
        candAddrs=[...new Set(CHAMP_STORE[String(id)].addrs.filter(Boolean))]; recovered=true;   // #222: roster recovered post-restart
      }
      if(candAddrs && candAddrs.length){
        const real=[]; for(const a of candAddrs){ if(await escrow.isParticipant(id,a)) real.push(a); }
        if(real.length){
          const ok=await escrow.settleEqualSplit(id, seed, real).catch(()=>null);
          // Holder discount is applied ON-CHAIN at buy time (entryPriceFor); no off-chain rebate accrual here.
          if(ok){ ESC_SETTLED.add(id); await schedulePayout(id, real); _watchLog('settle', id, 'champ='+real.length+(recovered?' (roster recovered post-restart)':'')); settled=true; return 'settled'; }
        }
      }
    }
    if(!settled){
      // #223 ORPHAN SWEEP: a Committed round is past lockTime + the play+challenge margin AND cannot be settled (no
      // recoverable seed anywhere — ESC_SEED/getSeed/PROOF_STORE — or no reconstructable+on-chain-validated champion).
      // This is the deterministic VOID-and-refund orphan terminal. Announce once with the fall-through reason, then
      // void via the EXISTING path (refund ALL on-chain payers, zero rake, idempotent). ESC_SETTLED is the guard.
      if(!ORPHAN_SWEPT.has(id)){ ORPHAN_SWEPT.add(id);
        const reason = seed ? 'past_deadline' : 'no_seed';   // no seed => can never settle; else no validated champion
        let payers=0; try{ const e=BigInt(r.entry||0), p=BigInt(r.pot||0); if(e>0n && p>0n) payers=Number(p/e); }catch(_){}
        console.warn('[orphan-sweep] round='+id+' reason='+reason+' -> void-refund (payers='+payers+')'); }
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
    // keep the one-time orphan-log guard bounded: once a round is terminal (not in the live scan window) it will
    // never re-appear, so drop its ORPHAN_SWEPT marker. Cheap O(set) prune against the current candidate window.
    if(ORPHAN_SWEPT.size>256){ const live=new Set(ids.map(String)); ORPHAN_SWEPT.forEach(v=>{ if(!live.has(String(v))) ORPHAN_SWEPT.delete(v); }); }
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
    console.log('[vault-standoff] settle-watcher boot catch-up sweep complete; pending='+WATCH.pending.length);
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
// FOUNDATIONAL null-G FIX (closes the whole class). The synchronous boot tick() above does NOT always create G: on an
// escrow-ON boot, rmfillTick RETURNS EARLY (rmReconcileNextId() is async; it waits for RM_RECONCILED before building
// the first round — see rmfillTick), and the clock engine likewise defers to on-chain timing. So for ~2s after the
// port opens, G is null and ANY request handler that derefs G (join -> G.phase/G.players, pricing, preflight, relay/*,
// pick/send, ready, chat) throws `TypeError: Cannot read properties of null (reading 'phase')` and 500s. Rather than
// guard each handler one-by-one, GUARANTEE G is non-null from t=0: if tick() left it null, install a SAFE placeholder
// round (phase:'filling', empty players, seatCount 0, roundId null, no committed seed). engine:'booting' is deliberate
// so the first real tick's `G.engine!=='rmfill'`/`!=='clock'`/`!=='fill'` guard REPLACES it with the genuine round
// (correct reconciled id + committed seed) the instant the async warmup finishes — the placeholder never settles or
// takes money, it only keeps every G deref safe during the boot window. Idempotent (only fills a null G).
function ensureGame(){
  if(G) return G;
  G = { engine:'booting', booting:true, phase:'filling', players:{}, roster:false,
        roundId:null, rmId:null, start:null, armedAt:null, graceEnds:null, fuseEnds:null, runStart:null,
        routes:[], cur:-1, resolved:{}, done:false, champ:null, counts:null, bust:null, bustN:0,
        endedAt:null, ticketsSold:0, locked:false, bustLog:[], _walletCap:walletCap() };
  return G;
}
ensureGame();   // G is now a valid 'filling' placeholder BEFORE server.listen — every handler that derefs G is safe at t=0
// FEATURE 3: settle-watcher runs on a slow independent interval (every 30s) so it never piggybacks the hot 1s
// loop, plus a one-shot bounded catch-up sweep on boot for orphaned rounds.
const WATCH_INTERVAL_MS = Math.max(10000, parseInt(process.env.VS_WATCH_INTERVAL_MS||'30000',10)||30000);
setInterval(()=>{ settleWatcher(); }, WATCH_INTERVAL_MS);
setTimeout(bootCatchupSweep, 2500);   // let the first tick open/sync rounds before the sweep reads them

// ambient bot chatter
const BOT_LINES=['everyone go left, trust me 😏','skylight is a trap','I only take the quiet door','who’s banking at the last door?','got busted last time lol','follow me or lose','service shaft crew where you at','too many of you in east vault','🔥🔥','holding to the very end','new robbers get eaten first','watch the herd, not the door','north wing is cursed today','don’t overthink it','last one in takes it all','psh, amateurs','I never split. ever.','split with me and we both live','just bought in','fuse is lit, let’s go'];
let chatBeat=0;
setInterval(()=>{ if(!G)return; chatBeat++; if(chatBeat%2 && Math.random()<0.7){ const bots=Object.values(G.players).filter(p=>p.bot&&!p.left); if(!bots.length)return; const b=bots[Math.floor(Math.random()*bots.length)]; CHAT.push({name:b.name,text:BOT_LINES[Math.floor(Math.random()*BOT_LINES.length)],ts:Date.now(),th:null,bot:true}); while(CHAT.length>80)CHAT.shift(); } },5000);

// ---- API ----
app.post('/api/join',(req,res)=>{
  if(!rl(rlKey(req,'join'),20,60000)) return res.status(429).json({error:'slow down'});
  if(!G)tick();
  // FIX (red-team) defense-in-depth: bound REG growth. Join is now IP-rate-limited (the token is out of the rl key), but
  // as a hard ceiling, when REG is large sweep UNVERIFIED entries that hold no live seat (verified wallets and seated
  // players are always preserved; a dropped anon u_ entry simply re-creates on its next join). Cheap, only over cap.
  try{ const _k=Object.keys(REG); if(_k.length>8000){ for(const k of _k){ const r=REG[k]; if(r&&!r.verified&&!(G&&G.players&&G.players[k])) delete REG[k]; } } }catch(_){}
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
  let nm=(req.body&&req.body.name)?String(req.body.name).slice(0,14):((REG[token]&&REG[token].name)||('Robber '+token.slice(2,6)));
  REG[token]=REG[token]||{name:nm,pre:null,active:true,tickets:1}; REG[token].name=nm; REG[token].active=true;
  // (C) a persisted profile name (and B: a resolved ENS name) take precedence over the posted base name, so a chosen
  // display name survives a reconnect and is never clobbered by the client's default shortAddr/name on join.
  try{ const addr=REG[token]&&REG[token].address; if(addr){ ensResolveLazy(addr, token); const p=profileFor(addr); if(p&&p.name){ nm=p.name; REG[token].name=nm; } else if(REG[token].ens){ nm=REG[token].ens; REG[token].name=nm; } } }catch(_){}
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
  res.json({ on:true, current:current!=null?String(current):null, next, engine:C.engine });
});
// PUBLIC PROOF of a settled round: the revealed seed + hashed ticket set + every logged pick + which door
// busted each chamber (and how many were caught) + the winner. Anyone can replay prng(seed, roundId, label)
// against this to independently reproduce the outcome, and check the seed's keccak256 == the on-chain commit.
app.get('/api/round/:id/proof',(req,res)=>{
  if(!rl(rlKey(req,'proof'),60,60000)) return res.status(429).json({error:'slow down'});
  const id=String(req.params.id||''); const p=PROOF_STORE[id];
  // SEC-1: surface the OFF-CHAIN SIGNED SEED PRE-COMMIT published at OPEN. This lets anyone verify, BEFORE any pick
  // was made, that the operator was cryptographically bound to this round's seedHash + openedAt. It is returned the
  // instant a round opens — well before (and independently of) the settled proof — so the endpoint no longer 404s
  // for an open-but-unsettled round that has a pre-commit. Fields are self-contained for verification: the signer
  // address + the exact canonical `message`, so a verifier recomputes ethers.verifyMessage(message,sig)===signer.
  const pcRaw=getPrecommit(id);
  let precommit=null;
  if(pcRaw && pcRaw.sig){
    precommit={ roundId:String(id), seedHash:pcRaw.seedHash, openedAt:pcRaw.openedAt, signer:pcRaw.signer,
      sig:pcRaw.sig, message:pcRaw.message, chainId:pcRaw.chainId, escrow:pcRaw.escrow,
      // self-asserting: recover the signer from (message,sig) and confirm it matches the published signer address.
      sigValid: escrow.verifyPrecommit(pcRaw) };
  } else if(pcRaw && pcRaw.unavailable){
    precommit={ roundId:String(id), seedHash:pcRaw.seedHash, openedAt:pcRaw.openedAt, signer:null, sig:null, unavailable:true };
  }
  if(!p){
    // No settled proof yet. If we at least have a pre-commit, serve it (the round is bound, just not revealed yet).
    if(precommit) return res.json({ roundId:String(id), precommit, revealed:false });
    return res.status(404).json({error:'no proof for this round yet (not settled, or unknown round)'});
  }
  // Settled: return the full proof PLUS the pre-commit AND the reveal-matches-commit verification. Once the seed is
  // revealed (it is public in the proof), compute keccak256(seed) and assert it equals the pre-committed seedHash.
  let seedMatchesPrecommit=null;
  try { if(precommit && precommit.seedHash && p.seed){ seedMatchesPrecommit = (keccak256(p.seed).toLowerCase()===String(precommit.seedHash).toLowerCase()); } } catch(_){ seedMatchesPrecommit=null; }
  res.json(Object.assign({}, p, { precommit, revealed:true, seedMatchesPrecommit }));
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
  if(!rl(rlKey(req,'relay'),150,60000)) return res.status(429).json({error:'slow down'});
  try{ const r=await fetch(`${RELAY_API}/chains`,{headers:RELAY_HEADERS(),signal:AbortSignal.timeout(12000)}); res.status(r.status).json(await r.json()); }
  catch(e){ res.status(502).json({error:'relay chains unavailable'}); }
});
// LOCKED-DOWN quote proxy (replaces the former open passthrough that forwarded ANY body to Relay, a free
// arbitrary-swap oracle for anyone with the URL). The connector's generic relayDeliver still calls this, but
// the DESTINATION is now forced server-side: it can ONLY ever deliver the escrow's RVLT token onto the escrow
// chain. Origin currency/chain are the player's choice; destination is not negotiable. Inert unless escrow is on.
app.post('/api/relay/quote', express.json({limit:'8kb'}), async (req,res)=>{
  if(!rl(rlKey(req,'relay'),150,60000)) return res.status(429).json({error:'slow down'});
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
    if(!body.originChainId) return res.status(400).json({error:'originChainId required'});
    if(!/^\d+$/.test(body.amount) || body.amount==='0') return res.status(400).json({error:'amount required'});
    // M-5: origin may be EVM (0x token/native sentinel) OR Solana (base58 mint/native) when originChainId is the
    // Relay Solana id. recipient is ALWAYS an EVM address on Robinhood (where RVLT lands); destination stays pinned
    // to RVLT above. Validation keeps an unvalidated client string from being reflected into the Relay request.
    const SOL_B58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, EVM=/^0x[0-9a-fA-F]{40}$/, BTC_ADDR=/^(bc1[a-z0-9]{8,87}|[13][a-km-zA-HJ-NP-Z1-9]{20,40})$/i;
    const isSolOrigin = body.originChainId === 792703809;  // Relay Solana mainnet
    const isBtcOrigin = body.originChainId === 8253038;    // Relay Bitcoin mainnet (deposit-address model)
    if(isSolOrigin){
      if(!SOL_B58.test(body.user)) return res.status(400).json({error:'valid Solana user address required'});
      if(!SOL_B58.test(body.originCurrency)) return res.status(400).json({error:'originCurrency must be a base58 Solana mint/native for a Solana origin'});
    } else if(isBtcOrigin){
      // BTC origin: user + currency are bech32/base58 Bitcoin strings (Relay's canonical BTC currency). RVLT still
      // lands on an EVM recipient on Robinhood; Relay returns a deposit address the user funds from their BTC wallet.
      if(!BTC_ADDR.test(body.user)) return res.status(400).json({error:'valid Bitcoin user address required'});
      if(!BTC_ADDR.test(body.originCurrency)) return res.status(400).json({error:'originCurrency must be a Bitcoin address for a BTC origin'});
    } else {
      if(!EVM.test(body.user)) return res.status(400).json({error:'valid user address required'});
      if(!EVM.test(body.originCurrency)) return res.status(400).json({error:'originCurrency must be a 0x EVM token address or the native sentinel'});
    }
    if(!EVM.test(body.recipient)) return res.status(400).json({error:'valid EVM recipient required (RVLT lands on Robinhood)'});
    const r=await fetch(`${RELAY_API}/quote`,{method:'POST',headers:RELAY_HEADERS(),body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    res.status(r.status).json(await r.json());
  }catch(e){ res.status(502).json({error:'relay quote unavailable'}); }
});
// ---- GAS SLICE QUOTE: deliver a SMALL amount of NATIVE gas on the escrow chain (4663) to the user's own wallet -----
// This is the gas-buffer leg of the pay-any-token flow. When a user pays with a NON-RVLT token, the RVLT convert lands
// on Robinhood (4663) but leaves NO native gas for the VERY NEXT user-signed tx (the approve / buyIn). This route quotes
// a tiny native-gas delivery sourced from the SAME origin token, run as a separate leg BEFORE the RVLT convert so it
// works even when the pay token is the user's only asset. Unlike /api/relay/quote (which forces RVLT), the destination
// here is the escrow chain's NATIVE coin. The amount is SERVER-BOUNDED and small (Robinhood gas is ~$0.002/tx) and is
// CLAMPED to GAS_SLICE_WEI_4663 regardless of any client-supplied amount, so this can never be an arbitrary-swap oracle.
// The gas lands in the user's OWN wallet; unused gas simply stays with them. Inert unless escrow is on. Rate-limited.
const RH_NATIVE = '0x0000000000000000000000000000000000000000';
// Tunable gas slice: ~0.0005 native (Robinhood ETH). At ~$0.002/tx this comfortably covers the one approve + the
// handful of user-signed txs the flow needs, with modest headroom, while staying well under a dollar. Override via env.
const GAS_SLICE_WEI_4663 = (function(){ try{ const v=process.env.VS_GAS_SLICE_WEI; if(v && /^\d+$/.test(String(v))) return BigInt(v); }catch(_){} return 500000000000000n; })();   // 0.0005e18
app.post('/api/relay/gas-quote', express.json({limit:'8kb'}), async (req,res)=>{
  if(!rl(rlKey(req,'relay'),150,60000)) return res.status(429).json({error:'slow down'});
  try{
    const cfg=escrow.config();
    if(!cfg.on) return res.status(409).json({error:'escrow not enabled'});
    const b=req.body||{};
    // Destination is FORCED to the escrow chain's native coin (gas); client amount is IGNORED and clamped to the slice.
    const body={
      user: String(b.user||''),
      recipient: String(b.recipient||b.user||''),
      originChainId: parseInt(b.originChainId,10),
      originCurrency: String(b.originCurrency||RH_NATIVE),
      destinationChainId: cfg.chainId,
      destinationCurrency: RH_NATIVE,
      amount: GAS_SLICE_WEI_4663.toString(),   // SERVER-BOUNDED gas slice, never the client's amount
      tradeType: 'EXACT_OUTPUT'
    };
    if(!body.originChainId) return res.status(400).json({error:'originChainId required'});
    const SOL_B58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, EVM=/^0x[0-9a-fA-F]{40}$/, BTC_ADDR=/^(bc1[a-z0-9]{8,87}|[13][a-km-zA-HJ-NP-Z1-9]{20,40})$/i;
    const isSolOrigin = body.originChainId === 792703809;
    const isBtcOrigin = body.originChainId === 8253038;
    if(isSolOrigin){
      if(!SOL_B58.test(body.user)) return res.status(400).json({error:'valid Solana user address required'});
      if(!SOL_B58.test(body.originCurrency)) return res.status(400).json({error:'originCurrency must be a base58 Solana mint/native for a Solana origin'});
    } else if(isBtcOrigin){
      if(!BTC_ADDR.test(body.user)) return res.status(400).json({error:'valid Bitcoin user address required'});
      if(!BTC_ADDR.test(body.originCurrency)) return res.status(400).json({error:'originCurrency must be a Bitcoin address for a BTC origin'});
    } else {
      if(!EVM.test(body.user)) return res.status(400).json({error:'valid user address required'});
      if(!EVM.test(body.originCurrency)) return res.status(400).json({error:'originCurrency must be a 0x EVM token address or the native sentinel'});
    }
    if(!EVM.test(body.recipient)) return res.status(400).json({error:'valid EVM recipient required (gas lands on Robinhood)'});
    const r=await fetch(`${RELAY_API}/quote`,{method:'POST',headers:RELAY_HEADERS(),body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    res.status(r.status).json(await r.json());
  }catch(e){ res.status(502).json({error:'relay gas quote unavailable'}); }
});
// ---- GAS DRIP (relayer -> gas-short player) -----------------------------------------------------------------
// Sends a TINY, SERVER-BOUNDED amount of native 4663 gas from the RELAYER wallet to a gas-short, SIWE-verified
// player so they can sign the approve/buyIn of a pay-any-token buy. This is the reliable alternative to the Relay
// native-gas delivery, which cannot top up a player already on 4663 (same-chain "send" is rejected, and a gasless
// player can't sign+pay an origin deposit to bridge gas in). MONEY-SAFETY (all enforced here + in escrow.dripNativeTo):
//   - SIWE-GATED: the caller must hold a SIWE-verified session whose address == `user` (same gate /api/autobuy uses).
//   - BOUNDED: the amount is DRIP_WEI in escrow.js (default ~0.0005 native), clamped by a hard ceiling; any client
//     amount is IGNORED (server authoritative).
//   - ONLY WHEN SHORT: escrow.dripNativeTo reads the player's on-chain native balance and sends nothing (skipped)
//     if they already hold >= the reserve.
//   - ONCE PER WALLET: a persisted 24h ledger refuses a second drip to the same wallet (anti-farming); the player
//     is told to top up manually if they burned the first drip.
//   - RATE-LIMITED: per-IP (rlKey) + a global rolling-hour cap, as defense-in-depth on relayer drain.
// It NEVER touches the RVLT approve amount, the range signature, the per-round pulls, or settle.
app.post('/api/gas-drip', express.json({limit:'4kb'}), async (req,res)=>{
  if(!rl(rlKey(req,'gasdrip'),8,60000)) return res.status(429).json({error:'slow down'});
  if(!escrow.isOn()) return res.status(409).json({error:'escrow not enabled'});
  // Relayer must be usable to send (same signer the game already pays gas with). If it isn't, there is nothing to drip.
  if(!escrow.relayUsable()) return res.status(409).json({error:'gas top-up temporarily unavailable', gasDripUnavailable:true});
  const b=req.body||{};
  const user=String(b.user||'').toLowerCase();
  if(!/^0x[0-9a-fA-F]{40}$/.test(user)) return res.status(400).json({error:'valid user address required'});
  // SIWE GATE: the caller must be signed in as THIS wallet (reuse the exact check /api/autobuy + /api/autoplay use).
  const tok=reqToken(req); const reg=tok&&REG[tok];
  if(!(reg&&reg.verified&&reg.address&&reg.address.toLowerCase()===user)) return res.status(401).json({error:'sign in with this wallet (SIWE) first'});
  // FIX 2 (red-team): INTENT GATE. A bare SIWE sign-in is free, so dripping to any verified wallet lets an attacker
  // farm relayer gas from many throwaway wallets. Only drip to a wallet that is actually about to play: a seat
  // candidate for the current/next round OR a wallet with an active, sig-verified auto-buy record. Soft 200 (not a
  // hard error) so the UI simply doesn't show a top-up for a wallet with no buy intent yet. All caps below still apply.
  if(!hasActiveBuyIntent(user)) return res.json({ ok:false, reason:'no active buy intent' });
  // PER-WALLET DAILY BUDGET: allow repeat top-ups (dripNativeTo sends nothing if still funded) up to a small daily cap,
  // with a short min-interval. This lets a returning player who spent their first drip get gas again the same day.
  const _dchk=gasDripCheck(user);
  if(!_dchk.ok) return res.status(429).json({error:_dchk.reason, alreadyDripped:true});
  // GLOBAL rolling-hour cap (relayer-drain defense-in-depth).
  if(!gasDripGlobalOk()) return res.status(429).json({error:'gas top-up busy, try again shortly'});
  try{
    const out=await escrow.dripNativeTo(user);   // server-authoritative amount; reads on-chain balance; sends nothing if funded
    if(!out || out.ok!==true){
      return res.status(502).json({error:(out&&out.reason)||'gas top-up failed', gasDripUnavailable:true});
    }
    if(out.skipped){ return res.json({ ok:true, skipped:true, balWei:out.balWei||null }); }   // already had gas: no send, no ledger write
    // A real send happened: record it (ledger + global counter) and log WITHOUT keys.
    recordGasDrip(user, out.wei, out.tx);
    gasDripGlobalBump();
    try{ console.log('[gas-drip] user='+user+' wei='+out.wei+' tx='+out.tx); }catch(_){}
    return res.json({ ok:true, dripped:true, wei:out.wei, tx:out.tx });
  }catch(e){ return res.status(502).json({error:'gas top-up failed', gasDripUnavailable:true}); }
});
app.get('/api/relay/status', async (req,res)=>{
  if(!rl(rlKey(req,'relay'),150,60000)) return res.status(429).json({error:'slow down'});
  try{ const rid=String(req.query.requestId||''); if(!/^[a-zA-Z0-9_\-]{1,128}$/.test(rid)) return res.status(400).json({error:'bad requestId'}); const r=await fetch(`${RELAY_API}/intents/status?requestId=${encodeURIComponent(rid)}`,{headers:RELAY_HEADERS(),signal:AbortSignal.timeout(12000)}); res.status(r.status).json(await r.json()); }
  catch(e){ res.status(502).json({error:'relay status unavailable'}); }
});
// Solana JSON-RPC proxy. A Relay Solana origin returns raw INSTRUCTIONS (+ address-lookup-tables), not a serialized
// tx, so the browser must fetch a blockhash + the ALT accounts to assemble the VersionedTransaction before the wallet
// signs it. The browser must NOT hit a Solana RPC directly (CORS + no key exposure), so it goes through here. Only
// whitelisted read methods are forwarded (never a raw sendTransaction path the client could abuse as an open relay);
// the signed tx is submitted by the wallet (Phantom) itself. Inert unless escrow is on. Rate-limited.
const SOL_RPC_UPSTREAM = process.env.VS_SOL_RPC || 'https://solana-rpc.publicnode.com';
const SOL_RPC_METHODS = new Set(['getLatestBlockhash','getMultipleAccounts','getAccountInfo','getSignatureStatuses','getAddressLookupTable','getFeeForMessage','getSlot']);
app.post('/api/sol-rpc', express.json({limit:'64kb'}), async (req,res)=>{
  if(!rl(rlKey(req,'solrpc'),120,60000)) return res.status(429).json({error:'slow down'});
  try{
    if(!escrow.config().on) return res.status(409).json({error:'escrow not enabled'});
    const m=req.body && req.body.method;
    if(typeof m!=='string' || !SOL_RPC_METHODS.has(m)) return res.status(400).json({error:'method not allowed'});
    const r=await fetch(SOL_RPC_UPSTREAM,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(req.body),signal:AbortSignal.timeout(15000)});
    res.status(r.status).json(await r.json());
  }catch(e){ res.status(502).json({error:'sol rpc unavailable'}); }
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
// FIX E: PAY-METHOD-AWARE grace margin. The old flat 90s margin refused EVERY buy in the last 90s of the fuse, even a
// DIRECT RVLT buyIn (a single tx, no swap to race the lock) — so on a 300s fuse the "grab the final seat" moment was
// dead for 90s. The margin only needs to cover the time a buy takes to mine before the on-chain lock:
//   * DIRECT RVLT (no swap): a single approve+buyIn, a few seconds -> small margin (~8s).
//   * RELAY SWAP: the swap (~15-45s) + approve + buyIn -> a moderate margin (~28s).
// Both are then CAPPED to <=10% of the configured grace window (floor 6s) so a long fuse stays buyable to near the end.
const PREFLIGHT_GRACE_MARGIN_DIRECT_SEC = Math.max(4, Math.min(120, parseInt(process.env.VS_PREFLIGHT_GRACE_MARGIN_DIRECT_SEC||'8',10)||8));
const PREFLIGHT_GRACE_MARGIN_SWAP_SEC   = Math.max(8, Math.min(600, parseInt(process.env.VS_PREFLIGHT_GRACE_MARGIN_SWAP_SEC||'28',10)||28));
// effectiveGraceMargin(isSwap, graceSec): the margin to actually enforce for this buy. isSwap=false -> direct RVLT
// (small margin); true/undefined -> swap (moderate). When the round's grace window is known, cap to max(6, 10% of it)
// so a 300s fuse allows buys until ~the last <=30s (swap) / ~8s (direct) instead of locking out the final 90s.
function effectiveGraceMargin(isSwap, graceSec){
  const base = isSwap ? PREFLIGHT_GRACE_MARGIN_SWAP_SEC : PREFLIGHT_GRACE_MARGIN_DIRECT_SEC;
  if(graceSec!=null && isFinite(graceSec) && graceSec>0){ return Math.min(base, Math.max(6, Math.floor(graceSec*0.1))); }
  return base;
}
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
    if(String(G.rmId)!==String(buyId)) return { buyOpen:true, graceLeftSec:null, seatsLeft:null, lockInSec:null, offRound:true };
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
// isSwap: true when the buy routes through a RELAY SWAP (needs more lock headroom for the swap to land); false/omitted
// for a DIRECT RVLT buyIn (single tx, only needs a few seconds). FIX E: the grace margin is sized off this + capped to
// the round's grace window so a long fuse stays buyable to near the end (and direct RVLT buys the final seat).
async function preflightBuy(buyId, qty, addr, isSwap){
  if(!escrow.isOn()) return { ok:false, reason:'escrow_off' };
  if(buyId==null) return { ok:false, reason:'no_round' };
  // ANTI-WHALE: a wallet frozen for winning too many in a row cannot buy into a new round until the cooldown ends.
  const frz=isFrozen(addr);
  if(frz) return { ok:false, reason:'frozen', frozenUntil:frz };
  const tickets=Math.max(1,Math.min(MAX_TIX_PER_GAME,parseInt(qty,10)||1));
  // FIX E: pay-method-aware, grace-window-capped margin. The configured fuse ceiling is C.graceMs (Jake's = 300s); the
  // cap keeps the margin at <=10% of it so buy-in only closes in the final few seconds before the vault actually seals.
  const _graceWindowSec = (C && C.graceMs!=null) ? Math.round(C.graceMs/1000) : null;
  const _graceMargin = effectiveGraceMargin(!!isSwap, _graceWindowSec);
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
    if(tm.graceLeftSec!=null && tm.graceLeftSec<_graceMargin) return { ok:false, reason:'round_locking' };  // fuse about to fire (pay-method-aware margin)
    if(tm.seatsLeft!=null && tm.seatsLeft<=0) return { ok:false, reason:'round_full' };
    // ADAPTIVE SEAT MARGIN: the fixed PREFLIGHT_SEAT_MARGIN (default 3) was tuned for ~50-seat launch rounds (refuse
    // only the final few seats so a Relay swap can't race a fill). For SMALL rounds (canary / low roundTarget) a fixed
    // 3 made EVERY round perma-"round_full" (a target-3 round starts at seatsLeft=3 <= 3). Cap the effective margin at
    // ~10% of the round target so small rounds stay Relay-buyable to the last seat; the client's buy-before-swap race
    // fallback (roll to next round / pay RVLT direct) still covers the rare fill-during-swap case.
    // PAY-METHOD-AWARE (pairs with the client stepper cap + the FIX E grace margin): the margin exists ONLY to stop a
    // RELAY SWAP from landing AFTER the round locks. A DIRECT RVLT buy (isSwap false) has no swap race, so it must be
    // allowed to take the very last seat (margin 0) or a target-10 round could never fill past 9/10. A swap keeps the
    // adaptive margin (a slow swap must not land post-lock; the client rolls it to the next heist). Line ~3009
    // (seatsLeft<=0 -> round_full) still blocks a truly full round for both paths.
    const _seatMargin = isSwap ? Math.min(PREFLIGHT_SEAT_MARGIN, Math.floor((Number(getCfg().roundTarget)||50)/10)) : 0;
    if(tm.seatsLeft!=null && tm.seatsLeft>0 && tm.seatsLeft<=_seatMargin) return { ok:false, reason:'round_full' };       // within the (adaptive, swap-only) seat margin of full
    if(tm.lockInSec!=null && tm.lockInSec<_graceMargin) return { ok:false, reason:'round_locking' };        // clock lobby about to close (pay-method-aware margin)
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
  if(!rl(rlKey(req,'relay'),150,60000)) return res.status(429).json({error:'slow down'});
  try{
    const cfg=escrow.config();
    if(!cfg.on) return res.json({ ok:false, reason:'escrow_off' });
    const qty=Math.max(1,Math.min(10,parseInt(req.body&&req.body.qty||'1',10)));
    const user=String(req.body&&req.body.user||'');
    if(user && !/^0x[0-9a-fA-F]{40}$/.test(user)) return res.status(400).json({ ok:false, reason:'bad_user' });
    const buyId=(req.body&&req.body.buyId!=null && /^\d+$/.test(String(req.body.buyId))) ? String(req.body.buyId) : currentBuyRoundId();
    // FIX E: pay-method-aware lock margin. The client sends swap:false for a DIRECT RVLT buy (single tx, small margin)
    // and swap:true (or omits it) for a Relay-swap buy (moderate margin). Default to swap=true (the safer, larger
    // margin) when the flag is absent so an older client is never LESS protected against a swap racing the lock.
    const isSwap = (req.body && req.body.swap===false) ? false : true;
    const pf=await preflightBuy(buyId, qty, user||null, isSwap);
    // ITEM 2 (finish FIX 4): only remember a seat candidate AFTER preflight returned ok (not from the raw body before
    // the gate). This keeps the legit hint (so the seat-sync loop re-checks ticketsOf for a real buyer whose post-buy
    // /api/relay/seat races/fails) while denying an attacker the ability to seed junk candidates that each cost a
    // per-3s on-chain ticketsOf read. Seating still ultimately requires ticketsOf>0; this is only the reconcile hint.
    if(user && pf && pf.ok && pf.roundId!=null) addSeatCandidate(pf.roundId, user);
    res.json(pf);
  }catch(e){ res.status(502).json({ ok:false, reason:'preflight_unavailable' }); }
});
app.post('/api/relay/entry-quote', express.json({limit:'8kb'}), async (req,res)=>{
  try{
    const cfg=escrow.config();
    if(!cfg.on) return res.status(409).json({error:'escrow not enabled'});
    const entryWei=BigInt(cfg.entry||'0'); if(entryWei<=0n) return res.status(409).json({error:'no entry configured'});
    const qty=Math.max(1,Math.min(10,parseInt(req.body&&req.body.qty||'1',10)));
    const user=String(req.body&&req.body.user||'');
    const fromChainId=parseInt(req.body&&req.body.fromChainId,10);
    const fromCurrency=String(req.body&&req.body.fromCurrency||'0x0000000000000000000000000000000000000000');
    // SPLIT SENDER vs RECIPIENT (SOL/BTC origin fix): `user` is ALWAYS the EVM recipient on Robinhood where the RVLT +
    // seat land (preflight, cap, seat attribution are all keyed to it). For a Solana/BTC-origin swap the wallet SENDING
    // on the origin chain is a Solana/Bitcoin address, NOT the EVM one; Relay needs that as the quote `user` or it
    // rejects it ("Invalid address 0x.. for chain 792703809"). The client passes it as `fromUser`; absent (EVM origin)
    // the sender == recipient == the EVM address, exactly as before. We never weaken the EVM recipient validation.
    const fromUser=String(req.body&&req.body.fromUser||'');
    if(!/^0x[0-9a-fA-F]{40}$/.test(user)) return res.status(400).json({error:'valid user address required'});
    if(!fromChainId) return res.status(400).json({error:'fromChainId required'});
    if(fromUser){
      const SOL_B58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, EVM_RE=/^0x[0-9a-fA-F]{40}$/, BTC_ADDR=/^(bc1[a-z0-9]{8,87}|[13][a-km-zA-HJ-NP-Z1-9]{20,40})$/i;
      if(fromChainId===792703809){ if(!SOL_B58.test(fromUser)) return res.status(400).json({error:'valid Solana fromUser required'}); }
      else if(fromChainId===8253038){ if(!BTC_ADDR.test(fromUser)) return res.status(400).json({error:'valid Bitcoin fromUser required'}); }
      else { if(!EVM_RE.test(fromUser)) return res.status(400).json({error:'valid EVM fromUser required'}); }
    }
    // SERVE-CACHED-ON-429 (SHORT 12s TTL). MONEY SAFETY: the entry-quote drives BOTH the display (native unit price)
    // AND the actual buy. The charged amount (deliverWei/costWei) is derived server-side from the on-chain per-wallet
    // price in preflightBuy and is RE-VALIDATED on-chain at buyInViaRelay; the Relay `quote` object carries its own
    // short validity window. A 12s cache only SMOOTHS a burst (the same buyer's pay-grid render + preflight + buy
    // firing within seconds); it can never under/over-charge because the buy re-reads the authoritative amount on
    // chain. We cache the key scoped to (qty, fromChainId, fromCurrency, user, buyId) so two different buyers / params
    // never share a quote. FRESH (<12s) answers instantly; over the limit we serve the recent copy (up to 25s) rather
    // than a 429 so the quote the buy needs is always available. Only successful (2xx) quotes are cached; a preflight
    // failure or Relay error is never served stale.
    const _qk=qty+'|'+fromChainId+'|'+String(fromCurrency).toLowerCase()+'|'+user.toLowerCase()+'|'+(fromUser?fromUser.toLowerCase():'')+'|'+String(currentBuyRoundId());
    const _qnow=Date.now();
    const _qcached=_EQUOTE_CACHE.get(_qk);
    if(_qcached && (_qnow-_qcached.ts)<12000) return res.status(_qcached.status).json(_qcached.data);
    if(!rl(rlKey(req,'relay'),150,60000)){
      if(_qcached && (_qnow-_qcached.ts)<25000) return res.status(_qcached.status).json(_qcached.data);
      return res.status(429).json({error:'slow down'});
    }
    // GATE THE SWAP: re-run the pre-flight here too (not just in the separate endpoint) so a client can never
    // skip it and price/swap into a round that won't accept the buy. buyId may be pinned by the client so the
    // quote, cap check and the later buyIn all target the SAME round.
    const buyId=(req.body&&req.body.buyId!=null && /^\d+$/.test(String(req.body.buyId))) ? String(req.body.buyId) : currentBuyRoundId();
    const pf=await preflightBuy(buyId, qty, user, true);   // FIX E: the entry-quote path is ALWAYS a Relay swap -> swap margin
    if(!pf.ok) return res.status(409).json({ error:'preflight failed', reason:pf.reason, ok:false, buyId:buyId!=null?String(buyId):null });
    // ITEM 2 (finish FIX 4): only remember a seat candidate AFTER preflight returned ok. Previously this ran from the
    // unauthenticated body `user` BEFORE the gate, so one IP could seed up to the per-round candidate cap with junk
    // addresses (each re-read on-chain every ~3s by the reconcile loop). A preflight-ok address is a real, round-valid
    // buyer about to swap, so this keeps the legit pre-swap reconcile hint (a payer whose later seat call fails) while
    // denying never-valid junk. pf.roundId is the exact round the quote + buyIn target.
    if(user && pf.roundId!=null) addSeatCandidate(pf.roundId, user);
    // SINGLE SOURCE OF TRUTH: the required (costWei) + delivered (deliverWei) amounts come straight from the
    // pre-flight, which derived them from the on-chain per-wallet price (holder-discount-aware). We do NOT
    // recompute entry*qty here, so the holder-discount change needs no edit on this path.
    const costWei=BigInt(pf.costWei), deliverWei=BigInt(pf.deliverWei);
    // Relay `user` = the ORIGIN SENDER (fromUser for SOL/BTC origin), else the EVM user. `recipient` = ALWAYS the EVM
    // address on Robinhood where RVLT + the seat land.
    const body={ user:(fromUser||user), recipient:user, originChainId:fromChainId, originCurrency:fromCurrency,
      destinationChainId:cfg.chainId, destinationCurrency:cfg.rvlt, amount:deliverWei.toString(), tradeType:'EXACT_OUTPUT' };
    const r=await fetch(`${RELAY_API}/quote`,{method:'POST',headers:RELAY_HEADERS(),body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const quote=await r.json();
    const _out={ quote, entryWei:entryWei.toString(), costWei:costWei.toString(), deliverWei:deliverWei.toString(), headroomBps:RELAY_HEADROOM_BPS, qty, rvlt:cfg.rvlt, chainId:cfg.chainId, buyId:pf.roundId };
    // Cache ONLY a successful quote (2xx). A Relay error / 4xx is never served stale so the client always re-tries it.
    if(r.status>=200 && r.status<300) _EQUOTE_CACHE.set(_qk,{ts:Date.now(),status:r.status,data:_out});
    res.status(r.status).json(_out);
  }catch(e){ res.status(502).json({error:'entry quote unavailable'}); }
});
// ---- FEATURE 2 (auto-play funding): CONVERT-ONCE-UP-FRONT quote for the N-game budget. The single-buy entry-quote
// prices RVLT for ONE round (qty<=10, pinned to a round's preflight). The auto-play ceremony instead needs to fund a
// WHOLE budget = entry x maxTicketsPerRound x rounds, converting a chosen token -> RVLT ONCE, delivered to the USER'S
// OWN EVM wallet on chain 4663 (exactly like entry-quote's recipient:user). This endpoint is the SERVER-AUTHORITATIVE
// amount source so the client never invents a conversion size:
//   totalWei  = entryWei x totalTickets            (totalTickets = maxTicketsPerRound x rounds, bounded)
//   shortfall = max(0, totalWei - heldRvltWei)      (what the wallet is missing; 0 => no convert needed)
//   deliverWei= shortfall x (1 + buffer)            (price-drift buffer, 3-5% so the convert lands enough RVLT)
// The APPROVE + the range SIGNATURE + the on-chain range bounds are all still EXACT and unchanged; this only sizes the
// pre-funding swap. Any unused RVLT (buffer or an early stop) simply stays in the user's wallet — never auto-pulled
// beyond the signed/approved bound. Relay is MAINNET-ONLY (the escrow module reports chainId; off-mainnet this path is
// never reached because the client only shows the selector when relayAvailable()). No economics/settle logic here.
const FUND_BUFFER_BPS = Math.max(300, Math.min(500, parseInt(process.env.VS_FUND_BUFFER_BPS||'400',10)||400)); // 3-5%, default 4%
app.post('/api/relay/fund-quote', express.json({limit:'8kb'}), async (req,res)=>{
  try{
    const cfg=escrow.config();
    if(!cfg.on) return res.status(409).json({error:'escrow not enabled'});
    const entryWei=BigInt(cfg.entry||'0'); if(entryWei<=0n) return res.status(409).json({error:'no entry configured'});
    const user=String(req.body&&req.body.user||'');
    if(!/^0x[0-9a-fA-F]{40}$/.test(user)) return res.status(400).json({error:'valid EVM user address required'});
    const fromChainId=parseInt(req.body&&req.body.fromChainId,10);
    const fromCurrency=String(req.body&&req.body.fromCurrency||'0x0000000000000000000000000000000000000000');
    if(!fromChainId) return res.status(400).json({error:'fromChainId required'});
    // SPLIT SENDER vs RECIPIENT (same as entry-quote): `user` is the EVM wallet that holds the funded RVLT + signs the
    // auto-play authorization (recipient). For a SOL/BTC-origin convert the sending wallet is a Solana/Bitcoin address,
    // passed as `fromUser`; absent (EVM origin) sender == recipient == the EVM address, unchanged.
    const fromUser=String(req.body&&req.body.fromUser||'');
    if(fromUser){
      const SOL_B58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, EVM_RE=/^0x[0-9a-fA-F]{40}$/, BTC_ADDR=/^(bc1[a-z0-9]{8,87}|[13][a-km-zA-HJ-NP-Z1-9]{20,40})$/i;
      if(fromChainId===792703809){ if(!SOL_B58.test(fromUser)) return res.status(400).json({error:'valid Solana fromUser required'}); }
      else if(fromChainId===8253038){ if(!BTC_ADDR.test(fromUser)) return res.status(400).json({error:'valid Bitcoin fromUser required'}); }
      else { if(!EVM_RE.test(fromUser)) return res.status(400).json({error:'valid EVM fromUser required'}); }
    }
    // BOUND the budget exactly like the client/arm path: rounds 1..50, tickets/round 1..100 (armAutobuy + /api/autobuy
    // already clamp these identically), so totalTickets <= 5000. The amount is derived from the on-chain entry, never
    // from a client figure, so a tampered body cannot inflate the conversion beyond entry x boundedTotalTickets.
    const rounds=Math.max(1,Math.min(50,parseInt(req.body&&req.body.rounds,10)||0));
    const perRound=Math.max(1,Math.min(100,parseInt(req.body&&req.body.maxTicketsPerRound,10)||0));
    if(!rounds||!perRound) return res.status(400).json({error:'rounds + maxTicketsPerRound required'});
    const totalTickets=BigInt(rounds)*BigInt(perRound);
    const totalWei=entryWei*totalTickets;                                 // full RVLT needed to cover the whole budget
    // heldRvltWei: the wallet's CURRENT RVLT balance (server-read on-chain, authoritative). If the read fails we treat
    // held as 0 so we never UNDER-fund (worst case the convert over-delivers a little, which stays in the user's wallet).
    let heldWei=0n;
    try{ const bal=await escrow.rvltBalanceWei(user); if(bal!=null) heldWei=BigInt(bal); }catch(_){ heldWei=0n; }
    const shortfallWei = totalWei>heldWei ? (totalWei-heldWei) : 0n;
    if(shortfallWei<=0n){
      // Already covered: no conversion needed. The client skips straight to approve + range-sign (today's path).
      return res.json({ ok:true, sufficient:true, totalWei:totalWei.toString(), heldWei:heldWei.toString(),
        shortfallWei:'0', deliverWei:'0', rvlt:cfg.rvlt, chainId:cfg.chainId, bufferBps:FUND_BUFFER_BPS,
        rounds, maxTicketsPerRound:perRound, totalTickets:Number(totalTickets) });
    }
    // deliver the shortfall + a price-drift buffer, as RVLT, to the USER'S OWN wallet on the escrow chain (recipient:user).
    const deliverWei=(shortfallWei*BigInt(10000+FUND_BUFFER_BPS))/10000n;
    // Relay `user` = the ORIGIN SENDER (fromUser for SOL/BTC), else the EVM user. `recipient` = ALWAYS the EVM wallet.
    const body={ user:(fromUser||user), recipient:user, originChainId:fromChainId, originCurrency:fromCurrency,
      destinationChainId:cfg.chainId, destinationCurrency:cfg.rvlt, amount:deliverWei.toString(), tradeType:'EXACT_OUTPUT' };
    const r=await fetch(`${RELAY_API}/quote`,{method:'POST',headers:RELAY_HEADERS(),body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const quote=await r.json();
    const _out={ ok:(r.status>=200&&r.status<300), sufficient:false, quote, totalWei:totalWei.toString(),
      heldWei:heldWei.toString(), shortfallWei:shortfallWei.toString(), deliverWei:deliverWei.toString(),
      bufferBps:FUND_BUFFER_BPS, rvlt:cfg.rvlt, chainId:cfg.chainId, rounds, maxTicketsPerRound:perRound, totalTickets:Number(totalTickets) };
    res.status(r.status).json(_out);
  }catch(e){ res.status(502).json({error:'fund quote unavailable'}); }
});
// ---- SEAT ATTRIBUTION (Item B): a successful on-chain buyIn ALWAYS seats the buyer, with NO extra signature. ------
// The client calls this right after buyInOnchain succeeds. We VALIDATE against on-chain truth (escrow.ticketsOf>0) and
// only then upsert the REG w: seat for the CHECKSUMMED paid address + seatWalletCount. ticketsOf==0 => no seat (so a
// caller cannot seat an address that did not actually pay). The address is also added to the persisted candidate set
// so the seat-sync loop / a restart re-reconciles it. This NEVER touches settle/winner logic - the seat just carries
// the real paid address, so the existing isParticipant/payWinners path is unchanged.
app.post('/api/relay/seat', express.json({limit:'2kb'}), async (req,res)=>{
  if(!rl(rlKey(req,'relay'),150,60000)) return res.status(429).json({error:'slow down'});
  try{
    const cfg=escrow.config();
    if(!cfg.on) return res.status(409).json({ seated:false, tickets:0, reason:'escrow_off' });
    const addr=String(req.body&&req.body.addr||'');
    if(!/^0x[0-9a-fA-F]{40}$/.test(addr)) return res.status(400).json({ seated:false, tickets:0, reason:'bad_addr' });
    // roundId: client-pinned buyId it paid into; default to the current buy-round. Must be a plain integer id.
    let roundId=(req.body&&req.body.roundId!=null && /^\d+$/.test(String(req.body.roundId))) ? String(req.body.roundId) : currentBuyRoundId();
    if(roundId==null) return res.status(409).json({ seated:false, tickets:0, reason:'no_round' });
    // FIX 4: do NOT add a seat candidate from this unauthenticated, attacker-controlled body BEFORE the on-chain gate.
    // addSeatCandidate used to run here unconditionally, so one IP could seed up to the per-round candidate cap with junk
    // addresses, each then re-read on-chain (ticketsOf) every ~3s by the reconcile loop. A never-paid candidate has zero
    // reconciliation value, so we only remember it AFTER seatPaidAddress confirms escrow.ticketsOf(roundId,addr)>0.
    const r=await seatPaidAddress(roundId, addr);    // THE GATE: seats only if escrow.ticketsOf(roundId,addr)>0
    if(r.seated && r.tickets>0) addSeatCandidate(roundId, addr);   // confirmed real payer -> remember for restart-safe reconciliation
    try{ console.log('[pay/seat] addr='+addr+' round='+roundId+' seated='+r.seated+' tickets='+r.tickets); }catch(_){}
    res.json({ seated:r.seated, tickets:r.tickets, roundId:String(roundId) });
  }catch(e){ res.status(502).json({ seated:false, tickets:0, reason:'seat_unavailable' }); }
});
// ---- MULTI-CHAIN HELD-BALANCE READER (read-only, server-side) --------------------------------------------------
// The browser can only read the ONE EVM chain the wallet is on, so a Phantom/MetaMask user with funds spread across
// Ethereum/Base/Arbitrum/Optimism/Polygon/BNB (plus Solana, plus USDG on Robinhood) sees only part of what they hold.
// This route reads balances server-side across every supported SOURCE chain + Solana, in parallel with per-call
// timeouts, and returns ONLY non-zero holdings that are actually payable to RVLT via Relay. It reads only (no keys,
// no writes). Prices are best-effort: natives/SOL get a USD figure; stables are ~$1 = amount. Rate-limited.
// Public RPC fallbacks per chain (used after Alchemy, or when Alchemy is not configured / errors).
const PAYRPC_PUBLIC = {
  1:     process.env.VS_RPC_ETH  || 'https://ethereum-rpc.publicnode.com',
  8453:  process.env.VS_RPC_BASE || 'https://base-rpc.publicnode.com',
  42161: process.env.VS_RPC_ARB  || 'https://arbitrum-one-rpc.publicnode.com',
  10:    process.env.VS_RPC_OP   || 'https://optimism-rpc.publicnode.com',
  137:   process.env.VS_RPC_POLY || 'https://polygon-bor-rpc.publicnode.com',
  56:    process.env.VS_RPC_BNB  || 'https://bsc-rpc.publicnode.com',
  4663:  process.env.VS_RPC || 'https://rpc.mainnet.chain.robinhood.com'
};
// P3: SECONDARY public RPCs for the chains that otherwise have only ONE endpoint (an outage there would hide ALL that
// chain's assets). BNB and Robinhood each get a second fallback, appended after the primary in payRpcList + deduped.
const PAYRPC_PUBLIC2 = {
  56:   process.env.VS_RPC_BNB2 || 'https://bsc.drpc.org',
  4663: process.env.VS_RPC_RH2  || ''
};
// ALCHEMY: resolved from the group env var `Alchemy` (raw key OR full URL), kept through the boot env-wipe (added to
// KEEP above). Used as the PRIMARY EVM read endpoint for the Alchemy-supported chains, because the public chain-1 RPC
// was flaky and ETH-mainnet balances intermittently never surfaced. Mirrors the HELIUS_SOL_RPC resolution. The
// Alchemy host subdomain differs per chain; BNB (56) is NOT on Alchemy (keep its public RPC), 4663 stays Robinhood.
const _ALCHEMY_RAW = process.env.Alchemy ? String(process.env.Alchemy).trim() : '';
const _ALCHEMY_IS_URL = /^https?:\/\//.test(_ALCHEMY_RAW);
const _ALCHEMY_HOST_BY_CHAIN = { 1:'eth-mainnet', 8453:'base-mainnet', 42161:'arb-mainnet', 10:'opt-mainnet', 137:'polygon-mainnet' };
function alchemyUrl(chainId){
  if(!_ALCHEMY_RAW) return '';
  const host=_ALCHEMY_HOST_BY_CHAIN[chainId]; if(!host) return '';   // chain not on Alchemy (e.g. BNB 56, Robinhood 4663)
  if(_ALCHEMY_IS_URL){
    // A full URL was supplied. If it already targets this chain's host, use it as-is; otherwise swap the host
    // subdomain so one configured URL still serves every Alchemy chain (the key/path are preserved).
    try{ const u=new URL(_ALCHEMY_RAW); const parts=u.hostname.split('.'); if(parts.length>=4 && parts[1]==='g' && parts[2]==='alchemy'){ parts[0]=host; u.hostname=parts.join('.'); return u.toString(); } }catch(_){}
    return _ALCHEMY_RAW;   // non-standard URL shape: use verbatim (caller still falls back to public on error)
  }
  return 'https://'+host+'.g.alchemy.com/v2/'+_ALCHEMY_RAW;   // raw key
}
// Ordered read endpoints per chain: Alchemy first (when available for that chain), then the public fallback(s).
function payRpcList(chainId){
  const out=[]; const a=alchemyUrl(chainId); if(a) out.push(a);
  const p=PAYRPC_PUBLIC[chainId]; if(p && out.indexOf(p)<0) out.push(p);
  const p2=PAYRPC_PUBLIC2[chainId]; if(p2 && out.indexOf(p2)<0) out.push(p2);   // P3: second fallback for single-RPC chains
  return out;
}
// Back-compat: the single "primary" URL per chain (Alchemy if present, else public). Used anywhere a single URL is read.
const PAYRPC = (function(){ const m={}; for(const c of Object.keys(PAYRPC_PUBLIC).map(Number)){ const l=payRpcList(c); m[c]=l[0]||PAYRPC_PUBLIC[c]; } return m; })();
// Solana read endpoints. VS_SOL_SPL_RPC (Jake's dedicated key) is the PRIMARY for ALL Solana reads (native balance
// + SPL token balance + any Solana quote-side need); the public endpoints are fallbacks only. Setting VS_SOL_SPL_RPC
// in the env is all that is needed to harden every Solana read here.
// Helius RPC resolved from the group env var `Helius` (raw key OR full URL); it is kept through the boot env-wipe (added
// to KEEP above) and used as the PRIMARY Solana endpoint, since public RPCs frequently block getTokenAccountsByOwner.
const HELIUS_SOL_RPC = process.env.Helius ? (/^https?:\/\//.test(String(process.env.Helius).trim()) ? String(process.env.Helius).trim() : ('https://mainnet.helius-rpc.com/?api-key='+String(process.env.Helius).trim())) : '';
const SOL_READ_RPCS = [ HELIUS_SOL_RPC, (process.env.VS_SOL_SPL_RPC||''), (process.env.VS_SOL_RPC||''), 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com' ].filter(Boolean);
const PAY_SOL_RPC = SOL_READ_RPCS[0];   // primary (kept for callers that want a single URL)
// Try a Solana JSON-RPC method across the configured endpoints in order; returns the first non-error result, else null.
async function solRpc(method, params, timeoutMs){
  for(const url of SOL_READ_RPCS){
    try{
      const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(timeoutMs||7000)});
      const j=await r.json(); if(j&&j.error) continue; if(j&&j.result!==undefined) return j.result;
    }catch(_){ /* try next */ }
  }
  return null;
}
// Native coin symbol + pay-key + CoinGecko id per source chain. The KEY is per-SYMBOL (not a generic 'eth') so the
// dedup keeps ETH, BNB and POL as SEPARATE entries. POLYGON NATIVE (POL, 137) is kept here ONLY so its balance is read
// for the Polygon-stablecoin gas check (a USDC/USDT/DAI payment on 137 needs POL gas); it is NOT surfaced as a pay chip
// (NO_NATIVE_PAY_CHAINS below), because its Relay route to RVLT/4663 deposits through a non-canonical swap-router
// (0xb92f..., a 7.5 KB-calldata path) unlike every other native chain's canonical 0x4cd0... deposit and does not
// complete reliably. Polygon STABLES still pay fine (canonical deposit), so a Polygon holder is never stranded.
const PAY_NATIVE_META = {
  1:{sym:'ETH',key:'eth',cg:'ethereum'}, 8453:{sym:'ETH',key:'eth',cg:'ethereum'}, 42161:{sym:'ETH',key:'eth',cg:'ethereum'},
  10:{sym:'ETH',key:'eth',cg:'ethereum'}, 137:{sym:'POL',key:'pol',cg:'matic-network'}, 56:{sym:'BNB',key:'bnb',cg:'binancecoin'}
};
// Chains whose NATIVE coin is read for gas but NEVER offered as a pay chip (its cross-chain native route is unreliable).
const NO_NATIVE_PAY_CHAINS = new Set([137]);   // Polygon native POL: non-canonical deposit route, removed from pay options
// Per-chain stable token maps (address + REAL decimals). USDC/USDT are 6-dec everywhere EXCEPT BSC (18); DAI is
// 18-dec everywhere; USDG on Robinhood is the 6-dec canonical contract (NOT the 18-dec same-symbol spam token).
const PAY_TOKENS = {
  1:   [ {key:'usdc',sym:'USDC',addr:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',dec:6},
         {key:'usdt',sym:'USDT',addr:'0xdAC17F958D2ee523a2206206994597C13D831ec7',dec:6},
         {key:'dai', sym:'DAI', addr:'0x6B175474E89094C44Da98b954EedeAC495271d0F',dec:18} ],
  8453:[ {key:'usdc',sym:'USDC',addr:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',dec:6},
         {key:'dai', sym:'DAI', addr:'0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',dec:18} ],
  42161:[{key:'usdc',sym:'USDC',addr:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831',dec:6},
         {key:'usdt',sym:'USDT',addr:'0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',dec:6},
         {key:'dai', sym:'DAI', addr:'0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',dec:18} ],
  10:  [ {key:'usdc',sym:'USDC',addr:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',dec:6},
         {key:'usdt',sym:'USDT',addr:'0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',dec:6},
         {key:'dai', sym:'DAI', addr:'0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',dec:18} ],
  137: [ {key:'usdc',sym:'USDC',addr:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',dec:6},
         {key:'usdt',sym:'USDT',addr:'0xc2132D05D31c914a87C6611C10748AEb04B58e8F',dec:6},
         {key:'dai', sym:'DAI', addr:'0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',dec:18} ],
  56:  [ {key:'usdc',sym:'USDC',addr:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',dec:18},
         {key:'usdt',sym:'USDT',addr:'0x55d398326f99059fF775485246999027B3197955',dec:18},
         {key:'dai', sym:'DAI', addr:'0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',dec:18} ],
  4663:[ {key:'usdg',sym:'USDG',addr:'0x5fc5360d0400a0fd4f2af552add042d716f1d168',dec:6},
         // RVLT held on Robinhood is the DIRECT buy-in asset (no Relay swap); surface it so the wallet that already
         // holds ROBINVAULT sees it as a pay option. dec 18. addr is read at request time from escrow.config().rvlt.
         {key:'rvlt',sym:'RVLT',addr:'__RVLT__',dec:18} ]
};
function payScale(rawHex, dec){ try{ const raw=BigInt(rawHex); const d=10n**BigInt(dec); const whole=raw/d; const frac=raw%d; const fs=frac.toString().padStart(dec,'0'); return Number(whole.toString()+'.'+fs); }catch(_){ return 0; } }
async function payEvmRpc(chainId, method, params, timeoutMs){
  const urls=payRpcList(chainId); if(!urls.length) return null;
  for(const url of urls){
    try{
      const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(timeoutMs||6000)});
      const j=await r.json(); if(j&&j.error) continue;   // provider error -> try the next endpoint
      if(j && j.result!==undefined) return j.result;
    }catch(_){ /* try next endpoint */ }
  }
  return null;
}
// P4: short-lived BALANCE last-known-good cache. Keyed `${address}:${chainId}:${currency}` (currency='native' or the
// token address), ~180s TTL. A 2-min-stale balance beats a DROPPED chip when every RPC for a chain is momentarily
// down. On a fresh-enough cached value we skip the RPC entirely; on a null/failed live read we serve the cached hex.
const _balCache={}; const BAL_TTL=180000;
async function payEvmBalance(address, chainId, currency, data){
  const key=address.toLowerCase()+':'+chainId+':'+String(currency).toLowerCase();
  const now=Date.now(); const c=_balCache[key]||(_balCache[key]={});
  if(c.hex!=null && now-(c.t||0)<BAL_TTL) return c.hex;   // fresh cached balance, no RPC call
  let hex;
  if(currency==='native') hex=await payEvmRpc(chainId,'eth_getBalance',[address,'latest'],6000);
  else hex=await payEvmRpc(chainId,'eth_call',[{to:currency,data},'latest'],6000);
  if(hex!=null && hex!=='0x'){ c.hex=hex; c.t=now; return hex; }    // live read ok -> cache + return
  if(hex==='0x'){ c.hex='0x'; c.t=now; return '0x'; }               // genuine empty balance -> cache the zero too
  if(c.hex!=null) return c.hex;                                     // live read FAILED (null) -> serve LKG if we have one
  return null;                                                      // never read this balance before
}
// ---- PRICE CACHE with LAST-KNOWN-GOOD (never drop a held asset on a cold/flaky price) ----------------------------
// Each price key keeps { v: fresh value, t: fresh timestamp, lkg: last-known-good (sticky forever once set) }. A read
// returns the fresh value within FRESH_TTL; otherwise it tries to refetch. On refetch success it updates BOTH v and
// lkg; on refetch failure it returns the LKG value (never null once we've ever had a price) and kicks a background
// refresh so the next call is current. This mirrors the RVLT-peg fix: an asset the wallet HOLDS must not vanish from
// the held set just because a price lookup was momentarily cold.
const _pxCache={};
const PX_FRESH_TTL=300000;   // 5 min: within this, serve the cached value without any network call
// fetchFn resolves to a positive number or null. Returns the fresh value, else the LKG value, else null (never seen).
async function pxGet(key, fetchFn){
  const now=Date.now(); const c=_pxCache[key]||(_pxCache[key]={});
  if(c.v!=null && c.v>0 && now-(c.t||0)<PX_FRESH_TTL) return c.v;   // fresh
  // need a refresh. If we have an LKG, do the fetch but fall back to LKG on failure (never return null).
  try{
    const v=await fetchFn();
    if(v!=null && v>0){ c.v=v; c.t=now; c.lkg=v; return v; }
  }catch(_){}
  // fetch failed or returned nothing: serve the last-known-good, and refresh in the background for next time.
  if(c.lkg!=null && c.lkg>0){
    if(!c._bg){ c._bg=true; Promise.resolve().then(fetchFn).then(v=>{ if(v!=null && v>0){ c.v=v; c.t=Date.now(); c.lkg=v; } }).catch(()=>{}).finally(()=>{ c._bg=false; }); }
    return c.lkg;
  }
  return null;   // never had a price for this key yet (pre-warmup, brand-new instance)
}
// Native USD unit price: Relay first (authoritative, matches the buy path), CoinGecko fallback; LKG-sticky.
async function _fetchNativeUsd(chainId, meta){
  try{
    const cfg=escrow.config();
    const body={ user:'0x0000000000000000000000000000000000000001', recipient:'0x0000000000000000000000000000000000000001',
      originChainId:chainId, originCurrency:'0x0000000000000000000000000000000000000000',
      destinationChainId:cfg.chainId, destinationCurrency:cfg.rvlt, amount:(10n**18n).toString(), tradeType:'EXACT_INPUT' };
    const r=await fetch(`${RELAY_API}/quote`,{method:'POST',headers:RELAY_HEADERS(),body:JSON.stringify(body),signal:AbortSignal.timeout(9000)});
    const j=await r.json(); const ci=j&&j.details&&j.details.currencyIn;
    const usd=ci&&Number(ci.amountUsd), amt=ci&&Number(ci.amountFormatted);
    if(usd>0 && amt>0) return usd/amt;
  }catch(_){}
  try{
    const r=await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${meta.cg}&vs_currencies=usd`,{signal:AbortSignal.timeout(7000)});
    const j=await r.json(); const v=j&&j[meta.cg]&&Number(j[meta.cg].usd);
    if(v>0) return v;
  }catch(_){}
  return null;
}
async function nativeUsdPrice(chainId){
  const meta=PAY_NATIVE_META[chainId]; if(!meta) return null;
  return pxGet(meta.cg, ()=>_fetchNativeUsd(chainId, meta));
}
async function _fetchSolUsd(){
  try{ const r=await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',{signal:AbortSignal.timeout(7000)}); const j=await r.json(); const v=j&&j.solana&&Number(j.solana.usd); if(v>0) return v; }catch(_){}
  return null;
}
async function solUsdPrice(){ return pxGet('solana', _fetchSolUsd); }
async function _fetchBtcUsd(){
  try{ const r=await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',{signal:AbortSignal.timeout(7000)}); const j=await r.json(); const v=j&&j.bitcoin&&Number(j.bitcoin.usd); if(v>0) return v; }catch(_){}
  try{ const r=await fetch('https://mempool.space/api/v1/prices',{signal:AbortSignal.timeout(7000)}); const j=await r.json(); const v=j&&Number(j.USD); if(v>0) return v; }catch(_){}
  return null;
}
async function btcUsdPrice(){ return pxGet('bitcoin', _fetchBtcUsd); }
// Confirmed BTC balance (in BTC) for an address, from mempool.space (primary) then blockstream.info (fallback).
// sats = chain_stats.funded_txo_sum - chain_stats.spent_txo_sum. Returns 0 on any failure.
const BTC_RELAY_CHAIN = 8253038;   // Relay Bitcoin mainnet chain id (deposit-address model), matches the client
async function btcBalance(addr){
  const hosts=['https://mempool.space/api','https://blockstream.info/api'];
  for(const h of hosts){
    try{
      const r=await fetch(h+'/address/'+encodeURIComponent(addr),{signal:AbortSignal.timeout(7000)});
      if(!r.ok) continue;
      const j=await r.json(); const cs=j&&j.chain_stats;
      if(cs && cs.funded_txo_sum!=null && cs.spent_txo_sum!=null){ const sats=Number(cs.funded_txo_sum)-Number(cs.spent_txo_sum); if(sats>0) return sats/1e8; return 0; }
    }catch(_){ /* try next host */ }
  }
  return 0;
}
// RVLT USD unit price (so the held RVLT chip can show "$X" not a bare amount). Derived from Relay: price a known
// chunk of native ETH on Robinhood -> RVLT, read RVLT out amountUsd / amountFormatted. Cached ~5 min. Null on fail.
// RVLT/USD unit price. PRIMARY source is the WARM PEG: PEG.lastWei is entryUsd worth of RVLT (18-dec wei), so
// rvltUsd = entryUsd / (PEG.lastWei in RVLT). The #224 boot warmup + persisted PEG_FILE seed PEG.lastWei, so after
// boot this returns a positive number on the VERY FIRST call (no cold-drop that would make a held-RVLT wallet show
// held:[]). Secondary: the Relay quote path. Returns null only if the peg is unseeded AND Relay fails. Cached ~5 min,
// but a cold call still resolves from the peg synchronously (no await) so RVLT is never dropped by a slow network.
function rvltUsdFromPeg(){
  try{
    const entryUsd=Number(getCfg().entryUsd)||10;
    const lw=PEG.lastWei;   // BigInt wei of RVLT == entryUsd
    if(lw && lw>0n){ const rvltUnits=Number(lw)/1e18; if(rvltUnits>0){ const v=entryUsd/rvltUnits; if(v>0 && isFinite(v)) return v; } }
  }catch(_){}
  return null;
}
async function rvltUsdPrice(){
  const now=Date.now(); const c=_pxCache['rvlt']; if(c && now-c.t<300000) return c.v;
  // PRIMARY: warm peg (synchronous, always positive once the peg is seeded). Cache + return immediately.
  const pegV=rvltUsdFromPeg();
  if(pegV!=null){ _pxCache['rvlt']={t:now,v:pegV}; return pegV; }
  // SECONDARY: Relay quote (only reached before the peg is ever seeded, e.g. a brand-new instance pre-warmup).
  try{
    const cfg=escrow.config();
    const body={ user:'0x0000000000000000000000000000000000000001', recipient:'0x0000000000000000000000000000000000000001',
      originChainId:cfg.chainId, originCurrency:'0x0000000000000000000000000000000000000000',
      destinationChainId:cfg.chainId, destinationCurrency:cfg.rvlt, amount:(10n**16n).toString(), tradeType:'EXACT_INPUT' };
    const r=await fetch(`${RELAY_API}/quote`,{method:'POST',headers:RELAY_HEADERS(),body:JSON.stringify(body),signal:AbortSignal.timeout(9000)});
    const j=await r.json(); const co=j&&j.details&&j.details.currencyOut;
    const usd=co&&Number(co.amountUsd), amt=co&&Number(co.amountFormatted);
    if(usd>0 && amt>0){ const v=usd/amt; _pxCache['rvlt']={t:now,v}; return v; }
  }catch(_){}
  // LAST: re-check the peg (it may have been seeded concurrently by the warmup) so we still avoid a null.
  const pegV2=rvltUsdFromPeg(); if(pegV2!=null){ _pxCache['rvlt']={t:now,v:pegV2}; return pegV2; }
  return null;
}
// SPL token balance for a Solana owner + mint, via getTokenAccountsByOwner (jsonParsed). Returns a float. 0 on fail.
// NOTE: some public RPCs (e.g. publicnode) block getTokenAccountsByOwner as an "indexed request"; the official Solana
// Labs RPC permits it. So this tries the configured RPC first, then a fallback that is known to allow the method.
const SOL_USDC_MINT='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';   // Solana USDC (6 decimals)
// SPL token balance via getTokenAccountsByOwner (jsonParsed), using the unified Solana RPC list (VS_SOL_SPL_RPC first).
// Some public RPCs block this method as an "indexed request"; solRpc skips any endpoint that errors and tries the next.
async function solSplBalance(owner, mint){
  const res=await solRpc('getTokenAccountsByOwner',[owner,{mint},{encoding:'jsonParsed'}],7000);
  const accts=res&&res.value;   // solRpc returns the full result object {context, value:[...]}
  if(!Array.isArray(accts)) return 0;
  let amt=0; for(const a of accts){ try{ amt+=Number(a.account.data.parsed.info.tokenAmount.uiAmount||0); }catch(_){} }
  return amt;
}
// ---- FEASIBILITY: can this wallet actually complete a $10 entry with this asset, end to end? -----------------
// Dust like $0.31 ETH must be HIDDEN. For each asset we check: (a) enough value, (b) a real Relay route exists and
// its cost is covered, (c) GAS: a token payment needs native gas on its origin chain; a native payment must keep a
// gas reserve on top of the entry. RVLT (direct buy-in) uses a DIFFERENT model: no Relay buffer, just the exact
// required RVLT + a little Robinhood gas.
// Native-gas USD reserve per origin chain: enough to approve+swap (L1 pricier than L2s). Err high so we never
// surface an asset that would then fail for gas. USD figures (converted to native via the chain's native price).
const GAS_RESERVE_USD = { 1:4.0, 8453:0.25, 42161:0.25, 10:0.25, 137:0.15, 56:0.6, 4663:0.25 };
// Relay cost (USD the player pays IN) to deliver one entry of RVLT from (chain,currency). Quotes EXACT_OUTPUT of the
// configured entry RVLT; reads details.currencyIn.amountUsd. null when NO route exists (asset then hidden). Cached ~60s.
// LAST-KNOWN-GOOD entry-cost cache. A transient Relay failure (e.g. "Could not process request. Please try again
// later.") must NOT hide an asset that was routable before (Jake's cold-drop class). We keep { v, t, lkg }: a fresh
// value within 60s is served directly; on a failed/transient refresh we serve the LKG cost (never null once we've
// ever priced this route) and background-refresh. Only a DEFINITIVE no-route (Relay says no liquidity/unsupported)
// returns null, and even then only if we never had a good cost for it. Natives on supported chains + the RVLT
// destination are known-routable, so a flaky quote never drops them.
const _costCache={};
function _relayDefinitiveNoRoute(j){ try{ const m=String((j&&(j.message||j.error))||'').toLowerCase(); return /no route|insufficient liquidity|unsupported|not supported|no liquidity|cannot be bridged|no quotes/.test(m); }catch(_){ return false; } }
async function _fetchEntryCost(fromChainId, fromCurrency){
  const cfg=escrow.config();
  const SOL_B58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  // P2: the EVM dummy user 0x...0001 is REJECTED by Relay for a same-chain 4663 quote; the peg relay uses 0x...dEaD and
  // works. Use 0x...dEaD as the EVM dummy (recipient too) so a same-chain / future route still quotes. Solana dummy kept.
  const EVM_DUMMY='0x000000000000000000000000000000000000dEaD';
  const dummyUser = (fromChainId===792703809 || SOL_B58.test(String(fromCurrency)))
    ? 'So11111111111111111111111111111111111111112' : EVM_DUMMY;
  const body={ user:dummyUser, recipient:EVM_DUMMY, originChainId:fromChainId, originCurrency:fromCurrency,
    destinationChainId:cfg.chainId, destinationCurrency:cfg.rvlt, amount:String(cfg.entry||'0'), tradeType:'EXACT_OUTPUT' };
  const r=await fetch(`${RELAY_API}/quote`,{method:'POST',headers:RELAY_HEADERS(),body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const j=await r.json(); const ci=j&&j.details&&j.details.currencyIn;
  const usd=ci&&Number(ci.amountUsd);
  if(usd>0) return { usd, definitiveNoRoute:false };
  return { usd:null, definitiveNoRoute:_relayDefinitiveNoRoute(j) };   // distinguish a real no-route from a transient error
}
async function relayEntryCostUsd(fromChainId, fromCurrency){
  const key=fromChainId+':'+String(fromCurrency).toLowerCase();
  const now=Date.now(); const c=_costCache[key]||(_costCache[key]={});
  if(c.v!=null && c.v>0 && now-(c.t||0)<60000) return c.v;   // fresh
  try{
    const res=await _fetchEntryCost(fromChainId, fromCurrency);
    if(res.usd!=null && res.usd>0){ c.v=res.usd; c.t=now; c.lkg=res.usd; return res.usd; }
    // the quote came back WITHOUT a cost. If Relay definitively says no route AND we never had one, it's truly unroutable.
    if(res.definitiveNoRoute && !(c.lkg>0)){ c.v=null; c.t=now; return null; }
    // otherwise treat as transient: serve the last-known-good if we have one, and refresh in the background.
  }catch(_){ /* network error -> transient; fall through to LKG */ }
  if(c.lkg>0){
    if(!c._bg){ c._bg=true; Promise.resolve().then(()=>_fetchEntryCost(fromChainId, fromCurrency)).then(res=>{ if(res&&res.usd>0){ c.v=res.usd; c.t=Date.now(); c.lkg=res.usd; } }).catch(()=>{}).finally(()=>{ c._bg=false; }); }
    return c.lkg;
  }
  return null;   // never had a cost for this route (and not definitively no-route): caller hides until first good quote
}
// Decide feasibility for one held asset. Returns { feasible, reason }. nativeByChain = {chainId: nativeCoinUsdValue}
// held on the wallet (for the gas check on token payments). solNativeUsd = SOL value held (gas for Solana swaps).
async function assetFeasible(h, ctx){
  const entryUsd = Number(getCfg().entryUsd)||10;
  // RVLT DIRECT: no Relay. Required = exact on-chain RVLT (requiredRvltWei, holder-aware) or the pegged entry RVLT.
  if(h.key==='rvlt'){
    const needRvlt = Number(ctx.requiredRvlt)||0;                 // RVLT units required for 1 ticket
    if(!(needRvlt>0)) return { feasible:false, reason:'no_price' };
    if(h.amount < needRvlt*1.001) return { feasible:false, reason:'low_balance' };   // tiny dust margin only
    // needs a little Robinhood native gas for approve+buyIn
    const rhGas = Number(ctx.nativeByChain[4663]||0);
    if(!(rhGas >= (GAS_RESERVE_USD[4663]||0.25))) return { feasible:false, reason:'low_gas' };
    return { feasible:true, reason:'ok' };
  }
  // BTC: Relay deposit-address model (no EVM gas, no on-chain approval). BTC carries a network fee + bridge
  // slippage, so gate on a USD threshold = entry + a sensible buffer (max of +30% or +$3) rather than a live quote
  // (a BTC origin quote needs a BTC user address we don't synthesize here). ~$14.68 clears a $10 entry comfortably.
  if(h.key==='btc'){
    if(h.usd==null || !(h.usd>0)) return { feasible:false, reason:'no_price' };
    const buffer = Math.max(entryUsd*0.30, 3);
    if(h.usd < entryUsd + buffer) return { feasible:false, reason:'low_balance' };
    return { feasible:true, reason:'ok' };
  }
  // ROBINHOOD SAME-CHAIN assets (chain 4663): Robinhood-native ETH AND the 4663 TOKENS (USDG) are SAME-CHAIN swaps to
  // RVLT (origin==destination, NO bridge), so we gate on a USD THRESHOLD (entry + buffer), NOT a live Relay quote. The
  // dummy-address cost probe for same-chain 4663 is intermittently rejected by Relay ("Could not process request"),
  // which would otherwise permanently hide a genuinely routable asset (e.g. USDG $18.9 or ETH $24). The real buy still
  // routes via buyInViaRelay on 4663. P1: this now covers TOKENS too (was native-only in round 11).
  if(h.chainId===4663){
    if(h.usd==null || !(h.usd>0)) return { feasible:false, reason:'no_price' };
    const buffer = Math.max(entryUsd*0.20, 1.5);   // covers same-chain swap premium
    if(h.usd < entryUsd + buffer) return { feasible:false, reason:'low_balance' };   // dust ($0.31) still hidden
    if(h.token!=='native'){
      // a 4663 TOKEN (USDG) also needs a little Robinhood native gas to approve+swap; native ETH pays gas from itself.
      const rhGas = Number(ctx.nativeByChain[4663]||0);
      if(!(rhGas >= (GAS_RESERVE_USD[4663]||0.25))) return { feasible:false, reason:'low_gas' };
    }
    return { feasible:true, reason:'ok' };
  }
  // Everything else is a Relay (bridged/swapped) asset: value must cover the quoted cost, a route must exist, gas.
  if(h.usd==null || !(h.usd>0)) return { feasible:false, reason:'no_price' };
  const fromCurrency = ctx.fromCurrency(h);
  if(!fromCurrency) return { feasible:false, reason:'no_route' };
  const costUsd = await relayEntryCostUsd(h.chainId, fromCurrency);
  if(costUsd==null) return { feasible:false, reason:'no_route' };
  const isNative = (h.token==='native');
  const gasRes = GAS_RESERVE_USD[h.chainId] || (h.chainId===792703809 ? 0.02 : 0.25);
  if(isNative){
    // native payment also pays its own gas: need cost + gas reserve out of the SAME balance.
    if(h.usd < costUsd + gasRes) return { feasible:false, reason:'low_balance' };
  } else {
    // token payment: value must cover the quoted cost (small margin), AND native gas must exist on that origin chain.
    if(h.usd < costUsd * 1.01) return { feasible:false, reason:'low_balance' };
    if(h.chainId===792703809){
      // P7: Solana-USDC gas is SOL. If the SOL native read FAILED (solNativeUsd unknown), do NOT silently drop the
      // USDC-SPL for low_gas - treat unknown as allow (Relay covers tiny SOL rent anyway) and log it. Only block when
      // we KNOW the SOL balance and it is below the (tiny) reserve.
      const solKnown = (ctx.solNativeUsd!=null);
      const solGas = Number(ctx.solNativeUsd||0);
      if(solKnown && solGas>0 && solGas < gasRes) return { feasible:false, reason:'low_gas' };
      if(!solKnown || solGas===0){ try{ console.log('[pay/balances] solana-usdc gas unknown/zero (solNativeUsd='+ctx.solNativeUsd+'), allowing'); }catch(_){} }
    } else {
      const gasHeld = Number(ctx.nativeByChain[h.chainId]||0);
      if(!(gasHeld >= gasRes)) return { feasible:false, reason:'low_gas' };
    }
  }
  return { feasible:true, reason:'ok' };
}
const _PAYBAL_CACHE=new Map();   // addrKey -> {ts,data}: the modal re-reads on every live state push, so cache + serve-cached kills the repeat RPC fan-out AND the 429 storm behind the shared custom-domain proxy IP
const _PRICING_CACHE=new Map();  // (qty|addr|buyId) -> {ts,data}: same serve-cached-on-429 pattern for /api/pricing (holder-aware per-ticket price read); fresh 20s, serve-recent up to 2min under a burst
const _EQUOTE_CACHE=new Map();   // (qty|fromChainId|fromCurrency|user|buyId) -> {ts,status,data}: SHORT (~12s) serve-cached-on-429 for /api/relay/entry-quote so a buyer's display+buy burst can't 429 the quote; amount stays server-authoritative + re-validated on-chain at buyInViaRelay
app.get('/api/pay/balances', async (req,res)=>{
  const cfg=escrow.config();
  if(!cfg.on) return res.status(409).json({error:'escrow not enabled'});
  const evm=String(req.query.evm||'').trim();
  const sol=String(req.query.sol||'').trim();
  const btc=String(req.query.btc||'').trim();
  const _ck=evm.toLowerCase()+'|'+sol+'|'+btc;
  const _now=Date.now();
  const _cached=_PAYBAL_CACHE.get(_ck);
  // FRESH cache (<12s): answer the repeat read instantly, no RPC fan-out, no rate-limit hit.
  if(_cached && (_now-_cached.ts)<12000) return res.json(_cached.data);
  // Over the limit but we have a recent-ish copy? Serve it (up to 2min) instead of a 429 so the client never
  // shows "could not read your wallet" during a burst behind the shared proxy IP.
  if(!rl(rlKey(req,'paybal'),240,60000)){
    if(_cached && (_now-_cached.ts)<120000) return res.json(_cached.data);
    return res.status(429).json({error:'slow down'});
  }
  try{
    const EVM=/^0x[0-9a-fA-F]{40}$/, SOL_B58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    const BTC_ADDR=/^(bc1[a-z0-9]{8,87}|[13][a-km-zA-HJ-NP-Z1-9]{20,40})$/i;   // bech32 or legacy base58
    const haveEvm = evm && EVM.test(evm);
    const haveSol = sol && SOL_B58.test(sol);
    const haveBtc = btc && BTC_ADDR.test(btc);
    if(!haveEvm && !haveSol && !haveBtc) return res.status(400).json({error:'valid evm, sol or btc address required'});
    const held=[];           // {key,symbol,chainId,token,amount,usd}
    const nativeUsdByChain={};   // chainId -> native coin USD value held (for the GAS feasibility check), incl 4663
    const jobs=[];
    if(haveEvm){
      // Robinhood native ETH (4663): read ONCE and use for BOTH (a) the GAS balance for the direct RVLT buy-in and
      // same-chain USDG swap (nativeUsdByChain[4663]), AND (b) a PAYABLE ETH entry. It is Relay-routable as a
      // SAME-CHAIN swap to RVLT on 4663 (confirmed: native -> RVLT, no bridge). key 'eth' so it joins the ETH dedup
      // set across chains (1/8453/42161/10/4663) and the max-USD chain wins; feasibility gates out the dust case.
      jobs.push((async()=>{
        const hex=await payEvmBalance(evm,4663,'native');   // P4: LKG-cached
        if(hex){ const amt=payScale(hex,18); const px=await nativeUsdPrice(1); const usd= px? amt*px : 0;
          nativeUsdByChain[4663]= usd;
          if(amt>0.000001 && usd>0){ held.push({ key:'eth', symbol:'ETH', chainId:4663, token:'native', amount:amt, usd, nativeAmt:amt }); } }
      })());
      for(const chainId of Object.keys(PAYRPC).map(Number)){
        // native (skip Robinhood native here: RVLT is the direct asset there; native ETH on 4663 is not a pay option)
        if(PAY_NATIVE_META[chainId]){
          jobs.push((async()=>{
            const hex=await payEvmBalance(evm,chainId,'native');   // P4: LKG-cached
            if(hex){ const amt=payScale(hex,18); const px=await nativeUsdPrice(chainId); const usd= px? amt*px : null;
              if(usd!=null) nativeUsdByChain[chainId]=usd;   // record for the token gas check even if below the display floor
              // POL native (137) is READ for the Polygon-stablecoin gas check above, but NEVER pushed as a pay chip (its
              // cross-chain native route is unreliable, see NO_NATIVE_PAY_CHAINS); the stablecoin chips on 137 still show.
              if(amt>0.000001 && !NO_NATIVE_PAY_CHAINS.has(chainId)){
                // BASE ETH: give Base-native ETH its OWN dedup key so it survives as a selectable chip alongside
                // mainnet ETH instead of being collapsed into the single max-USD ETH chain (Jake holds ETH on both
                // Base ~$19 and mainnet ~$21; the old key:'eth' dedup hid the Base balance). Mainnet/Arbitrum/Optimism
                // ETH still share key:'eth' (they route identically, so one chip is correct). Routing/feasibility are
                // keyed on h.token+h.chainId, not the display key, so the Base buy quotes/builds unchanged.
                const _nkey=(chainId===8453 && PAY_NATIVE_META[chainId].key==='eth') ? 'ethbase' : PAY_NATIVE_META[chainId].key;
                held.push({ key:_nkey, symbol:PAY_NATIVE_META[chainId].sym, chainId, token:'native', amount:amt, usd, nativeAmt:amt }); } }
          })());
        }
        const toks=PAY_TOKENS[chainId]||[];
        for(const tk of toks){
          jobs.push((async()=>{
            const tokAddr = (tk.addr==='__RVLT__') ? cfg.rvlt : tk.addr;   // RVLT address comes from escrow config
            if(!tokAddr || !/^0x[0-9a-fA-F]{40}$/.test(tokAddr)) return;
            const data='0x70a08231000000000000000000000000'+evm.toLowerCase().replace(/^0x/,'');
            const hex=await payEvmBalance(evm,chainId,tokAddr,data);   // P4: LKG-cached
            if(hex && hex!=='0x'){ const amt=payScale(hex,tk.dec);
              const isRvlt = tk.key==='rvlt';
              const minHold = isRvlt ? 1 : 0.01;
              if(amt>minHold){
                // USD-ONLY display: RVLT is priced from Relay (implied RVLT/USD) so the chip shows "$X" like the rest.
                let usd = amt;
                if(isRvlt){ const px=await rvltUsdPrice(); usd = (px>0) ? amt*px : null; }
                held.push({ key:tk.key, symbol:tk.sym, chainId, token:tk.key, amount:amt, usd });
              }
            }
          })());
        }
      }
    }
    let solNativeUsdKnown=false, solNativeUsdVal=0;   // P7: track whether the SOL native read SUCCEEDED (vs unknown)
    if(haveSol){
      // native SOL (uses the unified Solana RPC list; VS_SOL_SPL_RPC primary)
      jobs.push((async()=>{
        try{
          const bal=await solRpc('getBalance',[sol],7000); const lamports=bal&&bal.value;
          if(lamports!=null){ solNativeUsdKnown=true;   // RPC answered (even 0): we KNOW the SOL balance
            const amt=Number(lamports)/1e9; const px=await solUsdPrice(); const usd= px? amt*px : null;
            if(usd!=null) solNativeUsdVal=usd;
            if(amt>0.0001 && usd!=null){ held.push({ key:'sol', symbol:'SOL', chainId:792703809, token:'native', amount:amt, usd, nativeAmt:amt }); }
          }
        }catch(_){ /* solNativeUsdKnown stays false -> treated as unknown (allow) for the USDC-SPL gas check */ }
      })());
      // Solana USDC (SPL). Relay-routable to RVLT on Robinhood (verified). 6-dec, ~$1. key 'solusdc' so it never
      // collides with EVM 'usdc' in the dedup (different origin chain + currency the buy must use).
      jobs.push((async()=>{
        const amt=await solSplBalance(sol, SOL_USDC_MINT);
        if(amt>0.01){ held.push({ key:'solusdc', symbol:'USDC', chainId:792703809, token:'solusdc', amount:amt, usd:amt }); }
      })());
    }
    if(haveBtc){
      // BTC via Relay's deposit-address model (already wired in the client's PAY_SRCS + buyInViaRelay btc branch).
      // Read the confirmed on-chain balance (mempool.space primary, blockstream fallback) and price it in USD.
      jobs.push((async()=>{
        const amt=await btcBalance(btc);
        if(amt>0.0000001){ const px=await btcUsdPrice(); held.push({ key:'btc', symbol:'BTC', chainId:BTC_RELAY_CHAIN, token:'native', amount:amt, usd: px? amt*px : null, nativeAmt:amt }); }
      })());
    }
    // P5: HARD DEADLINE. A hung provider must not hold the route open forever. Jobs that already resolved have pushed
    // into held[], so partial results survive; the deadline just stops waiting on stragglers.
    const _deadline=new Promise(r=>setTimeout(r, 12000));
    await Promise.race([ Promise.all(jobs), _deadline ]).catch(()=>{});
    // DEDUP same asset held on multiple chains: keep the holding with the LARGEST USD VALUE (fallback to amount when
    // USD is unknown). That chain is the one the buy will use, so the displayed chain and the entry-quote fromChainId
    // stay consistent. Picking by USD (not raw amount) fixes native coins where a tiny balance on one chain could
    // otherwise outrank the real holding on another if amounts were compared naively.
    const usdVal=(h)=> (h.usd!=null ? Number(h.usd) : Number(h.amount)||0);
    const best={};
    for(const h of held){ const k=h.key; if(!best[k] || usdVal(h)>usdVal(best[k])) best[k]=h; }
    // USD-ONLY: drop any asset we could NOT price in USD (keeps the display strictly dollar-denominated).
    const priced=Object.values(best).filter(h=> h.usd!=null && Number(h.usd)>0).sort((a,b)=> usdVal(b) - usdVal(a));
    // FEASIBILITY GATE: only return assets the wallet can actually complete a 1-ticket entry with (value covers the
    // quoted cost + gas, a route exists, gas present). Dust like $0.31 ETH is hidden. RVLT uses the exact-required
    // model (no Relay buffer). Run the per-asset checks in parallel (each quote cost is cached ~60s).
    const requiredRvlt = Number(payScale(String(cfg.entry||'0'), 18));   // RVLT units for 1 ticket (full, non-holder)
    // P7: solNativeUsd is NULL when the SOL native read did not succeed (unknown), vs 0 when we know it's empty. The
    // USDC-SPL gas check treats null as "allow" (don't drop) and only blocks on a KNOWN-below-reserve SOL balance.
    const ctx={ requiredRvlt, nativeByChain:nativeUsdByChain,
      solNativeUsd:(solNativeUsdKnown ? solNativeUsdVal : null),
      fromCurrency:(h)=>{
        if(h.key==='solusdc') return SOL_USDC_MINT;
        if(h.key==='sol') return '11111111111111111111111111111111';
        if(h.token==='native') return '0x0000000000000000000000000000000000000000';
        const tk=(PAY_TOKENS[h.chainId]||[]).find(t=>t.key===h.key);
        if(!tk) return null; return (tk.addr==='__RVLT__')?cfg.rvlt:tk.addr;
      } };
    const checks=await Promise.all(priced.map(async h=>({ h, f:await assetFeasible(h, ctx) })));
    const out=[]; const hidden=[];
    for(const {h,f} of checks){ if(f.feasible) out.push(h); else {
      hidden.push({ key:h.key, reason:f.reason });
      // P6: diagnostic - log every HIDDEN held asset so the next whack-a-mole is instant (e.g. "hidden key=usdg chain=4663 reason=no_route").
      try{ console.log('[pay/balances] hidden key='+h.key+' chain='+h.chainId+' reason='+f.reason+' usd='+(h.usd!=null?Math.round(h.usd*100)/100:'?')); }catch(_){}
    } }
    // one-line reason when NOTHING qualifies, so the client can disable Buy In with a clear message.
    const entryUsd=Number(getCfg().entryUsd)||10;
    const reason = out.length ? null : (priced.length ? ('Not enough balance in a supported coin for a $'+entryUsd+' entry.') : 'No supported coins held for a $'+entryUsd+' entry.');
    // GAS PRE-FLIGHT echo: expose the wallet's NATIVE Robinhood (4663) USD value the gate already computed (no new RPC;
    // nativeUsdByChain[4663] was read above). The client uses it to verify the user can SIGN the 4663 approve/buyIn and
    // to top up a tiny gas slice if short. null = the 4663 native read did not resolve (client falls back to its own read).
    const rhNativeUsd = (nativeUsdByChain[4663]!=null) ? nativeUsdByChain[4663] : null;
    res.json({ ok:true, held:out, hidden, reason, entryUsd, rhNativeUsd });
  }catch(e){ res.status(502).json({error:'balances unavailable'}); }
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
    // (C) load a persisted profile so a chosen name/avatar survives across sessions; (B) kick a lazy ENS resolve. Both
    // are display-only; the profile name takes precedence over the base seat name the moment it is known.
    try{ const p=profileFor(a); if(p&&p.name) REG[token].name=p.name; }catch(_){}
    try{ ensResolveLazy(a, token); }catch(_){}
    try{ registerThAddr(a); }catch(_){}   // (D) map token hash -> address for the public /api/u card
    const sess=mintSess(a);   // FIX P0: server-issued SECRET session; authority routes require this, not the public token
    res.json({ok:true,token,verified:true,sess});
  }catch(e){ res.status(500).json({error:String(e.message||e)}); }
});
// IDOR fix: identity is the AUTHENTICATED token (x-vs-token header) only. A caller can only ever log out their
// own seat, never force-logout another player's token from the request body. Rate-limited to blunt abuse.
app.post('/api/logout',(req,res)=>{ if(!rl(rlKey(req,'logout'),20,60000)) return res.status(429).json({error:'slow down'}); const t=reqToken(req); if(t&&t.indexOf('w:')===0 && reqAuthTok(req)!==t) return res.status(401).json({error:'verify your wallet'}); if(t&&REG[t])REG[t].active=false; const pl=player(t); if(pl){pl.left=true;pl.alive=false;} res.json({ok:true}); });
// IDOR fix: pre-choice is set ONLY for the caller's own authenticated token (x-vs-token), never a body token.
// Routes are range-guarded the same way /api/autoplay does (0..maxch-1, else null) so a bad index can't slip in.
app.post('/api/prechoose',(req,res)=>{ if(!rl(rlKey(req,'pre'),15,60000)) return res.status(429).json({error:'slow down'}); const t=reqAuthTok(req); const reg=t&&REG[t]; if(!reg)return res.status(401).json({error:'verify your wallet'});
  // FIX 3b (fairness): require a SIWE-VERIFIED session (reg.verified && reg.address) to persist a prechoice, matching
  // /api/autoplay. Without this a bare (unverified) registration could seed pre-doors that the thin-round autofill
  // consumes, a cheap way to influence the field from an unproven identity. A prechoice now requires proof of wallet.
  if(!(reg.verified && reg.address)) return res.status(401).json({error:'sign in with this wallet (SIWE) first'});
  const mx=(C&&C.maxch)||8; const pre=(req.body.routes||[]).map(x=>x==null||x===''?null:parseInt(x,10)).map(x=>Number.isInteger(x)&&x>=0&&x<mx?x:null); reg.pre=pre; const pl=player(t); if(pl)pl.pre=pre; res.json({ok:true,pre}); });
// ---- HOLDER-AWARE PRICING (read-only; single source of truth = the on-chain per-ticket price) ----
// Returns the EXACT per-ticket + total RVLT this wallet is charged for `qty` tickets, straight from the
// contract's entryPriceFor (which halves on-chain for a Vault Robbers NFT holder once the Safe enables it).
// The client uses this to show the real price BEFORE a buy, so when the discount is still OFF on-chain
// (holderNft==0) everyone correctly sees full price. There is NO off-chain discount math here. `isHolder` and
// the on-chain discountBps are surfaced only for the UI badge; the CHARGE is always entryPriceFor.
// SERVE-CACHED-ON-429: /api/pricing is a pure READ (contract per-ticket price + holder flags). The buy sheet
// re-reads it on open/qty/token change and the pay-grid can fan out several in a burst, so a single active buyer
// can exhaust the shared relay/pricing bucket and 429 the very read the buy needs. Mirror the proven
// _PAYBAL_CACHE pattern: FRESH cache (<20s) answers repeats instantly with no on-chain calls; over the limit we
// serve a RECENT cache (up to ~2min) instead of a 429 so a burst can never break the buy. Keyed by (qty, resolved
// address) so holder vs non-holder pricing never cross-contaminates. No economics change: the cached object is the
// identical on-chain-derived response; the real charge is still escrow.requiredRvltWei re-read at buy time.
app.get('/api/pricing',async (req,res)=>{
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
  // Cache key: qty + the RESOLVED address (holder pricing is per-address). buyId is included so a round roll
  // invalidates the cache rather than serving a prior round's amounts.
  const _pk=qty+'|'+addr.toLowerCase()+'|'+String(currentBuyRoundId());
  const _pnow=Date.now();
  const _pcached=_PRICING_CACHE.get(_pk);
  if(_pcached && (_pnow-_pcached.ts)<20000) return res.json(_pcached.data);   // FRESH: answer instantly, no on-chain reads
  if(!rl(rlKey(req,'pricing'),150,60000)){
    // Over the limit during a burst: serve a recent copy (up to 2min) so the buy's price read never fails.
    if(_pcached && (_pnow-_pcached.ts)<120000) return res.json(_pcached.data);
    return res.status(429).json({error:'slow down'});
  }
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
  const _payload={
    isHolder,
    discountBps: disc.enabled ? disc.discountBps : 0,   // 0 when the contract discount is OFF (not yet enabled)
    discountApplies,
    perTicketWei, totalWei, qty,
    perTicketUsd, fullPerTicketUsd: entryUsd,
    nft: escrow.holderConfig().nft,
    nftMatchesContract: disc.matchesVsNft,
    note: discountApplies ? 'Vault Robber holder price, charged on-chain at buy time'
                          : 'standard price (holder discount not currently enabled on-chain)'
  };
  // Cache only a complete, on-chain-derived answer (both amounts present). A partial read (contract hiccup) is not
  // cached so the next call re-tries instead of pinning a bad price.
  if(perTicketWei!=null && totalWei!=null) _PRICING_CACHE.set(_pk,{ts:Date.now(),data:_payload});
  res.json(_payload);
});

// ---- VAULT ROBBERS NFT UTILITY (per-heist airdrop). Read-only on-chain reads + claim calldata the OWNER signs.
// No keys server-side. All reads target Robinhood mainnet (where the NFT+RVLT+6551 live); inert/zero until armed. ----
app.get('/api/robbers/config',(req,res)=>{ try{ res.json(Object.assign({}, robbers.config())); }catch(e){ res.status(500).json({error:'config'}); } });
app.get('/api/robbers/owned',async (req,res)=>{
  if(!rl(rlKey(req,'rob'),60,60000)) return res.status(429).json({error:'slow down'});
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
  try{ res.json(await robbers.claimPlan(tokenId, owner)); }catch(e){ res.status(400).json({error:String(e&&e.message||'claim plan failed')}); }
});

// ---- FEATURE 2: AUTO-PLAY (durable recurring prechoose). Set a persistent door strategy that re-applies every
// round until turned off. Survives restart. The seeded absent-default still covers any chamber left null. ----
app.post('/api/autoplay',(req,res)=>{
  if(!rl(rlKey(req,'autoplay'),20,60000)) return res.status(429).json({error:'slow down'});
  // IDOR fix: identity is the AUTHENTICATED token (x-vs-token header) only, never a body token. And, mirroring
  // /api/autobuy's ownership gate, the caller may only arm autoplay for their OWN SIWE-VERIFIED session — a bare
  // (unverified) registration can no longer persist autoplay for its u_ token.
  const tok=reqAuthTok(req); const reg=tok&&REG[tok];
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
app.get('/api/autoplay',(req,res)=>{ const tok=reqAuthTok(req); const ap=tok&&AUTOPLAY_STORE[tok]; res.json({ on:!!(ap&&ap.on), pre:(ap&&ap.pre)||null }); });

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
    // P0: honest availability for the client. autoBuyAvailable=false + relayerSlotOk=false means the on-chain relayer
    // slot is NOT our key (every buyInForRange would revert) -> the client disables the CTA with a clear message
    // instead of letting the user approve+sign into a silent trap. null slot = optimistic (not proven unavailable).
    autoBuyAvailable: escrow.relayUsable(), relayerSlotOk: escrow.relayerSlotVerdict(),
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
  // P0 RELAYER-SLOT GATE: re-probe the on-chain relayer slot (TTL-cached) BEFORE accepting an authorization. If the
  // slot is unset / mismatched the relayer can never submit buyInForRange, so storing an auth here would be a silent
  // trap (the user approves + signs for nothing). Reject with an honest, retryable message instead of a no-op accept.
  // A fresh refresh ensures a Safe setRelayer landing since boot flips us live without a restart. null (transient RPC)
  // is treated as optimistic (relayUsable passes) so a blip can't block a correctly-provisioned relayer.
  try{ await escrow.refreshRelayerSlot(false); }catch(_){}
  if(!escrow.relayUsable()){
    const reason = (escrow.relayerSlotVerdict()===false)
      ? 'auto-buy temporarily unavailable (the on-chain relayer is not set to our key yet). Nothing was spent.'
      : 'auto-buy relayer not provisioned (set VS_RELAY_PK)';
    return res.status(409).json({error:reason, autoBuyUnavailable:true});
  }
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
    // FIX 1 (red-team): CRYPTOGRAPHICALLY VERIFY the range authorization server-side BEFORE persisting, instead of
    // validating shape only. Previously a SIWE-verified wallet could POST a well-formed-but-junk {roundStart,roundCount,
    // nonce,sig} record; it would be stored and then INFLATE committedAutobuyTicketsFor() (which arms the grace timer
    // early) even though buyInForRange could never land it. It is not a money hole (committed only ARMS a timer; the
    // real lock still gates on on-chain `sold`), but it enables timer-griefing + relayer-gas-waste + metric pollution.
    //
    // We recover the EIP-712 AutoBuyRange signer here and require it == player, and require the record's nonce == the
    // on-chain autoBuyNonce(player). The typed data MATCHES the client exactly (public/index.html ~4080-4086):
    //   domain = escrow.eip712Domain()           // same object served by /api/autobuy/params as `domain`
    //   types  = escrow.autobuyRangeTypes()       // { AutoBuyRange:[roundStart,roundCount,player,maxTickets,maxEntry,nonce,deadline] }
    //   value  = { roundStart, roundCount, player, maxTickets, maxEntry, nonce, deadline }   // all as decimal strings
    // and the field set/order is identical to the contract's AUTOBUY_RANGE_TYPEHASH (StandoffEscrow.sol ~187/395), so a
    // sig that recovers here is exactly one buyInForRange would accept. We sign over the SIGNED body values (the raw
    // b.maxTickets / b.maxEntry the client put in the message), NOT the server-clamped `maxTickets` above.
    // A recovery mismatch -> 400 (bad signature); a stale nonce -> 409 (re-sign). On success we stamp sigVerified=true.
    let _sigVerified=false;
    try{
      const _E=require('ethers');
      const _dom=escrow.eip712Domain();
      // Domain must be fully resolved (verifyingContract set) to recover deterministically; if it isn't, we cannot
      // hard-verify, so fall through to the defense-in-depth path (record stored but NOT sigVerified -> never counted).
      if(_dom && _dom.verifyingContract){
        const _val={
          roundStart:String(roundStart),
          roundCount:String(roundCount),
          player:_E.getAddress(player),
          maxTickets:String(b.maxTickets),
          maxEntry:String(maxEntry),
          nonce:String(nonce),
          deadline:String(deadline)
        };
        let _rec=null; try{ _rec=_E.verifyTypedData(_dom, escrow.autobuyRangeTypes(), _val, sig); }catch(_){ _rec=null; }
        if(!_rec || _rec.toLowerCase()!==player) return res.status(400).json({error:'bad signature (does not recover to this wallet), re-sign the authorization'});
        // Nonce must equal the current on-chain autoBuyNonce(player); a stale nonce means buyInForRange would revert
        // ("bad nonce"). null = transient RPC read failure -> do NOT hard-reject (optimistic, like the relayer-slot gate).
        const _onNonce=await escrow.autoBuyNonce(player);
        if(_onNonce!=null && String(_onNonce)!==String(nonce)) return res.status(409).json({error:'stale nonce, your authorization is out of date, please re-sign', staleNonce:true, onchainNonce:String(_onNonce)});
        _sigVerified=true;
      }
    }catch(_){ _sigVerified=false; }   // never break legit auto-play on an unexpected verify error; falls to defense-in-depth
    // RANGE-REPLAY HARDENING (LOW): rangeSpent is the OFF-CHAIN per-round replay guard (the relayer skips a round
    // already relayed for this range). It is persisted to disk by saveAutobuy() and reloaded on boot, so a bare
    // process restart cannot replay. BUT the raw range sig is MEMORY-ONLY (nulled on disk, line ~192), so after a
    // restart the player must RE-ARM with the same signature to resume — and a naive re-arm used to reset rangeSpent
    // to [], re-opening the replay window for rounds already entered before the restart. So: when the player re-arms
    // the IDENTICAL range (same roundStart + nonce), CARRY FORWARD the prior rangeSpent, and set roundsLeft net of it.
    // (The on-chain rangeSpent(address,uint256) mapping remains the ultimate hard guard — a replayed buyInForRange
    // reverts there regardless; this keeps our off-chain mirror honest so the relayer never even attempts a replay.)
    const _prev=AUTOBUY_STORE[player];
    const _sameRange=(_prev && _prev.range && String(_prev.range.roundStart)===roundStart && Number(_prev.range.nonce)===nonce && Array.isArray(_prev.rangeSpent));
    const carriedSpent=_sameRange ? _prev.rangeSpent.slice() : [];
    AUTOBUY_STORE[player]={ player, maxTickets, perRound, maxEntry, deadline,
      // FIX 1/3: sigVerified gates whether committedAutobuyTicketsFor() counts this record toward arming the grace
      // timer. true here means the EIP-712 signature + on-chain nonce were proven above; a carry-forward re-arm of the
      // IDENTICAL range that already had landed rounds (carriedSpent) is also treated as verified (it was proven when
      // those rounds landed). Unverified records are stored (so the relayer can still attempt them) but never arm early.
      sigVerified:(_sigVerified || carriedSpent.length>0),
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
  // FIX 2 (red-team): CRYPTOGRAPHICALLY VERIFY every legacy ordered-auth EIP-712 signature server-side BEFORE persisting
  // — matching what the V6 range path already does. Previously this path stored auths after only SHAPE validation, so a
  // SIWE-verified wallet could POST well-formed-but-JUNK sigs; the relayer would then attempt buyInFor per round, each
  // reverting on-chain ECDSA recovery and BURNING relayer gas (a relayer-gas-exhaustion vector), plus polluting the
  // committed-ticket / timer-arming metrics. We recover each AutoBuy EIP-712 signer here (domain = escrow.eip712Domain(),
  // types = escrow.autobuyTypes(), value bound to THAT auth's roundId + nonce under the shared bounds) and require it ==
  // player. The field set/order is identical to the on-chain AUTOBUY_TYPEHASH, so a sig that recovers here is exactly one
  // buyInFor would accept. The first auth's nonce must also equal the current on-chain autoBuyNonce(player) (the contract
  // consumes them in order starting there). ANY bad sig rejects the WHOLE submission (fail-closed) rather than storing a
  // mix of good/junk. maxTickets/maxEntry are signed over the RAW body values (b.maxTickets / maxEntry), NOT the
  // server-clamped `maxTickets`, exactly as the range path does.
  {
    const _E=require('ethers');
    const _dom=escrow.eip712Domain();
    if(!_dom || !_dom.verifyingContract) return res.status(503).json({error:'auto-buy verification unavailable right now, please retry'});
    let _pchk; try{ _pchk=_E.getAddress(player); }catch(_){ return res.status(400).json({error:'valid player address required'}); }
    // On-chain base nonce: the first signed nonce MUST match it (the contract consumes consecutive nonces from here).
    // null = transient RPC read failure -> optimistic (do NOT hard-reject), same posture as the range path's nonce check.
    let _onNonce=null; try{ _onNonce=await escrow.autoBuyNonce(player); }catch(_){ _onNonce=null; }
    if(_onNonce!=null && String(_onNonce)!==String(auths[0].nonce)) return res.status(409).json({error:'stale nonce: your authorization is out of date, please re-sign', staleNonce:true, onchainNonce:String(_onNonce)});
    for(let i=0;i<auths.length;i++){
      const _val={
        roundId:String(auths[i].roundId),
        player:_pchk,
        maxTickets:String(b.maxTickets),
        maxEntry:String(maxEntry),
        nonce:String(auths[i].nonce),
        deadline:String(deadline)
      };
      let _rec=null; try{ _rec=_E.verifyTypedData(_dom, escrow.autobuyTypes(), _val, auths[i].sig); }catch(_){ _rec=null; }
      if(!_rec || _rec.toLowerCase()!==player) return res.status(400).json({error:'bad signature at index '+i+' (does not recover to this wallet); re-sign the authorization'});
    }
  }
  AUTOBUY_STORE[player]={ player, maxTickets, perRound, maxEntry, deadline,
    auths, startNonce:auths[0].nonce, sigVerified:true,
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
  const tok=reqAuthTok(req); if(!tok) return res.status(401).json({error:'verify your wallet'});
  const reg=tok&&REG[tok]; const player=(reg&&reg.address&&reg.address.toLowerCase())||'';
  if(!/^0x[0-9a-fA-F]{40}$/.test(player)) return res.status(400).json({error:'player address required'});
  if(!(reg&&reg.verified&&reg.address&&reg.address.toLowerCase()===player)) return res.status(401).json({error:'sign in with this wallet first'});
  if(AUTOBUY_STORE[player]){ delete AUTOBUY_STORE[player]; saveAutobuy(); }
  res.json({ ok:true, note:'auto-buy cancelled on the server. Also revoke the escrow allowance (approve(escrow,0)) for full off.' });
});
// ADDRESS-ENUMERATION fix: only ever return the CALLER'S OWN auto-buy, keyed off their SIWE-verified address
// (reqToken -> REG[tok].verified + .address). No `?address=` lookup, so a caller cannot probe another wallet's
// bounded auto-buy authorization.
app.get('/api/autobuy',(req,res)=>{ const tok=reqAuthTok(req); const reg=tok&&REG[tok]; const player=(reg&&reg.verified&&reg.address&&reg.address.toLowerCase())||null; const a=player&&AUTOBUY_STORE[player];
  res.json(a?{ active:true, maxTickets:a.maxTickets, perRound:a.perRound, roundsLeft:a.roundsLeft, deadline:a.deadline, spent:a.spent.length, lastRoundId:a.lastRoundId||null, retiredReason:a.retiredReason||null,
    nonces:(Array.isArray(a.auths)?a.auths.map(x=>({ nonce:x.nonce, spent:!!x.spent, round:x.spentRound||null })):[]) }:{ active:false }); });

// READY-CHECK: mark the caller checked-in (PRESENT) for the CURRENT round. Idempotent. Only a VERIFIED seat owner can
// check in: we resolve the caller's seat via primarySeatForViewer (seat-to-session, address-scoped) and require their
// SIWE-verified address, so a check-in can never be spoofed for another address. Not-checked-in is NOT an error for a
// non-seated viewer; it just returns ready:false. This gates auto-play classification only, never settle/payout.
app.post('/api/ready',(req,res)=>{
  if(!rl(rlKey(req,'ready'),20,10000)) return res.status(429).json({error:'slow down'});
  const tok=reqAuthTok(req); const reg=tok&&REG[tok];
  const rk=_roundKey(); if(!rk) return res.json({ ok:true, ready:false, reason:'no_round' });
  // the verified wallet address bound to this session (null unless SIWE-verified) is the only thing we check in.
  const addr=(reg&&reg.verified&&reg.address)?String(reg.address).toLowerCase():null;
  if(!addr) return res.json({ ok:true, ready:false, reason:'not_verified' });
  // must actually hold a seat in the live round (ticketsOf>0 is already the gate behind a real G.players seat).
  const seat=primarySeatForViewer(tok); if(!seat) return res.json({ ok:true, ready:false, reason:'no_seat' });
  markCheckedIn(rk, addr); try{ stampSeen(tok); if(seat) seat.away=false; }catch(_){}
  res.json({ ok:true, ready:true });
  try{ global.__vsNudge&&global.__vsNudge(); }catch(_){ }   // push the updated present/away counts to everyone
});
app.post('/api/pick',(req,res)=>{ if(!rl(rlKey(req,'pick'),5,10000)) return res.status(429).json({error:'slow down'});
  // IDOR fix: the acting player is the AUTHENTICATED token (x-vs-token header) only. Previously the seat was
  // read from req.body.token, letting any gate-authed caller pick a door for ANOTHER player's seat. Route
  // validation (Number.isInteger + range) below is unchanged.
  // SEAT-TO-SESSION BINDING: the acting seat is resolved by the authenticated token (exact roster key) OR, for a
  // SIWE-VERIFIED session, by the roster entity owned by the SAME wallet address (primarySeatForViewer). This lets a
  // verified buyer pick their own seat even if the seat was keyed under a slightly different token, WITHOUT letting an
  // unproven session pick for an address it has not proven control of. The on-chain seat gate (ticketsOf>0) is untouched.
  const _tok=reqAuthTok(req); if(!_tok) return res.status(401).json({error:'verify your wallet'}); const pl=primarySeatForViewer(_tok);
  // LIVE OVERTIME: during an OT CHOOSE window a finalist picks against the OT doors (same endpoint, no blind phase).
  // This takes precedence over the per-engine run-info (which would read the wall clock as 'ended' past maxch).
  const info = (G&&G.ot) ? { phase:(G.otPhase==='choose'?'choose':'ot-'+G.otPhase), blind:false }
             : MODE==='fill' ? (G&&G.phase==='running'?fillRunInfo(Date.now()):{phase:G?G.phase:'?'})
             : C.engine==='rmfill' ? (G&&G.phase==='playing'?rmRunInfo(Date.now()):{phase:G?G.phase:'?'})
             : clockPhaseAt(Date.now());
  if(!pl||!pl.alive||info.phase!=='choose'||info.blind)return res.status(400).json({error:'cannot pick'}); const r=parseInt(req.body.route,10); if(!Number.isInteger(r)||r<0||r>=G.routes.length)return res.status(400).json({error:'bad route'}); pl.pick=r;
  stampSeen(_tok); pl.away=false;   // a manual pick means you're present: resume manual control, clear away autopilot
  // A pick is the strongest presence signal: check the owner in for this round so they count as PLAYING in the stats
  // and are never auto-played while present. (seatPresent also requires a live lastSeen, which stampSeen just refreshed.)
  try{ const rk=_roundKey(); const oa=addrOfOwner(pl.owner||_tok); if(rk&&oa) markCheckedIn(rk, oa); }catch(_){}
  // append-only pick log (token HASHED, never raw) keyed to the round + current chamber + chosen door, for the public proof.
  // FIX 3c (fairness): do NOT fire the instant pick-driven broadcast; that was a sub-second "someone just locked" signal
  // (and, combined with the roster, a last-picker oracle). The lock still propagates to everyone on the normal ~1s tick,
  // and the broadcast only moves when the field crosses a coarse lock TIER (see stateSignature/crowd), so no exact,
  // instantaneous "N-1 of N locked" edge leaks during the choose window. Other interactions (chat) keep their nudge.
  logPick(G.roundId, reqToken(req), G.cur!=null?G.cur:-1, r); res.json({ok:true}); });
app.post('/api/chat',(req,res)=>{ if(!rl(rlKey(req,'chat'),6,10000)) return res.status(429).json({error:'slow down'}); const tok=reqToken(req); const pl=player(tok); const reg=REG[tok]; var text=req.body&&String(req.body.text||'').trim().slice(0,120); if(!text)return res.status(400).json({error:'empty'});
  const _th=tokenHash(tok);
  // MODERATION (6): an ops-muted address is silenced at INGEST for everyone; its line never enters CHAT. We return ok
  // so the muted user sees no error (shadow-style), and nothing is broadcast. The address comes from REG or, for a w:
  // token that never set it, is derived from the token itself (escrow.addrOfToken), so a mute always applies.
  try{ const _a=(reg&&reg.address)||(typeof tok==='string'&&tok.indexOf('w:')===0?escrow.addrOfToken(tok):null); if(_a&&isMutedAddr(_a)) return res.json({ok:true}); }catch(_){}
  // MODERATION (5): drop an identical repeat from the same sender inside the dup window (anti-flood) without erroring.
  if(isDuplicateSpam(_th, text)) return res.json({ok:true});
  // MODERATION (1,2): defang any link and mask profanity BEFORE the text is stored or shown. If nothing survives the
  // sanitize (e.g. an all-blocked line), drop it quietly. Never store the raw unsanitized text.
  text = moderateChatText(text).trim(); if(!text) return res.json({ok:true});
  // LAZY ENS: kick a best-effort reverse-resolve on first chat send so a .eth name/avatar fills in for next time (B).
  try{ if(reg&&reg.address) ensResolveLazy(reg.address, tok); }catch(_){}
  // DISPLAY NAME precedence (profile > ENS > base); stored on the line so history keeps the name shown at send time (C).
  var _ts=Date.now();
  var _rec={ id:newMsgId(_ts), name:displayNameFor(tok,(pl&&pl.name)||(reg&&reg.name)||'anon'), text, ts:_ts, th:_th };
  // (B) REPLY: if `re` references a parent message still in the live window, cache a compact {id, name, snippet} on the
  // line so the client can render a quoted parent without a lookup. Kept small (name + a short text snippet). If the
  // parent is unknown we store just the id so the client can still scroll to it when loaded.
  try{ var reId=req.body&&req.body.re!=null?String(req.body.re).slice(0,40):null; if(reId){ var par=CHAT.find(function(x){return synthesizeId(x)===reId;}); _rec.re = par ? { id:reId, name:String(par.name||'').slice(0,20), snippet:String(par.text||'').slice(0,60) } : { id:reId }; } }catch(_){}
  // store ONLY an opaque token hash (never the raw token); /api/state turns it into a per-request `mine` flag.
  CHAT.push(_rec); while(CHAT.length>80)CHAT.shift();
  appendChatLog(_rec);   // DURABLE: persist this REAL human message (append-only JSONL); bot chatter is never logged.
  res.json({ok:true}); try{global.__vsNudge&&global.__vsNudge();}catch(_){ } });
// (A) REACTIONS: toggle the caller's reaction (emoji) on a message. Auth via reqToken (the tokenHash is the dedupe
// key), rate-limited, emoji validated against ALLOWED_REACTIONS. Returns the message's updated compact summary so the
// client can repaint immediately; the nudge broadcasts the reactions version bump to everyone else sub-second.
app.post('/api/chat/react',(req,res)=>{
  if(!rl(rlKey(req,'react'),30,10000)) return res.status(429).json({error:'slow down'});
  const tok=reqToken(req); const th=tokenHash(tok); if(!th) return res.status(400).json({error:'connect first'});
  const id=req.body&&String(req.body.id||'').slice(0,40); const emoji=req.body&&String(req.body.emoji||'');
  if(!id) return res.status(400).json({error:'id required'});
  if(ALLOWED_REACTIONS.indexOf(emoji)<0) return res.status(400).json({error:'bad reaction'});
  const summary=toggleReaction(id, emoji, th);
  res.json({ ok:true, id, rx:(summary&&summary.rx)||{}, mine:(summary&&summary.mine)||[] });
  try{ global.__vsNudge&&global.__vsNudge(); }catch(_){ }
});
// (4) REPORT: anyone connected can flag a message/user for ops review. Appends to reports.json (reporter token hash,
// target id/address, a snapshot of the message id + text, reason, ts). Rate-limited; never exposes raw tokens. A small
// one-sentence confirmation is returned. This moderates nothing by itself; it feeds GET /api/admin/reports.
app.post('/api/chat/report',(req,res)=>{
  if(!rl(rlKey(req,'report'),8,60000)) return res.status(429).json({error:'slow down'});
  const tok=reqToken(req); const th=tokenHash(tok); if(!th) return res.status(400).json({error:'connect first'});
  const b=req.body||{};
  const id=b.id!=null?String(b.id).slice(0,40):null;
  const targetId=b.targetId!=null?String(b.targetId).slice(0,64):null;
  const reason=b.reason!=null?String(b.reason).slice(0,200):null;
  if(!id && !targetId) return res.status(400).json({error:'nothing to report'});
  // snapshot the reported message text if we still hold it in the live window (best-effort; history is append-only too).
  let snap=null; try{ if(id){ const m=CHAT.find(x=>synthesizeId(x)===id); if(m) snap=String(m.text||'').slice(0,160); } }catch(_){}
  addReport({ reporterTh:th, targetId, msgId:id, text:snap, reason, ts:Date.now() });
  res.json({ ok:true });
});
// (C) PROFILE: upsert the caller's persistent display name + avatar, keyed on their verified EVM address. Auth via the
// wallet token (reqToken) and it must be a verified wallet with a known address (display only; never a seat/settle id).
// GET returns the current profile + ENS so the editor can offer "use my ENS picture". Name/avatar are validated here.
app.post('/api/profile',(req,res)=>{
  if(!rl(rlKey(req,'profile'),10,60000)) return res.status(429).json({error:'slow down'});
  const tok=reqToken(req); const reg=tok&&REG[tok];
  if(!reg||!reg.verified||!reg.address) return res.status(400).json({error:'connect a wallet first'});
  const b=req.body||{};
  // name: trim, length 1..20, printable (letters/digits/space + a small punctuation set); empty clears to the default.
  let name; if(typeof b.name==='string'){ name=b.name.replace(/[^\w .,!?+\-]/g,'').trim().slice(0,20); }
  const avatar = (typeof b.avatar==='string' && (b.avatar==='ens' || PROFILE_AVATAR_SET.indexOf(b.avatar)>=0)) ? b.avatar : undefined;
  if(name===undefined && avatar===undefined) return res.status(400).json({error:'nothing to update'});
  const patch={}; if(name!==undefined) patch.name=name; if(avatar!==undefined) patch.avatar=avatar;
  const p=upsertProfile(reg.address, patch);
  // apply immediately to the live seat so the new name/avatar shows this session without waiting for a reconnect.
  if(p&&p.name) reg.name=p.name; else if(name==='') reg.name='Robber '+String(reg.address).slice(2,6);
  res.json({ ok:true, profile:p });
  try{ global.__vsNudge&&global.__vsNudge(); }catch(_){ }
});
app.get('/api/profile',(req,res)=>{
  if(!rl(rlKey(req,'profileget'),30,60000)) return res.status(429).json({error:'slow down'});
  const tok=reqToken(req); const reg=tok&&REG[tok];
  if(!reg||!reg.address) return res.json({ profile:null, ens:null, ensAvatar:null, avatarSet:PROFILE_AVATAR_SET });
  try{ ensResolveLazy(reg.address, tok); }catch(_){}
  res.json({ profile:profileFor(reg.address), ens:reg.ens||null, ensAvatar:reg.ensAvatar||null, avatarSet:PROFILE_AVATAR_SET });
});
// (D) PUBLIC STAT CARD: GET /api/u?aid=<tokenHash> (or ?address=0x..). Returns ONLY the public card a name already
// implies: display name (profile>ENS>Robber), ens, avatar override, and the observe-only stats. aid->address resolves
// via the TH index; nothing beyond the shown name is leaked. Rate-limited. A wallet with no stats yet reads as a new
// robber (zeros), never an error, so the card always renders.
app.get('/api/u',(req,res)=>{
  if(!rl(rlKey(req,'ucard'),60,60000)) return res.status(429).json({error:'slow down'});
  let addr=null;
  const qa=req.query&&req.query.address, qaid=req.query&&req.query.aid;
  if(typeof qa==='string' && /^0x[0-9a-fA-F]{40}$/.test(qa)) addr=qa.toLowerCase();
  else if(typeof qaid==='string' && qaid) addr=addrByTh(String(qaid).slice(0,32));
  if(!addr){ return res.json({ found:false, name:null, ens:null, av:null, wins:0, games:0, biggestHeist:0, memberSince:null }); }
  const tok='w:'+addr; const reg=REG[tok];
  try{ ensResolveLazy(addr, tok); }catch(_){}
  const name = displayNameFor(tok, (reg&&reg.name)||('Robber '+addr.slice(2,6)));
  const av = avatarByTh(tokenHash(tok));
  const st = _statFor(addr);
  res.json({ found:true, name, ens:(reg&&reg.ens)||null, av:av||null,
    wins:(st&&st.wins)||0, games:(st&&st.games)||0, biggestHeist:(st&&st.biggestHeist)||0, memberSince:(st&&st.firstSeen)||null });
});
// SCROLLBACK PAGINATION: return the page of persisted real messages with ts < `before` (default now), oldest-first,
// so the client prepends older history on scroll-up. Raw tokens never leave the server; we emit name/text/ts and a
// best-effort `mine` only when the requester's current session token hash matches a stored line's th (old
// cross-session messages simply aren't flagged mine, which is fine). Rate-limited.
app.get('/api/chat/history',(req,res)=>{
  if(!rl(rlKey(req,'chathist'),20,10000)) return res.status(429).json({error:'slow down'});
  try{
    const before = (req.query.before!=null && /^\d+$/.test(String(req.query.before))) ? Number(req.query.before) : Infinity;
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit,10)||50));
    const myTh = tokenHash(reqToken(req));
    const page = readChatHistory(before, limit).map(m=>{ const id=synthesizeId(m); if(m.kind==='sys'){ return { id, sys:true, evkind:(m.evkind||null), text:m.text, ts:m.ts }; } const o={ id, name:m.name, text:m.text, ts:m.ts, mine: !!(myTh && m.th===myTh), aid:(m.th||null) }; const av=avatarByTh(m.th); if(av) o.av=av; if(m.re) o.re=m.re; const rs=reactionSummary(id, myTh); if(rs){ o.rx=rs.rx; o.mine_rx=rs.mine; } return o; });
    res.json({ messages:page, oldestTs: page.length?page[0].ts:null, hasMore: page.length>=limit });
  }catch(e){ res.status(502).json({error:'history unavailable'}); }
});
// Privileged: switching mode resets the live game, so it is admin-only (was unauthenticated). Fail-closed:
// with no VS_ADMIN_TOKEN provisioned, mode is locked to its configured value. ADDITIONALLY: a mode switch is
// REFUSED while a real-money round is committed-but-unsettled, because resetting G mid-round would orphan a
// funded on-chain pot (split-brain). The operator must let the live round settle (or void) first.
function realRoundInFlight(){ for(const gs of ESC_OPENED){ if(!ESC_SETTLED.has(gs)) return gs; } for(const gs of ESC_COMMITTED){ if(!ESC_SETTLED.has(gs)) return gs; } return null; }
app.post('/api/mode',(req,res)=>{ if(!rl('mode:'+(req.headers['x-forwarded-for']||req.socket.remoteAddress||'?'),10,60000))return res.status(429).json({error:'slow down'}); if(!vsAdminOk(req))return res.status(401).json({error:'unauthorized'}); const m=req.body&&req.body.mode; if(!MODES[m])return res.status(400).json({error:'bad mode'});
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
// (6) OPS MODERATION: admin-gated mute/unmute suppress a bad actor's chat for EVERYONE at ingest; reports lists the
// queue. Admin auth is the existing adminGate (x-vs-admin header or the admin cookie). Addresses are lowercased.
app.post('/api/admin/mute', adminGate, express.json({limit:'1kb'}), (req,res)=>{
  const addr=String((req.body&&req.body.addr)||'').trim(); if(!/^0x[0-9a-fA-F]{40}$/.test(addr)) return res.status(400).json({error:'valid address required'});
  const ok=setMuted(addr, true); if(!ok) return res.status(400).json({error:'bad address'});
  res.json({ ok:true, muted:addr.toLowerCase() });
});
app.post('/api/admin/unmute', adminGate, express.json({limit:'1kb'}), (req,res)=>{
  const addr=String((req.body&&req.body.addr)||'').trim(); if(!/^0x[0-9a-fA-F]{40}$/.test(addr)) return res.status(400).json({error:'valid address required'});
  setMuted(addr, false);
  res.json({ ok:true, unmuted:addr.toLowerCase() });
});
app.get('/api/admin/reports', adminGate, (req,res)=>{
  const limit=Math.max(1, Math.min(200, parseInt(req.query.limit,10)||100));
  res.json({ reports: REPORT_STORE.slice(-limit).reverse(), muted: Object.keys(MUTE_STORE) });
});
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
// #223 ORPHAN VISIBILITY (read-only). Lists every round in the live scan window that is on-chain Open(1) or
// Committed(2) and NOT yet terminal, with its age, whether a seed is recoverable, and what the settle-watcher WOULD
// do (settle if a validated champion + seed exist; void-refund otherwise; still gated by the on-chain deadline/play
// margin so a legitimately-live round shows willVoid:false). This endpoint moves NO funds and reveals NO seed — it
// only reports a boolean `seedRecoverable`. Gated by adminGate (x-vs-admin header or the admin cookie).
app.get('/api/admin/orphans', adminGate, async (req,res)=>{
  if(!escrow.isOn()) return res.json({ escrowOn:false, orphans:[], ts:Date.now() });
  try{
    const nowS=Math.floor(Date.now()/1000), marginSec=_watchPlayMarginSec();
    const ids=_watchCandidateIds();
    const liveId = (C.engine==='rmfill') ? (G&&G.rmId) : (G&&G.start);
    const out=[];
    for(const id of ids){
      const r=await escrow.readRound(id).catch(()=>null);
      if(!r || r.status>=3) continue;                         // skip missing + already terminal (Settled/Voided)
      // seed recoverability (boolean only — never the seed value): any of the three durable sources.
      const seedRecoverable = !!(ESC_SEED[id] || getSeed(id) || (PROOF_STORE[String(id)] && PROOF_STORE[String(id)].seed));
      // can we rebuild + settle a champion? live G.champ for the live round, else the #222 CHAMP_STORE roster.
      const hasChampRoster = (String(liveId)===String(id) && G && G.champ && G.champ.owners && G.champ.owners.length)
        || !!(CHAMP_STORE[String(id)] && Array.isArray(CHAMP_STORE[String(id)].addrs) && CHAMP_STORE[String(id)].addrs.length);
      const proofWinner = !!(PROOF_STORE[String(id)] && PROOF_STORE[String(id)].winner && !PROOF_STORE[String(id)].winner.none);
      let pastDeadline=false, willVoid=false, willSettle=false, phase;
      if(r.status===1){ phase='open'; pastDeadline = nowS>=r.deadline; willVoid=pastDeadline; }
      else if(r.status===2){ phase='committed'; pastDeadline = nowS >= (r.lockTime+marginSec);
        if(pastDeadline){ willSettle = !!(seedRecoverable && proofWinner && hasChampRoster); willVoid = !willSettle; } }
      let payers=0; try{ const e=BigInt(r.entry||0), p=BigInt(r.pot||0); if(e>0n && p>0n) payers=Number(p/e); }catch(_){}
      out.push({ id:String(id), status:r.status, phase, ageSec: Math.max(0, nowS - (r.status===1?r.deadline-marginSec:r.lockTime)),
        lockTime:r.lockTime, deadline:r.deadline, pastDeadline, seedRecoverable, hasChampRoster, payers,
        willSettle, willVoid, live:(String(liveId)===String(id)) });
    }
    out.sort((a,b)=>b.ageSec-a.ageSec);
    res.json({ escrowOn:true, engine:C.engine, playMarginSec:marginSec, watcherIntervalMs:WATCH_INTERVAL_MS,
      watcherStale:(WATCH.lastTickTs>0 && Date.now()-WATCH.lastTickTs > WATCH_INTERVAL_MS*3),
      orphans:out, count:out.length, ts:Date.now() });
  }catch(e){ res.status(502).json({ error:'orphans unavailable' }); }
});
// #224 PEG HEALTH (read-only). Surfaces the live RVLT price feed state so drift/staleness is observable: current
// price (USD per RVLT), how many independent sources + TWAP samples backed it, the freshest live-sample age, the
// last-known-good entry wei + the 6h anchor, and the running clamp/band/reject/lkg counters. Reveals NO seed and
// moves NO money. Gated by adminGate (x-vs-admin header or the admin cookie).
app.get('/api/admin/peg', adminGate, (req,res)=>{
  const now=Date.now(); const ageMs = PEG.lastLiveTs ? (now-PEG.lastLiveTs) : null;
  const usd = Number(getCfg().entryUsd)||10;
  res.json({
    entryUsd: usd,
    priceUsdPerRvlt: PEG.lastPriceUsdPerRvlt,                 // TWAP-window median, USD per RVLT (null if none yet)
    sources: PEG.lastSources, samples: PEG.lastSamples,      // independent live sources + TWAP samples behind it
    lastLiveTs: PEG.lastLiveTs||0, liveAgeMs: ageMs,
    staleMs: PEG.STALE_MS, stale: (ageMs!=null && ageMs>PEG.STALE_MS),   // true -> next open/quote fails closed to static
    failClosed: (PEG.lastPriceUsdPerRvlt==null) || (ageMs!=null && ageMs>PEG.STALE_MS),
    twapWindowMs: PEG.TWAP_MS, clampPct: PEG.CLAMP_PCT, bandPct: PEG.BAND_PCT, anchorTtlMs: PEG.ANCHOR_TTL_MS,
    lastWeiRvlt: PEG.lastWei!=null ? Number(PEG.lastWei/10n**15n)/1000 : null,   // last-known-good entry, human RVLT (3dp)
    anchorWeiRvlt: PEG.anchorWei!=null ? Number(PEG.anchorWei/10n**15n)/1000 : null, anchorTs: PEG.anchorTs||0,
    memoAgeMs: PEG._memo.ts ? (now-PEG._memo.ts) : null,
    staticEntryWei: String(escrow.entryWei()||'0'),           // the fail-closed fallback entry
    counts: Object.assign({}, PEG.stats), lastEvent: PEG.lastEvent, lastEventTs: PEG.lastEventTs,
    ts: now
  });
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
  // GAS DRIP ops (monitor relayer drain): the relayer's native balance is relayerGasEth above; here we add the
  // drip's bounds + how many wallets have been dripped (ledger size) + the current rolling-hour count so a drain
  // or a farming spike is visible. gasDripConfig() returns the server-authoritative wei bounds.
  const _dripCfg = (function(){ try{ return escrow.gasDripConfig(); }catch(_){ return {}; } })();
  const _dripHourNow = Math.floor(Date.now()/3600000);
  const gasDrip = { dripWei:_dripCfg.wei||null, reserveWei:_dripCfg.reserveWei||null, maxWei:_dripCfg.maxWei||null,
    walletsDripped:Object.keys(GASDRIP_STORE).length, drippedThisHour:(_gasDripHour.h===_dripHourNow?_gasDripHour.n:0),
    globalPerHourCap:GAS_DRIP_GLOBAL_PER_HOUR, windowHrs:GAS_DRIP_WINDOW_MS/3600000 };
  const autobuy = { relayerServer:escrow.relayAddress(), relayerUsable:escrow.relayUsable(), relayerIsFallback:escrow.relayIsFallback(),
    relayerGasEth:relayGas, activeAuthorizations:autobuyActive.length, totalAuthorizations:Object.keys(AUTOBUY_STORE).length, gasDrip,
    // PARALLELIZATION observability: per-(player,round) buys that were covered by a signed range but never landed
    // before the round locked (lost the lock race / dropped send). No auto-refund — the authorization is just unused.
    missedCoveredRounds:_autobuyMissCount, missedCoveredAlerts:AUTOBUY_MISS_ALERTS.slice(-10) };
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
  // #1 cross-chain visibility: paid-but-unattributed fill tickets (on-chain pot/entry exceeded the seated count), so
  // ops can make the stranded payer whole. A non-empty list means a funded buyer was not attributed to an address.
  const fillStrands = { count:FILL_STRAND_ALERTS.length, alerts:FILL_STRAND_ALERTS.slice(-10) };
  // #224 compact peg health (full detail at GET /api/admin/peg). Synchronous read of the in-memory PEG snapshot.
  const _pegAge = PEG.lastLiveTs ? (Date.now()-PEG.lastLiveTs) : null;
  const peg = { priceUsdPerRvlt:PEG.lastPriceUsdPerRvlt, sources:PEG.lastSources, samples:PEG.lastSamples,
    liveAgeMs:_pegAge, stale:(_pegAge!=null && _pegAge>PEG.STALE_MS),
    failClosed:(PEG.lastPriceUsdPerRvlt==null) || (_pegAge!=null && _pegAge>PEG.STALE_MS),
    counts:Object.assign({}, PEG.stats), lastEvent:PEG.lastEvent };
  return {
    escrow:{ on:cfg.on, chainId:cfg.chainId, address:cfg.address, rvlt:cfg.rvlt, entry:cfg.entry },
    signerAddress: escrow.signerAddress(), signerGasEth: gas, rakeBps: rbps,
    recentRounds,
    totals:{ rounds:ids.length, settled, voided, potSumRvlt, rakePool, burnShareBps, rakeToTreasury, rakeBurned },
    holderDiscount, autobuy, autoplay, watcher, payoutKeeper, fillStrands, peg,
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
  if(!G)tick();
  // ITEM 1: BOOT-WINDOW NULL-G GUARD. A request that lands in the brief window before the first round inits (tick()
  // above may not have populated G yet) would otherwise deref G.phase / seatCount() / rmThresholdTickets() / the final
  // return and throw `TypeError: Cannot read properties of null (reading 'phase')`, 500-ing that caller (logged on
  // EVERY boot). Return a minimal, SAFE "booting" payload whose top-level shape matches the real return closely enough
  // that the client render + poll loop tolerate it (it reads s.phase / s.fill / s.escrow / s.pot / s.alive / s.total /
  // s.me / s.chat / s.history / s.routes / s.econ / s.sybil / s.launch). fill:null + booting:true + phase:'filling'
  // renders the lobby "forming" state; the next poll (ms later, once G exists) returns the full payload.
  if(!G){
    return {
      now:Date.now(), mode:MODE, engine:C.engine, maxChambers:C.maxch, phase:'filling', fill:null, booting:true,
      schedule:null, nextGameIn:0, lobbyEndsIn:0, chamber:null, blind:false, lockIn:0, chooseWindow:30,
      routes:[], heat:[], crowd:null, ot:null, launchedAtMs:null, roundId:null,
      pot:0, alive:0, total:0, me:null, reveal:null, champion:null, ended:null,
      chat:[], history:[], watching:0, typing:[], jackpot:(JACKPOT_RVLT||0), rolledOver:false,
      launch:launchState(),
      econ:{ entryUsd:getCfg().entryUsd, roundTarget:getCfg().roundTarget, walletCap:walletCap() },
      sybil:{ maxTicketsPerWallet:walletCap(), enforce:SYBIL_ENFORCE },
      // escrow: the on/entry facts are G-independent; the live round-scoped fields (id/buyOpen/pot) are null/false while
      // booting so the client shows "buy-in forming" rather than a stale round. Matches the real escrow block's keys.
      escrow: escrow.isOn()
        ? { on:true, id:null, entry:escrow.entryWei(), buyOpen:false, live:false, pot:0, precommit:null }
        : { on:false }
    };
  }
  const now=Date.now(),tok=reqToken(req),gp=player(tok),reg=REG[tok];
  // FIX P0 (pick-oracle): the PRIVATE view (own locked door + prechoice) is shown only to a caller who PROVED wallet
  // control this session (x-vs-sess matches reg.address). A forged `w:<addr>` token with no session gets the public
  // view only, so it can never read another seat's locked pick. Non-wallet (u_) tokens are unaffected (no money).
  const _pa=provenAddr(req); const _walletTok=(typeof tok==='string'&&tok.indexOf('w:')===0); const _showPrivate=(!_walletTok)||!!(_pa&&reg&&reg.address&&String(reg.address).toLowerCase()===_pa);
  const myTh=tokenHash(tok);   // used to flag the requester's own chat lines without ever echoing a raw token
  let phase, chamber=null, blind=false, lockIn=0, chooseWindow=30, reveal=null, champion=null, ot=null;
  let fill=null, schedule=null, nextGameIn=0, lobbyEndsIn=0;

  if(MODE==='fill'){
    if(G.phase==='running'){ const info=fillRunInfo(now); phase=info.phase; chamber=info.chamber!=null?info.chamber:null; blind=!!info.blind; lockIn=info.lockIn||0; chooseWindow=info.cwin||30; }
    else if(G.phase==='ended'){ phase='ended'; nextGameIn=Math.max(0,C.resultMs-(now-G.endedAt)); }
    else { phase='filling'; }
    var regTix=Object.keys(REG).reduce((a,t)=>a+(REG[t].active?clampTickets(REG[t].tickets):0),0);
    fill={ state:G.phase, seats:seatCount(), threshold:C.threshold, cap:C.cap, fuseIn:(G.phase==='armed')?Math.max(0,G.fuseEnds-now):null, nextPacking:C.seedBots+regTix,
           graceEndsAtMs:(G.phase==='armed'&&G.fuseEnds!=null)?G.fuseEnds:null,   // exact fuse-seal epoch (fake-fill parity)
           lobby: fillLobby(seatCount(), C.cap, seatCount()*ENTRY, tok) };
  } else if(C.engine==='rmfill'){
    // THRESHOLD-FILL: the UI shows fill progress (ticketsSold / target) + grace remaining instead of a wall clock.
    if(G.phase==='playing'){ const info=rmRunInfo(now); phase=info.phase; chamber=info.chamber!=null?info.chamber:null; blind=!!info.blind; lockIn=info.lockIn||0; chooseWindow=info.cwin||Math.round((C.choose||30000)/1000); }
    else if(G.phase==='ended'){ phase='ended'; }
    else if(G.phase==='locking'){ phase='locking'; }   // buy-in closing on-chain; chambers about to start
    else { phase='filling'; }   // 'voiding' also lands here (brief; fill.state carries the real phase + voidReason below)
    fill={ state:G.phase, seats:seatCount(), ticketsSold:(G.ticketsSold||0), threshold:rmThresholdTickets(), target:(C.target||50), cap:C.cap,
           graceIn:(G.graceEnds!=null)?Math.max(0,G.graceEnds-now):null,
           // EXACT TIMING: the absolute epoch the fuse seals (now + remaining grace) so the client anchors the launch
           // countdown on a hard timestamp instead of interpolating graceIn. Only present while the fuse is lit.
           graceEndsAtMs:(G.phase==='locking'&&G.graceEnds!=null)?G.graceEnds:null,
           // FIX 1/FIX 3 (additive; client copy is a follow-up for the other agent). When the engine voids a fill
           // round for refund, surface WHY so the lobby can show "round voided, everyone refunded — need 2 wallets"
           // instead of a silent reset. Null during a normal fill. state carries 'voiding'/'ended' verbatim.
           voidReason:(G.phase==='voiding'||G.voided)?(G.voidReason||null):null,
           voidDetail:(G.phase==='voiding'||G.voided)?(G.voidDetail||null):null,
           minDistinctWallets:minDistinctRequired(),
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
    // youWin: the champ owner token matches the viewer exactly OR (seat-to-session binding) maps to the viewer's proven
    // wallet address, so a verified winner is always told they won even on a token-key drift. Pure display; payout is on-chain.
    const _va = viewerAddr(tok);
    const youWin = !!(G.champ.owners && tok && (G.champ.owners.indexOf(tok)>=0 || (_va && G.champ.owners.some(o=>{ var oa=escrow.addrOfToken(o); return oa && oa.toLowerCase()===_va; }))));
    const voided = !!G.champ.none;                                   // no real winner -> round voids -> refund path
    const myTix = seatIdsForViewer(tok);
    const mine = myTix.length>0;   // the local viewer actually had a ticket in this round (not a spectator)
    const myAliveTix = myTix.filter(id=>{var p=G.players[id];return p.alive&&!p.left;}).length;
    const kind = voided ? 'void' : (youWin ? 'win' : (mine ? 'loss' : 'spectator'));
    ended={
      kind, realMoney:rm, pot, rakeBps, rake, payout, winnerTix,
      take: youWin ? perWinner : null,                               // what THIS viewer collects (equal split share)
      roundId:(G&&G.roundId)||null,
      // loss/near-miss context, read from the same per-door distribution the reveal already exposes:
      chambersCracked:(G&&G.resolved)?Object.keys(G.resolved).filter(k=>G.resolved[k]).length:0,
      maxChambers:C.maxch, wasOvertime:!!(G&&G._hadOt), myTickets:myTix.length, myAliveTix,
      // H1: the on-chain auto-payout time (settle + challenge window) so the win screen can show a live countdown to the
      // ~2h anti-cheat window. Read from the CACHED keeper queue (schedulePayout already read claimAtOf when it queued
      // the auto-send) so this adds NO per-poll RPC. null until settle schedules the payout; client then shows the plain
      // "about 2 hours" copy. The `after` value folds in the ~15s keeper margin, which is fine for a display countdown.
      claimAt: (youWin && PAYOUT_QUEUE[String((G&&G.roundId))] && PAYOUT_QUEUE[String((G&&G.roundId))].after) || null
    };
  }

  // AGENT-PROOFING (H6): NO per-door signal is ever exposed DURING THE PICK WINDOW. `heat` is all-null at every
  // phase (unchanged), and the only crowd figure during choose is the aggregate committed/alive counter below,
  // which carries no door-level information to optimize against. The per-door count VECTOR is withheld through
  // choose/blind and released ONLY at reveal (see the revealCounts block), by which point all picks are locked,
  // so it leaks nothing a headless client could act on. This keeps it genuinely person-vs-person.
  const heat=(G.routes||[]).map(()=>null);
  // crowd carries the aggregate locked/alive during choose PLUS the ready-check breakdown (playing/away/locked/total) so
  // the pick screen can show who is actually competing vs auto-played. All display-only; no door-level signal leaks here.
  // `aliveRoster` names EVERY alive robber (NO door) so the client can label the whole field, not just chatters; capped
  // at 60 with the true total in `aliveTotal`. ANTI-EDGE: chooseRoster() emits only {name,aid,av} — never any pick/door.
  // FIX 3c (fairness): the EXACT live locked count is a last-picker oracle. During the choose window it lets a player
  // detect the instant "everyone but me has locked" (I'm the last unlocked, so the crowd's door distribution is fixed
  // and I can pick the emptiest door with no risk the field moves). We therefore BUCKET the publicly-broadcast locked
  // count into coarse tiers (none / some / most / all) instead of the precise integer, so the exact "N-1 of N" edge is
  // gone while the "lots of robbers are locking in" UX is preserved. `alive` (field size) stays exact (it's public and
  // shown anyway). `roster.locked` is coarsened the same way (it exposed the same precise count). The EXACT figures are
  // NOT in this player-facing payload at all; ops reads them live via /api/admin/metrics, which computes from server
  // state directly. committedTier lets the client render a proportional bar without the exact integer.
  const crowd=(phase==='choose')?(function(){
    const aliveN=aliveCount();
    const lockedN=aliveList().filter(([,p])=>p.pick!=null).length;
    const tierOf=(l,a)=>{ if(a<=0||l<=0) return 'none'; if(l>=a) return 'all'; const r=l/a; return r>=0.6?'most':'some'; };
    // Coarse integer so the client's "N of M locked in" bar still animates without being an exact last-picker signal:
    // snap the locked count to the tier's representative value (0 / ~third / ~75% / full), never the precise count.
    const coarse=(t,a)=>{ if(t==='none') return 0; if(t==='all') return a; if(t==='most') return Math.max(1,Math.round(a*0.75)); return Math.max(1,Math.round(a*0.33)); };
    const tier=tierOf(lockedN,aliveN);
    const committedCoarse=coarse(tier,aliveN);
    const obj={ committed:committedCoarse, committedTier:tier, alive:aliveN };
    const rs=rosterStats();
    if(rs){ const rt=tierOf(rs.locked||0, rs.total||0); rs.lockedTier=rt; rs.locked=coarse(rt, rs.total||0); obj.roster=rs; }   // coarsen roster.locked identically (same oracle)
    const ar=chooseRoster(60); if(ar){ obj.aliveRoster=ar; obj.aliveTotal=aliveN; }
    return obj;
  })():null;
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
    // REVEAL IDENTITIES (post-decision, anti-edge-safe): WHO chose which door + who was caught, for THIS chamber only.
    // Safe for the same reason as revealCounts: every pick is LOCKED before reveal, so door identity leaks no live
    // signal. Capped at 60 with the true totals already carried above (busted / survived). Absent -> client falls
    // back to the anonymous count bodies. Scoped strictly to `chamber` via p.bustCh so no prior casualty bleeds in.
    const rp=revealPlayers(chamber, 60); if(rp) reveal.players=rp;
  }

  return {
    now, mode:MODE, engine:C.engine, maxChambers:C.maxch, nextGameIn, lobbyEndsIn, fill, schedule,
    phase, chamber, blind, lockIn, chooseWindow, routes:G.routes||[], heat, crowd, ot,
    // AUTHORITATIVE LAUNCH EDGE: the absolute epoch the round flipped locking->playing, so the client fires the
    // launch (breach-in) transition on the real server flip instead of inferring the phase edge locally.
    launchedAtMs:(G&&G.launchedAtMs!=null)?G.launchedAtMs:null,
    roundId:(G&&G.roundId)||null,   // current round id, so the client can offer to verify it once settled
    // Sybil policy (surfaced for the UI + sim): a hard per-wallet seat cap; the economy is near zero-sum so a
    // Sybil buys a proportional share of a pot it also funds (it cannot drain the house), the lever is concentration.
    sybil:{ maxTicketsPerWallet:(G&&G._walletCap)||walletCap(), enforce:SYBIL_ENFORCE },
    // runtime economy config surfaced to the UI: the display entry price + the computed per-wallet cap + target.
    econ:{ entryUsd:getCfg().entryUsd, roundTarget:getCfg().roundTarget, walletCap:(G&&G._walletCap)||walletCap() },
    jackpot: JACKPOT_RVLT,   // V5 progressive jackpot (human RVLT) for the UI counter; grows on final-vault rollovers
    rolledOver: !!(G&&G.rollover),   // this round ended in a mutual-bust rollover (client shows the "pot rolls over" ceremony)
    launch: launchState(),   // condition-driven: open === mint sold out OR Halloween cutoff (gate 1 = auto-gated); drives the client overlay + "X/max minted"
    alive:aliveCount(), total:seatCount(), pot: realMoney()?((G._onchainPot||0)+(Number(JACKPOT_RVLT)||0)):seatCount()*ENTRY,
    me: reg ? (function(){ var ids=seatIdsForViewer(tok); var al=ids.filter(id=>{var p=G.players[id];return p.alive&&!p.left;}).length; var pr=primarySeatForViewer(tok);
      // CREW VIEW (own tickets ONLY): during the choose/blind/reveal window, surface where THIS caller's own EXTRA
      // tickets (the tok+'#k' entities, owner===tok, id!==tok) are currently sitting, so a multi-ticket player can
      // spread their manual pick. STRICT SCOPING: we read entities whose owner is exactly this request's token and
      // never any other player's; we emit only { ticket, door } for the caller's own extras. No other player's pick
      // is ever added to any payload, and this does NOT touch the per-door `heat`/`crowd` (still hidden). Only when
      // the caller owns >1 ticket, and capped at 3 entries (EV-neutral, matches the per-wallet extra model).
      var crew=null;
      if(tok && ids.length>1 && (phase==='choose'||phase==='reveal')){
        crew=[];
        // ids is already SCOPED to this viewer's own entities (seatIdsForViewer: exact token OR proven address). The
        // primary is the base entity (no '#'); the rest are the viewer's extra auto tickets. We surface only those.
        var _primaryId = ids.find(function(id){ return String(id).indexOf('#')<0; }) || ids[0];
        ids.forEach(function(id){
          if(id===_primaryId) return;                           // skip ticket 1 (that is the player's own primary door = pick above)
          var p=G.players[id]; if(!p) return;
          if(p.left) return;                                    // a withdrawn ticket is not on a door
          var k=parseInt(String(id).split('#')[1],10);          // entity index k (k>=1 for extras); human ticket label = k+1 (k=1 -> "#2")
          // FIX 3a (fairness): never leak the seeded door of an EXTRA auto-ticket DURING the choose window; that is a
          // thin-round info edge (a multi-ticket player could read where their own auto picks landed and infer crowd
          // pressure before locking). Surface `door` ONLY at reveal (after picks are locked and the chamber resolved);
          // during choose it stays null. The ticket index + alive flag are fine to show (no door signal).
          crew.push({ ticket:(Number.isInteger(k)?k+1:ids.indexOf(id)+1), door:(phase==='reveal' && p.pick!=null)?p.pick:null, alive:!!(p.alive&&!p.busted) });
        });
        crew.sort(function(a,b){ return a.ticket-b.ticket; });
        crew=crew.slice(0,3);                                   // cap at 3 (safe, EV-neutral)
        if(!crew.length) crew=null;
      }
      // aid/av: the viewer's own stable avatar id + optional override (so their own messages + the editor render with the
      // same art). ens/profile: surfaced so the profile editor can show the current name + offer "use my ENS picture".
      var _myAid=myTh||null; var _myAv=avatarByTh(myTh)||null;
      // checkedIn: whether THIS viewer's verified seat is checked in for the current round (drives the ready button).
      var _ckAddr=(reg&&reg.verified&&reg.address)?String(reg.address).toLowerCase():null; var _ck=!!(_ckAddr && _roundKey() && isCheckedIn(_roundKey(), _ckAddr));
      return { inGame:ids.length>0, alive:al>0, busted:ids.length>0&&al===0, pick:(_showPrivate&&pr)?pr.pick:null, spectator:ids.length===0, pre:_showPrivate?(reg.pre||null):null, name:reg.name, tickets:ids.length, ticketsAlive:al, wantTickets:clampTickets(reg.tickets), verified:!!reg.verified, away:!!(pr&&pr.away), checkedIn:_ck, crew:crew, aid:_myAid, av:_myAv, ens:reg.ens||null, ensAvatar:reg.ensAvatar||null, profile:(reg.address?profileFor(reg.address):null) }; })() : null,
    reveal, champion, ended,
    // chat: strip the stored token hash; emit only a per-request `mine` boolean (no raw token ever leaves the server).
    // `k` lets the client tell human from bot chatter without exposing the token: a real human line carries a `th`, a
    // bot-chatter line carries `bot:true`. We never emit the raw th; only this coarse kind leaves the server.
    // `aid` = a stable per-author id (the token hash) so the client keys avatar/color on the AUTHOR, not the name, so a
    // rename never re-colors and duplicate names do not collide. `av` is an optional avatar override (chosen emoji or an
    // ENS image URL) resolved from the author's profile/ENS; absent -> client falls back to its aid-keyed procedural art.
    chat:CHAT.slice(-24).map(m=>{ const id=synthesizeId(m); if(m.kind==='sys'){ return { id, sys:true, evkind:(m.evkind||null), text:m.text, ts:m.ts }; } const o={ id, name:m.name, text:m.text, ts:m.ts, mine: !!(myTh && m.th===myTh), k:(m.bot?'bot':(m.th?'human':'bot')), aid:(m.th||null) }; const av=avatarByTh(m.th); if(av) o.av=av; if(m.re) o.re=m.re; const rs=reactionSummary(id, myTh); if(rs){ o.rx=rs.rx; o.mine_rx=rs.mine; } return o; }), history:HISTORY.slice(0,3),
    // #5 ONLINE COUNT + #6 TYPING: `watching` = REG tokens seen within WATCH_WINDOW_MS (cheap O(reg) scan). `typing`
    // = the short-lived set of display names currently typing (see TYPING map), excluding the caller's own name so a
    // client never shows itself. Both are tiny (one int, a short string array) to keep per-connection serialize lean.
    watching: watchingCount(),
    typing: typingNames(reg&&reg.name),
    // real-money context (only when escrow is enabled + on a clock round). buyOpen = the on-chain buy-in window (lobby).
    // Rolling buy-in: `id` is the round a buy-in targets (current lobby OR the next heist), so buy-in is always
    // open. `pot` is the pot you'd be joining; `live` = a heist is running now, so a buy-in pre-books the next one.
    // real-money context (escrow enabled). `id` is the round a buy-in targets so buy-in is always open:
    //   clock  -> current lobby OR next heist (G._buyRound)
    //   rmfill -> the current round while it fills, else the pre-opened next round (RM_BUY)
    // For rmfill there is no wall-clock `startsIn`; progress is ticketsSold/target (see the `fill` block above).
    escrow: escrow.isOn() ? (() => { const _esc = (
      C.engine==='rmfill'
        ? { on:true, id:(G&&RM_BUY!=null?String(RM_BUY):null), entry:escrow.entryWei(),
            buyOpen:(G&&G.phase==='filling'), live:(phase!=='filling'), pot:(realMoney()?(G._buyPot||0):0),
            ticketsSold:(G&&G.ticketsSold||0), target:(C.target||50), graceIn:(G&&G.graceEnds!=null?Math.max(0,G.graceEnds-now):null),
            // ITEM C: expose the PRE-OPENED NEXT round so the client can offer a working buy + progress bar DURING play.
            // nextBuyOpen is true only while the current game is NOT filling (so RM_BUY points at the separate next round)
            // AND that id actually has a fill cache. nextBuyId = RM_BUY (buys already target it via currentBuyRoundId).
            // nextFill = {sold,target} of THAT round only (never the current round's fill). Guard RM_NEXT_FILL's id ==
            // RM_BUY so a value cached just before a rollover is never shown stale against the new next round.
            nextBuyOpen: !!(G && G.phase!=='filling' && RM_BUY!=null && Number(RM_BUY)!==Number(RM_CUR)),
            nextBuyId: (G && RM_BUY!=null && Number(RM_BUY)!==Number(RM_CUR)) ? String(RM_BUY) : null,
            nextFill: (RM_NEXT_FILL && RM_BUY!=null && Number(RM_NEXT_FILL.id)===Number(RM_BUY)) ? { sold:RM_NEXT_FILL.sold, target:RM_NEXT_FILL.target } : null,
            paid:(realMoney()?Object.values(G.players).filter(p=>!p.left&&typeof p.owner==='string'&&p.owner.startsWith('w:')).length:0) }
        : { on:true, id:(C.engine==='clock'&&G?String(G._buyRound||G.start):null), entry:escrow.entryWei(), buyOpen:realMoney(), live:(phase!=='lobby'), pot:(realMoney()?(G._buyPot||0):0), startsIn:(realMoney()&&G._buyRound?Math.max(0,G._buyRound-now):0), paid:(realMoney()?Object.values(G.players).filter(p=>!p.left&&typeof p.owner==='string'&&p.owner.startsWith('w:')).length:0) }
    );
      // SEC-1: attach the compact SIGNED SEED PRE-COMMIT for the round a buy-in targets, so a player sees the
      // operator's binding to this round's seedHash the instant the lobby is live (before they buy), without a
      // separate /proof poll. Hash + signer + sig + openedAt only — never the raw seed. Full canonical message +
      // verification live at /api/round/:id/proof. Null while no round id is known or no pre-commit exists yet.
      try { const _pid=_esc && _esc.id; const _pc=_pid?getPrecommit(_pid):null;
        _esc.precommit = (_pc && _pc.sig) ? { roundId:String(_pid), seedHash:_pc.seedHash, openedAt:_pc.openedAt, signer:_pc.signer, sig:_pc.sig, proofUrl:'api/round/'+encodeURIComponent(_pid)+'/proof' } : null;
      } catch(_){ _esc.precommit=null; }
      return _esc;
    })() : { on:false }
  };
}
// HTTP poll path — UNCHANGED behaviour: still gated upstream (the global play-gate middleware), still serves the
// identical JSON. This is the fallback the WS layer degrades to, so it must keep working exactly as before.
app.get('/api/state',(req,res)=>{ if(!rl(rlKey(req,'state'),120,10000)) return res.status(429).json({error:'slow down'}); try{ stampSeen(reqToken(req)); }catch(_){} res.json(buildStatePayload(req)); });

// ---- WEB PUSH endpoints (opt-in notifications; NO money path) ------------------------------------------------
// Public VAPID key for the client's PushManager.subscribe(). Non-secret by design (it is the public half). Returns
// { enabled:false } when Web Push is unavailable so the client falls back to the in-tab path without erroring.
app.get('/api/push/pubkey',(req,res)=>{
  if(!pushEnabled()) return res.json({ enabled:false });
  res.json({ enabled:true, key: VAPID.publicKey });
});
// Store a PushSubscription (+ the caller's connected wallet addr, optional, for personal "you won" pushes). Rate-limited.
// The subscription is attacker-opaque (a browser-issued endpoint); storing it only lets US push to that browser. addr is
// taken from the body for the personal-win match; it is NOT authenticated here (a mismatched addr only means the wrong
// person might get a "you won" ping, never any fund movement), so this is purely a notification convenience.
app.post('/api/push/subscribe', express.json({limit:'8kb'}), (req,res)=>{
  if(!rl(rlKey(req,'pushsub'),30,60000)) return res.status(429).json({error:'slow down'});
  if(!pushEnabled()) return res.status(409).json({ ok:false, enabled:false });
  const b=req.body||{};
  const sub=b.subscription||b.sub||null;
  const addr=(typeof b.addr==='string')?b.addr:((typeof b.address==='string')?b.address:null);
  // FIX 3 (red-team): a personal "you won" push binds a browser to a wallet. Previously `addr` came straight from the
  // body with no auth, so anyone who knew a victim's wallet could register THEIR browser to receive that wallet's
  // personal win push — a win-timing side-channel. When an addr IS supplied, require the SIWE-verified session to map
  // to that exact address (same check used at /api/gas-drip + /api/autobuy). Anonymous subscriptions (no addr, generic
  // round pings only) stay allowed with no auth — they leak nothing wallet-specific.
  if(addr!=null){
    const _tok=reqToken(req); const _reg=_tok&&REG[_tok];
    const _addrL=String(addr).toLowerCase();
    if(!/^0x[0-9a-fA-F]{40}$/.test(_addrL)) return res.status(400).json({ ok:false, error:'invalid wallet address' });
    if(!(_reg&&_reg.verified&&_reg.address&&_reg.address.toLowerCase()===_addrL)) return res.status(401).json({ ok:false, error:'sign in with this wallet (SIWE) first' });
  }
  const ok=addPushSub(sub, addr);
  if(!ok) return res.status(400).json({ ok:false, error:'invalid subscription' });
  res.json({ ok:true });
});
// Remove a subscription (client opt-out). Idempotent.
app.post('/api/push/unsubscribe', express.json({limit:'4kb'}), (req,res)=>{
  if(!rl(rlKey(req,'pushsub'),30,60000)) return res.status(429).json({error:'slow down'});
  const ep=(req.body&&typeof req.body.endpoint==='string')?req.body.endpoint:null;
  if(ep && PUSH_SUBS[ep]){ delete PUSH_SUBS[ep]; savePushSubs(); }
  res.json({ ok:true });
});
// sw.js + manifest.webmanifest are served EARLY + PUBLICLY above (before the password gate), so no route for them is
// needed here. express.static keeps serving the rest of public/ (it also sets the right MIME on sw.js/manifest as a
// belt-and-suspenders in case a request ever reaches it through a different path).
// Backup serve-guard (defense-in-depth): never ship a stray .bak/promote-bak/etc under a served dir to a browser.
const BAK_GUARD = /\.(bak|prexcp-bak|promote-bak|pre[-.][a-z0-9]*bak)(\b|$)/i;
app.use((req,res,next)=>{ const p=req.path||''; if(BAK_GUARD.test(p)||p.includes('bak-')||p.includes('_bak')) return res.status(404).end(); next(); });
app.use(express.static(path.join(__dirname,'public'),{ setHeaders:(res,fp)=>{ if(fp.endsWith('sw.js')){ res.set('Content-Type','application/javascript'); res.set('Service-Worker-Allowed','/'); res.set('Cache-Control','no-cache'); } else if(fp.endsWith('.webmanifest')){ res.set('Content-Type','application/manifest+json'); } } }));

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
// H3 WS HARDENING: cap inbound frames at 4 KB (protocol messages are tiny) and disable permessage-deflate (a
// compression-bomb / CPU-amplification vector and pointless for our small frames). We gate the path ourselves below.
const wss = new WebSocketServer({ server, path: undefined, maxPayload: 4096, perMessageDeflate: false });

// H3 PER-IP CONNECTION CAP: a handful of sockets per IP is normal (multiple tabs / a shared NAT household), but an
// unbounded fan-out from one source is a cheap memory/FD exhaustion vector. Cap concurrent sockets per hardened real
// client IP; further connections over the cap are closed immediately. Keyed on the SAME trusted-proxy-authenticated IP
// the HTTP limiter uses, so a direct-to-origin caller can't spoof x-vs-real-ip to mint fresh buckets.
const WS_IP_CAP = 8;
const WS_MAX_BUFFER = 1 << 20;   // 1 MB: a socket whose outbound buffer balloons past this is a slow reader / slow-loris; terminate it.
const _wsConnByIp = Object.create(null);
// Resolve the hardened real client IP for a raw upgrade request: trust x-vs-real-ip ONLY behind a valid proxy secret
// (constant-time compare, same rule as rlKey); otherwise fall back to the real socket peer. Never trust a bare XFF.
function wsClientIp(upgradeReq){
  try{
    const h=upgradeReq.headers||{};
    const pa=h['x-vs-proxy-auth'], rip=h['x-vs-real-ip'];
    if(typeof rip==='string' && rip && typeof pa==='string' && _ctEq(pa, PROXY_SECRET)){
      return rip.indexOf(',')>=0 ? rip.split(',')[0].trim() : rip;
    }
    return (upgradeReq.socket && upgradeReq.socket.remoteAddress) || 'anon';
  }catch(_){ return 'anon'; }
}

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
  // H3 PER-IP CONNECTION CAP: reject a new socket once this hardened IP already holds WS_IP_CAP live sockets. The count
  // is decremented on close below. Legit players (a few tabs each) are well under the cap; a fan-out flood is refused.
  const _wsIp = wsClientIp(upgradeReq);
  if((_wsConnByIp[_wsIp]||0) >= WS_IP_CAP){ try{ ws.close(1013,'too many connections'); }catch(_){ } return; }
  _wsConnByIp[_wsIp] = (_wsConnByIp[_wsIp]||0) + 1;
  ws._vsIp = _wsIp;
  ws.on('close', ()=>{ try{ if(ws._vsIp!=null){ const n=(_wsConnByIp[ws._vsIp]||1)-1; if(n>0) _wsConnByIp[ws._vsIp]=n; else delete _wsConnByIp[ws._vsIp]; } }catch(_){ } });
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
        // FIX P0: a `w:` wallet token is honored on this socket ONLY with a matching secret session (m.sess); without
        // it the socket is an anonymous spectator (public snapshot, no per-player me/pick). Non-wallet tokens unchanged.
        const okWallet = (m.token.indexOf('w:')===0) ? (sessAddr(m.sess)===m.token.slice(2)) : true;
        if(r && okWallet){ ws._vsToken=m.token; ws._vsSess=(m.token.indexOf('w:')===0?m.sess:null); ws._vsHello=true; }
        else { ws._vsToken=null; ws._vsSess=null; ws._vsHello=true; }   // identified but not proven -> public snapshot only
      } else { ws._vsToken=null; ws._vsSess=null; ws._vsHello=true; }
      // #3 WS PRESENCE: a live socket for this token IS presence. Away detection keys on lastSeen (stampSeen), which
      // the HTTP poll normally refreshes, but a WS-connected client DROPS the hot poll (setPollCadence skips it while
      // the socket is healthy), so a genuinely-present player could cross AWAY_MS during filling / pre-first-pick and
      // get auto-played. Stamp on the hello handshake AND on the lightweight periodic presence ping below, so socket
      // activity counts as presence. Cheap (an in-memory timestamp write); never gates play, only clears the away flag.
      try{ if(ws._vsToken) stampSeen(ws._vsToken); }catch(_){}
      sendStateTo(ws);
    }
    // #3 PRESENCE PING: a tiny heartbeat the client sends on an interval while the socket is healthy. It carries no
    // state and triggers no re-serialize (unlike resync); it ONLY refreshes this token's lastSeen so a connected but
    // idle player (watching the fill, not yet picking) is never mistaken for away. Rate-limited by the per-socket
    // flood cap above. No-op for an anonymous/unverified socket (no token to stamp).
    else if(m.type==='presence'){ try{ if(ws._vsToken) stampSeen(ws._vsToken); }catch(_){} }
    // #6 TYPING: a composing client sends {type:'typing'} (throttled client-side to ~once/2s). Record the sender's
    // display name in the short-lived TYPING map so other viewers see "X is typing". Also counts as presence. Only an
    // identified token can type (anonymous sockets are ignored), and the per-socket flood cap above already bounds it.
    else if(m.type==='typing'){ try{ const r=ws._vsToken&&REG[ws._vsToken]; if(r&&r.name){ noteTyping(r.name); stampSeen(ws._vsToken); } }catch(_){} }
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
  if(ws._vsHello && ws._vsToken){ shim.headers = Object.assign({}, shim.headers, { 'x-vs-token': ws._vsToken }); if(ws._vsSess) shim.headers['x-vs-sess']=ws._vsSess; }
  else { if(shim.headers){ delete shim.headers['x-vs-token']; delete shim.headers['x-vs-sess']; } }   // pre-hello: no per-player identity -> public
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
  // CHAT-LIVELINESS SIGNATURE: fold the online count + the set of currently-typing names into the signature so a
  // start/stop-typing or a change in "N watching" triggers a push within ~1s (and the typing line clears when the TTL
  // lapses) without any extra timer. Both reads are O(reg)/O(typing) and tiny; they never touch play or settle.
  const live = watchingCount()+'~'+typingNames().join(',');
  // LOCK-IN COUNTER: during a choose window fold the committed count into the signature so a player locking a door
  // pushes the updated "N of M robbers locked in" to everyone within ~1s (the per-second game tick), independent of the
  // explicit pick nudge. Scoped to the playing/choose phase so it never adds churn outside a live chamber.
  let committed='';
  // FIX 3c (fairness): fold only the COARSE lock TIER (not the exact locked integer) into the broadcast signature, so a
  // single door-lock that stays within the same tier no longer flips the signature and triggers an immediate full-state
  // push. This removes the sub-second "I'm the last unlocked player" oracle (the broadcast only moves when the field
  // crosses a tier boundary, or on the normal 1s tick). The exact count is never broadcast; ops reads it live via
  // /api/admin/metrics. playing/away still fold in (presence stats are not a door-distribution oracle).
  try{ if(C.engine==='rmfill' && G.phase==='playing'){ const i=rmRunInfo(now); if(i.phase==='choose'){ var rs=rosterStats(); var _aN=aliveCount(); var _lN=aliveList().filter(([,p])=>p.pick!=null).length; var _tier=(_aN<=0||_lN<=0)?'none':(_lN>=_aN?'all':((_lN/_aN)>=0.6?'most':'some')); committed='c'+_tier+(rs?('p'+rs.playing+'a'+rs.away):''); } } }catch(_){ }
  // _reactVer bumps on every reaction toggle so a like/unlike pushes to all viewers sub-second (A). committed folds the
  // locked count PLUS the ready-check playing/away split so a check-in pushes the stats to everyone within ~1s.
  return [G.roundId, G.phase, phase, chamber, ot, seatCount(), (G.ticketsSold||0), pot, champ, rev, CHAT.length, live, _reactVer, committed].join('|');
}

let _wsLastSig = null;
// Push loop: runs once per second AFTER the game tick. If the signature changed, push a heavy full state to all;
// otherwise push a tiny shared countdown tick so timers animate smoothly between real events. Fully isolated from
// the game loop — it only READS state, never mutates it, so it can't affect gameplay even if it throws.
function wsPushLoop(){
  try{
    // DURABLE GAME LOG: diff the authoritative public facts and persist any newly-public sys line (buy-in, chamber,
    // breach, winner) BEFORE the signature check. Runs even with zero subscribers so events are still captured for
    // history/refresh. Read-only against game state; appending a sys line bumps CHAT.length so the signature below
    // naturally picks it up and pushes the new line live to any connected viewer (no separate broadcast needed).
    sysLogWatch();
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

// Liveness: terminate dead sockets so clients list stays clean. H3: also terminate any socket whose OUTBOUND buffer has
// ballooned past WS_MAX_BUFFER (a slow reader / slow-loris that never drains our pushes) so one stuck peer can't grow
// server memory unbounded. A healthy client keeps bufferedAmount near zero.
setInterval(()=>{ wss.clients.forEach(ws=>{
  try{ if(ws.bufferedAmount > WS_MAX_BUFFER){ ws.terminate(); return; } }catch(_){ }
  if(ws._vsAlive===false){ try{ws.terminate();}catch(_){ } return; } ws._vsAlive=false; try{ ws.ping(); }catch(_){ } }); }, 30000);

// Advertise our assigned loopback PORT to a sibling file so the Vault Robbers hub can reverse-proxy us under
// /play/v3 directly on loopback. Non-secret: just a port number in our own source dir.
try{ fs.writeFileSync(path.join(__dirname,'.vs-port'), String(process.env.PORT||'')); }catch(_){}
ensureGame();   // defensive: guarantee G is non-null at the moment the port opens (closes the boot-window null-G 500 class)
server.listen(process.env.PORT,()=>console.log('[vault-standoff] mode='+MODE+' on',process.env.PORT,'(+WS push)'));
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
  // Prime the RVLT/USD cache off the now-warm peg so the FIRST /api/pay/balances call prices held RVLT (never a
  // cold-drop that returns held:[] for a wallet that holds RVLT). rvltUsdPrice reads PEG.lastWei synchronously.
  const rp=await rvltUsdPrice();
  console.log('[vault-standoff] PEG boot warmup done (twap primed'+(w!=null?', entry='+(w/10n**18n)+' RVLT':'')+(rp!=null?(', rvlt=$'+rp.toFixed(6)):'')+')');
}catch(_){} })(); }
// ASSET-PRICE BOOT WARMUP: prime the last-known-good price cache for every held-asset class (ETH via cg 'ethereum'
// covering chains 1/8453/42161/10/4663, BNB, POL, SOL, BTC) so the VERY FIRST /api/pay/balances call is warm and an
// asset the wallet holds is never dropped by a cold price lookup. Best-effort, bounded, fully non-fatal. Once seeded,
// pxGet serves the LKG value forever on any later cold/flaky call (background-refreshed).
if(escrow.isOn()){ (async()=>{ try{
  const [eth,bnb,pol,sol,btc]=await Promise.all([
    nativeUsdPrice(1).catch(()=>null), nativeUsdPrice(56).catch(()=>null), nativeUsdPrice(137).catch(()=>null),
    solUsdPrice().catch(()=>null), btcUsdPrice().catch(()=>null)
  ]);
  console.log('[vault-standoff] asset-price warmup: ETH=$'+(eth||'?')+' BNB=$'+(bnb||'?')+' POL=$'+(pol||'?')+' SOL=$'+(sol||'?')+' BTC=$'+(btc||'?'));
  // Prime the entry-COST (feasibility route) cache for the native routes incl Robinhood-ETH (4663) + SOL + Sol-USDC,
  // so a flaky Relay quote on the first request can't hide a routable held asset (it serves the warm LKG instead).
  const NATIVE='0x0000000000000000000000000000000000000000';
  // Prime only the BRIDGED routes (chains 1/8453/42161/10/56/137 + Solana). 4663 is EXCLUDED: its same-chain quote is
  // intermittently rejected by Relay and its assets now use the USD-threshold feasibility branch (P1), not this cost.
  const costJobs=[1,8453,42161,10,56,137].map(c=>relayEntryCostUsd(c, NATIVE).catch(()=>null))
    .concat([ relayEntryCostUsd(792703809,'11111111111111111111111111111111').catch(()=>null),
              relayEntryCostUsd(792703809, SOL_USDC_MINT).catch(()=>null) ]);
  const costs=await Promise.all(costJobs);
  console.log('[vault-standoff] entry-cost warmup primed '+costs.filter(x=>x!=null&&x>0).length+'/'+costs.length+' routes');
}catch(_){} })(); }
// Boot assertion: the EIP-712 domain constants served by /api/autobuy/params must recompute to the on-chain
// domainSeparatorV4(). If they ever diverge (e.g. a redeploy under a different name/version), log it LOUDLY so
// the auto-buy signing material is never silently unsignable. Non-fatal (read-only, best-effort).
if (escrow.isOn()) { escrow.assertDomain().then(r => {
  if (r && r.ok) console.log('[vault-standoff] EIP-712 AutoBuy domain OK (name/version match on-chain domainSeparator).');
  else console.error('[vault-standoff] WARNING: EIP-712 AutoBuy domain MISMATCH — /api/autobuy/params may serve an unsignable domain. detail=', r);
}).catch(()=>{}); }
// GAP-B: ENV / ON-CHAIN PARITY SELF-CHECK. Mainnet-only (the escrow module no-ops on testnet). Once the contract
// is reachable, assert token()==configured RVLT and settlementSigner()==our signer, and log rake/cap for operator
// confirmation. A DEFINITIVE token/signer mismatch is fatal (exit 1) so the server never settles against the wrong
// token or with a key the contract won't accept; a transient RPC error only warns (so a network blip can't brick a
// restart); rake/cap differences are logged loudly but non-fatal.
if (escrow.isOn()) { escrow.parityCheck().then(r => {
  if (r && r.ok) {
    console.log('[vault-standoff] parity OK (token + settlementSigner match config). on-chain reads:', r.reads||{});
  } else if (r && r.fatal) {
    console.error('[vault-standoff] FATAL (GAP-B): env/on-chain parity MISMATCH — ' + (r.reason||'') + '. Refusing to go live.');
    process.exit(1);
  } else {
    console.warn('[vault-standoff] WARNING (GAP-B): parity not verified — ' + (r && r.reason || 'unknown') + '. Will proceed (non-fatal); re-check the environment.');
  }
}).catch(e => { console.warn('[vault-standoff] WARNING (GAP-B): parity check threw (non-fatal):', e && e.message || e); }); }
// P0: ON-CHAIN RELAYER-SLOT ASSERTION. buyInForRange/buyInFor revert unless the escrow's `relayer` slot == our
// VS_RELAY_PK address. The parity check above does NOT cover this, so without it a never-set relayer slot leaves
// auto-buy "armed" but silently reverting every round (autoBuyTick .catch(()=>null)). Assert it at boot: on a
// cleanly-read MISMATCH with escrow ON + real money, FAIL LOUD (same severity as the key guards) and leave
// auto-buy disabled (the cached false makes relayUsable() return false, so autoBuyTick goes inert and /api/autobuy
// rejects arming). A transient RPC error only warns (we never disarm a possibly-correct relayer on a blip). This
// is READ-ONLY: it never sets the slot (that is a Safe owner action) — it only verifies + fails loud + blocks.
if (escrow.isOn()) { escrow.assertRelayerSlot().then(r => {
  if (r && r.ok) {
    console.log('[vault-standoff] relayer-slot OK (on-chain relayer == our VS_RELAY_PK ' + (r.local||'') + '). Auto-buy can land.');
  } else if (r && r.fatal) {
    console.error('[vault-standoff] FATAL (P0): on-chain relayer-slot MISMATCH — ' + (r.reason||'') + '. Auto-buy is DISABLED (every buyInForRange would revert). A Safe owner must run setRelayer(' + (r.local||'<relay key>') + '). Settle/void/manual-buy are unaffected.');
  } else {
    console.warn('[vault-standoff] WARNING (P0): relayer-slot not verified — ' + (r && r.reason || 'unknown') + '. Auto-buy stays optimistic until the slot is read cleanly; /api/autobuy still re-checks it per arm.');
  }
}).catch(e => { console.warn('[vault-standoff] WARNING (P0): relayer-slot assertion threw (non-fatal):', e && e.message || e); }); }
