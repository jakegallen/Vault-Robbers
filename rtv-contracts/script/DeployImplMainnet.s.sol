// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RobbingTheVault} from "../src/RobbingTheVault.sol";

/// @notice MAINNET UUPS upgrade step 1: deploy a NEW RobbingTheVault implementation (adds seedPot()). Harmless on its
///         own — the live proxy keeps using the old impl until the Safe calls upgradeToAndCall(NEW_IMPL, 0x).
///         Broadcasts with DEPLOYER_PRIVATE_KEY_2 (asserts the expected deployer).
contract DeployImplMainnet is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY_2");
        address deployer = vm.addr(pk);
        require(deployer == 0x8444149B8E5eD771607452FB133d8803A3F02D0e, "wrong deployer key");
        vm.startBroadcast(pk);
        RobbingTheVault impl = new RobbingTheVault();
        vm.stopBroadcast();
        console2.log("NEW_IMPL", address(impl));
    }
}
