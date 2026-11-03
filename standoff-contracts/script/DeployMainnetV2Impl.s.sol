// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ============================================================================================
//  RUN ONLY WHEN JAKE APPROVES. Requires the mainnet deployer key (DEPLOYER_PK, sealed env).
//  THIS SCRIPT DOES NOT EXECUTE THE UPGRADE. It ONLY deploys the V2 implementation contract.
//  The actual upgrade (upgradeToAndCall) is executed by the 2-of-2 Safe, NOT by this script.
//  It deploys NO proxy and calls NO initializer (the impl constructor runs _disableInitializers).
// ============================================================================================
//
//  Hard-guarded to Robinhood mainnet chainid 4663. Will revert on any other chain.
//
//  USAGE (only after sign-off, with the sealed deployer key exported):
//    export DEPLOYER_PK=0x<mainnet deployer key>        # sealed env only, never in source/logs
//    forge script script/DeployMainnetV2Impl.s.sol:DeployMainnetV2Impl \
//      --rpc-url https://rpc.chain.robinhood.com \
//      --broadcast --legacy
//
//  OUTPUT: prints the new V2 implementation address. Hand THAT address to the Safe ceremony
//  as `newImpl` in upgradeToAndCall(newImpl, 0x). Do NOT point the app at the impl; the app
//  always uses the existing proxy 0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5.

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";

contract DeployMainnetV2Impl is Script {
    // The live mainnet proxy this implementation is intended to back. Informational only; this
    // script never touches it. The Safe performs the upgrade in a separate transaction.
    address constant MAINNET_PROXY = 0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5;
    // The 2-of-2 Safe that owns the proxy and is the ONLY authorized upgrader.
    address constant MAINNET_SAFE  = 0x2aA3936C0312f3604982B2504BeE7ad8c88e9397;

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
        console2.log("StandoffEscrow V2 IMPLEMENTATION deployed (NO proxy, NO init)");
        console2.log("  chainid            :", block.chainid);
        console2.log("  new implementation :", implementation);
        console2.log("  VERSION (constant) :", uint256(impl.VERSION()));
        console2.log("-------------------------------------------------------------");
        console2.log("NEXT (Safe does this, NOT this script):");
        console2.log("  proxy  :", MAINNET_PROXY);
        console2.log("  safe   :", MAINNET_SAFE);
        console2.log("  call   : upgradeToAndCall(newImpl, 0x) with newImpl = the address above");
        console2.log("=============================================================");
    }
}
