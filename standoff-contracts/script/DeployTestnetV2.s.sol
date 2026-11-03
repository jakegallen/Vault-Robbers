// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice TESTNET-ONLY (Robinhood 46630) deploy of StandoffEscrow V2 as a fresh UUPS proxy + impl.
/// Unlike the canonical Deploy.s.sol, this permits owner == deployer (fine on testnet; the Safe guard is
/// deliberately NOT applied here so we can end-to-end test the threshold model with the deployer as owner/relayer).
/// NEVER run this against mainnet (4663). All params come from env vars; nothing is hardcoded.
///   DEPLOYER_PK            deployer private key (uint)      -> owner, treasury, guardian, relayer on testnet
///   RVLT_TOKEN            mock RVLT on testnet
///   ESCROW_OWNER          contract owner + upgrade authority (= deployer on testnet)
///   ESCROW_SIGNER         settlement hot-key ADDRESS
///   ESCROW_TREASURY       rake -> treasury
///   ESCROW_BURN          rake -> burn sink
///   ESCROW_RAKE_BPS      default 500 (5%)
///   ESCROW_BURN_SHARE_BPS default 5000 (50% of rake burned)
///   ESCROW_CHALLENGE     default 300 (contract enforces a 300s / 5-min floor in V2 initialize)
///   ESCROW_MAXTIX        per-wallet ticket cap (default 5)
///   ESCROW_RELAYER       auto-buy relayer (= deployer on testnet)
///   ESCROW_GUARDIAN      void guardian (= deployer on testnet)
contract DeployTestnetV2 is Script {
    function run() external returns (address proxy, address implementation) {
        require(block.chainid == 46630, "TESTNET ONLY (expect chainid 46630)");

        uint256 pk = vm.envUint("DEPLOYER_PK");
        address token = vm.envAddress("RVLT_TOKEN");
        address owner = vm.envAddress("ESCROW_OWNER");
        address signer = vm.envAddress("ESCROW_SIGNER");
        address treasury = vm.envAddress("ESCROW_TREASURY");
        address burnSink = vm.envAddress("ESCROW_BURN");
        uint16 rakeBps = uint16(vm.envOr("ESCROW_RAKE_BPS", uint256(500)));
        uint16 burnShareBps = uint16(vm.envOr("ESCROW_BURN_SHARE_BPS", uint256(5000)));
        uint32 challenge = uint32(vm.envOr("ESCROW_CHALLENGE", uint256(300)));
        uint128 maxTix = uint128(vm.envOr("ESCROW_MAXTIX", uint256(5)));
        address relayer = vm.envAddress("ESCROW_RELAYER");
        address guardian = vm.envAddress("ESCROW_GUARDIAN");

        vm.startBroadcast(pk);

        StandoffEscrow impl = new StandoffEscrow();
        bytes memory initData = abi.encodeCall(
            StandoffEscrow.initialize,
            (token, owner, signer, treasury, burnSink, rakeBps, burnShareBps, challenge)
        );
        ERC1967Proxy p = new ERC1967Proxy(address(impl), initData);
        StandoffEscrow escrow = StandoffEscrow(address(p));

        // V2 config that the initializer does NOT set (owner calls; owner == deployer == broadcaster on testnet).
        escrow.setMaxTicketsPerWallet(maxTix);
        escrow.setRelayer(relayer);
        escrow.setGuardian(guardian);

        vm.stopBroadcast();

        proxy = address(p);
        implementation = address(impl);
        console2.log("StandoffEscrow V2 proxy      :", proxy);
        console2.log("StandoffEscrow V2 impl       :", implementation);
        console2.log("  owner   ", owner);
        console2.log("  token   ", token);
        console2.log("  signer  ", signer);
        console2.log("  relayer ", relayer);
        console2.log("  guardian", guardian);
        console2.log("  maxTix  ", uint256(maxTix));
    }
}
