/**
 * A persisted ledger entry must not freeze a market's copy.
 *
 * Production hit this for real: the recurring round's cadence became daily and the catalogue was
 * renamed to "CSPR up or down today?", but casper.playhunch.xyz kept serving "CSPR up or down this
 * hour?" — the KV entry had been seeded before the rename, and `ledgerGet` returned it verbatim.
 * Every freshly-spawned round read "today" while its own parent still advertised an hourly cadence
 * it no longer ran. A market whose title outruns its cadence is exactly the defect the daily-cadence
 * work was meant to end.
 *
 * The line: the catalogue owns copy (title, subtitle, category, outcome labels); the ledger owns
 * money and time (pools, stakes, status, deadline, fee). Refreshing copy is safe. Refreshing money
 * would restate economics under a market that already holds stakes, so it never happens.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  __resetLedger,
  exportSettlementState,
  importSettlementState,
  ledgerGet,
  ledgerRecordBet,
} from "@/adapters/mock/settlement-ledger";
import { createMockMarketStore } from "@/adapters/mock/mock-market-store";
import { MARKET_DEFINITIONS } from "@/core/catalogue";

const RECURRING = MARKET_DEFINITIONS.find((d) => d.slug === "cspr-hourly-updown")!;
const ID = `testnet:${RECURRING.slug}`;

/** Persist an entry whose copy is stale, exactly as a pre-rename KV snapshot would be. */
function persistStaleCopy(): void {
  __resetLedger();
  ledgerGet(ID); // seed from the current catalogue
  const snapshot = exportSettlementState();
  const entry = snapshot.entries.find(([id]) => id === ID)![1];
  entry.market.title = "CSPR up or down this hour?";
  entry.market.subtitle = "Casper-native · recurring hourly round";
  entry.market.category = "provably-fair";
  entry.market.outcomes = entry.market.outcomes.map((o) => ({ ...o, label: "STALE" }));
  importSettlementState(snapshot);
}

beforeEach(() => __resetLedger());

describe("catalogue copy is refreshed onto a persisted ledger entry", () => {
  it("a stale persisted title is replaced by the catalogue's", () => {
    persistStaleCopy();
    expect(ledgerGet(ID)?.title).toBe(RECURRING.title);
  });

  it("subtitle, category and outcome labels are refreshed too", () => {
    persistStaleCopy();
    const m = ledgerGet(ID)!;
    expect(m.subtitle).toBe(RECURRING.subtitle);
    expect(m.category).toBe(RECURRING.category);
    expect(m.outcomes.map((o) => o.label)).toEqual(RECURRING.outcomes.map((o) => o.label));
  });

  it("the store's list view serves the refreshed copy, not the frozen one", async () => {
    persistStaleCopy();
    const markets = await createMockMarketStore().list({ network: "testnet" });
    const m = markets.find((x) => x.id === ID)!;
    expect(m.title).toBe(RECURRING.title);
    expect(m.category).toBe(RECURRING.category);
  });

  it("money and time survive the refresh untouched", () => {
    persistStaleCopy();
    const before = ledgerGet(ID)!;
    ledgerRecordBet({
      marketId: ID,
      outcomeKey: "up",
      amountMotes: "7000000000",
      bettor: "agent:Momentum",
    });
    const after = ledgerGet(ID)!;
    expect(BigInt(after.poolByOutcomeMotes.up)).toBe(BigInt(before.poolByOutcomeMotes.up) + 7_000_000_000n);
    expect(after.deadlineIso).toBe(before.deadlineIso);
    expect(after.feeBps).toBe(before.feeBps);
    // …and the copy is still the catalogue's after a mutating call.
    expect(after.title).toBe(RECURRING.title);
  });

  it("a market that has left the catalogue keeps the copy it last had", () => {
    __resetLedger();
    const orphanId = "testnet:this-slug-is-not-in-the-catalogue";
    expect(ledgerGet(orphanId)).toBeNull(); // unknown slugs stay unknown, never throw on read
  });
});
