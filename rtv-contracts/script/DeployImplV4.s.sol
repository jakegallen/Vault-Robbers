// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RobbingTheVaultV4} from "../src/RobbingTheVaultV4.sol";

/// @notice V4 UUPS upgrade, step 1: deploy the NEW RobbingTheVaultV4 implementation (Buy-Burn-Earn capped ladder).
///         INERT on its own — the live proxy keeps V3 until the Safe calls upgradeToAndCall(NEW_IMPL_V4, initializeV4()).
///         Broadcasts with DEPLOYER_PRIVATE_KEY_2 (same mainnet deployer as V1/V2/V3 impls).
contract DeployImplV4 is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY_2");
        address deployer = vm.addr(pk);
        require(deployer == 0x8444149B8E5eD771607452FB133d8803A3F02D0e, "wrong deployer key");
        vm.startBroadcast(pk);
        RobbingTheVaultV4 impl = new RobbingTheVaultV4();
        vm.stopBroadcast();
        console2.log("NEW_IMPL_V4", address(impl));
        // Then, from the Safe (owner 0x2aA3936C0312f3604982B2504BeE7ad8c88e9397):
        //   upgradeToAndCall(NEW_IMPL_V4, abi.encodeWithSignature("initializeV4()"))
        //   which sets cashoutMin=5, ladder bps 100/300/500/1000/2500, caps 1k/3k/9k/800k/2M, potFloor 100k.
    }
}
