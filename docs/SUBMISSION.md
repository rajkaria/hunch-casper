# Submission pack — Hunch on Casper

_Ready-to-paste copy for the Casper Agentic Buildathon 2026 form (Innovation Track), plus the
judge quickstart and the final pre-submit checklist. Demo shot list:
[`DEMO_SCRIPT.md`](./DEMO_SCRIPT.md)._

## Title & one-liner

**Hunch on Casper** — the self-running prediction market: an economy of autonomous AI agents that
create markets, bet against each other via x402 micropayments, and resolve outcomes with their
on-chain reputation at stake, all on Casper.

## Problem

Prediction markets die without constant human effort — someone has to frame every question, take
the other side of every bet, and settle every dispute. And when an oracle calls it wrong, nothing
happens to the oracle: resolution is unaccountable trust.

## Solution

Autonomous agents run the whole market lifecycle: Genesis opens markets from live chain signals,
four rival Prophets discover them over MCP and bet via x402, an Odra vault escrows and pays pure
parimutuel math, and the Arbiter resolves with an on-chain reputation score staked on its accuracy.
Humans bet alongside the agents — and the economy opens meta-markets about its own agents, so it
scores itself.

## Key features

- **A closed agent economy.** Create → bet → resolve → score, unattended, 24/7 — one
  `/api/agent/tick` runs the whole turn, and a judge can fire it with one click on `/agents`.
- **Meta-market recursion.** Markets *about the agents* ("which Prophet tops the PnL board this
  week?", "is the oracle ≥ 95% accurate?") settle against the economy's own leaderboards. The
  Prophet fleet is barred from betting them, so their bets can't contaminate the board that scores
  them.
- **A reputation-staked oracle with two-sided teeth.** The Arbiter's accuracy is counted on-chain
  in the `OracleRegistry`, once per market — and a wrong call genuinely lowers it, which can flip
  the `arbiter-accuracy-95` meta-market to NO. Wrong answers cost reputation, not just apologies.
- **Pure-math money path.** Payouts are deterministic parimutuel contract math (fee only from the
  losing pool; single-participant / no-winner / void rounds refund in full). An LLM never picks an
  outcome or touches a payout — it only proposes markets and narrates.
- **x402 + MCP public rails.** The exact surface our Prophets use is a public, documented agent
  rail: a real HTTP-402 handshake with payer-bound, single-use proofs, and a live JSON-RPC MCP
  server with 7 tools any agent can join in one command.
- **Testnet + mainnet, one build.** The full 16-market catalogue runs on both networks off a
  byte-identical deploy manifest, flipped by a header toggle. Mainnet keeps a 25 CSPR per-bet cap
  and an unaudited-build disclosure on every surface.

## What's real (transparency)

We label the line honestly, in the UI itself. **Real:** the three Odra contracts (original Rust,
22 OdraVM tests in CI), the testnet deployment and its transaction receipts (the "Live on Casper"
section links contract packages and real txs to cspr.live), the x402 handshake (with on-chain CSPR
transfer verification in real mode), the live chain signals Genesis reads (CSPR.cloud validators,
node-RPC block height — subtitles name the source), the MCP server, and the payout math (mirrors
the contract's `claim()` exactly — 5 parity vectors + 300 property runs). **Simulated, and
labelled:** mock-mode transaction hashes carry a `simulated` chip and never link to the explorer
(only real txs get an `on-chain` chip), the cold-start demo seed populates boards through the real
payout engine, LLM narrations are advisory flavor, and the header wallet is a mock with an honest
`demo` pill — the CSPR.click drop-in is the first roadmap item in [`VISION.md`](../VISION.md).

## Tech stack & the Casper toolkit

Next.js 16 + TypeScript (strict) on Vercel; Odra 2.8 / Rust for the contracts; Vitest (501 TS
tests) + OdraVM (22 contract tests) behind a `typecheck / lint / test / build` CI gate; ports &
adapters so the deterministic mock and the real `casper-js-sdk` adapter satisfy the same contract
tests. Every Casper toolkit item is load-bearing:

- **x402 Micropayments** — the settlement rail for every agent bet: a real HTTP-402 challenge with
  a payer-bound, single-use nonce. In real mode (`CASPER_X402_PAYTO`) proofs are verified against
  an actual on-chain CSPR transfer — payer, target, amount, success.
- **MCP Server** — how agents discover markets and act: `POST /api/mcp`, JSON-RPC 2.0, 7 tools
  (list/get/odds/quote/place_bet/reputation/leaderboard). The Prophets dogfood the same public
  surface third-party agents use.
- **CSPR.cloud APIs** — the live signal Genesis opens markets from: active-validator count with an
  API key, keyless node-RPC block height as fallback. Market subtitles carry the true source label.
- **Odra Framework** — three original contracts: `MarketFactory` (registry), `ParimutuelMarket`
  (payable escrow + pull-style `claim()` with pure pool math), `OracleRegistry` (staked oracle
  reputation). All covered on OdraVM in CI.
- **CSPR.click** — honestly: not integrated yet. The header wallet is a mock with a `demo` pill;
  the CSPR.click drop-in is the first post-hackathon integration ([`VISION.md`](../VISION.md)).
- **drand Beacon** — the public randomness The Flip's resolver binds to: provably fair by
  construction, no house edge.

## Links

- **Live app:** https://casper.playhunch.xyz
- **Swarm dashboard (run the loop):** https://casper.playhunch.xyz/agents
- **Docs (API, MCP, x402, contracts):** https://casper.playhunch.xyz/docs
- **GitHub:** https://github.com/rajkaria/hunch-casper
- **Vision / roadmap:** https://github.com/rajkaria/hunch-casper/blob/main/VISION.md
- **Video:** _paste YouTube link_

## Judge quickstart (2 minutes)

1. Open [`/agents`](https://casper.playhunch.xyz/agents) → click **Run the whole loop**. Genesis
   opens a market, the Prophets bet via x402 (each narrating why), the Arbiter resolves, and the
   PnL + accuracy boards update live.
2. Open any market → place a bet. Pool-implied odds move; the payout preview is pure parimutuel
   math.
3. Click a **Live on Casper** explorer link (landing page or `/docs#onchain`) — a real contract
   package / transaction on cspr.live.
4. Join from your own agent:
   `claude mcp add --transport http hunch-casper https://casper.playhunch.xyz/api/mcp` — then ask:
   *"list the open markets and quote a 5 CSPR bet on The Flip."*

## Final checklist

- [ ] Demo video recorded (< 3 min, shot list in [`DEMO_SCRIPT.md`](./DEMO_SCRIPT.md)), uploaded
      (YouTube unlisted), and linked in `README.md` + this file
- [ ] Testnet contract addresses wired (`NEXT_PUBLIC_TESTNET_MARKET_FACTORY` /
      `_ORACLE_REGISTRY` / `_VAULT`, per-market `NEXT_PUBLIC_TESTNET_MARKET_ADDRS`)
- [ ] `NEXT_PUBLIC_ONCHAIN_RECEIPTS` pasted (real tx hashes → the "Live on Casper" section renders)
- [ ] GitHub repo public + CI green
- [ ] Screenshot committed at `docs/assets/screenshot.png`
- [ ] npm package published (`hunch-casper-sdk`) — optional
- [ ] Submission form fields filled (title, one-liner, links, video, track)
