// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC6551Registry} from "./IERC6551Registry.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

/// @title StandoffEscrow
/// @notice On-chain buy-in escrow + verifiable payout for Vault Standoff. UUPS-UPGRADEABLE: the logic can be
/// replaced by the owner (the 2-of-2 Safe) via _authorizeUpgrade, so rules can change post-launch. Funds live
/// in the proxy and survive upgrades. Players trust the Safe not to upgrade maliciously (disclosed in the UI).
///
/// The GAME ENGINE IS DELIBERATELY OFF-CHAIN (so bots can't read the pick distribution or manipulate
/// resolution). This contract only handles MONEY and makes every payout provable:
///   * Buy-ins are pulled into a per-round pot. Funds can ONLY leave by contract rules.
///   * Settlement can only pay that round's own participants, and only pot minus a capped rake.
///   * The server commits a seed hash before revealing it at settle. A wrong or absent result can be voided
///     into full refunds. NOTE: winners are asserted by the signer, not derived on-chain (last-robber-standing
///     is adjudicated by the off-chain engine); the contract bounds abuse to one round's pot + the void window.
///   * NOTHING is transferred at settle. Winners pull their share after a challenge window; rake is paid
///     after the window too. So voiding during the window always leaves the whole pot available to refund.
///
/// Roles: `owner` (the 2-of-2 Safe) sets config AND authorizes upgrades. `settlementSigner` (a rotatable hot
/// key) runs rounds but can never withdraw arbitrarily or pay a non-participant. `relayer` (a separate hot key)
/// may submit player-signed auto-buy authorizations. `guardian` (owner-settable) may void un-settled rounds
/// inside the post-deadline grace window before the public void path opens.
///
/// @dev VERSION 2 (threshold-fill upgrade). Adds, append-only and storage-layout-safe:
///   1. lockRound  -> fill-driven start (signer moves lockTime earlier; rounds open with a far-future sentinel)
///   2. maxTicketsPerWallet -> owner-settable per-wallet cap enforced in buyIn
///   3. buyInFor   -> relayer-submitted EIP-712 auto-buy authorization (allowance-to-escrow, player-revocable)
///   4. guardian + voidGrace -> close the post-deadline public-void griefing window
///   5. Round.rakeBpsSnap -> rake is snapshotted at openRound and used at settle (mid-round rake change can't stall)
///
/// @dev VERSION 3 (rake-split snapshot). Append-only and storage-layout-safe:
///   6. Round.burnShareSnap -> the burn/treasury split is snapshotted at openRound and used in payRake, so a
///      mid-round setRake can't redirect an already-committed round's rake split (C-1 fix, mirrors rakeBpsSnap)
///
/// @dev VERSION 4 (on-chain holder half-price). Append-only and storage-layout-safe:
///   7. holderNft + holderDiscountBps -> Vault Robber NFT holders pay a DISCOUNTED per-ticket price at buy time
///      (default 5000 bps = 50% off = half entry). The discount is applied in buyIn AND buyInFor (checked against
///      the beneficiary/player), so the pot receives the discounted amount for holder seats. This is INTENTIONAL:
///      the pot is smaller for holder seats, there is NO treasury top-up. It REPLACES the prior off-chain rebate.
///      holderNft is owner-settable (0 = discount OFF, everyone pays full). isHolder(a) = holderNft.balanceOf(a) > 0.
///      These two vars PACK into a single new storage slot (address 20B + uint16 2B); together with the roundPaid
///      mapping's base slot, __gap shrinks 41 -> 39 (uint256[39]) so the
///      overall layout end-slot is unchanged. Per-round rake/burn accounting still derives from `pot`, so a smaller
///      pot simply means smaller payouts (correct) with NO change to the snapshot logic.
///
/// @dev VERSION 8 (relayer allowlist / key-pool). Append-only and storage-layout-safe: adds ONE new storage slot, the
///      isRelayer mapping (slot 17, its base counts as one reserved slot; entries live at keccak-derived slots), placed
///      strictly AFTER the last V6 storage var (rangeSpent, slot 16) and before __gap, so __gap shrinks uint256[36] ->
///      uint256[35] and the layout end-slot (52) is UNCHANGED. Every pre-existing variable keeps its exact slot/offset.
///      Purpose: allow MULTIPLE relayer hot keys to submit auto-buys in parallel (one key = one serial nonce lane; a
///      pool = parallel throughput for a launch rush). The legacy single `relayer` var + setRelayer stay for back-compat;
///      a new internal _isRelayer(a) accepts either the legacy relayer OR any owner-allowlisted key. The ONLY behaviour
///      change is the "not relayer" gate in buyInFor + buyInForRange, which now passes for any allowlisted key (same
///      revert string). No money path (settle/void/rollover/rake/claim/refund), EIP-712 domain, settlement-signer
///      isolation, or owner-only _authorizeUpgrade is touched.
///
/// @dev VERSION 9 (random Vault Robber airdrop). Append-only and storage-layout-safe: adds FOUR new storage slots
///      strictly AFTER the last V8 var (isRelayer, slot 17) and before __gap:
///        * slot 18 : robberNft (address, 20B) + robberSupply (uint32, 4B) + robberShareBps (uint16, 2B) packed (26B)
///        * slot 19 : robberRegistry (address)
///        * slot 20 : robberAccountImpl (address)
///        * slot 21 : robberSalt (bytes32)
///      __gap shrinks uint256[35] -> uint256[31] so the layout end-slot (52) is UNCHANGED; every pre-existing
///      variable keeps its exact slot/offset. UUPS-upgrade-safe.
///      MECHANIC: at settle, a configurable share (robberShareBps) OF THE ALREADY-COMPUTED RAKE is routed to a
///      RANDOM Vault Robber's ERC-6551 token-bound account; the rest of the rake keeps flowing to treasury/burn.
///      The winner budget (pot - rake + jackpot) is UNCHANGED — the robber share comes out of the rake, not the pot.
///      The winning tokenId is drawn ON-CHAIN from the revealed settle seed, deterministic + verifiable + ungrindable:
///        tokenId = (uint256(keccak256(abi.encodePacked(seed, id, "robber"))) % robberSupply) + 1
///      domain-separated with the "robber" label so it is independent of any game-winner draw. The recipient is that
///      tokenId's TBA from the canonical 6551 registry — PURE deterministic CREATE2 math, no mint/ownerOf dependency,
///      so an unminted/burned id can NEVER revert settle. INERT UNTIL CONFIGURED: if robberNft==0 || robberSupply==0
///      || robberShareBps==0 the robber leg is SKIPPED entirely and the whole rake flows to treasury/burn exactly as
///      in V8, so the upgrade can ship before mint-reveal without changing any existing-round or settle behaviour.
///      The transfer happens at payRake (the single existing rake-settlement choke point, after the challenge window),
///      so the void->refund safety net is fully preserved: no rake — robber share included — ever moves at settle.
///
/// @dev VERSION 10 (RELAYER-FUNDED buy-in for cross-chain / Phantom players). Append-only and storage-layout-safe:
///      adds TWO new storage slots strictly AFTER the last V9 var (robberSalt, slot 21) and before __gap:
///        * slot 22 : fundedPaid  (mapping round -> player -> RVLT fronted by a relayer for that player this round)
///        * slot 23 : fundedBy    (mapping round -> player -> the relayer that fronted it; 0 = none/self-funded)
///      __gap shrinks uint256[31] -> uint256[29] so the layout end-slot (52) is UNCHANGED; every pre-existing variable
///      keeps its exact slot/offset. UUPS-upgrade-safe.
///      PROBLEM: a Solana/Phantom player CANNOT operate on Robinhood Chain 4663 (no 4663 wallet/gas) and their RVLT has
///      no EIP-2612 permit, so they can neither approve() the escrow nor sign/pay gas on 4663. The existing relayer path
///      (buyInFor/buyInForRange) still does RVLT.transferFrom(PLAYER, escrow, cost), which requires the player's 4663
///      approval — impossible for them.
///      MECHANIC: buyInForRangeFunded is a relayer-only twin of buyInForRange with ONE difference — the RVLT is pulled
///      from the RELAYER (msg.sender, who pre-approves the escrow once) instead of the player. The player's EIP-712 RANGE
///      authorization is verified and consumed EXACTLY as buyInForRange (same AUTOBUY_RANGE_TYPEHASH, same domain, same
///      deadline/nonce/rangeSpent replay guard, same maxTickets/maxEntry/per-wallet-cap bounds), so the relayer can only
///      seat a player the player authorized, for no more than the player signed. The player is credited identically to
///      buyInForRange (same tickets[], roundPaid[], pot[], winner eligibility); `player` — never the relayer — is the
///      seated/potential winner. The relayer can NEVER overspend (cost capped at signed maxEntry * maxTickets) nor seat
///      an unauthorized player (signature bound to player).
///      REFUND SAFETY: because the RELAYER fronted the RVLT for a funded seat, a voided round must return that RVLT to the
///      FUNDER, not to the player (who paid on their own chain via the off-chain swap, not on 4663). fundedPaid/fundedBy
///      record exactly how much each relayer fronted per seat. refund() is unchanged for self-funded seats (fundedPaid==0
///      => byte-for-byte identical) and, for a seat with a funded portion, returns the funded portion to the funder and
///      only any self-paid remainder to the player. refundFor(id, player) lets the server trigger a Solana player's refund
///      without the player needing 4663 gas (destinations are immutable stored data, so it is safe for anyone to call).
///      No change to settle/claim/payWinners/payRake/void/rolloverRound or any existing selector; _buyIn is REUSED as-is
///      (it already supports payer != beneficiary). This upgrade can ship before any funded buy occurs without changing
///      any existing-round behaviour (fundedPaid/fundedBy are zero for every pre-V10 seat).
contract StandoffEscrow is Initializable, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    // ---- storage (append-only across upgrades; never reorder/remove) ----
    // ---- V1 LAYOUT (do not touch) ----
    IERC20 public token;                // ROBINVAULT
    address public settlementSigner;    // hot key: opens/commits/settles rounds (bounded by rules)
    address public treasury;            // receives the treasury portion of the rake
    address public burnSink;            // receives the burn portion of the rake (e.g. dead address / deployer)
    uint16 public rakeBps;              // total rake, basis points (<= MAX_RAKE_BPS)
    uint16 public burnShareBps;         // portion OF THE RAKE that is burned; remainder goes to treasury
    uint32 public challenge;            // seconds after settle before winners/rake can be paid (dispute window)

    uint16 public constant MAX_RAKE_BPS = 1000; // 10% hard ceiling
    uint16 public constant BPS = 10000;
    uint256 public constant MAX_TICKETS = 100;  // per buyIn call
    uint32 public constant MIN_CHALLENGE = 300; // 5min floor: the owner's only backstop to void a bad settle

    enum Status { None, Open, Committed, Settled, Voided, RolledOver }
    struct Round {
        uint128 entry;      // RVLT per ticket
        uint128 pot;        // total escrowed this round
        uint128 rakeOwed;   // rake computed at settle, paid after the window
        uint64 lockTime;    // no buy-ins at/after this
        uint64 deadline;    // if not settled by here, anyone can void -> refunds
        uint64 claimAt;     // winners/rake payable at/after this (set on settle)
        bool rakePaid;
        bytes32 seedHash;   // commitment
        Status status;
        // ---- V2 APPEND (struct lives in a mapping; appending a member only extends into previously-unused
        //      slots per key, so this is storage-layout-safe for the UUPS upgrade) ----
        uint16 rakeBpsSnap; // rake basis points snapshotted at openRound; used at settle so a mid-round
                            //   setRake can't change this round's economics or stall settlement (BASE-2 fix)
        // ---- V3 APPEND (last field; appended for the same storage-safe reason as rakeBpsSnap: struct lives
        //      in a mapping, so a new trailing member only extends into previously-unused per-key slots) ----
        uint16 burnShareSnap; // burn share (bps OF THE RAKE) snapshotted at openRound; used in payRake so a
                              //   mid-round setRake can't redirect an already-committed round's rake split (C-1 fix)
        // ---- V9 APPEND (last field; storage-safe for the same reason as the V2/V3 appends: the struct lives in a
        //      mapping, so a new trailing member only extends into previously-unused per-key slots). The seed revealed
        //      at settle is persisted here so payRake can draw the winning robber tokenId from it (the raw seed is not
        //      otherwise kept on-chain — only seedHash is). Stays bytes32(0) for rounds that never settle. ----
        bytes32 seedRevealed; // the seed revealed at settle(); consumed by payRake for the deterministic robber draw
    }

    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => uint256)) public tickets;   // round -> player -> tickets
    mapping(uint256 => mapping(address => uint256)) public winShare;  // round -> player -> claimable payout
    mapping(uint256 => mapping(address => bool)) public settled;      // round -> player -> claimed/refunded

    // ---- V2 APPENDED STATE (new storage slots, added strictly after V1 state, before __gap) ----
    // Verified layout (forge inspect): V1 occupies slots 0-7 byte-for-byte unchanged; the four appended vars
    // take slots 8, 9, 10 (guardian+voidGrace packed), 11; __gap[41] then spans 12..52 — the SAME end slot the
    // old __gap[45] (slots 8..52) reached. Append-only, no reorder, no overlap. UUPS-upgrade-safe.
    /// @notice Per-wallet ticket cap enforced in buyIn. 0 = unlimited (back-compat default). (slot 8)
    uint128 public maxTicketsPerWallet;
    /// @notice Dedicated auto-buy relayer hot key. Submits player-signed buyInFor authorizations only.
    ///         Distinct from settlementSigner and owner. 0 = auto-buy disabled. (slot 9)
    address public relayer;
    /// @notice May void un-settled rounds inside the post-deadline grace window before the public path opens.
    ///         0 = no guardian (only owner may void in the window). (slot 10, packed with voidGrace)
    address public guardian;
    /// @notice Seconds after `deadline` during which only owner/guardian may void an un-settled round; after
    ///         deadline + voidGrace, anyone may void (public liveness backstop). 0 = public void at deadline
    ///         (V1 behaviour). (slot 10, packed with guardian: 20 + 4 bytes fit one 32-byte slot)
    uint32 public voidGrace;
    /// @notice Per-player monotonic nonce for EIP-712 auto-buy authorizations (replay protection). (slot 11)
    mapping(address => uint256) public autoBuyNonce;

    // ---- V4 APPENDED STATE (new storage, added strictly after V2 state, before __gap) ----
    // Verified layout (forge inspect): holderNft (20B) + holderDiscountBps (2B) PACK into slot 12 (the first slot
    // previously inside __gap). __gap then shrinks uint256[41] -> uint256[40], spanning slots 13..52 — the SAME
    // end slot the old __gap[41] (slots 12..52) reached. Append-only, no reorder, no overlap. UUPS-upgrade-safe.
    /// @notice The Vault Robber ERC721 whose holders pay the discounted (half) entry. 0 = holder discount OFF
    ///         (everyone pays full entry; isHolder() is always false). Owner-settable. (slot 12)
    address public holderNft;
    /// @notice Per-ticket discount for NFT holders, in basis points OF the entry (5000 = 50% off = half price).
    ///         Applied at buy time in buyIn/buyInFor; the pot receives the discounted amount (no treasury top-up).
    ///         <= BPS. 0 = no discount (holders pay full). (slot 12, packed with holderNft: 20 + 2 bytes fit one slot)
    uint16 public holderDiscountBps;
    /// @notice Actual RVLT each player contributed to a round (round -> player -> amount paid). Needed because
    ///         with the holder discount a player's paid amount is NO LONGER `entry * tickets` uniformly, so refunds
    ///         on a voided round must return exactly what was paid (otherwise a discounted holder would be
    ///         over-refunded and drain the pot). Accumulated in _buyIn, consumed in refund. (slot 13)
    mapping(uint256 => mapping(address => uint256)) public roundPaid;

    // ---- V5 APPENDED STATE (progressive jackpot + auto-send). Append-only after roundPaid; jackpot = slot 14,
    //      roundJackpotApplied mapping base = slot 15. __gap shrinks 39 -> 37 so the layout end-slot (52) is unchanged. ----
    /// @notice Persistent PROGRESSIVE JACKPOT (RVLT). Grows when a FINAL-VAULT standoff ends with everybody busted:
    ///         rolloverRound moves that round's whole pot here (no rake, no refund). The next round that is actually
    ///         WON folds the entire jackpot into the winner's payout and resets it to 0. Always backed by tokens
    ///         already escrowed in this contract (a rolled-over pot never leaves). (slot 14)
    uint256 public jackpot;
    /// @notice Jackpot amount FOLDED into a given settled round's payout budget (round -> amount). Recorded at settle
    ///         so that voiding a bad settle DURING the challenge window RESTORES the jackpot (otherwise a voided
    ///         jackpot-winning settle would silently lose the accumulated jackpot). (slot 15)
    mapping(uint256 => uint256) public roundJackpotApplied;

    // ---- V6 APPENDED STATE (range auto-buy: ONE signature covers many rounds). Append-only after roundJackpotApplied;
    //      rangeSpent mapping base = slot 16. __gap shrinks 37 -> 36 so the layout end-slot (52) is unchanged. ----
    /// @notice Per-(player,round) consumed marker for a RANGE auto-buy authorization, so the relayer can enter a player
    ///         into each round of the signed range EXACTLY ONCE off a single signature (buyInForRange). (slot 16)
    mapping(address => mapping(uint256 => bool)) public rangeSpent;

    // ---- V8 APPENDED STATE (relayer key-pool / allowlist). Append-only after rangeSpent; isRelayer mapping base = slot 17,
    //      its entries live at keccak-derived slots so the base counts as one reserved slot. __gap shrinks 36 -> 35 so the
    //      layout end-slot (52) is unchanged. Append-only, no reorder, no overlap. UUPS-upgrade-safe. ----
    /// @notice Owner-allowlisted relayer hot keys. ANY address with isRelayer[addr]==true may submit player-signed
    ///         auto-buys (buyInFor / buyInForRange), IN ADDITION to the legacy single `relayer`. A pool of keys lets the
    ///         server run multiple serial nonce lanes in parallel for a launch rush. Owner-settable via setRelayerAllowed.
    ///         Same custody guarantees as before: an allowlisted relayer can only pull funds FROM the player into the pot,
    ///         never redirect them; it cannot settle, void, or withdraw. (slot 17)
    mapping(address => bool) public isRelayer;

    // ---- V9 APPENDED STATE (random Vault Robber airdrop). Append-only after isRelayer; FOUR new slots placed strictly
    //      AFTER the last V8 var (isRelayer, slot 17) and before __gap. __gap shrinks 35 -> 31 so the layout end-slot
    //      (52) is UNCHANGED. Append-only, no reorder, no overlap. UUPS-upgrade-safe.
    //      Slot math (verified by forge inspect): robberNft (20B) + robberSupply (4B) + robberShareBps (2B) = 26B pack
    //      into slot 18; robberRegistry = slot 19; robberAccountImpl = slot 20; robberSalt = slot 21. __gap[31] = 22..52.
    //
    //      ALL FOUR are set together via setRobberConfig AFTER mint closes (final minted supply known). Until then they
    //      are zero and the robber leg is INERT (see payRake): settle + rake route exactly as V8 for every existing round.
    /// @notice The Vault Robbers ERC721 (0xABC6c4F5d1F31326b419c2645C981743a845313a on 4663). Identifies the collection
    ///         whose random tokenId wins the robber share of the rake. 0 = robber airdrop OFF. (slot 18)
    address public robberNft;
    /// @notice Final MINTED supply of Vault Robbers, set at reveal once mint closes. The on-chain draw is
    ///         `mod robberSupply`, so the winning tokenId is always in [1, robberSupply]. 0 = robber airdrop OFF. (slot 18)
    uint32 public robberSupply;
    /// @notice Share OF THE RAKE routed to the drawn robber's TBA, in basis points (5000 = half the rake). <= BPS.
    ///         The remainder of the rake keeps flowing to burn/treasury per burnShareSnap. 0 = robber airdrop OFF. (slot 18)
    uint16 public robberShareBps;
    /// @notice Canonical ERC-6551 registry (0x000000006551c19487814612e58FE06813775758 on 4663 and every EVM chain).
    ///         Used to compute the drawn tokenId's token-bound account deterministically (CREATE2, no deploy needed). (slot 19)
    address public robberRegistry;
    /// @notice The ERC-6551 account IMPLEMENTATION we standardize on for the TBA derivation. Set at reveal; the TBA
    ///         address depends on it. (slot 20)
    address public robberAccountImpl;
    /// @notice Salt for the account() derivation (default 0). Part of the deterministic TBA address. (slot 21)
    bytes32 public robberSalt;

    // ---- V10 APPENDED STATE (relayer-funded buy-in for cross-chain / Phantom players). Append-only after robberSalt;
    //      fundedPaid base = slot 22, fundedBy base = slot 23 (each mapping base counts as one reserved slot; entries live
    //      at keccak-derived slots). __gap shrinks uint256[31] -> uint256[29] so the layout end-slot (52) is UNCHANGED.
    //      Append-only, no reorder, no overlap. UUPS-upgrade-safe. ----
    /// @notice RVLT a relayer fronted for `player` in a round via buyInForRangeFunded (round -> player -> amount). This is
    ///         a SUBSET of roundPaid[id][player] (a funded buy increments BOTH by the same cost), so on a void the funded
    ///         portion is returned to the funder and only the self-paid remainder to the player. 0 = no funded buys. (slot 22)
    mapping(uint256 => mapping(address => uint256)) public fundedPaid;
    /// @notice The relayer that fronted a player's funded seat (round -> player -> funder). Set on the first funded buy for
    ///         a (round, player); a second funded buy from a different relayer reverts "funder mismatch" so refund routing
    ///         is always unambiguous. 0 = no funded buy for this seat. (slot 23)
    mapping(uint256 => mapping(address => address)) public fundedBy;

    uint16 public constant VERSION = 10;
    /// @dev EIP-712 typed-data for a single bounded auto-buy. Signed by `player`, submitted by `relayer`.
    ///      maxTickets caps the per-round tickets the relayer may buy; maxEntry caps the price the player will
    ///      pay per ticket (so a mid-round signer can't raise entry under them); deadline is a Unix expiry;
    ///      nonce must equal the player's current autoBuyNonce (consumed on use -> replay-proof).
    bytes32 public constant AUTOBUY_TYPEHASH = keccak256(
        "AutoBuy(uint256 roundId,address player,uint256 maxTickets,uint256 maxEntry,uint256 nonce,uint256 deadline)"
    );
    /// @dev V6 EIP-712 typed-data for a RANGE auto-buy: ONE player signature authorizing the relayer to enter the player
    ///      into every round in [roundStart, roundStart+roundCount) at up to maxTickets each, price <= maxEntry, until
    ///      deadline. This is what cuts a multi-game deposit to a single signature. Per-round replay is blocked by
    ///      rangeSpent (not the nonce, which is shared across the range); the player revokes an outstanding range by
    ///      invalidateAutoBuy() (bumps their nonce) and/or approve(escrow,0).
    bytes32 public constant AUTOBUY_RANGE_TYPEHASH = keccak256(
        "AutoBuyRange(uint256 roundStart,uint256 roundCount,address player,uint256 maxTickets,uint256 maxEntry,uint256 nonce,uint256 deadline)"
    );
    /// @dev EIP-712 domain. Computed on the fly from block.chainid + address(this) so it needs NO extra inherited
    ///      storage (adding EIP712Upgradeable would insert its own storage and break the UUPS layout). The domain
    ///      is chain- and contract-bound, so a signature cannot be replayed on another chain or escrow instance.
    bytes32 private constant _DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant _DOMAIN_NAME = keccak256("StandoffEscrow");
    bytes32 private constant _DOMAIN_VERSION = keccak256("2");

    /// @dev EIP-712 digest for an AutoBuy struct hash, bound to this chain + this contract.
    function _autoBuyDigest(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(abi.encode(
            _DOMAIN_TYPEHASH, _DOMAIN_NAME, _DOMAIN_VERSION, block.chainid, address(this)
        ));
        return MessageHashUtils.toTypedDataHash(domainSeparator, structHash);
    }

    /// @notice Current EIP-712 domain separator (exposed so the relayer/client can build matching signatures).
    function domainSeparatorV4() external view returns (bytes32) {
        return keccak256(abi.encode(
            _DOMAIN_TYPEHASH, _DOMAIN_NAME, _DOMAIN_VERSION, block.chainid, address(this)
        ));
    }

    event RoundOpened(uint256 indexed id, uint256 entry, uint64 lockTime, uint64 deadline);
    event BoughtIn(uint256 indexed id, address indexed player, uint256 tickets, uint256 paid);
    event Committed(uint256 indexed id, bytes32 seedHash);
    event SettledRound(uint256 indexed id, bytes32 seed, uint256 pot, uint256 rake, uint256 winnerCount);
    event Claimed(uint256 indexed id, address indexed player, uint256 amount);
    event RakePaid(uint256 indexed id, uint256 toBurn, uint256 toTreasury);
    event VoidedRound(uint256 indexed id);
    event Refunded(uint256 indexed id, address indexed player, uint256 amount);
    event ConfigChanged();
    // ---- V2 events (ADD ONLY; never changed the signatures above) ----
    event RoundLocked(uint256 indexed id, uint64 lockTime);
    event AutoBought(uint256 indexed id, address indexed player, address indexed relayer, uint256 tickets, uint256 paid, uint256 nonce);
    // ---- V5 events (ADD ONLY) ----
    event RolledOver(uint256 indexed id, bytes32 seed, uint256 amount, uint256 jackpot);
    event JackpotWon(uint256 indexed id, uint256 amount);
    // ---- V9 events (ADD ONLY) ----
    /// @dev The robber share of the rake was routed to the drawn Vault Robber's TBA. `tokenId` is the seed-derived
    ///      winning id; `tba` is its ERC-6551 token-bound account (deterministic); `amount` is rake*robberShareBps/BPS.
    event RobberPaid(uint256 indexed roundId, uint256 indexed tokenId, address tba, uint256 amount);
    // ---- V10 events (ADD ONLY) ----
    /// @dev A relayer-FUNDED range auto-buy seated `player`; the RVLT was pulled from `relayer` (the funder), not the player.
    event AutoBoughtFunded(uint256 indexed id, address indexed player, address indexed relayer, uint256 tickets, uint256 paid, uint256 nonce);
    /// @dev A voided round's FUNDED portion was returned to the funder (`toFunder`), the self-paid remainder to the player (`toPlayer`).
    event FundedRefund(uint256 indexed id, address indexed player, address indexed funder, uint256 toFunder, uint256 toPlayer);

    modifier onlySigner() { require(msg.sender == settlementSigner, "not signer"); _; }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); } // implementation can never be initialized directly

    function initialize(
        address token_, address initialOwner, address signer_, address treasury_, address burnSink_,
        uint16 rakeBps_, uint16 burnShareBps_, uint32 challenge_
    ) external initializer {
        require(token_ != address(0) && initialOwner != address(0) && signer_ != address(0)
            && treasury_ != address(0) && burnSink_ != address(0), "zero addr");
        require(rakeBps_ <= MAX_RAKE_BPS && burnShareBps_ <= BPS, "bad bps");
        require(challenge_ >= MIN_CHALLENGE, "challenge too short");
        __Ownable_init(initialOwner);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();
        token = IERC20(token_);
        settlementSigner = signer_; treasury = treasury_; burnSink = burnSink_;
        rakeBps = rakeBps_; burnShareBps = burnShareBps_; challenge = challenge_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {} // only the owner (Safe) may upgrade the logic

    // ---------- owner (Safe) config ----------
    function setSigner(address s) external onlyOwner { require(s != address(0), "zero"); settlementSigner = s; emit ConfigChanged(); }
    function setPayees(address t, address b) external onlyOwner { require(t != address(0) && b != address(0), "zero"); treasury = t; burnSink = b; emit ConfigChanged(); }
    function setRake(uint16 r, uint16 bShare) external onlyOwner { require(r <= MAX_RAKE_BPS && bShare <= BPS, "bad bps"); rakeBps = r; burnShareBps = bShare; emit ConfigChanged(); }
    function setChallenge(uint32 c) external onlyOwner { require(c >= MIN_CHALLENGE, "challenge too short"); challenge = c; emit ConfigChanged(); }

    // ---------- V2 owner (Safe) config ----------
    /// @notice Per-wallet ticket cap (0 = unlimited). Enforced in buyIn/buyInFor against the player's running total.
    function setMaxTicketsPerWallet(uint128 cap) external onlyOwner { maxTicketsPerWallet = cap; emit ConfigChanged(); }
    /// @notice Dedicated auto-buy relayer key (0 disables auto-buy). MUST NOT be the settlement signer or an owner key.
    function setRelayer(address r) external onlyOwner { relayer = r; emit ConfigChanged(); }
    /// @notice V8: allow (or revoke) an additional relayer hot key in the key-pool. Any allowlisted key may submit
    ///         player-signed auto-buys (buyInFor/buyInForRange) in parallel with the legacy `relayer`. Owner-only.
    function setRelayerAllowed(address r, bool ok) external onlyOwner { isRelayer[r] = ok; emit ConfigChanged(); }
    /// @notice Guardian may void un-settled rounds inside the post-deadline grace window (0 = none). And the grace
    ///         length (seconds) after `deadline` during which the public void path stays closed.
    function setGuardian(address g) external onlyOwner { guardian = g; emit ConfigChanged(); }
    function setVoidGrace(uint32 g) external onlyOwner { voidGrace = g; emit ConfigChanged(); }

    // ---------- V4 owner (Safe) config: holder half-price ----------
    /// @notice Set (or clear) the Vault Robber ERC721 whose holders get the entry discount. 0 disables the discount
    ///         entirely (isHolder() always false; everyone pays full). Owner-only.
    function setHolderNft(address nft) external onlyOwner { holderNft = nft; emit ConfigChanged(); }
    /// @notice Set the holder per-ticket discount in basis points of the entry (5000 = 50% off = half price).
    ///         Must be STRICTLY < BPS (max BPS-1 = 9999); the ceiling is a near-free but NONZERO ticket. A full
    ///         BPS (10000) is rejected because it would make holder tickets FREE (price 0), letting a single-NFT
    ///         holder flood a round with zero-cost seats. 0 = no discount (holders pay full). Owner-only.
    function setHolderDiscountBps(uint16 bps) external onlyOwner { require(bps < BPS, "bad bps"); holderDiscountBps = bps; emit ConfigChanged(); }

    // ---------- V9 owner (Safe) config: random Vault Robber airdrop ----------
    /// @notice Set the random-robber airdrop config IN ONE CALL, intended AFTER mint closes when the final minted
    ///         supply is known. All five together: the Vault Robbers ERC721 (`nft`), the canonical 6551 `registry`,
    ///         the `accountImpl` the TBA derivation uses, the `salt` (0 by default), the final minted `supply` (the
    ///         draw is `mod supply` so tokenIds land in [1, supply]), and the `shareBps` OF THE RAKE routed to the
    ///         drawn robber's TBA (5000 = half the rake; <= BPS). Setting any of {nft, supply, shareBps} to zero turns
    ///         the robber leg OFF (payRake routes the whole rake to burn/treasury as in V8). Owner (the 2-of-2 Safe) only.
    function setRobberConfig(address nft, address registry, address accountImpl, bytes32 salt, uint32 supply, uint16 shareBps) external onlyOwner {
        require(shareBps <= BPS, "bad bps");
        robberNft = nft;
        robberRegistry = registry;
        robberAccountImpl = accountImpl;
        robberSalt = salt;
        robberSupply = supply;
        robberShareBps = shareBps;
        emit ConfigChanged();
    }

    // ---------- V9 robber-draw views (pure deterministic; exposed for off-chain verification) ----------
    /// @notice True when the random-robber airdrop is configured and active. When false, payRake behaves exactly as V8
    ///         (whole rake to burn/treasury). Mirrors the inert-until-configured gate in payRake.
    function robberActive() public view returns (bool) {
        return robberNft != address(0) && robberSupply != 0 && robberShareBps != 0;
    }

    /// @notice The winning Vault Robber tokenId drawn from a round's revealed `seed`, deterministic + verifiable +
    ///         ungrindable (the seed is committed before reveal). Domain-separated with the "robber" label so it is
    ///         independent of any game-winner draw off the same seed. In [1, robberSupply]. Reverts if supply is 0.
    function robberTokenId(uint256 id, bytes32 seed) public view returns (uint256) {
        require(robberSupply != 0, "no supply");
        return (uint256(keccak256(abi.encodePacked(seed, id, "robber"))) % robberSupply) + 1;
    }

    /// @notice The ERC-6551 token-bound account that receives the robber share for a given tokenId. Pure deterministic
    ///         CREATE2 math from the canonical registry — same whether or not the account/token has ever been deployed.
    function robberTba(uint256 tokenId) public view returns (address) {
        return IERC6551Registry(robberRegistry).account(robberAccountImpl, robberSalt, block.chainid, robberNft, tokenId);
    }

    // ---------- V4 holder-discount views ----------
    /// @notice True if `a` holds at least one Vault Robber NFT. False when no holderNft is configured (discount off).
    ///         Wrapped in try/catch so a misconfigured/non-ERC721 holderNft can never brick buy-in (falls back to
    ///         "not a holder" = full price, never reverts the buy).
    function isHolder(address a) public view returns (bool) {
        address nft = holderNft;
        if (nft == address(0)) return false;
        try IERC721(nft).balanceOf(a) returns (uint256 bal) { return bal > 0; } catch { return false; }
    }

    /// @notice The per-ticket price `a` pays: discounted (entry - entry*discountBps/BPS) if a holder, else full entry.
    function entryPriceFor(uint256 id, address a) public view returns (uint256) {
        return _ticketPrice(uint256(rounds[id].entry), a);
    }

    /// @dev Per-ticket price for `a` given a base `entry`: half (or discountBps off) for holders, full otherwise.
    function _ticketPrice(uint256 entry, address a) internal view returns (uint256) {
        if (holderDiscountBps != 0 && isHolder(a)) {
            return entry - (entry * holderDiscountBps / BPS);
        }
        return entry;
    }

    // ---------- round lifecycle (settlement signer) ----------
    function openRound(uint256 id, uint128 entry, uint64 lockTime, uint64 deadline) external onlySigner {
        require(rounds[id].status == Status.None, "exists");
        require(entry > 0 && lockTime > block.timestamp && deadline > lockTime, "bad params");
        Round storage r = rounds[id];
        r.entry = entry; r.lockTime = lockTime; r.deadline = deadline; r.status = Status.Open;
        r.rakeBpsSnap = rakeBps; // BASE-2: freeze the rake for this round at open; settle uses the snapshot
        r.burnShareSnap = burnShareBps; // C-1: freeze the burn/treasury split at open; payRake uses the snapshot
        emit RoundOpened(id, entry, lockTime, deadline);
    }

    /// @notice THRESHOLD-START (fill-driven lock). Close buy-in NOW for a still-Open round by moving its lockTime
    /// to the current block, which flips buyIn (requires < lockTime) closed and commit (requires >= lockTime)
    /// open. Signer-only: same trust boundary as openRound/commit, moves no funds. Can ONLY move the lock EARLIER
    /// (require new lockTime <= current lockTime) so it can never re-open or extend buy-in. Rounds are opened with
    /// a far-future sentinel lockTime, so this is how buy-in actually closes in the threshold-fill model.
    function lockRound(uint256 id) external onlySigner {
        Round storage r = rounds[id];
        require(r.status == Status.Open, "not open");
        uint64 nowT = uint64(block.timestamp);
        require(nowT <= r.lockTime, "only earlier"); // never extend/re-open buy-in
        r.lockTime = nowT;
        emit RoundLocked(id, nowT);
    }

    function buyIn(uint256 id, uint256 nTickets) external nonReentrant {
        _buyIn(id, msg.sender, msg.sender, nTickets);
    }

    /// @dev V8: an address is an authorized relayer if it is the legacy single `relayer` OR an owner-allowlisted
    ///      key-pool member. address(0) is never a relayer (preserves the V1..V7 "relayer unset = auto-buy off"
    ///      guarantee: with relayer==0 and an empty allowlist this returns false for every caller).
    function _isRelayer(address a) internal view returns (bool) {
        return a != address(0) && (a == relayer || isRelayer[a]);
    }

    /// @notice BOUNDED AUTO-BUY. Relayer submits a player's EIP-712 AutoBuy authorization; funds are pulled from
    /// the PLAYER (who has approve()'d this escrow), never from the relayer. The relayer can only enter the player
    /// into the authorized round, up to the signed maxTickets, at a price <= the signed maxEntry, before the signed
    /// deadline, once per nonce. It can NEVER redirect funds to itself (buyIn pulls player->escrow; the pot exits
    /// only by settle-to-participants or refund). Player revokes any time via approve(escrow, 0) or by not signing.
    /// nonce must equal the player's current autoBuyNonce and is incremented on use (replay protection).
    function buyInFor(
        uint256 id, address player, uint256 nTickets,
        uint256 maxTickets, uint256 maxEntry, uint256 deadline, uint256 nonce, bytes calldata sig
    ) external nonReentrant {
        require(_isRelayer(msg.sender), "not relayer");
        require(player != address(0), "zero player");
        require(block.timestamp <= deadline, "auth expired");
        require(nTickets <= maxTickets, "over authorized tickets");
        require(nonce == autoBuyNonce[player], "bad nonce");
        // V4: maxEntry is a CEILING on the per-ticket price actually charged. The discounted holder price can only
        // be <= the full entry, so this also covers the pre-V4 semantics (full entry <= maxEntry). Bounding against
        // the CHARGED price (not the raw entry) keeps the authorization honest: the player never pays more per
        // ticket than they signed for, whether or not the discount applies.
        uint256 price = _ticketPrice(uint256(rounds[id].entry), player);
        require(price <= maxEntry, "entry over max");

        bytes32 structHash = keccak256(abi.encode(
            AUTOBUY_TYPEHASH, id, player, maxTickets, maxEntry, nonce, deadline
        ));
        bytes32 digest = _autoBuyDigest(structHash);
        require(ECDSA.recover(digest, sig) == player, "bad auth sig");

        autoBuyNonce[player] = nonce + 1; // consume BEFORE the external token pull (CEI + replay-proof)
        _buyIn(id, player, player, nTickets);
        emit AutoBought(id, player, msg.sender, nTickets, price * nTickets, nonce);
    }

    /// @notice V6 RANGE AUTO-BUY. The relayer enters `player` into round `id` against a SINGLE range authorization the
    /// player signed (covering [roundStart, roundStart+roundCount)). This is how a multi-game deposit becomes one approve
    /// + one signature: the player signs once, the relayer calls this per round as each opens. Same custody guarantees as
    /// buyInFor (funds pulled from the player, never redirected; bounded by maxTickets/maxEntry/deadline/allowance), with
    /// per-round replay blocked by rangeSpent (the nonce is shared across the whole range, so it is NOT incremented here;
    /// the player invalidates an outstanding range via invalidateAutoBuy() or approve(escrow,0)).
    function buyInForRange(
        uint256 id, address player, uint256 nTickets,
        uint256 roundStart, uint256 roundCount, uint256 maxTickets, uint256 maxEntry, uint256 nonce, uint256 deadline, bytes calldata sig
    ) external nonReentrant {
        require(_isRelayer(msg.sender), "not relayer");
        require(player != address(0), "zero player");
        require(block.timestamp <= deadline, "auth expired");
        require(roundCount > 0 && id >= roundStart && id < roundStart + roundCount, "round out of range");
        require(nTickets <= maxTickets, "over authorized tickets");
        require(nonce == autoBuyNonce[player], "bad nonce");
        require(!rangeSpent[player][id], "round already bought");
        uint256 price = _ticketPrice(uint256(rounds[id].entry), player);
        require(price <= maxEntry, "entry over max");

        bytes32 structHash = keccak256(abi.encode(
            AUTOBUY_RANGE_TYPEHASH, roundStart, roundCount, player, maxTickets, maxEntry, nonce, deadline
        ));
        bytes32 digest = _autoBuyDigest(structHash);
        require(ECDSA.recover(digest, sig) == player, "bad auth sig");

        rangeSpent[player][id] = true;   // consume THIS round only (the shared nonce stays valid for the rest of the range)
        _buyIn(id, player, player, nTickets);
        emit AutoBought(id, player, msg.sender, nTickets, price * nTickets, nonce);
    }

    /// @notice V10 RELAYER-FUNDED RANGE AUTO-BUY. Identical to buyInForRange in EVERY way (same EIP-712 range authorization,
    /// same domain/typehash, same deadline/nonce/rangeSpent replay guard, same maxTickets/maxEntry/per-wallet-cap bounds,
    /// same seating: `player` gets the tickets/pot credit and is the potential winner) EXCEPT the RVLT is pulled from the
    /// RELAYER (msg.sender), who pre-approves the escrow once, instead of from the player. This is the path for a Solana/
    /// Phantom player who CANNOT approve RVLT or pay gas on Robinhood Chain 4663: the server swaps the player's funds into
    /// RVLT held by the relayer (off-chain, via Relay), and the relayer forwards it here while seating the player. The
    /// player signs ONLY the standard AutoBuyRange authorization (no 4663 tx, no approval) and can never be charged on 4663.
    ///
    /// SAFETY: the relayer can only seat a player the player SIGNED FOR, for AT MOST maxTickets at AT MOST maxEntry/ticket,
    /// within the signed deadline, once per round (rangeSpent). It can NEVER overspend beyond maxEntry*maxTickets, seat an
    /// unauthorized player (sig is bound to `player`), or redirect funds to itself (the pot exits only via settle-to-player
    /// or refund). The funded RVLT is recorded in fundedPaid/fundedBy so a voided round returns it to the FUNDER, not the
    /// player (see refund/refundFor). The player revokes an outstanding range via invalidateAutoBuy() exactly as before.
    function buyInForRangeFunded(
        uint256 id, address player, uint256 nTickets,
        uint256 roundStart, uint256 roundCount, uint256 maxTickets, uint256 maxEntry, uint256 nonce, uint256 deadline, bytes calldata sig
    ) external nonReentrant {
        require(_isRelayer(msg.sender), "not relayer");
        require(player != address(0), "zero player");
        require(block.timestamp <= deadline, "auth expired");
        require(roundCount > 0 && id >= roundStart && id < roundStart + roundCount, "round out of range");
        require(nTickets <= maxTickets, "over authorized tickets");
        require(nonce == autoBuyNonce[player], "bad nonce");
        require(!rangeSpent[player][id], "round already bought");
        uint256 price = _ticketPrice(uint256(rounds[id].entry), player);
        require(price <= maxEntry, "entry over max");

        // SAME authorization the player signs for buyInForRange: one range sig = one buy per round, routable to either the
        // player-funded (buyInForRange) OR the relayer-funded (this) path. The player is only ever BENEFITED here.
        bytes32 structHash = keccak256(abi.encode(
            AUTOBUY_RANGE_TYPEHASH, roundStart, roundCount, player, maxTickets, maxEntry, nonce, deadline
        ));
        bytes32 digest = _autoBuyDigest(structHash);
        require(ECDSA.recover(digest, sig) == player, "bad auth sig");

        // EFFECTS before the external token pull (CEI; nonReentrant also guards). rangeSpent consumes THIS round only (the
        // shared nonce stays valid for the rest of the range, mirroring buyInForRange). cost is recomputed EXACTLY as _buyIn
        // will charge it (deterministic _ticketPrice * nTickets, same block, same holder status), so fundedPaid matches the
        // RVLT actually pulled to the wei.
        rangeSpent[player][id] = true;
        uint256 cost = price * nTickets;
        address existing = fundedBy[id][player];
        require(existing == address(0) || existing == msg.sender, "funder mismatch"); // one funder per seat => unambiguous refund
        fundedBy[id][player] = msg.sender;
        fundedPaid[id][player] += cost;
        // payer = msg.sender (the RELAYER/funder), beneficiary = player. _buyIn is reused UNCHANGED: it already supports
        // payer != beneficiary, credits tickets/roundPaid/pot to the player, and does token.safeTransferFrom(relayer, escrow, cost).
        _buyIn(id, msg.sender, player, nTickets);
        emit AutoBoughtFunded(id, player, msg.sender, nTickets, cost, nonce);
    }

    /// @notice Player-initiated revoke of ALL outstanding auto-buy authorizations (single and range): bumping the caller's
    /// nonce invalidates every signature bound to the old nonce. One tx, no approval needed (pair with approve(escrow,0)
    /// to also zero the allowance). This is the on-chain safety lever; normal UX treats a deposit as final.
    function invalidateAutoBuy() external { autoBuyNonce[msg.sender] += 1; }

    /// @dev Shared buy-in core. `payer` is who the tokens are pulled from; `beneficiary` is credited with tickets
    ///      and whose holder status sets the per-ticket price. In both buyIn and buyInFor payer == beneficiary.
    function _buyIn(uint256 id, address payer, address beneficiary, uint256 nTickets) internal {
        Round storage r = rounds[id];
        require(r.status == Status.Open, "not open");
        require(block.timestamp < r.lockTime, "locked");
        require(nTickets > 0 && nTickets <= MAX_TICKETS, "bad tickets");
        // V4: holders of the Vault Robber NFT pay the discounted (half) per-ticket price; the pot receives the
        // discounted amount (intended: smaller pot for holder seats, no treasury top-up). Non-holders pay full.
        uint256 price = _ticketPrice(uint256(r.entry), beneficiary);
        uint256 cost = price * nTickets;
        uint256 newPot = uint256(r.pot) + cost;
        require(newPot <= type(uint128).max, "pot overflow"); // checked downcast: never silently truncate escrow liability
        uint256 newTotal = tickets[id][beneficiary] + nTickets;
        uint128 cap = maxTicketsPerWallet;
        if (cap != 0) require(newTotal <= cap, "wallet cap"); // ON-CHAIN PER-WALLET CAP (0 = unlimited)
        tickets[id][beneficiary] = newTotal;
        roundPaid[id][beneficiary] += cost; // V4: track actual paid (discount-aware) for exact refunds on void
        r.pot = uint128(newPot);
        token.safeTransferFrom(payer, address(this), cost);
        emit BoughtIn(id, beneficiary, nTickets, cost);
    }

    function commit(uint256 id, bytes32 seedHash) external onlySigner {
        Round storage r = rounds[id];
        require(r.status == Status.Open, "not open");
        require(block.timestamp >= r.lockTime, "not locked");
        require(seedHash != bytes32(0), "zero seed");
        r.seedHash = seedHash; r.status = Status.Committed;
        emit Committed(id, seedHash);
    }

    /// @notice Reveal the seed and record the split. Each winner must be a participant; sum(amounts) must equal
    /// pot - rake. No tokens move here (they are pulled after the challenge window), so a void during the window
    /// always leaves the full pot available for refunds.
    function settle(uint256 id, bytes32 seed, address[] calldata winners, uint256[] calldata amounts) external onlySigner {
        Round storage r = rounds[id];
        require(r.status == Status.Committed, "not committed");
        require(keccak256(abi.encodePacked(seed)) == r.seedHash, "seed mismatch");
        uint256 n = winners.length;
        require(n > 0 && n == amounts.length, "len");
        uint256 pot = r.pot;
        uint256 rake = pot * r.rakeBpsSnap / BPS; // BASE-2: use the rake snapshotted at open, not live rakeBps
        // V5: the current progressive jackpot is WON by this round and folded into the payout budget. Its tokens are
        // already escrowed (from prior rollovers), so no new funds are needed. Recorded per-round so a void can restore
        // it inside the challenge window. jackpot is almost always 0 (budget == pot - rake, unchanged behaviour).
        uint256 jp = jackpot;
        uint256 budget = pot - rake + jp;
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            address w = winners[i];
            require(tickets[id][w] > 0, "winner not participant");
            require(winShare[id][w] == 0, "dup winner");
            require(amounts[i] > 0, "zero amount");
            winShare[id][w] = amounts[i];
            sum += amounts[i];
        }
        require(sum == budget, "payout != pot-rake+jackpot");
        if (jp > 0) { roundJackpotApplied[id] = jp; jackpot = 0; emit JackpotWon(id, jp); }
        require(rake <= type(uint128).max, "rake overflow"); // checked downcast (pot is uint128-bounded, so always holds; explicit for safety)
        r.rakeOwed = uint128(rake);
        r.claimAt = uint64(block.timestamp + challenge);
        r.seedRevealed = seed; // V9: persist the revealed seed so payRake can draw the robber tokenId from it
        r.status = Status.Settled;
        emit SettledRound(id, seed, pot, rake, n);
    }

    /// @notice FINAL-VAULT STANDOFF ROLLOVER. When the off-chain engine determines the final vault ended with
    /// EVERYBODY busted (the whole surviving crowd converged on one door), there is no winner: this round's entire
    /// pot rolls into the persistent progressive `jackpot` (NO rake, NO refunds — the buy-ins intentionally seed the
    /// next game's prize). Reveals the committed seed so the no-winner outcome is provable from the public proof, and
    /// marks the round RolledOver (terminal: not claimable, not refundable). Signer-only; moves no funds OUT of the
    /// contract (the pot tokens stay escrowed, now accounted to the jackpot). Bounded abuse: a wrongful rollover can
    /// only PARK a pot into the jackpot (paid to a future winner), never send it anywhere, so no funds can be stolen.
    function rolloverRound(uint256 id, bytes32 seed) external onlySigner {
        Round storage r = rounds[id];
        require(r.status == Status.Committed, "not committed");
        require(keccak256(abi.encodePacked(seed)) == r.seedHash, "seed mismatch");
        uint256 amount = r.pot;
        jackpot += amount;              // whole pot seeds the progressive jackpot (no rake, no refund)
        r.status = Status.RolledOver;
        emit RolledOver(id, seed, amount, jackpot);
    }

    function claim(uint256 id) external nonReentrant {
        Round storage r = rounds[id];
        require(r.status == Status.Settled, "not settled");
        require(block.timestamp >= r.claimAt, "challenge window");
        uint256 amt = winShare[id][msg.sender];
        require(amt > 0 && !settled[id][msg.sender], "nothing");
        settled[id][msg.sender] = true;
        token.safeTransfer(msg.sender, amt);
        emit Claimed(id, msg.sender, amt);
    }

    /// @notice AUTO-SEND the settled payout to winners (PUSH), callable by ANYONE after the challenge window. Lets the
    /// server deliver winnings automatically so a winner never has to click "collect" (claim() stays as a self-service
    /// fallback). Idempotent per winner (settled[] guard). The challenge window is unchanged, so the void->refund
    /// safety net is fully preserved: funds still move only AFTER the window, never at settle.
    function payWinners(uint256 id, address[] calldata ws) external nonReentrant {
        Round storage r = rounds[id];
        require(r.status == Status.Settled, "not settled");
        require(block.timestamp >= r.claimAt, "challenge window");
        uint256 len = ws.length;
        for (uint256 i; i < len; ++i) {
            address w = ws[i];
            uint256 amt = winShare[id][w];
            if (amt > 0 && !settled[id][w]) {
                settled[id][w] = true;
                token.safeTransfer(w, amt);
                emit Claimed(id, w, amt);
            }
        }
    }

    /// @notice Pay the rake to burn + treasury, once, after the challenge window. Anyone may trigger it.
    function payRake(uint256 id) external nonReentrant {
        Round storage r = rounds[id];
        require(r.status == Status.Settled, "not settled");
        require(block.timestamp >= r.claimAt, "challenge window");
        require(!r.rakePaid, "rake paid");
        r.rakePaid = true;
        uint256 rake = r.rakeOwed;

        // V9: RANDOM VAULT ROBBER AIRDROP. A configurable share OF THE RAKE (robberShareBps) is routed to a randomly
        // drawn Vault Robber's ERC-6551 TBA; the REMAINDER of the rake is then split burn/treasury exactly as before.
        // This only changes the SPLIT of the rake — the winner budget (pot - rake + jackpot, fixed at settle) is
        // untouched, so this does NOT reduce the winner pot. INERT UNTIL CONFIGURED: if the robber airdrop is off
        // (robberNft==0 || robberSupply==0 || robberShareBps==0) this whole leg is skipped and the full rake flows to
        // burn/treasury exactly as in V8. The tokenId is drawn deterministically from the revealed settle seed
        // (domain-separated with the "robber" label), and the recipient is pure 6551 CREATE2 math (no mint/ownerOf
        // dependency), so an unminted/burned id can never revert here.
        uint256 robberCut;
        if (robberActive()) {
            robberCut = rake * robberShareBps / BPS;
            if (robberCut > 0) {
                uint256 tokenId = robberTokenId(id, r.seedRevealed);
                address tba = robberTba(tokenId);
                token.safeTransfer(tba, robberCut);
                emit RobberPaid(id, tokenId, tba, robberCut);
            }
        }

        // C-1: use the burn share SNAPSHOTTED at openRound, not the live burnShareBps, so an owner setRake
        // between open and payout can't redirect this already-committed round's rake split. NO "fall back to
        // live if snap==0" branch: unlike rake, burnShareBps=0 is a VALID production value (0 = 100% to
        // treasury, the current live setting), so 0 is not a sentinel. Any round opened pre-field (mainnet has
        // none) reads 0 = 100% treasury, which matches current prod anyway.
        // V9: the burn/treasury split applies to the rake REMAINING after the robber share (rake - robberCut), so the
        // robber share comes off the top and the remainder keeps flowing burn/treasury as today. When the robber leg
        // is inert robberCut == 0 and this is byte-for-byte the V8 split of the full rake.
        uint256 remaining = rake - robberCut;
        uint256 burnCut = remaining * r.burnShareSnap / BPS;
        uint256 treasCut = remaining - burnCut;
        if (burnCut > 0) token.safeTransfer(burnSink, burnCut);
        if (treasCut > 0) token.safeTransfer(treasury, treasCut);
        emit RakePaid(id, burnCut, treasCut);
    }

    // ---------- liveness / safety ----------
    /// @notice Owner may void a SETTLED round during its challenge window (bad result). For an un-settled round
    /// past its deadline (server outage), BASE-1: only owner OR guardian may void during the post-deadline grace
    /// window (deadline .. deadline+voidGrace); after the grace, anyone may void (public liveness backstop).
    /// With voidGrace == 0 this reduces to the V1 behaviour (public void immediately at deadline).
    function voidRound(uint256 id) external {
        Round storage r = rounds[id];
        if (r.status == Status.Settled) {
            require(msg.sender == owner(), "only owner");
            require(block.timestamp < r.claimAt, "window passed");
            // V5: if this settle had folded in the progressive jackpot, RESTORE it so voiding a bad jackpot-winning
            // settle doesn't lose the accumulated jackpot (it returns to the pool for the next winner).
            uint256 jp = roundJackpotApplied[id];
            if (jp > 0) { roundJackpotApplied[id] = 0; jackpot += jp; }
        } else {
            require(r.status == Status.Open || r.status == Status.Committed, "cannot void");
            require(block.timestamp >= r.deadline, "not past deadline");
            // BASE-1: within the grace window only owner/guardian may void; the public path opens after it.
            bool priv = msg.sender == owner() || (guardian != address(0) && msg.sender == guardian);
            if (!priv) {
                require(block.timestamp >= uint256(r.deadline) + voidGrace, "void grace");
            }
        }
        r.status = Status.Voided;
        emit VoidedRound(id);
    }

    /// @notice V7: Owner may UNWIND a RolledOver round back to Voided so its participants can refund(). A rollover parks
    /// the whole pot into the progressive jackpot with no winner; this reverses that accrual (jackpot -= the round's
    /// pot) and marks the round Voided, after which each participant pulls back EXACTLY what they paid via refund().
    /// This is the escape hatch for a WRONGFUL rollover (e.g. a buggy or compromised signer rolled a round that should
    /// have had a winner) and for winding the game down fairly (refund players instead of stranding funds in the
    /// jackpot). Owner (the 2-of-2 Safe) ONLY. Bounded and safe: it can only return a parked pot to that round's own
    /// refundable participants, never move funds elsewhere; and it reverts if the jackpot has since been drawn down
    /// below this round's pot (those tokens already went to a later winner and cannot be clawed back).
    function voidRolledOver(uint256 id) external {
        require(msg.sender == owner(), "only owner");
        Round storage r = rounds[id];
        require(r.status == Status.RolledOver, "not rolled over");
        uint256 amount = r.pot;                      // whole pot was added to the jackpot at rollover (no rake taken)
        require(jackpot >= amount, "jackpot drawn");  // a later winner already swept it; cannot reverse
        jackpot -= amount;
        r.status = Status.Voided;                    // enables refund() of roundPaid (exactly what each participant paid)
        emit VoidedRound(id);
    }

    function refund(uint256 id) external nonReentrant {
        _refund(id, msg.sender);
    }

    /// @notice V10: trigger a VOIDED round's refund FOR a player who cannot call refund() themselves (e.g. a Solana/
    /// Phantom player with no 4663 gas). Callable by anyone: the destinations are immutable stored data (self portion ->
    /// player, funded portion -> the recorded funder), the settled[] guard makes it idempotent, and it can only pay this
    /// round's own participants — so there is no abuse or griefing vector, only a liveness convenience for the server.
    function refundFor(uint256 id, address player) external nonReentrant {
        _refund(id, player);
    }

    /// @dev Shared refund core. Returns EXACTLY what was paid for `player`'s seat (discount-aware, via roundPaid), split by
    ///      funder: any relayer-FUNDED portion (fundedPaid) goes back to the FUNDER that fronted it, the self-paid remainder
    ///      goes to the player. For every pre-V10 / self-funded seat fundedPaid==0, so selfAmt==roundPaid and the player
    ///      receives the full amount via the SAME Refunded event as before — byte-for-byte identical behaviour.
    function _refund(uint256 id, address player) internal {
        Round storage r = rounds[id];
        require(r.status == Status.Voided, "not voided");
        require(tickets[id][player] > 0 && !settled[id][player], "nothing");
        settled[id][player] = true; // EFFECTS before interactions (CEI); nonReentrant also guards
        // V4: refund EXACTLY what was paid (discount-aware), not entry*tickets. With holder half-price a player's
        // contribution is no longer uniform, so paying entry*tickets would over-refund a discounted holder and
        // drain the pot. roundPaid is the sum of this player's actual (discounted/full) buy-ins for the round.
        uint256 total = roundPaid[id][player];
        // V10: the relayer-FUNDED portion (fundedPaid, a subset of roundPaid) is returned to the FUNDER that fronted it,
        // NOT to the player — the player paid on their own chain via the off-chain swap, not on 4663, so refunding them here
        // would double-pay them and strand the relayer's RVLT. funded <= total always (a funded buy increments both by the
        // same cost), so selfAmt never underflows.
        uint256 funded = fundedPaid[id][player];
        uint256 selfAmt = total - funded;
        if (selfAmt > 0) { token.safeTransfer(player, selfAmt); emit Refunded(id, player, selfAmt); }
        if (funded > 0) {
            address funder = fundedBy[id][player]; // always set when fundedPaid > 0 (set together in buyInForRangeFunded)
            token.safeTransfer(funder, funded);
            emit FundedRefund(id, player, funder, funded, selfAmt);
        }
    }

    /// @dev storage gap for future upgrades (reserve slots so appended vars never collide).
    /// V1 reserved uint256[45]. V2 appended 4 new 32-byte storage slots of plain state
    /// (maxTicketsPerWallet | relayer | {guardian,voidGrace} | autoBuyNonce mapping) so the gap shrank by 4 to 41.
    /// NOTE: the autoBuyNonce *mapping* occupies one slot number for its base (its entries live at keccak-derived
    /// slots), so it counts as one reserved slot here. 45 - 4 = 41.
    /// V4 appended TWO new 32-byte storage slots: {holderNft, holderDiscountBps} packed (slot 12) and the
    /// roundPaid mapping (slot 13, its entries live at keccak-derived slots so the base counts as one slot),
    /// so the gap shrinks by 2. 41 - 2 = 39. The gap's end slot (52) is unchanged, so every pre-existing
    /// variable keeps its exact slot/offset — only the gap shrank to make room. UUPS-upgrade-safe.
    /// V5 appended TWO new 32-byte slots: jackpot (slot 14) and the roundJackpotApplied mapping (slot 15, base counts
    /// as one slot), so the gap shrinks by 2 again. 39 - 2 = 37. End slot (52) unchanged. UUPS-upgrade-safe.
    /// V6 appended ONE new slot: the rangeSpent mapping (slot 16, base counts as one slot), so the gap shrinks by 1.
    /// 37 - 1 = 36. End slot (52) unchanged. UUPS-upgrade-safe.
    /// V7 added ONLY a function (voidRolledOver) and bumped VERSION; NO new storage, so the gap is UNCHANGED at 36 and
    /// the layout is byte-for-byte identical to V6. UUPS-upgrade-safe.
    /// V8 appended ONE new slot: the isRelayer mapping (slot 17, base counts as one slot), so the gap shrinks by 1.
    /// 36 - 1 = 35. End slot (52) unchanged. UUPS-upgrade-safe.
    /// V9 appended FOUR new slots: {robberNft, robberSupply, robberShareBps} packed (slot 18, 20+4+2 = 26 bytes fit one
    /// slot), robberRegistry (slot 19), robberAccountImpl (slot 20), robberSalt (slot 21). So the gap shrinks by 4.
    /// 35 - 4 = 31. __gap[31] spans slots 22..52 — the SAME end slot (52) as every prior version. (The V9 Round.seedRevealed
    /// append does NOT touch this gap: the Round struct lives in a mapping, so a trailing member only uses previously-unused
    /// per-key slots.) Append-only, no reorder, no overlap. UUPS-upgrade-safe.
    /// V10 appended TWO new slots: the fundedPaid mapping (slot 22) and the fundedBy mapping (slot 23); each mapping base
    /// counts as one reserved slot (entries live at keccak-derived slots). So the gap shrinks by 2. 31 - 2 = 29. __gap[29]
    /// spans slots 24..52 — the SAME end slot (52) as every prior version. Append-only, no reorder, no overlap. UUPS-upgrade-safe.
    uint256[29] private __gap;
}
