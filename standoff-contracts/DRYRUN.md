# Vault Standoff — testnet dry-run runbook (Robinhood 46630)

Validates the escrow MECHANICS end to end with a mock token: buy-in → settle → claim, plus the void → refund path.
The $10-any-currency Relay leg is NOT exercised here (Relay has no testnet); it gets a small real-money smoke test at
mainnet cutover. On testnet the game shows only the direct ROBINVAULT buy-in (the client auto-detects chain 46630).

## Live addresses (already wired in vaultstandoff-dev/.escrow.local.json, escrow = ON)
- Escrow (StandoffEscrow): `0x22B7AAC6dd09b6B97D7f330D123e4158640e1BeE`
- Mock RVLT (MockERC20 "mRVLT", open `mint`): `0xd493C5D56C3A4F6a71450091CD33BF3A9e5999C0`
- Chain: 46630 · RPC: `https://rpc.testnet.chain.robinhood.com`
- Entry: 1000 mRVLT / ticket (`1000000000000000000000`)
- Settlement signer: in `.escrow-signer.key` (git-excluded); the server settles rounds automatically.

## 0. Prereqs
- Foundry `cast` installed. A funded testnet deployer key (needs 46630 gas) to send the funding txs.
- 2–3 test wallets (their ADDRESSES) that will play. They each need: a little 46630 gas + some mRVLT.

```bash
export RPC=https://rpc.testnet.chain.robinhood.com
export FUNDER_PK=0x<your funded testnet key>        # pays gas for the mint/transfer txs below
export RVLT=0xd493C5D56C3A4F6a71450091CD33BF3A9e5999C0
export ESC=0x22B7AAC6dd09b6B97D7f330D123e4158640e1BeE
# your test players:
export P1=0x<test wallet 1>
export P2=0x<test wallet 2>
export P3=0x<test wallet 3>
```

## 1. Give each test wallet mock RVLT (10 tickets' worth = 10,000 mRVLT)
Open mint, so FUNDER just pays gas.
```bash
for P in $P1 $P2 $P3; do
  cast send $RVLT "mint(address,uint256)" $P 10000000000000000000000 --rpc-url $RPC --private-key $FUNDER_PK --legacy
done
```

## 2. Give each test wallet a little gas (skip any that already have 46630 ETH)
```bash
for P in $P1 $P2 $P3; do
  cast send $P --value 0.01ether --rpc-url $RPC --private-key $FUNDER_PK --legacy
done
```

## 3. Verify balances
```bash
for P in $P1 $P2 $P3; do
  echo "$P  mRVLT=$(cast call $RVLT 'balanceOf(address)(uint256)' $P --rpc-url $RPC)  gas=$(cast balance $P --rpc-url $RPC)"
done
```

## 4. Play (gated dev site)
1. Open the vaultstandoff-dev site (password-gated), connect each test wallet in its own browser/profile.
2. Make sure the wallet is on Robinhood testnet (the Network switcher adds/switches 46630 automatically).
3. During a dev-mode LOBBY, hit Buy in → it approves exactly `entry × tickets` mRVLT and calls `buyIn`. Repeat on 2–3 wallets.
4. Let the round run to the end. The server auto-`commit`s at lock and auto-`settle`s (equal split among on-chain winners) when it resolves.
5. Winner: after the 60s challenge window, the 💰 Winnings button `claim`s the pot. Confirm mRVLT lands.

## 5. Verify on-chain
```bash
# round state: entry, pot, rakeOwed, lockTime, deadline, claimAt, rakePaid, seedHash, status
cast call $ESC "rounds(uint256)(uint128,uint128,uint128,uint64,uint64,uint64,bool,bytes32,uint8)" <ROUND_ID> --rpc-url $RPC
# rake split to burn/treasury (anyone can call after the challenge window)
cast send $ESC "payRake(uint256)" <ROUND_ID> --rpc-url $RPC --private-key $FUNDER_PK --legacy
```
Round IDs are the game-start epoch seconds (shown in the escrow logs / state). Status enum: 0 None,1 Open,2 Committed,3 Settled,4 Void.

## 6. Void → refund path (liveness safety net)
Let a round pass its deadline WITHOUT settling (e.g. stop the server briefly after a buy-in). Then each participant
reclaims their entry:
```bash
cast send $ESC "refund(uint256)" <ROUND_ID> --rpc-url $RPC --private-key <PLAYER_PK> --legacy
```
(Or the server auto-voids when no real participant wins; then `refund` returns each entry.)

## What passing looks like
- buyIn pulls exactly `entry × tickets` mRVLT; pot grows by that each buy-in.
- settle records winShare for the winning on-chain address(es); claim pays pot − 5% rake after 60s.
- payRake sends 50% of the rake to burn, 50% to treasury.
- A voided/stale round refunds every participant their exact entry. No funds ever strand.

## Then: mainnet cutover (your keys, not scripted here)
Redeploy (or repoint) with owner = the 2-of-2 Safe, real RVLT, chain 4663; set `.escrow.local.json` chainId 4663 +
mainnet RPC + real RVLT; `transferOwnership` to the Safe; small real-$ Relay smoke test (pay $10 in ETH → RVLT → pot).
