// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ============================================================================================
//  RUN ONLY WHEN JAKE APPROVES. Requires the mainnet deployer key (DEPLOYER_PK, sealed env).
//  THIS SCRIPT DOES NOT EXECUTE THE UPGRADE. It ONLY deploys the V6 implementation contract.
//  The actual upgrade (upgradeToAndCall) + config are executed by the 2-of-2 Safe, NOT here.
//  It deploys NO proxy and calls NO initializer (the impl constructor runs _disableInitializers).
// ============================================================================================
//
//  Hard-guarded to Robinhood mainnet chainid 4663. Will revert on any other chain.
//
//  CONTEXT: the live proxy 0x6486...3EEA5 is currently on V1 (VERSION/relayer/holderNft revert).
//  All of V2..V6 storage is append-only, and the proxy has never run a round, so a straight
//  V1 -> V6 upgrade is layout-safe (every new slot is zero on this proxy).
//
//  USAGE (only after sign-off, with the sealed deployer key exported):
//    export DEPLOYER_PK=0x<mainnet deployer key>        # sealed env only, never in source/logs
//    forge script script/DeployMainnetV6Impl.s.sol:DeployMainnetV6Impl \
//      --rpc-url https://rpc.mainnet.chain.robinhood.com \
//      --broadcast --legacy
//
//  OUTPUT: prints the new V6 implementation address. Hand THAT to the Safe ceremony as `newImpl`
//  in upgradeToAndCall(newImpl, 0x). Then run the config calls (see GO-LIVE-V6.md). Do NOT point
//  the app at the impl; the app always uses the existing proxy.

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";

contract DeployMainnetV6Impl is Script {
    // The live mainnet proxy this implementation is intended to back. Informational only; this
    // script never touches it. The Safe performs the upgrade in a separate transaction.
    address constant MAINNET_PROXY = 0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5;
    // The ACTUAL on-chain owner()/upgrader of the proxy (read live 2026-10-12). This 2-of-2 Safe
    // is the ONLY authorized upgrader. NOTE: this differs from the stale address in the old V2
    // script; always trust the live owner() read. Verify before the ceremony with:
    //   cast call 0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5 "owner()(address)" --rpc-url <mainnet>
    address constant MAINNET_SAFE  = 0x3290f9cbF7bE7dEA11E7d482Ae0418b83E363665;

    function run() external returns (address implementation) {
        // HARD GUARD: mainnet only. Prevents an accidental testnet/other-chain broadcast.
        require(block.chainid == 4663, "MAINNET ONLY (expect Robinhood chainid 4663)");

        uint256 pk = vm.envUint("DEPLOYER_PK");

        // Deploy ONLY the implementation. No proxy, no initialize, no upgrade call.
        vm.startBroadcast(pk);
        StandoffEscrow impl = new StandoffEscrow();
        vm.stopBroadcast();

        implementation = address(impl);

        console2.log("=============================================================");
        console2.log("StandoffEscrow V6 IMPLEMENTATION deployed (NO proxy, NO init)");
        console2.log("  chainid            :", block.chainid);
        console2.log("  new implementation :", implementation);
        console2.log("  VERSION (constant) :", uint256(impl.VERSION()));
        console2.log("-------------------------------------------------------------");
        console2.log("NEXT (the Safe does these, NOT this script) - see GO-LIVE-V6.md:");
        console2.log("  proxy  :", MAINNET_PROXY);
        console2.log("  safe   :", MAINNET_SAFE);
        console2.log("  1) upgradeToAndCall(newImpl, 0x) with newImpl = the address above");
        console2.log("  2) setSigner / setRelayer / setMaxTicketsPerWallet(3) / setHolderNft / setHolderDiscountBps(5000) / setGuardian / setVoidGrace");
        console2.log("=============================================================");
    }
}
