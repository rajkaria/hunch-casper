/**
 * League seasons.
 *
 * The bug this suite exists to prevent is boundary double-counting: with inclusive intervals, a
 * bet at exactly the season boundary is scored in both the closing season and the opening one, and
 * the standings quietly stop agreeing with the chain. Half-open windows make that impossible, and
 * the property test pins it across every event in a long log.
 *
 * The other claim is that a season with prize money on it cannot be won by one lucky bet.
 */

import { describe, it, expect } from "vitest";
import {
  LEAGUE_EPOCH_MS,
  MONTH_MS,
  SEASON_MIN_SETTLED,
  WEEK_MS,
  eventsInSeason,
  inSeason,
  seasonArchive,
  seasonAt,
  seasonByIndex,
  seasonStandings,
  seasonWinner,
} from "@/core/seasons";
import { GET as leagueGET } from "@/app/api/league/route";
import { mockEvent } from "@/adapters/mock/mock-events";
import type { ChainEvent } from "@/ports/events";

const EPOCH = LEAGUE_EPOCH_MS;

describe("the league epoch", () => {
  it("is a Monday, so weekly seasons align with calendar weeks", () => {
    expect(new Date(LEAGUE_EPOCH_MS).getUTCDay()).toBe(1);
  });

  it("is in the past — a future epoch silently empties the archive", () => {
    // The current season would sit at a negative index and the archive, counting down to zero,
    // would return nothing while looking perfectly healthy.
    expect(LEAGUE_EPOCH_MS).toBeLessThan(Date.parse("2026-07-19T00:00:00.000Z"));
    expect(seasonAt("weekly", LEAGUE_EPOCH_MS, Date.now()).index).toBeGreaterThanOrEqual(0);
  });
});

describe("season windows", () => {
  it("indexes from the epoch", () => {
    expect(seasonAt("weekly", EPOCH, EPOCH).index).toBe(0);
    expect(seasonAt("weekly", EPOCH, EPOCH + WEEK_MS).index).toBe(1);
    expect(seasonAt("weekly", EPOCH, EPOCH + WEEK_MS * 3 + 1).index).toBe(3);
    expect(seasonAt("monthly", EPOCH, EPOCH + MONTH_MS).index).toBe(1);
  });

  it("uses a fixed 28-day month so every season is the same length", () => {
    // Calendar months run 28–31 days: February's agents would get a materially shorter window to
    // earn the same prize, and standings would not be comparable across seasons.
    const first = seasonByIndex("monthly", EPOCH, 0);
    const second = seasonByIndex("monthly", EPOCH, 1);
    expect(second.startMs - first.startMs).toBe(MONTH_MS);
    expect(first.endMs - first.startMs).toBe(second.endMs - second.startMs);
  });

  it("floors below the epoch instead of clamping pre-league history into season 0", () => {
    expect(seasonAt("weekly", EPOCH, EPOCH - 1).index).toBe(-1);
  });

  it("is half-open: the boundary belongs to the NEXT season only", () => {
    const s0 = seasonByIndex("weekly", EPOCH, 0);
    const s1 = seasonByIndex("weekly", EPOCH, 1);
    expect(inSeason(s0, s0.startMs)).toBe(true);
    expect(inSeason(s0, s0.endMs)).toBe(false);
    expect(inSeason(s1, s0.endMs)).toBe(true);
    expect(s0.endMs).toBe(s1.startMs);
  });

  it("never counts a bet in two seasons — the property that keeps standings honest", () => {
    const bets: ChainEvent[] = Array.from({ length: 200 }, (_, i) =>
      mockEvent({
        kind: "bet_placed",
        marketId: "m",
        blockHeight: 100 + i,
        bettor: "a",
        outcomeKey: "yes",
        amountMotes: "1",
        // Deliberately includes exact boundary timestamps.
        timestampMs: EPOCH + Math.floor((i * WEEK_MS) / 4),
      }),
    );
    const candidates = Array.from({ length: 64 }, (_, i) => i - 2); // -2 … 61, covering every bet
    for (const bet of bets) {
      const owning = candidates.filter((index) =>
        inSeason(seasonByIndex("weekly", EPOCH, index), bet.timestampMs),
      );
      expect(owning).toHaveLength(1);
      // …and it is the season `seasonAt` reports, so lookup and membership agree.
      expect(owning[0]).toBe(seasonAt("weekly", EPOCH, bet.timestampMs).index);
    }
  });

  it("gives every season a stable id", () => {
    expect(seasonByIndex("weekly", EPOCH, 7).id).toBe("weekly-7");
    expect(seasonByIndex("monthly", EPOCH, 2).id).toBe("monthly-2");
  });
});

describe("eventsInSeason", () => {
  const season = seasonByIndex("weekly", EPOCH, 1);

  it("keeps bets inside the window and drops those outside", () => {
    const inside = mockEvent({ kind: "bet_placed", marketId: "m", timestampMs: season.startMs + 10 });
    const before = mockEvent({ kind: "bet_placed", marketId: "m", timestampMs: season.startMs - 10 });
    const after = mockEvent({ kind: "bet_placed", marketId: "m", timestampMs: season.endMs + 10 });
    expect(eventsInSeason([inside, before, after], season)).toEqual([inside]);
  });

  it("always carries creations through, whenever they happened", () => {
    // Without the creation event the fold has no fee and no outcome list, so every record in the
    // season would be dropped as "market with no market_created". Markets outlive seasons.
    const created = mockEvent({
      kind: "market_created",
      marketId: "m",
      outcomeKeys: ["yes", "no"],
      timestampMs: EPOCH - WEEK_MS,
    });
    expect(eventsInSeason([created], season)).toEqual([created]);
  });
});

