# Hunch on Casper — Build Spec & Sprint Plan
### Casper Agentic Buildathon 2026 · Casper Innovation Track

> **One-liner:** The first *self-running* prediction market — an economy of autonomous AI
> agents that create markets, bet against each other via x402 micropayments, and resolve
> outcomes with their on-chain reputation at stake — all on Casper. Humans can bet
> alongside the agents through a swipe UI.

**Deploy target:** `casper.playhunch.xyz` (standalone public repo, own Vercel project, own worktree — zero commits to the main Hunch repo).
**Networks:** Casper **Testnet** (judged surface + 24/7 agent economy) **and Mainnet** (full catalogue, same code, network toggle in header).
**Status of this doc:** Phase 3 (Spec) + Phase 4 (Plan) of the hackathon workflow.

---

## 1. Why this wins

### 1.1 The gap nobody else fills
The brief hands every team four "example directions" (yield agent, RWA oracle, DAO swarm, KYC agent). **80% of submissions will be one of those four, built as a single agent doing a single thing.** The gap: nobody builds a **closed multi-agent economy where every Casper primitive is load-bearing and the agents genuinely need each other.**

A prediction market is the perfect vehicle for exactly that:

| Casper AI Toolkit component | How it's load-bearing here (not a checkbox) |
|---|---|
| **x402 Micropayments** | Every bet an agent places is an HTTP-402 payment with a Casper payment proof. x402 is the **settlement rail for the whole economy**, not a bolt-on. |
| **MCP Servers** | How the bettor agents (and any external Casper agent) **discover markets, get odds, and place bets**. Our MCP server is the economy's public interface. |
| **CSPR.click AI Agent Skill** | Wallet creation + transaction signing for every agent *and* human bettors. |
| **CSPR.cloud APIs** | Real chain-data feeds powering the market-creator and oracle agents (price, deploys, validators, staking). |
| **Odra Framework** | Every contract — market factory, parimutuel vault, oracle reputation registry — is Odra/Rust. |
| **Casper Manifest** ("trust layer for the agent economy") | Literally our thesis restated: agents transacting trustlessly, reputation on-chain. |

Every single toolkit item is used because the product *needs* it. That is the sponsor-integration and technical-execution score locked in.

### 1.2 The "why didn't I think of that" moment
**Meta-markets: agents betting on agents.** The bettor agents ("Prophets") each run a distinct strategy (Momentum, Contrarian, Value, Chaos). We open markets *about the agents themselves* — "Which Prophet tops the PnL board this week?", "Will Momentum beat Contrarian?", "Is the oracle's accuracy ≥ 95% this week?" — and the Prophets can bet on *those* too. The economy becomes recursive and self-referential. No other team will show judges an economy that runs, reasons about itself, and never sleeps.

### 1.3 The demo that closes it
A live dashboard where you watch **Genesis** open markets, the **Prophets** bet against each other (each narrating *why* via an LLM), and **Arbiter** resolve them — in real time, every action a real Casper transaction with an explorer link. One team demos a bot. We demo an economy.

### 1.4 The unfair advantages
- **"Long-Term Launch Plans" is a scored criterion.** Hunch is a live product (Base mainnet, Sui mainnet, real users, real revenue). No fresh team can compete on this axis. We arrive with socials, a track record, and a real deployment plan.
- **Community-vote path** (top 3 by CSPR.fans skip judging). We have distribution to mobilize; most teams have none.
- **Mainnet deployment** of the full catalogue is a disproportionately strong "we actually shipped" signal.

### 1.5 RWA thesis (hits the DeFi + RWA emphasis)
**Arbiter** — the oracle agent — carries an on-chain identity and a reputation score updated on every resolution. Because a wrong resolution costs bettors real money, its reputation has **economic teeth**. That is precisely Casper's example direction #2 ("RWA oracle with verifiable on-chain reputation"), applied to the one use case where oracle reputation actually matters. We surface it on RWA markets (T-bill yield, gold, stablecoin supply) so the RWA framing is explicit.

---

## 2. The agents (the swarm)

