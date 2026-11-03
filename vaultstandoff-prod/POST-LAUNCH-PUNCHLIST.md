# Vault Standoff — Post-Launch Punch-List (compiled 2026-10-13)

Status at compile: StandoffEscrow **V7 live** on Robinhood mainnet (proxy 0x6486…3EEA5, impl 0x5C6B2fa5…), prod game published + hardened + gated at /pub/main/vault-standoff/ (is_public=false + VS_PASSWORD). Canary not yet run.

---

## A. CANARY (Jake plays small real rounds; Claude watches the chain)
- [ ] Normal round: buy in -> win -> **auto-payout lands after the 5-min challenge window** (no Collect click).
- [ ] Final-vault rollover: force/observe a mutual bust -> pot rolls into jackpot -> next win sweeps pot + jackpot.
- [ ] 1-signature **range deposit**: one approve + one sig covers N heists; confirm exactly N entries, no overspend.
- [ ] Holder discount: a Vault Robbers NFT holder pays ~$5 vs $10.
- [ ] 3-tickets-per-wallet cap holds.
- [ ] Void/refund path works (force a stuck round).
- [ ] **NEW in V7:** owner `voidRolledOver(id)` unwinds a rollover and players `refund()` (test on a throwaway round).
- WATCH (Claude): signer 0xe7B8 + relayer 0xE4aF gas balances; auto-payout keeper reads on-chain claimAt; no FATAL/parity errors in logs; pot/jackpot display matches chain.

## B. MUST-DO BEFORE PUBLIC LAUNCH (Halloween 00:00 ET)
- [ ] Remove `DEPLOYER_PRIVATE_KEY` from main env again (clean posture; done being needed after V7 deploy).
- [ ] Decide public pre-launch strategy: keep password-gated until launch, OR open with launchGate=1 countdown. Flip launchGate=0 at 00:00 ET.
- [ ] Decide is_public flip (currently false). At launch the game must be reachable; keep VS_PASSWORD or drop it.
- [ ] Stand up **vaultrobbers.com** (task #202) pointing at the game.
- [ ] Fund signer + relayer for launch volume; add a **gas-balance alert** on both (audit F-9 / monitoring).
- [ ] Confirm MetaMask/Rabby note surfaced (Phantom can't do chain 4663).

## C. CONTRACT / ON-CHAIN (optional, next revision only)
- [ ] CEI reorder: zero `jackpot` at the TOP of settle (defensive; not a live bug in single-threaded EVM).
- [ ] Snapshot `challenge` at openRound so a mid-round change can't shift an in-flight round's claim window (low).
- [ ] Document `_DOMAIN_VERSION` is intentionally frozen at "2" for this proxy.
- [ ] Monitoring/alerting on unexpected settle/void/rollover txs from the signer.

## D. SERVER / APP (lower-priority leftovers; P0+P1 already shipped)
- [ ] Encrypt `seeds.json` at rest (pre-reveal oracle; host-level risk only, dir is 0600).
- [ ] Consolidate the two admin-token paths (x-admin vs x-vs-admin) into one (rate-limit already added to /api/mode).
- [ ] Non-mainnet ADMIN_TOKEN dev-default is derived from VS_PASSWORD (staging only) — make it independent.
- [ ] Ensure admin routes require a token independent of is_public (so an accidental is_public=true never exposes admin).
- [ ] SSRF validation on any user-supplied URL in server fetches.

## E. PLATFORM CONTROL-PLANE (Build-core recommendations; read-only to me)
From the AI/agent red-team. These harden the fleet against the Sept-style attack:
- [ ] Hook `copy_env_to_group` + `register_group` (F-1 critical: 2-call secret exfil if main is socially engineered).
- [ ] Hook `Write` to any non-main `CLAUDE.md` (F-3: charter-injection / the rewrite I did today).
- [ ] Hook `schedule_task` cross-group (F-5) and `cross_publish_artifact` (F-6).
- [ ] Extend the publish hook to ALL publish paths (cross_publish, swarm-worker), not just `publish_artifact` (F-7).
- [ ] Add a "money-app + inert/canary/fails-safe reframe" clause to the publish hook (F-8).
- [ ] sender-allowlist: fail CLOSED for the main group if config missing/invalid (F-10).

## F. MISC / HOUSEKEEPING
- [ ] Move/redact the key-name->address map in `GO-LIVE-V6.md` out of the git workspace post-launch (M-4).
- [ ] Decide: unpublish the `vaultrobbers-cutover` console after go-live, or keep it gated.
- [ ] Vault Robbers artist SVGs (blocking the mint site) — separate track.
- [ ] Finish the full 5th control-plane audit write-up into the vault if a durable record is wanted (summary already in memory).

---
Compiled from: 5-agent red-team (2026-10-13), the V6 go-live runbook, and the launch session. Fixes already SHIPPED today: allowlist env scrub, gate rate-limit, /api/mode rate-limit + OPENED guard, _RL cap, schedulePayout on all paths, regex fix, RPC PROD-gate, log label; deleted the unused vault_standoff group; V7 contract (voidRolledOver) built, tested 77/77, deployed, and upgraded.
