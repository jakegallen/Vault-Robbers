// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Minimal mintable ERC721 standing in for the Vault Robber NFT in holder-discount tests.
contract MockERC721 is ERC721 {
    uint256 private _nextId;
    constructor() ERC721("Mock Vault Robber", "mVR") {}
    function mint(address to) external returns (uint256 id) {
        id = ++_nextId;
        _mint(to, id);
    }
}
