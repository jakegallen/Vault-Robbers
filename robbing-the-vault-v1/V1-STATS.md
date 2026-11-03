# Robbing the Vault — V1 Final Statistics (RETIRED)

**Status:** V1 permanently retired 2026-09-15. Source locked away, never to be republished
(pre-hardening leaky engine — security risk). The domain `v1.robbingthevault.com` is left
unpointed. Full restorable data dump lives beside this file at `.emblem_build/db-backup.sql`
(3366 rows). The live source of truth remains the `rtv_*_v1archive` tables in the group DB,
which the V2 game never touches.

## Run record (rtv_runs_v1archive — authoritative)
- **Total runs:** 1,918
- **Unique players:** 108
- **Live window:** 2026-09-07 14:44 → 2026-09-13 21:27 UTC (~6.3 days)
- **Core cracks (rob):** 1
- **Busts:** 1,831
- **RVLT won (paid out):** 3,135,448
- **RVLT burned (entry fees):** 945,500
- **ETH robbed:** 13.095496
- **Avg depth reached:** 2.68 chambers
- **Max depth:** 10 (the single core crack)

## Depth distribution (where runs ended)
| Depth | Runs |
|------:|-----:|
| 0 | 289 |
| 1 | 273 |
| 2 | 281 |
| 3 | 377 |
| 4 | 343 |
| 5 | 325 |
| 6 | 29 |
| 10 | 1 |

Note the difficulty cliff at chamber 6 (325 → 29): V1's deep tail was extremely rare, and
exactly one player reached and cracked the core (depth 10).

## State snapshot (rtv_state_v1archive, as of 2026-09-14 03:13 UTC)
- jackpot_eth: 12.8218
- pot_rvlt: 13,000
- burned_rvlt: 372,500
- seeded_rvlt: 50,000
- plays: 112 · robs: 1

(The state row is a point-in-time mirror; the run-table sums above are the full-history totals.)

## Other archived tables
- Visits: 1,424 · Door-picks: 10 categories · Arcade passes: 13

## Restore (if ever needed)
The dump is plain SQL (`CREATE TABLE IF NOT EXISTS` + `INSERT`). Apply it to any RVLT group DB
to recreate the `rtv_*_v1archive` tables verbatim. It only touches the archive tables, never
the live V2 tables.
