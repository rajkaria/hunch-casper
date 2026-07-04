# Status — Hunch on Casper

_Resume point for the next session. Full plan: [`BUILD_SPEC.md`](./BUILD_SPEC.md)._

**Updated:** 2026-07-04

## Live
- **Repo:** https://github.com/rajkaria/hunch-casper (public, `main`)
- **Deploy:** https://hunch-casper.vercel.app (Vercel prod, public 200) — Vercel team `rajkaria67-1831s-projects`, project `hunch-casper`
- **Domain:** `casper.playhunch.xyz` **not yet attached** — user will connect the domain in the Vercel dashboard (TXT-verify if `playhunch.xyz` DNS is on a different Vercel team). No main-Hunch-repo change needed.

## Current state — S0 (Foundation) DONE, green
Green gate passes (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`), 20 tests, all 5 routes prerendered, runtime smoke 200 on `/ /markets /agents /docs`.

- **Isolation:** fully standalone repo, sibling to `/Users/rajkaria/Projects/hunch`. Zero coupling to / commits in the main Hunch repo. Keep it that way.
- **Ports & adapters:** `core/` depends only on `ports/`. Mock adapters (deterministic, credential-free) behind every port. Composition root `src/lib/container.ts` is the only place adapters are chosen → real Casper/Odra adapter drops in with no core refactor.
- **Network toggle works:** Testnet ⇄ Mainnet, `useSyncExternalStore` (SSR-safe, persisted). All network-specific values live only in `src/config/network.ts` (RPC, CSPR.cloud, cspr.live explorer, chain name, contract addresses, mainnet guardrails: 25-CSPR cap + unaudited banner).
- **Catalogue:** config-driven, 7 seed markets across all 4 categories (casper-native, provably-fair, rwa, meta). One const each; materialised per-network.
- **Pages:** landing (hero + swarm + primitives), `/markets` (network-reactive explorer + category filters + pool-implied odds), `/agents` + `/docs` stubs.

## Key files
- `src/config/network.ts` — network config + toggle source of truth + guardrails
- `src/core/{types,catalogue,parimutuel-odds}.ts` — domain, config-driven catalogue, pure odds
- `src/ports/*` — CasperChain, Payment (x402), Oracle, Llm, MarketStore interfaces
- `src/adapters/mock/*` — deterministic mocks
- `src/lib/container.ts` — composition root
- `src/components/{network-context,network-toggle,site-header,mainnet-banner,market-card}.tsx`
- `src/app/{page,markets,agents,docs}` — pages
- `test/*` — 20 tests · `.github/workflows/ci.yml` — CI gate

## Next steps
1. **Ops (user):** attach `casper.playhunch.xyz` in Vercel dashboard.
2. **S1 — Odra contracts (qualifier-critical).** FIRST do the Day-1 de-risking (BUILD_SPEC §8): confirm Casper native **x402** is live on testnet (else HTTP-402 + CSPR-proof fallback); get the **Odra** local build/deploy loop working; check **CSPR.click agent skill** can create/sign wallets programmatically; confirm **CSPR.cloud** endpoints + rate limits; pick randomness (drand) for the flip. Then: `MarketFactory` + `ParimutuelMarket` in Odra/Rust → deploy to testnet → produce one real tx.
3. **S2 — thin slice:** real Casper adapter behind the ports + contract tests → one real bet + one resolution end-to-end. That completes the **qualifier** (submit by Jul 7).

## Key decisions
- Subdomain (`casper.playhunch.xyz`) via separate Vercel project + repo — NOT a `/casper` path (a path would require rewriting the main Hunch app). Zero main-repo risk.
- Full 15+ catalogue will run on BOTH testnet and mainnet (same code, toggle). Mainnet keeps bet caps + unaudited disclosure as the only guardrail around fresh Rust holding real value.
- Differentiator: a closed multi-agent economy (Genesis creates, Prophets bet via x402, Arbiter resolves with staked on-chain reputation) + meta-markets (agents betting on agents). Every Casper primitive load-bearing.
- No env vars required to deploy S0 (network.ts has safe public defaults); real endpoints/contract addresses injected via `NEXT_PUBLIC_*` as S1+ lands them.
