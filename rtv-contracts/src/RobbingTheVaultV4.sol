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

/// @title Robbing the Vault V4 — Buy, Burn, Earn cash-out ladder (Robinhood Chain).
/// @notice UUPS upgrade of V3. STORAGE LAYOUT IS APPEND-ONLY vs V3 (payoutCap + potFloor consume 2 slots from __gap[36]->[34]).
///         Change vs V3 (Jake 2026-09-11): the cash-out ladder becomes payout = min(pct*pot, cap), floored so a cash-out can
///         never take the pot below potFloor. This makes deep tiers un-farmable at ANY pot size (the cap bounds the payout, so a
///         big pot never becomes +EV to grind) while letting the pot grow freely. Buy = 50% of creator fees buy RVLT and are
///         seeded into the pot via seedPot() (Emblem Terminal, hourly). Burn = 100% of the entry (fee, burnBps unchanged).
///         crackCore() is UNCHANGED — the core winner still chooses 100% ETH or 100% pot (the rare apex; not part of the ladder).
contract RobbingTheVaultV4 is
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

    // ── V2 storage (appended) ──
    uint256 public coreCooldown;
    mapping(address => uint256) public lastCoreCrackAt;

    // ── V3 storage (appended) ──
    address public sponsor;
    uint256 public sponsoredPlays;

    // ── V4 NEW storage (appended; consumes 2 slots from the old __gap) ──
    mapping(uint8 => uint256) public payoutCap;   // per-stage hard cap in RVLT (0 = uncapped). Cash-out pays min(pct*pot, cap).
    uint256 public potFloor;                      // a cash-out never takes potRvlt below this (underflow guard)

    event Entered(bytes32 indexed runId, address indexed player, bytes32 commit, uint256 burned, uint256 chips);
    event EnteredFor(bytes32 indexed runId, address indexed player, address indexed sponsor);
    event Settled(bytes32 indexed runId, address indexed player, uint8 stage, bool robbed, uint256 rvltPaid, uint256 ethPaid, bytes32 serverSeed);
    event CoreCracked(bytes32 indexed runId, address indexed player, bool tookEth, uint256 rvltPaid, uint256 ethPaid, bytes32 serverSeed);
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
        potLadderBps[5] = 500;
        potLadderBps[6] = 1000;
        potLadderBps[7] = 2000;
        potLadderBps[8] = 3500;
        potLadderBps[9] = 6000;
    }

    function initializeV2() public reinitializer(2) {
        coreCooldown = 3 days;
    }

    /// @notice One-shot V4 migration: set the Buy-Burn-Earn ladder (pct + caps + floor). Idempotent-safe to run once on upgrade;
    ///         the same values can also be (re)set any time via setLadder / setPayoutCap / setPotFloor (owner = multisig).
    ///         Ladder is keyed by CLEARED stage 5-9 == the chamber the player is STANDING IN (6-10) in player copy.
    function initializeV4() public reinitializer(4) {
        cashoutMin = 5;                    // first cash-out standing in Chamber 6 (cleared 5)
        potLadderBps[5] = 100;  payoutCap[5] = 1_000 ether;        // Ch6: 1%, cap 1,000 (half your 2,000 back)
        potLadderBps[6] = 300;  payoutCap[6] = 3_000 ether;        // Ch7: 3%, cap 3,000
        potLadderBps[7] = 500;  payoutCap[7] = 9_000 ether;        // Ch8: 5%, cap 9,000
        potLadderBps[8] = 1000; payoutCap[8] = 800_000 ether;      // Ch9: 10%, cap 800,000
        potLadderBps[9] = 2500; payoutCap[9] = 2_000_000 ether;    // Ch10: 25%, cap 2,000,000 (or crack core for ETH)
        potFloor = 100_000 ether;
        emit ParamsUpdated();
    }

    // ---- play ----

    function _openRun(address payer, address player, bytes32 runId, bytes32 commit) internal {
        require(runs[runId].status == Status.None, "run exists");
        require(commit != bytes32(0), "no commit");
        require(player != address(0), "no player");
        require(gameEnd == 0 || block.timestamp < gameEnd, "game over");
        uint256 burnAmt = fee * burnBps / 10000;
        uint256 chips = fee - burnAmt;
        rvlt.safeTransferFrom(payer, address(this), fee);
        if (burnAmt > 0) rvlt.safeTransfer(DEAD, burnAmt);
        potRvlt += chips;
        totalBurned += burnAmt;
        totalPlays += 1;
        runs[runId] = Run({player: player, commit: commit, stage: 0, status: Status.Open});
        emit Entered(runId, player, commit, burnAmt, chips);
    }

    function enter(bytes32 runId, bytes32 commit) external whenNotPaused nonReentrant {
        _openRun(msg.sender, msg.sender, runId, commit);
    }

    function enterFor(address player, bytes32 runId, bytes32 commit) external whenNotPaused nonReentrant {
        require(msg.sender == sponsor || msg.sender == owner(), "not authorized");
        _openRun(msg.sender, player, runId, commit);
        sponsoredPlays += 1;
        emit EnteredFor(runId, player, msg.sender);
    }

    /// @notice Settle a CASH-OUT (non-core) run. Pays min(pct*pot, cap), floored so it can't take the pot below potFloor. RVLT
    ///         only; never ETH. The core is claimed via crackCore(); settle() rejects `robbed` so there is one core path.
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
        uint256 rvltPay = 0;
        if (bps != 0) {
            rvltPay = potRvlt * bps / 10000;                       // percent of pot
            uint256 cap = payoutCap[stage];
            if (cap != 0 && rvltPay > cap) rvltPay = cap;          // hard cap (un-farmable at any pot size)
            uint256 avail = potRvlt > potFloor ? potRvlt - potFloor : 0;
            if (rvltPay > avail) rvltPay = avail;                  // floor guard (never drains the pot to zero)
        }

        potRvlt -= rvltPay;
        r.stage = stage;
        r.status = Status.Settled;

        if (rvltPay > 0) rvlt.safeTransfer(r.player, rvltPay);
        emit Settled(runId, r.player, stage, false, rvltPay, 0, serverSeed);
    }

    /// @notice Core crack — UNCHANGED from V3. The winner chooses 100% of the ETH vault OR 100% of the RVLT pot (never both).
    ///         This is the rare apex (~1-in-284k pushed), not part of the capped ladder, so it is intentionally uncapped.
    function crackCore(bytes32 runId, bool takeEth, bytes32 serverSeed, bytes calldata operatorSig)
        external
        whenNotPaused
        nonReentrant
    {
        Run storage r = runs[runId];
        require(r.status == Status.Open, "not open");
        require(keccak256(abi.encodePacked(serverSeed)) == r.commit, "bad reveal");
        require(lastCoreCrackAt[r.player] == 0 || block.timestamp >= lastCoreCrackAt[r.player] + coreCooldown, "core cooldown");
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

    /// @notice Add RVLT to the pot. The Emblem Terminal buyback calls this hourly (buy RVLT with 50% of creator fees -> pot).
    ///         Add-only: the only way RVLT leaves the pot is a game settle/crackCore. Open to anyone (a griefer can only ADD).
    function seedPot(uint256 amount) external nonReentrant {
        require(amount > 0, "zero");
        rvlt.safeTransferFrom(msg.sender, address(this), amount);
        potRvlt += amount;
        emit PotSeeded(msg.sender, amount);
    }

    // ---- views ----

    function vaultEth() external view returns (uint256) { return address(this).balance; }

    /// @notice What a cash-out at `stage` would pay right now given the current pot (mirrors settle()). Handy for the UI + admin.
    function quoteCashout(uint8 stage) external view returns (uint256) {
        uint16 bps = stage >= cashoutMin ? potLadderBps[stage] : 0;
        if (bps == 0) return 0;
        uint256 pay = potRvlt * bps / 10000;
        uint256 cap = payoutCap[stage];
        if (cap != 0 && pay > cap) pay = cap;
        uint256 avail = potRvlt > potFloor ? potRvlt - potFloor : 0;
        if (pay > avail) pay = avail;
        return pay;
    }

    function settleDigest(bytes32 runId, uint8 stage, bool robbed) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(SETTLE_TYPEHASH, runId, stage, robbed)));
    }

    // ---- admin (owner = multisig) — every ladder knob is settable any time ----

    function setOperator(address o) external onlyOwner { operator = o; emit ParamsUpdated(); }
    function setSponsor(address s) external onlyOwner { sponsor = s; emit ParamsUpdated(); }
    function setFee(uint256 f) external onlyOwner { fee = f; emit ParamsUpdated(); }
    function setBurnBps(uint16 b) external onlyOwner { require(b <= 10000, "bps"); burnBps = b; emit ParamsUpdated(); }
    function setLadder(uint8 stage, uint16 bps) external onlyOwner { require(bps <= 10000, "bps"); potLadderBps[stage] = bps; emit ParamsUpdated(); }
    function setPayoutCap(uint8 stage, uint256 cap) external onlyOwner { payoutCap[stage] = cap; emit ParamsUpdated(); }   // 0 = uncapped
    function setPotFloor(uint256 f) external onlyOwner { potFloor = f; emit ParamsUpdated(); }
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

    uint256[34] private __gap;   // was [36] in V3; 2 slots consumed by payoutCap + potFloor
}
