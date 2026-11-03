// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// Minimal Pyth Entropy interfaces (no npm pkg available; vendored to match the live 4663 deployment).
interface IEntropy {
    function getFee(address provider) external view returns (uint128);
    function requestWithCallback(address provider, bytes32 userRandomNumber) external payable returns (uint64 assignedSequenceNumber);
}

/// Pyth's consumer base: Entropy calls _entropyCallback, which authenticates msg.sender then hands off to entropyCallback.
abstract contract IEntropyConsumer {
    function _entropyCallback(uint64 sequence, address provider, bytes32 randomNumber) external {
        address entropy = getEntropy();
        require(entropy != address(0), "no entropy");
        require(msg.sender == entropy, "unauthorized");
        entropyCallback(sequence, provider, randomNumber);
    }
    function getEntropy() internal view virtual returns (address);
    function entropyCallback(uint64 sequence, address provider, bytes32 randomNumber) internal virtual;
}

/// @title EntropyBeacon — a fund-less on-chain randomness beacon for Robbing the Vault.
/// @notice Periodically pulls an unpredictable value from Pyth Entropy (provider "quiver:fletcher" on Robinhood Chain
///         4663) and stores it. The game server folds `latestRandom` into every provably-fair roll, so no single party
///         (operator OR sequencer) can bias an outcome. Holds NO player funds and is fully independent of the money
///         vault contract — worst case it stalls and the game falls back to pure commit-reveal. Only `poker`/owner can
///         request; only the Entropy contract can deliver a value.
contract EntropyBeacon is IEntropyConsumer, Ownable {
    IEntropy public entropy;      // Pyth Entropy contract (0x8cF4…C9a3 on 4663)
    address public provider;      // registered provider (0xeb8e79… "quiver:fletcher")
    address public poker;         // keeper allowed to trigger requests (besides owner)

    bytes32 public latestRandom;  // most recent delivered random value
    uint64  public latestSequence;
    uint256 public latestBlock;
    uint256 public latestTime;
    uint256 public count;         // total values delivered
    uint64  public pendingSequence; // last requested seq awaiting callback (0 = none)

    mapping(uint64 => bytes32) public randomBySequence; // history, for independent verification

    event Requested(uint64 indexed sequence, uint128 fee, bytes32 userContribution);
    event Delivered(uint64 indexed sequence, bytes32 randomNumber, uint256 blockNumber);
    event ConfigUpdated(address entropy, address provider, address poker);

    constructor(address _entropy, address _provider, address _owner) Ownable(_owner) {
        entropy = IEntropy(_entropy);
        provider = _provider;
        poker = _owner;
    }

    modifier onlyPoker() { require(msg.sender == poker || msg.sender == owner(), "not poker"); _; }

    /// @notice Request a fresh random value. Reads the live fee and pays it from this contract's ETH balance
    ///         (fee is 0 today but read dynamically so a future provider fee still works). Fund via `receive()`.
    function poke() external onlyPoker returns (uint64 seq) {
        uint128 fee = entropy.getFee(provider);
        require(address(this).balance >= fee, "underfunded");
        // Our contribution — the provider supplies the real entropy; ours only needs to be non-trivially-known.
        bytes32 userContribution = keccak256(abi.encodePacked(block.timestamp, block.prevrandao, count, blockhash(block.number - 1), address(this)));
        seq = entropy.requestWithCallback{value: fee}(provider, userContribution);
        pendingSequence = seq;
        emit Requested(seq, fee, userContribution);
    }

    function entropyCallback(uint64 sequence, address, bytes32 randomNumber) internal override {
        latestRandom = randomNumber;
        latestSequence = sequence;
        latestBlock = block.number;
        latestTime = block.timestamp;
        count += 1;
        randomBySequence[sequence] = randomNumber;
        if (sequence == pendingSequence) pendingSequence = 0;
        emit Delivered(sequence, randomNumber, block.number);
    }

    function getEntropy() internal view override returns (address) { return address(entropy); }

    /// @notice One-call read for the game server / verifiers.
    function latest() external view returns (bytes32 random, uint64 sequence, uint256 blockNumber, uint256 ts, uint256 total) {
        return (latestRandom, latestSequence, latestBlock, latestTime, count);
    }

    function currentFee() external view returns (uint128) { return entropy.getFee(provider); }

    // ---- admin ----
    function setConfig(address _entropy, address _provider, address _poker) external onlyOwner {
        entropy = IEntropy(_entropy); provider = _provider; poker = _poker;
        emit ConfigUpdated(_entropy, _provider, _poker);
    }
    function withdraw(address to) external onlyOwner {
        (bool ok, ) = payable(to).call{value: address(this).balance}(""); require(ok, "withdraw failed");
    }

    receive() external payable {} // accept ETH to cover request fees
}