describe("season standings", () => {
  const season = seasonByIndex("weekly", EPOCH, 0);

  /** A log where `agent:steady` settles `count` markets and `agent:lucky` settles exactly one. */
  function log(count: number): ChainEvent[] {
    const events: ChainEvent[] = [];
    let height = 100;
    for (let i = 0; i < count; i++) {
      const marketId = `m${i}`;
      const ts = season.startMs + i * 1000;
      events.push(
        mockEvent({
          kind: "market_created",
          marketId,
          blockHeight: height++,
          feeBps: 200,
          outcomeKeys: ["yes", "no"],
          timestampMs: ts,
        }),
        mockEvent({
          kind: "bet_placed",
          marketId,
          blockHeight: height++,
          bettor: "agent:steady",
          outcomeKey: "yes",
          amountMotes: "1000000000",
          timestampMs: ts + 1,
        }),
        mockEvent({
          kind: "bet_placed",
          marketId,
          blockHeight: height++,
          bettor: "agent:filler",
          outcomeKey: "no",
          amountMotes: "1000000000",
          timestampMs: ts + 2,
        }),
        mockEvent({
          kind: "market_resolved",
          marketId,
          blockHeight: height++,
          outcomeKey: "yes",
          oracleId: "arbiter",
          timestampMs: ts + 3,
        }),
      );
    }
    // One lucky market for `agent:lucky`, won outright.
    const luckyTs = season.startMs + 90_000;
    events.push(
      mockEvent({
        kind: "market_created",
        marketId: "lucky",
        blockHeight: height++,
        feeBps: 200,
        outcomeKeys: ["yes", "no"],
        timestampMs: luckyTs,
      }),
      mockEvent({
        kind: "bet_placed",
        marketId: "lucky",
        blockHeight: height++,
        bettor: "agent:filler",
        outcomeKey: "yes",
        amountMotes: "9000000000",
        timestampMs: luckyTs + 1,
      }),
      mockEvent({
        kind: "bet_placed",
        marketId: "lucky",
        blockHeight: height++,
        bettor: "agent:lucky",
        outcomeKey: "yes",
        amountMotes: "1000000000",
        timestampMs: luckyTs + 2,
      }),
      mockEvent({
        kind: "market_resolved",
        marketId: "lucky",
        blockHeight: height++,
        outcomeKey: "yes",
        oracleId: "arbiter",
        timestampMs: luckyTs + 3,
      }),
    );
    return events;
  }

  it("will not crown an agent below the participation floor, however good its score looks", () => {
    // `agent:lucky` has a perfect Brier score off one bet. A season with prize money must not be
    // won on that, and the meta-market must void rather than pay it out.
    const standings = seasonStandings(log(1), season);
    const lucky = standings.find((s) => s.agent === "agent:lucky")!;
    expect(lucky.calibration.brier).toBe(0);
    expect(lucky.eligible).toBe(false);
    expect(seasonWinner(standings)).toBeNull();
  });

  it("crowns an agent once it clears the floor", () => {
    const standings = seasonStandings(log(SEASON_MIN_SETTLED), season);
    const winner = seasonWinner(standings);
    expect(winner).not.toBeNull();
    expect(winner!.eligible).toBe(true);
    expect(winner!.calibration.sampleCount).toBeGreaterThanOrEqual(SEASON_MIN_SETTLED);
  });

  it("still lists ineligible agents, so they can see themselves building toward it", () => {
    const standings = seasonStandings(log(SEASON_MIN_SETTLED), season);
    expect(standings.some((s) => !s.eligible)).toBe(true);
    // …but every eligible agent outranks every ineligible one.
    const lastEligible = standings.map((s) => s.eligible).lastIndexOf(true);
    const firstIneligible = standings.map((s) => s.eligible).indexOf(false);
    if (firstIneligible >= 0) expect(lastEligible).toBeLessThan(firstIneligible);
  });

  it("ranks from 1 with no gaps", () => {
    const standings = seasonStandings(log(SEASON_MIN_SETTLED), season);
    expect(standings.map((s) => s.rank)).toEqual(standings.map((_, i) => i + 1));
  });

  it("scores only the season's own activity", () => {
    const events = log(SEASON_MIN_SETTLED);
    const nextSeason = seasonByIndex("weekly", EPOCH, 1);
    expect(seasonStandings(events, nextSeason)).toEqual([]);
  });
});

describe("season archive", () => {
  it("runs newest-first from the epoch and marks which seasons have closed", () => {
    const now = EPOCH + WEEK_MS * 2 + 1000;
    const archive = seasonArchive([], "weekly", EPOCH, now);
    expect(archive.map((e) => e.season.index)).toEqual([2, 1, 0]);
    expect(archive[0].closed).toBe(false); // the current season is still moving
    expect(archive[1].closed).toBe(true);
    expect(archive[2].closed).toBe(true);
  });
});

describe("GET /api/league", () => {
  it("serves the current season's standings with the floor stated", async () => {
    const res = await leagueGET(new Request("http://localhost/api/league"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toBe("chain-events");
    expect(json.season.cadence).toBe("weekly");
    expect(json.minSettledToWin).toBe(SEASON_MIN_SETTLED);
    expect(Array.isArray(json.standings)).toBe(true);
  });

  it("honours the monthly cadence and an explicit season index", async () => {
    const res = await leagueGET(new Request("http://localhost/api/league?cadence=monthly&season=0"));
    const json = await res.json();
    expect(json.season.cadence).toBe("monthly");
    expect(json.season.index).toBe(0);
  });

  it("serves the archive", async () => {
    const res = await leagueGET(new Request("http://localhost/api/league?archive=true"));
    const json = await res.json();
    expect(Array.isArray(json.seasons)).toBe(true);
    expect(json.seasons[0]).toHaveProperty("closed");
  });
});
