// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RobbingTheVaultV5} from "../src/RobbingTheVaultV5.sol";

/// @notice V5 UUPS upgrade, step 1: deploy the NEW RobbingTheVaultV5 implementation (V4 + owner withdrawal).
///         INERT on its own — the live proxy keeps V4 until the Safe calls upgradeToAndCall(NEW_IMPL_V5, "0x").
///         Storage layout is IDENTICAL to V4 (functions only), so no reinitializer is needed.
contract DeployImplV5 is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY_2");
        address deployer = vm.addr(pk);
        require(deployer == 0x8444149B8E5eD771607452FB133d8803A3F02D0e, "wrong deployer key");
        vm.startBroadcast(pk);
        RobbingTheVaultV5 impl = new RobbingTheVaultV5();
        vm.stopBroadcast();
        console2.log("NEW_IMPL_V5", address(impl));
    }
}
