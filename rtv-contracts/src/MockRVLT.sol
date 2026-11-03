// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockRVLT — a testnet stand-in for the real RVLT token (open mint for testing only).
contract MockRVLT is ERC20 {
    constructor() ERC20("Mock RobinVault", "tRVLT") {
        _mint(msg.sender, 1_000_000_000 ether);
    }
    /// @notice Anyone can mint on testnet so players can grab RVLT to play.
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}
