## What & why

<!-- What does this change do, and why? Link the issue it closes. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Docs
- [ ] CI / tooling
- [ ] Contracts (Odra/Rust)

## Green gate

CI runs `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Confirm it passes locally:

- [ ] `pnpm typecheck` ✅
- [ ] `pnpm lint` ✅
- [ ] `pnpm test` ✅
- [ ] `pnpm build` ✅
- [ ] `cargo odra test` ✅ (only if `contracts/` changed)

## Invariants (see [AGENTS.md](../AGENTS.md))

- [ ] No LLM was routed into the money path (payouts stay pure, deterministic contract math).
- [ ] The Prophet fleet still cannot bet meta-markets.
- [ ] Network-specific values live only in `src/config/network.ts`.
- [ ] Adapter selection happens only in `src/lib/container.ts`.

## Notes for reviewers

<!-- Anything mocked/simulated vs. real? Screenshots for UI changes? Migration steps? -->
