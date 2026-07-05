---
feature: submission-hardening
globs:
  - src/**
  - docs/**
  - packages/**
  - .github/**
  - contracts/DEPLOY.md
updated: 2026-07-05
---

# S14 — best-on-casper hardening (judge-review fix pass)

_Detailed sprint-by-sprint history lives in [`docs/STATUS.md`](../STATUS.md) — this doc is the
fast resume point for the submission push._

## Current state — what's working, deployed, broken

- **S3–S14 done, gate green**: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` — 573 TS
  tests (38 files) + 22 OdraVM contract tests. Committed as `e0fa11b` on branch
  `claude/gracious-jemison-69e02b` (worktree). **NOT yet merged to `main` / pushed** — that is the
  first next step; the scheduled economy workflow and CI badge only run from the default branch.
- Live site: https://casper.playhunch.xyz (Vercel project `hunch-casper`, mock chain mode) —
  markets/agents/docs all serve; tick + MCP verified live this session.
- **User is running the testnet contract deploy** (contracts/DEPLOY.md) in parallel — code-side
  wiring for it (per-market routing, proof surface, receipts env) is ready and waiting on hashes.
- The one remaining human deliverable is the **demo video** (docs/DEMO_SCRIPT.md, <3 min).

## Recent changes — files touched and why (all in commit `e0fa11b`)

14-item fix pass, executed with 5 parallel subagents + main session:

1. Feed honesty — `simulated` flag on `AgentAction` (src/adapters/mock/activity-log.ts, agent/*,
   demo-seed) + chips in src/components/activity-feed.tsx; fake hashes never link to cspr.live.
2. On-chain proof — src/config/onchain-proof.ts, src/components/onchain-proof-section.tsx
   (landing + /docs#onchain); renders `NEXT_PUBLIC_*` contract hashes + `NEXT_PUBLIC_ONCHAIN_RECEIPTS`
   (JSON `[{label,hash,network}]`) as real explorer links; hidden until env wired.
3. Per-market routing — `parseMarketAddresses` (src/config/network.ts), `resolveMarketContract`
   (src/adapters/casper/deploy-plan.ts), real-chain + container wiring; env
   `NEXT_PUBLIC_*_MARKET_ADDRS` (slug→package hash), vault fallback.
4. Live Genesis signals — src/adapters/casper/chain-signals.ts (CSPR.cloud validators with
   `CSPR_CLOUD_API_KEY` → keyless node-RPC block height → deterministic rotation);
   `GenesisTrigger.sourceLabel` keeps provenance honest; `CASPER_LIVE_SIGNALS=false` forces rotation.
5. Real x402 — src/adapters/casper/real-payment.ts verifies proofs against actual on-chain CSPR
   transfers (TxV1 + legacy Deploy shapes, pure `verifyTransferResult`); enabled in real mode by
   `CASPER_X402_PAYTO` (treasury account); `CASPER_REAL_AGENT_X402=true` stays as weaker opt-in;
   gate logic in src/lib/agent-bet.ts; AGENTS.md invariant updated.
6. Claims audit — honest CSPR.click copy (mock wallet + demo pill) in README, landing PRIMITIVES,
   VISION roadmap; README "What's real vs simulated" table.
7. 24/7 ticks — .github/workflows/economy.yml (cron */10, repo var `ECONOMY_BASE_URL`, optional
   secret `CRON_SECRET`, default-branch only).
8. KV persistence — src/adapters/persist/{economy-state,economy-persist-hook}.ts; env-gated
   (`KV_REST_API_URL/TOKEN` or `UPSTASH_REDIS_REST_URL/TOKEN`); hydrate-before-read in
   mock-market-store + activity/leaderboard/tick routes; export/import pairs on all four state
   modules; hydration calls `markDemoSeeded()` so the seed never double-applies; last-write-wins.
9. Abuse guards — src/lib/abuse-guards.ts; Genesis cap (`GENESIS_MAX_CREATED`, default 12) + 20s
   cooldown → 409/429; off under test unless `ABUSE_GUARDS=on`.
10. API DX — /api/markets and /api/markets/[slug] default to `DEFAULT_NETWORK` when `?network=`
    missing; invalid values still 400.
11. README — CI badge + docs/assets/screenshot.png (real /agents capture via headless Chrome).
12. MCP recipe — `claude mcp add --transport http hunch-casper https://casper.playhunch.xyz/api/mcp`
    in /docs mcp section + README "Connect your agent in 60 seconds".
13. SDK package — packages/sdk (npm `hunch-casper-sdk`) compiles src/agent/sdk.ts verbatim (imports
    rewritten `@/`→relative; NodeNext/CJS); `pnpm sdk:build`; workspace added to pnpm-workspace.yaml.
14. Submission pack — docs/SUBMISSION.md (paste-ready description, judge quickstart, checklist);
    cross-links from README + DEMO_SCRIPT.

## Key decisions — choices and trade-offs

- **Judged surface stays in MOCK chain mode.** Real mode would kill the demo (seed off → empty
  boards; swarm triggers 401 cron-gated; slow operator-funded txs). On-chain reality is proven via
  the receipts/proof surface instead — real explorer links, honestly separated from the simulated
  demo economy. Do NOT set `CASPER_CHAIN_MODE=real` on the public Vercel deploy.
- **Two-path x402 real-mode gate**: `CASPER_X402_PAYTO` (trustless transfer verification) OR
  `CASPER_REAL_AGENT_X402=true` (explicit trust-me opt-in); fail-closed otherwise. Internal Prophet
  fleet keeps fabricated mock proofs — in real+real-payment mode they correctly fail verify
  (documented; fleet is a mock-mode demo device).
- **Persistence is a snapshot/hydrate layer, not a DB**: whole-economy JSON envelope keyed
  `hunch:economy:v1`, debounced writes, last-write-wins; hook registry avoids import cycles.
- **SDK package compiles app source directly** (no fork/drift); publish from packages/sdk.
- Genesis creations are always `simulated: true` (no MarketFactory tx at runtime yet).

## Next steps — specific, actionable

1. **Merge `claude/gracious-jemison-69e02b` → `main` and push** (enables CI badge + 10-min economy
   workflow). Optionally set repo variable `ECONOMY_BASE_URL` and secret `CRON_SECRET` (only needed
   in real mode).
2. **After the testnet deploy finishes** (user is running it): in Vercel env set
   `NEXT_PUBLIC_TESTNET_MARKET_FACTORY/_ORACLE_REGISTRY/_VAULT`, `NEXT_PUBLIC_TESTNET_MARKET_ADDRS`
   (slug→hash JSON; slugs from `/api/deploy-plan?network=testnet`), and
   `NEXT_PUBLIC_ONCHAIN_RECEIPTS` (real bet/resolve tx hashes) → redeploy → "Live on Casper"
   section appears. Keep `CASPER_CHAIN_MODE=mock` on the public deploy.
3. Optional hardening: Upstash Redis env pair (persistent boards), `CSPR_CLOUD_API_KEY` (live
   validator signal), `npm publish --access public` from packages/sdk.
4. **Record + upload the demo video** (docs/DEMO_SCRIPT.md), paste link into README Demo section,
   docs/SUBMISSION.md, and the submission form; finish SUBMISSION.md checklist.
5. Nice-to-have if time: real CSPR.click widget integration (first VISION roadmap item).
