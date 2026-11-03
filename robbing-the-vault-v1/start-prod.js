// PUBLIC PROD launcher for Robbing the Vault (launch day, Mon Sep 7 2026).
// Same code + public/ as dev, pointed at the DEPLOYED mainnet contracts (Robinhood 4663) via RTV_NET=mainnet, AND ungated
// via RTV_PUBLIC=1 (server.js skips the DEV_SITE_PASSWORD door when this is set — see the gate middleware). Uses the mainnet
// OPERATOR_PK / ROBBERS_SIGNER_PK group secrets automatically (chain-gated in server.js). Publish with:
//   publish_artifact(name="robbing-the-vault", source_path="robbing-the-vault-dev", type="app", entry_point="node start-prod.js", is_public=true)
// The dev (test.*) + mainnet-test (dev.*) artifacts are untouched — they don't set RTV_PUBLIC, so their gate stays on.
process.env.RTV_NET = 'mainnet';
process.env.RTV_PUBLIC = '1';
// ODDS_V2 skill-driven model is the LAUNCH model (Jake 2026-09-04, Path B): deterministic skill ch1-5 + bot-proof gauntlet ch6-10,
// random door composition, post-cashout cooldown. Payout %s UNCHANGED (no contract change); protect the pot at launch via a
// RIGHT-SIZED RVLT seed (the shallow-cashout farm caps an uncapped pot ~50-100k). Big-pot + absolute caps = week-one contract upgrade.
process.env.RTV_ODDS_V2 = 'on';
// V2 CORE UPGRADE LIVE (Jake 2026-09-07): the RobbingTheVaultV2 impl is deployed + the Safe upgraded the proxy, so the core is
// now claimed via crackCore() (choose 100% ETH OR 100% pot, not both) + a 3-day per-wallet cooldown. The old settle(robbed) path
// now REVERTS on-chain, so this flag MUST be on to route core cracks to the choice screen + crackCore.
process.env.RTV_CORE_V2 = 'on';
require('./server.js');
