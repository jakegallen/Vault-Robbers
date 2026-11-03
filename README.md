# Vault Robbers

Open-source source release of the Vault Robbers / Robbing the Vault ecosystem — an
on-chain, push-your-luck heist game and arcade built around the RVLT token, plus the
Vault Standoff PvP game, the NFT mint/reveal flow, and the generative art pipeline.

Released under the MIT License (see `LICENSE`) — free to use, fork, and build on.

## Layout

| Directory | What it is |
|-----------|------------|
| `robbing-the-vault-v1/` | Original V1 heist game server + client |
| `vaultrobbers/`, `vaultrobbers-dev/` | V2 game (chambers, casino rooms, skill/perception engines), prod + dev |
| `vaultstandoff-prod/`, `vaultstandoff-dev/` | Vault Standoff PvP escrow game, prod + dev |
| `vaultrobbers-mint/`, `vaultrobbers-mint-dev/` | NFT mint flow |
| `vaultrobbers-reveal/` | NFT reveal / metadata freeze pipeline |
| `vaultrobbers-studio/` | Generative art pipeline (layers + authoring scripts) |
| `vault-robbers-gallery/` | Collection gallery |
| `rtv-contracts/`, `standoff-contracts/` | Solidity contracts (Foundry) |

## Running

Each app is a Node server (`server.js`) that reads configuration from environment
variables — see `.env.example` for the full list of names. **No secrets, keys, or
credentials are included in this repository**; every server reads them from `process.env`
at runtime. You must supply your own RPC endpoints, API keys, and signer configuration.

Contracts use [Foundry](https://book.getfoundry.sh/) (`forge build` / `forge test`).

## Security note

This was a live, money-handling game. If you deploy it, the integrity of funds relies on
your own on-chain contracts and server-authoritative logic + your own secrets — never on
the privacy of this source. Review the contracts and the escrow/relayer flow before
putting real value behind it.
