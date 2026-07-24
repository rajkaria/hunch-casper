# Phase 0 — Close the Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Hunch economy complete its advertised cycle — markets open, take bets, mature, resolve, pay out, and roll into a fresh round — unattended, within the hour.

**Architecture:** Two independent root causes are fixed first (a frozen round counter that pins every tick to the same agent and market; a catalogue where every deadline is a fixed Aug 1 literal so nothing ever matures). Then a recurring-round scheduler is built on the `cadence` field the `MarketDefinition` type has always carried but never honoured. Wall-clock reads move behind a `ClockPort` so the AGENTS.md determinism invariant survives.

**Tech Stack:** TypeScript, Next.js App Router, Vitest, Odra/Rust contracts (unchanged this phase), Casper testnet.

## Global Constraints

- Green gate before every commit: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` — all green. `tsc` also typechecks test files, so re-run the full gate after the last edit.
- `core/` depends only on `ports/` and `core/` types — never on a concrete adapter, network client, or framework.
- `src/lib/container.ts` is the ONLY place that picks adapters.
- Never trust an LLM into the money path. Round scheduling, settlement and rollover are pure integer/date arithmetic.
- Everything that differs between Testnet and Mainnet lives in `src/config/network.ts`.
- Deterministic data: tests must not drift on the wall clock. Where this plan introduces time-dependence, tests inject a pinned clock.
- The Prophet fleet never bets `category === "meta"`.
- Quarantine and the bet-breaker keep their no-self-healing posture: neither is released by a timer.
- Measured on-chain costs (do not re-estimate): `create_market` 3.74 CSPR net (first call on a fresh vault 4.958), resolve 6.317 consumed, bet 1.439, register 0.976.

---

## Root cause reference

Two defects, verified against production on 2026-07-24. Every task below traces to one of them.

**Bug A — nothing ever matures.** `src/core/catalogue.ts` pins every market to `AUG_1 = "2026-08-01T00:00:00.000Z"` (or an offset from it). `src/adapters/mock/settlement-ledger.ts:57` only reports `locked` past the deadline, and `src/agent/arbiter.ts:219` only resolves `locked` markets. Result over 2.7 days of production: 40 bets, 0 resolutions, 0 claims.

**Bug B — the round counter is frozen at 50.** `src/app/api/agent/tick/route.ts:110` computes `const seq = typeof body.seq === "number" ? body.seq : listActions().length`. `listActions(limit = 50)` returns `log.slice(0, limit)`, so once the feed holds 50+ entries its length is permanently 50. Then:

| Consumer | Expression | Frozen value | Observed in production |
|---|---|---|---|
| `runProphetFleet` market pick | `open[seq % open.length]` → `open[50 % 19]` | index 12 | 23 of 40 bets on one market |
| `runProphetFleet` agent pick | `PROPHETS[(seq + i) % 4]` → `PROPHETS[50 % 4]` | index 2 = **Value** | Value placed 26 of 40 bets |
| `decide(...)` / LLM narration | seeded by `seq` | constant | 23 byte-identical narration strings |

The activity log already maintains a correct monotonic `counter` (`src/adapters/mock/activity-log.ts:44`, exported via `exportActivityState`). The tick simply does not use it.

---

## File structure

| File | Responsibility | Status |
|---|---|---|
| `src/ports/clock.ts` | `ClockPort` — the only source of "now" for schedule-dependent core logic | create |
| `src/adapters/mock/mock-clock.ts` | Pinned, advanceable clock for tests | create |
| `src/adapters/system-clock.ts` | `Date.now()` adapter | create |
| `src/core/round-schedule.ts` | Pure round math: index, window, maturity, next deadline | create |
| `src/core/round-id.ts` | `<slug>#<roundIndex>` encode/decode | create |
| `src/adapters/mock/activity-log.ts` | Expose the monotonic counter as the round seq | modify |
| `src/app/api/agent/tick/route.ts:110` | Use the monotonic counter, not the capped list length | modify |
| `src/core/types.ts:19` | `MarketCadence` gains recurring semantics | modify |
| `src/core/catalogue.ts` | Recurring markets stop carrying Aug 1 literals | modify |
| `src/adapters/mock/settlement-ledger.ts:57` | `effectiveStatus` reads the clock port | modify |
| `src/agent/round-rollover.ts` | Open the next round of a matured recurring market | create |
| `src/agent/economy.ts` | Rollover after the Arbiter sweep | modify |
| `src/agent/prophet.ts:274-288` | De-concentrated market + agent selection | modify |
| `src/core/health.ts`, `src/lib/health.ts` | Loop-liveness + runway checks | modify |

---

## Task 1: Unfreeze the round counter

Bug B, root fix. This one change restores agent rotation, market rotation, and narration variety.

**Files:**
- Modify: `src/adapters/mock/activity-log.ts`
- Modify: `src/app/api/agent/tick/route.ts:110`
- Test: `test/round-seq.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `nextRoundSeq(): number` from `@/adapters/mock/activity-log` — a strictly monotonic counter that survives the ring-buffer cap and KV restore. Tasks 8 and 11 rely on it advancing every tick.

- [ ] **Step 1: Write the failing test**

Create `test/round-seq.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import {
  appendAction,
  listActions,
  nextRoundSeq,
  __resetActivity,
  ACTIVITY_CAP,
} from "@/adapters/mock/activity-log";

function append(n: number): void {
  for (let i = 0; i < n; i++) {
    appendAction({
      agent: "Momentum",
      kind: "bet_placed",
      marketId: "testnet:x",
      marketTitle: "x",
      narration: "n",
      simulated: true,
    });
  }
}

