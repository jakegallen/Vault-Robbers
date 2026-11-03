# Vault Standoff — Relay-Funnel Canary Log (started 2026-10-13)

Goal: prove the real-user funding funnel (pay any origin asset -> Relay swaps to exact RVLT on Robinhood 4663 -> buy into a round -> play -> win/auto-payout). Driven by Claude across 3 throwaway wallets, authorized by Jake.

## Wallets (throwaway, keys in main secrets CANARY_PK_1/2/3 + CANARY_PK_1_SOL)
- W1 EVM: 0x7d801B10C02272bb4be8aD64aA456456C5aa8AdC  (Robinhood gas 0.01)
- W1 SOL: 2Tb9NoNFz7vjhntEyTiEcyjigWMh7anHFdV9Pegcn5xP  (0.20 SOL)
- W2 EVM: 0xE6bdAbcb89beB6ba4810d1F31099747de8Ea77Ac  (Robinhood gas 0.02; no source funds)
- W3 EVM: 0x9c925E714B1F63C6A0c9AdE9dc172fb3236d012D  (ETH-mainnet 0.01 ETH + 20 USDC; Robinhood gas 0.01)

## Funded routes to test FIRST (this pass)
- USDC mainnet -> RVLT (W3)
- ETH mainnet -> RVLT (W3)
- SOL -> RVLT (W1 sol -> W1 evm recipient on Robinhood)
NOT funded (later): Base, BNB, USDC-on-Robinhood.

## Relay quote validation (read-only, 2026-10-13) — target 5000 RVLT (~$1.085) EXACT_OUTPUT
- USDC-mainnet: 1.225 USDC in -> 5000 RVLT out. steps: approve, deposit. fees ~$0.13 gas + $0.08 relayer. ROUTE OK.
- ETH-mainnet : 0.000476 ETH in -> 5000 RVLT out. steps: deposit. fees ~$0.056 gas + $0.055 relayer. ROUTE OK.
- SOL         : 0.01138 SOL in -> 5000 RVLT out. steps: deposit. fees ~$0.00004 gas + $0.084 relayer. ROUTE OK.
=> Relay routes all three origins to RVLT on 4663. Core funnel proven at the quote layer.

## FINDINGS / FIXES
- F1: game /api/relay/quote proxy (server.js ~1610) only accepted a 0x EVM originCurrency, so a SOLANA origin was
  REJECTED by the funnel even though Relay supports it. FIX: extended the proxy to accept a base58 Solana origin
  (user + originCurrency) when originChainId is the Relay Solana id (792703809); recipient + destination stay pinned
  to an EVM address + RVLT on 4663. [applied 2026-10-13]
- Canary pricing: lowered the baked entry to 5000 RVLT (~$1.07) + roundTarget 3 for affordable solo multi-wallet
  rounds. RESTORE to 46584 RVLT (~$10) + launch roundTarget before public flip.

## EXECUTION (tx hashes logged as each route runs)
- [ ] USDC-mainnet route: approve+deposit tx, Relay requestId, RVLT landed on W3, buyIn tx, round result
- [ ] ETH-mainnet route: deposit tx, requestId, RVLT landed, buyIn, result
- [ ] SOL route: deposit tx, requestId, RVLT landed on W1-evm, buyIn, result
- [ ] win -> auto-payout after 5-min window (tx)
- [ ] rollover (pot->jackpot->next win) if reproducible with 3 wallets
- [ ] range deposit (1 sig) + voidRolledOver spot-check

## RESULTS (2026-10-13, mainnet canary)
EXECUTED end-to-end (swap -> RVLT -> buyIn -> round -> settle -> auto-payout):
- ETH/Ethereum: 0.000482 ETH -> 5318 RVLT | origin 182.1s, bridge 3.2s, total 185.3s | tx 0x54ab75…
- USDC/Ethereum: 1.233 USDC (approve exact) -> 5322 RVLT | origin 73.5s, bridge 3.1s, total 76.7s
- SOL/Solana: 0.0115 SOL -> 5318 RVLT | solana-confirm 0.5s, bridge 3.0s, total 3.5s (FASTEST)
QUOTE-VALIDATED (route+economics OK, not yet funded): ETH/Base, ETH/Robinhood(same-chain SWAP), BNB, USDC/Base, USDC/BNB, USDC/Solana(no approve).
PENDING: USDC/Robinhood (need RH USDC token address).
NATIVE: ROBINVAULT direct (approve+buyIn, no Relay) proven via the canary buy-ins.
ROUND 11 SETTLED: 2 players, pot 10000 RVLT, rake 500 (5%), winner W1 auto-paid 9500 RVLT (settled=true), jackpot 0. Economics exact.
KEY: Relay bridge ~3s constant; all variance = origin-chain confirmation (ETH L1 slowest). Add EVM priority fees. Instr data for Solana is HEX. SOL-origin proxy gap fixed. On-chain-only buy funds pot but needs SIWE session to seat (void-refund safety net).
FULL MATRIX + UI loading-label spec: artifact /pub/main/vaultstandoff-relay-matrix/
PARKED (self-recovers at round deadline via void-refund): W3 has 5000 RVLT in round 12 (stray seat); ~$1, refundable.

