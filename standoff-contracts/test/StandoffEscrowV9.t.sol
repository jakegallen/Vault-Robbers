// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StandoffEscrow} from "../src/StandoffEscrow.sol";
import {IERC6551Registry} from "../src/IERC6551Registry.sol";
import {MockERC20} from "./MockERC20.sol";
import {MockERC6551Registry} from "./MockERC6551Registry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice V9 tests: RANDOM VAULT ROBBER AIRDROP. A configurable share OF THE RAKE (robberShareBps) is paid at payRake
/// to a RANDOM Vault Robber's ERC-6551 token-bound account; the remainder of the rake keeps flowing burn/treasury.
/// The winner budget (pot - rake + jackpot) is UNCHANGED — the robber share comes out of the rake, not the pot.
/// Covers:
///   * UNCONFIGURED => behaves exactly like V8 (no robber transfer, full rake to treasury/burn per burnShareSnap).
///   * CONFIGURED   => robber share == rake*shareBps/BPS lands at the correct deterministic TBA (computed via the
///                     published 6551 algorithm), treasury gets the remainder, RobberPaid emitted with the seed-derived
///                     tokenId, and the winner budget / claimable payout is identical to the unconfigured case.
///   * seed-derivation is deterministic for a fixed (seed,id) and domain-separated with "robber".
///   * setRobberConfig with shareBps > BPS reverts; onlyOwner enforced.
///   * storage-layout / upgrade: a full round's state written pre-upgrade reads back byte-for-byte after upgrading the
///     proxy, and the V9 robber leg goes live only after setRobberConfig.
contract StandoffEscrowV9Test is Test {
    StandoffEscrow esc;
    MockERC20 tok;
    MockERC6551Registry registry;

    address owner = address(0x5afe);
    address signer = address(0x516e);
    address treasury = address(0x7ea5);
    address burn = address(0xdead);
    address player1 = address(0xA11);
    address player2 = address(0xB22);
    address winner = player1;

    // The real mainnet values (used only as config inputs; the mock registry does the derivation locally).
    address constant ROBBER_NFT = 0xABC6c4F5d1F31326b419c2645C981743a845313a;
    address constant ACCOUNT_IMPL = address(0xACC0); // standardized 6551 account impl (test stand-in)
    bytes32 constant SALT = bytes32(0);
    uint32  constant SUPPLY = 1000;
    uint16  constant ROBBER_SHARE = 5000; // half the rake

    uint16 constant RAKE = 500;        // 5%
    uint16 constant BURNSHARE = 0;     // current prod: 100% of the non-robber rake to treasury
    uint32 constant CHAL = 3600;
    uint128 constant ENTRY = 1000 ether;
    uint64  constant SENTINEL = 1_000_000;

    function setUp() public {
        vm.warp(1000);
        tok = new MockERC20();
        registry = new MockERC6551Registry();
        StandoffEscrow impl = new StandoffEscrow();
        bytes memory initData = abi.encodeCall(
            StandoffEscrow.initialize, (address(tok), owner, signer, treasury, burn, RAKE, BURNSHARE, CHAL)
        );
        esc = StandoffEscrow(address(new ERC1967Proxy(address(impl), initData)));
        tok.mint(player1, 1_000_000 ether);
        tok.mint(player2, 1_000_000 ether);
        vm.prank(player1); tok.approve(address(esc), type(uint256).max);
        vm.prank(player2); tok.approve(address(esc), type(uint256).max);
    }

    // Open a round, seat both players (2 tickets each => pot 4000e), lock, commit, settle with the single winner,
    // warp past the challenge window. Returns (pot, rake, budget, seed).
    function _runToWindow(uint256 id, bytes32 seed) internal returns (uint256 pot, uint256 rake, uint256 budget) {
        uint64 lock = uint64(block.timestamp) + SENTINEL;
        vm.prank(signer); esc.openRound(id, ENTRY, lock, lock + 10000);
        vm.prank(player1); esc.buyIn(id, 2);
        vm.prank(player2); esc.buyIn(id, 2);
        vm.prank(signer); esc.lockRound(id);
        vm.prank(signer); esc.commit(id, keccak256(abi.encodePacked(seed)));

        pot = 4000 ether;
        rake = pot * RAKE / esc.BPS();
        budget = pot - rake; // jackpot 0

        address[] memory w = new address[](1); w[0] = winner;
        uint256[] memory a = new uint256[](1); a[0] = budget;
        vm.prank(signer); esc.settle(id, seed, w, a);

        vm.warp(block.timestamp + CHAL + 1);
    }

    function _configureRobber() internal {
        vm.prank(owner);
        esc.setRobberConfig(ROBBER_NFT, address(registry), ACCOUNT_IMPL, SALT, SUPPLY, ROBBER_SHARE);
    }

    // Reproduce the contract's on-chain draw with the published algorithm.
    function _expectTokenId(uint256 id, bytes32 seed) internal pure returns (uint256) {
        return (uint256(keccak256(abi.encodePacked(seed, id, "robber"))) % SUPPLY) + 1;
    }

    function test_version_is_9() public view { assertEq(esc.VERSION(), 9); }

    // ---- UNCONFIGURED: payRake routes the WHOLE rake to treasury/burn, no robber transfer (identical to V8) ----
    function test_unconfigured_behaves_like_v8() public {
        assertFalse(esc.robberActive(), "robber leg off by default");
        bytes32 seed = keccak256("seedU");
        (, uint256 rake,) = _runToWindow(1, seed);

        uint256 tBefore = tok.balanceOf(treasury);
        uint256 bBefore = tok.balanceOf(burn);
        esc.payRake(1);
        // BURNSHARE == 0 -> whole rake to treasury, nothing to burn, nothing to any TBA.
        assertEq(tok.balanceOf(treasury) - tBefore, rake, "full rake to treasury");
        assertEq(tok.balanceOf(burn) - bBefore, 0, "nothing burned");

        // winner claim is pot - rake, unchanged
        uint256 wBefore = tok.balanceOf(winner);
        vm.prank(winner); esc.claim(1);
        assertEq(tok.balanceOf(winner) - wBefore, 4000 ether - rake, "winner budget = pot - rake");
    }

    // ---- CONFIGURED: robber share to the correct TBA, remainder to treasury, winner budget unchanged, event emitted ----
    function test_configured_pays_robber_tba_and_keeps_budget() public {
        _configureRobber();
        assertTrue(esc.robberActive(), "robber leg live");

        bytes32 seed = keccak256("seedC");
        (, uint256 rake, uint256 budget) = _runToWindow(2, seed);

        uint256 expectedTokenId = _expectTokenId(2, seed);
        assertEq(esc.robberTokenId(2, seed), expectedTokenId, "on-chain draw matches algorithm");
        // Expected TBA via the published 6551 algorithm (same registry instance).
        address expectedTba = registry.account(ACCOUNT_IMPL, SALT, block.chainid, ROBBER_NFT, expectedTokenId);
        assertEq(esc.robberTba(expectedTokenId), expectedTba, "TBA derivation matches");

        uint256 robberCut = rake * ROBBER_SHARE / esc.BPS();
        uint256 remainder = rake - robberCut; // BURNSHARE 0 -> all remainder to treasury

        uint256 tbaBefore = tok.balanceOf(expectedTba);
        uint256 tBefore = tok.balanceOf(treasury);
        uint256 bBefore = tok.balanceOf(burn);

        vm.expectEmit(true, true, false, true, address(esc));
        emit StandoffEscrow.RobberPaid(2, expectedTokenId, expectedTba, robberCut);
        esc.payRake(2);

        assertEq(tok.balanceOf(expectedTba) - tbaBefore, robberCut, "robber share to TBA");
        assertEq(tok.balanceOf(treasury) - tBefore, remainder, "remainder to treasury");
        assertEq(tok.balanceOf(burn) - bBefore, 0, "nothing burned (burnShare 0)");
        assertEq(robberCut + remainder, rake, "robber share + remainder == rake exactly");

        // The winner budget is identical to the unconfigured case: the robber share came from the RAKE, not the pot.
        uint256 wBefore = tok.balanceOf(winner);
        vm.prank(winner); esc.claim(2);
        assertEq(tok.balanceOf(winner) - wBefore, budget, "winner budget UNCHANGED (pot - rake)");
    }

    // ---- CONFIGURED with a nonzero burnShare: the burn/treasury split applies to the rake REMAINING after robber ----
    function test_configured_splits_remainder_burn_treasury() public {
        // 5000 bps burn share of the NON-robber rake
        vm.prank(owner); esc.setRake(RAKE, 5000);
        _configureRobber();

        bytes32 seed = keccak256("seedS");
        (, uint256 rake,) = _runToWindow(3, seed);

        uint256 robberCut = rake * ROBBER_SHARE / esc.BPS();
        uint256 remaining = rake - robberCut;
        uint256 burnCut = remaining * 5000 / esc.BPS();
        uint256 treasCut = remaining - burnCut;

        uint256 tBefore = tok.balanceOf(treasury);
        uint256 bBefore = tok.balanceOf(burn);
        esc.payRake(3);
        assertEq(tok.balanceOf(burn) - bBefore, burnCut, "burn gets half of remaining");
        assertEq(tok.balanceOf(treasury) - tBefore, treasCut, "treasury gets the rest of remaining");
    }

    // ---- seed-derivation is DETERMINISTIC for a fixed (seed,id) and domain-separated with "robber" ----
    function test_draw_deterministic_and_domain_separated() public {
        _configureRobber();
        bytes32 seed = keccak256("seedD");
        uint256 a = esc.robberTokenId(7, seed);
        uint256 b = esc.robberTokenId(7, seed);
        assertEq(a, b, "deterministic for fixed (seed,id)");
        assertTrue(a >= 1 && a <= SUPPLY, "tokenId in [1, supply]");
        // Different id => (almost surely) different draw, and it is NOT the raw seed mod supply (domain separated).
        uint256 c = esc.robberTokenId(8, seed);
        // sanity: the "robber"-labelled draw differs from a naive seed-only hash mod supply
        uint256 naive = (uint256(keccak256(abi.encodePacked(seed))) % SUPPLY) + 1;
        assertTrue(a != naive || c != naive, "domain separated from a seed-only hash");
    }

    // ---- setRobberConfig validation + access control ----
    function test_setRobberConfig_rejects_shareBps_over_bps() public {
        uint16 overBps = esc.BPS() + 1; // evaluate the view BEFORE expectRevert so it targets setRobberConfig
        vm.prank(owner);
        vm.expectRevert(bytes("bad bps"));
        esc.setRobberConfig(ROBBER_NFT, address(registry), ACCOUNT_IMPL, SALT, SUPPLY, overBps);
    }

    function test_setRobberConfig_only_owner() public {
        vm.prank(signer);
        vm.expectRevert();
        esc.setRobberConfig(ROBBER_NFT, address(registry), ACCOUNT_IMPL, SALT, SUPPLY, ROBBER_SHARE);
        // owner succeeds
        _configureRobber();
        assertEq(esc.robberSupply(), SUPPLY);
        assertEq(esc.robberShareBps(), ROBBER_SHARE);
        assertEq(esc.robberNft(), ROBBER_NFT);
        assertEq(esc.robberRegistry(), address(registry));
        assertEq(esc.robberAccountImpl(), ACCOUNT_IMPL);
    }

    // ---- inert if any of {nft, supply, shareBps} is zero even if the others are set ----
    function test_zero_any_field_keeps_inert() public {
        vm.prank(owner); esc.setRobberConfig(ROBBER_NFT, address(registry), ACCOUNT_IMPL, SALT, SUPPLY, 0);
        assertFalse(esc.robberActive(), "shareBps 0 -> inert");
        vm.prank(owner); esc.setRobberConfig(ROBBER_NFT, address(registry), ACCOUNT_IMPL, SALT, 0, ROBBER_SHARE);
        assertFalse(esc.robberActive(), "supply 0 -> inert");
        vm.prank(owner); esc.setRobberConfig(address(0), address(registry), ACCOUNT_IMPL, SALT, SUPPLY, ROBBER_SHARE);
        assertFalse(esc.robberActive(), "nft 0 -> inert");
    }

    // ---- STORAGE-LAYOUT / UPGRADE: state written through the proxy survives a fresh-impl upgrade byte-for-byte,
    //      and the V9 robber leg goes live only after setRobberConfig. ----
    function test_storage_layout_and_upgrade_activation() public {
        // write config + run a round to the challenge window (exercises rounds incl. the new seedRevealed member)
        vm.prank(owner); esc.setMaxTicketsPerWallet(50);
        vm.prank(owner); esc.setRake(RAKE, 0);
        bytes32 seed = keccak256("seedUp");
        (uint256 pot, uint256 rake,) = _runToWindow(9, seed);

        // snapshot a broad spread of pre-upgrade state
        (uint128 b_entry, uint128 b_pot, uint128 b_rakeOwed,,,,,,,, ,) = esc.rounds(9);
        uint256 b_ticketsW = esc.tickets(9, winner);
        uint256 b_win = esc.winShare(9, winner);
        uint256 b_tokBal = tok.balanceOf(address(esc));
        uint128 b_cap = esc.maxTicketsPerWallet();

        // upgrade the proxy to a fresh impl (Safe does upgradeToAndCall)
        StandoffEscrow newImpl = new StandoffEscrow();
        vm.prank(owner); esc.upgradeToAndCall(address(newImpl), "");

        (uint128 a_entry, uint128 a_pot, uint128 a_rakeOwed,,,,,,,, ,) = esc.rounds(9);
        assertEq(a_entry, b_entry, "entry");
        assertEq(a_pot, b_pot, "pot");
        assertEq(a_rakeOwed, b_rakeOwed, "rakeOwed");
        assertEq(esc.tickets(9, winner), b_ticketsW, "tickets");
        assertEq(esc.winShare(9, winner), b_win, "winShare");
        assertEq(tok.balanceOf(address(esc)), b_tokBal, "escrow balance");
        assertEq(esc.maxTicketsPerWallet(), b_cap, "cap");

        // new robber slots default zero => inert; pre-existing state did NOT collide with them
        assertEq(esc.robberNft(), address(0), "robberNft default 0");
        assertEq(esc.robberSupply(), 0, "robberSupply default 0");
        assertEq(esc.robberShareBps(), 0, "robberShareBps default 0");
        assertFalse(esc.robberActive(), "inert until configured");
        assertEq(esc.VERSION(), 9, "version 9");

        // payRake on the pre-upgrade round still routes the FULL rake to treasury (robber leg was never configured)
        uint256 tBefore = tok.balanceOf(treasury);
        esc.payRake(9);
        assertEq(tok.balanceOf(treasury) - tBefore, rake, "full rake to treasury (inert)");
        pot; // silence unused

        // configuring post-upgrade arms the robber leg for future rounds
        _configureRobber();
        assertTrue(esc.robberActive(), "robber leg live after config");
    }
}
