# What Casper contract calls actually cost

Every number on this page was **measured on Casper testnet**, not estimated. Each row names the
transaction it came from, so you can open it on `testnet.cspr.live` and check.

Published because these figures are hard to find and expensive to acquire: the difference between
a design that costs 324 CSPR per market and one that costs 3.74 was a week of work to discover,
and there is no reason the next team should pay for it again.

## How to read a cost

Casper holds the **full gas limit** at acceptance and refunds **75% of the unused portion**. So
three numbers matter and only one of them is what you pay:

```
net = consumed + 0.25 × (limit − consumed)
```

- **limit** — what you must hold in the purse before submitting. An install you cannot fund at the
  limit fails at acceptance, even if it would only have consumed a third of it.
- **consumed** — what execution actually used.
- **net** — what leaves the purse for good. This is the number to budget an economy against.

A cheap call with a generous limit is not free: raising a limit "just in case" costs 25% of the
slack on every single call. The limits below are tuned, not padded.

**Method.** Every deploy driver prints a `HUNCH_GAS` line per call with all three numbers. The
tables are those lines. Toolchain pinned in [`contracts/rust-toolchain`](../contracts/rust-toolchain);
Odra 2.8.2; measurements from the runs dated below.

## The headline: markets as state entries, not contracts

The single most consequential number in this repository.

| Approach | Cost per new market | Measured |
|---|---|---|
| Install a `ParimutuelMarket` contract per market (v1) | **324.27 CSPR** | 2026-07-05 run |
| `create_market` on a singleton `HunchVault` (v2) | **3.74 CSPR** | 2026-07-18 run, tx `e2bb364c…` |

**87× cheaper.** This is what makes an autonomous market-creating agent possible at all: at 324
CSPR a call, an agent opening one market per hour burns 7,782 CSPR a day and no grant survives it.
At 3.74 the same cadence costs 90 CSPR a day.

The pattern is in [`contracts/PATTERNS.md`](../contracts/PATTERNS.md#1-markets-as-state-entries).

## HunchVault v2 — the singleton escrow

Testnet: `hash-ce45136047089a4d0882c7b52f1df6a01ff8e601c1b097440f705fdc9f2876a1`
Measured 2026-07-18.

| Call | net (CSPR) | consumed | limit | tx |
|---|---|---|---|---|
| `HunchVault` install (one-time) | **373.07** | 364.099 | 400 | `43eab0e4…` |
| `create_market` (first — initialises the dictionaries) | **5.22** | 4.958 | 6 | `40273e4b…` |
| `create_market` (typical) | **3.74** | 2.323 | 8 | `e2bb364c…` |
| `register_market` | **1.48** | 0.976 | 3 | `1515eff3…` |
| `bet` | **3.08** | 1.439 | 8 | `79f232a6…` |
| `resolve` (fee sweep + bond refund) | **6.74** | 6.317 | 8 | `46312a4c…` |
| `claim` | **4.19** | 2.921 | 8 | `1364254c…` |

Note the **first** `create_market` costs 40% more than the steady state. That is dictionary
initialisation, a one-off per vault — budget for it, don't be alarmed by it, and don't infer your
per-market cost from it.

`resolve` is the most expensive recurring call because it does the most: sweeps the fee, refunds
the creation bond, and writes the outcome.

## FieldMarket — a parimutuel over a 177-candidate field

Testnet: `hash-dd4c2a59183c251a9654ea79130916ff6ae9c06b7159910745f12c2b79a7930e`, field frozen at
commitment `59f84e52a4a6271220dee52c2353a9435e584fedec049353cf533d1b79b81e7b`. Measured 2026-08-01.

| Call | net (CSPR) | limit | tx |
|---|---|---|---|
| `FieldMarket` install (331,421-byte wasm) | **354.10** | 450 | `4f802fa1…` |
| `register_candidates` × 40 keys | **7.458** | 10 | `be19ce69…` + 3 more |
| `register_candidates` × 17 keys | **4.734** | 10 | `42abda06…` |
| `freeze_field` | **2.942** | 10 | `9d476f58…` |
| **Whole deploy, install → open for betting** | **391.61** | — | — |

**≈0.186 CSPR per candidate, and flat in the field width.** That flatness is the whole point: it
is what a dictionary buys you over a `Vec`. See
[`PATTERNS.md`](../contracts/PATTERNS.md#3-dictionary-membership-for-wide-fields).

## AgentRegistry — bonded agent identity

Testnet: `hash-e226e709c6806bc9e7208e3e421859aa840fc88d27dd3604101426e61d3d9955`
Measured 2026-08-02, deployed with `registry-deploy 100 48` (100 CSPR minimum bond, 48h
withdrawal cooldown).

| Call | net (CSPR) | limit |
|---|---|---|
| `AgentRegistry` install (308,722-byte wasm) | **329.43** | 450 |
| `register` (agent bonds its own identity) | 8 (limit) | 8 |

The install figure is the deployer purse before and after: 2000.00 → 1670.57 CSPR. It is a good
reference point for "what does an Odra contract of ~300 KB cost to install", independent of what
this particular contract does.

## v1 per-market installs (historical)

| Call | net (CSPR) | consumed | limit |
|---|---|---|---|
| `ParimutuelMarket` install | **324.27** | 299.023 | 400 |

Kept here because it is the baseline the v2 design is measured against, and because it is a
realistic number for *any* Odra contract install of that size — useful if you are budgeting your
own deploy rather than ours.

## Budgeting rules of thumb

1. **Hold the limit, not the net.** A 450-CSPR install limit needs 450 CSPR in the purse at
   submit time. `field-deploy` refuses to start below the full budget rather than stranding a
   contract with an unfreezable field.
2. **A contract install is ~300–400 CSPR** at these wasm sizes. Treat every install as a
   deliberate, funded event; never put one on an automated path.
3. **A state-entry write is single-digit CSPR.** This is what agents can afford to do on a
   schedule.
4. **Budget an autonomous economy on `net`, per tick, per capability.** Hunch's cadence planner
   degrades on exactly these numbers: house seeding off below 24h of runway, market creation off
   below 8h, betting last. See [`OPS.md`](./OPS.md).
5. **Native transfers have a floor.** `core.native_transfer_minimum_motes` is 2.5 CSPR on
   testnet — a consensus rule, not a policy. Any micropayment design settling in native CSPR
   inherits it as a minimum payment size.

## Reproducing these

```bash
cd contracts
cargo run --bin contracts_catalogue -- balance         # what the deployer holds
cargo run --bin contracts_catalogue -- vault-deploy 1000000000
```

Each call prints its own `HUNCH_GAS` line. Full step-by-step receipts, including the exact command
for every table row above, are in [`contracts/DEPLOY.md`](../contracts/DEPLOY.md).
