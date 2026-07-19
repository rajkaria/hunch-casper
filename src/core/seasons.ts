/**
 * Seasons — the Casper Agent League's scoring windows.
 *
 * A permanent all-time leaderboard is a closed door. Whoever started first is ahead, the gap only
 * grows, and a developer arriving in month four can see they will never rank. Seasons reset that:
 * every window is a fresh contest with its own standings, which is what turns a registry into a
 * reason to show up.
 *
 * ## Windows are half-open, and it matters
 *
 * `[start, end)`. The boundary is where a naive implementation double-counts: a bet at exactly the
 * boundary timestamp lands in both the closing season and the opening one, an agent's stake is
 * scored twice, and the standings quietly disagree with the chain. Half-open intervals make that
 * impossible by construction rather than by care.
 *
 * ## Standings rank calibration first
 *
 * The same reasoning as the reputation API, and the reason the roadmap puts prizes on calibration:
 * ranking a season by PnL crowns whoever took the most risk during a lucky window. Ranking by
 * Brier score crowns whoever's probabilities were worth reading. A participation floor keeps a
 * one-bet wonder off the top of a board that is about to pay out.
 *
 * Pure: windows are derived from a supplied epoch and index, never from the wall clock, so a
 * season's standings are reproducible forever.
 */

import type { ChainEvent } from "@/ports/events";
import { buildAgentRecords, type AgentRecord, type MarketMeta } from "@/core/agent-record";

export type SeasonCadence = "weekly" | "monthly";

/**
 * League epoch — 2026-07-13T00:00:00Z, a Monday, so weekly seasons align with calendar weeks with
 * no timezone arithmetic anywhere.
 *
 * A fixed literal, not a deploy-time value: a shifting epoch renumbers every season and
 * invalidates the archive. It must also be in the PAST — an epoch in the future puts the current
 * season at a negative index, and the archive (which counts down to zero) comes back empty while
 * looking perfectly healthy. `test/seasons.test.ts` pins both properties.
 */
export const LEAGUE_EPOCH_MS = Date.parse("2026-07-13T00:00:00.000Z");

export interface Season {
  /** Stable id, e.g. `weekly-3`. Used as the archive key and in meta-market slugs. */
  id: string;
  cadence: SeasonCadence;
  /** Zero-based index from the league epoch. */
  index: number;
  /** Inclusive start, epoch ms. */
  startMs: number;
  /** EXCLUSIVE end, epoch ms — a bet at exactly `endMs` belongs to the next season. */
  endMs: number;
}

/** Seven days, in ms. */
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A "month" is 28 days rather than a calendar month. Calendar months are 28–31 days long, so a
 * calendar league would hand February's agents a materially shorter window to earn the same prize
 * — and the standings would not be comparable across seasons. A fixed length is fair and, being
 * arithmetic, reproducible with no timezone in sight.
 */
export const MONTH_MS = 28 * 24 * 60 * 60 * 1000;

export function seasonLengthMs(cadence: SeasonCadence): number {
  return cadence === "weekly" ? WEEK_MS : MONTH_MS;
}

/** The season containing `atMs`, counted from `epochMs`. */
export function seasonAt(cadence: SeasonCadence, epochMs: number, atMs: number): Season {
  const length = seasonLengthMs(cadence);
  // Floor, so a timestamp before the epoch yields a negative index rather than silently clamping
  // to season 0 and mixing pre-league history into the first standings.
  const index = Math.floor((atMs - epochMs) / length);
  const startMs = epochMs + index * length;
  return { id: `${cadence}-${index}`, cadence, index, startMs, endMs: startMs + length };
}

/** The season with a given index. */
export function seasonByIndex(cadence: SeasonCadence, epochMs: number, index: number): Season {
  const length = seasonLengthMs(cadence);
  const startMs = epochMs + index * length;
  return { id: `${cadence}-${index}`, cadence, index, startMs, endMs: startMs + length };
}

/** Whether a timestamp falls in a season's half-open window. */
export function inSeason(season: Season, timestampMs: number): boolean {
  return timestampMs >= season.startMs && timestampMs < season.endMs;
}

/**
 * Events whose timestamp falls inside a season.
 *
 * `market_created` events are carried through regardless of when they happened: without the
 * creation event the fold has no fee, no outcome list, and no way to price a bet, so every record
 * in the season would be dropped as "market with no market_created". A market opened in season 2
 * and bet in season 3 is normal, and the season's standings must still be able to score it.
 */
export function eventsInSeason(events: readonly ChainEvent[], season: Season): ChainEvent[] {
  return events.filter((e) => e.kind === "market_created" || inSeason(season, e.timestampMs));
}

export interface SeasonStanding extends AgentRecord {
  rank: number;
  /** Whether this agent cleared the participation floor and is eligible to win. */
  eligible: boolean;
}

/**
 * Settled forecasts an agent needs before it can top a season.
 *
 * The same reasoning as `META_MIN_SETTLED`, applied to a board with prize money on it: without a
 * floor, one lucky bet produces a perfect Brier score and wins the season. Higher than the
 * meta-market floor because a season is longer and the prize is real.
 */
export const SEASON_MIN_SETTLED = 5;

/**
 * Rank a season's agents.
 *
 * Eligible agents (those clearing the floor) come first, ordered by calibration and then PnL;
 * ineligible ones follow so they are still visible — an agent building toward eligibility should
 * be able to see itself on the board, and hiding it would make the floor look arbitrary.
 */
export function seasonStandings(
  events: readonly ChainEvent[],
  season: Season,
  meta: Record<string, MarketMeta> = {},
): SeasonStanding[] {
  const records = buildAgentRecords(eventsInSeason(events, season), meta);
  const eligible = records.filter((r) => r.calibration.sampleCount >= SEASON_MIN_SETTLED);
  const rest = records.filter((r) => r.calibration.sampleCount < SEASON_MIN_SETTLED);
  return [...eligible, ...rest].map((record, i) => ({
    ...record,
    rank: i + 1,
    eligible: record.calibration.sampleCount >= SEASON_MIN_SETTLED,
  }));
}

/**
 * The season's winner, or `null` when nobody cleared the participation floor.
 *
 * `null` means the league meta-market VOIDS and refunds rather than crowning someone on thin
 * evidence. A season that pays out on one lucky bet teaches exactly the wrong lesson about what
 * the board measures.
 */
export function seasonWinner(standings: readonly SeasonStanding[]): SeasonStanding | null {
  return standings.find((s) => s.eligible) ?? null;
}

export interface SeasonArchiveEntry {
  season: Season;
  standings: SeasonStanding[];
  winner: string | null;
  /** Whether the season's window has closed at the supplied time. */
  closed: boolean;
}

/**
 * Standings for every season from the epoch up to `nowMs`, newest first.
 *
 * `closed` is computed against the supplied clock rather than assumed: an open season's standings
 * are provisional, and a UI that presents them as final would be lying about a board that is still
 * moving.
 */
export function seasonArchive(
  events: readonly ChainEvent[],
  cadence: SeasonCadence,
  epochMs: number,
  nowMs: number,
  meta: Record<string, MarketMeta> = {},
): SeasonArchiveEntry[] {
  const current = seasonAt(cadence, epochMs, nowMs);
  const entries: SeasonArchiveEntry[] = [];
  for (let index = current.index; index >= 0; index--) {
    const season = seasonByIndex(cadence, epochMs, index);
    const standings = seasonStandings(events, season, meta);
    entries.push({
      season,
      standings,
      winner: seasonWinner(standings)?.agent ?? null,
      closed: nowMs >= season.endMs,
    });
  }
  return entries;
}
