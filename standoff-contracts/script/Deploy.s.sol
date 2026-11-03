// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Deploy the UUPS-upgradeable StandoffEscrow: implementation + ERC1967 proxy, initialized in one tx.
/// Testnet-first (Robinhood 46630); flip RVLT_TOKEN + ESCROW_OWNER to the real token + Safe for mainnet 4663.
/// All params come from env vars; nothing is hardcoded. Use the PROXY address in the app/env, never the impl.
///   DEPLOYER_PK           deployer private key (uint)
///   RVLT_TOKEN            ROBINVAULT (or a test token on testnet)
///   ESCROW_OWNER          contract owner + upgrade authority (the 2-of-2 Safe on mainnet)
///   ESCROW_SIGNER         settlement hot-key ADDRESS
///   ESCROW_TREASURY       rake -> treasury
///   ESCROW_BURN           rake -> burn sink
///   ESCROW_RAKE_BPS       default 500 (5%)
///   ESCROW_BURN_SHARE_BPS default 0 (NO burn; 100% of the 5% rake goes to treasury. RVLT deflation comes from
///                         the creator-fee buy-and-burn + the 3 Vault Robbers NFT royalties, not from this rake)
///   ESCROW_CHALLENGE      default 3600 (seconds; contract enforces a 3600 floor)
contract Deploy is Script {
    function run() external returns (address proxy, address implementation) {
        uint256 pk = vm.envUint("DEPLOYER_PK");
        address token = vm.envAddress("RVLT_TOKEN");
        address owner = vm.envAddress("ESCROW_OWNER");
        address signer = vm.envAddress("ESCROW_SIGNER");
        address treasury = vm.envAddress("ESCROW_TREASURY");
        address burnSink = vm.envAddress("ESCROW_BURN");
        uint16 rakeBps = uint16(vm.envOr("ESCROW_RAKE_BPS", uint256(500)));
        uint16 burnShareBps = uint16(vm.envOr("ESCROW_BURN_SHARE_BPS", uint256(0))); // 0 = no burn; full rake to treasury
        uint32 challenge = uint32(vm.envOr("ESCROW_CHALLENGE", uint256(3600)));

        // Safety: the owner (also the upgrade authority) MUST be the multisig Safe, never the deployer EOA.
        // An EOA owner could void settled rounds, redirect payees, OR upgrade the logic to drain. Blocks it.
        require(owner != vm.addr(pk), "owner must not be deployer; use the 2-of-2 Safe");

        vm.startBroadcast(pk);
        StandoffEscrow impl = new StandoffEscrow();
        bytes memory initData = abi.encodeCall(
            StandoffEscrow.initialize,
            (token, owner, signer, treasury, burnSink, rakeBps, burnShareBps, challenge)
        );
        ERC1967Proxy p = new ERC1967Proxy(address(impl), initData);
        vm.stopBroadcast();

        proxy = address(p);
        implementation = address(impl);
        console2.log("StandoffEscrow proxy         :", proxy);        // <-- use THIS in the app/env (VS_ESCROW_ADDR)
        console2.log("StandoffEscrow implementation:", implementation);
        console2.log("  owner   ", owner);
        console2.log("  token   ", token);
        console2.log("  signer  ", signer);
    }
}
