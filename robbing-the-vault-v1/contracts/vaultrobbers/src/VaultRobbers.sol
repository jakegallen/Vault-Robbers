// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/token/ERC721/ERC721.sol";
import "@openzeppelin/token/common/ERC2981.sol";
import "@openzeppelin/access/Ownable.sol";
import "@openzeppelin/utils/ReentrancyGuard.sol";
import "@openzeppelin/token/ERC20/IERC20.sol";
import "@openzeppelin/utils/Strings.sol";
import "@openzeppelin/utils/cryptography/ECDSA.sol";
import "@openzeppelin/utils/cryptography/EIP712.sol";

/// @dev Canonical ERC-6551 registry (same address on every EVM chain, already live on Robinhood Chain).
interface IERC6551Registry {
    function createAccount(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) external returns (address);
    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) external view returns (address);
}

/// @dev Creator Token Standard (ERC721C) surface. OpenSea and other marketplaces detect a "creator token" via
///      ICreatorToken and enforce the collection's on-chain transfer policy — which is where enforceable royalties live.
///      We expose the standard hooks and call the configured transfer validator (OpenSea's "TX Validator") on every
///      real transfer. The validator is settable and defaults to address(0) (no enforcement, transfers always work), so
///      the collection can be deployed on a chain where the validator is not live yet and enforcement is switched on
///      later with a single setTransferValidator() once the validator contract exists on that chain.
interface ICreatorToken {
    event TransferValidatorUpdated(address oldValidator, address newValidator);
    function getTransferValidator() external view returns (address validator);
    function setTransferValidator(address validator) external;
    function getTransferValidationFunction() external view returns (bytes4 functionSignature, bool isViewFunction);
}
interface ITransferValidator {
    function validateTransfer(address caller, address from, address to, uint256 tokenId) external view;
}

