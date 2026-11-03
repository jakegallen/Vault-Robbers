# RVLT Ecosystem — Ownership / Admin Migration to the New 2-of-2 Safe

Status: RESEARCH + PLAN ONLY. Producing this doc sent NO transaction, signed NOTHING,
generated/used NO private key, and set NO secret. The only network calls were READ-ONLY
`cast call` / `cast storage` / `cast code` / `cast chain-id` / `cast balance` against the
Robinhood mainnet (4663) + testnet (46630) RPCs and one Ethereum (chain 1) public RPC, plus
OFFLINE `cast calldata` encoding. Jake executes every write below from his Safe / EOAs.

- NEW destination Safe (2-of-2, Robinhood mainnet 4663): `0x3290f9cbF7bE7dEA11E7d482Ae0418b83E363665`
- OLD shared Safe being retired (Robinhood mainnet 4663): `0x2aA3936C0312f3604982B2504BeE7ad8c88e9397`
- Deployer / NFT+beacon owner EOA: `0x8444149B8E5eD771607452FB133d8803A3F02D0e`
- Testnet escrow owner EOA: `0x411f48757B2114392556a221aAA154b94bA449d1`
- Mainnet read RPC: `https://rpc.mainnet.chain.robinhood.com` (chainid confirmed `4663`)
- Reusable calldata (same for every single-step Ownable below — selector + the new Safe left-padded):
  `transferOwnership(0x3290…3665)` = `0xf2fde38b0000000000000000000000003290f9cbf7be7dea11e7d482ae0418b83e363665`

---

## 1. Ownership map — the contracts we control (READ ON-CHAIN today)

| # | Contract | Addr | Chain | Purpose | Current owner/admin (read on-chain) | Model | Transfer action → new Safe | Who signs |
|---|---|---|---|---|---|---|---|---|
| 1 | StandoffEscrow (UUPS proxy) | `0x6486531cC2b5ed5Cd5Af2C293Deb9EbA01a3EEA5` | 4663 | Vault Standoff on-chain money escrow; owner = config + UUPS upgrade authority | `owner()` = OLD Safe `0x2aA3…9397` | `OwnableUpgradeable` (single-step) + UUPS (`_authorizeUpgrade onlyOwner`) | `transferOwnership(0x3290…3665)` — calldata above. Owner controls upgrades, so this one call moves upgrade AND config authority. No accept step. | OLD Safe (2-of-2) |
| 2 | Vault Robbers NFT (LIVE) | `0xABC6c4F5d1F31326b419c2645C981743a845313a` | 4663 | 777/1000 ERC721 game mint, ERC721C, ERC2981; owner sets price/signer/sink/royalty/validator/reveal, rescue | `owner()` = EOA `0x8444…2D0e`; `pendingOwner()` reverts (confirms single-step) | `Ownable` (OZ v5, single-step) | `transferOwnership(0x3290…3665)` | **EOA `0x8444` signs directly** (NOT the old Safe) |
| 3 | Vault Robbers NFT (STALE/superseded) | `0x0741A47CE1A25419335dD4a39059Ec63Ba336f69` | 4663 | Earlier VaultRobbers deploy (3 mints, still `mintActive=true`); superseded by #2 (136 mints, the one both deployment.mainnet.json + the RETIRE doc call live) | `owner()` = EOA `0x8444…2D0e` (DEPLOYED_MAINNET.txt recorded it as the old Safe at deploy; ownership has since moved back to the EOA — note the drift) | `Ownable` (single-step) | Decide: either `transferOwnership(0x3290…3665)` to bring it under the new Safe, OR `setMintActive(false)` then `renounceOwnership()` to seal it. Recommend seal — see Open Item A. | **EOA `0x8444` signs directly** |
| 4 | EntropyBeacon | `0xaE28aD458af04207677466dd52dBa2415b9F40ee` | 4663 | Optional provably-fair randomness anchor; holds NO funds (`balance` = 0); owner can only `poke`/config the Pyth provider | `owner()` = EOA `0x8444…2D0e` | `Ownable` (single-step) | `transferOwnership(0x3290…3665)` (low priority — no funds, non-authoritative to the game) | **EOA `0x8444` signs directly** |
| 5 | ROBINVAULT (RVLT) ERC20 | `0x77061B45C5E4D440bd681B5F72BD0F4231a6fC04` | 4663 | The game/ecosystem token | **NONE — ownerless/immutable.** `owner()`, `DEFAULT_ADMIN_ROLE()`, `mint`, `setMinter`, `pause`, `upgradeToAndCall`, `grantRole` ALL ABSENT from bytecode. Only `burn(uint256)` (holder self-burn) present. Fixed supply ~5.3758e26. | Immutable (no admin surface) | **NOTHING TO TRANSFER** — there is no owner/admin/minter/upgrade authority. Document and move on. | n/a |
| 6 | Retired game vault (UUPS proxy) | `0x254DBcB680ECdF534eC0Dafb7aC476Bc768C77C1` | 4663 | V1 "Robbing the Vault" push-your-luck money vault | `owner()` = `0x0000…0000` — **ALREADY RENOUNCED** (the RETIRE/renounce Safe tx was executed; RVLT swept, balance 0) | UUPS, renounced | **NOTHING TO DO** — ownerless, permanently sealed, un-upgradeable. Not part of the migration. | n/a |
| 7 | StandoffEscrow TESTNET (UUPS proxy) | `0xa2321d3A8AfC966cd96636e3d11aeA2DdF8Fd355` | 46630 | Testnet twin of #1 | `owner()` = EOA `0x411f4875…49d1` (testnet deployer) | `OwnableUpgradeable` + UUPS | LOW PRIORITY. If desired, `transferOwnership` to a testnet-controlled key. The new Safe is a 4663 (mainnet) Safe and will NOT exist at the same address usability on 46630 unless deployed there — do NOT point testnet ownership at a Safe that can't act on 46630. Leave with the EOA or a dedicated testnet key. | **EOA `0x411f` signs directly** |

