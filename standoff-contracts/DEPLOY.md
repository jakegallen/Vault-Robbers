# StandoffEscrow, deploy + wire guide

Contract: `src/StandoffEscrow.sol` (Option D: on-chain money, off-chain agent-proof engine). Tests: `forge test` (11/11).

## 1. Deploy to Robinhood TESTNET (46630) first
Never hardcode keys. Export env, then run the script.

```bash
cd standoff-contracts

# --- who/what ---
export DEPLOYER_PK=0x<funded testnet deployer key>       # needs testnet gas
export RVLT_TOKEN=0x<test token>                          # deploy a MockERC20 on testnet, or reuse one
export ESCROW_OWNER=0x<owner>                             # testnet: the deployer is fine; MAINNET: the 2-of-2 Safe
export ESCROW_SIGNER=0x<settlement hot-key ADDRESS>       # the address of VS_ESCROW_SIGNER_PK below
export ESCROW_TREASURY=0x<treasury>
export ESCROW_BURN=0x<burn sink>                          # e.g. 0x...dead or the deployer
# optional (defaults shown): ESCROW_RAKE_BPS=500  ESCROW_BURN_SHARE_BPS=5000  ESCROW_CHALLENGE=60

forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.testnet.chain.robinhood.com \
  --broadcast --legacy
# prints "StandoffEscrow: 0x...."
```

A throwaway test token: `forge create test/MockERC20.sol:MockERC20 --rpc-url <testnet> --private-key $DEPLOYER_PK`, then `mint(addr, amount)` to your test wallets and `approve` the escrow.

## 2. Wire the game (vaultstandoff-dev) to the deployed contract
Set these env vars on the artifact, then restart it. Real-money rounds only run on a CLOCK cadence (dev/demo/daily), where lock/deadline map cleanly on-chain. The `fill` (demand) preview stays fake-chips.

```
VS_ESCROW=on
VS_ESCROW_ADDR=0x<deployed escrow>
VS_ESCROW_SIGNER_PK=0x<settlement hot key>     # matches ESCROW_SIGNER; env only, never in source
VS_RPC=https://rpc.testnet.chain.robinhood.com # mainnet RPC at cutover
VS_CHAINID=46630                               # 4663 at cutover
VS_RVLT=0x<test token>                         # real RVLT at cutover
VS_ENTRY_WEI=<entry per ticket in base units>  # e.g. 1000e18 = 1000000000000000000000
VS_MODE=daily                                  # or dev/demo; a clock engine, not fill
```

Lifecycle the server drives automatically (all guarded, fire-and-forget, idempotent):
- lobby opens -> `openRound(gameStart, entry, chooseStart[0], gameEnd+1h)`
- buy-in cutoff (first choose) -> `commit(id, keccak(seed))`
- game ends -> `settle(id, seed, winners[], amounts[])` split equally among the winning on-chain participants, OR `voidRound(id)` if no real participant won (pot refunds).

Still to add for a full player loop (next, against the live testnet contract): the client "Buy in on-chain" button (calls `buyIn` during the lobby via the wallet), and a claim/refund button reading `/api/escrow/config`.

## 3. Playtest on testnet
Fund 2-3 test wallets, buy in during a daily/dev lobby, let a round resolve, confirm the winner can `claim()` after the challenge window and `payRake()` splits burn/treasury. Test the void path (skip settlement past deadline -> `refund()`).

## 4. Mainnet cutover (4663)
Redeploy with `ESCROW_OWNER` = the 2-of-2 Safe, `RVLT_TOKEN` = real ROBINVAULT, then set the game env to mainnet RPC/chainId/RVLT and the final `VS_ENTRY_WEI`. Confirm `owner()` = Safe. Keep the settlement key hot but rotatable via the Safe (`setSigner`).
