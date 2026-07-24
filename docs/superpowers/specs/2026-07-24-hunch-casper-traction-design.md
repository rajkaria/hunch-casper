# Hunch on Casper — closing the loop, then earning traction

**Date:** 2026-07-24
**Status:** design, awaiting review
**Scope:** four phases, no fixed deadline ("build everything"), testnet-only spend

---

## 1. Why this document exists

Hunch on Casper is, as an engineering artifact, close to finished: nine original Odra contracts,
95 OdraVM + ~1166 TS tests, a deployed v2 vault with permissionless creation flipped on, real-mode
agents paying x402 out of purses they control, and `/api/health` reporting 14/14 green.

It has no traction, and the reason is not marketing. **The economy's loop does not close.** This
document establishes that with evidence, then sequences the work that follows from it.

---

## 2. Evidence — production, observed 2026-07-24

### 2.1 The loop runs one quarter of its cycle

Forty most recent agent actions, spanning ~2.7 days (`1784661757470` → `1784892059631`):

| Action kind | Count |
|---|---|
| `bet_placed` | 40 |
| `market_created` | 0 |
| `market_resolved` | 0 |
| `payout_claimed` | 0 |

The headline claim — *"create → bet → resolve → score, unattended, 24/7"* — is currently only
"bet". Genesis creates nothing in production; the Arbiter has never resolved a catalogue market.

### 2.2 Root cause: every market matures on Aug 1

[`src/core/catalogue.ts`](../../../src/core/catalogue.ts) hardcodes a single literal deadline
across the catalogue. The two markets whose titles promise a short cycle do not have one — their
"hourly" and "5m" are *offsets from Aug 1*, not cadences:

| Slug | Subtitle claims | `deadlineIso` |
|---|---|---|
| `cspr-hourly-updown` | "Casper-native · recurring hourly round" | `2026-08-01T01:00:00.000Z` |
| `coin-flip-5m` | 5-minute round | `2026-08-01T00:05:00.000Z` |
| every other catalogue market | — | `2026-08-01T00:00:00.000Z` |

[`src/agent/arbiter.ts:219`](../../../src/agent/arbiter.ts) gates the unattended sweep on
`m.status !== "locked"` — a status only reached past deadline. Nothing has matured, so nothing has
resolved, so nothing has ever paid out on chain.

The `MarketDefinition` type already carries a `cadence` field, documented as *"How often the market
opens a fresh round (declarative; the scheduler is a later sprint)."* **The scheduler was deferred
and never built.** This design builds it.

### 2.3 Everything else that looks broken is downstream of 2.2

| Surface | Observed | Why |
|---|---|---|
| `/api/boards` | `agentPnl: []`, `eventCount: 0`, `lastBlockHeight: 0` | `computeAgentLeaderboard(settledEntriesFrom(state))` needs settlements. Zero resolutions → zero settled entries. |
| `/api/league` | `standings: []`, `winner: null`, season `weekly-0` closed Jul 18, never rolled | `minSettledToWin: 5`; zero settled markets means no agent can ever qualify. |
| `prophet-race-weekly`, `momentum-vs-contrarian-weekly`, `arbiter-accuracy-95` | open, unresolvable | Meta-markets settle against the PnL / oracle boards, which are empty. |
| Calibration / Brier ranking | no data | Requires resolved outcomes to score forecasts against. |
| Arbiter on-chain reputation | never incremented | `OracleRegistry` accrues on resolution. |

**Correction to an earlier reading:** the indexer's contract scope *is* also wrong (§4.2), but
fixing it alone would surface bets and still render an empty PnL board. Resolution is upstream of
every one of these.

### 2.4 Two secondary defects visible in the same data

**Degenerate market selection.** Of 40 bets, 23 (58%) landed on `cspr-hourly-updown`, and `Value`
placed 26 of the 40 — 23 of them on that one market, all on `down`, all at 3 CSPR, all carrying a
byte-identical narration string. Nineteen markets are open; the fleet behaves as though one is.

**A leaking purse.** `Value` holds 170.2 CSPR against 281.3 / 297.3 / 303.5 for the rest of the
fleet, all funded at 300 in the same session. It has spent the difference into a market that
cannot settle for eight days. `cspr-hourly-updown` currently escrows **1072 CSPR**
(540 `up` / 532 `down`) with no path to payout.

---

## 3. Design principles for this work

1. **Fix causes, not symptoms.** Resolution before indexing before presentation.
2. **Respect the determinism invariant.** AGENTS.md requires fixed deadline literals so tests
   don't drift on the wall clock. Recurring rounds need wall-clock-relative deadlines. Resolve the
   tension by injecting the clock as a port — tests pin a fixed clock and stay deterministic —
   rather than relaxing the invariant.
3. **No LLM in the money path.** Unchanged. Round scheduling, settlement and rollover are pure
   integer/date arithmetic.
4. **Every safeguard stays.** The bet-breaker and market quarantine keep their no-self-healing
   posture; round rollover must not silently release a quarantined market.
5. **Traction is measured in agents you do not own.** Every Phase 3 decision optimises that number.

---

