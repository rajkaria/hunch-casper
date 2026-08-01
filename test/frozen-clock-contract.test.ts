/**
 * The contract between the suite's frozen "now" and the data the suite runs against.
 *
 * On 2026-08-01T00:00Z the catalogue's "by Aug 1" deadlines passed and 67 tests in 20 files went
 * red at once, all of them saying "betting is closed" — 67 copies of a message that named a symptom
 * in the settlement ledger and said nothing about the actual cause (the calendar). `setupFiles`
 * freezes `Date` so that cannot recur by the mere passage of time, but the frozen instant still has
 * to sit in the window the fixtures assume. This file asserts that window, so the day someone
 * authors a market outside it the failure is ONE test naming the slug.
 *
 * Note the asymmetry these tests encode: a catalogue market is allowed to be dated — it answers a
 * real-world question by a real date, and `HunchVault.create_market` writes that deadline once,
 * with no entry point to change it. What is not allowed is for the suite to depend on where the
 * wall clock happens to sit relative to it.
 */

import { describe, expect, it } from "vitest";
import { TEST_NOW_ISO, TEST_NOW_MS } from "./setup/frozen-clock";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import { LEAGUE_EPOCH_MS, WEEK_MS } from "@/core/seasons";
import { createMockMarketStore } from "@/adapters/mock/mock-market-store";

const live = MARKET_DEFINITIONS.filter((d) => !d.retired);
const retired = MARKET_DEFINITIONS.filter((d) => d.retired);

describe("the frozen test clock", () => {
  it("is actually what the suite runs at", () => {
    expect(Date.now()).toBe(TEST_NOW_MS);
    expect(new Date().toISOString()).toBe(TEST_NOW_ISO);
  });

  it("sits before every live deadline, so every live market can take a bet", () => {
    const matured = live
      .filter((d) => TEST_NOW_MS >= Date.parse(d.deadlineIso))
      .map((d) => `${d.slug} (${d.deadlineIso})`);
    // If this fails: the market's deadline is at or before TEST_NOW, so every test that bets
    // through the ledger will throw "betting is closed". Either the market is settled history and
    // wants `retired: true` plus a successor, or TEST_NOW has to move earlier — and it cannot move
    // before the retired cohort (see below).
    expect(matured).toEqual([]);
  });

  it("sits after every retired deadline, so settled history really is in the past", () => {
    // `catalogue.test.ts` holds a retired market to having already matured. A frozen "now" earlier
    // than the retired cohort would make settled history read as an open market.
    const notYetMatured = retired
      .filter((d) => TEST_NOW_MS < Date.parse(d.deadlineIso))
      .map((d) => `${d.slug} (${d.deadlineIso})`);
    expect(notYetMatured).toEqual([]);
  });

  it("leaves room on both sides of the window rather than sitting on an edge", () => {
    const HOUR = 60 * 60 * 1000;
    const earliestLive = Math.min(...live.map((d) => Date.parse(d.deadlineIso)));
    const latestRetired = Math.max(...retired.map((d) => Date.parse(d.deadlineIso)));
    expect(earliestLive - TEST_NOW_MS).toBeGreaterThan(HOUR);
    expect(TEST_NOW_MS - latestRetired).toBeGreaterThan(HOUR);
  });

  it("sits far enough after the league epoch that the season archive is non-empty", () => {
    // A frozen now before the epoch puts the current season at a negative index and returns an
    // empty archive while every health check still reads fine — the failure mode seasons.test.ts
    // was written to catch.
    expect(TEST_NOW_MS - LEAGUE_EPOCH_MS).toBeGreaterThan(WEEK_MS);
  });

  it("reads every live catalogue market as open through the store, not just on paper", async () => {
    const store = createMockMarketStore();
    const markets = await store.list({ network: "testnet" });
    const liveSlugs = new Set(live.map((d) => d.slug));
    const notOpen = markets
      .filter((m) => liveSlugs.has(m.slug) && m.status !== "open")
      .map((m) => `${m.slug} → ${m.status}`);
    expect(notOpen).toEqual([]);
  });
});
