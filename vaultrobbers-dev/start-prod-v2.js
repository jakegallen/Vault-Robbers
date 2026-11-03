// PUBLIC V2 LAUNCHER — Robbing the Vault V2 (Jake 2026-09-09 cutover).
// Boots the V2 rebuild (vaultrobbers-dev source) on MAINNET (Robinhood 4663) and UNGATES it (RTV_PUBLIC=1 skips the
// DEV_SITE_PASSWORD door). This is the file the public game artifact runs at launch. LAUNCH MODEL (Jake 2026-09-14): deterministic
// no-roll skill + shadow-gate ENFORCED. The twin (start-mainnet.js) runs the same model; the only twin differences are that it leaves
// Practice on for Jake and its shadow-gate is flipped to on for final playtest. det-bars still need final calibration from playtest data.
//
// VALIDATED FLAG SET (identical to start-mainnet.js):
process.env.RTV_NET = 'mainnet';        // deployed mainnet contracts + mainnet OPERATOR_PK/ROBBERS_SIGNER_PK (chain-gated in server.js)
process.env.RTV_ODDS_V2 = 'on';         // skill-driven odds model
process.env.RTV_SKILL_V3 = 'on';        // skill decides ch6-9 (no roll), harder/faster with depth, core keeps one rarity roll
process.env.RTV_SKILL_V4 = 'on';        // seed-not-answer Skill Engine v4 (no answers/scoring in the client) + new/culled game roster + MEMORY category
process.env.RTV_CORE_V2 = 'on';         // crackCore() ETH-or-pot choice (RobbingTheVaultV2 proxy upgrade is live on-chain)
process.env.RTV_MINT_SPOTS = 'on';      // hidden Vault Robber dealers in chambers 3 & 4
// PUBLIC:
process.env.RTV_PUBLIC = '1';           // ungate (skip DEV_SITE_PASSWORD)
process.env.RTV_BOT_SHADOW_GATE = 'on'; // humanness hard-gate ON at launch (Jake 2026-09-12): flagged non-luck runs that would succeed become hard misses
process.env.RTV_SHADOW_ODDS = 'on';     // Jake 2026-09-14: shadow-ODDS mode. A flagged wallet still advances shallow chambers at a low decaying rate (looks like a struggling human, no 0%-win tell) but can NEVER clear the cash-out gate -> it keeps burning entry fees and never banks. Off = hard void every flagged win.
process.env.RTV_AUTO_SHADOW = 'on';     // Jake 2026-09-16: auto-detect + shadow-gate the metronomic agent signature (near-perfect mean score + near-zero variance + deep reach). Tunable via RTV_AS_MEAN/AS_VAR/AS_RUNS/AS_DEPTH. Catches Will's agent fan-out without manual flagging.
process.env.RTV_DETERMINISTIC = 'on';   // Jake 2026-09-14: ship the deterministic no-roll skill model (clear the room = you win; no rarity roll on skill/dexterity/perception). Backstop = shadow-gate ON + sticky bot-roles + dexterity authenticity. NOTE: det-bars need final calibration from playtest scores before this is public.
process.env.RTV_DEX_AUTH_GATE = 'log';  // Jake 2026-09-15: dexterity-authenticity in LOG/MEASURE mode (never voids a human win). DECOUPLED from RTV_BOT_SHADOW_GATE (which stays 'on' hard). Rationale: real human dex traces avg 0.581, too thin a margin to hard-void day one; the multisig payout review + sticky roles + shadow-odds are the enforcing backstops. Flip to 'on' after a week of real traces confirm zero human false-positives.
process.env.RTV_DEX_AUTH_MIN = '0.4';   // tuned down from 0.5 to sit clear of the human dex band (2 real human runs grazed 0.5); only strongly synthetic traces surface in the review queue.
process.env.RTV_V2 = 'on';              // 2000-RVLT entry / 100% burn / holder discount + casino rooms. Jake CONFIRMED 2026-09-13; already validated on the mainnet-test twin (start-mainnet.js:24 sets it too).
process.env.RTV_LADDER_V2 = 'on';
process.env.RTV_PAYOUT_PAUSE = '1';     // RE-ENABLED 2026-09-17 (Jake, post-exploit stabilization): PAUSE all RVLT ladder cash-out signing while we secure the pot on-chain + decide the reset. Server returns a graceful "paused, run is safe" on cash-out. NOTE: core/ETH settles are EXEMPT from this flag (it does NOT stop the on-chain core claim path that bypassed the server tonight — the 3.76M pot must be secured via the Safe). Remove to resume ladder cash-outs.
/* CASH-OUT HOLD LIFTED 2026-09-16: fixed on-chain caps confirmed (Safe tx 0x3489b46399961836fa4c46c4accc2ce6c00c956547367ec9b800b7e73d2daa85). Re-add process.env.RTV_PAYOUT_PAUSE='1' to hold again. */   // (was TEMP HOLD) (Jake 2026-09-16): RVLT cash-outs held (core/ETH exempt) until the fixed on-chain caps (setLadder 1k/3k/9k/18k/36k) land via the Safe — the on-chain ladder was paying %-of-pot uncapped (~1M/deep cash-out). REMOVE this line + restart the moment setLadder is confirmed on-chain.       // Jake 2026-09-14: capped Buy-Burn-Earn ladder (pct WITH per-tier cap). Server display now MATCHES the live on-chain ladder verified 2026-09-14 (1/3/5/10/25% caps 1k/3k/9k/800k/2M, floor 100k). Was OFF -> server showed pure-% while the V4 contract already paid capped (a desync). Values live in LADDER_V2 in server.js.
process.env.RTV_HIDE_PRACTICE = '1';    // Jake 2026-09-13: NO Practice Arena at launch — players burn + play the real game only. Re-enable in a week or two if nobody wins. The mainnet-test twin (start-mainnet.js) leaves this OFF so Jake keeps practicing.
process.env.RTV_OBFUSCATE = '1';        // Jake 2026-09-13: minify/mangle the game-logic client JS on serve (strip comments = the real intel). Defense-in-depth speed-bump only — fail-safe (falls back to original on any minify error). Twin stays readable.
process.env.RTV_V2_EPOCH = '2026-09-16 12:00:00';   // LAUNCH CUTOFF (corrected 2026-09-16: game actually went public ~13:40 UTC and real runs began 14:11 UTC, BEFORE the original 15:00 target — which hid live runs from the loot page). Set to noon UTC: after the last pre-launch test row (2026-09-15 23:07) and before the first real run (14:11), so every real launch run shows while all test data stays excluded from PUBLIC reads (admin panel reads unscoped).
//
// NOT SET HERE — deliberate, pending Jake's call:
//   • RTV_V2_EPOCH (V1↔V2 data cutoff) — see the cutover plan; needed because V1 and V2 both write net=4663 rows.
//   • DEV_SKIP stays OFF on a public mainnet build (it is staging-gated) — verify no chamber-skip is reachable before publish.
require('./server.js');
