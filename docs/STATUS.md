# Status — Hunch on Casper

_Resume point for the next session. Full plan: [`BUILD_SPEC.md`](./BUILD_SPEC.md)._

**Updated:** 2026-07-05

## Live
- **Repo:** https://github.com/rajkaria/hunch-casper (public, `main`)
- **Deploy:** https://hunch-casper.vercel.app (Vercel prod, public 200) — Vercel team `rajkaria67-1831s-projects`, project `hunch-casper`
- **Domain:** `casper.playhunch.xyz` **attached on Vercel** (2026-07-05). No main-Hunch-repo change needed.

## Current state — S3–S11 DONE + green (Phase 1 core + Phase 2 agent economy + Phase 3 mainnet, loop closed)

**S3–S11 shipped** (tags `s3`…`s11`; 493 TS tests + 22 OdraVM tests; gate
`typecheck && lint && test && build` green each sprint; every sprint adversarially reviewed
before commit and money-path findings fixed).

- **S3 — Catalogue engine.** `MarketDefinition` enriched with a declarative `resolver` binding
  (kind/source/metric/target/comparator), `feeBps`, `cadence`; full 16-market catalogue across
  all 4 categories. `core/market-generator.ts` = the on-chain half (one config → `init` +
  `register_market` args) that doubles as the config validator (rejects bad fee/outcomes/deadline/
  seed-pool offline).
- **S4 — Explorer + detail + human betting.** Store-backed read model (`/api/markets[/slug]`) via
  a client hook; mock CSPR.click wallet connect behind an SSR-safe store (fixed an infinite-loop
  getSnapshot bug from review); pure `related-markets` + full-width section; bet panel carries the
  connected account.
- **S5 — Payout engine.** `core/market-payout.ts` reproduces the vault's claim() algorithm
  exactly (5 parity vectors + 300 property runs). Mutable in-process settlement ledger (bets → live
  pools; resolve → settle). Review fixes: house-liquidity model (seed = real staker escrowed
  on-chain via `MarketDeployPlan.seedBets`), orphaned-settlement guard (`indexed:false`), deadline
  lock, idempotent resolve.
- **S6 — Oracle + reputation.** Odra `OracleRegistry` (identity + `accuracy_bps`, admin-gated,
  once-per-market; 6 OdraVM tests). Off-chain mirror + reputation ledger (Arbiter seeded 123/128 ≈
  96.09%); resolve records accuracy; `GET /api/oracle/[id]` + `<OracleReputation>` on detail +
  /agents.
- **S7 — x402 + MCP.** REST x402 rail `POST /api/agent/v1/bet` (HTTP-402 handshake) + MCP server
  `POST /api/mcp` (JSON-RPC: list/get/odds/quote_bet/place_bet/reputation/leaderboard), sharing
  `lib/agent-bet.ts`. **Hardened per review:** payer-bound + single-use proofs (replay keyed on
  the payment deployHash), agent-rail mainnet cap, REST/MCP network parity, MCP envelope guard.
- **S8 — Agent SDK + Genesis.** `market-source` unifies static + Genesis-created markets. Genesis
  (`POST /api/agent/genesis/run`) autonomously opens markets from CSPR.cloud-style signals
  (LLM-framed, generator-validated). Typed `HunchCasperClient` SDK (injectable transport) runs the
  full x402 exchange.
- **S9 — Prophet fleet.** Four pure strategies (Momentum/Contrarian/Value/Chaos) → live agents that
  read odds, narrate (LLM, advisory), and bet via x402; `POST /api/agent/prophets/run` sends the
  fleet at one market per round (visible rivalry); activity feed (`/api/agent/activity`) +
  live `/agents` dashboard.