## 4. Phase 0 — close the loop

The single highest-value change. Everything else in this document depends on it.

### 4.1 The recurring-round scheduler

**Goal:** markets with a short `cadence` open, take bets, mature, resolve, pay, and roll — within
the hour, unattended.

**Components:**

- **`ClockPort`** (`src/ports/clock.ts`) — `now(): number`. Real adapter returns `Date.now()`;
  the test adapter returns a pinned literal. Added to the container at the composition root.
  This is what keeps §3.2 honest.
- **`src/core/round-schedule.ts`** (pure) — given a `MarketDefinition` and a timestamp, compute
  the current round index, its deadline, and whether the round has matured. Pure integer/date
  arithmetic, exhaustively unit-tested including DST-free UTC boundaries and cadence changes.
- **Round-aware market identity.** A recurring market's on-chain id becomes `<slug>#<roundIndex>`
  so each round is a distinct vault entry with its own pools, while `<slug>` remains the stable
  catalogue/UI identity. This keeps parimutuel accounting per-round and makes round history
  addressable.
- **Rollover in the tick** — after `runArbiterSweep` settles a matured round, open the next round
  for any recurring market via the vault's `create_market`. Measured cost is 3.74 CSPR per call,
  which sets the treasury budget in §4.5.
- **Cadence taxonomy.** `MarketCadence` gains explicit semantics: `once` (existing long-dated
  catalogue behaviour, unchanged), `hourly`, `daily`, `weekly`. Meta-markets stay `weekly` and keep
  their explicit close path so Prophets can bet them through the window.

**Interaction with quarantine:** a quarantined slug does not roll. Rollover reads the quarantine
set first; releasing a market is still a deliberate human act.

### 4.2 Correct the mislabeled markets and strand-free the escrow

- `cspr-hourly-updown` → `cadence: hourly`, deadline computed, subtitle finally true.
- `coin-flip-5m` → the drand-bound flip becomes a genuine short round.
- The 1072 CSPR currently escrowed in `cspr-hourly-updown` needs an explicit decision. Two
  defensible options, to be chosen at implementation time with the numbers in front of us:
  **(a)** let the existing round run to its Aug 1 deadline and resolve normally — nothing is lost,
  the money simply stays locked for eight days; **(b)** void the round, which refunds every
  participant in full via the existing void path. **(a) is the default** — it requires no
  live-money contract interaction and the pools are near-balanced, so the parimutuel outcome is
  fair either way. Recurring rounds start fresh alongside it.

### 4.3 Fix degenerate market selection

The fleet must spread across open markets rather than converging on one. The fix belongs in
`src/core/prophet-strategies.ts` and must stay deterministic and testable: a strategy proposes a
ranked preference over *eligible* markets, and selection deterministically de-concentrates — an
agent that bet a market last round deprioritises it, and per-round per-market exposure is capped.
Pinned by a test asserting that N rounds across M open markets produce a bounded concentration
ratio, so this cannot silently regress.

### 4.4 Narration variety

Twenty-three byte-identical narration strings read as fake to anyone watching the feed, and the
feed is the demo. Narrations must vary with the market, the round, the price the agent accepted,
and its recent record. The LLM remains advisory-only — it never selects an outcome or sizes a
stake, so this is presentation, not money path.

### 4.5 Treasury model for recurring rounds

Hourly rounds cost real testnet CSPR: 3.74 CSPR per `create_market`, plus resolve (6.317 consumed)
and per-bet gas. Before enabling any cadence, compute and document runway at that cadence against
the current treasury, and choose the fastest cadence the treasury sustains for a stated number of
weeks. **Hourly on one or two flagship markets, daily on the rest** is the expected answer; the
calculation decides. `/api/health` gains a runway check that warns before the treasury cannot fund
the next N rounds.

### 4.6 Genesis creates again

Genesis has produced nothing in production. With the vault and open creation live, Genesis should
open genuinely new markets from live CSPR.cloud signals on a bounded cadence, respecting the
existing `GENESIS_MAX_CREATED` cap and cooldown abuse guards.

**Phase 0 exit criteria:** within one hour of deploy, production shows a `market_resolved` and a
`payout_claimed` action; `/api/boards` returns a non-empty `agentPnl`; `/api/league` shows
standings advancing toward `minSettledToWin`.

---

## 5. Phase 1 — make every claim provable

With settlements flowing, the credibility layer can be made honest.

### 5.1 Multiplex the chain-event indexer

[`src/lib/container.ts:145`](../../../src/lib/container.ts) scopes the real `EventsPort` to
`contracts.vaultV2` alone, but health reports bets route to **five per-market v1 packages first**,
with v2 as fallback. Every v1 bet is structurally invisible to the fold. Multiplex the port across
all routable contracts (the v1 address map plus the v2 vault), merging into one ordered stream —
`blockHeight` + `eventIndex` is already the documented ordering key.

Separately verify that CSPR.cloud actually returns CES contract events for these Odra packages
against the **live** endpoint. Per the `/auction-metrics` precedent recorded in AGENTS.md, a
mocked fixture proves nothing about a real upstream; if CSPR.cloud cannot see them, fall back to
folding the package's transaction history.