| Agent | Role | Casper tech it leans on | LLM use (advisory only — never in the money path) |
|---|---|---|---|
| **Genesis** | Watches CSPR.cloud + external feeds; autonomously opens markets on schedule/threshold | CSPR.cloud reads → Odra `MarketFactory` deploy | Proposes market ideas + framing copy |
| **Prophets** (fleet of N) | Bettor agents, each a distinct strategy (Momentum / Contrarian / Value / Chaos). Own wallets. Discover markets via MCP, bet via x402 | MCP + x402 + CSPR.click signing | Narrates *why* it's taking each bet (great demo, pure flavor) |
| **Arbiter** | Resolves markets from off-chain data; posts resolution on-chain; reputation score updated by outcome accuracy | CSPR.cloud/oracle reads → Odra `OracleRegistry` + `ParimutuelMarket.resolve` | Writes a plain-English resolution rationale |
| **Vault** (contract, not an LLM) | Holds stakes, computes parimutuel payouts, settles | Odra `ParimutuelVault` | — none; **pure contract math is the payout authority** |

**Hard rule (ported from Hunch):** *Never trust LLM output into a money path.* Payout authority is pure, deterministic contract math. LLMs only propose, narrate, and summarize.

---

## 3. Markets (15+ catalogue, config-driven)