- **S10 — Arbiter + meta-markets + boards (the loop closes).** The economy now runs itself and
  scores itself:
  - **Autonomous Arbiter** (`src/agent/arbiter.ts`): `resolveMarket(slug)` reads the deciding datum,
    posts the winner on-chain, settles via the pure engine, and updates its on-chain reputation.
    `runArbiterSweep` resolves every *matured* (past-deadline) market unattended; explicit-by-slug
    resolution is the operator/demo weekly-close (gated by `ARBITER_CRON_SECRET` in real mode).
    `POST /api/agent/arbiter/run` (sweep, or `{slug}`).
  - **Boards, from money-path numbers:** pure `core/agent-leaderboard.ts` folds settled markets'
    stakes + payout manifests into per-agent realized PnL/ROI/W-L (house + humans excluded);
    `core/meta-resolution.ts` resolves the meta-markets against them. `GET /api/agent/leaderboard`
    (agent PnL + oracle accuracy) + `<AgentLeaderboard>` on `/agents`; MCP `get_leaderboard` now
    returns the real boards; new port methods `MarketStorePort.settledEntries` + `OraclePort.leaderboard`.
  - **The recursion:** `prophet-race-weekly` settles to the board's top Prophet;
    `momentum-vs-contrarian-weekly` to whichever out-earned; `arbiter-accuracy-95` to the Arbiter's
    live accuracy (seeded ≥95 → YES). Proven end-to-end in `test/economy-loop.test.ts`.
  - **Unattended full loop:** `runEconomyTick` (Prophets bet → Arbiter sweeps → boards snapshot) via
    `/api/agent/tick` (GET = Vercel cron, POST = demo w/ `resolveSlugs` weekly close). `vercel.json`
    cron is a **Hobby-safe daily** schedule; the live demo cadence is driven by the plan-independent
    `scripts/economy-loop.mjs` (POSTs the tick on an interval). Tighten the cron to `*/5 * * * *`
    on Pro.

- **S11 — Mainnet (Phase 3).** Same code, same contracts, second network — the toggle now flips
  both networks live off one build:
  - **Mainnet caps enforced on *every* surface.** The 25-CSPR per-bet cap is now a single shared
    rule (`exceedsBetCap`/`maxBetCspr` in `src/config/network.ts`) used by the human bet route, the
    agent x402 rail (`lib/agent-bet.ts`), **and** the trade panel — which surfaces the cap and
    blocks over-cap stakes client-side (previously only a server 400). The unaudited-build banner
    stays on mainnet.
  - **Full-catalogue deploy manifest** (`core/deploy-manifest.ts` + `GET /api/deploy-plan?network=`):
    the credential-free, address-free description of everything a network needs on-chain — both
    singleton infra contracts (`MarketFactory` + `OracleRegistry`) + one `ParimutuelMarket` per
    catalogue market (init/register args + house seed liquidity). The market plans are **byte-identical
    across networks** (proven in `test/deploy-manifest.test.ts`) — the "same contracts, both networks"
    identity behind the toggle. The catalogue stays the single source of truth for on-chain state; the
    mainnet deploy is driven from this manifest.
  - **Deploy CLI now stands up all THREE contracts.** `contracts/bin/cli.rs` deploys
    `MarketFactory` + `OracleRegistry` (registering the deployer as the on-chain "Arbiter" oracle) +
    the sample market (was factory + market only). Idempotent (`is_registered` guard, matches
    `load_or_deploy`).
  - **Mainnet runbook** (`contracts/DEPLOY.md` §6): fund a real-CSPR key → bootstrap singletons →
    deploy the full catalogue from the manifest → wire `NEXT_PUBLIC_MAINNET_*` → optional
    `NEXT_PUBLIC_DEFAULT_NETWORK=mainnet`. Caps + banner stay on. Fixed the stale `/deploy/<hash>`
    explorer path → Casper-2.0 `/transaction/<hash>`; added `OracleRegistry` to the contract table.

**Next: S12 — landing + dashboard + polish.** Landing page, live `/agents` dashboard, `/docs`,
branding/logo/favicon, mobile responsive, loading/error states. Then S13–S14 judge loop + submit.

