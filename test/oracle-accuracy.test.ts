/**
 * The Arbiter's reputation has TWO-SIDED risk. Before S13 every resolution was recorded
 * `accurate: true`, so accuracy could only rise and `arbiter-accuracy-95` could never resolve NO —
 * the "oracle with economic teeth" thesis was hollow. These tests prove the teeth are real: the
 * mock oracle marks a deterministic minority of external reads inaccurate, a run of misses drops
 * the Arbiter below its 95% target, and the meta-market then settles NO.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createContainer } from "@/lib/container";
import { resolveMarket } from "@/agent/arbiter";
import { isAccurateReading } from "@/adapters/mock/mock-oracle";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetActivity } from "@/adapters/mock/activity-log";
import { __resetOracleLedger } from "@/adapters/mock/oracle-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";
import { __resetCreatedMarkets } from "@/adapters/mock/market-source";

beforeEach(() => {
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetConsumedNonces();
  __resetCreatedMarkets();
});

describe("Arbiter reputation is two-sided (arbiter-accuracy-95 can resolve either way)", () => {
  it("resolves YES at the seeded baseline (123/128 ≈ 96.09% ≥ 95%)", async () => {
    const container = createContainer("testnet");
    await resolveMarket(container, "arbiter-accuracy-95");
    const acc = await container.store.settlementFor("testnet:arbiter-accuracy-95");
    expect(acc!.winningOutcomeKey).toBe("yes");
  });

  it("resolves NO once enough inaccurate resolutions drag accuracy below 95%", async () => {
    const container = createContainer("testnet");
    // Seed 123/128 = 96.09%. Two more resolutions, both inaccurate → 123/130 = 94.6% < 95%.
    await container.oracle.recordResolution("arbiter", "testnet:miss-a", false);
    await container.oracle.recordResolution("arbiter", "testnet:miss-b", false);

    const rep = await container.oracle.reputationOf("arbiter");
    expect(rep.accuracyBps / 100).toBeLessThan(95);

    await resolveMarket(container, "arbiter-accuracy-95");
    const acc = await container.store.settlementFor("testnet:arbiter-accuracy-95");
    expect(acc!.winningOutcomeKey).toBe("no"); // reputation on the line, and it lost
  });
});

describe("mock oracle marks a deterministic minority of reads inaccurate", () => {
  it("is deterministic and exercises BOTH accurate and inaccurate outcomes across the catalogue", () => {
    const ids = MARKET_DEFINITIONS.map((d) => `testnet:${d.slug}`);
    const flags = ids.map((id) => isAccurateReading(id));

    // Deterministic — same id, same verdict.
    expect(ids.every((id) => isAccurateReading(id) === isAccurateReading(id))).toBe(true);
    // The majority are accurate (a competent oracle) …
    expect(flags.filter(Boolean).length).toBeGreaterThan(flags.length / 2);
    // … but at least one is inaccurate, so the reputation genuinely can fall.
    expect(flags.some((f) => !f)).toBe(true);
  });
});
