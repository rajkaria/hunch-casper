import { describe, expect, it, afterEach } from "vitest";
import { createMockClock } from "@/adapters/mock/mock-clock";
import { createSystemClock } from "@/adapters/system-clock";
import { setLedgerClock } from "@/adapters/mock/settlement-ledger";
import { createMockMarketStore } from "@/adapters/mock/mock-market-store";
import { MARKET_DEFINITIONS } from "@/core/catalogue";

const store = createMockMarketStore();

afterEach(() => setLedgerClock(createSystemClock()));

function oneShot() {
  return MARKET_DEFINITIONS.find((d) => d.cadence === "one-shot")!;
}

describe("market maturity", () => {
  it("an open market past its deadline reads locked", async () => {
    const def = oneShot();
    setLedgerClock(createMockClock(Date.parse(def.deadlineIso) + 1));
    const m = await store.get(def.slug, "testnet");
    expect(m?.status).toBe("locked");
  });

  it("the same market before its deadline reads open", async () => {
    const def = oneShot();
    setLedgerClock(createMockClock(Date.parse(def.deadlineIso) - 1));
    const m = await store.get(def.slug, "testnet");
    expect(m?.status).toBe("open");
  });

  it("maturity is exactly at the deadline, not after it", async () => {
    const def = oneShot();
    setLedgerClock(createMockClock(Date.parse(def.deadlineIso)));
    const m = await store.get(def.slug, "testnet");
    expect(m?.status).toBe("locked");
  });
});