**⚠️ S11 tail (credential-gated, human/ops):** the *actual* mainnet contract deploy needs a
mainnet key funded with **real CSPR** — run `contracts/DEPLOY.md` §6, then set the
`NEXT_PUBLIC_MAINNET_*` addresses + `CASPER_CHAIN_MODE=real` in Vercel. All S11 *code* (toggle
wiring, caps on every surface, deploy manifest, all-contracts CLI, runbook) is DONE + green.

## Prior state — S2 (End-to-end thin slice) DONE, green

**S2 (End-to-end thin slice)** — the app can now place a bet and resolve a market end-to-end
through the `CasperChainPort`, mock today and byte-identical when the real Casper adapter is
switched on. All original, all behind the ports.
- **Real `CasperChainPort`** (`src/adapters/casper/real-chain.ts`) — `casper-js-sdk@5.0.12`
  (Casper 2.0 / Condor Transaction model). Signs with an Ed25519 env key, submits via node RPC,
  returns `{deployHash, explorerUrl}`. **Load-bearing finding (verified against Odra 2.8.2
  source):** the payable `bet` CANNOT attach CSPR by a direct call — it must route through
  Odra's `proxy_caller_with_return.wasm` session (5 args: `package_hash`, `entry_point`, inner
  `args` as Bytes, `attached_value`, `amount`==attached_value); a direct call attaches ZERO
  (silent money bug). `resolve` is a direct package-targeting tx, oracle-signed. The proxy wasm
  (exact 2.8.2 build from the odra-casper crate) ships in-repo at
  `src/adapters/casper/resources/` and is traced into the chain routes on Vercel.
- **Pure ABI seam** (`src/adapters/casper/deploy-plan.ts`) — `buildBetPlan`/`buildResolvePlan`
  map inputs → a normalized `CasperCallPlan {targetContract, entryPoint, args, attachedMotes,
  gasMotes, usesProxy}`, NO SDK import. This is the ABI-critical part and it is fully unit-tested
  offline (entry points `bet`/`resolve`, args `outcome`/`winning_outcome`, `usesProxy` invariant,
  attached-vs-gas motes) with **zero key/node**.
- **Shared contract test** (`test/contract/casper-chain.shared.ts`) — one suite both adapters
  satisfy: the mock runs it in full (it can submit); the real adapter runs the credential-free
  subset (network + explorer-URL shape). "Same contract tests, zero core refactor," proven.
- **Composition root seam** (`src/lib/container.ts`) — `CASPER_CHAIN_MODE=real` swaps the chain
  adapter; the SDK is loaded via a **lazy dynamic `import()`** so it never enters the client
  bundle (the Sui-rail discipline). Mock stays default → CI + the demo run credential-free.
- **Thin-slice UI** — `/markets/[slug]` detail page (fixes the previously-dead "Trade →" link)
  with a stat strip, total-betted block, pool-implied odds, and a `<BetPanel>` that POSTs to
  `POST /api/chain/bet` + `/api/chain/resolve`. Runtime-verified: detail renders, bet + resolve
  return tx hashes + explorer links (`simulated:true` on mock), mainnet over-cap → 400, and
  real-mode without keys fails LOUD (`502 CasperConfigError`, never silently mocks).
- **Adversarial review applied (12-agent workflow):** explorer links use the Casper 2.0
  **`/transaction/`** path (not legacy `/deploy/`, confirmed against Casper docs); the resolve
  route is **fail-closed + operator-token-gated in real mode** (open only for the no-value mock
  demo); the payable proxy envelope is a pure `buildBetProxyArgs` seam with an offline test
  asserting the 5 args + `amount===attached_value` + 32-byte hash; real-mode single-custodian
  custody is documented (per-user wallet signing = S4/S7).
- **Green gate:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass; **54 TS
  tests** (was 20). CI `gate` job pulls `casper-js-sdk` via the committed lockfile; `next build`
  stays green (serverExternalPackages).

