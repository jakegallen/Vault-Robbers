// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";
import {MockERC20} from "./MockERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice V7 tests: voidRolledOver(). Owner can UNWIND a RolledOver round back to Voided so its participants refund()
/// exactly what they paid, reversing the jackpot accrual. This is the escape hatch for a wrongful rollover and for a
/// fair wind-down. Covers: reverse + refund, owner-only, status gate, and the "jackpot already drawn" revert.
contract StandoffEscrowV7Test is Test {
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

    function test_version_is_7() public view { assertEq(esc.VERSION(), 9); } // repo source impl has since advanced to V9

    // The core fix: owner unwinds a rolled-over round -> jackpot reversed, status Voided, participant refunds exactly.
    function test_voidRolledOver_reverses_jackpot_and_enables_refund() public {
        bytes32 seed = keccak256("r1");
        uint256 pot = _openBuyCommit(1, alice, 3, seed);
        vm.prank(signer); esc.rolloverRound(1, seed);
        assertEq(esc.jackpot(), pot, "jackpot seeded");
        assertEq(_status(1), uint8(5), "RolledOver");

        vm.prank(owner); esc.voidRolledOver(1);
        assertEq(esc.jackpot(), 0, "jackpot reversed");
        assertEq(_status(1), uint8(4), "Voided");

        // alice gets back EXACTLY what she paid (3 * ENTRY); net balance made whole.
        vm.prank(alice); esc.refund(1);
        assertEq(tok.balanceOf(alice), 1_000_000 ether, "alice made whole");
        // refund is one-shot
        vm.prank(alice); vm.expectRevert(bytes("nothing")); esc.refund(1);
    }

    function test_voidRolledOver_only_owner() public {
        bytes32 seed = keccak256("r1");
        _openBuyCommit(1, alice, 3, seed);
        vm.prank(signer); esc.rolloverRound(1, seed);
        vm.prank(bob); vm.expectRevert(bytes("only owner")); esc.voidRolledOver(1);
        vm.prank(signer); vm.expectRevert(bytes("only owner")); esc.voidRolledOver(1);
    }

    function test_voidRolledOver_requires_rolledover_status() public {
        bytes32 seed = keccak256("r1");
        _openBuyCommit(1, alice, 3, seed); // Committed, not rolled over
        vm.prank(owner); vm.expectRevert(bytes("not rolled over")); esc.voidRolledOver(1);
    }

    // Once a later winner has swept the jackpot, the rolled funds are gone and cannot be clawed back.
    function test_voidRolledOver_reverts_if_jackpot_drawn() public {
        bytes32 s1 = keccak256("r1");
        uint256 pot1 = _openBuyCommit(1, alice, 3, s1);
        vm.prank(signer); esc.rolloverRound(1, s1);
        assertEq(esc.jackpot(), pot1);

        bytes32 s2 = keccak256("r2");
        uint256 pot2 = _openBuyCommit(2, bob, 3, s2);
        uint256 rake2 = uint256(pot2) * RAKE / 10000;
        address[] memory w = new address[](1); w[0] = bob;
        uint256[] memory a = new uint256[](1); a[0] = pot2 - rake2 + pot1; // budget folds the jackpot
        vm.prank(signer); esc.settle(2, s2, w, a);
        assertEq(esc.jackpot(), 0, "jackpot consumed by the win");

        // the rolled funds already went to bob's payout -> cannot reverse round 1
        vm.prank(owner); vm.expectRevert(bytes("jackpot drawn")); esc.voidRolledOver(1);
    }
}
