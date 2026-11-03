// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RobbingTheVaultV3} from "../src/RobbingTheVaultV3.sol";

/// @notice V3 UUPS upgrade, step 1: deploy the NEW RobbingTheVaultV3 implementation (adds enterFor comps + sponsor role).
///         Harmless on its own — the live proxy keeps V2 until the Safe calls upgradeToAndCall(NEW_IMPL_V3, "") + setSponsor.
///         Broadcasts with DEPLOYER_PRIVATE_KEY_2 (same mainnet deployer as V1/V2 impls).
contract DeployImplV3 is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY_2");
        address deployer = vm.addr(pk);
        require(deployer == 0x8444149B8E5eD771607452FB133d8803A3F02D0e, "wrong deployer key");
        vm.startBroadcast(pk);
        RobbingTheVaultV3 impl = new RobbingTheVaultV3();
        vm.stopBroadcast();
        console2.log("NEW_IMPL_V3", address(impl));
        // Then, from the Safe: upgradeToAndCall(NEW_IMPL_V3, "") + setSponsor(0x411f48757B2114392556a221aAA154b94bA449d1).
    }
}
