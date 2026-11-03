// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/access/Ownable.sol";

/// @title Minimal ERC721C transfer validator (TESTNET proof)
/// @notice Mirrors, at a basic level, the OpenSea "TX Validator" model that ERC721C tokens call on every transfer.
///         When enforcement is ON, a token can only be moved on the owner's behalf by a whitelisted operator (a
///         royalty-honoring marketplace); the owner's own direct transfers always pass, and mints/burns are never
///         gated. This lets us prove the enforced-royalty wiring end to end on Robinhood testnet. On MAINNET this is
///         replaced by OpenSea's canonical CreatorTokenTransferValidator, deployed at its standard address.
contract TransferValidator is Ownable {
    bool public enforce;                                  // master switch; off = fully open (transfers unrestricted)
    mapping(address => bool) public allowedOperator;      // royalty-honoring operators (e.g. an OpenSea conduit)

    event EnforceSet(bool on);
    event OperatorSet(address indexed operator, bool allowed);

    constructor() Ownable(msg.sender) {}

    function setEnforce(bool on) external onlyOwner { enforce = on; emit EnforceSet(on); }
    function setOperator(address op, bool ok) external onlyOwner { allowedOperator[op] = ok; emit OperatorSet(op, ok); }

    /// @notice The exact ERC721C hook the token staticcalls on every real transfer. Reverts to block a disallowed
    ///         (royalty-skipping) move. Selector: validateTransfer(address,address,address,uint256) = 0xcaee23ea.
    function validateTransfer(address caller, address from, address /*to*/, uint256 /*tokenId*/) external view {
        if (!enforce) return;                 // open: nothing enforced
        if (caller == from) return;           // the owner moving their own token is always allowed
        require(allowedOperator[caller], "operator not allowed");
    }
}
