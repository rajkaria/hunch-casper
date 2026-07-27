/**
 * In-process settlement ledger — the mutable state behind the mock `MarketStorePort`. It seeds
 * each market from the config-driven catalogue, records escrowed bets so pools + implied odds go
 * live, and settles markets through the pure `computeMarketPayouts` engine (never an LLM).
 *
 * It is a module-level singleton so state survives across requests within a process (the demo
 * shows a bet move the odds, then a resolution pay out). The chain remains the source of truth
 * for money; this ledger is a fast index that may reset on a cold start — exactly the role the
 * spec assigns the off-chain store. The real Supabase/SQLite adapter drops in behind the
 * same port with no core change.
 */

import { buildMarket } from "@/core/catalogue";
import { findDefinition } from "@/adapters/mock/market-source";
import { computeMarketPayouts } from "@/core/market-payout";
import type { Market, MarketStatus } from "@/core/types";
import type { RecordBetInput, SettledEntry, SettlementRecord } from "@/ports/market-store";
import type { ClockPort } from "@/ports/clock";
import { createSystemClock } from "@/adapters/system-clock";
import { isCasperNetwork } from "@/config/network";

export interface LedgerEntry {
  market: Market;
  /** bettor -> outcomeKey -> motes. */
  stakes: Record<string, Record<string, string>>;
  settlement: SettlementRecord | null;
}

const ledger = new Map<string, LedgerEntry>();

/**
 * At-most-once keys for bets already recorded — on-chain transaction hashes.
 *
 * Confirmation became a poll rather than a single blocking wait (the visitor should see their
 * transaction hash the moment the chain has it, not 15-20s later when it executes), which means the
 * same executed transaction is observed by more than one request. Without this set each observation
 * would add the stake again and the boards would claim money the vault never received. Persisted
 * and unioned across instances exactly like the oracle's resolution keys — an idempotence key that
 * only one lambda remembers does not prevent anything.
 */
const recordedBets = new Set<string>();

/**
 * The catalogue's seed pools are **house launch liquidity**, not a display fiction: a market
 * opens with the house staked on every outcome so it is never a dead 0/0 book, and the house
 * then wins or loses exactly like any other participant. We model that as one clearly-labelled
 * participant (`house:liquidity`) whose stake IS the seed pool. Because the house is a real
 * staker, the pure payout engine mirrors the on-chain vault's claim() MATH exactly: given the
 * same escrowed stakes it returns the same payouts. A faithful deployment escrows these same
 * house bets on-chain at launch — the deploy plan carries them (`MarketDeployPlan.seedBets`) so
 * the on-chain pools match the catalogue. (Renamed from the earlier "seed:liquidity" framing per
 * the S5 review, which correctly flagged that calling it a demo-only fiction made the
 * exact-mirror claim untrue for an unseeded on-chain market.)
 */
const HOUSE_BETTOR = "house:liquidity";

/** Parse a `network:slug` market id into its parts, or throw. */
function parseMarketId(marketId: string): { network: "testnet" | "mainnet"; slug: string } {
  const idx = marketId.indexOf(":");
  const network = idx >= 0 ? marketId.slice(0, idx) : "";
  const slug = idx >= 0 ? marketId.slice(idx + 1) : marketId;
  if (!isCasperNetwork(network)) {
    throw new Error(`marketId must be '<network>:<slug>', got ${JSON.stringify(marketId)}`);
  }
  return { network, slug };
}

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

/** Effective status: an open market at or past its deadline is `locked` (bets closed), matching
 * the on-chain vault which reverts a `bet` once `block_time >= deadline`. Derived, not stored. */
function effectiveStatus(m: Market): MarketStatus {
  if (m.status === "open" && ledgerClock.now() >= Date.parse(m.deadlineIso)) return "locked";
  return m.status;
}

function cloneMarket(m: Market): Market {
  return {
    ...m,
    status: effectiveStatus(m),
    outcomes: m.outcomes.map((o) => ({ ...o })),
    poolByOutcomeMotes: { ...m.poolByOutcomeMotes },
  };
}

