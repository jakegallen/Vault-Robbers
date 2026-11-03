// V2 FREE-PLAY — free-to-play, no-chain version of Robbing the Vault V2 (Jake 2026-09-20, retirement pivot).
// Boots the V2 build (vaultrobbers-dev source, same code + public/ as the public game) on TESTNET (chainId 46630),
// so OC.chainId !== 4663 -> ONCHAIN_ONLY is false -> the OFF-CHAIN "chips" money path (/api/enter + /api/cashout,
// DB-only, no token) is enabled = ALL FEES WAIVED, no wallet needed, no burns, no cashouts, ZERO mainnet exposure
// (the real 4663 vault/pot/keys are never touched). Ungated via RTV_PUBLIC=1. Full V2 experience (all chambers,
// 60 mini-games, casino rooms, stats page) minus the on-chain economy. Free-play rows are net-scoped to 46630 so
// they never mix with the historical mainnet (4663) stats.
process.env.RTV_PUBLIC = '1';
// Match V2 launch odds/skill model exactly.
process.env.RTV_ODDS_V2 = 'on';
// Cut the Vault Robber NFT mint on free-play (removes the discounted-mint Sybil vector; nostalgia/testing ground only).
process.env.RTV_NO_MINT = '1';
// Deliberately NOT set: RTV_NET (stays testnet -> off-chain demo path), RTV_ONCHAIN_ONLY (would disable free play),
// RTV_MINT_SPOTS. Mainnet-only contract paths resolve off-chain in free mode.
require('./server.js');
