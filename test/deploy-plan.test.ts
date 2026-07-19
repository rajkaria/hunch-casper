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
    expect(plan.args[0]).toMatchObject({ name: "outcome", value: "YES" });
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

describe("deploy-plan builder — HunchVault v2 targets (market_id-keyed ABI)", () => {
  it("prepends market_id to a v2 bet: bet(market_id, outcome), stake still attached", () => {
    const plan = buildBetPlan(
      { marketId: "testnet:btc-150k-aug1", outcomeKey: "YES", amountMotes: "1000000000", bettor: "agent:value" },
      { marketContract: MARKET, vaultMarketId: "btc-150k-aug1" },
    );
    // ARG ORDER IS ABI: market_id must come first, exactly as the Odra entrypoint declares it.
    expect(plan.args).toEqual([
      { name: "market_id", clType: "string", value: "btc-150k-aug1" },
      { name: "outcome", clType: "string", value: "YES" },
    ]);
    expect(plan.entryPoint).toBe("bet");
    expect(plan.attachedMotes).toBe("1000000000");
    expect(plan.usesProxy).toBe(true);
  });

  it("prepends market_id to a v2 resolve: resolve(market_id, winning_outcome)", () => {
    const plan = buildResolvePlan(
      { marketId: "testnet:btc-150k-aug1", winningOutcomeKey: "NO", oracleId: "arbiter" },
      { marketContract: MARKET, vaultMarketId: "btc-150k-aug1" },
    );
    expect(plan.args).toEqual([
      { name: "market_id", clType: "string", value: "btc-150k-aug1" },
      { name: "winning_outcome", clType: "string", value: "NO" },
    ]);
    expect(plan.usesProxy).toBe(false);
  });

  it("omitting vaultMarketId keeps the legacy single-arg ABI (v1 contracts unchanged)", () => {
    const plan = buildBetPlan(
      { marketId: "testnet:the-flip", outcomeKey: "heads", amountMotes: "1", bettor: "x" },
      { marketContract: MARKET },
    );
    expect(plan.args.map((a) => a.name)).toEqual(["outcome"]);
  });

  it("rejects an empty vaultMarketId (silent mis-route protection)", () => {
    expect(() =>
      buildBetPlan(
        { marketId: "m", outcomeKey: "YES", amountMotes: "1", bettor: "x" },
        { marketContract: MARKET, vaultMarketId: "" },
      ),
    ).toThrow(/vaultMarketId/);
  });
});
