// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/token/ERC721/IERC721.sol";
import "@openzeppelin/interfaces/IERC1271.sol";
import "@openzeppelin/utils/cryptography/SignatureChecker.sol";

// --- ERC-6551 account interfaces (per EIP-6551 v0.3.1) ---
interface IERC6551Account {
    function token() external view returns (uint256 chainId, address tokenContract, uint256 tokenId);
    function state() external view returns (uint256);
    function isValidSigner(address signer, bytes calldata context) external view returns (bytes4 magicValue);
}
interface IERC6551Executable {
    function execute(address to, uint256 value, bytes calldata data, uint8 operation) external payable returns (bytes memory);
}

/// @title Loot Bag — the token-bound loot wallet ("Loot Bag", ticker LOOT) for each Vault Robber.
/// @notice The EVM-native echo of Emblem Vault: the NFT owns a wallet. Whoever holds the Robber
///         controls its Loot Bag and everything inside it (ETH, ERC-20s, stock tokens, other NFTs);
///         sell the Robber and the Loot Bag ships with it. No fungible token required — the NFT IS the account.
///         Deployed as the implementation behind the canonical ERC-6551 registry (0x000000006551c...5758).
contract LootBag is IERC1271, IERC6551Account, IERC6551Executable {
    uint256 public state;

    /// @notice Display name / ticker for tools and explorers. The Loot Bag is an account (ERC-6551), not a token,
    ///         so these are purely cosmetic view helpers — there is no transferable "LOOT" supply.
    function name() external pure returns (string memory) { return "Loot Bag"; }
    function symbol() external pure returns (string memory) { return "LOOT"; }

    receive() external payable {}

    /// @notice Run any call from the Loot Bag. Only the current Robber owner can sign it.
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory result)
    {
        require(_isValidSigner(msg.sender), "Loot Bag: not Robber owner");
        require(operation == 0, "Loot Bag: only call ops");
        ++state;
        bool success;
        (success, result) = to.call{value: value}(data);
        if (!success) {
            assembly { revert(add(result, 32), mload(result)) }
        }
    }

    function isValidSigner(address signer, bytes calldata) external view returns (bytes4) {
        return _isValidSigner(signer) ? IERC6551Account.isValidSigner.selector : bytes4(0);
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        return SignatureChecker.isValidSignatureNow(owner(), hash, signature)
            ? IERC1271.isValidSignature.selector
            : bytes4(0);
    }

    /// @notice The Robber this Loot Bag belongs to (decoded from the registry's appended immutable data).
    function token() public view returns (uint256, address, uint256) {
        bytes memory footer = new bytes(0x60);
        assembly { extcodecopy(address(), add(footer, 0x20), 0x4d, 0x60) }
        return abi.decode(footer, (uint256, address, uint256));
    }

    /// @notice Current controller of the Loot Bag = current owner of the bound Robber NFT.
    function owner() public view returns (address) {
        (uint256 chainId, address tokenContract, uint256 tokenId) = token();
        if (chainId != block.chainid) return address(0);
        return IERC721(tokenContract).ownerOf(tokenId);
    }

    function _isValidSigner(address signer) internal view returns (bool) {
        return signer == owner();
    }

    // let the Loot Bag safely receive NFTs (so a Robber can hold other NFTs / stock-token NFTs)
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) { return 0x150b7a02; }
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) { return 0xf23a6e61; }
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) { return 0xbc197c81; }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7   // ERC165
            || id == 0x6faff5f1   // IERC6551Account
            || id == 0x51945447   // IERC6551Executable
            || id == 0x150b7a02   // ERC721Receiver
            || id == 0x4e2312e0;  // ERC1155Receiver
    }
}
