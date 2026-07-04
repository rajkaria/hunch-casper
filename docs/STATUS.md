# Status — Hunch on Casper

_Resume point for the next session. Full plan: [`BUILD_SPEC.md`](./BUILD_SPEC.md)._

**Updated:** 2026-07-04

## Live
- **Repo:** https://github.com/rajkaria/hunch-casper (public, `main`)
- **Deploy:** https://hunch-casper.vercel.app (Vercel prod, public 200) — Vercel team `rajkaria67-1831s-projects`, project `hunch-casper`
- **Domain:** `casper.playhunch.xyz` **not yet attached** — user will connect the domain in the Vercel dashboard (TXT-verify if `playhunch.xyz` DNS is on a different Vercel team). No main-Hunch-repo change needed.

## Current state — S1 (Contracts v1) DONE, green

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
- `src/lib/container.ts` — composition root
- `src/components/{network-context,network-toggle,site-header,mainnet-banner,market-card}.tsx`
- `src/app/{page,markets,agents,docs}` — pages
- `test/*` — 20 tests · `.github/workflows/ci.yml` — CI gate (TS `gate` + Rust `contracts` jobs)
- **`contracts/`** — Odra/Rust on-chain layer:
  - `src/{market_factory,parimutuel_market}.rs` — the two contracts + 15 OdraVM tests
  - `bin/cli.rs` — odra-cli livenet deploy driver · `Odra.toml` — contract registrations
  - `DEPLOY.md` — deploy runbook · `.env.example` — livenet env template
  - `wasm/*.wasm` — built artifacts (gitignored; `cargo odra build` regenerates)

## Next steps
1. **Ops (user):** attach `casper.playhunch.xyz` in Vercel dashboard.
2. **S1 tail — mint the real testnet tx (credential-gated, ~10 min).** `contracts/DEPLOY.md`: generate a key (`casper-client keygen`), fund it at the faucet, `cargo run --bin contracts_cli -- deploy` (deploys factory + sample market + registers = 3 real txs), then set `NEXT_PUBLIC_TESTNET_MARKET_FACTORY` / `_VAULT` in Vercel + `.env.local`. This closes the S1 "one real transaction" qualifier requirement. (Everything else in S1 — contracts, 15 tests, optimized wasm, deploy script, CI — is DONE + green.)
3. **S2 — thin slice:** real `CasperChainPort` adapter (`@mysten`-style, behind the port, kept out of the client bundle via `container.ts`) reading the deployed addresses → contract tests → one real bet + one resolution end-to-end from the UI. That completes the **qualifier** (submit by Jul 7).
   - Remaining Day-1 de-risking to confirm during S2: Casper native **x402** live on testnet (else HTTP-402 + CSPR-proof fallback); **CSPR.click agent skill** programmatic wallet/sign; **CSPR.cloud** endpoints + rate limits; **drand** for the flip.

## Key decisions
- Subdomain (`casper.playhunch.xyz`) via separate Vercel project + repo — NOT a `/casper` path (a path would require rewriting the main Hunch app). Zero main-repo risk.
- Full 15+ catalogue will run on BOTH testnet and mainnet (same code, toggle). Mainnet keeps bet caps + unaudited disclosure as the only guardrail around fresh Rust holding real value.
- Differentiator: a closed multi-agent economy (Genesis creates, Prophets bet via x402, Arbiter resolves with staked on-chain reputation) + meta-markets (agents betting on agents). Every Casper primitive load-bearing.
- No env vars required to deploy S0 (network.ts has safe public defaults); real endpoints/contract addresses injected via `NEXT_PUBLIC_*` as S1+ lands them.
