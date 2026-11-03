// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";
import {MockERC20} from "./MockERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract StandoffEscrowTest is Test {
    StandoffEscrow esc;
    MockERC20 tok;

    address owner = address(0x5afe);
    address signer = address(0x516e);
    address treasury = address(0x7ea5);
    address burn = address(0xdead);
    address alice = address(0xa11ce);
    address bob = address(0xb0b);
    address carol = address(0xca401);

    uint16 constant RAKE = 500;   // 5%
    uint16 constant BURNSHARE = 5000; // 50% of rake burned
    uint32 constant CHAL = 3600; // contract enforces MIN_CHALLENGE (1h) floor
    uint128 constant ENTRY = 1000 ether;

    function setUp() public {
        tok = new MockERC20();
        StandoffEscrow impl = new StandoffEscrow();
        bytes memory initData = abi.encodeCall(
            StandoffEscrow.initialize, (address(tok), owner, signer, treasury, burn, RAKE, BURNSHARE, CHAL)
        );
        esc = StandoffEscrow(address(new ERC1967Proxy(address(impl), initData)));
        for (uint160 i; i < 3; ++i) {
            address u = [alice, bob, carol][i];
            tok.mint(u, 1_000_000 ether);
            vm.prank(u); tok.approve(address(esc), type(uint256).max);
        }
    }

    function _openAndFill() internal returns (uint256 id) {
        id = 1;
        uint64 lock = uint64(block.timestamp + 100);
        uint64 dead = lock + 1000;
        vm.prank(signer); esc.openRound(id, ENTRY, lock, dead);
        vm.prank(alice); esc.buyIn(id, 2); // 2000
        vm.prank(bob); esc.buyIn(id, 1);   // 1000
        vm.prank(carol); esc.buyIn(id, 1); // 1000  -> pot 4000
    }

    function test_HappyPath_settle_claim_rake() public {
        uint256 id = _openAndFill();
        ( , uint128 pot,,,,,,,,,, ) = esc.rounds(id);
        assertEq(pot, 4000 ether);
        vm.warp(block.timestamp + 101); // past lock

        bytes32 seed = keccak256("seed-1");
        vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));

        // pot 4000, rake 5% = 200, budget 3800 to the winner (alice)
        address[] memory w = new address[](1); w[0] = alice;
        uint256[] memory a = new uint256[](1); a[0] = 3800 ether;
        vm.prank(signer); esc.settle(id, seed, w, a);

        // cannot claim during window
        vm.expectRevert(bytes("challenge window"));
        vm.prank(alice); esc.claim(id);

        vm.warp(block.timestamp + CHAL);
        uint256 before = tok.balanceOf(alice);
        vm.prank(alice); esc.claim(id);
        assertEq(tok.balanceOf(alice) - before, 3800 ether);

        // rake split: 200 -> 100 burn + 100 treasury
        esc.payRake(id);
        assertEq(tok.balanceOf(burn), 100 ether);
        assertEq(tok.balanceOf(treasury), 100 ether);

        // escrow drained to zero
        assertEq(tok.balanceOf(address(esc)), 0);
        // double claim blocked
        vm.expectRevert(bytes("nothing"));
        vm.prank(alice); esc.claim(id);
    }

    function test_settle_rejects_nonparticipant() public {
        uint256 id = _openAndFill();
        vm.warp(block.timestamp + 101);
        bytes32 seed = keccak256("s"); vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));
        address[] memory w = new address[](1); w[0] = address(0xbeef); // never bought in
        uint256[] memory a = new uint256[](1); a[0] = 3800 ether;
        vm.expectRevert(bytes("winner not participant"));
        vm.prank(signer); esc.settle(id, seed, w, a);
    }

    function test_settle_rejects_bad_sum() public {
        uint256 id = _openAndFill();
        vm.warp(block.timestamp + 101);
        bytes32 seed = keccak256("s"); vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));
        address[] memory w = new address[](1); w[0] = alice;
        uint256[] memory a = new uint256[](1); a[0] = 3801 ether; // != pot - rake
        vm.expectRevert(bytes("payout != pot-rake+jackpot"));
        vm.prank(signer); esc.settle(id, seed, w, a);
    }

    function test_settle_rejects_wrong_seed() public {
        uint256 id = _openAndFill();
        vm.warp(block.timestamp + 101);
        vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(keccak256("real"))));
        address[] memory w = new address[](1); w[0] = alice;
        uint256[] memory a = new uint256[](1); a[0] = 3800 ether;
        vm.expectRevert(bytes("seed mismatch"));
        vm.prank(signer); esc.settle(id, keccak256("wrong"), w, a);
    }

    function test_split_multiple_winners() public {
        uint256 id = _openAndFill(); // pot 4000, rake 200, budget 3800
        vm.warp(block.timestamp + 101);
        bytes32 seed = keccak256("split"); vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));
        address[] memory w = new address[](2); w[0] = alice; w[1] = bob;
        uint256[] memory a = new uint256[](2); a[0] = 1900 ether; a[1] = 1900 ether;
        vm.prank(signer); esc.settle(id, seed, w, a);
        vm.warp(block.timestamp + CHAL);
        vm.prank(alice); esc.claim(id);
        vm.prank(bob); esc.claim(id);
        assertEq(tok.balanceOf(alice), 1_000_000 ether - 2000 ether + 1900 ether);
        assertEq(tok.balanceOf(bob), 1_000_000 ether - 1000 ether + 1900 ether);
    }

    function test_buyIn_blocked_after_lock() public {
        uint256 id = 1;
        uint64 lock = uint64(block.timestamp + 100);
        vm.prank(signer); esc.openRound(id, ENTRY, lock, lock + 1000);
        vm.warp(block.timestamp + 101);
        vm.expectRevert(bytes("locked"));
        vm.prank(alice); esc.buyIn(id, 1);
    }

    function test_void_unsettled_after_deadline_refunds() public {
        uint256 id = _openAndFill();
        // never settled; warp past deadline
        vm.warp(block.timestamp + 2000);
        esc.voidRound(id); // anyone
        uint256 aBefore = tok.balanceOf(alice);
        vm.prank(alice); esc.refund(id);
        assertEq(tok.balanceOf(alice) - aBefore, 2000 ether);
        vm.prank(bob); esc.refund(id);
        vm.prank(carol); esc.refund(id);
        assertEq(tok.balanceOf(address(esc)), 0); // fully refunded
    }

    function test_owner_void_during_window_fully_refundable() public {
        uint256 id = _openAndFill();
        vm.warp(block.timestamp + 101);
        bytes32 seed = keccak256("bad"); vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));
        address[] memory w = new address[](1); w[0] = alice;
        uint256[] memory a = new uint256[](1); a[0] = 3800 ether;
        vm.prank(signer); esc.settle(id, seed, w, a);
        // owner voids during challenge window (nothing was transferred at settle)
        vm.prank(owner); esc.voidRound(id);
        // everyone refunds full entry; rake was never paid
        vm.prank(alice); esc.refund(id);
        vm.prank(bob); esc.refund(id);
        vm.prank(carol); esc.refund(id);
        assertEq(tok.balanceOf(address(esc)), 0);
        assertEq(tok.balanceOf(burn), 0);
        assertEq(tok.balanceOf(treasury), 0);
    }

    function test_access_control() public {
        uint256 id = 1;
        uint64 lock = uint64(block.timestamp + 100);
        vm.expectRevert(bytes("not signer"));
        esc.openRound(id, ENTRY, lock, lock + 1000); // not signer

        vm.prank(signer); esc.openRound(id, ENTRY, lock, lock + 1000);
        vm.expectRevert(bytes("not signer"));
        esc.commit(id, keccak256("x"));

        vm.expectRevert(); // Ownable: not owner
        esc.setRake(100, 5000);
    }

    function test_rake_cap_enforced() public {
        vm.expectRevert(bytes("bad bps"));
        vm.prank(owner); esc.setRake(1001, 5000); // > MAX_RAKE_BPS
        vm.prank(owner); esc.setRake(1000, 10000); // ok at ceiling
        assertEq(esc.rakeBps(), 1000);
    }

    function test_payRake_once_and_after_window() public {
        uint256 id = _openAndFill();
        vm.warp(block.timestamp + 101);
        bytes32 seed = keccak256("r"); vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));
        address[] memory w = new address[](1); w[0] = alice;
        uint256[] memory a = new uint256[](1); a[0] = 3800 ether;
        vm.prank(signer); esc.settle(id, seed, w, a);
        vm.expectRevert(bytes("challenge window"));
        esc.payRake(id);
        vm.warp(block.timestamp + CHAL);
        esc.payRake(id);
        vm.expectRevert(bytes("rake paid"));
        esc.payRake(id);
    }

    function test_no_burn_full_rake_to_treasury() public {
        vm.prank(owner); esc.setRake(500, 0); // 5% rake, 0% burned -> 100% to treasury (the live config)
        uint256 id = _openAndFill(); // pot 4000, rake 200, budget 3800
        vm.warp(block.timestamp + 101);
        bytes32 seed = keccak256("nb"); vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));
        address[] memory w = new address[](1); w[0] = alice;
        uint256[] memory a = new uint256[](1); a[0] = 3800 ether;
        vm.prank(signer); esc.settle(id, seed, w, a);
        vm.warp(block.timestamp + CHAL);
        vm.prank(alice); esc.claim(id);
        esc.payRake(id);
        assertEq(tok.balanceOf(burn), 0);           // nothing burned
        assertEq(tok.balanceOf(treasury), 200 ether); // full rake to treasury
        assertEq(tok.balanceOf(address(esc)), 0);     // escrow fully drained
    }

    // ---- upgradeability (UUPS) ----
    function test_initialize_rejects_short_challenge() public {
        StandoffEscrow impl = new StandoffEscrow();
        bytes memory bad = abi.encodeCall(
            StandoffEscrow.initialize, (address(tok), owner, signer, treasury, burn, RAKE, BURNSHARE, uint32(60))
        );
        vm.expectRevert(bytes("challenge too short"));
        new ERC1967Proxy(address(impl), bad);
    }

    function test_impl_cannot_be_initialized_directly() public {
        StandoffEscrow impl = new StandoffEscrow();
        vm.expectRevert(); // InvalidInitialization: implementation disabled in constructor
        impl.initialize(address(tok), owner, signer, treasury, burn, RAKE, BURNSHARE, CHAL);
    }

    function test_only_owner_can_upgrade() public {
        StandoffEscrow v2 = new StandoffEscrow();
        vm.expectRevert(); // non-owner rejected by _authorizeUpgrade
        esc.upgradeToAndCall(address(v2), "");
        vm.prank(owner); esc.upgradeToAndCall(address(v2), ""); // owner (Safe) upgrades
        assertEq(esc.rakeBps(), RAKE); // storage + logic survive the upgrade
    }
}
