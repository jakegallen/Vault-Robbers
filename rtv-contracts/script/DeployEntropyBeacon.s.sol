// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {EntropyBeacon} from "../src/EntropyBeacon.sol";

/// @notice Deploy the standalone EntropyBeacon to Robinhood Chain mainnet (4663). Holds no player funds; owner =
///         deployer (transfer to the Safe later). Broadcasts with DEPLOYER_PRIVATE_KEY_2.
contract DeployEntropyBeacon is Script {
    address constant ENTROPY  = 0x8cF4f562301fA966F153eE1e3D46D975DF21C9a3; // Pyth Entropy on 4663
    address constant PROVIDER = 0xeB8E79d3495638Dde48336D01A1f1229822bB016; // quiver:fletcher

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY_2");
        address deployer = vm.addr(pk);
        require(deployer == 0x8444149B8E5eD771607452FB133d8803A3F02D0e, "wrong deployer key");
        vm.startBroadcast(pk);
        EntropyBeacon beacon = new EntropyBeacon(ENTROPY, PROVIDER, deployer);
        vm.stopBroadcast();
        console2.log("ENTROPY_BEACON", address(beacon));
    }
}
