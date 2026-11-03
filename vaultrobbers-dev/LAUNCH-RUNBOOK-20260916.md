# Robbing the Vault V2 — GO-LIVE RUNBOOK (target 2026-09-16 ~08:00 PT / 15:00 UTC)

Prepared 2026-09-15 by Build. Launch = repoint the PUBLIC game artifact onto the V2 source.
The V2 build (`vaultrobbers-dev`, start-prod-v2.js) is code-complete, tested, and running gated
on the twin (`robbing-the-vault-main`). The public artifact `robbing-the-vault` still serves the
OLD game (`robbing-the-vault-dev`, start-prod.js). Go-live swaps it.

## Pre-flight (all GREEN as of 2026-09-15)
- [x] Test suite 18/18 (`npm test` in vaultrobbers-dev)
- [x] Dev-skip OFF on public prod: `DEV_SKIP = V2 && !RTV_PUBLIC && !MAINNET` + `/api/dev/skip` unconditional 403 when RTV_PUBLIC=1
- [x] Client leak-free: /api/config exposes no odds/bar/human/tier; seed-not-answer intact; RTV_OBFUSCATE=1
- [x] dexAuth in LOG mode (never voids a human), decoupled from the sticky-role gate (which stays hard); DEX_AUTH_MIN=0.4
- [x] Loot epoch honored by all 6 public reads (players/tries/depth/recent/leaderboard/picks); RTV_V2_EPOCH set to 2026-09-16 15:00:00
- [x] Admin telemetry panel live (private, rtv-admin) — reads full history unscoped
- [x] DB checkpoint backup taken (.emblem_build/db-backup.sql, 23 tables)
- [x] Launch source boots clean (twin healthy; "error" badge = health probe hitting the password gate, clears when public)

## Dependencies that only Jake can do (launch morning)
1. BUY RVLT for the cash-out pot seed (from treasury 0xe8886fd4…ec8c).
2. SEED the pot via the rtv-admin deposit console (or transfer to vault), so the pot shows a real value.
3. Confirm the multisig owner set (2-of-2) is correct for core-crack payout review.

## Go-live steps (in order, ~08:00 PT)
1. FINAL SANITY on the twin: play one paid run end to end on robbing-the-vault-main; confirm cash-out settles.
2. (Optional) update the epoch to the exact flip minute in start-prod-v2.js if not launching at 15:00 UTC.
3. RESET the public hero counters (one row, NOT a data delete — history/research all preserved):
   `UPDATE rtv_state SET burned_rvlt=0, plays=0, robs=0 WHERE id='main';`  (via db_execute; jackpot_eth reads from chain, pot_rvlt set by the seed)
4. FLIP the public artifact onto the V2 source (THE launch command):
   `publish_artifact(name="robbing-the-vault", source_path="vaultrobbers-dev", type="app", entry_point="node start-prod-v2.js", is_public=true)`
5. VERIFY: list_artifacts shows robbing-the-vault active; open https://build-…/pub/main/robbing-the-vault/ (and robbingthevault.com) — landing loads, a run is payable, no password gate, no skip UI, loot board clean.
6. FLIP the public loot page V2 live (task #169) + confirm it reads post-epoch data only.
7. WATCH: rtv-admin (approvals + bot watch + telemetry) + the drain circuit-breaker for the first hours.

## Rollback (if anything is wrong post-flip)
- Repoint back to the old game instantly:
  `publish_artifact(name="robbing-the-vault", source_path="robbing-the-vault-dev", type="app", entry_point="node start-prod.js", is_public=true)`
- Or pause via the admin circuit-breaker (`POST /api/admin/breaker {action:'pause'}`) to halt payouts without unpublishing.
- Restore DB from .emblem_build/db-backup.sql if a bad write occurs.

## Post-launch (first week)
- Keep dexAuth in LOG; tune DEX_AUTH_MIN and flip to enforce only after real human traces confirm zero false-positives.
- Re-enable Practice Arena in a week or two if nobody wins (RTV_HIDE_PRACTICE=0).
- Task #184 dead-code cleanup; #177 deep-dexterity playtest tuning.
