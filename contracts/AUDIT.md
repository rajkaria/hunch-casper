# Audit bundle — Hunch on Casper contracts

A scoped, reviewable artefact for an independent auditor (or a careful reader) of the on-chain
layer. It states what the contracts are, what must always be true of them, who is allowed to call
what, the risks we have accepted with eyes open, and where the tests cover it. It is written to be
read alongside the source, not instead of it.

**Status:** testnet-only, **unaudited**. This document is the input to an audit, not its output. No
mainnet deployment carries real funds until an independent audit closes. The paid audit itself is
an operator action (only-stop list) and is not performed by the build automation.

**Commit reviewed:** the tree containing this file. **Backends:** Odra `OdraVM` (tests) and Casper
`casper` (wasm). **Toolchain:** pinned in `contracts/rust-toolchain`.

---

## 1. Contracts in scope

| Contract | File | Role | Handles funds? |
|---|---|---|---|
| `HunchVault` (v2) | `src/hunch_vault.rs` | Singleton multi-market escrow + settlement. Markets are state entries keyed by `market_id`; `bet`/`resolve`/`claim` carry the id. Creation bond + parimutuel payout math. | **Yes** — native CSPR escrow, the money path |
| `ParimutuelMarket` (v1) | `src/parimutuel_market.rs` | Single-market escrow + settlement (the pre-v2 model; still deployed for legacy markets). | **Yes** |
| `MarketFactory` | `src/market_factory.rs` | On-chain registry (id → question/category/address/deadline/resolved). No escrow. | No |
| `OracleRegistry` | `src/oracle_registry.rs` | Oracle identity + staked reputation (accuracy in bps). | No |
| `AgentRegistry` | `src/agent_registry.rs` | Bonded agent identity; bond held at risk, admin-gated slashing with reason codes. | **Yes** — holds bonds |

The money-path contracts are `HunchVault`, `ParimutuelMarket`, and `AgentRegistry` (bond custody).
`MarketFactory` and `OracleRegistry` are index/identity only.

---

## 2. Invariants (what must always hold)

These are the properties an auditor should try hardest to break. Each is asserted by OdraVM tests
(§6); the property ones are exhaustive over generated inputs.

**Conservation**
- **I1 — no mint:** across a market's life, `Σ claims + Σ refunds + fee ≤ Σ stakes`. The vault never
  pays out more than was staked. (Parimutuel: winners split the whole pool net of fee.)
- **I2 — fee only from the losing pool:** the fee is taken from losers, never from a winner's
  principal. A winner on a one-sided or degenerate market is made whole.
- **I3 — degenerate rounds refund in full:** a market with no winning stake (void, single
  participant, unbacked winning outcome) refunds every bettor their principal with **zero** fee.

**Authority** (see §3 for the full table)
- **I4 — only the bound oracle resolves:** `resolve`/`void` revert for any caller that is not the
  market's oracle. The oracle is set at creation and is immutable thereafter.
- **I5 — a creator is never their own oracle:** creation binds an approved, non-creator oracle.
  A self-oracle market (create → take the other side → self-resolve → drain) is rejected at
  `create_market`. This is the theft vector S19 closed; the test drills it directly.
- **I6 — admin-only administration:** `approve_oracle`, `set_open_creation`,
  `set_max_open_markets_per_creator`, `slash`, `set_min_bond`, `set_cooldown_ms` revert for
  non-admin callers.

**State machine**
- **I7 — one resolution:** a market resolves at most once; a second `resolve`/`void` reverts.
- **I8 — no bet after close:** `bet` reverts once a market is resolved/voided or past its deadline.
- **I9 — claim once:** each (bettor, market) can `claim` at most once; double-claim reverts.
- **I10 — no claim before resolution:** `claim` reverts on an open market.

**Bonds (AgentRegistry / creation bond)**
- **I11 — bond conservation:** a slash moves at most the bonded amount; the remainder is
  withdrawable after cooldown. A slash cannot exceed the bond.
- **I12 — cooldown before withdraw:** `withdraw_bond` reverts before the deactivation cooldown
  elapses.
- **I13 — creation bond round-trips:** the creation bond is refunded on clean resolution and
  retained on an unresolvable/void market, never silently kept on a clean one.

**Never-LLM (design invariant, enforced off-chain + by contract structure)**
- **I14 — deterministic money:** every payout, fee, slash and bond figure is pure integer math in
  the contract. No contract call takes an LLM output as an argument that selects a winner or sizes
  a payout. LLMs propose markets and narrate; they never resolve.

---

## 3. Authority table (entrypoint by entrypoint)

`HunchVault` (v2):

| Entrypoint | Caller allowed | Reverts when | Moves funds |
|---|---|---|---|
| `create_market` | anyone (if `open_creation`) or admin | oracle is creator / oracle not approved / per-creator open-market cap hit / bad args | escrows creation bond |
| `bet` | anyone | market missing/closed/past deadline; outcome invalid | escrows stake |
| `resolve` | the market's bound oracle | non-oracle caller; already resolved; unknown outcome | sweeps fee + bond |
| `void` | the market's bound oracle | non-oracle caller; already resolved | — |
| `claim` | a winning bettor | before resolution; already claimed; no winning stake | pays winner |
| `refund` | a bettor on a void/degenerate market | market not refundable; already refunded | refunds principal |
| `set_open_creation`, `approve_oracle`, `set_max_open_markets_per_creator` | admin | non-admin | — |
| readonly getters | anyone | — | — |

