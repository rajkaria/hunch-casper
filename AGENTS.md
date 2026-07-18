<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Hunch on Casper — project instructions

Standalone submission for the **Casper Agentic Buildathon 2026**. A self-running prediction
market run by autonomous agents on Casper. Separate from the main Hunch repo — **never** import
from or commit to it.

Full spec & sprint plan: `docs/BUILD_SPEC.md` (internal working doc — untracked, lives only in
the maintainer's checkout).

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

## Economy invariants (keep the self-scoring board honest)
- **The Prophet fleet never bets meta-markets.** `runProphetFleet` filters out `category === "meta"`.
  Meta-markets (`prophet_pnl`, `arbiter_accuracy_pct`) resolve against the Prophet PnL / oracle
  boards, so letting the fleet bet them would let their bets contaminate the board that scores them.
  Only humans + external agents bet meta-markets.
- **A `prophet_pnl` meta-market only crowns a Prophet with ≥ `META_MIN_SETTLED` settled markets**
  (`core/meta-resolution.ts`) — a participation floor so a single manipulated pool can't hand a
  chosen Prophet the win. Combined with the weekly window, it bounds oracle-manipulation of the
  self-scoring board.
- **`meta` is a reserved category, enforced on chain (S19).** Once `HunchVault.open_creation`
  is flipped, anyone may mint a market — so `create_market` reverts `ReservedCategory` for a
  non-admin creator passing `meta` (case/whitespace-insensitive). Without it, the public could
  mint the very markets that score the Prophet/Arbiter boards. The admin (Genesis) is exempt,
  because the curated catalogue legitimately ships meta-markets.
- **A permissionless market's oracle must be admin-approved and never its creator.** The
  oracle is the only address that can resolve, i.e. it decides who gets paid; an
  unconstrained creator would name themselves, take the other side's stake and self-resolve.
  This is the guardrail the whole `open_creation` flip hinges on — do not relax it to "any
  address in OracleRegistry" without re-checking who can write to that registry.
- **The Arbiter's accuracy is two-sided.** The mock oracle marks a deterministic minority of external
  reads inaccurate, so a wrong call genuinely lowers reputation and `arbiter-accuracy-95` can resolve
  NO. Meta-markets resolve from board math and are accurate by construction.
- **Real-mode agent x402 opens through exactly two paths.** In `CASPER_CHAIN_MODE=real` `agentBet`
  fails closed unless EITHER `CASPER_X402_PAYTO` is set — wiring the real transfer-verifying
  PaymentPort (`adapters/casper/real-payment.ts`), which accepts a proof only if it maps to a
  successful on-chain CSPR transfer from the payer to the treasury (trustless) — OR
  `CASPER_REAL_AGENT_X402=true`, the weaker legacy opt-in that keeps the mock nonce-match verifier.
  Either way the mock-vs-real mismatch is explicit and safe-by-default, never a silent
  operator-funded gap.
- **Every agent pays from a purse it controls (S17).** A Prophet's x402 proof is the settlement id
  of a real transfer out of its own wallet (`WalletPort`) — never a locally fabricated string. Each
  agent has its **own** Ed25519 identity, derived as
  `HMAC-SHA256(CASPER_FLEET_SEED, "hunch-fleet-v1:<agentId>")`; a shared key is not an option,
  because it would collapse every agent's track record into one on-chain identity and destroy the
  reputation data the registry (S19) is built on. Derivation must stay deterministic — fleet
  wallets are funded by hand, so a drifting address strands real money.
- **An agent that cannot pay sits the round out.** Below its turn floor (largest stake + transfer
  gas) a Prophet skips instead of submitting a transfer it cannot fund: a failed transaction burns
  gas and yields an unverifiable proof, which is strictly worse than not betting.
- **The payment binds to the account; the ledger binds to the name.** `AgentBetInput.payerAccount`
  carries the Casper key the transfer-verifying PaymentPort checks, while `bettor` stays the
  readable agent id the boards, feed and meta-markets are keyed by. Collapsing the two breaks
  either verification or every leaderboard.

## Green gate (before every commit)
`pnpm typecheck && pnpm lint && pnpm test && pnpm build` — all green. `tsc` also typechecks test
files, so re-run the full gate after the last edit.

## Originality
Hunch exists on other chains. All Casper code here is newly written for this buildathon. Keep that
true and state it in the README + submission.
