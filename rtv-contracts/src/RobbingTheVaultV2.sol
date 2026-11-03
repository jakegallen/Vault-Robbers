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

/// @title Robbing the Vault V2 — on-chain economy for the RVLT heist game (Robinhood Chain).
/// @notice UUPS upgrade of V1. STORAGE LAYOUT IS APPEND-ONLY vs V1 (new vars consume 2 slots from the old __gap[39]->[37]).
///         Changes vs V1 (Jake 2026-09-07):
///           1. Cashout ladder is unchanged in CODE (owner setLadder controls the bps; the new 1/3/10/20/30% values are set
///              via setLadder, not hardcoded here — see the migration batch).
///           2. THE CORE (chamber 10) no longer pays BOTH prizes. settle() now rejects `robbed` — the core is claimed via the
///              new crackCore(), where the WINNER CHOOSES ONE prize: 100% of the ETH vault OR 100% of the RVLT pot, never both.
///           3. A per-wallet cooldown (default 3 days) gates repeated core cracks (anti-farm).
///         The operator still signs only (runId, stage, robbed); the prize choice is the player's and is NOT signed, because a
///         player can never obtain both prizes regardless of which they pick, so it needs no operator authorization.
contract RobbingTheVaultV2 is
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

    // ── V1 storage (UNCHANGED order/types — must match the deployed proxy exactly) ──
    IERC20 public rvlt;
    address public operator;
    uint256 public fee;
    uint16 public burnBps;
    uint8 public levels;
    uint8 public cashoutMin;
    uint256 public gameEnd;

    uint256 public potRvlt;
    uint256 public totalBurned;
    uint256 public totalPlays;
    uint256 public robs;

    mapping(uint8 => uint16) public potLadderBps;

    enum Status { None, Open, Settled }
    struct Run { address player; bytes32 commit; uint8 stage; Status status; }
    mapping(bytes32 => Run) public runs;

    // ── V2 NEW storage (appended; consumes 2 slots from the old __gap) ──
    uint256 public coreCooldown;                    // seconds between core cracks per wallet (default 3 days)
    mapping(address => uint256) public lastCoreCrackAt;

    event Entered(bytes32 indexed runId, address indexed player, bytes32 commit, uint256 burned, uint256 chips);
    event Settled(bytes32 indexed runId, address indexed player, uint8 stage, bool robbed, uint256 rvltPaid, uint256 ethPaid, bytes32 serverSeed);
    event CoreCracked(bytes32 indexed runId, address indexed player, bool tookEth, uint256 rvltPaid, uint256 ethPaid, bytes32 serverSeed);
    event VaultSeeded(address indexed from, uint256 amount);
    event ParamsUpdated();
    event GameEndSet(uint256 gameEnd);
    event Drained(address indexed to, uint256 ethAmount, uint256 rvltAmount);
    event PotSeeded(address indexed from, uint256 amount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /// @notice V1 initializer — kept for completeness; the live proxy is already initialized. Not re-run on upgrade.
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
        potLadderBps[5] = 500;
        potLadderBps[6] = 1000;
        potLadderBps[7] = 2000;
        potLadderBps[8] = 3500;
        potLadderBps[9] = 6000;
    }

    /// @notice V2 migration initializer — run ONCE via upgradeToAndCall(newImpl, abi.encodeCall(this.initializeV2, ())).
    ///         Sets the core cooldown. The ladder bps (1/3/10/20/30%) are set separately via setLadder in the same Safe batch.
    function initializeV2() public reinitializer(2) {
        coreCooldown = 3 days;
    }

    // ---- play ----

    function enter(bytes32 runId, bytes32 commit) external whenNotPaused nonReentrant {
        require(runs[runId].status == Status.None, "run exists");
        require(commit != bytes32(0), "no commit");
        require(gameEnd == 0 || block.timestamp < gameEnd, "game over");
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

    /// @notice Settle a CASH-OUT (non-core) run. Pays the share-of-pot ladder in RVLT only; never ETH. The core is claimed
    ///         via crackCore(), not here — settle() rejects `robbed` so there is exactly one core path and no double-pay.
    function settle(bytes32 runId, uint8 stage, bool robbed, bytes32 serverSeed, bytes calldata operatorSig)
        external
        whenNotPaused
        nonReentrant
    {
        require(!robbed, "core: use crackCore");
        Run storage r = runs[runId];
        require(r.status == Status.Open, "not open");
        require(keccak256(abi.encodePacked(serverSeed)) == r.commit, "bad reveal");
        require(stage <= levels, "bad stage");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(SETTLE_TYPEHASH, runId, stage, false)));
        require(ECDSA.recover(digest, operatorSig) == operator, "bad operator sig");

        uint16 bps = stage >= cashoutMin ? potLadderBps[stage] : 0;
        uint256 rvltPay = bps == 0 ? 0 : potRvlt * bps / 10000;

        potRvlt -= rvltPay;
        r.stage = stage;
        r.status = Status.Settled;

        if (rvltPay > 0) rvlt.safeTransfer(r.player, rvltPay);
        emit Settled(runId, r.player, stage, false, rvltPay, 0, serverSeed);
    }

    /// @notice Claim the CORE (chamber `levels`). The winner CHOOSES ONE prize: takeEth => 100% of the ETH vault; else =>
    ///         100% of the RVLT pot. Never both, which preserves whichever prize is not taken for the rest of the game. A
    ///         per-wallet cooldown gates repeated cracks. Operator sig authorizes the core outcome (robbed=true, stage=levels).
    function crackCore(bytes32 runId, bool takeEth, bytes32 serverSeed, bytes calldata operatorSig)
        external
        whenNotPaused
        nonReentrant
    {
        Run storage r = runs[runId];
        require(r.status == Status.Open, "not open");
        require(keccak256(abi.encodePacked(serverSeed)) == r.commit, "bad reveal");
        require(lastCoreCrackAt[r.player] == 0 || block.timestamp >= lastCoreCrackAt[r.player] + coreCooldown, "core cooldown");   // gate only REPEAT cracks; a first crack (never cracked before) is always allowed
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(SETTLE_TYPEHASH, runId, levels, true)));
        require(ECDSA.recover(digest, operatorSig) == operator, "bad operator sig");

        r.stage = levels;
        r.status = Status.Settled;
        robs += 1;
        lastCoreCrackAt[r.player] = block.timestamp;

        uint256 rvltPay = 0;
        uint256 ethPay = 0;
        if (takeEth) {
            ethPay = address(this).balance;
            if (ethPay > 0) { (bool ok, ) = payable(r.player).call{value: ethPay}(""); require(ok, "eth send"); }
        } else {
            rvltPay = potRvlt;
            potRvlt = 0;
            if (rvltPay > 0) rvlt.safeTransfer(r.player, rvltPay);
        }
        emit CoreCracked(runId, r.player, takeEth, rvltPay, ethPay, serverSeed);
    }

    // ---- fuel ----

    receive() external payable { emit VaultSeeded(msg.sender, msg.value); }
    function seedVault() external payable { emit VaultSeeded(msg.sender, msg.value); }

    function seedPot(uint256 amount) external nonReentrant {
        require(amount > 0, "zero");
        rvlt.safeTransferFrom(msg.sender, address(this), amount);
        potRvlt += amount;
        emit PotSeeded(msg.sender, amount);
    }

    // ---- views ----

    function vaultEth() external view returns (uint256) { return address(this).balance; }

    function settleDigest(bytes32 runId, uint8 stage, bool robbed) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(SETTLE_TYPEHASH, runId, stage, robbed)));
    }

    // ---- admin (owner = multisig) ----

    function setOperator(address o) external onlyOwner { operator = o; emit ParamsUpdated(); }
    function setFee(uint256 f) external onlyOwner { fee = f; emit ParamsUpdated(); }
    function setBurnBps(uint16 b) external onlyOwner { require(b <= 10000, "bps"); burnBps = b; emit ParamsUpdated(); }
    function setLadder(uint8 stage, uint16 bps) external onlyOwner { require(bps <= 10000, "bps"); potLadderBps[stage] = bps; emit ParamsUpdated(); }
    function setCashoutMin(uint8 c) external onlyOwner { cashoutMin = c; emit ParamsUpdated(); }
    function setCoreCooldown(uint256 s) external onlyOwner { coreCooldown = s; emit ParamsUpdated(); }
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function sweepStrayRvlt(address to) external onlyOwner {
        uint256 bal = rvlt.balanceOf(address(this));
        require(bal > potRvlt, "none stray");
        rvlt.safeTransfer(to, bal - potRvlt);
    }

    function setGameEnd(uint256 t) external onlyOwner { require(t >= gameEnd, "cannot shorten"); gameEnd = t; emit GameEndSet(t); }

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

    uint256[37] private __gap;   // was [39] in V1; 2 slots consumed by coreCooldown + lastCoreCrackAt
}
