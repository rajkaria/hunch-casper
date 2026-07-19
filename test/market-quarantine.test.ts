/**
 * Market quarantine.
 *
 * The breaker stops the fleet when the money path is broken everywhere. This covers the narrower,
 * more expensive case: the money path works, but ONE market's catalogue entry disagrees with the
 * contract it routes to, so a bet on it reverts every time. Because the fleet picks its target by
 * `seq % openMarkets.length`, that market comes back on a fixed cycle and charges a full stake each
 * time — while the breaker never trips, since the failures are never consecutive.
 *
 * Real case: `coin-flip-5m` routed to a package that rejected BOTH of its catalogue outcomes with
 * `UnknownOutcome`, while twelve other markets bet fine.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  exportQuarantine,
  importQuarantine,
  isQuarantined,
  permanentMarketFault,
  quarantineMarket,
  quarantinedMarkets,
  releaseAllMarkets,
  releaseMarket,
} from "@/agent/market-quarantine";

beforeEach(() => {
  releaseAllMarkets();
});

describe("classifying a revert as a permanent market fault", () => {
  it("recognises the two reverts that mean 'config, not weather'", () => {
    expect(permanentMarketFault("transaction abc reverted on chain: User error: 3")).toBe("UnknownOutcome");
    expect(permanentMarketFault("transaction abc reverted on chain: User error: 12")).toBe("UnknownMarket");
  });

  it("does NOT quarantine on transient or expected failures", () => {
    // A blip must never silently shrink the catalogue.
    expect(permanentMarketFault("Code: 413, err: Payload Too Large")).toBeNull();
    expect(permanentMarketFault("transaction did not execute within the confirmation window")).toBeNull();
    expect(permanentMarketFault("chain submission failed")).toBeNull();
    // MarketClosed (2) is expected near a deadline — the market is fine, it is just over.
    expect(permanentMarketFault("reverted on chain: User error: 2")).toBeNull();
    // Out of gas / ZeroStake are our bugs to fix, not the market's identity.
    expect(permanentMarketFault("reverted on chain: User error: 4")).toBeNull();
  });

  it("is not fooled by a number that is not a revert code", () => {
    expect(permanentMarketFault("transferred 3 motes")).toBeNull();
  });
});

describe("quarantine", () => {
  const entry = (slug: string) => ({
    slug,
    reason: "UnknownOutcome: reverted on chain: User error: 3",
    deployHash: "ab".repeat(32),
    ts: 1_700_000_000_000,
  });

  it("starts empty — every market is bettable until proven otherwise", () => {
    expect(quarantinedMarkets()).toEqual([]);
    expect(isQuarantined("coin-flip-5m")).toBe(false);
  });

  it("quarantines a slug and leaves every other market alone", () => {
    quarantineMarket(entry("coin-flip-5m"));
    expect(isQuarantined("coin-flip-5m")).toBe(true);
    expect(isQuarantined("btc-150k-aug")).toBe(false);
  });

  it("keeps the FIRST diagnosis, with the settlement hash of the stake that bought nothing", () => {
    quarantineMarket(entry("coin-flip-5m"));
    quarantineMarket({ ...entry("coin-flip-5m"), reason: "something later and vaguer", ts: 9 });
    const [q] = quarantinedMarkets();
    expect(q.reason).toMatch(/UnknownOutcome/);
    expect(q.deployHash).toBe("ab".repeat(32));
  });

  it("releases only on an explicit operator action — nothing expires on its own", () => {
    quarantineMarket(entry("coin-flip-5m"));
    expect(releaseMarket("not-a-market")).toBe(false);
    expect(isQuarantined("coin-flip-5m")).toBe(true);
    expect(releaseMarket("coin-flip-5m")).toBe(true);
    expect(isQuarantined("coin-flip-5m")).toBe(false);
  });

  it("survives a cold start through the KV envelope", () => {
    // Otherwise every new serverless instance would re-discover the fault by paying for it again.
    quarantineMarket(entry("coin-flip-5m"));
    const persisted = JSON.parse(JSON.stringify(exportQuarantine()));
    releaseAllMarkets();
    expect(isQuarantined("coin-flip-5m")).toBe(false);
    importQuarantine(persisted);
    expect(isQuarantined("coin-flip-5m")).toBe(true);
  });

  it("ignores malformed persisted entries rather than crashing the tick", () => {
    importQuarantine([{ slug: "", reason: "x", deployHash: "", ts: 0 }, null as never]);
    expect(quarantinedMarkets()).toEqual([]);
  });
});
