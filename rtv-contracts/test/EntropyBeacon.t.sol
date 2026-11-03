// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EntropyBeacon, IEntropy} from "../src/EntropyBeacon.sol";

/// Mock Pyth Entropy: models the REAL async flow — requestWithCallback returns a sequence immediately; the provider
/// delivers the random value in a SEPARATE later call (deliver()), exactly like the keeper reveal on chain.
contract MockEntropy is IEntropy {
    uint64 public seq;
    uint128 public fee;
    mapping(uint64 => bytes32) userOf;
    mapping(uint64 => address) provOf;

    function setFee(uint128 f) external { fee = f; }
    function getFee(address) external view returns (uint128) { return fee; }

    function requestWithCallback(address provider, bytes32 userRandomNumber) external payable returns (uint64) {
        require(msg.value >= fee, "fee");
        seq += 1;
        userOf[seq] = userRandomNumber;
        provOf[seq] = provider;
        return seq; // NO synchronous callback — delivered later, like the real keeper
    }

    function deliver(address consumer, uint64 s) external returns (bytes32 rnd) {
        rnd = keccak256(abi.encodePacked(userOf[s], provOf[s], s));
        (bool ok, ) = consumer.call(abi.encodeWithSignature("_entropyCallback(uint64,address,bytes32)", s, provOf[s], rnd));
        require(ok, "callback failed");
    }
}

contract EntropyBeaconTest is Test {
    MockEntropy ent;
    EntropyBeacon beacon;
    address owner = address(0xB0B);
    address prov = address(0xF1e7c4e7);
    address stranger = address(0xBAD);

    function setUp() public {
        ent = new MockEntropy();
        beacon = new EntropyBeacon(address(ent), prov, owner);
        vm.deal(address(beacon), 1 ether); // fund for fees
    }

    function test_requestThenDeliverStores() public {
        vm.prank(owner);
        uint64 s = beacon.poke();
        assertEq(s, 1);
        assertEq(beacon.pendingSequence(), 1); // awaiting delivery

        bytes32 rnd = ent.deliver(address(beacon), s);
        (bytes32 got, uint64 seq, , , uint256 total) = beacon.latest();
        assertEq(seq, 1);
        assertEq(total, 1);
        assertEq(got, rnd);
        assertTrue(got != bytes32(0));
        assertEq(beacon.randomBySequence(1), rnd);
        assertEq(beacon.pendingSequence(), 0); // cleared on delivery
    }

    function test_nonZeroFeeIsPaidFromBalance() public {
        ent.setFee(0.001 ether);
        vm.prank(owner);
        uint64 s = beacon.poke();
        ent.deliver(address(beacon), s);
        (, , , , uint256 total) = beacon.latest();
        assertEq(total, 1);
    }

    function test_onlyPokerOrOwnerCanPoke() public {
        vm.prank(stranger);
        vm.expectRevert("not poker");
        beacon.poke();
    }

    function test_onlyEntropyCanCallback() public {
        vm.prank(stranger);
        vm.expectRevert("unauthorized");
        beacon._entropyCallback(1, prov, bytes32(uint256(1)));
    }

    function test_pokerRoleCanPoke() public {
        vm.prank(owner);
        beacon.setConfig(address(ent), prov, stranger); // make stranger the poker
        vm.prank(stranger);
        uint64 s = beacon.poke();
        ent.deliver(address(beacon), s);
        (, , , , uint256 total) = beacon.latest();
        assertEq(total, 1);
    }

    function test_underfundedReverts() public {
        ent.setFee(2 ether); // beacon only has 1 ether
        vm.prank(owner);
        vm.expectRevert("underfunded");
        beacon.poke();
    }

    function test_multipleRoundsAccumulate() public {
        vm.startPrank(owner);
        uint64 s1 = beacon.poke();
        vm.stopPrank();
        ent.deliver(address(beacon), s1);
        vm.prank(owner);
        uint64 s2 = beacon.poke();
        ent.deliver(address(beacon), s2);
        (, uint64 seq, , , uint256 total) = beacon.latest();
        assertEq(total, 2);
        assertEq(seq, 2);
        assertTrue(beacon.randomBySequence(1) != beacon.randomBySequence(2));
    }
}
