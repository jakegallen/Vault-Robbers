// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Robbing the Vault — on-chain economy for the RVLT heist game (Robinhood Chain).
/// @notice Custodies the RVLT pot + the ETH vault, enforces the locked model on-chain, and settles runs
///         from an operator-signed outcome anchored by a commit-reveal seed. Payouts are capped to a
///         share-of-pot ladder, so the operator can never overpay. Upgradeable via UUPS (owner-gated).
contract RobbingTheVault is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    EIP712Upgradeable
{
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    bytes32 public constant SETTLE_TYPEHASH = keccak256("Settle(bytes32 runId,uint8 stage,bool robbed)");

    IERC20 public rvlt;         // the RVLT token used for entry/pot
    address public operator;    // trusted game server that signs run outcomes
    uint256 public fee;         // entry fee in RVLT (e.g. 2500e18)
    uint16 public burnBps;      // share of the fee burned forever (5000 = 50%)
    uint8 public levels;        // total chambers (10); reaching `levels` = core crack
    uint8 public cashoutMin;    // earliest stage a player may cash out (5)
    uint256 public gameEnd;     // unix ts the game closes; entries stop, and the owner may drain the remainder

    uint256 public potRvlt;     // RVLT held for player payouts (chips accumulate here)
    uint256 public totalBurned; // lifetime RVLT burned
    uint256 public totalPlays;  // lifetime entries
    uint256 public robs;        // lifetime core cracks

    mapping(uint8 => uint16) public potLadderBps; // stage(5..9) => share of current pot in bps

    enum Status { None, Open, Settled }
    struct Run { address player; bytes32 commit; uint8 stage; Status status; }
    mapping(bytes32 => Run) public runs;

    event Entered(bytes32 indexed runId, address indexed player, bytes32 commit, uint256 burned, uint256 chips);
    event Settled(bytes32 indexed runId, address indexed player, uint8 stage, bool robbed, uint256 rvltPaid, uint256 ethPaid, bytes32 serverSeed);
    event VaultSeeded(address indexed from, uint256 amount);
    event ParamsUpdated();
    event GameEndSet(uint256 gameEnd);
    event Drained(address indexed to, uint256 ethAmount, uint256 rvltAmount);
    event PotSeeded(address indexed from, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address _rvlt, address _operator, address _owner, uint256 _fee, uint256 _gameEnd) public initializer {
        __UUPSUpgradeable_init();
        __Ownable_init(_owner);
        __Pausable_init();
        __ReentrancyGuard_init();
        __EIP712_init("RobbingTheVault", "1");
        rvlt = IERC20(_rvlt);
        operator = _operator;
        fee = _fee;
        gameEnd = _gameEnd;
        burnBps = 5000;
        levels = 10;
        cashoutMin = 5;
        potLadderBps[5] = 500;   // 5%
        potLadderBps[6] = 1000;  // 10%
        potLadderBps[7] = 2000;  // 20%
        potLadderBps[8] = 3500;  // 35%
        potLadderBps[9] = 6000;  // 60%
    }

    // ---- play ----

    /// @notice Pay the entry fee, burn half, add half to the pot, and open a run committed to `commit`.
    /// @param runId  unique run id (server-generated)
    /// @param commit keccak256(serverSeed) — the pre-committed, later-revealed provably-fair seed
    function enter(bytes32 runId, bytes32 commit) external whenNotPaused nonReentrant {
        require(runs[runId].status == Status.None, "run exists");
        require(commit != bytes32(0), "no commit");
        require(gameEnd == 0 || block.timestamp < gameEnd, "game over");   // entries close at gameEnd; settles stay open so in-flight runs finish
        uint256 burnAmt = fee * burnBps / 10000;
        uint256 chips = fee - burnAmt;
        rvlt.safeTransferFrom(msg.sender, address(this), fee);
        if (burnAmt > 0) rvlt.safeTransfer(DEAD, burnAmt);
        potRvlt += chips;
        totalBurned += burnAmt;
        totalPlays += 1;
        runs[runId] = Run({player: msg.sender, commit: commit, stage: 0, status: Status.Open});
        emit Entered(runId, msg.sender, commit, burnAmt, chips);
    }

    /// @notice Settle a run with an operator-signed outcome. Anyone may submit (the player relays the sig).
    ///         Reveals the server seed (must match the entry commit) and pays the capped share.
    function settle(bytes32 runId, uint8 stage, bool robbed, bytes32 serverSeed, bytes calldata operatorSig)
        external
        whenNotPaused
        nonReentrant
    {
        Run storage r = runs[runId];
        require(r.status == Status.Open, "not open");
        require(keccak256(abi.encodePacked(serverSeed)) == r.commit, "bad reveal");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(SETTLE_TYPEHASH, runId, stage, robbed)));
        require(ECDSA.recover(digest, operatorSig) == operator, "bad operator sig");
        if (robbed) { require(stage == levels, "not core"); } else { require(stage <= levels, "bad stage"); }

        uint16 bps = robbed ? 10000 : (stage >= cashoutMin ? potLadderBps[stage] : 0);
        uint256 rvltPay = bps == 0 ? 0 : potRvlt * bps / 10000;
        uint256 ethPay = robbed ? address(this).balance : 0;

        potRvlt -= rvltPay;
        r.stage = stage;
        r.status = Status.Settled;
        if (robbed) robs += 1;

        if (rvltPay > 0) rvlt.safeTransfer(r.player, rvltPay);
        if (ethPay > 0) { (bool ok, ) = payable(r.player).call{value: ethPay}(""); require(ok, "eth send"); }

        emit Settled(runId, r.player, stage, robbed, rvltPay, ethPay, serverSeed);
    }

    // ---- fuel ----

    /// @notice Seed the ETH vault (creator fees + donations). Also catches plain transfers.
    receive() external payable { emit VaultSeeded(msg.sender, msg.value); }
    function seedVault() external payable { emit VaultSeeded(msg.sender, msg.value); }

    /// @notice Add RVLT directly to the payable pot (founder seed or community boost). Permissionless — it only
    ///         INCREASES what players can win. Requires the caller to have approved `amount` to this contract first.
    ///         (A raw ERC20 transfer would land as "stray" and NOT count as pot; this is the correct way to seed.)
    function seedPot(uint256 amount) external nonReentrant {
        require(amount > 0, "zero");
        rvlt.safeTransferFrom(msg.sender, address(this), amount);
        potRvlt += amount;
        emit PotSeeded(msg.sender, amount);
    }

    // ---- views ----

    function vaultEth() external view returns (uint256) { return address(this).balance; }

    /// @notice The EIP-712 digest the operator must sign for a given outcome (used by the game server + verifiers).
    function settleDigest(bytes32 runId, uint8 stage, bool robbed) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(SETTLE_TYPEHASH, runId, stage, robbed)));
    }

    // ---- admin (owner = multisig) ----

    function setOperator(address o) external onlyOwner { operator = o; emit ParamsUpdated(); }
    function setFee(uint256 f) external onlyOwner { fee = f; emit ParamsUpdated(); }
    function setBurnBps(uint16 b) external onlyOwner { require(b <= 10000, "bps"); burnBps = b; emit ParamsUpdated(); }
    function setLadder(uint8 stage, uint16 bps) external onlyOwner { require(bps <= 10000, "bps"); potLadderBps[stage] = bps; emit ParamsUpdated(); }
    function setCashoutMin(uint8 c) external onlyOwner { cashoutMin = c; emit ParamsUpdated(); }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /// @notice Recover RVLT accidentally sent in excess of the tracked pot (never touches the pot itself).
    function sweepStrayRvlt(address to) external onlyOwner {
        uint256 bal = rvlt.balanceOf(address(this));
        require(bal > potRvlt, "none stray");
        rvlt.safeTransfer(to, bal - potRvlt);
    }

    /// @notice Extend the game-end (and the drain unlock) later. Can NEVER be pulled earlier — no early rug.
    function setGameEnd(uint256 t) external onlyOwner { require(t >= gameEnd, "cannot shorten"); gameEnd = t; emit GameEndSet(t); }

    /// @notice After gameEnd, the owner (multisig) may recover ALL remaining ETH + RVLT (including the pot). Before
    ///         gameEnd this reverts, so while the game is live the prize pool is untouchable by anyone but players.
    ///         Pause first and let any in-flight runs settle before draining, since this zeroes the pot.
    function drain(address to) external onlyOwner nonReentrant {
        require(gameEnd != 0 && block.timestamp >= gameEnd, "game not over");
        require(to != address(0), "zero to");
        uint256 ethBal = address(this).balance;
        uint256 rvltBal = rvlt.balanceOf(address(this));
        potRvlt = 0;
        if (rvltBal > 0) rvlt.safeTransfer(to, rvltBal);
        if (ethBal > 0) { (bool ok, ) = payable(to).call{value: ethBal}(""); require(ok, "eth send"); }
        emit Drained(to, ethBal, rvltBal);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    uint256[39] private __gap;
}