### Privileged non-owner roles tied to these (NOT ownership, but note for completeness)
- **Escrow `settlementSigner()`** = `0x90DE561c…b3c5` (hot key, rotatable by owner via `setSigner`). Not ownership; the new Safe can rotate it post-migration. The V2 go-live pack already plans to re-point signer/relayer/guardian to Jake's dedicated keys.
- **Escrow `treasury()`** = OLD Safe `0x2aA3…9397` (rake destination). Moving owner does NOT move treasury. If rake should land at the new Safe (or a dedicated treasury), the NEW owner must additionally call `setPayees(<treasury>, <burnSink>)` after it holds ownership. Current `burnSink` = `0x…dEaD`.
- **NFT #2 `signer()`** = `0xa6b827aB…17C9` (website voucher backend key, rotatable via `setSigner`), `sink()` = `0xe8886FD4…Ec8c` (mint-proceeds / burn source), `royaltyInfo` receiver = `0x96bcfdb1…2432` (2%). These are the EOA-owner's to rotate now, and the new Safe's after migration. The NFT uses OpenSea's canonical mainnet transfer validator `0xA000027A…5A0000` (royalty enforcement LIVE) — unchanged by ownership transfer.
- **RVLT sink wallet** `0xe8886FD4…Ec8c` is a treasury EOA (RVLT buy-burn / prize seed), not a contract admin — out of scope for contract-ownership migration.

---

## 2. Ordered execution sequence (with LOCKOUT SAFEGUARDS)

All contracts here are **single-step** `Ownable`/`OwnableUpgradeable` — `transferOwnership` takes effect in ONE tx with no accept step. The classic Ownable2Step lockout (transfer-without-accept stranding ownership) does NOT apply to any of these. The real lockout risk is the opposite: a single-step transfer to a Safe that cannot actually produce a valid tx. So the #1 safeguard is PROVING the new Safe can act BEFORE any transfer.

