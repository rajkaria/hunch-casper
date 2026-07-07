# Contributing to Hunch on Casper

Thanks for your interest. This repository is the standalone submission for the **Casper Agentic
Buildathon 2026**. It is separate from the main Hunch codebase and every line of Casper code here is
newly written for this buildathon — please keep that true (see [Originality](#originality)).

## Ways to contribute

- **Report a bug** — open a [bug report](https://github.com/rajkaria/hunch-casper/issues/new?template=bug_report.yml).
- **Suggest a feature** — open a [feature request](https://github.com/rajkaria/hunch-casper/issues/new?template=feature_request.yml).
- **Report a vulnerability** — do **not** open a public issue; follow [`SECURITY.md`](./SECURITY.md).
- **Send a pull request** — see below.

## Development setup

Requirements: Node.js 22+, [pnpm](https://pnpm.io/) 10+. For the contracts, a Rust toolchain and
[`cargo-odra`](https://odra.dev/) (only needed if you touch `contracts/`).

```bash
pnpm install
pnpm dev          # http://localhost:3000
```

Copy `.env.example` to `.env.local` if you want to exercise the credential-gated paths; the default
mock adapters run credential-free.

## The green gate (run before every commit)

CI runs the same four checks. All must pass:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

`tsc` also typechecks the test files, so re-run the full gate after your last edit. If you changed
anything under `contracts/`, also run the contract tests:

```bash
cd contracts && cargo odra test
```

## Architecture rules (please respect these)

This project uses **ports & adapters**. A few invariants keep it honest:

- **`core/` depends only on `ports/` and `core/` types** — never on a concrete adapter, network
  client, or framework.
- **`src/lib/container.ts` is the only composition root** — it is the single place that picks
  adapters.
- **Never route an LLM into the money path.** Payouts are pure, deterministic contract math
  (`core/parimutuel-odds.ts` + the vault). LLMs only propose markets and narrate.
- **One config for the network toggle.** Everything that differs between Testnet and Mainnet lives
  in `src/config/network.ts`.
- **Deterministic data.** Seed pools and deadlines are fixed literals so tests and demos reproduce.

See [`AGENTS.md`](./AGENTS.md) for the full working agreements and economy invariants.

## Pull request process

1. Fork and branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. Make your change with tests. New behavior needs a test; a bug fix needs a regression test.
3. Ensure the green gate is fully green.
4. Fill out the [PR template](./.github/PULL_REQUEST_TEMPLATE.md) — describe the change, link any
   issue, and confirm the gate passed.
5. Keep commits focused and messages descriptive. Conventional-commit prefixes
   (`feat:`, `fix:`, `docs:`, `chore:`) are appreciated.

## Originality

Hunch exists on other chains (Base, Sui). **All Casper code in this repository is original and newly
written for this buildathon** — the Odra/Rust contracts, the Casper adapter, the agent swarm, and
the UI. Do not import from or commit to the main Hunch repository. Keep this true and state it in
any derivative work.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By participating, you agree
to uphold it.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](./LICENSE).
