# Vault Robbers

The complete, open-source archive of **Vault Robbers / Robbing the Vault** — a push-your-luck
heist game that ran on Robinhood Chain across two seasons, its 1,000-piece masked NFT crew,
the ROBINVAULT token, and the Vault Standoff finale.

The game is retired. Rather than let it disappear when a server bill goes unpaid, the whole
thing is opened here, free, forever, under the MIT License (see `LICENSE`). Play it, study it,
fork it, rebuild it.

Play the free version at **[vaultrobbers.com](https://vaultrobbers.com)**.

## The games are detached from the money

Every game in this repository has been **detached from the on-chain economy**. There is no
token to buy, no entry fee, no wallet, no pot, and nothing to win or lose but the run itself.
The free builds boot straight into play:

- **V1 / V2** (`robbing-the-vault-v1/`, `vaultrobbers-dev/`) run in free mode via their
  `start-v1free.js` / `start-v2free.js` entry points (`RTV_FREE_ONLY=1`): off-chain "chips",
  no wallet, no real value, testnet-only so the live token and pot are never touched.
- **V3 Vault Standoff** (`vaultstandoff-dev/`) runs via `start-v3free.js` (`VS_FREE_ONLY=1`):
  the self-contained, client-side practice heist — a free solo run against an AI crew, no
  escrow, no wallet, no live round.

The original real-money server code is preserved alongside it for the historical record, but
the hosted site only ever runs the free builds.

## The contracts are kept for the record

The Solidity contracts (`rtv-contracts/`, `standoff-contracts/`) are included **as historical
reference only**. They are not deployed or wired to anything in this archive. They are here so
anyone who wants to review how the game worked on-chain, learn from it, or rebuild something
like it in the future can do exactly that.

## Layout

| Directory | What it is |
|-----------|------------|
| `robbing-the-vault-v1/` | V1, the original heist (free build: `start-v1free.js`) |
| `vaultrobbers/`, `vaultrobbers-dev/` | V2, the vault reborn: chambers, casino rooms, skill/perception engines (free build: `start-v2free.js`) |
| `vaultstandoff-prod/`, `vaultstandoff-dev/` | Vault Standoff (V3); the free build is the solo-vs-AI practice heist (`start-v3free.js`) |
| `vaultrobbers-mint/`, `vaultrobbers-mint-dev/` | The vaultrobbers.com site + NFT mint flow (on-chain stats are now frozen to their final values) |
| `vaultrobbers-reveal/` | NFT reveal / metadata + generative art server |
| `vaultrobbers-studio/` | Generative art pipeline (layers + authoring scripts) |
| `vault-robbers-gallery/` | Collection gallery |
| `rtv-contracts/`, `standoff-contracts/` | Solidity contracts (Foundry) — historical reference, not deployed |

## Running it yourself

Each app is a Node server (`node start-*free.js` for the free builds, or `node server.js`).
Install with `npm install` in the app directory, then start it; it listens on `process.env.PORT`.
Contracts use [Foundry](https://book.getfoundry.sh/) (`forge build` / `forge test`).

**No secrets, keys, credentials, private keys, seed phrases, passwords, or personal data are
included in this repository.** Every server reads its configuration from environment variables
at runtime; `.env.example` lists the variable *names* only (no values). The free builds need no
secrets at all.

## The honest part

The token is quiet and the crowd has moved on. That is just the end of a season. What the game
got right was never the pot — it was the play: a server-authoritative skill engine so you could
not cheat the outcome, a seed-not-answer design so it never leaked the solution, provably-fair
commit-reveal, and roughly sixty mini-games tuned so a bot could not farm them and a human could
still win. All of it is here to keep.

The vault is sealed. The doors are unlocked. Go play.

— Jake

*MIT Licensed. Built on Robinhood Chain. Powered by Emblem.*
