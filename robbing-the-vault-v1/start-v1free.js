// V1 CLASSIC — free-to-play, frozen replica of the original Robbing the Vault (Jake 2026-09-09).
// This is a FROZEN self-contained copy of the launch V1 build (robbing-the-vault-dev @ 2026-09-09). It runs on TESTNET, so
// OC.chainId !== 4663 → ONCHAIN_ONLY is false → the OFF-CHAIN demo money path (/api/enter + /api/cashout, DB-only "chips") is
// enabled = ALL FEES WAIVED, free for anyone, no wallet needed, and ZERO mainnet exposure (server uses the testnet deployer key,
// never OPERATOR_PK / the real mainnet vault or pot). Ungated via RTV_PUBLIC=1. Same code + public/ as the launch build, so it is
// an exact playable replica, locked as the "classic" version + a free testing ground. Bound to v1.robbingthevault.com.
// PROD (robbingthevault.com, robbing-the-vault / robbing-the-vault-dev) is completely untouched.
process.env.RTV_NET = 'testnet';
process.env.RTV_PUBLIC = '1';
// V1 launch odds model (matches start-prod's RTV_ODDS_V2) so gameplay + odds mirror the original exactly.
process.env.RTV_ODDS_V2 = 'on';
// RTV_CORE_V2 deliberately NOT set: the on-chain V2 core-claim (crackCore) is a mainnet-only contract path; in free demo mode the
// core resolves off-chain, so leaving it off avoids any testnet contract-version mismatch. RTV_ONCHAIN_ONLY deliberately NOT set
// (that would disable the free demo path). RTV_MINT_SPOTS left off — no on-chain Vault Robber mint on the free classic.
// SECURITY (Jake 2026-09-09): the Vault Robber mint is fully CUT on the classic — no voucher signing, no mint UI. The classic is a
// nostalgia/testing ground only; NFT minting (and its discounted-mint Sybil vector that fed the V1 swarm) does not exist here.
process.env.RTV_NO_MINT = '1';
// RETIREMENT (Jake 2026-11-10): free, wallet-free archive. RTV_FREE_ONLY makes /api/config report freeOnly:true, which tells the
// client to null window.RTV_OC (disabling every on-chain guard at once) and hide the wallet chrome, so the game plays purely on the
// off-chain demo chips path with no connect/sign prompt ever. Money builds (start-prod / start-mainnet) never set this flag, so they
// are byte-for-byte unchanged. Gated entirely behind the flag; default behaviour is untouched.
process.env.RTV_FREE_ONLY = '1';
require('./server.js');
