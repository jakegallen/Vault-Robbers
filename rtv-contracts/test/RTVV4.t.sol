// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RobbingTheVault} from "../src/RobbingTheVault.sol";
import {RobbingTheVaultV2} from "../src/RobbingTheVaultV2.sol";
import {RobbingTheVaultV3} from "../src/RobbingTheVaultV3.sol";
import {RobbingTheVaultV4} from "../src/RobbingTheVaultV4.sol";
import {MockRVLT} from "../src/MockRVLT.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// Tests the REAL mainnet upgrade path through to V4 (Buy-Burn-Earn capped ladder) + the capped-settle math + guards.
contract RTVV4Test is Test {
    RobbingTheVaultV4 vault;   // proxy, cast to V4 after upgrade
    MockRVLT rvlt;
    uint256 opPk = 0xA11CE;
    address operator;
    address owner = address(0xB0B);
    address sponsor = address(0x5900);
    address player = address(0xCAFE);
    address seeder = address(0x5EED);
    uint256 constant FEE = 2500 ether;
    uint256 gameEnd;

    function setUp() public {
        operator = vm.addr(opPk);
        gameEnd = block.timestamp + 60 days;
        rvlt = new MockRVLT();
        RobbingTheVault implV1 = new RobbingTheVault();
        bytes memory init = abi.encodeCall(RobbingTheVault.initialize, (address(rvlt), operator, owner, FEE, gameEnd));
        address proxy = address(new ERC1967Proxy(address(implV1), init));
        rvlt.mint(player, 1_000_000 ether); rvlt.mint(seeder, 50_000_000 ether);
        vm.prank(player); rvlt.approve(proxy, type(uint256).max);
        vm.prank(seeder); rvlt.approve(proxy, type(uint256).max);
        // V1 -> V2 -> V3 -> V4 (the real upgrade chain)
        RobbingTheVaultV2 implV2 = new RobbingTheVaultV2();
        vm.prank(owner); RobbingTheVault(payable(proxy)).upgradeToAndCall(address(implV2), abi.encodeCall(RobbingTheVaultV2.initializeV2, ()));
        RobbingTheVaultV3 implV3 = new RobbingTheVaultV3();
        vm.prank(owner); RobbingTheVaultV2(payable(proxy)).upgradeToAndCall(address(implV3), "");
        RobbingTheVaultV4 implV4 = new RobbingTheVaultV4();
        vm.prank(owner); RobbingTheVaultV3(payable(proxy)).upgradeToAndCall(address(implV4), abi.encodeCall(RobbingTheVaultV4.initializeV4, ()));
        vault = RobbingTheVaultV4(payable(proxy));
        vm.prank(owner); vault.setSponsor(sponsor);
    }

    function _sig(bytes32 runId, uint8 stage, bool robbed) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(opPk, vault.settleDigest(runId, stage, robbed));
        return abi.encodePacked(r, s, v);
    }

    // open a fresh run and force the pot to exactly `potTarget`
    function _openWithPot(bytes32 runId, uint256 potTarget) internal {
        vm.prank(player); vault.enter(runId, keccak256(abi.encodePacked(bytes32("s"))));
        uint256 pot = vault.potRvlt();
        if (potTarget > pot) { vm.prank(seeder); vault.seedPot(potTarget - pot); }
        assertEq(vault.potRvlt(), potTarget, "pot set");
    }

    function testInitV4SetsLadderCapsFloor() public view {
        assertEq(vault.cashoutMin(), 5);
        assertEq(vault.potLadderBps(5), 100);  assertEq(vault.payoutCap(5), 1_000 ether);
        assertEq(vault.potLadderBps(6), 300);  assertEq(vault.payoutCap(6), 3_000 ether);
        assertEq(vault.potLadderBps(7), 500);  assertEq(vault.payoutCap(7), 9_000 ether);
        assertEq(vault.potLadderBps(8), 1000); assertEq(vault.payoutCap(8), 800_000 ether);
        assertEq(vault.potLadderBps(9), 2500); assertEq(vault.payoutCap(9), 2_000_000 ether);
        assertEq(vault.potFloor(), 100_000 ether);
    }

    // deep tier at a HUGE pot: cap binds (this is the anti-farm guarantee)
    function testDeepTierCapBindsAtBigPot() public {
        _openWithPot("r", 10_000_000 ether);
        uint256 before = rvlt.balanceOf(player);
        vault.settle("r", 9, false, "s", _sig("r", 9, false));   // 25% of 10M = 2.5M, capped to 2M
        assertEq(rvlt.balanceOf(player) - before, 2_000_000 ether, "ch10 capped at 2M");
    }

    // deep tier below the cap: pays the percent
    function testDeepTierPctBelowCap() public {
        _openWithPot("r", 4_000_000 ether);
        uint256 before = rvlt.balanceOf(player);
        vault.settle("r", 9, false, "s", _sig("r", 9, false));   // 25% of 4M = 1M < 2M cap
        assertEq(rvlt.balanceOf(player) - before, 1_000_000 ether, "ch10 pays 25%");
    }

    // shallow tiers behave like fixed amounts at any real pot
    function testShallowTiersFixed() public {
        _openWithPot("r", 5_000_000 ether);
        uint256 before = rvlt.balanceOf(player);
        vault.settle("r", 5, false, "s", _sig("r", 5, false));   // 1% of 5M = 50k, capped to 1k
        assertEq(rvlt.balanceOf(player) - before, 1_000 ether, "ch6 fixed 1,000");
    }

    // floor guard: a payout can never take the pot below potFloor
    function testFloorGuard() public {
        _openWithPot("r", 100_400 ether);   // just above the 100k floor
        uint256 before = rvlt.balanceOf(player);
        vault.settle("r", 9, false, "s", _sig("r", 9, false));   // 25% would be 25,100 but only 400 is above floor
        assertEq(rvlt.balanceOf(player) - before, 400 ether, "clamped to pot - floor");
        assertEq(vault.potRvlt(), 100_000 ether, "pot never drops below floor");
    }

    // quoteCashout view matches what settle actually pays
    function testQuoteMatchesSettle() public {
        _openWithPot("r", 6_000_000 ether);
        uint256 q9 = vault.quoteCashout(9);
        uint256 before = rvlt.balanceOf(player);
        vault.settle("r", 9, false, "s", _sig("r", 9, false));
        assertEq(rvlt.balanceOf(player) - before, q9, "quote == payout");
        assertEq(q9, 1_500_000 ether, "25% of 6M");
    }

    // cap = 0 means uncapped (pure %), backward-compatible with V3 behavior
    function testUncappedWhenCapZero() public {
        vm.prank(owner); vault.setPayoutCap(9, 0);
        _openWithPot("r", 10_000_000 ether);
        uint256 before = rvlt.balanceOf(player);
        vault.settle("r", 9, false, "s", _sig("r", 9, false));   // 25% of 10M, no cap
        assertEq(rvlt.balanceOf(player) - before, 2_500_000 ether, "uncapped pays full 25%");
    }

    // core crack unchanged: winner takes 100% ETH
    function testCrackCoreEth() public {
        _openWithPot("r", 3_000_000 ether);
        vm.deal(address(vault), 2 ether);
        vault.crackCore("r", true, "s", _sig("r", 10, true));
        assertEq(player.balance, 2 ether, "core taker gets the ETH vault");
    }

    // core crack unchanged: winner can take 100% pot instead
    function testCrackCorePot() public {
        _openWithPot("r", 3_000_000 ether);
        uint256 before = rvlt.balanceOf(player);
        vault.crackCore("r", false, "s", _sig("r", 10, true));
        assertEq(rvlt.balanceOf(player) - before, 3_000_000 ether, "core taker can take 100% pot");
        assertEq(vault.potRvlt(), 0);
    }

    function testCapSetterOwnerOnly() public {
        vm.prank(player);
        vm.expectRevert();
        vault.setPayoutCap(9, 1);
        vm.prank(player);
        vm.expectRevert();
        vault.setPotFloor(1);
    }

    // farm-safety sanity: the two deepest caps are the ceiling on a single deep cash-out no matter the pot
    function testDeepCapsAreTheCeiling() public {
        _openWithPot("r", 50_000_000 ether);
        assertEq(vault.quoteCashout(8), 800_000 ether, "ch9 ceiling 800k");
        assertEq(vault.quoteCashout(9), 2_000_000 ether, "ch10 ceiling 2M");
    }
}
