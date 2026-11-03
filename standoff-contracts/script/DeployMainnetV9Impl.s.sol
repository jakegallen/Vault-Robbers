// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ============================================================================================
//  V9 IMPLEMENTATION DEPLOY. Requires the mainnet deployer key (DEPLOYER_PK, sealed env).
//  Deploys ONLY the V9 implementation contract. It does NOT execute the upgrade and touches no
//  funds. The 2-of-2 Safe performs upgradeToAndCall(newImpl, 0x) in a separate transaction.
//  The impl constructor runs _disableInitializers() so the logic contract cannot be initialized.
//
//  V9 delta vs V8: adds the RANDOM VAULT ROBBER AIRDROP. At payRake a configurable share OF THE
//  ALREADY-COMPUTED RAKE (robberShareBps) is routed to a randomly-drawn Vault Robber's ERC-6551
//  token-bound account; the remainder of the rake keeps flowing burn/treasury per the round's
//  burnShareSnap. The winner budget (pot - rake + jackpot) is UNCHANGED — the robber share comes
//  out of the rake, not the pot. The winning tokenId is drawn ON-CHAIN from the revealed settle
//  seed (domain-separated with the "robber" label), and the recipient is pure 6551 CREATE2 math
//  (no mint/ownerOf dependency), so an unminted/burned id can never revert settle/payRake.
//
//  Append-only storage: FOUR new slots — {robberNft, robberSupply, robberShareBps} packed (slot 18),
//  robberRegistry (slot 19), robberAccountImpl (slot 20), robberSalt (slot 21). __gap shrinks
//  uint256[35] -> uint256[31] so the layout end-slot (52) is UNCHANGED. (Round.seedRevealed is a
//  trailing struct member in a mapping, so it uses previously-unused per-key slots and does not
//  touch __gap.) INERT UNTIL CONFIGURED: until setRobberConfig is called the robber leg is skipped
//  entirely and the whole rake flows to treasury/burn exactly as in V8. V8 -> V9 upgrade is layout-safe.
//
//  USAGE (after sign-off, with the sealed deployer key exported):
//    export DEPLOYER_PK=0x<mainnet deployer key>        # sealed env only, never in source/logs
//    forge script script/DeployMainnetV9Impl.s.sol:DeployMainnetV9Impl \
//      --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --legacy
//
//  OUTPUT: prints the new V9 implementation address. Hand THAT to the Safe as newImpl in
//  upgradeToAndCall(newImpl, 0x). AFTER mint closes (final supply known), the Safe calls
//  setRobberConfig(nft, registry, accountImpl, salt, supply, shareBps) to arm the airdrop, and
//  setRake(600, burnShare) to raise the rake 5% -> 6% if desired.
// ============================================================================================

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";

contract DeployMainnetV9Impl is Script {
    address constant MAINNET_PROXY = 0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5;
    address constant MAINNET_SAFE  = 0x3290f9cbF7bE7dEA11E7d482Ae0418b83E363665;

    // Canonical ERC-6551 registry (same address on every EVM chain, confirmed live on Robinhood 4663).
    address constant ERC6551_REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    // Vault Robbers ERC721 (Robinhood Chain 4663).
    address constant ROBBER_NFT = 0xABC6c4F5d1F31326b419c2645C981743a845313a;

    function run() external returns (address implementation) {
        require(block.chainid == 4663, "MAINNET ONLY (expect Robinhood chainid 4663)");

        uint256 pk = vm.envUint("DEPLOYER_PK");

        vm.startBroadcast(pk);
        StandoffEscrow impl = new StandoffEscrow();
        vm.stopBroadcast();

        implementation = address(impl);

        console2.log("=============================================================");
        console2.log("StandoffEscrow V9 IMPLEMENTATION deployed (NO proxy, NO init)");
        console2.log("  chainid            :", block.chainid);
        console2.log("  new implementation :", implementation);
        console2.log("  VERSION (constant) :", uint256(impl.VERSION()));
        console2.log("-------------------------------------------------------------");
        console2.log("NEXT (the Safe does this, NOT this script):");
        console2.log("  proxy    :", MAINNET_PROXY);
        console2.log("  safe     :", MAINNET_SAFE);
        console2.log("  1) upgradeToAndCall(newImpl, 0x) with newImpl = the address above");
        console2.log("  2) AFTER mint closes, arm the airdrop with final supply:");
        console2.log("     setRobberConfig(nft, registry, accountImpl, salt, supply, shareBps)");
        console2.log("       nft        :", ROBBER_NFT);
        console2.log("       registry   :", ERC6551_REGISTRY);
        console2.log("       accountImpl: <the standardized 6551 account impl for 4663>");
        console2.log("       salt       : 0x0");
        console2.log("       supply     : <final minted N>");
        console2.log("       shareBps   : 10000 (FULL rake to one random robber - Jake 2026-10-22)");
        console2.log("  3) (optional) setRake(600, burnShare) to raise the rake 5% -> 6%");
        console2.log("  Until setRobberConfig is called the robber leg is INERT (V8 behaviour).");
        console2.log("=============================================================");
    }
}