/**
 * Refresh the catalogue-owned COPY of a stored entry: title, subtitle, category, outcome labels.
 *
 * Money and time — pools, stakes, status, deadline, fee — are the ledger's and are never
 * overwritten: restating them under a market that already holds stakes would rewrite economics
 * that bettors already acted on.
 *
 * Without this, a persisted entry freezes its copy at the moment it was first touched. Production
 * hit exactly that: after the recurring round's cadence became daily and the catalogue was renamed
 * to "CSPR up or down today?", the live site kept serving "CSPR up or down this hour?" from a KV
 * entry seeded before the rename — while every freshly-spawned child round read "today". A market
 * whose title outruns its cadence is the defect the daily-cadence work existed to end.
 */
function refreshCopy(entry: LedgerEntry): void {
  const def = findDefinition(parseMarketId(entry.market.id).slug);
  if (!def) return; // a market that has left the catalogue keeps the copy it last had
  const fresh = buildMarket(def, entry.market.network);
  entry.market.title = fresh.title;
  if (fresh.subtitle === undefined) delete entry.market.subtitle;
  else entry.market.subtitle = fresh.subtitle;
  entry.market.category = fresh.category;
  entry.market.outcomes = entry.market.outcomes.map((o) => {
    const current = fresh.outcomes.find((f) => f.key === o.key);
    return current ? { ...o, label: current.label } : o;
  });
}

/** Seed (or fetch) the ledger entry for a market id from the catalogue. */
function ensureEntry(marketId: string): LedgerEntry {
  const existing = ledger.get(marketId);
  if (existing) {
    refreshCopy(existing);
    return existing;
  }
  const { network, slug } = parseMarketId(marketId);
  const def = findDefinition(slug);
  if (!def) throw new Error(`unknown market '${slug}'`);
  const market = buildMarket(def, network);
  // The house is a real staker: its stake IS the seed pool, so settlement stays faithful to the
  // on-chain vault (which sees these as ordinary escrowed bets placed at launch).
  const houseStake: Record<string, string> = {};
  for (const [key, motes] of Object.entries(market.poolByOutcomeMotes)) {
    if (BigInt(motes) > 0n) houseStake[key] = motes;
  }
  const stakes: Record<string, Record<string, string>> = {};
  if (Object.keys(houseStake).length > 0) stakes[HOUSE_BETTOR] = houseStake;
  const entry: LedgerEntry = { market, stakes, settlement: null };
  ledger.set(marketId, entry);
  return entry;
}

/** The live market for `network:slug`, or `null` if the slug is not in the catalogue. */
export function ledgerGet(marketId: string): Market | null {
  const { slug } = parseMarketId(marketId);
  if (!findDefinition(slug)) return null;
  return cloneMarket(ensureEntry(marketId).market);
}

/** Whether this bet's at-most-once key has already been recorded on this instance. */
export function ledgerHasRecordedBet(dedupeKey: string): boolean {
  return recordedBets.has(dedupeKey);
}

/** Record an escrowed bet: grow the outcome pool, the total, and the bettor's stake. */
export function ledgerRecordBet(input: RecordBetInput): Market {
  const entry = ensureEntry(input.marketId);
  // At-most-once, BEFORE the status check: a market that locked between the bet and a late-arriving
  // replay must not turn an already-counted bet into a "betting is closed" error. The stake is on
  // the boards; the caller is asking about a bet that already succeeded.
  if (input.dedupeKey !== undefined && recordedBets.has(input.dedupeKey)) {
    return cloneMarket(entry.market);
  }
  const status = effectiveStatus(entry.market);
  if (status !== "open") {
    throw new Error(`market ${input.marketId} is ${status} — betting is closed`);
  }
  if (!entry.market.outcomes.some((o) => o.key === input.outcomeKey)) {
    throw new Error(`'${input.outcomeKey}' is not an outcome of ${input.marketId}`);
  }
  if (!/^\d+$/.test(input.amountMotes) || BigInt(input.amountMotes) <= 0n) {
    throw new Error(`amountMotes must be a positive integer motes string`);
  }
  const amount = BigInt(input.amountMotes);
  const pools = entry.market.poolByOutcomeMotes;
  pools[input.outcomeKey] = (BigInt(pools[input.outcomeKey] ?? "0") + amount).toString();
  entry.market.totalStakedMotes = (BigInt(entry.market.totalStakedMotes) + amount).toString();

  const byOutcome = (entry.stakes[input.bettor] ??= {});
  byOutcome[input.outcomeKey] = (BigInt(byOutcome[input.outcomeKey] ?? "0") + amount).toString();

  // Marked only after the bet is fully applied: a key burnt by a throw above would make a retry of
  // a bet that never landed silently succeed.
  if (input.dedupeKey !== undefined) recordedBets.add(input.dedupeKey);

  return cloneMarket(entry.market);
}

