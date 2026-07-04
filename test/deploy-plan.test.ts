import { describe, it, expect } from "vitest";
import {
  buildBetPlan,
  buildResolvePlan,
  DEFAULT_BET_GAS_MOTES,
  DEFAULT_RESOLVE_GAS_MOTES,
} from "@/adapters/casper/deploy-plan";

const MARKET = "hash-0000000000000000000000000000000000000000000000000000000000000000";

describe("deploy-plan builder (Odra ABI mapping)", () => {
  it("maps a bet to the payable `bet` entry point with the outcome arg + attached stake", () => {
    const plan = buildBetPlan(
      { marketId: "testnet:coin-flip-5m", outcomeKey: "heads", amountMotes: "2500000000", bettor: "agent:momentum" },
      { marketContract: MARKET },
    );
    expect(plan.targetContract).toBe(MARKET);
    expect(plan.entryPoint).toBe("bet");
    expect(plan.args).toEqual([{ name: "outcome", clType: "string", value: "heads" }]);
    // The stake is attached, not passed as an arg — it must reach the payable method as value.
    expect(plan.attachedMotes).toBe("2500000000");
    expect(BigInt(plan.gasMotes)).toBe(BigInt(DEFAULT_BET_GAS_MOTES));
    // Payable ⇒ must go through Odra's proxy_caller wasm, else attached value is silently zero.
    expect(plan.usesProxy).toBe(true);
  });

  it("maps a resolve to the `resolve` entry point with winning_outcome and no attached value", () => {
    const plan = buildResolvePlan(
      { marketId: "testnet:coin-flip-5m", winningOutcomeKey: "tails", oracleId: "arbiter" },
      { marketContract: MARKET },
    );
    expect(plan.entryPoint).toBe("resolve");
    expect(plan.args).toEqual([{ name: "winning_outcome", clType: "string", value: "tails" }]);
    expect(plan.attachedMotes).toBe("0");
    expect(BigInt(plan.gasMotes)).toBe(BigInt(DEFAULT_RESOLVE_GAS_MOTES));
    // Non-payable ⇒ direct call, no proxy envelope.
    expect(plan.usesProxy).toBe(false);
  });

  it("passes the outcome key through verbatim (on-chain casing is the caller's contract)", () => {
    const plan = buildBetPlan(
      { marketId: "m", outcomeKey: "YES", amountMotes: "1", bettor: "x" },
      { marketContract: MARKET },
    );
    expect(plan.args[0].value).toBe("YES");
  });

  it("honours a gas override", () => {
    const plan = buildBetPlan(
      { marketId: "m", outcomeKey: "yes", amountMotes: "1", bettor: "x" },
      { marketContract: MARKET, gasMotes: "12345" },
    );
    expect(plan.gasMotes).toBe("12345");
  });

  it("rejects a zero or non-integer stake", () => {
    const base = { marketId: "m", outcomeKey: "yes", bettor: "x" };
    expect(() => buildBetPlan({ ...base, amountMotes: "0" }, { marketContract: MARKET })).toThrow(/greater than zero/);
    expect(() => buildBetPlan({ ...base, amountMotes: "1.5" }, { marketContract: MARKET })).toThrow(/integer/);
    expect(() => buildBetPlan({ ...base, amountMotes: "-5" }, { marketContract: MARKET })).toThrow(/integer/);
    expect(() => buildBetPlan({ ...base, amountMotes: "" }, { marketContract: MARKET })).toThrow(/integer/);
  });

  it("rejects an empty outcome or missing market contract", () => {
    expect(() =>
      buildBetPlan({ marketId: "m", outcomeKey: "", amountMotes: "1", bettor: "x" }, { marketContract: MARKET }),
    ).toThrow(/outcomeKey/);
    expect(() =>
      buildResolvePlan({ marketId: "m", winningOutcomeKey: "yes", oracleId: "o" }, { marketContract: "" }),
    ).toThrow(/marketContract/);
  });
});
