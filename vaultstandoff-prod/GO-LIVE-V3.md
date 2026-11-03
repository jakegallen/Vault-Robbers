# Vault Robbers / V3 (Vault Standoff) GO-LIVE RUNBOOK

Staged 2026-10-14. Fire these TWO steps at go-live (mint sell-out OR Halloween 2026-10-31 00:00 ET / 04:00 UTC).
Everything else (prod promotion, peg, auto-launch gate, security headers, the public landing, the domains) is ALREADY
live. Pre-launch, `/play/v3` intentionally points at the TESTNET twin so testers use fake money; these steps flip it
to the real mainnet Standoff and set the launch config.

NOTE: the hub's server-side `isV3Open()` (mint totalMinted>=max OR >= Halloween) already gates `/play/v3` (403 +
locked button) regardless of where it points. So even after step 1 the game stays locked to the public until that
condition is true. Steps 1+2 can therefore be run a little early if desired; they do not open the game.

## STEP 1 — point the hub's V3 at the PROD Standoff
Edit `vaultrobbers-mint/server.js` (and, if you want dev to mirror, `vaultrobbers-mint-dev/server.js`):
  `const STANDOFF_DIR = path.join(__dirname, '..', 'vaultstandoff-dev');`
  ->
  `const STANDOFF_DIR = path.join(__dirname, '..', 'vaultstandoff-prod');`
Then: `node --check server.js` and `restart_artifact("vaultrobbers-mint")`.
(The prod Standoff advertises its loopback port in `vaultstandoff-prod/.vs-port`, same mechanism as dev. It already
has the gateOk Bearer-bypass so the hub proxy reaches it without a second password.)

## STEP 2 — apply the launch config to the PROD Standoff
Prod Standoff admin API (its own token, NOT the play gate). From a host with VS_ADMIN_TOKEN + reachability:
  POST {STANDOFF_URL}/api/admin/config   header `x-vs-admin: $VS_ADMIN_TOKEN`   body:
  {
    "entryUsd": 10,              // $10 ticket, live-pegged to RVLT per round (peg already wired + promoted)
    "roundTarget": 50,           // 50 tickets per game
    "thresholdPct": 50,          // arms the fuse at 25 (50% of 50)
    "graceSec": 900,             // flat 15-min grace
    "graceFloorSec": 900,
    "maxTicketsPerWalletPct": 6, // = cap 3 at target 50 (on-chain maxTicketsPerWallet is 3)
    "streakFreezeAt": 0,         // anti-whale consecutive-win freeze OFF (Jake wants it off)
    "launchGate": 1              // show the client "opens Halloween / X/1000 minted" overlay until open
  }
  (launchAtMs already defaults to Halloween 2026-10-31T04:00:00Z. Holder $5 discount is already on-chain: holderDiscountBps 5000.)
Config applies at the NEXT round boundary. Verify via `GET /api/admin/metrics` (entry/roundTarget/launch reflect it).

## VERIFY after both steps
- `/play/v3` on vaultrobbers.com proxies the PROD Standoff; pre-open it still 403s / shows the locked button.
- At the trigger (sell-out or Halloween) isV3Open flips true -> V3 button becomes the live "Enter Vault Standoff" link.
- A real $10 round opens, settles, auto-pays winner minus 5% rake, rollover/void paths intact (V7 escrow).

## ROLLBACK
Set STANDOFF_DIR back to 'vaultstandoff-dev' + restart the hub; set launchGate 0 on prod Standoff if needed.
