// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RobbingTheVault} from "../src/RobbingTheVault.sol";
import {MockRVLT} from "../src/MockRVLT.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Testnet deploy: MockRVLT + RobbingTheVault (UUPS proxy). Operator/owner default to the deployer;
///         rotate to the game-server signer + a multisig later via setOperator / transferOwnership.
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);

        MockRVLT rvlt = new MockRVLT();
        RobbingTheVault impl = new RobbingTheVault();
        bytes memory init = abi.encodeCall(
            RobbingTheVault.initialize,
            (address(rvlt), deployer, deployer, 2500 ether, 0)   // gameEnd=0 → no end/drain on testnet
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);

        vm.stopBroadcast();

        console2.log("deployer   ", deployer);
        console2.log("MockRVLT   ", address(rvlt));
        console2.log("impl       ", address(impl));
        console2.log("VAULT_PROXY", address(proxy));
    }
}
