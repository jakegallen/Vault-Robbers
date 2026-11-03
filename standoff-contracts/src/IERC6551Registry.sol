// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Canonical ERC-6551 registry interface. Only the deterministic `account(...)` view is needed: it
/// computes a token-bound account (TBA) address for a given NFT (chainId, contract, tokenId) + account
/// implementation + salt. The address is PURE CREATE2 math — it is the same whether or not the account has been
/// deployed, and an ERC20 can be transferred to it with no deploy. StandoffEscrow uses this to route the robber
/// share of the rake to a randomly-drawn Vault Robber's TBA WITHOUT any mint/ownerOf dependency (so an unminted
/// or burned tokenId can never revert settle). The canonical registry on Robinhood Chain (4663) and every
/// EVM chain is 0x000000006551c19487814612e58FE06813775758.
interface IERC6551Registry {
    /// @notice Returns the computed (deterministic, CREATE2) token-bound account address. View, never reverts.
    function account(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external view returns (address);
}
