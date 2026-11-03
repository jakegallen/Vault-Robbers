// Mainnet TEST launcher for Robbing the Vault.
// Forces RTV_NET=mainnet, then boots the normal server. Same code + public/ as the testnet dev site, but pointed at the
// DEPLOYED mainnet contracts (Robinhood chain 4663). Still password-gated by DEV_SITE_PASSWORD (same door as dev), and
// uses the mainnet OPERATOR_PK / ROBBERS_SIGNER_PK group secrets automatically (chain-gated in server.js). The testnet
// dev site (dev.robbingthevault.com) is left untouched.
process.env.RTV_NET = 'mainnet';
// ODDS_V2 skill-driven model (Jake 2026-09-04) — enabled on the mainnet-TEST site (dev.robbingthevault.com) for playtesting ONLY.
// Deterministic skill ch1-5 + bot-proof gauntlet ch6-10; Nerve/Luck unchanged. Monday's public prod (start-prod.js) does NOT set
// this, so the launch stays on the frozen model until we've validated V2 here.
process.env.RTV_ODDS_V2 = 'on';
// SKILL_V3 (Jake 2026-09-07) — staged HERE for playtesting: skill DECIDES chambers 6-9 (no roll), mini-games get much
// faster/tougher with depth, and the core (ch10) keeps one rarity roll to protect the ETH jackpot. start-prod.js does NOT set
// this, so production stays on the current model until we deliberately promote.
process.env.RTV_SKILL_V3 = 'on';
// Extra hidden Vault Robbers dealers in chambers 3 & 4 (Jake 2026-09-07) — staged here first; start-prod.js enables it on promote.
process.env.RTV_MINT_SPOTS = 'on';
// V2 core upgrade live (proxy upgraded to RobbingTheVaultV2 2026-09-07): route core cracks to crackCore() + the ETH-or-pot choice.
process.env.RTV_CORE_V2 = 'on';
// SKILL_V4 seed-not-answer engine (Jake 2026-09-09 audit fix) — mirror the stage twin so the mainnet-TEST site actually mounts
// /api/skill/* (the Practice Arcade + how-to-play demos depend on it) AND so the 'memory' door category is resolved by the v4
// crack engine instead of silently degrading to a skill/effOdds door. Test-site only; start-prod.js still omits it.
process.env.RTV_SKILL_V4 = 'on';
// FULL V2 on the mainnet-dev build (Jake 2026-09-09): 2000-RVLT burn economics, holder discount, casino, buy-and-seed. DEV_SKIP stays off on mainnet.
process.env.RTV_V2 = 'on';
// Buy-Burn-Earn capped ladder is LIVE on-chain (V4 impl 0x44A4E33376a9bE7f9f09260F35cd11272E3904Ad, upgraded via Safe 2026-09-11).
// Turn on the server/client mirror so displayed cash-out offers = min(pct*pot, cap, pot-floor), matching what the contract pays.
process.env.RTV_LADDER_V2 = 'on';
// Practice Arena free for game iteration; real runs still cost the 2000 burn.
process.env.RTV_FREE_ARCADE = '0';   // Jake 2026-09-13: gate the Practice Arena on the mainnet-test twin too (200 RVLT/run burn), so it matches production. Was '1' (free).
// HUMANNESS HARD-GATE (Jake 2026-09-12): a bot-flagged non-luck run that would otherwise succeed becomes a hard miss. Closes the
// soft-lane games a score bar can't defend (pure reaction / static-hold) by killing runs with superhuman/robotic input signatures.
// rtv_bot_signals keeps logging so thresholds can be tuned in week 1.
process.env.RTV_BOT_SHADOW_GATE = 'on';   // Jake 2026-09-14: ENFORCE on the twin — a detected bot auto-loses each run. Flipped from 'log' AFTER removing the constant_dt dexterity false-positive so a real human is not auto-failed. If a legit run is ever wrongly failed, flip back to 'log' and check the flag reason. Prod (start-prod-v2.js) already 'on'.
process.env.RTV_SHADOW_ODDS = 'on';   // Jake 2026-09-14: shadow-ODDS — flagged wallets advance shallow at a decaying rate (no 0%-win tell) but never clear the cash-out gate, so an agent bot keeps burning entry fees without realizing it's flagged.
process.env.RTV_HIDE_PRACTICE = '1';   // Jake 2026-09-13: NO practice arena on the public game — even the twin. The whole /api/skill/* free-games surface is CLOSED here too; real runs use the run-bound /api/mini/*. Team practices via the password-gated admin dashboard (embedded rtv-games-gallery). Match prod exactly.
// DETERMINISTIC pure-skill mode (Jake 2026-09-13): no rarity roll on skill categories — beat the game = advance ("if you win, you win").
// Rhythm deleted; lean roster (dexterity 8 / perception 9 / skill 5 / luck 15). Deep chambers (ch>=6) draw dexterity+luck only (the sole
// rare-gating categories; perception/skill can't floor deep yet). DET_CLEAR full-clear ~1-in-80k. Vault protection w/ no roll = deep
// difficulty + solver-fingerprint + sticky bot-role + telemetry. TWIN-ONLY for playtest; start-prod-v2.js does NOT set this.
process.env.RTV_DETERMINISTIC = 'on';
process.env.RTV_LADDER_V2 = 'on';   // Jake 2026-09-14: show the capped ladder on the twin too (matches live on-chain payoutCap read 2026-09-14: 1/3/5/10/25% caps 1k/3k/9k/800k/2M). Server was on pure-% legacy = desynced from what the contract pays.
process.env.RTV_DEX_NEW = 'on';   // Jake 2026-09-14: enable the 4 new dexterity games (dialstop/undertow/gaterunner/livewire) in the deep rotation on the TWIN for playtest. NOT set in start-prod-v2.js until validated.
process.env.RTV_DEX_AUTH_GATE = 'log';  // Jake 2026-09-15: dexterity-authenticity LOG/MEASURE only (never voids a human), decoupled from the sticky-role shadow-gate which stays 'on'. Matches start-prod-v2.js.
process.env.RTV_AUTO_SHADOW = 'on';     // Jake 2026-09-16: mirror prod — auto-detect + shadow-gate the metronomic agent signature (RTV_AS_MEAN/AS_VAR/AS_RUNS/AS_DEPTH tunable).
process.env.RTV_DEX_AUTH_MIN = '0.4';   // tuned from 0.5 to sit clear of the human dex band (avg 0.581, 2 human runs grazed 0.5).
require('./server.js');
