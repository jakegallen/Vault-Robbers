// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";
import {MockERC20} from "./MockERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice V5 tests: progressive jackpot (final-vault rollover) + auto-send payout (payWinners) + void restores the
/// jackpot. Rollover moves a committed round's whole pot into the persistent jackpot (no rake, no refund); the next
/// WON round folds the jackpot into the winner's payout and zeroes it; payWinners pushes the settled payout after the
/// challenge window so a winner never clicks claim; voiding a jackpot-winning settle in the window restores the jackpot.
contract StandoffEscrowV5Test is Test {
    StandoffEscrow esc;
    MockERC20 tok;

    address owner = address(0x5afe);
    address signer = address(0x516e);
    address treasury = address(0x7ea5);
    address burn = address(0xdead);

    address alice = address(0xa11ce);
    address bob = address(0xb0b);

    uint16 constant RAKE = 500;       // 5%
    uint16 constant BURNSHARE = 5000; // 50% of rake burned
    uint32 constant CHAL = 3600;
    uint128 constant ENTRY = 1000 ether;

    function setUp() public {
        vm.warp(1000);
        tok = new MockERC20();
        StandoffEscrow impl = new StandoffEscrow();
        bytes memory initData = abi.encodeCall(
            StandoffEscrow.initialize, (address(tok), owner, signer, treasury, burn, RAKE, BURNSHARE, CHAL)
        );
        esc = StandoffEscrow(address(new ERC1967Proxy(address(impl), initData)));
        address[2] memory users = [alice, bob];
        for (uint256 i; i < users.length; ++i) {
            tok.mint(users[i], 1_000_000 ether);
            vm.prank(users[i]); tok.approve(address(esc), type(uint256).max);
        }
    }

    // open a round with a far-future lock, buy `tix` for `who`, then lock+commit so it is Committed.
    function _openBuyCommit(uint256 id, address who, uint256 tix, bytes32 seed) internal returns (uint256 pot) {
        uint64 lock = uint64(block.timestamp) + 1_000_000;
        vm.prank(signer); esc.openRound(id, ENTRY, lock, lock + 10000);
        vm.prank(who); esc.buyIn(id, tix);
        vm.prank(signer); esc.lockRound(id);
        vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));
        ( , uint128 p,,,,,,,,,,) = esc.rounds(id);
        pot = p;
    }

    function _status(uint256 id) internal view returns (uint8) {
        ( , , , , , , , , StandoffEscrow.Status st, , , ) = esc.rounds(id);
        return uint8(st);
    }

    // ---- rollover: whole pot -> jackpot, terminal, no refund/claim ----
    function test_rollover_moves_pot_to_jackpot() public {
        bytes32 seed = keccak256("r1");
        uint256 pot = _openBuyCommit(1, alice, 3, seed);
        assertEq(esc.jackpot(), 0);
        vm.prank(signer); esc.rolloverRound(1, seed);
        assertEq(esc.jackpot(), pot, "jackpot = rolled pot");
        assertEq(_status(1), uint8(5), "RolledOver");
        // no refund on a rolled-over round
        vm.prank(alice); vm.expectRevert(bytes("not voided")); esc.refund(1);
        // no claim either
        vm.prank(alice); vm.expectRevert(bytes("not settled")); esc.claim(1);
    }

    function test_rollover_rejects_bad_seed_and_non_signer() public {
        bytes32 seed = keccak256("r2");
        _openBuyCommit(2, alice, 1, seed);
        vm.prank(signer); vm.expectRevert(bytes("seed mismatch")); esc.rolloverRound(2, keccak256("wrong"));
        vm.prank(bob); vm.expectRevert(bytes("not signer")); esc.rolloverRound(2, seed);
    }

    // ---- next WON round sweeps the jackpot into the winner's payout; jackpot resets ----
    function test_won_round_folds_jackpot_then_resets() public {
        // round 1 rolls over
        bytes32 s1 = keccak256("a");
        uint256 rolled = _openBuyCommit(1, alice, 2, s1);
        vm.prank(signer); esc.rolloverRound(1, s1);
        assertEq(esc.jackpot(), rolled);

        // round 2 is won by bob; budget = pot - rake + jackpot
        bytes32 s2 = keccak256("b");
        uint256 pot = _openBuyCommit(2, bob, 2, s2);
        uint256 rake = pot * RAKE / 10000;
        uint256 budget = pot - rake + rolled;
        address[] memory w = new address[](1); w[0] = bob;
        uint256[] memory a = new uint256[](1); a[0] = budget;
        vm.prank(signer); esc.settle(2, s2, w, a);
        assertEq(esc.jackpot(), 0, "jackpot consumed");
        assertEq(esc.roundJackpotApplied(2), rolled, "recorded for void-restore");

        // pay after the window: bob receives the full budget (incl. jackpot) with no claim() click
        vm.warp(block.timestamp + CHAL + 1);
        uint256 before = tok.balanceOf(bob);
        esc.payWinners(2, w);                   // anyone can push
        assertEq(tok.balanceOf(bob) - before, budget, "auto-sent pot-rake+jackpot");
        // idempotent: a second push sends nothing
        esc.payWinners(2, w);
        assertEq(tok.balanceOf(bob) - before, budget);
    }

    // ---- payWinners respects the challenge window ----
    function test_payWinners_blocked_in_window() public {
        bytes32 s = keccak256("c");
        uint256 pot = _openBuyCommit(1, alice, 2, s);
        uint256 budget = pot - (pot * RAKE / 10000);
        address[] memory w = new address[](1); w[0] = alice;
        uint256[] memory a = new uint256[](1); a[0] = budget;
        vm.prank(signer); esc.settle(1, s, w, a);
        vm.expectRevert(bytes("challenge window")); esc.payWinners(1, w);
    }

    // ---- voiding a jackpot-winning settle in the window restores the jackpot ----
    function test_void_restores_jackpot() public {
        bytes32 s1 = keccak256("d");
        uint256 rolled = _openBuyCommit(1, alice, 2, s1);
        vm.prank(signer); esc.rolloverRound(1, s1);

        bytes32 s2 = keccak256("e");
        uint256 pot = _openBuyCommit(2, bob, 2, s2);
        uint256 budget = pot - (pot * RAKE / 10000) + rolled;
        address[] memory w = new address[](1); w[0] = bob;
        uint256[] memory a = new uint256[](1); a[0] = budget;
        vm.prank(signer); esc.settle(2, s2, w, a);
        assertEq(esc.jackpot(), 0);

        // owner voids the bad settle inside the window -> jackpot comes back
        vm.prank(owner); esc.voidRound(2);
        assertEq(esc.jackpot(), rolled, "jackpot restored on void");
        assertEq(esc.roundJackpotApplied(2), 0);
        // bob can reclaim his own buy-ins via refund (round 2 now Voided)
        vm.prank(bob); esc.refund(2);
    }
}
