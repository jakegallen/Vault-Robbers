// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RobbingTheVault} from "../src/RobbingTheVault.sol";
import {RobbingTheVaultV2} from "../src/RobbingTheVaultV2.sol";
import {RobbingTheVaultV3} from "../src/RobbingTheVaultV3.sol";
import {MockRVLT} from "../src/MockRVLT.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// Tests the REAL mainnet upgrade path: V1 proxy (built state) -> V2 (live today) -> V3 (adds enterFor comps).
contract RTVV3Test is Test {
    RobbingTheVaultV3 vault;   // proxy, cast to V3 after upgrade
    MockRVLT rvlt;
    uint256 opPk = 0xA11CE;
    address operator;
    address owner = address(0xB0B);
    address sponsor = address(0x5900); // dedicated comp-funding wallet (0x411f… on mainnet)
    address player = address(0xCAFE);
    address player2 = address(0xD00D);
    uint256 constant FEE = 2500 ether;
    uint256 gameEnd;

    function setUp() public {
        operator = vm.addr(opPk);
        gameEnd = block.timestamp + 60 days;
        rvlt = new MockRVLT();
        RobbingTheVault implV1 = new RobbingTheVault();
        bytes memory init = abi.encodeCall(RobbingTheVault.initialize, (address(rvlt), operator, owner, FEE, gameEnd));
        address proxy = address(new ERC1967Proxy(address(implV1), init));
        rvlt.mint(player, 1_000_000 ether); rvlt.mint(player2, 1_000_000 ether); rvlt.mint(sponsor, 1_000_000 ether);
        vm.prank(player);  rvlt.approve(proxy, type(uint256).max);
        vm.prank(player2); rvlt.approve(proxy, type(uint256).max);
        vm.prank(sponsor); rvlt.approve(proxy, type(uint256).max);
        // V1 state
        vm.prank(player);  RobbingTheVault(payable(proxy)).enter("pre1", keccak256(abi.encodePacked(bytes32("s1"))));
        uint256 potV1 = RobbingTheVault(payable(proxy)).potRvlt();
        // -> V2
        RobbingTheVaultV2 implV2 = new RobbingTheVaultV2();
        vm.prank(owner);
        RobbingTheVault(payable(proxy)).upgradeToAndCall(address(implV2), abi.encodeCall(RobbingTheVaultV2.initializeV2, ()));
        // -> V3 (no initializer needed; empty call data, like the mainnet Safe tx)
        RobbingTheVaultV3 implV3 = new RobbingTheVaultV3();
        vm.prank(owner);
        RobbingTheVaultV2(payable(proxy)).upgradeToAndCall(address(implV3), "");
        vault = RobbingTheVaultV3(payable(proxy));
        // state preserved through BOTH upgrades
        assertEq(vault.potRvlt(), potV1, "pot preserved V1->V2->V3");
        assertEq(vault.totalPlays(), 1, "plays preserved");
        assertEq(vault.coreCooldown(), 3 days, "V2 cooldown preserved into V3");
        assertEq(vault.sponsoredPlays(), 0, "sponsoredPlays starts 0");
        // owner wires the new roles + ladder (the mainnet Safe batch)
        vm.startPrank(owner);
        vault.setSponsor(sponsor);
        vault.setLadder(5, 100); vault.setLadder(6, 300); vault.setLadder(7, 1000); vault.setLadder(8, 2000); vault.setLadder(9, 3000);
        vm.stopPrank();
        assertEq(vault.sponsor(), sponsor, "sponsor set");
    }

    function _sig(bytes32 runId, uint8 stage, bool robbed) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(opPk, vault.settleDigest(runId, stage, robbed));
        return abi.encodePacked(r, s, v);
    }

    function testEnterForCreditsPlayerAndBurnsLikeNormal() public {
        uint256 potBefore = vault.potRvlt();
        uint256 burnedBefore = vault.totalBurned();
        uint256 sponsorBefore = rvlt.balanceOf(sponsor);
        uint256 playerBefore = rvlt.balanceOf(player);

        vm.prank(sponsor);
        vault.enterFor(player, "c1", keccak256(abi.encodePacked(bytes32("cs1"))));

        // economics identical to a normal enter(): sponsor pays the whole fee, half burns, half to pot
        assertEq(rvlt.balanceOf(sponsor), sponsorBefore - FEE, "sponsor paid the fee");
        assertEq(rvlt.balanceOf(player), playerBefore, "player paid nothing");
        assertEq(vault.potRvlt(), potBefore + FEE / 2, "half the fee to pot");
        assertEq(vault.totalBurned(), burnedBefore + FEE / 2, "half burned");
        assertEq(vault.sponsoredPlays(), 1, "sponsored counter");
        // run is credited to the PLAYER, not the sponsor
        (address who,, , RobbingTheVaultV3.Status st) = vault.runs("c1");
        assertEq(who, player, "run credited to player");
        assertEq(uint8(st), uint8(RobbingTheVaultV3.Status.Open), "run open");
    }

    function testSponsoredRunCashesOutToPlayer() public {
        vm.prank(sponsor);
        vault.enterFor(player, "c1", keccak256(abi.encodePacked(bytes32("cs1"))));
        uint256 pot = vault.potRvlt();
        uint256 before = rvlt.balanceOf(player);
        vault.settle("c1", 9, false, "cs1", _sig("c1", 9, false));  // chamber 9 = 30%
        assertEq(rvlt.balanceOf(player) - before, pot * 3000 / 10000, "player gets 30% of pot");
    }

    function testSponsoredRunCanCrackCore() public {
        vm.prank(sponsor);
        vault.enterFor(player, "c1", keccak256(abi.encodePacked(bytes32("cs1"))));
        vm.deal(address(vault), 4 ether);
        vault.crackCore("c1", true, "cs1", _sig("c1", 10, true));
        assertEq(player.balance, 4 ether, "player takes the ETH vault");
        assertEq(vault.robs(), 1);
    }

    function testOperatorCannotEnterFor() public {
        vm.prank(operator);   // operator is deliberately NOT authorized — keeps it empty/sign-only
        vm.expectRevert(bytes("not authorized"));
        vault.enterFor(player, "c1", keccak256(abi.encodePacked(bytes32("cs1"))));
    }

    function testPlayerCannotEnterFor() public {
        vm.prank(player);
        vm.expectRevert(bytes("not authorized"));
        vault.enterFor(player, "c1", keccak256(abi.encodePacked(bytes32("cs1"))));
    }

    function testOwnerCanEnterForAsFallback() public {
        rvlt.mint(owner, FEE);
        vm.prank(owner); rvlt.approve(address(vault), type(uint256).max);
        vm.prank(owner);
        vault.enterFor(player, "c1", keccak256(abi.encodePacked(bytes32("cs1"))));
        (address who,,,) = vault.runs("c1");
        assertEq(who, player, "owner sponsored run credited to player");
    }

    function testEnterForRejectsDuplicateRun() public {
        vm.prank(sponsor);
        vault.enterFor(player, "c1", keccak256(abi.encodePacked(bytes32("cs1"))));
        vm.prank(sponsor);
        vm.expectRevert(bytes("run exists"));
        vault.enterFor(player2, "c1", keccak256(abi.encodePacked(bytes32("cs2"))));
    }

    function testEnterForRejectsZeroPlayer() public {
        vm.prank(sponsor);
        vm.expectRevert(bytes("no player"));
        vault.enterFor(address(0), "c1", keccak256(abi.encodePacked(bytes32("cs1"))));
    }

    function testEnterForBlockedWhenSponsorUnset() public {
        vm.prank(owner); vault.setSponsor(address(0));   // owner clears the sponsor role
        vm.prank(sponsor);                                // former sponsor is now unauthorized
        vm.expectRevert(bytes("not authorized"));
        vault.enterFor(player, "c1", keccak256(abi.encodePacked(bytes32("cs1"))));
    }

    function testEnterForBlockedWhenPaused() public {
        vm.prank(owner); vault.pause();
        vm.prank(sponsor);
        vm.expectRevert();   // Pausable EnforcedPause()
        vault.enterFor(player, "c1", keccak256(abi.encodePacked(bytes32("cs1"))));
    }

    function testEnterForBlockedAfterGameEnd() public {
        vm.warp(gameEnd + 1);
        vm.prank(sponsor);
        vm.expectRevert(bytes("game over"));
        vault.enterFor(player, "c1", keccak256(abi.encodePacked(bytes32("cs1"))));
    }

    function testSponsoredRunBustPaysNothing() public {
        vm.prank(sponsor);
        vault.enterFor(player, "c1", keccak256(abi.encodePacked(bytes32("cs1"))));
        uint256 pot = vault.potRvlt();
        uint256 before = rvlt.balanceOf(player);
        vault.settle("c1", 3, false, "cs1", _sig("c1", 3, false));   // below cashoutMin(5) -> 0
        assertEq(rvlt.balanceOf(player), before, "sub-teller cashout pays nothing");
        assertEq(vault.potRvlt(), pot, "pot untouched");
    }

    function testMultipleCompsForSameWallet() public {
        vm.prank(sponsor); vault.enterFor(player, "c1", keccak256(abi.encodePacked(bytes32("a"))));
        vm.prank(sponsor); vault.enterFor(player, "c2", keccak256(abi.encodePacked(bytes32("b"))));
        assertEq(vault.sponsoredPlays(), 2, "two sponsored runs for one wallet");
        (address w1,,,) = vault.runs("c1"); (address w2,,,) = vault.runs("c2");
        assertEq(w1, player); assertEq(w2, player);
    }

    function testNormalEnterStillWorks() public {
        uint256 potBefore = vault.potRvlt();
        vm.prank(player2);
        vault.enter("n1", keccak256(abi.encodePacked(bytes32("ns1"))));
        assertEq(vault.potRvlt(), potBefore + FEE / 2, "normal entry unaffected");
        (address who,,,) = vault.runs("n1");
        assertEq(who, player2, "normal run credited to msg.sender");
    }
}
