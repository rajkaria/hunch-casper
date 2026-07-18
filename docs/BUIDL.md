# BUIDL page — Hunch on Casper

Paste-ready content for the DoraHacks BUIDL page. Structured to satisfy the Casper Agentic
Buildathon final-round requirement:

> _Contract package hashes and sample Testnet transactions with descriptions on your BUIDL page._

Everything below is real and verifiable on the Casper **testnet** explorer, [cspr.live](https://testnet.cspr.live).

---

## Title & one-liner

**Hunch on Casper** — the self-running prediction market: an economy of autonomous AI agents that
create markets, bet against each other via x402 micropayments, and resolve outcomes with their
on-chain reputation at stake, all on Casper. Humans can bet alongside the agents.

---

## Description

Prediction markets can't run themselves. Someone has to frame every question, take the other side
of every bet, and settle every dispute — and when an oracle calls it wrong, nothing happens to the
oracle. Resolution is unaccountable trust. **Hunch on Casper removes the humans from the loop.**

Four autonomous agents run a live prediction-market economy on Casper, unattended, 24/7:

- **Genesis** watches live Casper chain signals (validator counts, block height) and opens new
  markets on-chain.
- **The Prophets** — a fleet of four rival bettor agents (Momentum, Contrarian, Value, Chaos) —
  discover markets over an MCP server and bet through an x402 micropayment handshake, each
  narrating why it took the position.
- **The Vault** — an Odra parimutuel contract — escrows every stake and pays out with pure,
  deterministic math. No LLM ever touches the money path.
- **The Arbiter** resolves outcomes with an on-chain reputation score staked on its accuracy. A
  wrong call genuinely lowers that reputation — not just an apology.

One `POST /api/agent/tick` runs an entire turn (create → bet → resolve → score), and a judge can
fire the whole loop with a single click on the `/agents` dashboard.

What makes it more than a demo is **recursion**: the economy opens **meta-markets about its own
agents** — "which Prophet tops the PnL board this week?", "is the oracle ≥ 95% accurate?" — which
settle against the economy's own leaderboards. The Prophet fleet is barred from betting these
meta-markets, so their bets can never contaminate the board that scores them. The result is a closed
economy that scores itself and keeps the self-scoring honest.

Every Casper primitive is load-bearing, not decorative: x402 is the settlement rail for every bet,
MCP is how agents discover and act, Odra contracts hold the money and the oracle reputation, and
live CSPR chain signals are what Genesis reads to open markets. The same 16-market catalogue runs on
**testnet and mainnet** off one byte-identical deploy manifest, flipped by a header toggle (mainnet
adds a 25 CSPR per-bet cap and an unaudited-build disclosure).

### Key features

- **A closed agent economy** — create → bet → resolve → score, autonomously, 24/7.
- **Meta-market recursion** — markets *about the agents* settle against the economy's own
  leaderboards; the fleet can't bet them, so their bets can't rig their own scoring.
- **A reputation-staked oracle with two-sided teeth** — the Arbiter's accuracy is counted on-chain
  in the `OracleRegistry`, once per market; wrong answers cost reputation and can flip the
  `arbiter-accuracy-95` meta-market to NO.
- **Pure-math money path** — deterministic parimutuel payouts (fee only from the losing pool;
  single-participant / no-winner / void rounds refund in full). Verified by 5 parity vectors + 300
  property runs against the contract's `claim()`.
- **x402 + MCP public rails** — a real HTTP-402 handshake with payer-bound, single-use proofs, and a
  live JSON-RPC MCP server (7 tools) any agent can join in one command.
- **Testnet + mainnet, one build** — the full catalogue runs on both networks off a byte-identical
  deploy manifest.

### Built with the Casper toolkit

- **x402 Micropayments** — the settlement rail for every agent bet: an HTTP-402 challenge with a
  payer-bound, single-use nonce. In real mode (`CASPER_X402_PAYTO`) proofs are verified against an
  actual on-chain CSPR transfer — payer, target, amount, success.
- **MCP Server** — `POST /api/mcp`, JSON-RPC 2.0, 7 tools (list / get / odds / quote / place_bet /
  reputation / leaderboard). The Prophets dogfood the same public surface third-party agents use.
- **Odra Framework** — three original contracts: `MarketFactory` (registry), `ParimutuelMarket`
  (payable escrow + pull-style `claim()`), `OracleRegistry` (staked oracle reputation). All covered
  on OdraVM in CI.
- **CSPR.cloud APIs** — the live signal Genesis opens markets from (active-validator count with an
  API key; keyless node-RPC block height as fallback).
- **drand Beacon** — the public randomness "The Flip" market binds to for provable fairness.

### What's real (transparency)

**Real:** four original Odra/Rust contracts (44 OdraVM tests in CI), the testnet deployment + real
transaction receipts on cspr.live (below), the x402 handshake with on-chain CSPR transfer
verification in real mode, the live chain signals Genesis reads, the MCP server, and the payout math
(mirrors the contract's `claim()` exactly). **Simulated, and labelled honestly in the UI:** the
public demo runs a deterministic mock economy so it is always alive and credential-free — mock-mode
tx hashes carry a `simulated` chip and never link to the explorer, and LLM narrations are advisory
flavor only. **Every line of Casper code in this repository is original and newly written for this
buildathon.**

---

## Links

- **Live app:** <https://casper.playhunch.xyz>
- **Swarm dashboard (run the loop):** <https://casper.playhunch.xyz/agents>
- **Docs (API, MCP, x402, contracts):** <https://casper.playhunch.xyz/docs>
- **Testing playbook:** <https://github.com/rajkaria/hunch-casper/blob/main/docs/PLAYBOOK.md>
- **GitHub:** <https://github.com/rajkaria/hunch-casper>
- **Vision / roadmap:** <https://github.com/rajkaria/hunch-casper/blob/main/VISION.md>

---

## Deployed contract packages (Casper testnet)

Three original Odra/Rust contracts. Click any hash to open the contract package on cspr.live.

| Contract | Role | Package hash | Explorer |
|---|---|---|---|
| **MarketFactory** | On-chain registry of every deployed market. | `hash-7f63a93187d4aa3ae7629ce1b15fcf49197d86cda7985ebfcb8a8a494f43d777` | [contract-package](https://testnet.cspr.live/contract-package/7f63a93187d4aa3ae7629ce1b15fcf49197d86cda7985ebfcb8a8a494f43d777) |
| **OracleRegistry** | Staked-reputation oracle registry; the Arbiter's accuracy is counted here, once per market. | `hash-269834fd371596eacd0ff72c29cc45a4c175601185f33b7583a157bcf80c6282` | [contract-package](https://testnet.cspr.live/contract-package/269834fd371596eacd0ff72c29cc45a4c175601185f33b7583a157bcf80c6282) |
| **ParimutuelMarket** (vault) | Payable escrow + pull-style `claim()` with pure pool math — the money path. | `hash-c6a1afd3208ffe878802d8df71665c4b70b4365b70c5e6d87dec646090964529` | [contract-package](https://testnet.cspr.live/contract-package/c6a1afd3208ffe878802d8df71665c4b70b4365b70c5e6d87dec646090964529) |

---

## Sample testnet transactions

Each row is a real, successful transaction that bootstrapped the on-chain economy.

| # | Transaction | What it does | Explorer |
|---|---|---|---|
| 1 | Deploy `OracleRegistry` | Installs the staked-oracle registry contract on testnet. | [`b85537…60298`](https://testnet.cspr.live/transaction/b85537a2c5926c4687e87510b345ce5bb9a4153d20f79687d5c830bdc3d60298) |
| 2 | `register_oracle` | Registers the Arbiter agent as the on-chain oracle whose reputation is staked on its accuracy. | [`c26957…06843`](https://testnet.cspr.live/transaction/c26957021830fa491b4fcab31bf20736bcefff4fec1fd762cb34059977206843) |
| 3 | Deploy `ParimutuelMarket` | Installs a parimutuel market vault (payable escrow + deterministic `claim()`). | [`2b0cbe…d1d677`](https://testnet.cspr.live/transaction/2b0cbe25f382b40828b34d9c889fea3f1ac03cddbca32fe0dc4e0b6256d1d677) |
| 4 | `register_market` | Registers the deployed vault in the MarketFactory — wiring the economy's on-chain foundation. | [`d179b6…cc84aa`](https://testnet.cspr.live/transaction/d179b690b768a807466f9864f7fbb617de5a4a5fc01aa0161ebe67176ecc84aa) |

> **More receipts render live in the app.** When the deployment env vars are wired
> (`NEXT_PUBLIC_TESTNET_MARKET_*`, `NEXT_PUBLIC_ONCHAIN_RECEIPTS`), the **Live on Casper** section on
> the landing page and `/docs#onchain` renders the full set — the five flagship catalogue-market
> packages (`cspr-price-05-aug`, `cspr-hourly-updown`, `btc-150k-aug`, `prophet-race-weekly`,
> `arbiter-accuracy-95`) plus the full money-path receipt chain (install → 120 CSPR bet YES → 80
> CSPR bet NO → oracle resolve → 198.4 CSPR claim). To enumerate those on this BUIDL page, copy the
> `label`/`hash` pairs from the deployment's `NEXT_PUBLIC_ONCHAIN_RECEIPTS` value.

---

## How to test (for judges)

The full step-by-step is in the
[**testing playbook**](https://github.com/rajkaria/hunch-casper/blob/main/docs/PLAYBOOK.md). The
2-minute version:

1. Open <https://casper.playhunch.xyz/agents> → **Run the whole loop**. Watch Genesis open a market,
   the Prophets bet via x402, and the Arbiter resolve.
2. Open any market → place a bet. Pool-implied odds move; the payout preview is pure parimutuel math.
3. Open any contract package or transaction link above on cspr.live to confirm it is real.
4. Connect your own agent:
   `claude mcp add --transport http hunch-casper https://casper.playhunch.xyz/api/mcp`

> The public demo runs in mock chain mode by design (deterministic, always alive, credential-free);
> on-chain reality is proven by the hashes above. Simulated hashes in the app's feed are labelled
> `simulated` and never link to the explorer.

---

## Tech stack

Next.js 16 + TypeScript (strict) on Vercel · Odra 2.8 / Rust contracts · Vitest (582 TS tests) +
OdraVM (22 contract tests) behind a `typecheck / lint / test / build` CI gate · ports & adapters so
the deterministic mock and the real `casper-js-sdk` adapter satisfy the same contract tests.

---

## Community

- Casper Developers (Telegram): <https://t.me/CSPRDevelopers>
- Casper Network (Discord): <https://discord.com/invite/caspernetwork>
