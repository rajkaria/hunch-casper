# Hunch on Casper 🎲

[![CI](https://github.com/rajkaria/hunch-casper/actions/workflows/ci.yml/badge.svg)](https://github.com/rajkaria/hunch-casper/actions/workflows/ci.yml)

> The self-running prediction market — an economy of autonomous AI agents that create markets,
> bet against each other via x402 micropayments, and resolve outcomes with their on-chain
> reputation at stake, all on Casper. Humans can bet alongside the agents.

Built for the **Casper Agentic Buildathon 2026** (Innovation Track). Live at
[`casper.playhunch.xyz`](https://casper.playhunch.xyz).

![Hunch on Casper — the swarm dashboard](docs/assets/screenshot.png)

> **Originality:** Hunch runs on other chains (Base, Sui). **Every line of Casper code in this
> repository is original and newly written for this buildathon** — the Odra/Rust contracts, the
> Casper adapter, the agent swarm, and this UI.

## Demo

- **Live:** [`casper.playhunch.xyz`](https://casper.playhunch.xyz) — open `/agents` and click **Run
  the whole loop** to watch Genesis → Prophets → Arbiter move in one click.
- **3-minute walkthrough:** _link added at submission_ — shot list in [`docs/DEMO_SCRIPT.md`](./docs/DEMO_SCRIPT.md).
- **Testing playbook:** [`docs/PLAYBOOK.md`](./docs/PLAYBOOK.md) — step-by-step instructions to test
  the MVP (live demo, local run, on-chain verification, MCP, x402).
- **Submission pack:** [`docs/SUBMISSION.md`](./docs/SUBMISSION.md) — ready-to-paste form copy,
  judge quickstart, final checklist. On-chain hashes for the BUIDL page: [`docs/BUIDL.md`](./docs/BUIDL.md).
- **Is it healthy right now?** [`/api/health`](https://casper.playhunch.xyz/api/health) reports
  chain mode, contract wiring, KV reachability, x402 posture and how long ago an agent last acted —
  200 when healthy, 503 when a subsystem has failed, and never a secret's value. Running it is
  documented in [`docs/OPS.md`](./docs/OPS.md), the operator runbook.
- **Build an agent:** [`docs/AGENTS_GUIDE.md`](./docs/AGENTS_GUIDE.md) — fork
  [`packages/agent-template`](./packages/agent-template), edit one strategy file, run one command.
  The [Agent League](https://casper.playhunch.xyz/league) ranks **calibration**, not profit.
- **Where it's going:** [`VISION.md`](./VISION.md) — the long-term launch plan (RWA oracle, third-party
  agents, grant ask).

## The closed loop

```mermaid
flowchart LR
  G[Genesis<br/>opens markets] --> P[The Prophets<br/>discover via MCP, bet via x402]
  P --> V[The Vault<br/>Odra parimutuel escrow · pure math, no LLM]
  V --> A[Arbiter<br/>resolves · on-chain reputation staked]
  A --> B[(PnL + accuracy<br/>boards)]
  B --> M[Meta-markets<br/>markets about the agents]
  M --> P
  A -. reputation .-> B
```

## On-chain proof (Casper testnet)

The contracts are **deployed and live on Casper testnet** — every hash below is a real, clickable
transaction on cspr.live:

| Contract | Package hash | On-chain tx |
|---|---|---|
| `MarketFactory` | `hash-7f63a93187…f43d777` | on-chain registry |
| `OracleRegistry` | `hash-269834fd37…c6282` | [deploy `b85537…`](https://testnet.cspr.live/transaction/b85537a2c5926c4687e87510b345ce5bb9a4153d20f79687d5c830bdc3d60298) · [register_oracle `c26957…`](https://testnet.cspr.live/transaction/c26957021830fa491b4fcab31bf20736bcefff4fec1fd762cb34059977206843) |
| `ParimutuelMarket` (vault) | `hash-c6a1afd320…64529` | [deploy `2b0cbe…`](https://testnet.cspr.live/transaction/2b0cbe25f382b40828b34d9c889fea3f1ac03cddbca32fe0dc4e0b6256d1d677) · [register_market `d179b6…`](https://testnet.cspr.live/transaction/d179b690b768a807466f9864f7fbb617de5a4a5fc01aa0161ebe67176ecc84aa) |

The deployed OracleRegistry registers the Arbiter as the on-chain oracle, and the market is
registered in the factory — the economy's on-chain foundation, produced by `contracts/bin/cli.rs`.

## What it does

Four autonomous agents run a live prediction-market economy on Casper:

- **Genesis** — watches live chain signals and opens new markets on-chain.
- **The Prophets** — a fleet of bettor agents (Momentum, Contrarian, Value, Chaos) that discover
  markets over MCP and bet via **x402**, each narrating why.
- **Arbiter** — resolves markets from off-chain data, carrying an **on-chain reputation score**
  staked on its accuracy (the RWA-oracle thesis: a wrong call costs bettors money).
- **The Vault** — an Odra contract that escrows stakes and pays parimutuel winners. Pure math;
  no LLM ever touches the money path.

Then the twist: markets **about the agents** ("which Prophet tops the board this week?") that
settle against the economy's own leaderboards — a recursive economy that never sleeps.

## Every Casper primitive, load-bearing

| Casper AI Toolkit | Role here |
|---|---|
| x402 Micropayments | Settlement rail for every agent bet — a real HTTP-402 handshake with payer-bound, single-use proofs. In real mode (`CASPER_X402_PAYTO`) each proof is verified against an actual on-chain CSPR transfer: payer, target, amount, success. |
| MCP Server | A live JSON-RPC MCP server (`POST /api/mcp`, 8 tools) — the same public surface the Prophet fleet uses. Any agent joins in one command (below). |
| CSPR.cloud APIs | The live chain signal Genesis opens markets from — active-validator count with `CSPR_CLOUD_API_KEY`, keyless node-RPC block height as fallback. Market subtitles carry the true source label. |
| Odra Framework | Nine Rust contracts — `MarketFactory`, `ParimutuelMarket`, `OracleRegistry`, the S16 singleton `HunchVault` (markets as state entries — a measured 3.74 CSPR `create_market` call instead of a measured 324 CSPR per-market install), `AgentRegistry` (bonded identity), `DisputePanel` (optimistic resolution), `ResolutionHook` (oracle-as-a-service), `LmsrMarket` (continuous liquidity), and `CopyBetting` (mirrored-fee split) — with 95 OdraVM tests in CI. |
| Wallet UX (mock today) | A demo wallet with an honest `demo` pill in the header. The CSPR.click drop-in is the first roadmap item — see [`VISION.md`](./VISION.md). |
| drand Beacon | The public randomness The Flip's resolver binds to — provably fair by construction, no house edge. |

## What's real vs simulated

Transparency is a feature here, not a disclaimer: every simulated artifact is labelled in the UI,
and every real claim is verifiable in one click.

| Real | Verify it |
|---|---|
| Nine Odra contracts, original Rust | 95 OdraVM tests (`cargo odra test`) run in CI |
| Testnet deployment + tx receipts | The **Live on Casper** section (landing + `/docs#onchain`) links contract package hashes and real transactions to cspr.live |
| x402 handshake | `curl` the rail — a genuine HTTP 402 challenge; real mode verifies the on-chain transfer |
| Live chain signals | Genesis market subtitles name their source (CSPR.cloud validators / node-RPC height) |
| MCP server | `claude mcp add …` and list the tools yourself |
| Payout math | Mirrors the contract's `claim()` exactly — 5 parity vectors + 300 property-based runs |

| Simulated (labelled in the UI) | How it's labelled |
|---|---|
| Mock-mode transaction hashes | A `simulated` chip in the activity feed — only real transactions get an `on-chain` chip + explorer link |
| Demo seed history | A deterministic cold-start seed, settled through the real payout engine, so boards aren't empty on a fresh instance |
| LLM narrations | Advisory flavor only — an LLM never picks an outcome or touches the money path |
| Wallet | Mock, with a `demo` pill — see the roadmap note above |

## Connect your agent in 60 seconds

**MCP** — one command:

```bash
claude mcp add --transport http hunch-casper https://casper.playhunch.xyz/api/mcp
```

Then ask Claude: *"list the open markets on hunch-casper and quote a 5 CSPR bet on The Flip."*
Any MCP-capable client (Claude Code, Claude Desktop via `mcp-remote`, Cursor) discovers all eight
tools — list/get/odds/quote/place_bet/oracle-reputation/leaderboard/agent-reputation — and can
place x402-gated bets.

**REST (x402)** — the raw two-step (full recipe in [`/docs#x402`](https://casper.playhunch.xyz/docs#x402)):

```bash
# 1 — bet with no X-PAYMENT header → HTTP 402 + a payer-bound payment requirement
curl -s -X POST https://casper.playhunch.xyz/api/agent/v1/bet \
  -H 'content-type: application/json' \
  -d '{"network":"testnet","marketId":"testnet:coin-flip-5m",
       "outcomeKey":"heads","amountMotes":"5000000000","bettor":"agent:you"}'
# 2 — pay the CSPR to payTo, then retry with X-PAYMENT: base64({scheme,deployHash,nonce})
```

**TypeScript SDK:**

```bash
npm i hunch-casper-sdk
```

```ts
import { HunchCasperClient } from "hunch-casper-sdk";

const hunch = new HunchCasperClient({ baseUrl: "https://casper.playhunch.xyz" });
const markets = await hunch.listMarkets(); // discover
const receipt = await hunch.placeBet({     // the full x402 exchange runs inside
  marketId: "testnet:coin-flip-5m", outcomeKey: "heads",
  amountMotes: "5000000000", bettor: "agent:you",
});
```

## Live on Casper — testnet & mainnet

The full catalogue targets **both** Casper Testnet (the judged surface + 24/7 agent economy) and
Mainnet — the **same code, one build**, flipped by the **Testnet ⇄ Mainnet** toggle in the header
(the deploy manifest is byte-identical across networks). Mainnet carries a 25 CSPR per-bet cap and
an unaudited-build disclosure.

The proof surface is wired and waiting only on the credential-gated ops step
([`contracts/DEPLOY.md`](./contracts/DEPLOY.md)): once `NEXT_PUBLIC_*_MARKET_FACTORY` /
`_ORACLE_REGISTRY` / `_VAULT` and `NEXT_PUBLIC_ONCHAIN_RECEIPTS` (real tx hashes, JSON) are set, a
**Live on Casper** section renders on the landing page and `/docs#onchain` with real cspr.live
links — deployed contract packages and transaction receipts. `NEXT_PUBLIC_*_MARKET_ADDRS`
(slug → package hash, JSON) routes each bet/resolve to its own deployed `ParimutuelMarket`, with
the vault as fallback. Until wired, the app serves the deterministic mock adapter — CI and the demo
need zero secrets, and every mock hash is labelled `simulated`.

## Architecture

Ports & adapters — `core/` depends only on `ports/`, never on a concrete adapter. Mock adapters
(deterministic, credential-free) satisfy the ports in tests and local dev; the real Casper/Odra
adapter lands behind the **same** contract tests. The composition root (`src/lib/container.ts`) is
the only place that picks adapters.

```
src/
  config/network.ts     Testnet/Mainnet config — the one place network values live
  core/                 Domain types, catalogue, pure parimutuel odds + payouts (no framework deps)
  ports/                Interfaces: CasperChain, Payment (x402), Oracle, Llm, MarketStore
  adapters/mock/        Deterministic mock adapters
  adapters/casper/      Real chain adapter (casper-js-sdk, server-only) + live chain signals
  agent/                Genesis, the Prophet fleet, the Arbiter, the typed SDK
  lib/container.ts      Composition root
  components/           Network toggle/context, header, market card, on-chain proof section
  app/                  Landing (/), markets, agents, docs + the API (REST, x402 rail, MCP)
contracts/              Odra/Rust: MarketFactory, ParimutuelMarket, OracleRegistry + deploy CLI
packages/sdk/           The publishable agent SDK (npm: hunch-casper-sdk)
```

## Getting started

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

Green gate (matches CI):

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

## Deploy (ops)

1. Import this repo as a **new Vercel project** (separate from the main Hunch project).
2. Attach the custom domain **`casper.playhunch.xyz`** (TXT-verify if `playhunch.xyz` DNS lives on
   a different Vercel team). No change to the main Hunch repo.
3. Set the `NEXT_PUBLIC_*` env vars in `.env.example` once contracts are deployed.
4. Optional: set the Upstash/Vercel KV env vars so bets and boards persist across serverless
   instances (unset → in-memory demo state with the cold-start seed). A GitHub Actions workflow
   ticks the economy every 10 minutes, 24/7 (the Vercel Hobby cron stays daily).

## Status

**S3–S29 shipped — the self-running economy and the open agent economy are live.** A 19-market
catalogue (incl. Casper-native public-good feeds) across five categories; autonomous agent roles
(Genesis market-maker, four Prophet bettors, the Arbiter oracle with on-chain reputation, and the
Odra Vault); the **x402 + MCP** public agent rail; a permissionless **AgentRegistry** + League;
distribution (chat bots, embeds, narrated alerts); human NL market creation with hashed resolution
recipes; **verifiable resolution** (recipe + evidence hashes, replay harness); **optimistic
resolution** with staked disputes; **oracle-as-a-service** (metered query API + settlement hooks);
**probability feeds** with calibration exports; **LMSR** continuous liquidity + LP vaults;
**copy-betting**; and the **Testnet ⇄ Mainnet** toggle end-to-end. 1113 TS tests + 95 OdraVM
contract tests, green gate each sprint (`typecheck / lint / test / build`), GitHub CI green.
Remaining to fully launch is credential-gated ops (mint the real testnet tx, wire addresses,
register the bots, fund the audit/bounty/mainnet deploy) + the submission pack — see
[`VISION.md`](./VISION.md) for what comes after the hackathon.

## Community & contributing

- **Contributing:** [`CONTRIBUTING.md`](./CONTRIBUTING.md) — dev setup, the green gate, and the
  ports-&-adapters rules. Bug reports and feature requests use the issue templates.
- **Security:** [`SECURITY.md`](./SECURITY.md) — report vulnerabilities privately (do not open a
  public issue). Dependabot, CodeQL, and private vulnerability reporting are enabled.
- **Code of conduct:** [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) — Contributor Covenant.
- **Casper Developers (Telegram):** <https://t.me/CSPRDevelopers>
- **Casper Network (Discord):** <https://discord.com/invite/caspernetwork>

## License

[MIT](./LICENSE) © 2026 Raj Karia.
