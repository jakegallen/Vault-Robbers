// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {RobbingTheVault} from "../src/RobbingTheVault.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice MAINNET deploy (Robinhood Chain 4663): RobbingTheVault behind a UUPS proxy, against the REAL
///         ROBINVAULT token. owner = Safe 2-of-2 (never the deployer), operator = dedicated server key,
///         fee = 1000 RVLT, gameEnd = Oct 31 2026 12:00 ET (16:00 UTC). Broadcasts with DEPLOYER_PRIVATE_KEY_2.
contract DeployMainnet is Script {
    address constant RVLT     = 0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04; // ROBINVAULT (18 decimals)
    address constant OWNER    = 0x2aA3936C0312f3604982B2504BeE7ad8c88e9397; // Safe multisig (2-of-2)
    address constant OPERATOR = 0x90DE561c63192AdcA8e5b81Bd9caa8ff8D95b3c5; // dedicated server settle-signer
    uint256 constant FEE      = 1000 ether;  // 1000 RVLT (18dp)
    uint256 constant GAME_END = 1793462400;  // 2026-10-31 12:00 ET (16:00 UTC)

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY_2");
        address deployer = vm.addr(pk);
        require(deployer == 0x8444149B8E5eD771607452FB133d8803A3F02D0e, "wrong deployer key");
        vm.startBroadcast(pk);

        RobbingTheVault impl = new RobbingTheVault();
        bytes memory init = abi.encodeCall(
            RobbingTheVault.initialize,
            (RVLT, OPERATOR, OWNER, FEE, GAME_END)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), init);

        vm.stopBroadcast();

        console2.log("deployer   ", deployer);
        console2.log("impl       ", address(impl));
        console2.log("VAULT_PROXY", address(proxy));
        console2.log("owner(Safe)", OWNER);
        console2.log("operator   ", OPERATOR);
        console2.log("rvlt       ", RVLT);
        console2.log("fee        ", FEE);
        console2.log("gameEnd    ", GAME_END);
    }
}