Each market is **one config object** (reusing Hunch's "one-const" philosophy) → a generator scaffolds its on-chain deploy + off-chain cache + resolver binding. Adding a market is trivial; that scalability is itself a judge-facing story.

**Casper-native (read via CSPR.cloud / node API):**
1. `cspr-price-ladder` — CSPR ≥ $X by date
2. `cspr-mcap-milestone` — CSPR market cap ≥ $X by date
3. `cspr-hourly-updown` — recurring hourly UP/DOWN round (24/7 fuel for the Prophets)
4. `casper-daily-deploys` — daily deploy count ≥ N
5. `casper-validators` — active validator count ≥ N
6. `cspr-staking-apy` — network staking APY ≥ X%
7. `cspr-total-staked` — total CSPR staked ≥ milestone

**Provably-fair recurring:**
8. `coin-flip-5m` — 5-minute Heads/Tails/Tie via a public randomness beacon (drand), Arbiter-resolved. The demo's heartbeat.

**RWA / macro (the DeFi+RWA emphasis):**
9. `tbill-yield` — 3-month T-bill yield ≥ X% by date
10. `gold-price` — gold ≥ $Y / oz by date
11. `btc-price` — BTC ≥ $Z by date
12. `eth-price` — ETH ≥ $X by date
13. `stablecoin-supply` — total stablecoin supply ≥ $X

**Meta / agent-performance (the novelty):**
14. `prophet-race-weekly` — which Prophet tops PnL this week (N-way)
15. `momentum-vs-contrarian` — will Momentum out-earn Contrarian this week
16. `arbiter-accuracy` — Arbiter weekly resolution accuracy ≥ 95%

→ Ship 15+; the 16 above give slack. Every one is agent-resolvable and needs no manual intervention.

---

## 4. Architecture

### 4.1 Shape (ports & adapters, reused from Hunch)
- `core/` depends only on `ports/`. Deterministic, credential-free **mock adapters** for tests; the **real Casper adapter** lands behind the same **contract tests** → zero core refactor.
- One **composition root** picks adapters (`src/lib/container.ts`).
- Ports: `CasperChainPort`, `PaymentPort` (x402), `OraclePort`, `LlmClient`, `MarketStorePort`.

### 4.2 Smart contracts (Odra, Rust — the one genuinely new surface)
- `MarketFactory` — deploys/registers markets.
- `ParimutuelMarket` / `ParimutuelVault` — escrows stakes, computes pool-implied odds, settles payouts, single-participant refund, void/refund on flat rounds (all logic ported *in design* from Hunch's `computeMarketPayouts`).
- `OracleRegistry` — oracle identity + reputation score; `resolve()` updates accuracy.
- Randomness for the flip via drand beacon (commit the beacon round on-chain for provable fairness).

### 4.3 Payments — x402
Every bet = an HTTP request carrying an x402 payment. **If Casper-native x402 is live on testnet at build time**, use it directly. **Otherwise**, implement the HTTP-402 handshake against Casper's spec, using a CSPR transfer (deploy hash) as the cryptographic settlement receipt. Either way, x402 is the rail — verified Day 1 (see §8).

### 4.4 MCP server (`/api/mcp`)
Tools: `list_markets`, `get_market`, `get_odds`, `place_bet` (x402-gated), `get_agent_leaderboard`, `get_oracle_reputation`, `resolve_status`. This is how Prophets act *and* how any external Casper agent can join — an open, composable interface, not a private bot.

### 4.5 Frontend (Next.js App Router + Tailwind + shadcn, dark premium theme)
- `casper.playhunch.xyz` → **landing page** (hero, the-swarm explainer, live-economy teaser, CTA).
- `/markets` → **explorer**: all markets, filter by category, live odds, network-aware.
- `/markets/[slug]` → market detail: metric grid, total-betted block, parimutuel odds, human bet panel (CSPR.click connect), agent activity feed, related markets.
- `/agents` → **live agent dashboard**: real-time feed of Genesis/Prophets/Arbiter actions with explorer links + PnL leaderboard + oracle-accuracy board.
- `/docs` → agent integration docs (MCP, x402, SDK quickstart).
- **Network toggle** (header): Testnet ⇄ Mainnet — swaps RPC endpoint, contract addresses, explorer base URL, CSPR.cloud network param. One param, same contracts, two deployments. Persists in URL + localStorage.

### 4.6 Off-chain
Lightweight store (Supabase or SQLite) for market cache, agent action logs, and leaderboards. Chain is source of truth for money; the store is an index for UX + demo speed.

### 4.7 Both-networks safety (per your call to ship the full catalogue on mainnet)
Same code serves both. On **mainnet**, add: (a) a per-bet **cap** (nominal amounts), (b) a persistent **"hackathon build — unaudited contracts"** disclosure banner, (c) mainnet contracts flagged in UI. The Prophet swarm runs continuously on **testnet** (free CSPR); on mainnet it runs a slower, capped cadence. This honors "all markets on mainnet" without turning fresh, unaudited Rust into a real-money hazard.

---

## 5. Tech stack
- **Contracts:** Odra (Rust) on Casper Testnet + Mainnet.
- **Frontend/Backend:** Next.js (App Router) on Vercel; Tailwind + shadcn/ui; dark theme.
- **Wallet:** CSPR.click (humans) + CSPR.click AI Agent Skill (agents).
- **Chain data:** CSPR.cloud (REST/Streaming/Node API).
- **Payments:** x402 (native if live; else HTTP-402 + CSPR proof).
- **Agents:** Node workers / Vercel crons; `LlmClient` port (model via provider string).
- **Store:** Supabase or SQLite (index only).
- **CI:** GitHub Actions — typecheck + lint + test + contract tests + build on every push.

---

## 6. Green gate (per sprint, ported discipline)
`typecheck && lint && test && build` + **contract tests** for the Casper adapter must be green before commit/tag/push. Mock-first so the suite runs credential-free in CI.

---

## 7. Sprint plan

Two-phase hackathon → sprints map to it. **Qualifier (by Jul 7)** needs only a working testnet prototype with a real on-chain tx. **Finals (Jul 13–26)** is the full economy. Everything after S2 is finals-grade; S0–S2 is the qualifier.

### Phase 0 — Foundation → **Qualifier**
| Sprint | Goal | Key deliverables | Gate |
|---|---|---|---|
| **S0** | Repo + rails | Standalone repo, Next scaffold, CI, deploy skeleton live at `casper.playhunch.xyz`, network-config module (testnet/mainnet endpoints + explorer bases), ports & mock adapters, `container.ts` | green + site 200s |
| **S1** | Contracts v1 on testnet | Odra `MarketFactory` + `ParimutuelMarket`, deployed to testnet, **one real transaction** produced + explorer link | contracts deploy; 1 real tx |
| **S2** | End-to-end thin slice | Casper adapter + contract tests; **place one real bet** and **resolve one market** end-to-end from the UI | green; qualifier-complete → **submit repo + video Jul 7** |

### Phase 1 — Core product
| Sprint | Goal | Key deliverables | Gate |
|---|---|---|---|
| **S3** | Catalogue engine | Config-driven market definitions + generator; all 15+ market configs authored | green |
| **S4** | Explorer + detail + human betting | `/markets`, `/markets/[slug]`, CSPR.click connect, live odds, total-betted block, related markets | green; UI verified |
| **S5** | Payout engine | Pure parimutuel payouts in `core/` (pool-implied odds, single-participant refund, flat-round void) + on-chain settlement wiring | green; property + contract tests |
| **S6** | Oracle + reputation | `OracleRegistry` contract (identity + reputation), resolution flow, accuracy accounting | green |

### Phase 2 — Agent economy (the differentiator)
| Sprint | Goal | Key deliverables | Gate |
|---|---|---|---|
| **S7** | x402 + MCP | x402 payment layer (native or HTTP-402+proof); MCP server with discover/quote/bet/leaderboard/reputation tools | green; live x402 bet |
| **S8** | Agent SDK + Genesis | Agent SDK; **Genesis** autonomously creating markets from CSPR.cloud triggers | green; autonomous market appears |
| **S9** | Prophet fleet | N bettor agents w/ strategies (Momentum/Contrarian/Value/Chaos), wallets, betting via x402/MCP, LLM narration | green; agents betting live |
| **S10** | Arbiter + meta-markets + boards | **Arbiter** resolving + reputation updates; agent PnL + oracle-accuracy leaderboards; meta-markets (Prophet race, momentum-vs-contrarian, arbiter-accuracy) | green; full loop runs unattended |

### Phase 3 — Both networks + polish
| Sprint | Goal | Key deliverables | Gate |
|---|---|---|---|
| **S11** | Mainnet | Deploy all contracts + full catalogue to **mainnet**; wire network toggle end-to-end; mainnet caps + disclosure banner | green; toggle flips both networks live |
| **S12** | Landing + dashboard + polish | Landing page, live `/agents` dashboard, `/docs`, branding/logo/favicon, mobile responsive, loading/error states | green; Lighthouse + mobile pass |

### Phase 4 — Ship
| Sprint | Goal | Key deliverables | Gate |
|---|---|---|---|
| **S13** | Judge loop | Simulated 5→7→9 judge panels; fix every issue to 8.5+ | panel ≥ 8.5 |
| **S14** | Submit | Demo video (<3 min, scripted), `VISION.md`, `README`, submission description, CSPR.fans listing + vote mobilization | submitted |

---

## 8. De-risking — verify Day 1 (before S1)
1. **Casper x402 status** — is native x402 live/usable on testnet now? If not, confirm the HTTP-402 + CSPR-proof fallback plan.
2. **Odra tooling** — local build/test/deploy loop working; a known-good template as base.
3. **CSPR.click AI Agent Skill** — can it programmatically create wallets + sign for the agent swarm?
4. **CSPR.cloud** — endpoints + rate limits for price, deploys, validators, staking.
5. **Randomness** — drand beacon usable for the coin flip's provable fairness (or commit-reveal fallback).
6. **DNS** — attach `casper.playhunch.xyz` to the new Vercel project (TXT-verify if a different Vercel team). No main-repo change.

---

## 9. Product vision (the separator — becomes `VISION.md`)
- **Hackathon scope:** a live self-running agent prediction market on Casper testnet + mainnet, 15+ markets, four agent roles, x402 + MCP + Odra + CSPR.cloud all load-bearing.
- **Month 1–6:** open the MCP interface so *third-party* Casper agents join the economy; grow the Arbiter into a reputation-staked RWA oracle other protocols can query; expand RWA market coverage.
- **Fold-back:** if it wins, integrate into the main Hunch product as a `HUNCH_CASPER_RAIL` behind a flag — additive, prod byte-identical (same playbook as the Sui and Arbitrum rails).
- **Revenue:** parimutuel fee on settled volume (same model as live Hunch); agent API usage via x402.
- **The ask:** x402 ecosystem credits + Casper grant/incubation to run the mainnet economy past the hackathon.

---

## 10. Submission checklist (Casper-specific)
- [ ] Public GitHub repo, README (one-liner + screenshot + architecture + "all Casper code newly written for this buildathon").
- [ ] Working prototype on **Casper Testnet** with transaction-producing on-chain component (the hard requirement).
- [ ] Live at `casper.playhunch.xyz`, network toggle working, mobile-tested.
- [ ] Demo video < 3 min (scripted, shows the live economy + explorer links).
- [ ] `VISION.md` linked from README.
- [ ] CSPR.fans listing for the community-vote path.
- [ ] Transparency line: exists on other chains; **all Casper code original to this buildathon**.
