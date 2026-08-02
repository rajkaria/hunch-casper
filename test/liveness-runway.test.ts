/**
 * S31/W8 — the economy degrades instead of halting, and says how long it has left.
 *
 * Two production failures motivate every test here. On 2026-07-31 the operator purse reached zero
 * and the breaker held the economy down for 44 hours. On 2026-08-02 the same purse was empty while
 * 755 CSPR sat in four healthy agent purses — and the planner still refused to bet, because the
 * betting gate required BOTH the treasury and the fleet. That gate was correct when the treasury
 * signed every escrow; it is wrong now that agents sign their own (S30/W1).
 *
 * The other half is the poorest-member rule: gating the whole fleet on its weakest purse turned one
 * drained Prophet into a silent economy. Each agent pays for its own turn, so one empty purse is
 * one agent sitting out.
 */
import { describe, it, expect } from "vitest";
import {
  planCadence,
  roundsOfRunway,
  runwayHours,
  TICK_INTERVAL_MS,
  BETTING_FLOOR_ROUNDS,
  CREATION_FLOOR_ROUNDS,
  SEEDING_FLOOR_ROUNDS,
  type CadenceInput,
} from "@/core/cadence";

const PER_ROUND = "1000000000"; // 1 CSPR per round, so rounds and CSPR line up

function input(over: Partial<CadenceInput> = {}): CadenceInput {
  return {
    treasuryMotes: (BigInt(PER_ROUND) * BigInt(SEEDING_FLOOR_ROUNDS * 10)).toString(),
    minFleetBalanceMotes: (BigInt(PER_ROUND) * BigInt(SEEDING_FLOOR_ROUNDS * 10)).toString(),
    perRoundTreasuryCostMotes: PER_ROUND,
    perRoundAgentCostMotes: PER_ROUND,
    ...over,
  };
}

const motesFor = (rounds: number) => (BigInt(PER_ROUND) * BigInt(rounds)).toString();

describe("a dry treasury no longer stops a funded fleet from betting", () => {
  it("keeps betting on when agents fund their own escrows — the 2026-08-02 outage", () => {
    const plan = planCadence(
      input({
        treasuryMotes: "0",
        minFleetBalanceMotes: motesFor(SEEDING_FLOOR_ROUNDS * 10),
        selfCustodialBets: true,
      }),
    );

    expect(plan.allowProphetBets).toBe(true);
    // Creation and seeding genuinely spend from the treasury, so they still stop.
    expect(plan.allowMarketCreation).toBe(false);
    expect(plan.allowHouseSeeding).toBe(false);
  });

  it("still stops betting on a dry treasury under the old operator-funded model", () => {
    const plan = planCadence(
      input({ treasuryMotes: "0", selfCustodialBets: false }),
    );
    expect(plan.allowProphetBets).toBe(false);
  });

  it("defaults to the conservative both-purses rule when custody is not stated", () => {
    const plan = planCadence(input({ treasuryMotes: "0" }));
    expect(plan.allowProphetBets).toBe(false);
  });

  it("still stops betting when the fleet itself is dry, whoever signs", () => {
    const plan = planCadence(
      input({
        minFleetBalanceMotes: "0",
        maxFleetBalanceMotes: "0",
        selfCustodialBets: true,
      }),
    );
    expect(plan.allowProphetBets).toBe(false);
  });
});

describe("one drained agent does not silence the fleet", () => {
  it("keeps betting on while any agent can still afford a turn", () => {
    const plan = planCadence(
      input({
        minFleetBalanceMotes: "0", // one Prophet is empty
        maxFleetBalanceMotes: motesFor(SEEDING_FLOOR_ROUNDS), // the others are fine
        selfCustodialBets: true,
      }),
    );

    expect(plan.allowProphetBets).toBe(true);
    // The poorest purse is still what the plan REPORTS, so the warning arrives early.
    expect(plan.fleetRounds).toBe(0);
  });

  it("falls back to the poorest purse when the caller does not distinguish them", () => {
    // Pre-S31 callers pass only `minFleetBalanceMotes`; their behaviour must not change.
    const plan = planCadence(input({ minFleetBalanceMotes: "0", selfCustodialBets: true }));
    expect(plan.allowProphetBets).toBe(false);
  });

  it("stops only when even the best-funded agent is below the floor", () => {
    const plan = planCadence(
      input({
        minFleetBalanceMotes: "0",
        maxFleetBalanceMotes: motesFor(BETTING_FLOOR_ROUNDS - 1),
        selfCustodialBets: true,
      }),
    );
    expect(plan.allowProphetBets).toBe(false);
    expect(plan.reason).toContain("best-funded");
  });
});

describe("runway in hours", () => {
  it("converts rounds at the real ten-minute tick cadence", () => {
    expect(TICK_INTERVAL_MS).toBe(600_000);
    expect(runwayHours(6)).toBe(1);
    expect(runwayHours(BETTING_FLOOR_ROUNDS)).toBe(2);
    expect(runwayHours(CREATION_FLOOR_ROUNDS)).toBe(8);
    expect(runwayHours(SEEDING_FLOOR_ROUNDS)).toBe(24);
  });

  it("reports an unspent purse as unlimited rather than dividing by zero", () => {
    expect(roundsOfRunway("1000", "0")).toBe(Number.POSITIVE_INFINITY);
    expect(runwayHours(roundsOfRunway("1000", "0"))).toBe(Number.POSITIVE_INFINITY);
  });

  it("floors an empty purse at zero rounds, not a negative or a throw", () => {
    expect(roundsOfRunway("0", PER_ROUND)).toBe(0);
    expect(runwayHours(0)).toBe(0);
  });
});

describe("the documented floors still mean what the docstring says", () => {
  it("keeps the degradation ORDER: seeding first, then creation, then betting", () => {
    const seedingOnly = planCadence(input({ treasuryMotes: motesFor(SEEDING_FLOOR_ROUNDS - 1) }));
    expect(seedingOnly.allowHouseSeeding).toBe(false);
    expect(seedingOnly.allowMarketCreation).toBe(true);
    expect(seedingOnly.allowProphetBets).toBe(true);

    const creationOff = planCadence(input({ treasuryMotes: motesFor(CREATION_FLOOR_ROUNDS - 1) }));
    expect(creationOff.allowMarketCreation).toBe(false);
    expect(creationOff.allowProphetBets).toBe(true);
  });
});
