// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RobbingTheVaultV2} from "../src/RobbingTheVaultV2.sol";

/// @notice V2 UUPS upgrade, step 1: deploy the NEW RobbingTheVaultV2 implementation. Harmless on its own — the live proxy
///         keeps the old impl until the Safe calls upgradeToAndCall(NEW_IMPL, initializeV2()). Broadcasts with
///         DEPLOYER_PRIVATE_KEY_2 and asserts the expected deployer (same as the prior mainnet impl deploy).
contract DeployImplV2 is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY_2");
        address deployer = vm.addr(pk);
        require(deployer == 0x8444149B8E5eD771607452FB133d8803A3F02D0e, "wrong deployer key");
        vm.startBroadcast(pk);
        RobbingTheVaultV2 impl = new RobbingTheVaultV2();
        vm.stopBroadcast();
        console2.log("NEW_IMPL_V2", address(impl));
        // Then, from the Safe: upgradeToAndCall(NEW_IMPL_V2, initializeV2()) + the 5 setLadder calls (safe-setladder-batch.json).
    }
}