### Step 0 — PROVE the new Safe can act (do this FIRST, before any transfer)
1. On Robinhood mainnet (4663), confirm `0x3290…3665` is a deployed Safe: `cast codesize 0x3290…3665 --rpc-url <mainnet>` is non-zero.
2. Confirm its threshold/owners read as the intended 2-of-2 (read `getThreshold()` / `getOwners()` on the Safe).
3. Fund the new Safe's signer EOAs with native gas on 4663.
4. Execute ONE harmless proof tx FROM the new Safe (e.g. a 0-value self-call / an on-chain `ERC20.approve(self,0)`), collect both signatures, and confirm it mines. This proves the 2-of-2 can sign+execute on 4663 before anything irreversible depends on it.

Do NOT proceed to any `transferOwnership` until Step 0 passes.

### Step 1 — Escrow upgrade FIRST, then transfer (coordinate with the pending V2 upgrade)
The escrow is UUPS and a V2 upgrade is pending (see `GO-LIVE-EXECUTION.md` / `MAINNET-UPGRADE-V2.md`). Ownership transfer and the V2 upgrade both require the OLD Safe. Do the V2 upgrade + config WHILE the OLD Safe is still owner (it is the owner the whole runbook assumes), THEN transfer ownership to the new Safe as the LAST escrow action. Rationale: don't fragment a half-finished upgrade across two different owners.

Order:
1. (If doing V2 now) Run the full `GO-LIVE-EXECUTION.md` upgrade+config batch from the OLD Safe BETWEEN ROUNDS (escrow pot confirmed 0, `rounds(0/1)` all-zero — clean).
2. Run the V2 verification script; all checks pass.
3. From the OLD Safe, `transferOwnership(0x3290…3665)` on `0x6486531c…3EEA5`.
4. Verify `owner()` = new Safe (read-only).
5. If rake should move off the OLD Safe, the NEW Safe calls `setPayees(<treasury>, 0x…dEaD)`. (Optional; decide at config time.)

If NOT doing V2 in this window: just do steps 3-5 (transfer + verify + optional payees). The new Safe can run the V2 upgrade itself later — it will hold `_authorizeUpgrade`.

