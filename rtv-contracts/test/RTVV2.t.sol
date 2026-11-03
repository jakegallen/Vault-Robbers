// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RobbingTheVault} from "../src/RobbingTheVault.sol";
import {RobbingTheVaultV2} from "../src/RobbingTheVaultV2.sol";
import {MockRVLT} from "../src/MockRVLT.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// Tests the REAL upgrade path: deploy V1 proxy, build state, upgrade to V2, then exercise the new economics.
contract RTVV2Test is Test {
    RobbingTheVaultV2 vault;   // proxy, cast to V2 after upgrade
    MockRVLT rvlt;
    uint256 opPk = 0xA11CE;
    address operator;
    address owner = address(0xB0B);
    address player = address(0xCAFE);
    address player2 = address(0xD00D);
    uint256 constant FEE = 2500 ether;
    uint256 gameEnd;

    function setUp() public {
        operator = vm.addr(opPk);
        gameEnd = block.timestamp + 60 days;
        rvlt = new MockRVLT();
        // deploy V1 behind the proxy (as mainnet is today)
        RobbingTheVault implV1 = new RobbingTheVault();
        bytes memory init = abi.encodeCall(RobbingTheVault.initialize, (address(rvlt), operator, owner, FEE, gameEnd));
        address proxy = address(new ERC1967Proxy(address(implV1), init));
        // fund players
        rvlt.mint(player, 1_000_000 ether); rvlt.mint(player2, 1_000_000 ether);
        vm.prank(player);  rvlt.approve(proxy, type(uint256).max);
        vm.prank(player2); rvlt.approve(proxy, type(uint256).max);
        // build some V1 state so we can prove it survives the upgrade
        vm.prank(player);  RobbingTheVault(payable(proxy)).enter("pre1", keccak256(abi.encodePacked(bytes32("s1"))));
        vm.prank(player2); RobbingTheVault(payable(proxy)).enter("pre2", keccak256(abi.encodePacked(bytes32("s2"))));
        uint256 potBefore = RobbingTheVault(payable(proxy)).potRvlt();
        assertEq(potBefore, 2500 ether, "pot from 2 entries");
        // UPGRADE to V2 + run the migration initializer
        RobbingTheVaultV2 implV2 = new RobbingTheVaultV2();
        vm.prank(owner);
        RobbingTheVault(payable(proxy)).upgradeToAndCall(address(implV2), abi.encodeCall(RobbingTheVaultV2.initializeV2, ()));
        vault = RobbingTheVaultV2(payable(proxy));
        // state preserved across the upgrade
        assertEq(vault.potRvlt(), potBefore, "pot preserved through upgrade");
        assertEq(vault.totalPlays(), 2, "plays preserved");
        assertEq(vault.coreCooldown(), 3 days, "V2 cooldown initialized");
        // apply the new ladder (owner setLadder — same batch the Safe runs on mainnet)
        vm.startPrank(owner);
        vault.setLadder(5, 100); vault.setLadder(6, 300); vault.setLadder(7, 1000); vault.setLadder(8, 2000); vault.setLadder(9, 3000);
        vm.stopPrank();
    }

    function _sig(bytes32 runId, uint8 stage, bool robbed) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(opPk, vault.settleDigest(runId, stage, robbed));
        return abi.encodePacked(r, s, v);
    }
    function _enter(address who, bytes32 runId, bytes32 seed) internal {
        vm.prank(who); vault.enter(runId, keccak256(abi.encodePacked(seed)));
    }

    function testNewLadderCashout() public {
        _enter(player, "r1", "s1");
        uint256 pot = vault.potRvlt();
        uint256 before = rvlt.balanceOf(player);
        vault.settle("r1", 5, false, "s1", _sig("r1", 5, false));   // chamber 5 = 1%
        assertEq(rvlt.balanceOf(player) - before, pot * 100 / 10000, "1% of pot");
    }

    function testDeepLadderCashout() public {
        _enter(player, "r9", "s9");
        uint256 pot = vault.potRvlt();
        uint256 before = rvlt.balanceOf(player);
        vault.settle("r9", 9, false, "s9", _sig("r9", 9, false));   // chamber 9 = 30%
        assertEq(rvlt.balanceOf(player) - before, pot * 3000 / 10000, "30% of pot");
    }

    function testSettleRejectsCore() public {
        _enter(player, "r1", "s1");
        bytes memory sig = _sig("r1", 10, true);
        vm.expectRevert(bytes("core: use crackCore"));
        vault.settle("r1", 10, true, "s1", sig);
    }

    function testCrackCoreTakeEth() public {
        _enter(player, "r1", "s1");
        vm.deal(address(vault), 5 ether);
        uint256 pot = vault.potRvlt();
        uint256 rBefore = rvlt.balanceOf(player);
        vault.crackCore("r1", true, "s1", _sig("r1", 10, true));
        assertEq(player.balance, 5 ether, "took 100% ETH");
        assertEq(rvlt.balanceOf(player), rBefore, "no RVLT taken");
        assertEq(vault.potRvlt(), pot, "pot untouched");
        assertEq(address(vault).balance, 0, "ETH vault emptied");
        assertEq(vault.robs(), 1);
    }

    function testCrackCoreTakePot() public {
        _enter(player, "r1", "s1");
        vm.deal(address(vault), 5 ether);
        uint256 pot = vault.potRvlt();
        uint256 rBefore = rvlt.balanceOf(player);
        vault.crackCore("r1", false, "s1", _sig("r1", 10, true));
        assertEq(rvlt.balanceOf(player) - rBefore, pot, "took 100% of pot");
        assertEq(vault.potRvlt(), 0, "pot drained");
        assertEq(player.balance, 0, "no ETH taken");
        assertEq(address(vault).balance, 5 ether, "ETH vault untouched");
    }

    function testCoreCooldownBlocksThenAllows() public {
        _enter(player, "r1", "s1");
        _enter(player, "r2", "s2");
        vm.deal(address(vault), 10 ether);
        vault.crackCore("r1", true, "s1", _sig("r1", 10, true));   // first crack ok
        bytes memory sig2 = _sig("r2", 10, true);
        vm.expectRevert(bytes("core cooldown"));
        vault.crackCore("r2", false, "s2", sig2);                  // within 3 days -> blocked
        vm.warp(block.timestamp + 3 days);
        vault.crackCore("r2", false, "s2", _sig("r2", 10, true));  // after 3 days -> ok
        assertEq(vault.robs(), 2);
    }

    function testNoDoubleClaimCore() public {
        _enter(player, "r1", "s1");
        vm.deal(address(vault), 2 ether);
        vault.crackCore("r1", true, "s1", _sig("r1", 10, true));
        bytes memory sig = _sig("r1", 10, true);
        vm.expectRevert(bytes("not open"));
        vault.crackCore("r1", true, "s1", sig);
    }

    function testCashoutStillWorksAfterUpgradeForPreExistingRun() public {
        // a run opened on V1 (pre2) must still settle correctly after the upgrade
        uint256 pot = vault.potRvlt();
        uint256 before = rvlt.balanceOf(player2);
        vault.settle("pre2", 5, false, "s2", _sig("pre2", 5, false));
        assertEq(rvlt.balanceOf(player2) - before, pot * 100 / 10000, "pre-upgrade run cashes at new 1%");
    }
}
