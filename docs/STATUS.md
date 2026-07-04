# Status — Hunch on Casper

_Resume point for the next session. Full plan: [`BUILD_SPEC.md`](./BUILD_SPEC.md)._

**Updated:** 2026-07-05

## Live
- **Repo:** https://github.com/rajkaria/hunch-casper (public, `main`)
- **Deploy:** https://hunch-casper.vercel.app (Vercel prod, public 200) — Vercel team `rajkaria67-1831s-projects`, project `hunch-casper`
- **Domain:** `casper.playhunch.xyz` **not yet attached** — user will connect the domain in the Vercel dashboard (TXT-verify if `playhunch.xyz` DNS is on a different Vercel team). No main-Hunch-repo change needed.

## Current state — S2 (End-to-end thin slice) DONE, green

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