### 5.2 A health check that fails on a silent zero

Real mode, with recorded bets, and `eventCount: 0` must be a `fail`. This defect survived precisely
because nothing watched it — the same failure mode as the CSPR.cloud bug.

### 5.3 League season auto-roll

Season `weekly-0` closed Jul 18 with no winner and never rolled. Seasons roll automatically on the
tick, crown a winner when `minSettledToWin` is met, and archive prior seasons to a public history.

### 5.4 Exercise the dispute path on chain (D23)

`DisputePanel` is deployed capability with no live transaction behind it, while "a wrong resolution
can be challenged" is a headline claim. Wire the Arbiter's propose → challenge-window → finalize
path for flagged markets, exercise it once end-to-end on testnet, and link the receipt from `/docs`.

### 5.5 Real-mode anchoring

Call the vault's `commit_recipe` / `commit_bundle` and the S26 `ResolutionHook` `dispatch` from the
live Arbiter, so a resolution is replayable from chain alone. Same argument as 5.4: shipped
capability, no receipt. This is also what makes the traction numbers in 5.6 independently
recomputable rather than asserted.

### 5.6 Live numbers, on the landing page

A derived, clickable bar: markets run, rounds settled, bets placed, CSPR settled, distinct agents,
on-chain receipts. Sourced from §5.1 so the numbers are recomputable by anyone. This is
simultaneously the credibility artifact and the Phase 3 growth artifact.

### 5.7 Demo video

Per [`docs/DEMO_SCRIPT.md`](../../DEMO_SCRIPT.md), recorded once Phase 0 makes the loop visibly
close on camera — which it currently does not.

---

## 6. Phase 2 — let humans in

**No human can currently bet.** The landing page serves `Connect wallet` and a `demo` pill; there
is no `NEXT_PUBLIC_CSPR_CLICK_APP_ID`. Every downstream traction goal is blocked on this.

- Merge and finish the existing `claude/cspr-click-wallet-integration-cb16cb` branch.
- Register the CSPR.click app, wire the app id, retire the `demo` pill.
- End-to-end verify a human bet from wallet connect through claim on testnet.
- Verify `/create` runtime market creation end-to-end — it shares the proxy envelope that was
  broken and is now fixed, but has never been exercised live.

---

## 7. Phase 3 — traction

### 7.1 Agent League Season 1

Converts the treasury from fuel into prize money: the same burn, a compounding result.

- A season with a real deadline and a testnet CSPR prize pool from the existing treasury.
- A public season page: countdown, live standings, rules, prize, and how to enter.
- Self-serve registration against the existing bonded `AgentRegistry`.
- A genuinely five-minute quickstart over `packages/agent-template` and the published SDK.
- **Ranked on calibration, not profit** — the existing invariant, and the thing that makes the
  league interesting rather than a whale contest.

Phase 0 is what makes this viable: an agent that joins a league whose board updates hourly gets
feedback within the hour. Against the current catalogue it would be scored never.

### 7.2 Distribution

Self-serve rails **and** a ready-to-send outreach kit:

- MCP registry listing; npm/SDK discoverability; oEmbed discovery `<link>` on market pages.
- `HUNCH_BOTS_LIVE` — Telegram and X posting live round results and league standings.
- Embeddable market widgets.
- Written outreach: Casper Discord, the buildathon cohort, agent-developer communities.

### 7.3 Ecosystem infrastructure

`ResolutionHook` (oracle-as-a-service) and the metered odds feed are deployed and nobody is bound
to them. One real Casper integration outweighs a great deal of consumer traffic for an ecosystem
prize. Longest sales cycle, highest ceiling — and materially easier to pitch once §5.6 shows a live
board with strangers on it.

---

## 8. Explicitly out of scope

- **Mainnet deployment.** Gated on an audit and real-CSPR funding; the operator has scoped this run
  to testnet spend.
- **Recovering rounds 1–42.** Agent identity was not on chain then; the history is unrecoverable
  and a backfill attempt is wasted work.
- **Relaxing any economy invariant** in AGENTS.md. Where this design touches one (deterministic
  deadlines), it does so through an injected clock that preserves the guarantee.

---

## 9. Sequencing

Phase 0 → 1 → 2 → 3, in order. The dependencies are real, not stylistic: Phase 1's boards need
Phase 0's settlements; Phase 3's league needs Phase 1's boards and Phase 2's wallet. Each phase
ends green on `pnpm typecheck && pnpm lint && pnpm test && pnpm build` plus `cargo odra test`.

---

## 10. Open questions for review

1. **Cadence, once the runway maths are in** — hourly on flagships and daily elsewhere is the
   expected shape, but the treasury calculation in §4.5 decides it. Confirm the runway floor you
   want to hold (e.g. "must sustain 8 weeks").
2. **The 1072 CSPR escrow** — §4.2 defaults to letting the existing round run to Aug 1 rather than
   voiding. Confirm.
3. **Prize pool size** for Season 1, in testnet CSPR, against current treasury and the new
   per-round burn.
