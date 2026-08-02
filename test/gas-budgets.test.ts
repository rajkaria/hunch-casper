/**
 * Gas budgets against chain measurements.
 *
 * This suite exists because of a real bug it would have caught: `DEFAULT_RESOLVE_GAS_MOTES` was a
 * round 5 CSPR "safe upper bound", while `resolve` actually consumes **6.317 CSPR** on chain. Every
 * real-mode resolution would have run out of gas — and an out-of-gas transaction refunds nothing,
 * so each failure burned the entire limit while settling nobody and paying no one.
 *
 * The measurements are from the transactions cited in `contracts/bin/catalogue.rs`. Anything that
 * retunes a limit must keep passing these, and the app's limits must stay in step with the deploy
 * driver's — the same call priced two different ways is how one of them ends up wrong.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_BET_GAS_MOTES,
  DEFAULT_CREATE_GAS_MOTES,
  DEFAULT_RESOLVE_GAS_MOTES,
} from "@/adapters/casper/deploy-plan";

const CSPR = 1_000_000_000n;

/** Measured consumption, in motes, from the cited testnet transactions. */
const MEASURED = {
  bet: 1_439_000_000n, // 79f232…
  resolve: 6_317_000_000n, // 46312a… (fee + bond sweep)
  createMarket: 4_958_000_000n, // 40273e… — the FIRST create on a fresh vault, the worst case
};

/** Testnet refunds 75 % of the unused limit: net = consumed + 0.25 × (limit − consumed). */
function netCost(consumed: bigint, limit: bigint): bigint {
  return consumed + (limit - consumed) / 4n;
}

describe("gas limits cover what the chain actually consumes", () => {
  const cases: [string, bigint, bigint][] = [
    ["bet", MEASURED.bet, BigInt(DEFAULT_BET_GAS_MOTES)],
    ["resolve", MEASURED.resolve, BigInt(DEFAULT_RESOLVE_GAS_MOTES)],
    ["create_market", MEASURED.createMarket, BigInt(DEFAULT_CREATE_GAS_MOTES)],
  ];

  for (const [name, consumed, limit] of cases) {
    it(`${name}: the limit exceeds measured consumption — an out-of-gas call burns the whole limit`, () => {
      expect(limit).toBeGreaterThan(consumed);
    });

    it(`${name}: keeps at least 1.5x headroom for a heavier-than-usual execution`, () => {
      expect(limit * 2n).toBeGreaterThanOrEqual(consumed * 3n);
    });

    it(`${name}: is not so over-budgeted that the refund model taxes every call`, () => {
      // 25 % of the slack is burned on every success. Cap the waste at the consumed cost itself.
      expect(netCost(consumed, limit)).toBeLessThanOrEqual(consumed * 2n);
    });
  }

  it("matches the limits the deploy driver uses for the same calls", () => {
    // contracts/bin/catalogue.rs: BET_GAS 5, SETTLE_GAS 12, CREATE_GAS 8.
    expect(BigInt(DEFAULT_BET_GAS_MOTES)).toBe(5n * CSPR);
    expect(BigInt(DEFAULT_RESOLVE_GAS_MOTES)).toBe(12n * CSPR);
    expect(BigInt(DEFAULT_CREATE_GAS_MOTES)).toBe(8n * CSPR);
  });
});

/**
 * The published gas documentation must not drift from the measurements the code is tuned against.
 *
 * `docs/GAS.md` and `contracts/PATTERNS.md` are written for Casper developers outside this repo,
 * who have no way to tell a current figure from a stale one. A number that quietly rots is worse
 * than no number at all, so every headline figure is asserted against the same constants the
 * budgets above use.
 */
describe("the published gas docs stay true", () => {
  const read = async (path: string): Promise<string> => {
    const { readFile } = await import("node:fs/promises");
    return readFile(new URL(`../${path}`, import.meta.url), "utf8");
  };

  it("GAS.md cites the measured create_market and per-market install costs", async () => {
    const gas = await read("docs/GAS.md");
    expect(gas).toContain("3.74");   // create_market, typical — tx e2bb364c…
    expect(gas).toContain("324.27"); // v1 ParimutuelMarket install
    expect(gas).toContain("5.22");   // first create_market, dictionary init
    expect(gas).toContain("373.07"); // HunchVault install
  });

  it("GAS.md states the refund model the net figures are derived from", async () => {
    const gas = await read("docs/GAS.md");
    // Every "net" number on the page is meaningless without this rule.
    expect(gas).toMatch(/75%/);
    expect(gas).toMatch(/net = consumed/);
  });

  it("GAS.md quotes the same bet/resolve/claim consumption the budgets are tuned to", async () => {
    const gas = await read("docs/GAS.md");
    expect(gas).toContain((Number(MEASURED.bet) / 1e9).toFixed(3));
    expect(gas).toContain((Number(MEASURED.resolve) / 1e9).toFixed(3));
  });

  it("PATTERNS.md agrees with GAS.md on the headline comparison", async () => {
    const patterns = await read("contracts/PATTERNS.md");
    expect(patterns).toContain("324.27");
    expect(patterns).toContain("3.74");
    // The 87× claim is load-bearing in the pitch; keep it arithmetically honest.
    expect(Math.round(324.27 / 3.74)).toBe(87);
  });

  it("PATTERNS.md describes contracts that actually exist in this crate", async () => {
    const { readFile } = await import("node:fs/promises");
    const patterns = await read("contracts/PATTERNS.md");
    for (const file of ["hunch_vault.rs", "field_market.rs"]) {
      const src = await readFile(new URL(`../contracts/src/${file}`, import.meta.url), "utf8");
      expect(src.length).toBeGreaterThan(0);
    }
    // The dictionary-membership claim is the one a reader would copy; pin the real declaration.
    const field = await readFile(new URL("../contracts/src/field_market.rs", import.meta.url), "utf8");
    expect(field).toContain("candidate: Mapping<String, bool>");
    expect(patterns).toContain("candidate: Mapping<String, bool>");
  });
});
