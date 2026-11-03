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
require('./server.js');
