# Vault Robbers engine port - notes for the next pass

## PROVEN this pass (Phase 2 foundation)
- `sha256.js`: a synchronous SHA-256 with a node-crypto-compatible surface
  (`createHash('sha256').update(x).digest()` with `readUInt32BE` + `toString('hex')`, plus `randomBytes`).
  VERIFIED byte-identical to node `crypto` (hex, readUInt32BE, multi-update, utf8). This is the keystone:
  it lets the real `skillgames.js` / `skillv4.js` run UNCHANGED in the browser with the SAME rng stream,
  so all ~56 games build and grade exactly as they did on vaultrobbers.com. Zero gameplay drift, no re-implementation.
- The real `skillgames.js` (56 games) loads and grades deterministically over (seed, level, events). Proven in `_enginetest.mjs`.
- Engine source staged in `engine/`: skillgames.js, skillv4.js, det-bars.js, render.js, pnggen.js (copied as-is from vaultrobbers-dev).

## FROZEN free-play config (the one flag set to hardcode; no runtime flags in a static build)
Gameplay as it shipped on vaultrobbers.com, money/mint/onchain/anti-bot OFF:
- ON: RTV_ODDS_V2, RTV_SKILL_V3, RTV_SKILL_V4, RTV_CORE_V2, RTV_DETERMINISTIC, RTV_V2, RTV_LADDER_V2, RTV_PUBLIC=1
- OFF: RTV_MINT_SPOTS/RTV_NO_MINT=1, RTV_BOT_SHADOW_GATE, RTV_SHADOW_ODDS, RTV_AUTO_SHADOW, RTV_DEX_AUTH_GATE, RTV_OBFUSCATE, RTV_PAYOUT_PAUSE, RTV_HIDE_PRACTICE (practice is free+open now)
- NET: testnet / FREE_PLAY true (off-chain "chips" path; all fees waived; pot/jackpot become cosmetic local counters)

## ODDS (exact, from server.js)
- CURVE A backbone: `P = [0.86,0.78,0.66,0.54,0.46,0.30,0.185,0.12,0.095,0.024]`, LEVELS=10
- Doors: left x1.22 (cautious), center x1.0 (standard), right x0.72 (greedy), cap 0.97
- Deterministic skill model: clear the room = win, no rarity roll on skill/dexterity/perception; core keeps one rarity roll
- Categories: luck, skill, perception, dexterity (rhythm deleted)
- V2_SKILL_BAR = [0.544,0.653,0.650,0.736,0.810,0.868,0.884,0.895,0.916,0.943]

## REMAINING (next pass) - well understood, de-risked
1. Browser CommonJS micro-bundler -> `engine.bundle.js` exposing `window.RTVEngine`:
   wrap each engine module in `register(name, fn(module,exports,require))`; require() maps
   `crypto`->sha256.js (RTVCrypto), `express`->noop stub (mountSkillV4 is NOT called; call startSession/gradeSession/getFrame directly),
   `./render.js`->render (with `./pnggen.js`->a browser pnggen whose `png()` returns a canvas dataURL),
   Buffer->Uint8Array shim, process.env->the frozen flags above.
2. `engine/pnggen.browser.js`: same pixel Canvas API (set/fillRect/circle/triangle/ring/digit/number/soft/vgrad/blend),
   but `png()` -> put px into ImageData on an offscreen <canvas> -> `toDataURL('image/png')`. render.js then works unchanged.
3. `crack.js`: extract ONLY the gameplay core from server.js `/api/crack` (~2663-2950): level=depth+1,
   col=tierCol(seed,level,door), score=GAMES[gk].grade(built,level,events), deterministic win = score>=bar
   (skill/dex/perc) else (score>=BAR && roll<ROLL) for luck; descend; core choice at LEVELS (cosmetic ETH-or-pot).
   DROP: db/rtv_seeds, run tokens, rate-limit, honeypot, bot-consistency, shadow-gate/odds, auto-shadow, dex-auth,
   ONCHAIN_ONLY, mint dealers. Use localStorage for run state. Also need gameForDoor / v4Challenge / tierCol / doorsLayout (pure, in server.js).
4. apishim wiring: api/enter (new run), api/crack (crack.js), api/mini/start+step (-> startSession/getStep bound to the door),
   api/skill/start+grade+step (-> startSession/gradeSession/getStep), api/forfeit, api/cashout (cosmetic).
5. Frame interception (recall games): `loadImg` uses `new Image().src='api/skill/frame?...'` (NOT fetch), so the apishim fetch
   override does NOT catch it. Intercept by wrapping Image / the src setter: for `api/skill/frame` + `api/mini/v4frame` URLs,
   call getFrame -> renderFrame (browser pnggen) -> dataURL and set that instead. DROP the getFrame time-gate/one-shot anti-cheat.
   Self-drawing games (timing/skill/dexterity, drawn by skillgames-remote.js from `data`) need NO frames and work from start+grade alone.

## Verify next pass
Extend `_enginetest.mjs` to run a full 10-chamber crack sequence + a getFrame render. Browser integration (Image intercept,
canvas pnggen, fetch wiring) can only be validated by a real browser playthrough - do that in ONE agent-browser pass (close it after; the host is 2-CPU).