`AgentRegistry`:

| Entrypoint | Caller | Reverts when | Funds |
|---|---|---|---|
| `register` | anyone | bond < `min_bond`; already registered | escrows bond |
| `update_profile` | the agent | not registered | — |
| `deactivate` | the agent | not registered | starts cooldown |
| `withdraw_bond` | the agent | before cooldown; nothing to withdraw | returns bond |
| `slash` | **admin only** | non-admin; amount > bond | seizes ≤ bond |
| `set_min_bond`, `set_cooldown_ms` | admin | non-admin | — |

`MarketFactory` / `OracleRegistry`: all writes are admin-gated; reads are open. Neither escrows.

---

## 4. Threat model

Actors: **bettor** (untrusted), **market creator** (untrusted once creation is open), **oracle**
(semi-trusted, reputation-staked), **admin** (trusted operator key), **agent** (untrusted, bonded).

Threats considered and where they are addressed:

- **Creator self-resolution / theft** → I5, enforced at `create_market` (oracle ≠ creator, oracle
  must be pre-approved). The central guardrail.
- **Oracle grief / wrong resolution** → today: reputation at stake + admin oversight. S25 adds
  optimistic resolution + dispute bonds + a stake-weighted panel so a wrong resolution is
  challengeable in contract math, not just socially. Flagged as the current centralisation.
- **Reentrancy on payout** → payout/claim update state before transferring; native CSPR transfers,
  no external contract callback in the money path. An auditor should confirm the checks-effects
  -interactions order at every `transfer`.
- **Integer overflow / precision** → `U512` math; pro-rata division rounds down (dust stays in the
  pool, never overpays — see I1). Confirm no path multiplies after dividing.
- **Griefing creation** → per-creator open-market cap + creation bond raise the cost of spamming
  the board; the off-chain category policy (`src/core/category-policy.ts`) rejects prohibited
  questions before they are created.
- **Bond farming via self-slash / wash** → slashing is admin-gated with reason codes (decision
  D10), not permissionless, precisely because every wash-trading heuristic has an innocent
  explanation; heuristics are advisory evidence, a human decides.
- **Replay of an x402 payment** → off-chain: one payment settles one bet, keyed by settlement hash;
  the real payment adapter additionally checks the on-chain transfer is unspent.

---

## 5. Known & accepted risks (for mainnet consideration)

1. **Admin key is a trusted single point.** `approve_oracle`, `slash`, and creation toggles are
   admin-gated. A compromised admin key can approve a malicious oracle or slash honestly. Mitigation
   path: multisig/timelock the admin, and S25's dispute panel removes slashing from admin authority.
2. **Oracle resolution is semi-trusted until S25.** A bound oracle can resolve wrongly; only its
   reputation and admin oversight check it today. Optimistic resolution + disputes are the fix.
3. **Unaudited.** No independent review has been performed. The mainnet build ships a per-bet cap
   (`src/config/caps.ts`, 25 CSPR while unaudited) and an unaudited-build banner on every surface;
   the cap cannot rise above the ceiling until `NEXT_PUBLIC_AUDIT_STATUS=audited` (property-tested).
4. **Off-chain index is convenience, not authority.** The KV/store mirror is demo-grade and
   last-write-wins; the chain remains the source of truth for money. A stale index misreports odds,
   never mis-pays.

---

## 6. Test-coverage map

`cargo odra test` runs the OdraVM suite (credential-free, in CI). Counts are `#[test]` functions.

| Contract | Tests | Covers |
|---|---|---|
| `hunch_vault.rs` | 34 | create/bet/resolve/void/claim/refund state machine; I1–I3, I5, I7–I10, I13; self-oracle rejection drill; per-creator cap; bond round-trip |
| `parimutuel_market.rs` | 11 | single-market escrow + settlement; fee-from-losers (I2); degenerate refunds (I3); claim-once (I9) |
| `agent_registry.rs` | 14 | register/deactivate/withdraw/slash; bond conservation (I11); cooldown (I12); admin gating (I6) |
| `market_factory.rs` | 8 | registration; admin gating; idempotent re-register guard |
| `oracle_registry.rs` | 8 | oracle identity; at-most-once resolution record; admin gating |

Plus the TS side (`pnpm test`, 900+ tests): the pure payout engine (`core/market-payout.ts`) mirrors
the vault's math and is property-tested for conservation; `test/gas-budgets.test.ts` asserts every
gas limit exceeds measured consumption with headroom; `test/real-mode-honesty.test.ts` asserts no
real-mode path emits a `simulated` chip.

---

## 7. What an auditor should focus on first

1. The checks-effects-interactions order around every CSPR `transfer` in `hunch_vault.rs`
   (`claim`, `refund`, `resolve` fee sweep) — reentrancy and double-pay.
2. The `create_market` oracle-binding guard (I5) — the theft vector; try every way to name yourself
   or an unapproved oracle.
3. The parimutuel division/rounding in the payout path — confirm dust rounds *into* the pool.
4. `slash` bounds (I11) and the cooldown gate on `withdraw_bond` (I12).
5. The state-machine reverts (I7–I10) under out-of-order calls (bet after resolve, claim before
   resolve, double resolve).
