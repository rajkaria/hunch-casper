/**
 * The cadence throttle. Real mode spends real CSPR every ten minutes with nobody watching, and a
 * nearly-broke economy drains *faster* than a healthy one — every underfunded transaction reverts
 * and burns its gas. So the economy has to degrade on purpose, in a fixed order, well before zero.
 *
 * These tests pin the order (seeding → creation → betting, with resolution never throttled) and
 * the rule that each capability is gated by the purse that actually pays for it.
 */

import { describe, it, expect } from "vitest";
import {
  BETTING_FLOOR_ROUNDS,
  CREATION_FLOOR_ROUNDS,
  SEEDING_FLOOR_ROUNDS,
  planCadence,
  roundsOfRunway,
  type CadenceInput,
} from "@/core/cadence";

const PER_ROUND_TREASURY = "1000000000"; // 1 CSPR
const PER_ROUND_AGENT = "1000000000";

function withRunway(treasuryRounds: number, fleetRounds: number): CadenceInput {
  return {
    treasuryMotes: (BigInt(PER_ROUND_TREASURY) * BigInt(treasuryRounds)).toString(),
    minFleetBalanceMotes: (BigInt(PER_ROUND_AGENT) * BigInt(fleetRounds)).toString(),
    perRoundTreasuryCostMotes: PER_ROUND_TREASURY,
    perRoundAgentCostMotes: PER_ROUND_AGENT,
  };
}

describe("roundsOfRunway", () => {
  it("counts whole affordable rounds", () => {
    expect(roundsOfRunway("2500000000", "1000000000")).toBe(2);
  });

  it("is zero at an empty or negative-going purse", () => {
    expect(roundsOfRunway("0", "1000000000")).toBe(0);
    expect(roundsOfRunway("999999999", "1000000000")).toBe(0);
  });

  it("treats a free round as unlimited rather than dividing by zero", () => {
    expect(roundsOfRunway("1", "0")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("planCadence — the degradation ladder", () => {
  it("runs everything when both purses are deep", () => {
    const plan = planCadence(withRunway(SEEDING_FLOOR_ROUNDS * 2, BETTING_FLOOR_ROUNDS * 10));
    expect(plan.cadence).toBe("full");
    expect(plan.allowHouseSeeding).toBe(true);
    expect(plan.allowMarketCreation).toBe(true);
    expect(plan.allowProphetBets).toBe(true);
  });

  it("drops house seeding first — the most expensive, most replaceable spend", () => {
    const plan = planCadence(withRunway(SEEDING_FLOOR_ROUNDS - 1, BETTING_FLOOR_ROUNDS * 10));
    expect(plan.cadence).toBe("reduced");
    expect(plan.allowHouseSeeding).toBe(false);
    expect(plan.allowMarketCreation).toBe(true);
    expect(plan.allowProphetBets).toBe(true);
  });

  it("drops market creation next — the catalogue stops growing, live markets keep trading", () => {
    const plan = planCadence(withRunway(CREATION_FLOOR_ROUNDS - 1, BETTING_FLOOR_ROUNDS * 10));
    expect(plan.cadence).toBe("minimal");
    expect(plan.allowMarketCreation).toBe(false);
    expect(plan.allowProphetBets).toBe(true);
  });

  it("drops betting last — an economy that stops betting looks dead", () => {
    const plan = planCadence(withRunway(0, 0));
    expect(plan.cadence).toBe("paused");
    expect(plan.allowProphetBets).toBe(false);
  });

  it("gates each capability by the purse that pays for it — a rich treasury cannot mask a starving fleet", () => {
    const plan = planCadence(withRunway(SEEDING_FLOOR_ROUNDS * 100, BETTING_FLOOR_ROUNDS - 1));
    expect(plan.allowHouseSeeding).toBe(true);
    expect(plan.allowMarketCreation).toBe(true);
    expect(plan.allowProphetBets).toBe(false);
    // …and vice versa: a full fleet cannot mask an empty treasury.
    const inverse = planCadence(withRunway(0, BETTING_FLOOR_ROUNDS * 100));
    expect(inverse.allowMarketCreation).toBe(false);
    expect(inverse.allowProphetBets).toBe(true);
  });

  it("treats a balance exactly at a floor as affordable", () => {
    const plan = planCadence(withRunway(SEEDING_FLOOR_ROUNDS, BETTING_FLOOR_ROUNDS));
    expect(plan.cadence).toBe("full");
  });

  it("explains itself in terms an operator can act on", () => {
    const plan = planCadence(withRunway(CREATION_FLOOR_ROUNDS - 1, BETTING_FLOOR_ROUNDS * 10));
    expect(plan.reason).toContain("market creation off");
    expect(plan.reason).toContain("refill");
  });

  it("degrades monotonically as the treasury drains — never re-enables something it just cut", () => {
    const seen: boolean[][] = [];
    for (const rounds of [SEEDING_FLOOR_ROUNDS * 2, SEEDING_FLOOR_ROUNDS, CREATION_FLOOR_ROUNDS, 0]) {
      const p = planCadence(withRunway(rounds, BETTING_FLOOR_ROUNDS * 10));
      seen.push([p.allowHouseSeeding, p.allowMarketCreation]);
    }
    for (let i = 1; i < seen.length; i++) {
      for (let cap = 0; cap < seen[i].length; cap++) {
        // Once false, it must stay false as runway shrinks further.
        if (!seen[i - 1][cap]) expect(seen[i][cap]).toBe(false);
      }
    }
  });
});
