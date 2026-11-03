// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";
import {MockERC20} from "./MockERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice V2 (threshold-fill) feature tests: lockRound, per-wallet cap, buyInFor (EIP-712 auto-buy),
/// guardian-windowed void, and rake snapshotting. Mirrors the StandoffEscrow.t.sol harness.
contract StandoffEscrowV2Test is Test {
    StandoffEscrow esc;
    MockERC20 tok;

    address owner = address(0x5afe);
    address signer = address(0x516e);
    address treasury = address(0x7ea5);
    address burn = address(0xdead);
    address relayer = address(0x7e1a);
    address guardian = address(0x6a47);
    address alice = address(0xa11ce);
    address bob = address(0xb0b);
    address carol = address(0xca401);

    // player with a known private key so we can sign EIP-712 auto-buy authorizations
    uint256 playerPk = 0xA11CE5EED;
    address player; // = vm.addr(playerPk)

    uint16 constant RAKE = 500;       // 5%
    uint16 constant BURNSHARE = 5000; // 50% of rake burned
    uint32 constant CHAL = 3600;
    uint128 constant ENTRY = 1000 ether;
    uint64 constant SENTINEL = 1_000_000; // far-future-ish sentinel lockTime (seconds)

    bytes32 constant AUTOBUY_TYPEHASH = keccak256(
        "AutoBuy(uint256 roundId,address player,uint256 maxTickets,uint256 maxEntry,uint256 nonce,uint256 deadline)"
    );

    function setUp() public {
        vm.warp(1000); // move off zero so sentinel math is sane
        player = vm.addr(playerPk);
        tok = new MockERC20();
        StandoffEscrow impl = new StandoffEscrow();
        bytes memory initData = abi.encodeCall(
            StandoffEscrow.initialize, (address(tok), owner, signer, treasury, burn, RAKE, BURNSHARE, CHAL)
        );
        esc = StandoffEscrow(address(new ERC1967Proxy(address(impl), initData)));
        address[4] memory users = [alice, bob, carol, player];
        for (uint256 i; i < users.length; ++i) {
            tok.mint(users[i], 1_000_000 ether);
            vm.prank(users[i]); tok.approve(address(esc), type(uint256).max);
        }
    }

    // Open a round with a far-future sentinel lockTime (threshold-fill style).
    function _openSentinel(uint256 id) internal {
        uint64 lock = uint64(block.timestamp) + SENTINEL;
        uint64 dead = lock + 10000;
        vm.prank(signer); esc.openRound(id, ENTRY, lock, dead);
    }

    // ---------------------------------------------------------------------
    // 1. lockRound: happy path, only-earlier, onlySigner
    // ---------------------------------------------------------------------
    function test_lockRound_happy_closes_buyin_and_enables_commit() public {
        uint256 id = 1;
        _openSentinel(id);
        // buy-in open while sentinel is far out
        vm.prank(alice); esc.buyIn(id, 2);
        vm.prank(bob); esc.buyIn(id, 1);

        // signer locks NOW -> lockTime moves to block.timestamp
        vm.prank(signer); esc.lockRound(id);
        ( , , , uint64 lockTime,,,,,,,, ) = esc.rounds(id);
        assertEq(lockTime, uint64(block.timestamp));

        // buy-in now blocked
        vm.expectRevert(bytes("locked"));
        vm.prank(carol); esc.buyIn(id, 1);

        // commit now allowed (>= lockTime)
        bytes32 seed = keccak256("s");
        vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));
        ( , , , , , , , , StandoffEscrow.Status status, , , ) = esc.rounds(id);
        assertEq(uint256(status), uint256(StandoffEscrow.Status.Committed));
    }

    function test_lockRound_only_moves_earlier() public {
        uint256 id = 1;
        _openSentinel(id);
        vm.prank(signer); esc.lockRound(id); // lockTime now == now
        // a second lockRound at a LATER time must revert (can't re-open/extend)
        vm.warp(block.timestamp + 50);
        vm.expectRevert(bytes("only earlier"));
        vm.prank(signer); esc.lockRound(id);
    }

    function test_lockRound_onlySigner() public {
        uint256 id = 1;
        _openSentinel(id);
        vm.expectRevert(bytes("not signer"));
        esc.lockRound(id); // not the signer
        vm.expectRevert(bytes("not signer"));
        vm.prank(owner); esc.lockRound(id); // owner is not the signer either
    }

    function test_lockRound_requires_open() public {
        uint256 id = 1;
        _openSentinel(id);
        vm.prank(signer); esc.lockRound(id);
        bytes32 seed = keccak256("s");
        vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));
        vm.expectRevert(bytes("not open")); // already Committed
        vm.prank(signer); esc.lockRound(id);
    }

    // ---------------------------------------------------------------------
    // 2. per-wallet cap enforcement
    // ---------------------------------------------------------------------
    function test_perWalletCap_enforced_across_calls() public {
        vm.prank(owner); esc.setMaxTicketsPerWallet(3);
        uint256 id = 1;
        _openSentinel(id);
        vm.prank(alice); esc.buyIn(id, 2); // total 2, ok
        vm.prank(alice); esc.buyIn(id, 1); // total 3, ok (at cap)
        vm.expectRevert(bytes("wallet cap"));
        vm.prank(alice); esc.buyIn(id, 1); // total 4 > 3
    }

    function test_perWalletCap_zero_is_unlimited() public {
        assertEq(esc.maxTicketsPerWallet(), 0);
        uint256 id = 1;
        _openSentinel(id);
        vm.prank(alice); esc.buyIn(id, 50);
        vm.prank(alice); esc.buyIn(id, 50); // 100 total, no cap
        assertEq(esc.tickets(id, alice), 100);
    }

    function test_perWalletCap_only_owner() public {
        vm.expectRevert(); // Ownable
        esc.setMaxTicketsPerWallet(5);
    }

    // ---------------------------------------------------------------------
    // 3. buyInFor: valid / expired / replayed / unauthorized relayer / over-tickets / entry-over-max
    // ---------------------------------------------------------------------
    function _signAutoBuy(
        uint256 id, uint256 maxTickets, uint256 maxEntry, uint256 nonce, uint256 deadline
    ) internal view returns (bytes memory sig) {
        bytes32 structHash = keccak256(abi.encode(
            AUTOBUY_TYPEHASH, id, player, maxTickets, maxEntry, nonce, deadline
        ));
        bytes32 domainSeparator = esc.domainSeparatorV4();
        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(playerPk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function test_buyInFor_valid_auth() public {
        vm.prank(owner); esc.setRelayer(relayer);
        uint256 id = 1;
        _openSentinel(id);
        uint256 dl = block.timestamp + 1000;
        bytes memory sig = _signAutoBuy(id, 3, ENTRY, 0, dl);

        uint256 before = tok.balanceOf(player);
        vm.prank(relayer);
        esc.buyInFor(id, player, 2, 3, ENTRY, dl, 0, sig);

        assertEq(esc.tickets(id, player), 2);
        assertEq(before - tok.balanceOf(player), 2 * ENTRY); // pulled from player, not relayer
        assertEq(esc.autoBuyNonce(player), 1);               // nonce consumed
    }

    function test_buyInFor_rejects_expired_auth() public {
        vm.prank(owner); esc.setRelayer(relayer);
        uint256 id = 1;
        _openSentinel(id);
        uint256 dl = block.timestamp + 100;
        bytes memory sig = _signAutoBuy(id, 3, ENTRY, 0, dl);
        vm.warp(block.timestamp + 101); // past deadline
        vm.expectRevert(bytes("auth expired"));
        vm.prank(relayer);
        esc.buyInFor(id, player, 2, 3, ENTRY, dl, 0, sig);
    }

    function test_buyInFor_rejects_replay() public {
        vm.prank(owner); esc.setRelayer(relayer);
        uint256 id = 1;
        _openSentinel(id);
        uint256 dl = block.timestamp + 1000;
        bytes memory sig = _signAutoBuy(id, 3, ENTRY, 0, dl);
        vm.prank(relayer);
        esc.buyInFor(id, player, 1, 3, ENTRY, dl, 0, sig);
        // same sig / nonce 0 again -> nonce is now 1, so this reverts
        vm.expectRevert(bytes("bad nonce"));
        vm.prank(relayer);
        esc.buyInFor(id, player, 1, 3, ENTRY, dl, 0, sig);
    }

    function test_buyInFor_rejects_non_relayer() public {
        vm.prank(owner); esc.setRelayer(relayer);
        uint256 id = 1;
        _openSentinel(id);
        uint256 dl = block.timestamp + 1000;
        bytes memory sig = _signAutoBuy(id, 3, ENTRY, 0, dl);
        vm.expectRevert(bytes("not relayer"));
        vm.prank(bob); // not the relayer
        esc.buyInFor(id, player, 1, 3, ENTRY, dl, 0, sig);
    }

    function test_buyInFor_disabled_when_no_relayer() public {
        // relayer unset (0) -> auto-buy disabled
        uint256 id = 1;
        _openSentinel(id);
        uint256 dl = block.timestamp + 1000;
        bytes memory sig = _signAutoBuy(id, 3, ENTRY, 0, dl);
        vm.expectRevert(bytes("not relayer"));
        vm.prank(relayer);
        esc.buyInFor(id, player, 1, 3, ENTRY, dl, 0, sig);
    }

    function test_buyInFor_rejects_over_authorized_tickets() public {
        vm.prank(owner); esc.setRelayer(relayer);
        uint256 id = 1;
        _openSentinel(id);
        uint256 dl = block.timestamp + 1000;
        bytes memory sig = _signAutoBuy(id, 3, ENTRY, 0, dl);
        vm.expectRevert(bytes("over authorized tickets"));
        vm.prank(relayer);
        esc.buyInFor(id, player, 4, 3, ENTRY, dl, 0, sig); // 4 > maxTickets 3
    }

    function test_buyInFor_rejects_entry_over_max() public {
        vm.prank(owner); esc.setRelayer(relayer);
        uint256 id = 1;
        _openSentinel(id);
        uint256 dl = block.timestamp + 1000;
        // player authorizes a maxEntry BELOW the actual entry -> protects against a raised price
        bytes memory sig = _signAutoBuy(id, 3, ENTRY - 1, 0, dl);
        vm.expectRevert(bytes("entry over max"));
        vm.prank(relayer);
        esc.buyInFor(id, player, 1, 3, ENTRY - 1, dl, 0, sig);
    }

    function test_buyInFor_rejects_forged_sig() public {
        vm.prank(owner); esc.setRelayer(relayer);
        uint256 id = 1;
        _openSentinel(id);
        uint256 dl = block.timestamp + 1000;
        // sign with a DIFFERENT key -> recovered signer != player
        bytes32 structHash = keccak256(abi.encode(AUTOBUY_TYPEHASH, id, player, uint256(3), ENTRY, uint256(0), dl));
        bytes32 digest = MessageHashUtils.toTypedDataHash(esc.domainSeparatorV4(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBADF00D, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.expectRevert(bytes("bad auth sig"));
        vm.prank(relayer);
        esc.buyInFor(id, player, 1, 3, ENTRY, dl, 0, sig);
    }

    function test_buyInFor_respects_perWalletCap() public {
        vm.prank(owner); esc.setRelayer(relayer);
        vm.prank(owner); esc.setMaxTicketsPerWallet(2);
        uint256 id = 1;
        _openSentinel(id);
        uint256 dl = block.timestamp + 1000;
        bytes memory sig = _signAutoBuy(id, 5, ENTRY, 0, dl);
        vm.expectRevert(bytes("wallet cap"));
        vm.prank(relayer);
        esc.buyInFor(id, player, 3, 5, ENTRY, dl, 0, sig); // authorized 5, but on-chain cap is 2
    }

    // ---------------------------------------------------------------------
    // 4. guardian-windowed void (BASE-1)
    // ---------------------------------------------------------------------
    function _openFillVoidable(uint256 id) internal returns (uint64 deadline) {
        uint64 lock = uint64(block.timestamp) + 100;
        deadline = lock + 1000;
        vm.prank(signer); esc.openRound(id, ENTRY, lock, deadline);
        vm.prank(alice); esc.buyIn(id, 1);
    }

    function test_void_window_guardian_only_then_public() public {
        vm.prank(owner); esc.setGuardian(guardian);
        vm.prank(owner); esc.setVoidGrace(600); // 10 min grace before public void
        uint256 id = 1;
        uint64 deadline = _openFillVoidable(id);

        // move just past deadline but inside the grace window
        vm.warp(uint256(deadline) + 1);
        // random caller CANNOT void yet (griefing window closed)
        vm.expectRevert(bytes("void grace"));
        vm.prank(bob); esc.voidRound(id);

        // guardian CAN void inside the window
        vm.prank(guardian); esc.voidRound(id);
        ( , , , , , , , , StandoffEscrow.Status status, , , ) = esc.rounds(id);
        assertEq(uint256(status), uint256(StandoffEscrow.Status.Voided));
    }

    function test_void_public_after_grace() public {
        vm.prank(owner); esc.setGuardian(guardian);
        vm.prank(owner); esc.setVoidGrace(600);
        uint256 id = 1;
        uint64 deadline = _openFillVoidable(id);

        // past deadline + grace -> anyone may void
        vm.warp(uint256(deadline) + 601);
        vm.prank(bob); esc.voidRound(id);
        ( , , , , , , , , StandoffEscrow.Status status, , , ) = esc.rounds(id);
        assertEq(uint256(status), uint256(StandoffEscrow.Status.Voided));

        // refunds still work
        uint256 before = tok.balanceOf(alice);
        vm.prank(alice); esc.refund(id);
        assertEq(tok.balanceOf(alice) - before, ENTRY);
    }

    function test_void_owner_always_in_window() public {
        vm.prank(owner); esc.setVoidGrace(600); // no guardian set
        uint256 id = 1;
        uint64 deadline = _openFillVoidable(id);
        vm.warp(uint256(deadline) + 1);
        // owner may void inside the window even without a guardian
        vm.prank(owner); esc.voidRound(id);
        ( , , , , , , , , StandoffEscrow.Status status, , , ) = esc.rounds(id);
        assertEq(uint256(status), uint256(StandoffEscrow.Status.Voided));
    }

    function test_void_grace_zero_is_v1_public_at_deadline() public {
        // voidGrace defaults to 0 -> public void immediately at deadline (V1 behaviour preserved)
        uint256 id = 1;
        uint64 deadline = _openFillVoidable(id);
        vm.warp(uint256(deadline));
        vm.prank(bob); esc.voidRound(id); // anyone, right at deadline
        ( , , , , , , , , StandoffEscrow.Status status, , , ) = esc.rounds(id);
        assertEq(uint256(status), uint256(StandoffEscrow.Status.Voided));
    }

    // ---------------------------------------------------------------------
    // 5. rake snapshot (BASE-2): change rakeBps mid-round, settle uses the OPENING value
    // ---------------------------------------------------------------------
    function test_rake_snapshot_used_at_settle() public {
        // open at 5% rake
        uint256 id = 1;
        uint64 lock = uint64(block.timestamp) + 100;
        vm.prank(signer); esc.openRound(id, ENTRY, lock, lock + 1000);
        vm.prank(alice); esc.buyIn(id, 2); // 2000
        vm.prank(bob); esc.buyIn(id, 2);   // 2000 -> pot 4000

        // snapshot recorded at open
        ( , , , , , , , , , uint16 snap, , ) = esc.rounds(id);
        assertEq(snap, RAKE);

        // owner changes rake mid-round to the ceiling (10%)
        vm.prank(owner); esc.setRake(1000, BURNSHARE);
        assertEq(esc.rakeBps(), 1000);

        vm.warp(block.timestamp + 101);
        bytes32 seed = keccak256("snap");
        vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));

        // settle must honour the SNAPSHOT (5% -> rake 200, budget 3800), NOT the live 10%
        address[] memory w = new address[](1); w[0] = alice;
        uint256[] memory a = new uint256[](1); a[0] = 3800 ether;
        vm.prank(signer); esc.settle(id, seed, w, a);

        ( , , uint128 rakeOwed,,,,,,,,, ) = esc.rounds(id);
        assertEq(rakeOwed, 200 ether); // 5% of 4000, snapshot value — NOT 400 (10%)

        vm.warp(block.timestamp + CHAL);
        vm.prank(alice); esc.claim(id);
        esc.payRake(id);
        // escrow fully drained: 3800 to winner + 200 rake, exactly pot
        assertEq(tok.balanceOf(address(esc)), 0);
    }

    function test_rake_snapshot_lower_change_also_ignored() public {
        uint256 id = 1;
        uint64 lock = uint64(block.timestamp) + 100;
        vm.prank(signer); esc.openRound(id, ENTRY, lock, lock + 1000);
        vm.prank(alice); esc.buyIn(id, 4); // pot 4000
        // lower the rake to 0 mid-round; settle must STILL use 5% snapshot
        vm.prank(owner); esc.setRake(0, 0);
        vm.warp(block.timestamp + 101);
        bytes32 seed = keccak256("lo");
        vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));
        address[] memory w = new address[](1); w[0] = alice;
        uint256[] memory a = new uint256[](1); a[0] = 3800 ether; // budget assumes 5% snapshot
        vm.prank(signer); esc.settle(id, seed, w, a); // would revert "payout != pot-rake" if it used live 0%
        ( , , uint128 rakeOwed,,,,,,,,, ) = esc.rounds(id);
        assertEq(rakeOwed, 200 ether);
    }

    // ---------------------------------------------------------------------
    // misc: VERSION bump, and config setters are owner-gated
    // ---------------------------------------------------------------------
    function test_version_is_4() public view {
        assertEq(esc.VERSION(), 9); // repo source impl has since advanced to V9
    }

    function test_v2_setters_owner_only() public {
        vm.expectRevert(); esc.setRelayer(relayer);
        vm.expectRevert(); esc.setGuardian(guardian);
        vm.expectRevert(); esc.setVoidGrace(600);
    }

    // ---------------------------------------------------------------------
    // 6. MIN_CHALLENGE floor lowered to 300s (5 min): 300 accepted, 299 rejected
    // ---------------------------------------------------------------------
    function test_min_challenge_floor_is_300() public view {
        assertEq(esc.MIN_CHALLENGE(), 300);
    }

    function test_setChallenge_accepts_300_rejects_299() public {
        vm.prank(owner); esc.setChallenge(300); // at the new floor -> ok
        assertEq(esc.challenge(), 300);
        vm.expectRevert(bytes("challenge too short"));
        vm.prank(owner); esc.setChallenge(299); // one below the floor -> reverts
    }

    function test_initialize_accepts_300() public {
        StandoffEscrow impl = new StandoffEscrow();
        bytes memory initData = abi.encodeCall(
            StandoffEscrow.initialize, (address(tok), owner, signer, treasury, burn, RAKE, BURNSHARE, uint32(300))
        );
        StandoffEscrow e = StandoffEscrow(address(new ERC1967Proxy(address(impl), initData)));
        assertEq(e.challenge(), 300);
    }

    function test_initialize_rejects_299() public {
        StandoffEscrow impl = new StandoffEscrow();
        bytes memory bad = abi.encodeCall(
            StandoffEscrow.initialize, (address(tok), owner, signer, treasury, burn, RAKE, BURNSHARE, uint32(299))
        );
        vm.expectRevert(bytes("challenge too short"));
        new ERC1967Proxy(address(impl), bad);
    }

    // ---------------------------------------------------------------------
    // 7. burn-share snapshot (C-1): change burnShareBps mid-round, payRake uses the OPENING value.
    //    Mirrors the rakeBps snapshot test: a mid-flight setRake(sameRake, newBurnShare) must NOT redirect
    //    an already-committed round's rake split.
    // ---------------------------------------------------------------------
    function test_burnShare_snapshot_used_at_payRake() public {
        // open at 5% rake, 50% burn share (BURNSHARE)
        uint256 id = 1;
        uint64 lock = uint64(block.timestamp) + 100;
        vm.prank(signer); esc.openRound(id, ENTRY, lock, lock + 1000);
        vm.prank(alice); esc.buyIn(id, 2); // 2000
        vm.prank(bob); esc.buyIn(id, 2);   // 2000 -> pot 4000

        // snapshot recorded at open: rakeBpsSnap at index 9, burnShareSnap at index 10
        ( , , , , , , , , , uint16 rakeSnap, uint16 burnSnap, ) = esc.rounds(id);
        assertEq(rakeSnap, RAKE);
        assertEq(burnSnap, BURNSHARE); // 50% frozen at open

        // owner changes ONLY the burn share mid-round (same rake) -> redirect ALL rake to treasury (0% burn)
        vm.prank(owner); esc.setRake(RAKE, 0);
        assertEq(esc.burnShareBps(), 0);

        vm.warp(block.timestamp + 101);
        bytes32 seed = keccak256("bshare");
        vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));

        // rake = 5% of 4000 = 200, budget 3800
        address[] memory w = new address[](1); w[0] = alice;
        uint256[] memory a = new uint256[](1); a[0] = 3800 ether;
        vm.prank(signer); esc.settle(id, seed, w, a);

        vm.warp(block.timestamp + CHAL);
        vm.prank(alice); esc.claim(id);
        esc.payRake(id);

        // SNAPSHOT (50% burn) honoured: 100 burn + 100 treasury — NOT the live 0% (which would send all 200 to treasury)
        assertEq(tok.balanceOf(burn), 100 ether);
        assertEq(tok.balanceOf(treasury), 100 ether);
        assertEq(tok.balanceOf(address(esc)), 0);
    }

    function test_burnShare_snapshot_increase_also_ignored() public {
        // open at 50% burn, then RAISE burn share mid-round to 100%; payRake must STILL use the 50% snapshot
        uint256 id = 1;
        uint64 lock = uint64(block.timestamp) + 100;
        vm.prank(signer); esc.openRound(id, ENTRY, lock, lock + 1000);
        vm.prank(alice); esc.buyIn(id, 4); // pot 4000

        vm.prank(owner); esc.setRake(RAKE, 10000); // 100% of rake to burn, live
        assertEq(esc.burnShareBps(), 10000);

        vm.warp(block.timestamp + 101);
        bytes32 seed = keccak256("bshare-up");
        vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));
        address[] memory w = new address[](1); w[0] = alice;
        uint256[] memory a = new uint256[](1); a[0] = 3800 ether;
        vm.prank(signer); esc.settle(id, seed, w, a);

        vm.warp(block.timestamp + CHAL);
        vm.prank(alice); esc.claim(id);
        esc.payRake(id);

        // 50% snapshot honoured: 100 burn + 100 treasury, NOT the live 100% (which would burn all 200)
        assertEq(tok.balanceOf(burn), 100 ether);
        assertEq(tok.balanceOf(treasury), 100 ether);
    }

    // ---------------------------------------------------------------------
    // 8. per-wallet cap across the buyIn <-> buyInFor cross path (audit L-4): a wallet buys manually, then an
    //    auto-buy (buyInFor) for the same wallet must respect the COMBINED running total against the cap.
    // ---------------------------------------------------------------------
    function test_perWalletCap_enforced_across_buyIn_and_buyInFor() public {
        vm.prank(owner); esc.setRelayer(relayer);
        vm.prank(owner); esc.setMaxTicketsPerWallet(5);
        uint256 id = 1;
        _openSentinel(id);

        // player manually buys 3 tickets (under the cap of 5)
        vm.prank(player); esc.buyIn(id, 3);
        assertEq(esc.tickets(id, player), 3);

        uint256 dl = block.timestamp + 1000;

        // a relayer-submitted buyInFor for 3 MORE (total would be 6 > cap 5) must revert on the wallet cap
        bytes memory sigOver = _signAutoBuy(id, 5, ENTRY, 0, dl);
        vm.expectRevert(bytes("wallet cap"));
        vm.prank(relayer);
        esc.buyInFor(id, player, 3, 5, ENTRY, dl, 0, sigOver); // 3 + 3 = 6 > 5

        // nonce was NOT consumed (reverted before increment), so the same nonce 0 still signs the bounded buy
        assertEq(esc.autoBuyNonce(player), 0);

        // a buyInFor for exactly the remaining 2 (total 5, at the cap) succeeds
        bytes memory sigOk = _signAutoBuy(id, 5, ENTRY, 0, dl);
        vm.prank(relayer);
        esc.buyInFor(id, player, 2, 5, ENTRY, dl, 0, sigOk);
        assertEq(esc.tickets(id, player), 5); // combined total bounded at the cap

        // any further buy (manual or auto) over the cap is rejected
        vm.expectRevert(bytes("wallet cap"));
        vm.prank(player); esc.buyIn(id, 1); // 5 + 1 = 6 > 5
    }
}
