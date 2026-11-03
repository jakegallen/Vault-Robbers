// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// ============================================================================================
//  V8 IMPLEMENTATION DEPLOY. Requires the mainnet deployer key (DEPLOYER_PK, sealed env).
//  Deploys ONLY the V8 implementation contract. It does NOT execute the upgrade and touches no
//  funds. The 2-of-2 Safe performs upgradeToAndCall(newImpl, 0x) in a separate transaction.
//  The impl constructor runs _disableInitializers() so the logic contract cannot be initialized.
//
//  V8 delta vs V7: adds a RELAYER KEY-POOL so multiple relayer hot keys can submit player-signed
//  auto-buys in parallel (one key = one serial nonce lane; a pool = parallel throughput for a
//  launch rush). Append-only storage: ONE new slot, the isRelayer mapping (slot 17, previously the
//  first slot inside __gap); __gap shrinks uint256[36] -> uint256[35] so the layout end-slot (52)
//  is UNCHANGED. The legacy single `relayer` + setRelayer stay for back-compat. The only behaviour
//  change is the "not relayer" gate in buyInFor + buyInForRange, which now also accepts any
//  owner-allowlisted key (same revert string). No money path, EIP-712 domain, settlement-signer
//  isolation, or owner-only _authorizeUpgrade is touched. V7 -> V8 upgrade is layout-safe.
//
//  USAGE (after sign-off, with the sealed deployer key exported):
//    export DEPLOYER_PK=0x<mainnet deployer key>        # sealed env only, never in source/logs
//    forge script script/DeployMainnetV8Impl.s.sol:DeployMainnetV8Impl \
//      --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --legacy
//
//  OUTPUT: prints the new V8 implementation address. Hand THAT to the Safe as newImpl in
//  upgradeToAndCall(newImpl, 0x). After the upgrade, the Safe authorizes each new relayer key with
//  setRelayerAllowed(key, true) (see the console output below).
// ============================================================================================

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";

contract DeployMainnetV8Impl is Script {
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
        console2.log("StandoffEscrow V8 IMPLEMENTATION deployed (NO proxy, NO init)");
        console2.log("  chainid            :", block.chainid);
        console2.log("  new implementation :", implementation);
        console2.log("  VERSION (constant) :", uint256(impl.VERSION()));
        console2.log("-------------------------------------------------------------");
        console2.log("NEXT (the Safe does this, NOT this script):");
        console2.log("  proxy :", MAINNET_PROXY);
        console2.log("  safe  :", MAINNET_SAFE);
        console2.log("  1) upgradeToAndCall(newImpl, 0x) with newImpl = the address above");
        console2.log("  2) setRelayerAllowed(<each new relayer key>, true) to arm the key-pool");
        console2.log("     (the legacy relayer set via setRelayer keeps working unchanged)");
        console2.log("=============================================================");
    }
}
