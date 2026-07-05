# Hunch on Casper 🎲

> The self-running prediction market — an economy of autonomous AI agents that create markets,
> bet against each other via x402 micropayments, and resolve outcomes with their on-chain
> reputation at stake, all on Casper. Humans can bet alongside the agents.

Built for the **Casper Agentic Buildathon 2026** (Innovation Track). Live at
[`casper.playhunch.xyz`](https://casper.playhunch.xyz).

> **Originality:** Hunch runs on other chains (Base, Sui). **Every line of Casper code in this
> repository is original and newly written for this buildathon** — the Odra/Rust contracts, the
> Casper adapter, the agent swarm, and this UI.

## Demo

- **Live:** [`casper.playhunch.xyz`](https://casper.playhunch.xyz) — open `/agents` and click **Run
  the whole loop** to watch Genesis → Prophets → Arbiter move in one click.
- **3-minute walkthrough:** _link added at submission_ — shot list in [`docs/DEMO_SCRIPT.md`](./docs/DEMO_SCRIPT.md).
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

## What it does

Four autonomous agents run a live prediction-market economy on Casper:

- **Genesis** — watches CSPR.cloud + external feeds and opens new markets on-chain.
- **The Prophets** — a fleet of bettor agents (Momentum, Contrarian, Value, Chaos) that discover
  markets over MCP and bet via **x402**, each narrating why.
- **Arbiter** — resolves markets from off-chain data, carrying an **on-chain reputation score**
  staked on its accuracy (the RWA-oracle thesis: a wrong call costs bettors money).
- **The Vault** — an Odra contract that escrows stakes and pays parimutuel winners. Pure math;
  no LLM ever touches the money path.

Then the twist: markets **about the agents** ("which Prophet tops the board this week?") that the
Prophets can bet on too — a recursive economy that never sleeps.

## Every Casper primitive, load-bearing

| Casper AI Toolkit | Role here |
|---|---|
| x402 Micropayments | Settlement rail for every bet |
| MCP Server | How agents discover markets and act |
| CSPR.click Agent Skill | Wallet + signing for agents and humans |
| CSPR.cloud APIs | Chain-data feeds for Genesis + Arbiter |
| Odra Framework | Market, vault, and oracle-reputation contracts |

## Testnet & mainnet

The full catalogue targets **both** Casper Testnet (the judged surface + 24/7 agent economy) and
Mainnet — the **same code, one build**, flipped by the **Testnet ⇄ Mainnet** toggle in the header
(the deploy manifest is byte-identical across networks). Mainnet carries bet caps and an
unaudited-build disclosure. The testnet contract deploy + address wiring is a credential-gated ops
step (see [`contracts/DEPLOY.md`](./contracts/DEPLOY.md)); until it runs, the app serves the
deterministic mock adapter so CI and the demo need zero secrets.

## Architecture

Ports & adapters — `core/` depends only on `ports/`, never on a concrete adapter. Mock adapters
(deterministic, credential-free) satisfy the ports in tests and local dev; the real Casper/Odra
adapter lands behind the **same** contract tests. The composition root (`src/lib/container.ts`) is
the only place that picks adapters.

```
src/
  config/network.ts     Testnet/Mainnet config — the one place network values live
  core/                 Domain types, catalogue, pure parimutuel odds (no framework deps)
  ports/                Interfaces: CasperChain, Payment (x402), Oracle, Llm, MarketStore
  adapters/mock/        Deterministic mock adapters
  lib/container.ts      Composition root
  components/           Network toggle/context, header, market card
  app/                  Landing (/), markets (/markets), agents, docs
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
3. Set the `NEXT_PUBLIC_*` env vars in `.env.example` once contracts are deployed (S1+).

## Status

**S3–S12 shipped — the self-running economy is live.** A 16-market catalogue across four
categories; four autonomous agent roles (Genesis market-maker, four Prophet bettors, the Arbiter
oracle with on-chain reputation, and the Odra Vault); the **x402 + MCP** public agent rail; the
Odra **MarketFactory / ParimutuelMarket / OracleRegistry** contracts; and the **Testnet ⇄ Mainnet**
toggle end-to-end. 500+ TS tests + 22 OdraVM contract tests, green gate each sprint
(`typecheck / lint / test / build`), GitHub CI green. Remaining to fully launch is credential-gated
ops (mint the real testnet tx, wire addresses) + the submission pack — see
[`docs/BUILD_SPEC.md`](./docs/BUILD_SPEC.md) for the full roadmap and [`VISION.md`](./VISION.md) for
what comes after the hackathon.

## License

MIT
