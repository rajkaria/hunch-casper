<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Hunch on Casper — project instructions

Standalone submission for the **Casper Agentic Buildathon 2026**. A self-running prediction
market run by autonomous agents on Casper. Separate from the main Hunch repo — **never** import
from or commit to it.

Full spec & sprint plan: [`docs/BUILD_SPEC.md`](./docs/BUILD_SPEC.md).

## Working agreements
- **Ports & adapters.** `core/` depends only on `ports/` and `core/` types — never on a concrete
  adapter, network client, or framework. Mock adapters in `adapters/mock/` are deterministic and
  credential-free. The real Casper/Odra adapter lands behind the SAME interface + contract tests.
- **Composition root only.** `src/lib/container.ts` is the only place that picks adapters.
- **Never trust an LLM into the money path.** Payouts are pure, deterministic contract math
  (`core/parimutuel-odds.ts` + the vault). LLMs only propose markets, narrate bets, summarise
  resolutions.
- **One config for the network toggle.** Everything that differs between Testnet and Mainnet lives
  in `src/config/network.ts`. Never hardcode a network-specific value elsewhere.
- **Deterministic data.** Seed pools and deadlines are fixed literals so tests don't drift on the
  wall clock and demos reproduce.

## Green gate (before every commit)
`pnpm typecheck && pnpm lint && pnpm test && pnpm build` — all green. `tsc` also typechecks test
files, so re-run the full gate after the last edit.

## Originality
Hunch exists on other chains. All Casper code here is newly written for this buildathon. Keep that
true and state it in the README + submission.
