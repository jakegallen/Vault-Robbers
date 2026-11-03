// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";
import {MockERC20} from "./MockERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice V6 tests: RANGE auto-buy. ONE player signature authorizes the relayer to enter the player into every round
/// in [roundStart, roundStart+roundCount); the relayer submits buyInForRange per round. Covers: multi-round off one sig,
/// per-round replay guard (rangeSpent), out-of-range + over-max + expired + bad-sig + non-relayer rejects, and
/// invalidateAutoBuy() revoking an outstanding range by bumping the nonce.
contract StandoffEscrowV6Test is Test {
    StandoffEscrow esc;
    MockERC20 tok;

    address owner = address(0x5afe);
    address signer = address(0x516e);
    address treasury = address(0x7ea5);
    address burn = address(0xdead);
    address relayer = address(0x7e1a);

    uint256 playerPk; // set in setUp
    address player;

    uint16 constant RAKE = 500;
    uint16 constant BURNSHARE = 5000;
    uint32 constant CHAL = 3600;
    uint128 constant ENTRY = 1000 ether;
    uint64  constant SENTINEL = 1_000_000;

    bytes32 constant AUTOBUY_RANGE_TYPEHASH = keccak256(
        "AutoBuyRange(uint256 roundStart,uint256 roundCount,address player,uint256 maxTickets,uint256 maxEntry,uint256 nonce,uint256 deadline)"
    );

    function setUp() public {
        vm.warp(1000);
        playerPk = 0xA11CE60D;
        player = vm.addr(playerPk);
        tok = new MockERC20();
        StandoffEscrow impl = new StandoffEscrow();
        bytes memory initData = abi.encodeCall(
            StandoffEscrow.initialize, (address(tok), owner, signer, treasury, burn, RAKE, BURNSHARE, CHAL)
        );
        esc = StandoffEscrow(address(new ERC1967Proxy(address(impl), initData)));
        vm.prank(owner); esc.setRelayer(relayer);
        tok.mint(player, 1_000_000 ether);
        vm.prank(player); tok.approve(address(esc), type(uint256).max);
    }

    function _open(uint256 id) internal {
        uint64 lock = uint64(block.timestamp) + SENTINEL;
        vm.prank(signer); esc.openRound(id, ENTRY, lock, lock + 10000);
    }

    function _tickets(uint256 id, address who) internal view returns (uint256) { return esc.tickets(id, who); }

    function _signRange(uint256 pk, uint256 roundStart, uint256 roundCount, address who, uint256 maxTickets, uint256 maxEntry, uint256 nonce, uint256 deadline) internal view returns (bytes memory sig) {
        bytes32 structHash = keccak256(abi.encode(AUTOBUY_RANGE_TYPEHASH, roundStart, roundCount, who, maxTickets, maxEntry, nonce, deadline));
        bytes32 digest = MessageHashUtils.toTypedDataHash(esc.domainSeparatorV4(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function test_version_is_6() public view { assertEq(esc.VERSION(), 9); } // repo source impl has since advanced to V9

    // ONE signature enters the player into 3 consecutive rounds via the relayer.
    function test_range_covers_many_rounds_one_sig() public {
        for (uint256 id = 10; id <= 12; id++) _open(id);
        uint256 dl = block.timestamp + 1 days;
        bytes memory sig = _signRange(playerPk, 10, 3, player, 2, ENTRY, 0, dl);
        for (uint256 id = 10; id <= 12; id++) {
            vm.prank(relayer); esc.buyInForRange(id, player, 2, 10, 3, 2, ENTRY, 0, dl, sig);
            assertEq(_tickets(id, player), 2, "seated 2 per round");
            assertTrue(esc.rangeSpent(player, id), "round marked spent");
        }
        // same sig can't double-buy a round
        vm.prank(relayer); vm.expectRevert(bytes("round already bought")); esc.buyInForRange(10, player, 1, 10, 3, 2, ENTRY, 0, dl, sig);
    }

    function test_range_rejects_out_of_range() public {
        _open(20);
        uint256 dl = block.timestamp + 1 days;
        bytes memory sig = _signRange(playerPk, 10, 3, player, 2, ENTRY, 0, dl);
        // sign range [10,13) but try to buy round 20
        vm.prank(relayer); vm.expectRevert(bytes("round out of range"));
        esc.buyInForRange(20, player, 1, 10, 3, 2, ENTRY, 0, dl, sig);
    }

    function test_range_rejects_over_max_tickets() public {
        _open(10);
        uint256 dl = block.timestamp + 1 days;
        bytes memory sig = _signRange(playerPk, 10, 3, player, 2, ENTRY, 0, dl);
        vm.prank(relayer); vm.expectRevert(bytes("over authorized tickets"));
        esc.buyInForRange(10, player, 3, 10, 3, 2, ENTRY, 0, dl, sig);
    }

    function test_range_rejects_expired_and_nonrelayer_and_badsig() public {
        _open(10);
        uint256 dl = block.timestamp + 1 days;
        bytes memory sig = _signRange(playerPk, 10, 3, player, 2, ENTRY, 0, dl);
        // non-relayer
        vm.prank(owner); vm.expectRevert(bytes("not relayer")); esc.buyInForRange(10, player, 1, 10, 3, 2, ENTRY, 0, dl, sig);
        // expired
        vm.prank(relayer); vm.expectRevert(bytes("auth expired")); esc.buyInForRange(10, player, 1, 10, 3, 2, ENTRY, 0, block.timestamp - 1, sig);
        // bad sig: wrong signer
        bytes memory bad = _signRange(0xBADBEEF, 10, 3, player, 2, ENTRY, 0, dl);
        vm.prank(relayer); vm.expectRevert(bytes("bad auth sig")); esc.buyInForRange(10, player, 1, 10, 3, 2, ENTRY, 0, dl, bad);
    }

    // invalidateAutoBuy bumps the player's nonce -> an outstanding range (signed over the old nonce) stops verifying.
    function test_invalidate_revokes_outstanding_range() public {
        _open(10);
        uint256 dl = block.timestamp + 1 days;
        bytes memory sig = _signRange(playerPk, 10, 3, player, 2, ENTRY, 0, dl);
        vm.prank(player); esc.invalidateAutoBuy();
        assertEq(esc.autoBuyNonce(player), 1, "nonce bumped");
        vm.prank(relayer); vm.expectRevert(bytes("bad nonce")); esc.buyInForRange(10, player, 1, 10, 3, 2, ENTRY, 0, dl, sig);
    }
}
