// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";
import {MockERC20} from "./MockERC20.sol";
import {MockERC721} from "./MockERC721.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice V4 (on-chain holder half-price) feature tests. Holders of the Vault Robber NFT pay a DISCOUNTED
/// per-ticket price (default 5000 bps = 50% off); the pot receives the discounted amount (no treasury top-up).
/// Covers: holder vs non-holder buyIn, buyInFor for holder/non-holder (+maxEntry bound), mixed rounds and
/// settle math, setter bounds, 0-discount sanity, and discount-aware refunds on a voided mixed round.
contract StandoffEscrowV4Test is Test {
    StandoffEscrow esc;
    MockERC20 tok;
    MockERC721 nft;

    address owner = address(0x5afe);
    address signer = address(0x516e);
    address treasury = address(0x7ea5);
    address burn = address(0xdead);
    address relayer = address(0x7e1a);

    address alice = address(0xa11ce); // will be an NFT holder
    address bob = address(0xb0b);     // non-holder

    // player with a known key for EIP-712 auto-buy; made a holder in setUp
    uint256 playerPk = 0xA11CE5EED;
    address player;
    // a non-holder player with a known key
    uint256 nhPk = 0xB0B5EED;
    address nhPlayer;

    uint16 constant RAKE = 500;       // 5%
    uint16 constant BURNSHARE = 5000; // 50% of rake burned
    uint32 constant CHAL = 3600;
    uint128 constant ENTRY = 1000 ether;
    uint16 constant DISCOUNT = 5000;  // 50% off = half price
    uint64 constant SENTINEL = 1_000_000;

    bytes32 constant AUTOBUY_TYPEHASH = keccak256(
        "AutoBuy(uint256 roundId,address player,uint256 maxTickets,uint256 maxEntry,uint256 nonce,uint256 deadline)"
    );

    function setUp() public {
        vm.warp(1000);
        player = vm.addr(playerPk);
        nhPlayer = vm.addr(nhPk);

        tok = new MockERC20();
        nft = new MockERC721();

        StandoffEscrow impl = new StandoffEscrow();
        bytes memory initData = abi.encodeCall(
            StandoffEscrow.initialize, (address(tok), owner, signer, treasury, burn, RAKE, BURNSHARE, CHAL)
        );
        esc = StandoffEscrow(address(new ERC1967Proxy(address(impl), initData)));

        // owner wires the holder discount (upgrade path: set post-deploy via the Safe)
        vm.prank(owner); esc.setHolderNft(address(nft));
        vm.prank(owner); esc.setHolderDiscountBps(DISCOUNT);

        // fund + approve everyone; make alice and player NFT holders (bob and nhPlayer are not)
        address[4] memory users = [alice, bob, player, nhPlayer];
        for (uint256 i; i < users.length; ++i) {
            tok.mint(users[i], 1_000_000 ether);
            vm.prank(users[i]); tok.approve(address(esc), type(uint256).max);
        }
        nft.mint(alice);
        nft.mint(player);
    }

    function _open(uint256 id) internal {
        uint64 lock = uint64(block.timestamp) + 100;
        vm.prank(signer); esc.openRound(id, ENTRY, lock, lock + 1000);
    }

    function _openSentinel(uint256 id) internal {
        uint64 lock = uint64(block.timestamp) + SENTINEL;
        vm.prank(signer); esc.openRound(id, ENTRY, lock, lock + 10000);
    }

    function _pot(uint256 id) internal view returns (uint128 pot) {
        ( , pot,,,,,,,,,, ) = esc.rounds(id);
    }

    function _signAutoBuy(
        uint256 pk, address who, uint256 id, uint256 maxTickets, uint256 maxEntry, uint256 nonce, uint256 deadline
    ) internal view returns (bytes memory sig) {
        bytes32 structHash = keccak256(abi.encode(AUTOBUY_TYPEHASH, id, who, maxTickets, maxEntry, nonce, deadline));
        bytes32 digest = MessageHashUtils.toTypedDataHash(esc.domainSeparatorV4(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    // ---------------------------------------------------------------------
    // config / views
    // ---------------------------------------------------------------------
    function test_version_is_4() public view {
        assertEq(esc.VERSION(), 9); // repo source impl has since advanced to V9
    }

    function test_isHolder_reflects_nft_balance() public view {
        assertTrue(esc.isHolder(alice));
        assertTrue(esc.isHolder(player));
        assertFalse(esc.isHolder(bob));
        assertFalse(esc.isHolder(nhPlayer));
    }

    function test_entryPriceFor_holder_vs_nonholder() public {
        uint256 id = 1; _open(id);
        assertEq(esc.entryPriceFor(id, alice), ENTRY / 2); // half
        assertEq(esc.entryPriceFor(id, bob), ENTRY);       // full
    }

    function test_holder_views_owner_only_and_bounds() public {
        // setters are owner-gated
        vm.expectRevert(); esc.setHolderNft(address(nft));
        vm.expectRevert(); esc.setHolderDiscountBps(1000);
        // bps bound: >= BPS reverts (BPS would make tickets FREE), BPS-1 is the ceiling
        vm.expectRevert(bytes("bad bps"));
        vm.prank(owner); esc.setHolderDiscountBps(10001);
        vm.expectRevert(bytes("bad bps"));
        vm.prank(owner); esc.setHolderDiscountBps(10000); // full BPS (free ticket) rejected
        vm.prank(owner); esc.setHolderDiscountBps(9999);  // near-free but nonzero ceiling ok
        assertEq(esc.holderDiscountBps(), 9999);
    }

    function test_no_holderNft_means_no_discount() public {
        // clearing the NFT disables the discount entirely even with a non-zero bps
        vm.prank(owner); esc.setHolderNft(address(0));
        assertFalse(esc.isHolder(alice));
        uint256 id = 1; _open(id);
        assertEq(esc.entryPriceFor(id, alice), ENTRY); // full price now
    }

    // ---------------------------------------------------------------------
    // buyIn: holder half, non-holder full, pot reflects the discount
    // ---------------------------------------------------------------------
    function test_buyIn_holder_charged_half_pot_half() public {
        uint256 id = 1; _open(id);
        uint256 before = tok.balanceOf(alice);
        vm.prank(alice); esc.buyIn(id, 2); // holder: 2 * (ENTRY/2) = ENTRY
        assertEq(before - tok.balanceOf(alice), ENTRY);     // charged exactly half per ticket
        assertEq(_pot(id), uint128(ENTRY));                 // pot increased by the discounted amount
        assertEq(esc.roundPaid(id, alice), ENTRY);          // paid tracked for refunds
    }

    function test_buyIn_nonholder_charged_full() public {
        uint256 id = 1; _open(id);
        uint256 before = tok.balanceOf(bob);
        vm.prank(bob); esc.buyIn(id, 2); // non-holder: 2 * ENTRY
        assertEq(before - tok.balanceOf(bob), 2 * ENTRY);
        assertEq(_pot(id), uint128(2 * ENTRY));
    }

    function test_zero_discount_holder_pays_full() public {
        vm.prank(owner); esc.setHolderDiscountBps(0); // sanity: 0 discount => holders pay full
        uint256 id = 1; _open(id);
        uint256 before = tok.balanceOf(alice);
        vm.prank(alice); esc.buyIn(id, 1);
        assertEq(before - tok.balanceOf(alice), ENTRY);
        assertEq(esc.entryPriceFor(id, alice), ENTRY);
    }

    // ---------------------------------------------------------------------
    // buyInFor: holder half (maxEntry bound), non-holder full
    // ---------------------------------------------------------------------
    function test_buyInFor_holder_charged_half_respects_maxEntry() public {
        vm.prank(owner); esc.setRelayer(relayer);
        uint256 id = 1; _openSentinel(id);
        uint256 dl = block.timestamp + 1000;
        // player signs with maxEntry = ENTRY (ceiling); discounted price (ENTRY/2) must be <= maxEntry
        bytes memory sig = _signAutoBuy(playerPk, player, id, 3, ENTRY, 0, dl);
        uint256 before = tok.balanceOf(player);
        vm.prank(relayer); esc.buyInFor(id, player, 2, 3, ENTRY, dl, 0, sig);
        assertEq(before - tok.balanceOf(player), ENTRY); // 2 * half = ENTRY
        assertEq(_pot(id), uint128(ENTRY));
        assertEq(esc.tickets(id, player), 2);
    }

    function test_buyInFor_holder_maxEntry_can_be_the_discounted_price() public {
        // a tight authorization: player signs maxEntry = ENTRY/2 (the discounted price). It must pass.
        vm.prank(owner); esc.setRelayer(relayer);
        uint256 id = 1; _openSentinel(id);
        uint256 dl = block.timestamp + 1000;
        bytes memory sig = _signAutoBuy(playerPk, player, id, 3, ENTRY / 2, 0, dl);
        vm.prank(relayer); esc.buyInFor(id, player, 1, 3, ENTRY / 2, dl, 0, sig);
        assertEq(esc.tickets(id, player), 1);
        assertEq(_pot(id), uint128(ENTRY / 2));
    }

    function test_buyInFor_nonholder_charged_full() public {
        vm.prank(owner); esc.setRelayer(relayer);
        uint256 id = 1; _openSentinel(id);
        uint256 dl = block.timestamp + 1000;
        bytes memory sig = _signAutoBuy(nhPk, nhPlayer, id, 3, ENTRY, 0, dl);
        uint256 before = tok.balanceOf(nhPlayer);
        vm.prank(relayer); esc.buyInFor(id, nhPlayer, 2, 3, ENTRY, dl, 0, sig);
        assertEq(before - tok.balanceOf(nhPlayer), 2 * ENTRY); // full price for a non-holder
        assertEq(_pot(id), uint128(2 * ENTRY));
    }

    function test_buyInFor_nonholder_entry_over_max_still_reverts() public {
        // a non-holder's charged price IS the full entry, so maxEntry below entry must still revert
        vm.prank(owner); esc.setRelayer(relayer);
        uint256 id = 1; _openSentinel(id);
        uint256 dl = block.timestamp + 1000;
        bytes memory sig = _signAutoBuy(nhPk, nhPlayer, id, 3, ENTRY - 1, 0, dl);
        vm.expectRevert(bytes("entry over max"));
        vm.prank(relayer); esc.buyInFor(id, nhPlayer, 1, 3, ENTRY - 1, dl, 0, sig);
    }

    // ---------------------------------------------------------------------
    // mixed round: holder + non-holder, pot = sum of their entries, settle pays pot - snapshot rake
    // ---------------------------------------------------------------------
    function test_mixed_round_pot_and_settle() public {
        uint256 id = 1; _open(id);
        // alice (holder) buys 2 -> pays ENTRY; bob (non-holder) buys 2 -> pays 2*ENTRY
        vm.prank(alice); esc.buyIn(id, 2);
        vm.prank(bob); esc.buyIn(id, 2);
        uint256 expectedPot = ENTRY + 2 * ENTRY; // 1000 + 2000 = 3000
        assertEq(_pot(id), uint128(expectedPot));

        vm.warp(block.timestamp + 101);
        bytes32 seed = keccak256("mix");
        vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));

        // rake = 5% of 3000 = 150; budget 2850 to the winner (bob)
        uint256 rake = expectedPot * RAKE / 10000;
        uint256 budget = expectedPot - rake;
        address[] memory w = new address[](1); w[0] = bob;
        uint256[] memory a = new uint256[](1); a[0] = budget;
        vm.prank(signer); esc.settle(id, seed, w, a);

        vm.warp(block.timestamp + CHAL);
        uint256 bBefore = tok.balanceOf(bob);
        vm.prank(bob); esc.claim(id);
        assertEq(tok.balanceOf(bob) - bBefore, budget);

        esc.payRake(id);
        // rake 150 -> 50% burn / 50% treasury = 75 / 75
        assertEq(tok.balanceOf(burn), rake / 2);
        assertEq(tok.balanceOf(treasury), rake / 2);
        assertEq(tok.balanceOf(address(esc)), 0); // escrow fully drained: pot == budget + rake
    }

    // ---------------------------------------------------------------------
    // voided mixed round: each refunds EXACTLY what they paid (discount-aware), escrow drains to 0
    // ---------------------------------------------------------------------
    function test_mixed_round_void_refunds_actual_paid() public {
        uint256 id = 1; _open(id);
        vm.prank(alice); esc.buyIn(id, 2); // holder paid ENTRY
        vm.prank(bob); esc.buyIn(id, 2);   // non-holder paid 2*ENTRY

        vm.warp(block.timestamp + 2000); // past deadline, never settled
        esc.voidRound(id);

        uint256 aBefore = tok.balanceOf(alice);
        uint256 bBefore = tok.balanceOf(bob);
        vm.prank(alice); esc.refund(id);
        vm.prank(bob); esc.refund(id);
        assertEq(tok.balanceOf(alice) - aBefore, ENTRY);     // holder got back exactly half-price*2
        assertEq(tok.balanceOf(bob) - bBefore, 2 * ENTRY);   // non-holder got back full
        assertEq(tok.balanceOf(address(esc)), 0);            // no over/under-refund
    }

    // sanity: a holder who sold the NFT after buying still gets back ONLY what they paid (not entry*tickets)
    function test_void_refund_uses_paid_not_live_holder_status() public {
        uint256 id = 1; _open(id);
        vm.prank(alice); esc.buyIn(id, 2); // paid ENTRY at half price (holder at buy time)
        // alice transfers her NFT away -> now a non-holder at refund time
        vm.prank(alice); nft.transferFrom(alice, bob, 1);
        assertFalse(esc.isHolder(alice));

        vm.warp(block.timestamp + 2000);
        esc.voidRound(id);
        uint256 aBefore = tok.balanceOf(alice);
        vm.prank(alice); esc.refund(id);
        assertEq(tok.balanceOf(alice) - aBefore, ENTRY); // exactly what was paid, NOT entry*2
        assertEq(tok.balanceOf(address(esc)), 0);
    }
}