/** Settle a market through the pure payout engine. Idempotent: re-settling returns the record. */
export function ledgerSettle(marketId: string, winningOutcomeKey: string | null): SettlementRecord {
  const entry = ensureEntry(marketId);
  if (entry.settlement) return entry.settlement;

  const manifest = computeMarketPayouts({
    outcomeKeys: entry.market.outcomes.map((o) => o.key),
    poolByOutcomeMotes: entry.market.poolByOutcomeMotes,
    stakesByBettor: entry.stakes,
    feeBps: entry.market.feeBps,
    winningOutcomeKey,
  });

  entry.market.status = manifest.mode === "void" ? "void" : "resolved";
  entry.market.resolvedOutcomeKey = manifest.winningOutcomeKey ?? undefined;
  const record: SettlementRecord = {
    marketId,
    status: entry.market.status === "void" ? "void" : "resolved",
    winningOutcomeKey: manifest.winningOutcomeKey,
    manifest,
  };
  entry.settlement = record;
  return record;
}

/** The settlement record for a market, or `null` if never touched / not yet settled. */
export function ledgerSettlementFor(marketId: string): SettlementRecord | null {
  const { slug } = parseMarketId(marketId);
  if (!findDefinition(slug)) return null;
  return ledger.get(marketId)?.settlement ?? null;
}

/** Deep-ish copy of a stakes map so callers can't mutate ledger state through the returned entry. */
function cloneStakes(stakes: Record<string, Record<string, string>>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [bettor, byOutcome] of Object.entries(stakes)) out[bettor] = { ...byOutcome };
  return out;
}

/**
 * Every settled market's stakes + manifest (optionally filtered to one network) — the raw input
 * the pure agent-PnL leaderboard folds over. Only markets with a computed manifest are included.
 */
export function ledgerSettledEntries(network?: "testnet" | "mainnet"): SettledEntry[] {
  const out: SettledEntry[] = [];
  for (const [marketId, entry] of ledger) {
    const manifest = entry.settlement?.manifest;
    if (!manifest) continue;
    if (network && parseMarketId(marketId).network !== network) continue;
    out.push({ marketId, stakesByBettor: cloneStakes(entry.stakes), manifest });
  }
  return out;
}

/** Test-only: clear all in-process settlement state so cases don't contaminate each other. */
export function __resetLedger(): void {
  ledger.clear();
  recordedBets.clear();
}

/** JSON-safe snapshot of the FULL settlement state (Map → array of entries) for KV persistence. */
export interface SettlementSnapshot {
  entries: [string, LedgerEntry][];
  /** At-most-once keys of bets already recorded. Optional: absent in envelopes written before
   * confirmation became a poll, which simply start the set empty. */
  recordedBets?: string[];
}

/** Export the full ledger, deep-cloned so later mutations never leak into a captured snapshot. */
export function exportSettlementState(): SettlementSnapshot {
  return {
    entries: structuredClone(Array.from(ledger.entries())),
    recordedBets: [...recordedBets],
  };
}

/** Restore a snapshot, REPLACING (not merging) current state. Idempotent. */
export function importSettlementState(snapshot: SettlementSnapshot): void {
  ledger.clear();
  for (const [marketId, entry] of structuredClone(snapshot.entries)) ledger.set(marketId, entry);
  recordedBets.clear();
  for (const key of snapshot.recordedBets ?? []) recordedBets.add(key);
}