**S0 (Foundation)** — green gate passes (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`), 20 TS tests, all 5 routes prerendered, runtime smoke 200 on `/ /markets /agents /docs`.

**S1 (Contracts v1 on Odra/Rust)** — the on-chain layer, all original to the buildathon:
- **`contracts/`** is a self-contained Odra 2.8 project (Rust nightly-2026-01-01, cargo-odra 0.1.7).
- **`MarketFactory`** (`contracts/src/market_factory.rs`) — on-chain **registry** of markets (id → question/category/market-address/deadline/resolved), admin-gated, event per registration. Chosen over Odra's `factory=on` (untestable on OdraVM) so it's fully covered by the gate.
- **`ParimutuelMarket`** (`contracts/src/parimutuel_market.rs`) — payable **escrow + settlement vault**. `bet` (payable CSPR), oracle-only `resolve`/`void`, pull-style `claim` with **pure pool math** (fee only from losing pool; single-participant/no-winner/void all refund full gross, no fee). The money path is deterministic contract math — never an LLM.
- **Contract gate green:** `cargo odra test` → **15/15 pass** on OdraVM (two-sided fee split, single-participant refund, no-winner auto-void, explicit void, double-claim guard, oracle gating, deadline/unknown-outcome guards). `cargo odra build` → optimized+stripped Casper wasm (`contracts/wasm/*.wasm`, ~273KB/315KB).
- **CI:** `.github/workflows/ci.yml` gains a `contracts` job (nightly toolchain + cargo-odra + binaryen/wabt → `cargo odra test` + `cargo odra build`).
- **Deploy tooling:** `contracts/bin/cli.rs` (odra-cli livenet driver — deploys factory + sample coin-flip market + registers it = 3 real txs) + **runbook `contracts/DEPLOY.md`** + `contracts/.env.example`.
- **De-risking (BUILD_SPEC §8) resolved:** Odra toolchain builds/tests/deploys locally ✅; Casper wasm compiles ✅; the app's `src/config/network.ts` already reads deployed addresses via `NEXT_PUBLIC_*` (no code change needed to wire real contracts).

**⚠️ The one remaining S1 deliverable is credential-gated (human step):** producing the *real testnet transaction* needs a funded testnet secret key — the faucet (<https://testnet.cspr.live/tools/faucet>) is browser/captcha-gated, so it can't be automated here. Everything up to that point (contracts, tests, optimized wasm, deploy script, runbook) is done and green. Run `contracts/DEPLOY.md` steps 3–5 with a funded key to mint the tx + wire the addresses.

- **Isolation:** fully standalone repo, sibling to `/Users/rajkaria/Projects/hunch`. Zero coupling to / commits in the main Hunch repo. Keep it that way.
- **Ports & adapters:** `core/` depends only on `ports/`. Mock adapters (deterministic, credential-free) behind every port. Composition root `src/lib/container.ts` is the only place adapters are chosen → real Casper/Odra adapter drops in with no core refactor.
- **Network toggle works:** Testnet ⇄ Mainnet, `useSyncExternalStore` (SSR-safe, persisted). All network-specific values live only in `src/config/network.ts` (RPC, CSPR.cloud, cspr.live explorer, chain name, contract addresses, mainnet guardrails: 25-CSPR cap + unaudited banner).
- **Catalogue:** config-driven, 7 seed markets across all 4 categories (casper-native, provably-fair, rwa, meta). One const each; materialised per-network.
- **Pages:** landing (hero + swarm + primitives), `/markets` (network-reactive explorer + category filters + pool-implied odds), `/agents` + `/docs` stubs.

## Key files
- `src/config/network.ts` — network config + toggle source of truth + guardrails (reads deployed contract addresses via `NEXT_PUBLIC_*`)
- `src/core/{types,catalogue,parimutuel-odds}.ts` — domain, config-driven catalogue, pure odds
- `src/ports/*` — CasperChain, Payment (x402), Oracle, Llm, MarketStore interfaces
- `src/adapters/mock/*` — deterministic mocks
- **`src/adapters/casper/*`** (S2) — `deploy-plan.ts` (pure ABI seam), `real-chain.ts`
  (`casper-js-sdk` adapter, server-only via the container's lazy import), `resources/proxy_caller_with_return.wasm`
- `src/config/chain-mode.ts` — `mock`|`real` selector (`CASPER_CHAIN_MODE`)
- `src/lib/container.ts` — composition root (lazy real-chain seam)
- **`src/app/api/chain/{bet,resolve}/route.ts`** (S2) — bet + resolve through the port
- **`src/app/markets/[slug]/page.tsx`** + `src/components/bet-panel.tsx` (S2) — thin-slice detail + trade
- `src/components/{network-context,network-toggle,site-header,mainnet-banner,market-card}.tsx`
- `src/app/{page,markets,agents,docs}` — pages
- `test/*` — **54 tests** (deploy-plan, proxy-args, mock/real chain contract, chain routes, container, catalogue, network, odds) · `.github/workflows/ci.yml` — CI gate (TS `gate` + Rust `contracts` jobs)
- **`contracts/`** — Odra/Rust on-chain layer:
  - `src/{market_factory,parimutuel_market}.rs` — the two contracts + 15 OdraVM tests
  - `bin/cli.rs` — odra-cli livenet deploy driver · `Odra.toml` — contract registrations
  - `DEPLOY.md` — deploy runbook · `.env.example` — livenet env template
  - `wasm/*.wasm` — built artifacts (gitignored; `cargo odra build` regenerates)

## Next steps
1. **Ops (user):** attach `casper.playhunch.xyz` in Vercel dashboard.
2. **S1 tail — mint the real testnet tx (credential-gated, ~10 min).** `contracts/DEPLOY.md`: generate a key (`casper-client keygen`), fund it at the faucet, `cargo run --bin contracts_cli -- deploy` (deploys factory + sample market + registers = 3 real txs), then set `NEXT_PUBLIC_TESTNET_MARKET_FACTORY` / `_VAULT` in Vercel + `.env.local`. This closes the S1 "one real transaction" qualifier requirement. (Everything else in S1 — contracts, 15 tests, optimized wasm, deploy script, CI — is DONE + green.)
3. **S2 code — DONE + green** (real adapter + contract tests + bet/resolve thin slice through the port). **S2 tail = the one real bet + resolution tx (credential-gated).** Once the S1 tail sets `NEXT_PUBLIC_TESTNET_VAULT` to the deployed `ParimutuelMarket` **package** hash, set `CASPER_CHAIN_MODE=real` + `CASPER_BETTOR_KEY` (a funded testnet key) and hit `POST /api/chain/bet` then `/api/chain/resolve` (or use the `/markets/[slug]` panel) to mint the real bet + resolution → **qualifier complete**. Alternatively the Rust `contracts/bin/cli.rs` already drives real txs. ⚠️ Note the S2 real bet path assumes `NEXT_PUBLIC_TESTNET_VAULT` is a *package* hash and the market's on-chain outcome keys equal the catalogue outcome keys.
4. **S3 — catalogue engine:** config-driven market definitions + generator; author all 15+ market configs (BUILD_SPEC §3, §7 S3).
   - Remaining Day-1 de-risking still open: Casper native **x402** live on testnet (else HTTP-402 + CSPR-proof fallback); **CSPR.click agent skill** programmatic wallet/sign; **CSPR.cloud** endpoints + rate limits; **drand** for the flip.

## Key decisions
- Subdomain (`casper.playhunch.xyz`) via separate Vercel project + repo — NOT a `/casper` path (a path would require rewriting the main Hunch app). Zero main-repo risk.
- Full 15+ catalogue will run on BOTH testnet and mainnet (same code, toggle). Mainnet keeps bet caps + unaudited disclosure as the only guardrail around fresh Rust holding real value.
- Differentiator: a closed multi-agent economy (Genesis creates, Prophets bet via x402, Arbiter resolves with staked on-chain reputation) + meta-markets (agents betting on agents). Every Casper primitive load-bearing.
- No env vars required to deploy S0 (network.ts has safe public defaults); real endpoints/contract addresses injected via `NEXT_PUBLIC_*` as S1+ lands them.