## ROUND 2 (2026-10-13 PM) — Jake funded Base/BNB + USDT/BNB + USDG/RH
Funding: W1 9818 RVLT; W2 0.0285 BNB + 21.16 USDT(BNB) + RH gas; W3 0.0084 BaseETH + 0.0095 ETH + 21.2 USDC(base) + 18.8 USDC(eth) + 103k RVLT.
ALL 5 newly-funded routes EXECUTED on real tx (api/relay/quote, EXACT_OUTPUT 5100 RVLT, delivered ~5318 each):
- ETH/Base:   0.000482 ETH -> 5318 RVLT | origin 4.5s, bridge 3.1s, TOTAL 7.6s | 1 deposit, native
- USDC/Base:  1.2346 USDC (approve EXACT) -> 5318 | origin 8.9s, bridge 3.1s, TOTAL 12.0s
- BNB native: 0.001637 BNB -> 5318 | origin 4.5s, bridge 3.0s, TOTAL 7.5s
- USDT/BNB:   1.2359 USDT (18-dec, approve EXACT) -> 5315 | origin 8.7s, bridge 3.2s, TOTAL 11.8s  [NEW]
- USDG/RH:    1.1576 USDG (6-dec canonical, approve EXACT, same-chain `swap`) -> 5318 | origin 9.4s, settle 3.3s, TOTAL 12.7s  [NEW]
INTEGRATION re-proven: entry-quote preflight -> on-chain buyIn (W1+W3 into round 14) -> pot 10000 RVLT (2-player, Open, auto-settles via grace+keeper).
SECURITY: TWO tokens on RH both symbol "USDG" — 6-dec 0x5fc5360d0400a0fd4f2af552add042d716f1d168 (REAL, Relay-routable) vs 18-dec 0xbf6295d125b61178ab182bb63875b7fc2d607a70 (SPAM, flat 10.0 airdropped to multiple wallets). Pinned the 6-dec; NEVER wired the spam twin.
NOT executed (no origin funds; sibling asset proven on that chain): USDC/BNB (USDT/BNB proven), USDC/Solana (SOL/Solana proven). USDC/Robinhood -> N/A (USDG is the RH stablecoin, proven).
KEY: every route bridge/settle ~3s constant; Base + BNB confirm ~4.5s (fast lane). ETH-mainnet L1 the only slow origin.
IMPROVEMENT shipped to prod client (public/index.html): wired USDT (eth/bnb/polygon/arb) + USDG (RH same-chain, pinned 6-dec) + USDC@BNB into the pay-with funnel; native pay chip shows the connected chain's real symbol (BNB/POL/ETH); approve stage label generalized to any stablecoin. Syntax-checked + render-verified through the gate. All approvals EXACT, never unlimited.

## ROUND 3 (2026-10-13 late) — USDC/Solana + USDC/BNB (last 2 cells)
Jake funded USDC on Solana (W1-sol 2Tb9…, 21.31) + USDC on BNB (W2, 24.65). BOTH EXECUTED:
- USDC/BNB:    1.238 USDC (18-dec, approve EXACT) -> 5318 RVLT | origin 8.7s, bridge 3.1s, TOTAL 11.7s
- USDC/Solana: 1.2352 USDC -> 5314 RVLT | origin 1.7s, bridge 3.3s, TOTAL 5.0s | tx 3aznf4…
=> ALL 11 practical matrix cells now executed on real tx.
## ROUND 4 (2026-10-13 late) — DAI + USD1 + efficiency pass
- DAI/Ethereum: 1.213 DAI (approve EXACT) -> 5318 RVLT | origin 37.5s (L1 default gas), bridge 3.1s, TOTAL 40.5s. EXECUTED. DAI wired into the game pay picker.
- USD1/Solana (Jake's "USDC1", World Liberty USD1 mint USD1ttGY…): Relay returns NO_SWAP_ROUTES_FOUND — no route to RVLT (too new/illiquid). NOT wired. (Also a stray mint 3o4Js… bal 5 on the sol wallet = likely spam, ignored.)
- BTC: game relay proxy now accepts BTC origin (chain 8253038) + reaches Relay (placeholder addr hit Relay's wallet-screen, not a route error); connector has the deposit-address branch. Awaiting real BTC in a wallet to execute (LAST test).
- EFFICIENCY SUGGESTIONS IMPLEMENTED: (1) EVM priority fees — connector _evmFeeParams() attaches EIP-1559 (base*2 + tip, min 1.5 gwei, +25%) to every relay EVM send, try/catch fallback; (2) over-delivery surfaced — game success line now shows RVLT change kept; (3)/(4) fast-origin expectation + no-bridging-animation = the per-chain loading labels; (5) seat-on-buy = already handled (re-SIWE re-seats); (6) same-chain swap + Solana instructions = handled in connector. All syntax-checked.
- MINT NOTE: vaultrobbers-mint uses DYNAMIC asset auto-detect (connector detectAssets), NOT a curated list, so it already offers any routable asset the user holds (DAI/USDT/BTC/Solana) — no server asset-list edit needed.

PROD BUG FOUND + FIXED: Relay returns Solana steps as raw `instructions`+`addressLookupTableAddresses` (NOT a serialized tx) for BOTH native SOL and SPL tokens. The connector's sol branch only read d.transaction, so the in-app SOL pay option silently did nothing (failed safe: no tx, no funds lost, relay poll times out). FIX: added signAndSendSolIx() in the connector (assembles a v0 tx from instructions+ALTs, wallet signs+sends) + server /api/sol-rpc proxy (whitelisted read methods only: getLatestBlockhash/getMultipleAccounts/getAccountInfo/getSignatureStatuses/getAddressLookupTable/getFeeForMessage/getSlot; sendTransaction BLOCKED; gated+rate-limited). Proxy smoke-tested (blockhash 200, sendTransaction 400). Phantom v0-sign leg still needs a real-wallet smoke test (can't headless). ALT-assembly + send proven with a raw keypair.
