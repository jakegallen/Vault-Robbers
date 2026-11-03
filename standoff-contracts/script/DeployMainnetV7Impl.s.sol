// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ============================================================================================
//  V7 IMPLEMENTATION DEPLOY. Requires the mainnet deployer key (DEPLOYER_PK, sealed env).
//  Deploys ONLY the V7 implementation contract. It does NOT execute the upgrade and touches no
//  funds. The 2-of-2 Safe performs upgradeToAndCall(newImpl, 0x) in a separate transaction.
//  The impl constructor runs _disableInitializers() so the logic contract cannot be initialized.
//
//  V7 delta vs V6: adds voidRolledOver(uint256) (owner-only) so the Safe can unwind a rolled-over
//  round back to Voided and let its participants refund() exactly what they paid. ZERO new storage
//  (layout byte-for-byte identical to V6), so the V6 -> V7 upgrade is trivially layout-safe.
//
//  USAGE (after sign-off, with the sealed deployer key exported):
//    export DEPLOYER_PK=0x<mainnet deployer key>        # sealed env only, never in source/logs
//    forge script script/DeployMainnetV7Impl.s.sol:DeployMainnetV7Impl \
//      --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --legacy
//
//  OUTPUT: prints the new V7 implementation address. Hand THAT to the Safe as newImpl in
//  upgradeToAndCall(newImpl, 0x). No config calls are needed for V7 (no new params).
// ============================================================================================

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";

contract DeployMainnetV7Impl is Script {
    address constant MAINNET_PROXY = 0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5;
    address constant MAINNET_SAFE  = 0x3290f9cbF7bE7dEA11E7d482Ae0418b83E363665;

    function run() external returns (address implementation) {
        require(block.chainid == 4663, "MAINNET ONLY (expect Robinhood chainid 4663)");

        uint256 pk = vm.envUint("DEPLOYER_PK");

        vm.startBroadcast(pk);
        StandoffEscrow impl = new StandoffEscrow();
        vm.stopBroadcast();

        implementation = address(impl);

        console2.log("=============================================================");
        console2.log("StandoffEscrow V7 IMPLEMENTATION deployed (NO proxy, NO init)");
        console2.log("  chainid            :", block.chainid);
        console2.log("  new implementation :", implementation);
        console2.log("  VERSION (constant) :", uint256(impl.VERSION()));
        console2.log("-------------------------------------------------------------");
        console2.log("NEXT (the Safe does this, NOT this script):");
        console2.log("  proxy :", MAINNET_PROXY);
        console2.log("  safe  :", MAINNET_SAFE);
        console2.log("  upgradeToAndCall(newImpl, 0x) with newImpl = the address above");
        console2.log("  (no config calls needed for V7)");
        console2.log("=============================================================");
    }
}
