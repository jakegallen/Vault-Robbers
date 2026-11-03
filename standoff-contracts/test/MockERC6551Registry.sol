// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC6551Registry} from "../src/IERC6551Registry.sol";

/// @notice Faithful stand-in for the canonical ERC-6551 registry (0x000000006551c19487814612e58FE06813775758).
/// It implements the EXACT `account(...)` CREATE2 derivation the canonical registry uses: the deployed account is a
/// minimal ERC-1167-style proxy whose creation code embeds [implementation] and whose constructor args /
/// immutable footer are abi.encode(salt, chainId, tokenContract, tokenId). The address is pure CREATE2 math from
/// (this registry, salt, keccak256(creationCode)). Because StandoffEscrow computes the TBA via this same interface,
/// a test can derive the SAME expected address with the published algorithm and assert the contract matches — proving
/// the robber share lands at the correct, deterministic, deploy-independent token-bound account.
contract MockERC6551Registry is IERC6551Registry {
    // Canonical ERC-6551 account proxy creation code (ERC-1167 header + footer), matching the reference registry.
    // header: 0x3d60ad80600a3d3981f3363d3d373d3d3d363d73 <impl> 5af43d82803e903d91602b57fd5bf3
    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view returns (address) {
        bytes memory code = abi.encodePacked(
            hex"3d60ad80600a3d3981f3363d3d373d3d3d363d73",
            implementation,
            hex"5af43d82803e903d91602b57fd5bf3",
            abi.encode(salt, chainId, tokenContract, tokenId)
        );
        bytes32 bytecodeHash = keccak256(code);
        bytes32 data = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, bytecodeHash));
        return address(uint160(uint256(data)));
    }
}
