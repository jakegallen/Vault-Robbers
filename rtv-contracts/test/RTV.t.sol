// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RobbingTheVault} from "../src/RobbingTheVault.sol";
import {MockRVLT} from "../src/MockRVLT.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract RTVTest is Test {
    RobbingTheVault vault;
    MockRVLT rvlt;
    uint256 opPk = 0xA11CE;
    address operator;
    address owner = address(0xB0B);
    address player = address(0xCAFE);
    uint256 constant FEE = 2500 ether;
    uint256 gameEnd;

    function setUp() public {
        operator = vm.addr(opPk);
        gameEnd = block.timestamp + 60 days;
        rvlt = new MockRVLT();
        RobbingTheVault impl = new RobbingTheVault();
        bytes memory init = abi.encodeCall(RobbingTheVault.initialize, (address(rvlt), operator, owner, FEE, gameEnd));
        vault = RobbingTheVault(payable(address(new ERC1967Proxy(address(impl), init))));
        rvlt.mint(player, 100_000 ether);
        vm.prank(player);
        rvlt.approve(address(vault), type(uint256).max);
    }

    function _sig(bytes32 runId, uint8 stage, bool robbed) internal view returns (bytes memory) {
        bytes32 digest = vault.settleDigest(runId, stage, robbed);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(opPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _enter(bytes32 runId, bytes32 seed) internal {
        vm.prank(player);
        vault.enter(runId, keccak256(abi.encodePacked(seed)));
    }

    function testEnterBurnsAndPots() public {
        _enter("run1", "seedA");
        assertEq(vault.totalBurned(), 1250 ether, "burn half");
        assertEq(vault.potRvlt(), 1250 ether, "pot half");
        assertEq(rvlt.balanceOf(vault.DEAD()), 1250 ether, "dead got burn");
        assertEq(vault.totalPlays(), 1);
    }

    function testCashoutPaysShareOfPot() public {
        // three entries build the pot to 3750 RVLT
        _enter("r1", "s1"); _enter("r2", "s2"); _enter("r3", "s3");
        assertEq(vault.potRvlt(), 3750 ether);
        uint256 before = rvlt.balanceOf(player);
        // settle r1 at stage 5 => 5% of pot
        vault.settle("r1", 5, false, "s1", _sig("r1", 5, false));
        uint256 paid = rvlt.balanceOf(player) - before;
        assertEq(paid, 3750 ether * 500 / 10000, "5% of pot");
        assertEq(vault.potRvlt(), 3750 ether - paid, "pot reduced");
    }

    function testCoreTakesAllEthAndPot() public {
        _enter("r1", "s1"); _enter("r2", "s2");
        vm.deal(address(vault), 5 ether); // seed the ETH vault
        uint256 pot = vault.potRvlt();
        uint256 rBefore = rvlt.balanceOf(player);
        vault.settle("r1", 10, true, "s1", _sig("r1", 10, true));
        assertEq(player.balance, 5 ether, "100% ETH claimed");
        assertEq(rvlt.balanceOf(player) - rBefore, pot, "100% of pot");
        assertEq(vault.potRvlt(), 0, "pot drained");
        assertEq(address(vault).balance, 0, "vault drained");
        assertEq(vault.robs(), 1);
    }

    function testBustClosesWithNoPay() public {
        _enter("r1", "s1"); _enter("r2", "s2");
        uint256 pot = vault.potRvlt();
        uint256 rBefore = rvlt.balanceOf(player);
        vault.settle("r1", 3, false, "s1", _sig("r1", 3, false)); // busted at 3 (<5)
        assertEq(rvlt.balanceOf(player), rBefore, "no payout on bust");
        assertEq(vault.potRvlt(), pot, "pot unchanged");
    }

    function testBadRevealReverts() public {
        _enter("r1", "s1");
        bytes memory sig = _sig("r1", 5, false);
        vm.expectRevert(bytes("bad reveal"));
        vault.settle("r1", 5, false, "WRONG", sig);
    }

    function testBadOperatorSigReverts() public {
        _enter("r1", "s1");
        // sign with a non-operator key
        bytes32 digest = vault.settleDigest("r1", 5, false);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        vm.expectRevert(bytes("bad operator sig"));
        vault.settle("r1", 5, false, "s1", abi.encodePacked(r, s, v));
    }

    function testDoubleSettleReverts() public {
        _enter("r1", "s1"); _enter("r2", "s2");
        vault.settle("r1", 5, false, "s1", _sig("r1", 5, false));
        bytes memory sig2 = _sig("r1", 5, false);
        vm.expectRevert(bytes("not open"));
        vault.settle("r1", 5, false, "s1", sig2);
    }

    function testOnlyOwnerUpgradeAndAdmin() public {
        vm.expectRevert();
        vault.setFee(1 ether); // not owner
        vm.prank(owner);
        vault.setFee(1000 ether);
        assertEq(vault.fee(), 1000 ether);
    }

    // ---- gameEnd timelock + drain ----

    function testEntryClosesAtGameEnd() public {
        vm.warp(gameEnd);
        vm.prank(player);
        vm.expectRevert(bytes("game over"));
        vault.enter("late", keccak256(abi.encodePacked(bytes32("x"))));
    }

    function testDrainBeforeEndReverts() public {
        _enter("r1", "s1");
        vm.deal(address(vault), 1 ether);
        vm.prank(owner);
        vm.expectRevert(bytes("game not over"));
        vault.drain(owner);
    }

    function testDrainAfterEndSweepsEthAndPot() public {
        _enter("r1", "s1"); _enter("r2", "s2");
        vm.deal(address(vault), 3 ether);
        assertGt(vault.potRvlt(), 0);
        vm.warp(gameEnd);
        vm.prank(owner);
        vault.drain(owner);
        assertEq(address(vault).balance, 0, "eth swept");
        assertEq(rvlt.balanceOf(address(vault)), 0, "rvlt swept");
        assertEq(vault.potRvlt(), 0, "pot zeroed");
        assertEq(owner.balance, 3 ether, "owner got eth");
    }

    function testDrainOnlyOwner() public {
        vm.warp(gameEnd);
        vm.expectRevert();
        vault.drain(player); // not owner
    }

    function testSetGameEndCannotShorten() public {
        vm.prank(owner);
        vm.expectRevert(bytes("cannot shorten"));
        vault.setGameEnd(gameEnd - 1);
        vm.prank(owner);
        vault.setGameEnd(gameEnd + 10 days);
        assertEq(vault.gameEnd(), gameEnd + 10 days);
    }

    function testSeedPotAddsToPayablePot() public {
        uint256 beforePot = vault.potRvlt();
        vm.prank(player);
        vault.seedPot(5000 ether);   // player approved max in setUp
        assertEq(vault.potRvlt(), beforePot + 5000 ether, "pot += seed");
        assertEq(rvlt.balanceOf(address(vault)), beforePot + 5000 ether, "rvlt held");
        // seeded pot is payable exactly like entry-built pot: settle a run at stage 5 pays 5% of the (now-seeded) pot
        _enter("s1", "seed1");
        uint256 pot = vault.potRvlt();
        uint256 before = rvlt.balanceOf(player);
        vault.settle("s1", 5, false, "seed1", _sig("s1", 5, false));
        assertEq(rvlt.balanceOf(player) - before, pot * 500 / 10000, "5% of seeded pot paid");
    }

    function testSeedPotZeroReverts() public {
        vm.prank(player);
        vm.expectRevert(bytes("zero"));
        vault.seedPot(0);
    }
}
