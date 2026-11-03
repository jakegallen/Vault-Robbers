# Robbing the Vault — LAUNCH DAY runbook (Mon Sep 7 2026, 10:00 AM ET)

Single source of truth for go-live. Everything below is STAGED and dev-verified; nothing here has been executed on prod.
Keep the game dev-gated until launch. Chain: Robinhood mainnet 4663 · RPC https://rpc.mainnet.chain.robinhood.com · Explorer https://robinhoodchain.blockscout.com

## Addresses / roles
- Game vault (RobbingTheVault, UUPS proxy): `0x254DBcB680ECdF534eC0Dafb7aC476Bc768C77C1`  — owner = **Safe 2-of-2** `0x2aA3936C0312f3604982B2504BeE7ad8c88e9397`
- Vault Robbers (ERC721C): `0x0741A47CE1A25419335dD4a39059Ec63Ba336f69`  — owner = **deployer EOA** `0x8444149B8E5eD771607452FB133d8803A3F02D0e` (direct owner calls via admin.html, NOT the Safe)
- ROBINVAULT token: `0x77061b45c5e4d440bd681b5f72bd0f4231a6fc04`
- Treasury (royalty + team reserve): `0x96bcfdb15b65245F5B9796C7A0587b3649f52432`
- Mint sink (RVLT proceeds): `0xe8886FD4863855884D5F1FFfA38F8C1c8502Ec8c`
- Operator (settle signer, group secret OPERATOR_PK): `0x90DE561c63192AdcA8e5b81Bd9caa8ff8D95b3c5`
- Robbers voucher signer (group secret ROBBERS_SIGNER_PK): `0xa6b827aB57907f394704c08a17F737C1da3417C9`

## Current on-chain state (verified 2026-09-03)
- Game vault: fee 1000e18, burn 50%, cashoutMin 5, gameEnd 1793462400 (2026-10-31 12:00 ET), paused false, ETH 0.005 (test), pot seeded (test).
- **Ladder: stage5 = 2% (200 bps) — DONE on-chain** (6/10/20/35/60/core100); server POT_LADDER matches.
- Vault Robbers: MAX_SUPPLY 1000, reserveMinted 0, mintActive **TRUE**, royalty 0x96bc @ 2%.
- ROBINVAULT burned to date ~457.76M (loot page reads it live: 1e9 − totalSupply + dead-balance).

## 1. Publish the PROD game artifact (engineering)
Prod uses `start-prod.js` (STAGED) which sets RTV_NET=mainnet + RTV_PUBLIC=1 → mainnet contracts + no dev-gate (server.js skips the DEV_SITE_PASSWORD door only when RTV_PUBLIC=1). Dev (test.*) and mainnet-test (dev.*) are untouched — they don't set RTV_PUBLIC, so their gate stays on.
```
publish_artifact(name="robbing-the-vault", source_path="robbing-the-vault-dev", type="app", entry_point="node start-prod.js", is_public=true)
```
Verify: list_artifacts active; open URL → loads with NO password door; /api/onchain/config → chainId 4663. OPERATOR_PK / ROBBERS_SIGNER_PK inject as group secrets (chain-gated so they only sign on mainnet).

## 2. Domain
Point the public play domain (robbingthevault.com or a play. subdomain — Jake to confirm) at the `robbing-the-vault` artifact via connect_custom_domain.

## 3. Vault Robbers owner txs — DIRECT from 0x8444 via dev.robbingthevault.com/admin.html (NOT the Safe)
- **reserveMint(treasury, 25) x4 = 100** to `0x96bc…2432` (25/batch; 100-at-once risks gas since each mint opens a Loot Bag SAC). admin.html reserve card does this; confirm reserveMinted → 100.
  raw calldata (to 0x0741…6f69): `0xb0ea180200000000000000000000000096bcfdb15b65245f5b9796c7a0587b3649f524320000000000000000000000000000000000000000000000000000000000000019`
- mintActive already TRUE. If toggled off pre-launch, re-enable at go-time.
  setMintActive(true): `0xee1cc9440000000000000000000000000000000000000000000000000000000000000001`
  setMintActive(false): `0xee1cc9440000000000000000000000000000000000000000000000000000000000000000`
- **LOCK** the admin reserve-destination field read-only right before mint day (add `readonly` to `<input id="resTo">` + hardcode 0x96bc) so the 100 reserve can't be misdirected.

## 4. Fund the pools (from admin.html / wallet)
- **ROBINVAULT pot:** seed 2,000,000 via seedPot (admin: approve → Seed the pot), top up over time. At 1000 buy-in / 2% stage-5 it distributes over the opening runs and settles ~49k floor.
- **ETH jackpot:** send ETH DIRECT to the game vault `0x254D…77C1` (receive() credits vaultEth) to a real launch amount. ETH is the headline prize.

## 5. Game vault Safe txs (2-of-2 `0x2aA3…9397`) — fee ramp (later, not launch-critical)
Raw custom tx → To `0x254DBcB680ECdF534eC0Dafb7aC476Bc768C77C1`, value 0:
- setFee 2000e18: `0x69fe0e2d00000000000000000000000000000000000000000000006c6b935b8bbd400000`
- setFee 2500e18: `0x69fe0e2d0000000000000000000000000000000000000000000000878678326eac900000`
- setLadder(5,200) [already executed]: `0x8b78bde9000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000c8`
- drain(to) is gameEnd-gated (Oct 31); pause() first + let in-flight runs settle.

## 6. Verify + safety
- Run the mini-game QA harness before promoting: `node robbing-the-vault-dev/tools/qa-minigames.mjs` (B=base, P=DEV_SITE_PASSWORD for gated dev/test; public prod needs no gate). Expect 135/135 ALL CLEAR.
- Real-phone playthrough of the timing games (dial/reflex/tumbler/stopwatch/torque/lasers) — touch/latency sensitivity can't be desktop-tested.
- Rollback: Safe `pause()` halts entries/settles; `unpause()` to resume.

## Post-launch fast-follows
- Pyth/Quiver on-chain VRF as a UUPS upgrade (provider not operational on 4663 yet).
- Vault Robbers "no-winner hedge" (split ETH to holders if uncracked at gameEnd).
- Endgame odds ramp in the final ~14 days + power-ups (skill-boost, checkpoint, pity) to lift the ~1-in-34M organic win rate.
- Blockscout/Robinscan source verification of the game vault (web UI; CLI is Cloudflare-blocked).
