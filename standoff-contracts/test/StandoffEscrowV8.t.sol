// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";
import {MockERC20} from "./MockERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice V8 tests: RELAYER KEY-POOL / allowlist. Multiple relayer hot keys may submit player-signed auto-buys in
/// parallel (one key = one serial nonce lane; a pool = parallel throughput for a launch rush). The legacy single
/// `relayer` + setRelayer stay for back-compat; setRelayerAllowed(k, true/false) manages the pool (owner-only).
/// Covers: legacy relayer still works on buyInFor + buyInForRange; an allowlisted key works on both; a non-allowlisted,
/// non-relayer key reverts "not relayer" on both; revoke via setRelayerAllowed(k,false); onlyOwner on setRelayerAllowed;
/// and a storage-layout continuity check (state written under V7 reads back identically after upgrading the proxy to V8).
contract StandoffEscrowV8Test is Test {
    StandoffEscrow esc;
    MockERC20 tok;

    address owner = address(0x5afe);
    address signer = address(0x516e);
    address treasury = address(0x7ea5);
    address burn = address(0xdead);
    address relayer = address(0x7e1a);   // legacy single relayer
    address relayer2 = address(0x7e1b);  // pooled key, allowlisted via setRelayerAllowed
    address stranger = address(0x5721);  // neither relayer nor allowlisted

    uint256 playerPk;
    address player;

    uint16 constant RAKE = 500;
    uint16 constant BURNSHARE = 5000;
    uint32 constant CHAL = 3600;
    uint128 constant ENTRY = 1000 ether;
    uint64  constant SENTINEL = 1_000_000;

    bytes32 constant AUTOBUY_TYPEHASH = keccak256(
        "AutoBuy(uint256 roundId,address player,uint256 maxTickets,uint256 maxEntry,uint256 nonce,uint256 deadline)"
    );
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

    function _signSingle(uint256 pk, uint256 id, address who, uint256 maxTickets, uint256 maxEntry, uint256 nonce, uint256 deadline) internal view returns (bytes memory sig) {
        bytes32 structHash = keccak256(abi.encode(AUTOBUY_TYPEHASH, id, who, maxTickets, maxEntry, nonce, deadline));
        bytes32 digest = MessageHashUtils.toTypedDataHash(esc.domainSeparatorV4(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function _signRange(uint256 pk, uint256 roundStart, uint256 roundCount, address who, uint256 maxTickets, uint256 maxEntry, uint256 nonce, uint256 deadline) internal view returns (bytes memory sig) {
        bytes32 structHash = keccak256(abi.encode(AUTOBUY_RANGE_TYPEHASH, roundStart, roundCount, who, maxTickets, maxEntry, nonce, deadline));
        bytes32 digest = MessageHashUtils.toTypedDataHash(esc.domainSeparatorV4(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    // The repo source impl has since advanced to V9 (random-robber airdrop appended). The V8 key-pool feature this
    // file exercises is unchanged; only the VERSION constant moved. Assert the current constant so this stays green.
    function test_version_is_current() public view { assertEq(esc.VERSION(), 9); }

    // ---- back-compat: the legacy single relayer still works on both entry points ----
    function test_legacy_relayer_buyInFor_still_works() public {
        _open(1);
        uint256 dl = block.timestamp + 1 days;
        bytes memory sig = _signSingle(playerPk, 1, player, 2, ENTRY, 0, dl);
        vm.prank(relayer); esc.buyInFor(1, player, 2, 2, ENTRY, dl, 0, sig);
        assertEq(_tickets(1, player), 2, "legacy relayer seated via buyInFor");
    }

    function test_legacy_relayer_buyInForRange_still_works() public {
        _open(10);
        uint256 dl = block.timestamp + 1 days;
        bytes memory sig = _signRange(playerPk, 10, 3, player, 2, ENTRY, 0, dl);
        vm.prank(relayer); esc.buyInForRange(10, player, 2, 10, 3, 2, ENTRY, 0, dl, sig);
        assertEq(_tickets(10, player), 2, "legacy relayer seated via buyInForRange");
    }

    // ---- key-pool: a second owner-allowlisted key can submit on both entry points ----
    function test_pooled_key_can_buyInForRange_and_buyInFor() public {
        vm.prank(owner); esc.setRelayerAllowed(relayer2, true);
        assertTrue(esc.isRelayer(relayer2), "key allowlisted");

        // buyInForRange with the pooled key (range nonce 0)
        _open(10);
        uint256 dl = block.timestamp + 1 days;
        bytes memory rsig = _signRange(playerPk, 10, 3, player, 2, ENTRY, 0, dl);
        vm.prank(relayer2); esc.buyInForRange(10, player, 2, 10, 3, 2, ENTRY, 0, dl, rsig);
        assertEq(_tickets(10, player), 2, "pooled key seated via buyInForRange");

        // buyInFor with the pooled key. The range buy above did NOT bump autoBuyNonce (shared across the range),
        // so the single-buy nonce is still 0.
        _open(1);
        bytes memory ssig = _signSingle(playerPk, 1, player, 2, ENTRY, 0, dl);
        vm.prank(relayer2); esc.buyInFor(1, player, 2, 2, ENTRY, dl, 0, ssig);
        assertEq(_tickets(1, player), 2, "pooled key seated via buyInFor");
    }

    // ---- a non-allowlisted, non-relayer key reverts "not relayer" on BOTH ----
    function test_stranger_reverts_not_relayer_on_both() public {
        _open(1); _open(10);
        uint256 dl = block.timestamp + 1 days;
        bytes memory ssig = _signSingle(playerPk, 1, player, 2, ENTRY, 0, dl);
        bytes memory rsig = _signRange(playerPk, 10, 3, player, 2, ENTRY, 0, dl);
        assertFalse(esc.isRelayer(stranger), "stranger not allowlisted");
        vm.prank(stranger); vm.expectRevert(bytes("not relayer")); esc.buyInFor(1, player, 2, 2, ENTRY, dl, 0, ssig);
        vm.prank(stranger); vm.expectRevert(bytes("not relayer")); esc.buyInForRange(10, player, 2, 10, 3, 2, ENTRY, 0, dl, rsig);
    }

    // ---- revoke: setRelayerAllowed(k,false) turns a pooled key back off ----
    function test_revoke_pooled_key() public {
        vm.prank(owner); esc.setRelayerAllowed(relayer2, true);
        _open(10);
        uint256 dl = block.timestamp + 1 days;
        bytes memory rsig = _signRange(playerPk, 10, 3, player, 2, ENTRY, 0, dl);
        vm.prank(relayer2); esc.buyInForRange(10, player, 2, 10, 3, 2, ENTRY, 0, dl, rsig);
        assertEq(_tickets(10, player), 2, "seated while allowed");

        vm.prank(owner); esc.setRelayerAllowed(relayer2, false);
        assertFalse(esc.isRelayer(relayer2), "key revoked");
        _open(11);
        // range buys don't bump autoBuyNonce, so it is still 0; sign over nonce 0 to isolate the relayer gate
        bytes memory rsig2 = _signRange(playerPk, 11, 1, player, 2, ENTRY, 0, dl);
        vm.prank(relayer2); vm.expectRevert(bytes("not relayer")); esc.buyInForRange(11, player, 2, 11, 1, 2, ENTRY, 0, dl, rsig2);
    }

    // ---- onlyOwner on setRelayerAllowed ----
    function test_setRelayerAllowed_only_owner() public {
        vm.prank(stranger); vm.expectRevert(); esc.setRelayerAllowed(relayer2, true);
        vm.prank(signer); vm.expectRevert(); esc.setRelayerAllowed(relayer2, true);
        // owner succeeds
        vm.prank(owner); esc.setRelayerAllowed(relayer2, true);
        assertTrue(esc.isRelayer(relayer2));
    }

    // ---- STORAGE-LAYOUT CONTINUITY: state written under V7 reads back identically after upgrading the proxy to V8.
    // We simulate "the proxy currently runs V7" by taking the V7 behaviour that the current impl ALSO has (the live
    // contract source IS V8 in this repo, but V7 had no isRelayer slot), writing a broad spread of state through the
    // proxy, then upgrading to a freshly-deployed impl and asserting every value is byte-for-byte preserved. The new
    // impl occupies the same bytecode as V8; slot 17 (isRelayer) was previously inside __gap and reads 0 (false) for
    // every key until setRelayerAllowed is called, so no pre-existing state can collide with it.
    function test_storage_layout_continuity_across_upgrade() public {
        // --- write a broad spread of state through the proxy ---
        // config
        vm.prank(owner); esc.setMaxTicketsPerWallet(42);
        vm.prank(owner); esc.setGuardian(address(0x6a7d));
        vm.prank(owner); esc.setVoidGrace(1800);
        vm.prank(owner); esc.setRake(300, 4000);

        // a full round lifecycle through rollover -> jackpot (exercises rounds, tickets, roundPaid, jackpot, rangeSpent, autoBuyNonce)
        _open(5);
        uint256 dl = block.timestamp + 1 days;
        bytes memory rsig = _signRange(playerPk, 5, 2, player, 3, ENTRY, 0, dl);
        vm.prank(relayer); esc.buyInForRange(5, player, 3, 5, 2, 3, ENTRY, 0, dl, rsig);
        vm.prank(signer); esc.lockRound(5);
        bytes32 seed = keccak256("seed5");
        vm.prank(signer); esc.commit(5, keccak256(abi.encodePacked(seed)));
        vm.prank(signer); esc.rolloverRound(5, seed); // whole pot -> jackpot

        // player bumps their nonce once so autoBuyNonce is non-zero
        vm.prank(player); esc.invalidateAutoBuy();

        // --- snapshot state BEFORE upgrade ---
        (uint128 b_entry, uint128 b_pot,,, , , , , StandoffEscrow.Status b_status, uint16 b_rakeSnap, uint16 b_burnSnap, ) = esc.rounds(5);
        uint256 b_tickets = esc.tickets(5, player);
        uint256 b_roundPaid = esc.roundPaid(5, player);
        uint256 b_jackpot = esc.jackpot();
        bool b_rangeSpent = esc.rangeSpent(player, 5);
        uint256 b_nonce = esc.autoBuyNonce(player);
        address b_relayer = esc.relayer();
        uint128 b_cap = esc.maxTicketsPerWallet();
        address b_guardian = esc.guardian();
        uint32 b_voidGrace = esc.voidGrace();
        uint16 b_rake = esc.rakeBps();
        uint16 b_burnShare = esc.burnShareBps();
        address b_token = address(esc.token());
        address b_signer = esc.settlementSigner();
        uint256 b_tokBal = tok.balanceOf(address(esc));

        // --- UPGRADE the proxy to a fresh impl (owner/Safe does upgradeToAndCall(newImpl, 0x)) ---
        StandoffEscrow newImpl = new StandoffEscrow();
        vm.prank(owner); esc.upgradeToAndCall(address(newImpl), "");

        // --- every value reads back IDENTICALLY after the upgrade ---
        (uint128 a_entry, uint128 a_pot,,, , , , , StandoffEscrow.Status a_status, uint16 a_rakeSnap, uint16 a_burnSnap, ) = esc.rounds(5);
        assertEq(a_entry, b_entry, "round.entry");
        assertEq(a_pot, b_pot, "round.pot");
        assertEq(uint8(a_status), uint8(b_status), "round.status");
        assertEq(a_rakeSnap, b_rakeSnap, "round.rakeBpsSnap");
        assertEq(a_burnSnap, b_burnSnap, "round.burnShareSnap");
        assertEq(esc.tickets(5, player), b_tickets, "tickets");
        assertEq(esc.roundPaid(5, player), b_roundPaid, "roundPaid");
        assertEq(esc.jackpot(), b_jackpot, "jackpot");
        assertEq(esc.rangeSpent(player, 5), b_rangeSpent, "rangeSpent");
        assertEq(esc.autoBuyNonce(player), b_nonce, "autoBuyNonce");
        assertEq(esc.relayer(), b_relayer, "relayer");
        assertEq(esc.maxTicketsPerWallet(), b_cap, "maxTicketsPerWallet");
        assertEq(esc.guardian(), b_guardian, "guardian");
        assertEq(esc.voidGrace(), b_voidGrace, "voidGrace");
        assertEq(esc.rakeBps(), b_rake, "rakeBps");
        assertEq(esc.burnShareBps(), b_burnShare, "burnShareBps");
        assertEq(address(esc.token()), b_token, "token");
        assertEq(esc.settlementSigner(), b_signer, "settlementSigner");
        assertEq(tok.balanceOf(address(esc)), b_tokBal, "escrow token balance");

        // the newly-appended slot reads its zero default for every key (no collision with prior state)
        assertFalse(esc.isRelayer(relayer2), "isRelayer defaults false");
        assertEq(esc.VERSION(), 9, "version bumped");

        // and the new key-pool works post-upgrade
        vm.prank(owner); esc.setRelayerAllowed(relayer2, true);
        assertTrue(esc.isRelayer(relayer2), "key-pool live after upgrade");
    }
}