/// @title Vault Robbers
/// @notice 777-piece ERC721 minted in-game (Robbing the Vault) with ROBINVAULT.
///         Payment is pulled straight to `sink` (the ROBINVAULT deployer/fee wallet, 0x888...)
///         so nothing is held by this contract. Mints start UNREVEALED (a question-mark robber
///         placeholder) and the artwork is revealed later with a fair, unpredictable art offset.
///         2% ERC2981 royalty (the amount marketplaces read). ERC721C (Creator Token Standard) compliant: exposes a
///         settable transfer validator so OpenSea can ENFORCE the royalty on-chain once a validator is live on this chain
///         (validator defaults to address(0) = unenforced but never bricked).
contract VaultRobbers is ERC721, ERC2981, Ownable, ReentrancyGuard, EIP712, ICreatorToken {
    using Strings for uint256;
    using ECDSA for bytes32;

    uint256 public constant MAX_SUPPLY = 1000;              // 900 public + 100 team reserve
    uint256 public constant MAX_PER_WALLET = 3;
    uint256 public constant RESERVE_MAX = 100;              // team reserve (free, owner-minted at the end), hard-capped
    uint256 public constant PUBLIC_SUPPLY = MAX_SUPPLY - RESERVE_MAX;   // 900 — the public sale stops here; the last 100 are the team's
    uint96  public constant ROYALTY_BPS = 200;  // 2%

    uint256 public reserveMinted;

    IERC20  public immutable payToken;      // ROBINVAULT (tRVLT on testnet)
    bytes32 public immutable provenanceHash;// commit of the final ordered artwork (fairness)

    // Every Robber is born owning a token-bound "SAC" wallet (ERC-6551), Emblem-Vault style.
    address public constant SAC_REGISTRY = 0x000000006551c19487814612e58FE06813775758;
    address public immutable sacImplementation;

    // Escalating mint price (18-decimal token). Four 25% tiers by 1-indexed token id (1000 supply).
    // OWNER-SETTABLE (2026-09-05, Jake): storage, not constants, so the Safe can re-price via setPrices() as ROBINVAULT moves,
    // with NO redeploy and NO new address ever again. Initial launch schedule (ROBINVAULT ~$0.0032 → entry ~$79, mint-out ~$199k):
    //   tokens 1..250 = 25,000 · 251..500 = 50,000 · 501..750 = 75,000 · 751..1000 = 100,000
    uint256 public PRICE1 = 25000 * 1e18;
    uint256 public PRICE2 = 50000 * 1e18;
    uint256 public PRICE3 = 75000 * 1e18;
    uint256 public PRICE4 = 100000 * 1e18;
    uint256 public constant TIER1_END = 250;
    uint256 public constant TIER2_END = 500;
    uint256 public constant TIER3_END = 750;

    address public sink;                    // where ROBINVAULT payments + royalties go (burn source)
    uint256 public totalMinted;
    bool    public mintActive;

    // ── Website-gated mint ────────────────────────────────────────────────────────────────────────
    // Public mint is CLOSED to direct callers. mint() requires an EIP-712 voucher signed by `signer`
    // (the website's backend key). No valid voucher = revert. This forces every mint through the site,
    // so nobody can call the contract directly to bypass the game and hoard. Per-wallet nonce blocks replay.
    address public signer;                  // backend voucher signer (website)
    mapping(address => uint256) public mintNonce;   // per-wallet voucher nonce (replay protection)
    bytes32 private constant MINT_VOUCHER_TYPEHASH =
        keccak256("MintVoucher(address minter,uint256 qty,uint256 nonce,uint256 deadline)");
    bool    public revealed;
    bool    public metadataFrozen;          // one-way lock: once true, baseURI/unrevealedURI can never change again
    string  public unrevealedURI;           // placeholder metadata for every token pre-reveal
    string  private _baseTokenURI;          // revealed art base (e.g. ipfs://CID/)
    uint256 public startingIndex;           // art offset set at reveal, unknowable in advance
    mapping(address => uint256) public mintedBy;

    // ── ERC721C transfer validator (OpenSea royalty enforcement) ──
    // Defaults to address(0): transfers are unrestricted until an owner points this at a live validator on this chain.
    address private _transferValidator;

    event Minted(address indexed to, uint256 indexed tokenId, uint256 pricePaid);
    event Revealed(string baseURI, uint256 startingIndex);
    event MintActiveSet(bool active);
    event SinkSet(address sink);
    event RoyaltyReceiverSet(address receiver);
    event SignerSet(address signer);
    event SacOpened(uint256 indexed tokenId, address account);
    event BaseURISet(string baseURI);
    event MetadataFrozen();

    constructor(
        address payToken_,
        address sink_,
        bytes32 provenanceHash_,
        string memory unrevealedURI_,
        address sacImplementation_,
        address signer_,
        address royaltyReceiver_
    ) ERC721("Vault Robbers", "ROBBERS") Ownable(msg.sender) EIP712("Vault Robbers", "1") {
        require(payToken_ != address(0) && sink_ != address(0) && sacImplementation_ != address(0) && signer_ != address(0) && royaltyReceiver_ != address(0), "zero addr");
        payToken = IERC20(payToken_);
        sink = sink_;                       // where minters' ROBINVAULT payments go (dev/token treasury, burnable)
        provenanceHash = provenanceHash_;
        unrevealedURI = unrevealedURI_;
        sacImplementation = sacImplementation_;
        signer = signer_;
        _setDefaultRoyalty(royaltyReceiver_, ROYALTY_BPS);   // secondary royalties go to a SEPARATE NFT treasury, decoupled from the mint sink
    }

    /// @notice The token-bound SAC address for a Robber (deterministic; exists from mint).
    function tokenAccount(uint256 tokenId) external view returns (address) {
        return IERC6551Registry(SAC_REGISTRY).account(sacImplementation, bytes32(0), block.chainid, address(this), tokenId);
    }

    /// @dev Open the Robber's SAC at mint. try/catch so a registry hiccup can never block a mint.
    function _openSac(uint256 tokenId) internal {
        try IERC6551Registry(SAC_REGISTRY).createAccount(sacImplementation, bytes32(0), block.chainid, address(this), tokenId) returns (address a) {
            emit SacOpened(tokenId, a);
        } catch {}
    }

    /// @notice Price of a single token by its 1-indexed id (escalating tiers). `view` (not `pure`) now that prices are settable storage.
    function priceForToken(uint256 id) public view returns (uint256) {
        if (id <= TIER1_END) return PRICE1;
        if (id <= TIER2_END) return PRICE2;
        if (id <= TIER3_END) return PRICE3;
        return PRICE4;
    }

    /// @notice Price of the next token to be minted.
    function currentPrice() external view returns (uint256) {
        return priceForToken(totalMinted + 1);
    }

    /// @notice Total cost to mint `qty` now (sums across any tier boundary).
    function quote(uint256 qty) public view returns (uint256 total) {
        for (uint256 i = 1; i <= qty; i++) total += priceForToken(totalMinted + i);
    }

    /// @notice Mint up to MAX_PER_WALLET. WEBSITE-GATED: requires a fresh EIP-712 voucher signed by `signer`
    ///         for exactly (msg.sender, qty, current nonce, deadline). Direct/unauthorized calls revert.
    ///         Also requires an ERC20 allowance of `quote(qty)` to this contract.
    /// @param qty       number to mint (1..MAX_PER_WALLET)
    /// @param deadline  unix time after which the voucher is void
    /// @param signature signer's EIP-712 signature over the MintVoucher
    function mint(uint256 qty, uint256 deadline, bytes calldata signature) external nonReentrant {
        require(mintActive, "mint closed");
        require(qty > 0 && qty <= MAX_PER_WALLET, "bad qty");
        require(mintedBy[msg.sender] + qty <= MAX_PER_WALLET, "wallet cap 3");
        require(totalMinted - reserveMinted + qty <= PUBLIC_SUPPLY, "public sold out");   // public stops at 900; the last 100 are reserved for the team
        require(block.timestamp <= deadline, "voucher expired");

        // Verify the website's voucher. The nonce is consumed so a voucher can be used only once.
        bytes32 structHash = keccak256(abi.encode(MINT_VOUCHER_TYPEHASH, msg.sender, qty, mintNonce[msg.sender], deadline));
        address rec = _hashTypedDataV4(structHash).recover(signature);
        require(rec == signer, "bad voucher");
        unchecked { mintNonce[msg.sender]++; }

        uint256 cost = quote(qty); // escalating tiers, summed across any boundary
        _safeTransferFromERC20(msg.sender, sink, cost); // ROBINVAULT -> sink (0x888) for burn

        mintedBy[msg.sender] += qty;
        for (uint256 i = 0; i < qty; i++) {
            uint256 id = ++totalMinted; // ids 1..1000
            _safeMint(msg.sender, id);
            _openSac(id);               // every Robber born with its SAC wallet
            emit Minted(msg.sender, id, priceForToken(id));
        }
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        if (!revealed) return unrevealedURI;
        // fair offset: the art file a token points to depends on startingIndex (set at reveal)
        uint256 art = (tokenId + startingIndex) % MAX_SUPPLY; // 0..776
        return string(abi.encodePacked(_baseTokenURI, art.toString(), ".json"));
    }

    // ---- owner controls ----
    /// @notice Free team reserve mint. No payment, ignores the per-wallet cap, hard-capped at RESERVE_MAX (100) — mint the last 100 for the team at the end.
    function reserveMint(address to, uint256 qty) external onlyOwner {
        require(to != address(0), "zero addr");
        require(reserveMinted + qty <= RESERVE_MAX, "reserve cap 100");
        require(totalMinted + qty <= MAX_SUPPLY, "sold out");
        reserveMinted += qty;
        for (uint256 i = 0; i < qty; i++) {
            uint256 id = ++totalMinted; // shares the same 1..777 id space and supply
            _safeMint(to, id);
            _openSac(id);               // every Robber born with its SAC wallet
            emit Minted(to, id, 0);
        }
    }

    function setMintActive(bool v) external onlyOwner { mintActive = v; emit MintActiveSet(v); }

    /// @notice Re-price the four tiers. Amounts are WHOLE ROBINVAULT (18 decimals applied internally), e.g. setPrices(25000,50000,75000,100000).
    ///         Lets the owner (Safe) raise/lower as ROBINVAULT moves with NO redeploy. Does not change already-minted tokens.
    event PricesSet(uint256 p1, uint256 p2, uint256 p3, uint256 p4);
    function setPrices(uint256 p1, uint256 p2, uint256 p3, uint256 p4) external onlyOwner {
        PRICE1 = p1 * 1e18; PRICE2 = p2 * 1e18; PRICE3 = p3 * 1e18; PRICE4 = p4 * 1e18;
        emit PricesSet(p1, p2, p3, p4);
    }

    /// @notice Rotate the website's voucher signer (e.g. key rotation). Owner only.
    function setSigner(address s) external onlyOwner { require(s != address(0), "zero addr"); signer = s; emit SignerSet(s); }

    function setUnrevealedURI(string calldata u) external onlyOwner {
        require(!revealed, "revealed");
        require(!metadataFrozen, "frozen");
        unrevealedURI = u;
    }

    /// @notice Update the revealed art/metadata base URI (e.g. tweak descriptions, or migrate hosted -> IPFS).
    ///         Allowed only after reveal and only until metadata is frozen.
    function setBaseURI(string calldata baseURI_) external onlyOwner {
        require(revealed, "not revealed");
        require(!metadataFrozen, "frozen");
        _baseTokenURI = baseURI_;
        emit BaseURISet(baseURI_);
    }

    /// @notice Permanently lock the metadata (unrevealedURI + baseURI can never change again). One-way.
    function freezeMetadata() external onlyOwner {
        metadataFrozen = true;
        emit MetadataFrozen();
    }

    function setSink(address s) external onlyOwner {
        require(s != address(0), "zero addr");
        sink = s;   // mint-proceeds destination only; royalty is decoupled (see setRoyaltyReceiver)
        emit SinkSet(s);
    }

    /// @notice Update the ERC-2981 royalty recipient (the separate NFT treasury), independent of the mint sink.
    function setRoyaltyReceiver(address r) external onlyOwner {
        require(r != address(0), "zero addr");
        _setDefaultRoyalty(r, ROYALTY_BPS);
        emit RoyaltyReceiverSet(r);
    }

    // ---- rescue (safety net) ----
    // Mint proceeds are pulled straight to `sink`, so this contract never holds funds in normal operation. These
    // owner-only rescues exist purely to recover tokens/ETH accidentally sent to the contract address. (Jake 2026-09-05)
    event Rescued(address indexed token, address indexed to, uint256 amount);
    /// @notice Recover ERC-20 tokens accidentally sent to this contract.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero addr");
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "rescue failed");
        emit Rescued(token, to, amount);
    }
    /// @notice Recover ETH accidentally forced into this contract (it has no payable path, so this is a last-resort net).
    function rescueETH(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "zero addr");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "eth rescue failed");
        emit Rescued(address(0), to, amount);
    }

    /// @notice Reveal the artwork. Locks in a pseudo-random starting offset from the reveal block.
    function reveal(string calldata baseURI_) external onlyOwner {
        require(!revealed, "already revealed");
        require(!metadataFrozen, "frozen");
        _baseTokenURI = baseURI_;
        revealed = true;
        uint256 si = uint256(keccak256(abi.encodePacked(blockhash(block.number - 1), address(this), totalMinted))) % MAX_SUPPLY;
        if (si == 0) si = 1;
        startingIndex = si;
        emit Revealed(baseURI_, si);
    }

    // ---- helpers ----
    /// @dev SafeERC20-style transferFrom that tolerates tokens that don't return a bool.
    function _safeTransferFromERC20(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(payToken).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "payment failed");
    }

    // ── ERC721C (Creator Token Standard) — OpenSea royalty enforcement ──
    /// @notice The transfer validator (OpenSea's "TX Validator") this collection enforces. address(0) = no enforcement.
    function getTransferValidator() external view returns (address validator) { return _transferValidator; }

    /// @notice Point the collection at a transfer validator to turn on enforced royalties, or address(0) to turn it off.
    ///         Set this to the CreatorTokenTransferValidator address on this chain ONCE it is deployed there; leaving it
    ///         at address(0) keeps transfers unrestricted (safe on chains where no validator is live yet). Owner only.
    function setTransferValidator(address validator) external onlyOwner {
        emit TransferValidatorUpdated(_transferValidator, validator);
        _transferValidator = validator;
    }

    /// @notice Tells marketplaces which function to call on the validator, and that it is a view (staticcall). Matches
    ///         the ERC721C standard: validateTransfer(address caller,address from,address to,uint256 tokenId), view.
    function getTransferValidationFunction() external pure returns (bytes4 functionSignature, bool isViewFunction) {
        return (ITransferValidator.validateTransfer.selector, true);
    }

    /// @dev OZ v5 transfer hook. On a REAL transfer (not mint/burn) with a validator set, ask the validator to approve
    ///      it; a disallowed transfer (e.g. an operator that would skip royalties) reverts the whole tx atomically.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = super._update(to, tokenId, auth);
        address v = _transferValidator;
        if (v != address(0) && from != address(0) && to != address(0)) {
            ITransferValidator(v).validateTransfer(msg.sender, from, to, tokenId);
        }
        return from;
    }

    function supportsInterface(bytes4 id) public view override(ERC721, ERC2981) returns (bool) {
        return id == type(ICreatorToken).interfaceId || super.supportsInterface(id);
    }
}
