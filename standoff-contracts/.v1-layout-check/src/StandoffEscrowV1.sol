// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// RECONSTRUCTED V1 LAYOUT FOR STORAGE DIFF ONLY. NOT FOR DEPLOYMENT.
// This mirrors the mainnet V1 state exactly: V1 state slots 0-7, Round struct WITHOUT rakeBpsSnap,
// NO V2-appended vars (maxTicketsPerWallet/relayer/guardian/voidGrace/autoBuyNonce), and __gap[45].
// Behaviour is stripped to the minimum needed to compile; only the STORAGE declarations matter here.
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

contract StandoffEscrowV1 is Initializable, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    IERC20 public token;                // slot 0
    address public settlementSigner;    // slot 1
    address public treasury;            // slot 2
    address public burnSink;            // slot 3 (offset 0)
    uint16 public rakeBps;              // slot 3 (offset 20)
    uint16 public burnShareBps;         // slot 3 (offset 22)
    uint32 public challenge;            // slot 3 (offset 24)

    enum Status { None, Open, Committed, Settled, Voided }
    struct Round {
        uint128 entry;
        uint128 pot;
        uint128 rakeOwed;
        uint64 lockTime;
        uint64 deadline;
        uint64 claimAt;
        bool rakePaid;
        bytes32 seedHash;
        Status status;
        // NO rakeBpsSnap in V1
    }

    mapping(uint256 => Round) public rounds;                          // slot 4
    mapping(uint256 => mapping(address => uint256)) public tickets;   // slot 5
    mapping(uint256 => mapping(address => uint256)) public winShare;  // slot 6
    mapping(uint256 => mapping(address => bool)) public settled;      // slot 7

    // V1 gap: uint256[45] starting at slot 8
    uint256[45] private __gap;

    constructor() { _disableInitializers(); }
    function _authorizeUpgrade(address) internal override onlyOwner {}
}