describe("round seq", () => {
  beforeEach(() => __resetActivity());

  it("keeps advancing after the ring buffer saturates", () => {
    append(ACTIVITY_CAP + 20);
    const first = nextRoundSeq();
    append(5);
    expect(nextRoundSeq()).toBe(first + 5);
  });

  it("does not saturate the way listActions().length does", () => {
    append(120);
    // The defect: the capped, limit-defaulted list length pins the round forever.
    expect(listActions().length).toBe(50);
    expect(nextRoundSeq()).toBeGreaterThanOrEqual(120);
  });

  it("rotates a 4-agent fleet across consecutive rounds", () => {
    append(120);
    const picks = new Set<number>();
    for (let i = 0; i < 4; i++) {
      picks.add(nextRoundSeq() % 4);
      append(1);
    }
    expect(picks.size).toBe(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/round-seq.test.ts`
Expected: FAIL — `nextRoundSeq` is not exported from `@/adapters/mock/activity-log`.

- [ ] **Step 3: Export the monotonic counter**

In `src/adapters/mock/activity-log.ts`, after `listActions`, add:

```ts
/**
 * The round counter — strictly monotonic, and the ONLY correct seq for the economy tick.
 *
 * `listActions().length` looks like a round number and is not: the feed is a ring buffer capped at
 * ACTIVITY_CAP and `listActions` defaults to a limit of 50, so its length saturates permanently.
 * A frozen seq pins `seq % fleetSize` and `seq % openMarkets` to one agent and one market forever
 * — which is exactly what production did for weeks. `counter` already survives the cap and is
 * restored by `importActivityState`, so it is the value that must drive rotation.
 */
export function nextRoundSeq(): number {
  return counter;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/round-seq.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Use it in the tick**

In `src/app/api/agent/tick/route.ts`, add `nextRoundSeq` to the existing `@/adapters/mock/activity-log` import, then replace line 110:

```ts
  // Monotonic, cap-proof round counter. NEVER `listActions().length` — that saturates at the
  // list limit and freezes agent + market rotation on a single pair (see round-seq.test.ts).
  const seq = typeof body.seq === "number" ? body.seq : nextRoundSeq();
```

- [ ] **Step 6: Verify no other caller repeats the mistake**

Run: `grep -rn "listActions().length" src/`
Expected: no output.

- [ ] **Step 7: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/adapters/mock/activity-log.ts src/app/api/agent/tick/route.ts test/round-seq.test.ts
git commit -m "fix(economy): the round counter stops freezing, so the fleet rotates again

seq came from listActions().length, but the feed is a ring buffer whose reader
defaults to a limit of 50 — so after fifty actions the round number never moved
again. Every tick then picked PROPHETS[50 % 4] on open[50 % 19]: one agent, one
market, and a byte-identical narration, forever. The log already keeps a correct
monotonic counter; the tick now uses it."
```

---

## Task 2: A clock port

Schedule-dependent logic must not read `Date.now()` directly, or the recurring-round tests drift on the wall clock and violate the AGENTS.md determinism invariant.

**Files:**
- Create: `src/ports/clock.ts`
- Create: `src/adapters/system-clock.ts`
- Create: `src/adapters/mock/mock-clock.ts`
- Modify: `src/ports/index.ts`
- Modify: `src/lib/container.ts`
- Test: `test/clock.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `ClockPort { now(): number }`; `createSystemClock(): ClockPort`; `createMockClock(startMs: number): ClockPort & { advance(ms: number): void; set(ms: number): void }`. `Container` gains a `clock: ClockPort` field. Tasks 3–7 and 10 consume `container.clock`.

- [ ] **Step 1: Write the failing test**

Create `test/clock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createMockClock } from "@/adapters/mock/mock-clock";
import { createSystemClock } from "@/adapters/system-clock";

describe("ClockPort", () => {
  it("mock clock is pinned and advanceable", () => {
    const clock = createMockClock(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
    clock.set(42);
    expect(clock.now()).toBe(42);
  });

  it("mock clock does not drift on repeated reads", () => {
    const clock = createMockClock(7);
    expect(clock.now()).toBe(clock.now());
  });

  it("system clock tracks wall time", () => {
    const before = Date.now();
    const now = createSystemClock().now();
    expect(now).toBeGreaterThanOrEqual(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/clock.test.ts`
Expected: FAIL — cannot resolve `@/adapters/mock/mock-clock`.

- [ ] **Step 3: Create the port**

Create `src/ports/clock.ts`:

```ts
/**
 * ClockPort — the only source of "now" for schedule-dependent logic.
 *
 * Recurring rounds are defined against the wall clock, but the catalogue's determinism invariant
 * (AGENTS.md) requires that tests never drift with it. Injecting the clock keeps both: production
 * reads real time, tests pin a literal and advance it deliberately.
 */
export interface ClockPort {
  /** Epoch milliseconds. */
  now(): number;
}
```

- [ ] **Step 4: Create the adapters**

Create `src/adapters/system-clock.ts`:

```ts
import type { ClockPort } from "@/ports/clock";

/** Wall-clock adapter — the production clock. */
export function createSystemClock(): ClockPort {
  return { now: () => Date.now() };
}
```

Create `src/adapters/mock/mock-clock.ts`:

```ts
import type { ClockPort } from "@/ports/clock";

export interface MockClock extends ClockPort {
  /** Move time forward by `ms`. */
  advance(ms: number): void;
  /** Jump to an absolute epoch ms. */
  set(ms: number): void;
}

/** A pinned clock. Time only moves when a test says so. */
export function createMockClock(startMs: number): MockClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/clock.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Wire into the container**

In `src/ports/index.ts` add:

```ts
export type { ClockPort } from "./clock";
```

In `src/lib/container.ts`: import `createSystemClock` from `@/adapters/system-clock` and `ClockPort` from `@/ports/clock`; add to the `Container` interface, after `store`:

```ts
  /** The only source of "now" for schedule-dependent logic (recurring rounds, maturity). */
  clock: ClockPort;
```

and add `clock: createSystemClock(),` to the returned object.

- [ ] **Step 7: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green. If `test/container.test.ts` asserts an exact key set on the container, add `clock` to that expectation.

- [ ] **Step 8: Commit**

```bash
git add src/ports/clock.ts src/ports/index.ts src/adapters/system-clock.ts src/adapters/mock/mock-clock.ts src/lib/container.ts test/clock.test.ts
git commit -m "feat(ports): a clock port, so recurring rounds can exist without drifting tests"
```

---

## Task 3: Pure round math

**Files:**
- Create: `src/core/round-schedule.ts`
- Test: `test/round-schedule.test.ts` (create)

**Interfaces:**
- Consumes: `MarketCadence` from `@/core/types`.
- Produces:
  - `cadenceIntervalMs(cadence: MarketCadence): number | null` — `null` for `"one-shot"`.
  - `roundIndexAt(epochMs: number, intervalMs: number): number`
  - `roundWindow(roundIndex: number, intervalMs: number): { openMs: number; deadlineMs: number }`
  - `currentRound(cadence: MarketCadence, nowMs: number): { index: number; openMs: number; deadlineMs: number } | null`
  Tasks 4, 6 and 7 consume these.

- [ ] **Step 1: Write the failing test**

Create `test/round-schedule.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  cadenceIntervalMs,
  roundIndexAt,
  roundWindow,
  currentRound,
} from "@/core/round-schedule";

const HOUR = 3_600_000;

describe("round schedule", () => {
  it("maps cadences to intervals", () => {
    expect(cadenceIntervalMs("5-minute")).toBe(300_000);
    expect(cadenceIntervalMs("hourly")).toBe(HOUR);
    expect(cadenceIntervalMs("weekly")).toBe(604_800_000);
    expect(cadenceIntervalMs("one-shot")).toBeNull();
  });

  it("indexes rounds from the epoch, so every instance agrees", () => {
    expect(roundIndexAt(0, HOUR)).toBe(0);
    expect(roundIndexAt(HOUR - 1, HOUR)).toBe(0);
    expect(roundIndexAt(HOUR, HOUR)).toBe(1);
    expect(roundIndexAt(HOUR * 3 + 5, HOUR)).toBe(3);
  });

  it("windows are half-open [open, deadline) and contiguous", () => {
    const a = roundWindow(3, HOUR);
    const b = roundWindow(4, HOUR);
    expect(a.openMs).toBe(HOUR * 3);
    expect(a.deadlineMs).toBe(HOUR * 4);
    expect(b.openMs).toBe(a.deadlineMs);
  });

  it("currentRound contains now", () => {
    const now = HOUR * 10 + 123;
    const r = currentRound("hourly", now);
    expect(r).not.toBeNull();
    expect(r!.index).toBe(10);
    expect(r!.openMs).toBeLessThanOrEqual(now);
    expect(r!.deadlineMs).toBeGreaterThan(now);
  });

  it("a one-shot market has no round", () => {
    expect(currentRound("one-shot", HOUR)).toBeNull();
  });

  it("rejects a non-positive interval rather than dividing by zero", () => {
    expect(() => roundIndexAt(1, 0)).toThrow(/interval/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/round-schedule.test.ts`
Expected: FAIL — cannot resolve `@/core/round-schedule`.

- [ ] **Step 3: Implement**

Create `src/core/round-schedule.ts`:

```ts
/**
 * Round math for recurring markets — pure, and indexed from the Unix epoch.
 *
 * Epoch-anchored indexing matters more than it looks: a serverless fleet has no shared memory, so
 * two instances must derive the SAME round number for the same instant without coordinating. A
 * counter stored anywhere would drift the moment one instance missed a tick; `floor(now/interval)`
 * cannot.
 *
 * Windows are half-open `[openMs, deadlineMs)`, matching the vault, which reverts a `bet` once
 * `block_time >= deadline`.
 */

import type { MarketCadence } from "@/core/types";

const MINUTE = 60_000;

/** How long one round of each cadence lasts. `null` ⇒ the market does not recur. */
export function cadenceIntervalMs(cadence: MarketCadence): number | null {
  switch (cadence) {
    case "5-minute":
      return 5 * MINUTE;
    case "hourly":
      return 60 * MINUTE;
    case "weekly":
      return 7 * 24 * 60 * MINUTE;
    case "one-shot":
      return null;
  }
}

/** Which round the given instant falls in. */
export function roundIndexAt(epochMs: number, intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`round interval must be a positive number of ms, got ${intervalMs}`);
  }
  return Math.floor(epochMs / intervalMs);
}

/** The half-open `[openMs, deadlineMs)` window of a round. */
export function roundWindow(
  roundIndex: number,
  intervalMs: number,
): { openMs: number; deadlineMs: number } {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`round interval must be a positive number of ms, got ${intervalMs}`);
  }
  const openMs = roundIndex * intervalMs;
  return { openMs, deadlineMs: openMs + intervalMs };
}

/** The round containing `nowMs`, or `null` for a non-recurring market. */
export function currentRound(
  cadence: MarketCadence,
  nowMs: number,
): { index: number; openMs: number; deadlineMs: number } | null {
  const intervalMs = cadenceIntervalMs(cadence);
  if (intervalMs === null) return null;
  const index = roundIndexAt(nowMs, intervalMs);
  return { index, ...roundWindow(index, intervalMs) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/round-schedule.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/round-schedule.ts test/round-schedule.test.ts
git commit -m "feat(core): epoch-anchored round math, so every instance agrees on the round"
```

---

## Task 4: Round-addressable market ids

A recurring market needs one vault entry per round, while the catalogue and UI keep a stable slug.

**Files:**
- Create: `src/core/round-id.ts`
- Test: `test/round-id.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `roundMarketId(slug: string, roundIndex: number): string`; `parseRoundMarketId(id: string): { slug: string; roundIndex: number | null }`; `baseSlug(id: string): string`. Tasks 6, 7 and 8 consume these.

- [ ] **Step 1: Write the failing test**

Create `test/round-id.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { roundMarketId, parseRoundMarketId, baseSlug } from "@/core/round-id";

describe("round market ids", () => {
  it("encodes a round as <slug>#<index>", () => {
    expect(roundMarketId("cspr-hourly-updown", 7)).toBe("cspr-hourly-updown#7");
  });

  it("round-trips", () => {
    const id = roundMarketId("coin-flip-5m", 1234);
    expect(parseRoundMarketId(id)).toEqual({ slug: "coin-flip-5m", roundIndex: 1234 });
  });

  it("treats a plain slug as round-less", () => {
    expect(parseRoundMarketId("btc-150k-aug")).toEqual({ slug: "btc-150k-aug", roundIndex: null });
  });

  it("baseSlug strips the round from either form", () => {
    expect(baseSlug("cspr-hourly-updown#7")).toBe("cspr-hourly-updown");
    expect(baseSlug("btc-150k-aug")).toBe("btc-150k-aug");
  });

  it("rejects a negative or non-integer round index", () => {
    expect(() => roundMarketId("x", -1)).toThrow(/round index/i);
    expect(() => roundMarketId("x", 1.5)).toThrow(/round index/i);
  });

  it("a malformed suffix is round-less, not a crash", () => {
    expect(parseRoundMarketId("x#nope")).toEqual({ slug: "x#nope", roundIndex: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/round-id.test.ts`
Expected: FAIL — cannot resolve `@/core/round-id`.

- [ ] **Step 3: Implement**

Create `src/core/round-id.ts`:

```ts
/**
 * Round-addressable market ids — `<slug>#<roundIndex>`.
 *
 * A recurring market is not one market with a moving deadline; it is a series of markets, each
 * with its own pools, its own bettors and its own settlement. Collapsing them onto one id would
 * mix round N's stakes into round N+1's payout, which the parimutuel math has no way to unpick.
 * The slug stays the stable catalogue and UI identity; the suffix addresses one round of it.
 *
 * `#` is deliberate: catalogue slugs are kebab-case and never contain it, so `baseSlug` is
 * unambiguous and a legacy round-less id parses as itself.
 */

const SEP = "#";

/** Address one round of a recurring market. */
export function roundMarketId(slug: string, roundIndex: number): string {
  if (!Number.isInteger(roundIndex) || roundIndex < 0) {
    throw new Error(`round index must be a non-negative integer, got ${roundIndex}`);
  }
  return `${slug}${SEP}${roundIndex}`;
}

/** Split a market id into its slug and round. `roundIndex` is `null` for a non-recurring id. */
export function parseRoundMarketId(id: string): { slug: string; roundIndex: number | null } {
  const idx = id.lastIndexOf(SEP);
  if (idx < 0) return { slug: id, roundIndex: null };
  const suffix = id.slice(idx + SEP.length);
  // A suffix that is not a plain non-negative integer is part of the name, not a round.
  if (!/^\d+$/.test(suffix)) return { slug: id, roundIndex: null };
  return { slug: id.slice(0, idx), roundIndex: Number(suffix) };
}

/** The catalogue slug behind any market id, round-addressed or not. */
export function baseSlug(id: string): string {
  return parseRoundMarketId(id).slug;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/round-id.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/round-id.ts test/round-id.test.ts
git commit -m "feat(core): address one round of a recurring market as <slug>#<index>"
```

---

## Task 5: Maturity reads the clock port

Bug A, first half. `effectiveStatus` currently calls `Date.now()` directly, which makes every maturity test wall-clock dependent.

**Files:**
- Modify: `src/adapters/mock/settlement-ledger.ts:55-59`
- Test: `test/market-maturity.test.ts` (create)

**Interfaces:**
- Consumes: `createMockClock` (Task 2).
- Produces: `setLedgerClock(clock: ClockPort): void` from `@/adapters/mock/settlement-ledger` — module-level clock override, defaulting to the system clock. Task 6 uses it in tests.

- [ ] **Step 1: Write the failing test**

Create `test/market-maturity.test.ts`:

```ts
import { describe, expect, it, afterEach } from "vitest";
import { createMockClock } from "@/adapters/mock/mock-clock";
import { createSystemClock } from "@/adapters/system-clock";
import { setLedgerClock } from "@/adapters/mock/settlement-ledger";
import { createMockMarketStore } from "@/adapters/mock/mock-market-store";
import { MARKET_DEFINITIONS } from "@/core/catalogue";

const store = createMockMarketStore();

afterEach(() => setLedgerClock(createSystemClock()));

describe("market maturity", () => {
  it("an open market past its deadline reads locked", async () => {
    const def = MARKET_DEFINITIONS.find((d) => d.cadence === "one-shot")!;
    setLedgerClock(createMockClock(Date.parse(def.deadlineIso) + 1));
    const m = await store.get({ network: "testnet", slug: def.slug });
    expect(m?.status).toBe("locked");
  });

  it("the same market before its deadline reads open", async () => {
    const def = MARKET_DEFINITIONS.find((d) => d.cadence === "one-shot")!;
    setLedgerClock(createMockClock(Date.parse(def.deadlineIso) - 1));
    const m = await store.get({ network: "testnet", slug: def.slug });
    expect(m?.status).toBe("open");
  });

  it("maturity is exactly at the deadline, not after it", async () => {
    const def = MARKET_DEFINITIONS.find((d) => d.cadence === "one-shot")!;
    setLedgerClock(createMockClock(Date.parse(def.deadlineIso)));
    const m = await store.get({ network: "testnet", slug: def.slug });
    expect(m?.status).toBe("locked");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/market-maturity.test.ts`
Expected: FAIL — `setLedgerClock` is not exported.

- [ ] **Step 3: Implement**

In `src/adapters/mock/settlement-ledger.ts`, add the import `import type { ClockPort } from "@/ports/clock";` and `import { createSystemClock } from "@/adapters/system-clock";`, then replace the `effectiveStatus` block (currently lines 55–59):

```ts
/**
 * The ledger's clock. Overridable so maturity is testable without sleeping or mocking globals —
 * a recurring round matures on a schedule, and a test that had to wait for the wall clock would
 * either be slow or flaky.
 */
let ledgerClock: ClockPort = createSystemClock();

/** Swap the ledger's clock (tests, and the composition root in future phases). */
export function setLedgerClock(clock: ClockPort): void {
  ledgerClock = clock;
}

/** Effective status: an open market at or past its deadline is `locked` (bets closed), matching the
 * on-chain vault which reverts a `bet` once `block_time >= deadline`. Derived, not stored. */
function effectiveStatus(m: Market): MarketStatus {
  if (m.status === "open" && ledgerClock.now() >= Date.parse(m.deadlineIso)) return "locked";
  return m.status;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/market-maturity.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/mock/settlement-ledger.ts test/market-maturity.test.ts
git commit -m "refactor(ledger): maturity reads an injectable clock, so rounds are testable"
```

---

## Task 6: Recurring markets get real deadlines

Bug A, second half. The catalogue stops pinning recurring markets to Aug 1.

**Files:**
- Modify: `src/core/catalogue.ts` (the `cspr-hourly-updown` and `coin-flip-5m` definitions, and the module header)
- Modify: `src/core/market-generator.ts` (deadline derivation for recurring definitions)
- Test: `test/catalogue-cadence.test.ts` (create)

**Interfaces:**
- Consumes: `currentRound`, `cadenceIntervalMs` (Task 3); `roundMarketId` (Task 4).
- Produces: `effectiveDeadlineMs(def: MarketDefinition, nowMs: number): number` from `@/core/market-generator` — the deadline of `def`'s current round, or its literal `deadlineIso` for `one-shot`. Task 7 consumes it.

- [ ] **Step 1: Write the failing test**

Create `test/catalogue-cadence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import { effectiveDeadlineMs } from "@/core/market-generator";
import { cadenceIntervalMs } from "@/core/round-schedule";

const HOUR = 3_600_000;

describe("catalogue cadence", () => {
  it("a recurring market's deadline is always in the near future", () => {
    const now = Date.parse("2026-09-15T13:37:00.000Z"); // deliberately past every Aug 1 literal
    for (const def of MARKET_DEFINITIONS) {
      const interval = cadenceIntervalMs(def.cadence);
      if (interval === null) continue;
      const deadline = effectiveDeadlineMs(def, now);
      expect(deadline).toBeGreaterThan(now);
      expect(deadline - now).toBeLessThanOrEqual(interval);
    }
  });

  it("a one-shot market keeps its literal deadline", () => {
    const def = MARKET_DEFINITIONS.find((d) => d.cadence === "one-shot")!;
    const now = Date.parse("2026-07-01T00:00:00.000Z");
    expect(effectiveDeadlineMs(def, now)).toBe(Date.parse(def.deadlineIso));
  });

  it("the hourly market is actually hourly", () => {
    const def = MARKET_DEFINITIONS.find((d) => d.slug === "cspr-hourly-updown")!;
    expect(def.cadence).toBe("hourly");
    const now = Date.parse("2026-09-15T13:37:00.000Z");
    expect(effectiveDeadlineMs(def, now) - effectiveDeadlineMs(def, now - HOUR)).toBe(HOUR);
  });

  it("the coin flip is actually a 5-minute round", () => {
    const def = MARKET_DEFINITIONS.find((d) => d.slug === "coin-flip-5m")!;
    expect(def.cadence).toBe("5-minute");
  });

  it("no recurring market advertises a cadence its subtitle contradicts", () => {
    // The defect this pins: a market titled "this hour" carrying an eight-day deadline.
    for (const def of MARKET_DEFINITIONS) {
      if (def.cadence === "one-shot") continue;
      const interval = cadenceIntervalMs(def.cadence)!;
      const literal = Date.parse(def.deadlineIso);
      const firstRound = effectiveDeadlineMs(def, literal);
      expect(firstRound - literal).toBeLessThanOrEqual(interval);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/catalogue-cadence.test.ts`
Expected: FAIL — `effectiveDeadlineMs` is not exported from `@/core/market-generator`.

- [ ] **Step 3: Implement the deadline derivation**

In `src/core/market-generator.ts`, add the import `import { currentRound } from "@/core/round-schedule";` and export:

```ts
/**
 * The deadline a definition is actually trading against right now.
 *
 * A recurring market's `deadlineIso` is only its FIRST round's boundary — every later round is
 * derived from the cadence. Reading the literal for a recurring market is what left
 * `cspr-hourly-updown` ("recurring hourly round") pinned to a single deadline eight days out, so
 * it never matured, never resolved, and never paid anyone.
 */
export function effectiveDeadlineMs(def: MarketDefinition, nowMs: number): number {
  const round = currentRound(def.cadence, nowMs);
  return round ? round.deadlineMs : deadlineToMs(def.slug, def.deadlineIso);
}
```

- [ ] **Step 4: Correct the two mislabeled definitions**

In `src/core/catalogue.ts`, set `coin-flip-5m`'s `cadence` to `"5-minute"` and confirm `cspr-hourly-updown`'s is `"hourly"` (it already is). Leave both `deadlineIso` literals in place — they are now the first round's boundary, and the deterministic anchor the tests use. Update the module header's deadline paragraph:

```ts
 * Deadlines and pools are fixed literals on purpose — deterministic data keeps tests stable
 * (no wall-clock drift) and the demo reproducible. For a RECURRING market (`cadence !== "one-shot"`)
 * the literal is only the first round's boundary: every later round is derived from the cadence by
 * `effectiveDeadlineMs`, against an injected clock. Reading the literal directly for a recurring
 * market is the bug that kept "CSPR up or down this hour?" open for eight days.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/catalogue-cadence.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green. `test/catalogue.test.ts` and `test/deploy-plan.test.ts` may assert the old `coin-flip-5m` cadence — update those expectations to `"5-minute"`.

- [ ] **Step 7: Commit**

```bash
git add src/core/catalogue.ts src/core/market-generator.ts test/catalogue-cadence.test.ts test/catalogue.test.ts test/deploy-plan.test.ts
git commit -m "fix(catalogue): a market that says 'this hour' now closes within the hour

Every catalogue deadline was the same Aug 1 literal, so the two markets whose
titles promise a short round carried an eight-day one. Nothing matured, the
Arbiter's sweep never fired, and in 2.7 days of production the economy placed
40 bets and settled nothing. A recurring definition's literal is now only its
first round; the rest derive from the cadence."
```

---

## Task 7: Roll the round

**Files:**
- Create: `src/agent/round-rollover.ts`
- Modify: `src/agent/economy.ts` (after the Arbiter sweep)
- Test: `test/round-rollover.test.ts` (create)

**Interfaces:**
- Consumes: `currentRound` (Task 3); `roundMarketId`, `baseSlug` (Task 4); `effectiveDeadlineMs` (Task 6); `isQuarantined` from `@/agent/market-quarantine`; `container.clock` (Task 2).
- Produces: `rollMaturedRounds(container: Container): Promise<AgentAction[]>` from `@/agent/round-rollover`. `EconomyTickReport` gains `rolloverActions: AgentAction[]`.

- [ ] **Step 1: Write the failing test**

Create `test/round-rollover.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { rollMaturedRounds } from "@/agent/round-rollover";
import { createMockClock } from "@/adapters/mock/mock-clock";
import { roundMarketId } from "@/core/round-id";
import { currentRound } from "@/core/round-schedule";
import { quarantineMarket, __resetQuarantine } from "@/agent/market-quarantine";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-15T13:37:00.000Z");

function containerWith(overrides: Record<string, unknown> = {}) {
  const created: string[] = [];
  return {
    created,
    container: {
      network: "testnet" as const,
      clock: createMockClock(NOW),
      chain: {
        createMarket: vi.fn(async (input: { marketId: string }) => {
          created.push(input.marketId);
          return { deployHash: "0xabc", explorerUrl: "https://x" };
        }),
      },
      store: { list: vi.fn(async () => []) },
      ...overrides,
    } as never,
  };
}

describe("round rollover", () => {
  it("opens the next round of a recurring market whose round has matured", async () => {
    const { container, created } = containerWith();
    await rollMaturedRounds(container);
    const idx = currentRound("hourly", NOW)!.index;
    expect(created).toContain(roundMarketId("cspr-hourly-updown", idx));
  });

  it("is idempotent — a round already open is not created twice", async () => {
    const { container, created } = containerWith();
    await rollMaturedRounds(container);
    const first = created.length;
    await rollMaturedRounds(container);
    expect(created.length).toBe(first);
  });

  it("never rolls a quarantined market", async () => {
    __resetQuarantine();
    quarantineMarket("coin-flip-5m", "UnknownOutcome");
    const { container, created } = containerWith();
    await rollMaturedRounds(container);
    expect(created.some((id) => id.startsWith("coin-flip-5m"))).toBe(false);
    __resetQuarantine();
  });

  it("never rolls a one-shot market", async () => {
    const { container, created } = containerWith();
    await rollMaturedRounds(container);
    expect(created.some((id) => id.startsWith("btc-150k-aug"))).toBe(false);
  });

  it("one market's creation failure does not abort the others", async () => {
    const { container, created } = containerWith({
      chain: {
        createMarket: vi.fn(async (input: { marketId: string }) => {
          if (input.marketId.startsWith("coin-flip-5m")) throw new Error("revert");
          created.push(input.marketId);
          return { deployHash: "0xabc", explorerUrl: "https://x" };
        }),
      },
    });
    await expect(rollMaturedRounds(container)).resolves.toBeDefined();
    expect(created.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/round-rollover.test.ts`
Expected: FAIL — cannot resolve `@/agent/round-rollover`.

- [ ] **Step 3: Implement**

Create `src/agent/round-rollover.ts`:

```ts
/**
 * Round rollover — open the current round of every recurring market that does not have one yet.
 *
 * This is the step that makes the loop a loop. Without it a recurring market matures, settles, and
 * then simply stops: the catalogue quietly shrinks to whatever is still open, the boards stop
 * gaining settlements, and the league can never reach its qualifying count.
 *
 * Creation costs a measured 3.74 CSPR, so rollover is deliberately *idempotent and lazy*: it opens
 * the round the clock is currently in, never backfills missed rounds. A serverless economy WILL
 * miss ticks, and paying to open rounds nobody could have bet on would burn the treasury for
 * markets with no participants.
 */

import type { Container } from "@/lib/container";
import type { AgentAction } from "@/adapters/mock/activity-log";
import { appendAction } from "@/adapters/mock/activity-log";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import { currentRound } from "@/core/round-schedule";
import { roundMarketId } from "@/core/round-id";
import { isQuarantined } from "@/agent/market-quarantine";
import { DEFAULT_CREATION_BOND_MOTES } from "@/adapters/casper/deploy-plan";
import { getNetworkConfig } from "@/config/network";

export async function rollMaturedRounds(container: Container): Promise<AgentAction[]> {
  const nowMs = container.clock.now();
  const open = await container.store.list({ network: container.network });
  const openIds = new Set(open.map((m) => m.slug));
  const actions: AgentAction[] = [];

  for (const def of MARKET_DEFINITIONS) {
    const round = currentRound(def.cadence, nowMs);
    if (!round) continue; // one-shot: nothing to roll
    // Quarantine is a deliberate human decision. Rolling a quarantined market would silently
    // resurrect the very thing an operator switched off, and charge the treasury to do it.
    if (isQuarantined(def.slug)) continue;

    const marketId = roundMarketId(def.slug, round.index);
    if (openIds.has(marketId)) continue; // this round already exists

    // Per-market isolation: one revert must not abort every other market's rollover, or a single
    // misconfigured market freezes the whole economy's cadence.
    try {
      const receipt = await container.chain.createMarket({
        marketId,
        question: def.title,
        category: def.category,
        oracle: getNetworkConfig(container.network).contracts.oracle ?? "",
        feeBps: def.feeBps,
        deadlineMs: round.deadlineMs,
        outcomeKeys: def.outcomes.map((o) => o.key),
        bondMotes: DEFAULT_CREATION_BOND_MOTES,
      });
      actions.push(
        appendAction({
          agent: "Genesis",
          kind: "market_created",
          marketId: `${container.network}:${marketId}`,
          marketTitle: def.title,
          narration: `Round ${round.index} of ${def.title} is open.`,
          deployHash: receipt.deployHash,
          explorerUrl: receipt.explorerUrl,
          simulated: false,
        }),
      );
    } catch (err) {
      console.error(
        "[rollover] could not open the next round — skipped this tick, retrying next: %s",
        JSON.stringify({ slug: def.slug, round: round.index, error: String(err) }),
      );
    }
  }
  return actions;
}
```

Note: if `DEFAULT_CREATION_BOND_MOTES` or `contracts.oracle` do not exist under those exact names, use the names the existing `src/lib/market-create.ts:120` `createMarket` call site uses — that call site is the reference for a correct create.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/round-rollover.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire into the tick**

In `src/agent/economy.ts`, add `rolloverActions: AgentAction[]` to `EconomyTickReport` (documented as "Rounds opened this tick — the step that makes the loop recur"), import `rollMaturedRounds`, and call it immediately after the Arbiter sweep and before the board snapshot, so the boards reflect the settlements that just happened and the new round is visible in the same report:

```ts
  // 3. Roll every recurring market whose round just settled into a fresh one. Resolution is never
  //    throttled, and neither is rollover: a settled market with no successor is a dead surface.
  const rolloverActions = await rollMaturedRounds(container);
```

Add `rolloverActions` to the returned report object.

- [ ] **Step 6: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green. `test/economy-loop.test.ts` may assert an exact report shape — add `rolloverActions` there.

- [ ] **Step 7: Commit**

```bash
git add src/agent/round-rollover.ts src/agent/economy.ts test/round-rollover.test.ts test/economy-loop.test.ts
git commit -m "feat(economy): a settled round opens the next one, so the loop actually loops"
```

---

## Task 8: De-concentrate market and agent selection

Task 1 unfreezes rotation. This task makes concentration structurally impossible rather than merely unlikely, and pins it with a test.

**Files:**
- Modify: `src/agent/prophet.ts:274-288` (`runProphetFleet`)
- Test: `test/prophet-spread.test.ts` (create)

**Interfaces:**
- Consumes: `nextRoundSeq` (Task 1); `baseSlug` (Task 4).
- Produces: `selectRoundTargets(open: Market[], seq: number, count: number): Market[]` exported from `@/agent/prophet` — pure, so the spread property is testable without a chain.

- [ ] **Step 1: Write the failing test**

Create `test/prophet-spread.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectRoundTargets } from "@/agent/prophet";
import type { Market } from "@/core/types";

function markets(n: number): Market[] {
  return Array.from({ length: n }, (_, i) => ({ slug: `m${i}`, category: "casper-native" }) as Market);
}

describe("prophet market spread", () => {
  it("covers every open market before repeating any", () => {
    const open = markets(19);
    const seen = new Set<string>();
    for (let seq = 0; seq < 19; seq++) {
      for (const m of selectRoundTargets(open, seq, 1)) seen.add(m.slug);
    }
    expect(seen.size).toBe(19);
  });

  it("bounds concentration well under the 58% production defect", () => {
    const open = markets(19);
    const counts = new Map<string, number>();
    for (let seq = 0; seq < 190; seq++) {
      for (const m of selectRoundTargets(open, seq, 1)) {
        counts.set(m.slug, (counts.get(m.slug) ?? 0) + 1);
      }
    }
    const top = Math.max(...counts.values());
    expect(top / 190).toBeLessThanOrEqual(0.15);
  });

  it("is deterministic for a given seq", () => {
    const open = markets(7);
    expect(selectRoundTargets(open, 3, 2).map((m) => m.slug)).toEqual(
      selectRoundTargets(open, 3, 2).map((m) => m.slug),
    );
  });

  it("never returns more targets than there are open markets", () => {
    expect(selectRoundTargets(markets(2), 0, 5)).toHaveLength(2);
  });

  it("returns nothing when nothing is open", () => {
    expect(selectRoundTargets([], 0, 1)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/prophet-spread.test.ts`
Expected: FAIL — `selectRoundTargets` is not exported from `@/agent/prophet`.

- [ ] **Step 3: Implement**

In `src/agent/prophet.ts`, add above `runProphetFleet`:

```ts
/**
 * Which markets this round's Prophets trade.
 *
 * Pure and deterministic, because concentration is a *property* worth pinning: production spent
 * weeks putting 58% of every bet on a single market, and a spot check of the feed would not have
 * caught it. Striding by round index visits every open market before repeating any, so coverage is
 * structural rather than a consequence of the counter happening to advance.
 */
export function selectRoundTargets(open: Market[], seq: number, count: number): Market[] {
  if (open.length === 0) return [];
  const n = Math.min(count, open.length);
  const picked: Market[] = [];
  for (let i = 0; i < n; i++) {
    picked.push(open[(seq + i) % open.length]);
  }
  return picked;
}
```

Then replace the body of `runProphetFleet` between the `open` filter and the loop:

```ts
  if (open.length === 0) return [];

  const count = Math.min(opts.maxProphets ?? prophetsPerTick(), PROPHETS.length);
  // One target per acting Prophet, strided across the open catalogue — never a single shared
  // target, which is how one market absorbed most of the fleet's stake.
  const targets = selectRoundTargets(open, seq, count);
  const actions: AgentAction[] = [];
  for (let i = 0; i < count; i++) {
    // Rotate the starting agent with the round so a partial fleet is not always the same agent.
    const prophet = PROPHETS[(seq + i) % PROPHETS.length];
    const target = targets[i % targets.length];
    const action = await runProphet(container, prophet, target.slug, seq + i);
    if (action) actions.push(action);
  }
  return actions;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/prophet-spread.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/agent/prophet.ts test/prophet-spread.test.ts
git commit -m "fix(prophet): spread the fleet across the catalogue, and pin the property

Concentration is now a tested property rather than an emergent one — 58% of
production's bets landed on a single market and nothing failed."
```

---

## Task 9: Loop-liveness health checks

A silent zero is how both of these defects survived. Neither may be able to recur unnoticed.

**Files:**
- Modify: `src/core/health.ts`
- Modify: `src/lib/health.ts`
- Test: `test/health-loop.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks (operates on already-collected economy state).
- Produces: two new checks in the `/api/health` payload — `loop.resolution` and `loop.rotation`.

- [ ] **Step 1: Write the failing test**

Create `test/health-loop.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loopChecks } from "@/core/health";

const DAY = 86_400_000;

describe("loop liveness checks", () => {
  it("fails when the economy has bet but never resolved", () => {
    const checks = loopChecks({
      nowMs: 10 * DAY,
      betCount: 40,
      resolutionCount: 0,
      oldestBetMs: 7 * DAY,
      distinctAgents: 1,
      distinctMarkets: 1,
      recentActionCount: 40,
    });
    const resolution = checks.find((c) => c.name === "loop.resolution")!;
    expect(resolution.status).toBe("fail");
    expect(resolution.detail).toMatch(/never resolved|no resolution/i);
  });

  it("passes when resolutions are flowing", () => {
    const checks = loopChecks({
      nowMs: 10 * DAY,
      betCount: 40,
      resolutionCount: 6,
      oldestBetMs: 9.5 * DAY,
      distinctAgents: 4,
      distinctMarkets: 9,
      recentActionCount: 40,
    });
    expect(checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("fails when one agent placed nearly every recent bet", () => {
    const checks = loopChecks({
      nowMs: 10 * DAY,
      betCount: 40,
      resolutionCount: 6,
      oldestBetMs: 9.5 * DAY,
      distinctAgents: 1,
      distinctMarkets: 1,
      recentActionCount: 40,
    });
    const rotation = checks.find((c) => c.name === "loop.rotation")!;
    expect(rotation.status).toBe("fail");
  });

  it("stays quiet on a cold economy rather than crying wolf", () => {
    const checks = loopChecks({
      nowMs: 10 * DAY,
      betCount: 0,
      resolutionCount: 0,
      oldestBetMs: null,
      distinctAgents: 0,
      distinctMarkets: 0,
      recentActionCount: 0,
    });
    expect(checks.every((c) => c.status === "ok")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/health-loop.test.ts`
Expected: FAIL — `loopChecks` is not exported from `@/core/health`.

- [ ] **Step 3: Implement**

In `src/core/health.ts`, following the existing check-shape conventions in that file, add:

```ts
export interface LoopLivenessInput {
  nowMs: number;
  betCount: number;
  resolutionCount: number;
  /** Timestamp of the oldest recorded bet, or null when the economy has never bet. */
  oldestBetMs: number | null;
  distinctAgents: number;
  distinctMarkets: number;
  recentActionCount: number;
}

/** A day of betting with nothing settled means the loop is not closing. */
const RESOLUTION_GRACE_MS = 86_400_000;
/** Below this many distinct markets/agents across a full window, rotation has frozen. */
const MIN_DISTINCT = 2;

/**
 * Does the loop actually close?
 *
 * Both of the defects this guards against were invisible: every other check stayed green while
 * production placed forty bets, settled nothing, and sent every one of them from the same agent to
 * the same market. A check that only watches subsystems will report a healthy economy that is not
 * running.
 */
export function loopChecks(input: LoopLivenessInput): HealthCheck[] {
  const checks: HealthCheck[] = [];

  const bettingLongEnough =
    input.oldestBetMs !== null && input.nowMs - input.oldestBetMs >= RESOLUTION_GRACE_MS;
  checks.push(
    bettingLongEnough && input.resolutionCount === 0
      ? {
          name: "loop.resolution",
          status: "fail",
          detail: `${input.betCount} bet(s) recorded over more than a day and no resolution — the loop is not closing`,
        }
      : {
          name: "loop.resolution",
          status: "ok",
          detail:
            input.resolutionCount > 0
              ? `${input.resolutionCount} resolution(s) recorded — the loop closes`
              : "not enough betting history to judge resolution yet",
        },
  );

  const frozen =
    input.recentActionCount >= 10 &&
    (input.distinctAgents < MIN_DISTINCT || input.distinctMarkets < MIN_DISTINCT);
  checks.push(
    frozen
      ? {
          name: "loop.rotation",
          status: "fail",
          detail: `${input.recentActionCount} recent action(s) span only ${input.distinctAgents} agent(s) and ${input.distinctMarkets} market(s) — rotation has frozen`,
        }
      : {
          name: "loop.rotation",
          status: "ok",
          detail: `recent activity spans ${input.distinctAgents} agent(s) and ${input.distinctMarkets} market(s)`,
        },
  );

  return checks;
}
```

Match `HealthCheck`'s existing exported shape in that file; if the status union differs, use the file's own names.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/health-loop.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into `/api/health`**

In `src/lib/health.ts`, derive `LoopLivenessInput` from the already-hydrated activity log (count `kind === "bet_placed"` and `kind === "market_resolved"`, and the distinct `agent` / `baseSlug(marketId)` values across the recorded actions), and append `loopChecks(...)` to the assembled check list.

- [ ] **Step 6: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green. `test/health.test.ts` may assert an exact check count — update it.

- [ ] **Step 7: Commit**

```bash
git add src/core/health.ts src/lib/health.ts test/health-loop.test.ts test/health.test.ts
git commit -m "feat(health): report when the loop stops closing or rotation freezes

Every existing check stayed green through both defects. A subsystem-only health
report describes a healthy economy that is not actually running."
```

---

## Task 10: Treasury runway for recurring rounds

Recurring rounds spend real CSPR on a schedule. Before any cadence goes live, the runway must be computed and visible.

**Files:**
- Modify: `src/core/cadence.ts`
- Test: `test/round-runway.test.ts` (create)

**Interfaces:**
- Consumes: `cadenceIntervalMs` (Task 3).
- Produces: `roundsPerDay(cadence: MarketCadence): number`; `dailyRolloverCostMotes(cadences: MarketCadence[]): string`; `runwayDays(treasuryMotes: string, dailyCostMotes: string): number` from `@/core/cadence`.

- [ ] **Step 1: Write the failing test**

Create `test/round-runway.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { roundsPerDay, dailyRolloverCostMotes, runwayDays } from "@/core/cadence";

const CSPR = 1_000_000_000n;

describe("round runway", () => {
  it("counts rounds per day per cadence", () => {
    expect(roundsPerDay("hourly")).toBe(24);
    expect(roundsPerDay("5-minute")).toBe(288);
    expect(roundsPerDay("weekly")).toBe(0);
    expect(roundsPerDay("one-shot")).toBe(0);
  });

  it("prices a day of rollover at the measured create cost", () => {
    // 24 rounds/day x 3.74 CSPR measured create = 89.76 CSPR
    const cost = BigInt(dailyRolloverCostMotes(["hourly"]));
    expect(cost).toBe(8976n * CSPR / 100n);
  });

  it("computes runway in whole days, rounding down", () => {
    expect(runwayDays((1000n * CSPR).toString(), (100n * CSPR).toString())).toBe(10);
    expect(runwayDays((150n * CSPR).toString(), (100n * CSPR).toString())).toBe(1);
  });

  it("a zero daily cost is unbounded runway, not a divide-by-zero", () => {
    expect(runwayDays((1000n * CSPR).toString(), "0")).toBe(Number.POSITIVE_INFINITY);
  });

  it("an empty treasury has zero runway", () => {
    expect(runwayDays("0", (100n * CSPR).toString())).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/round-runway.test.ts`
Expected: FAIL — `roundsPerDay` is not exported from `@/core/cadence`.

- [ ] **Step 3: Implement**

In `src/core/cadence.ts`, add:

```ts
import type { MarketCadence } from "@/core/types";
import { cadenceIntervalMs } from "@/core/round-schedule";

const DAY_MS = 86_400_000;
/** Measured on testnet: a typical `create_market` costs 3.74 CSPR net. Never re-estimate this. */
const CREATE_COST_MOTES = 3_740_000_000n;

/** How many rounds of a cadence open in a day. Weekly and one-shot do not roll daily. */
export function roundsPerDay(cadence: MarketCadence): number {
  const interval = cadenceIntervalMs(cadence);
  if (interval === null || interval >= DAY_MS) return 0;
  return Math.floor(DAY_MS / interval);
}

/** What a day of rollover costs the treasury across the given markets' cadences. */
export function dailyRolloverCostMotes(cadences: MarketCadence[]): string {
  let total = 0n;
  for (const c of cadences) total += BigInt(roundsPerDay(c)) * CREATE_COST_MOTES;
  return total.toString();
}

/**
 * Whole days of rollover the treasury can fund.
 *
 * Floored on purpose: a runway figure that rounds up tells an operator they have another day when
 * they do not, and an economy that runs out mid-round burns gas on reverts — it drains FASTER when
 * it is nearly broke.
 */
export function runwayDays(treasuryMotes: string, dailyCostMotes: string): number {
  const daily = BigInt(dailyCostMotes);
  if (daily === 0n) return Number.POSITIVE_INFINITY;
  return Number(BigInt(treasuryMotes) / daily);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/round-runway.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/core/cadence.ts test/round-runway.test.ts
git commit -m "feat(cadence): price recurring rounds against the treasury before enabling them"
```

---

## Task 11: Choose the cadence, deploy, verify

The only task with a live-money decision. It is deliberately last: everything above is verifiable offline.

**Files:**
- Modify: `src/core/catalogue.ts` (final cadence assignment)
- Modify: `docs/OPS.md` (rollover runbook)

- [ ] **Step 1: Compute the runway**

Run a one-off script against the live treasury balance from `/api/health` and `dailyRolloverCostMotes` for the proposed cadence set. Record the number.

- [ ] **Step 2: Choose the cadence against the operator's runway floor**

The operator's stated floor is an **8-week minimum**. Assign the fastest cadence set that holds it. Expected shape: `hourly` on `cspr-hourly-updown`, `5-minute` on `coin-flip-5m` only if the runway allows, `one-shot` elsewhere. If 5-minute does not hold the floor, demote `coin-flip-5m` to `hourly` and say so in the commit message.

- [ ] **Step 3: Document the decision**

Add a "Recurring rounds" section to `docs/OPS.md` covering: the chosen cadence per market, the measured daily cost, the computed runway, how to change a cadence, and the fact that rollover never backfills missed rounds.

- [ ] **Step 4: Run the full gate**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: all green.

- [ ] **Step 5: Commit and deploy**

```bash
git add src/core/catalogue.ts docs/OPS.md
git commit -m "feat(economy): recurring rounds go live at the cadence the treasury sustains"
```

- [ ] **Step 6: Verify the exit criteria in production**

Within one hour of deploy, confirm all four:

```bash
curl -s https://casper.playhunch.xyz/api/agent/activity?limit=40 | grep -c market_resolved
curl -s https://casper.playhunch.xyz/api/agent/activity?limit=40 | grep -c payout_claimed
curl -s https://casper.playhunch.xyz/api/health | grep -o '"loop.resolution","status":"[a-z]*"'
curl -s https://casper.playhunch.xyz/api/boards | grep -o '"agentPnl":\[[^]]*'
```

Expected: non-zero resolution and claim counts; `loop.resolution` `ok`; a non-empty `agentPnl`.

**If `agentPnl` is still empty while resolutions are flowing,** that is the Phase 1 indexer-scope defect (the events port is scoped to `contracts.vaultV2` alone while bets route to five v1 packages first) — not a Phase 0 regression. Record it and proceed to Phase 1.

---

## Self-review

**Spec coverage** — §4.1 scheduler → Tasks 2, 3, 4, 7. §4.2 mislabeled markets → Task 6; the 1072 CSPR escrow needs no code (default is to let the existing round run to its Aug 1 deadline, and Task 4's `#`-suffixed ids mean new rounds never collide with it). §4.3 selection → Task 8. §4.4 narration → Task 1 (the identical strings were the frozen seq feeding a deterministic mock LLM; no separate task needed). §4.5 treasury → Tasks 10, 11. §4.6 Genesis → Task 7 (rollover creates markets on the recurring cadence; broader Genesis signal-driven creation is deliberately left to Phase 1, since the catalogue does not need to grow for the loop to close).

**Placeholder scan** — none. Task 7 Step 3 carries a named fallback for two constants rather than a TODO, pointing at the exact reference call site.

**Type consistency** — `nextRoundSeq` (1), `ClockPort.now` (2), `currentRound`/`cadenceIntervalMs` (3), `roundMarketId`/`baseSlug` (4), `setLedgerClock` (5), `effectiveDeadlineMs` (6), `rollMaturedRounds` (7), `selectRoundTargets` (8), `loopChecks` (9), `roundsPerDay`/`dailyRolloverCostMotes`/`runwayDays` (10) — each defined once and consumed under the same name.