### Step 2 — Vault Robbers LIVE NFT (#2) — EOA-signed, not Safe
1. From EOA `0x8444…2D0e` (NOT the Safe), send `transferOwnership(0x3290…3665)` to `0xABC6c4F5…313a`.
2. Verify `owner()` = new Safe.
3. Safeguard: the mint stays live throughout (`mintActive=true`); transfer does not interrupt minting. After transfer, only the new Safe can `reserveMint`/`reveal`/`setPrices`/`setSigner`/`freezeMetadata`/rescue. Confirm the new Safe is ready to perform those before transferring if any are imminent (e.g. don't transfer the hour before a reveal unless the Safe is ready to run `reveal`).

### Step 3 — Stale NFT (#3) — decide per Open Item A, EOA-signed
Either `transferOwnership(0x3290…3665)` (bring under Safe) OR `setMintActive(false)` + `renounceOwnership()` (seal). EOA `0x8444` signs. If sealing, do `setMintActive(false)` FIRST and verify, THEN renounce (renounce is irreversible).

### Step 4 — EntropyBeacon (#4) — EOA-signed, low priority
From EOA `0x8444`, `transferOwnership(0x3290…3665)` to `0xaE28aD45…40ee`. No funds at risk; can be done anytime or skipped.

### Step 5 — RVLT token (#5) & retired vault (#6)
Nothing to do. RVLT is ownerless/immutable; the retired vault is already renounced. Record in the retire checklist.

### Step 6 — Testnet escrow (#7) — optional, EOA-signed, do NOT point at the mainnet Safe
Leave with EOA `0x411f` or a dedicated testnet key. Only transfer if a Safe exists AND can sign on 46630.

---

## 3. Retire-the-old-Safe checklist (`0x2aA3…9397`)

The OLD Safe only ever owned: the escrow (#1) and, historically, the now-renounced game vault (#6). (Note: DEPLOYED_MAINNET.txt recorded the two NFTs under the old Safe at deploy time, but on-chain today BOTH NFTs read owner = EOA `0x8444` — so the Safe does NOT currently own them.) After migration:

1. [ ] Escrow `owner()` = new Safe `0x3290…3665` (Step 1 done + verified).
2. [ ] Escrow `treasury()` — decide: keep at old Safe, or `setPayees` to new destination. If the old Safe is being fully retired, treasury MUST move off it (otherwise rake lands in a Safe you're abandoning).
3. [ ] Confirm NO other contract reads `owner()` / admin = old Safe on 4663 (escrow is the only live one; game vault is renounced). Spot-check: re-run the `owner()` reads in §1.
4. [ ] Sweep any residual token/ETH balances OUT of the old Safe to the new Safe / treasury (check RVLT, native ETH, any NFTs).
5. [ ] Only AFTER 1-4: the old Safe holds no contract authority and no funds. You may leave it dormant (recommended — no need to "destroy" a Safe) or reduce its usage. Do NOT renounce/transfer anything FROM the old Safe after Step 1 except the sweeps.

---

## 4. Open items for Jake (decisions, not blockers)

- **A. Stale NFT `0x0741…6f69`:** it is NOT the collection people are minting (3 mints vs the live 136 on `0xABC…313a`), but it is still `mintActive=true` and owned by the EOA. Recommend `setMintActive(false)` then either transfer-to-Safe or renounce, so there can't be a second "Vault Robbers" minting. Confirm which before acting.
- **B. Escrow treasury:** keep rake going to a Safe, or to a dedicated treasury key? Drives whether Step 1.5 (`setPayees`) runs.
- **C. V2 timing:** run the pending escrow V2 upgrade in the SAME window as the ownership move (recommended — one maintenance window, old Safe does the upgrade, then hands off), or transfer first and let the new Safe upgrade later.
- **D. EntropyBeacon / testnet escrow:** include or skip (both are low-stakes).

---

## 5. SEPARATE — adjacent products (Jake's scope decision; NOT part of the plan above)

Different chain (Ethereum mainnet, chainid 1) and a DIFFERENT owner EOA — intentionally excluded from the RVLT migration.

| Product | Contract | Chain | Current owner (read on-chain) | Model | Note |
|---|---|---|---|---|---|
| OneShot dedicated raffle (proxy) | `0x315144fFC17fE0B8977B74DC186d4c4deF7454F0` | 1 (ETH) | `owner()` = EOA `0x4a75f82A…9d4E` | UUPS + Ownable (single-step; `pendingOwner` reverts) | impl `0x00b1b46c…d939`. Would need the `0x4a75` EOA to sign a transfer; and the destination would have to be a Safe that can act on Ethereum mainnet — the new Robinhood Safe address is NOT guaranteed controllable on chain 1. |
| OneShot shared raffle (proxy) | `0xf640A1A82927b259B9b35c92a6433aA483A062A6` | 1 (ETH) | `owner()` = EOA `0x4a75f82A…9d4E` | UUPS + Ownable (single-step) | impl `0xcef746d6…3d58`. Same signer/same chain caveat. OneShot shares this contract's treasury+VRF sub historically. |

If Jake wants these folded in, it is a SEPARATE migration: EOA `0x4a75` signs, destination must be a Safe deployed+controllable on Ethereum mainnet (chain 1), and the VRF subscription + treasury wiring for both should be reviewed together since they're linked.

---

## 6. Confirmation

- Nothing was executed. No `--broadcast`, no Safe tx, no signature, no key generated or used, no secret set.
- Every "current owner" in this doc was read live on-chain (read-only `cast call`), not inferred from deploy records — and where a deploy record disagreed with chain state (the two NFTs, recorded as Safe-owned but reading EOA-owned today), the on-chain value wins and the drift is flagged.
- All `transferOwnership` targets use the same offline-encoded calldata (single selector + the new Safe), shown at the top.
- Dev twins and prod apps were only read, never modified.
