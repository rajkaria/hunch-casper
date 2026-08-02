/**
 * Economy cadence — how much the economy is allowed to do this tick, given what it can afford.
 *
 * Real mode spends real CSPR every ten minutes, unattended. Left alone it will eventually run the
 * treasury or the fleet purses to zero, and the failure mode is ugly: transactions start reverting
 * for insufficient funds, each burning gas, so an economy that is nearly broke drains *faster*
 * than one that is healthy. The fix is to degrade on purpose and in a fixed order, long before
 * the balance reaches zero.
 *
 * The order is chosen by what the surface loses:
 *   1. **House seeding** goes first. It is the most expensive per unit of value (a fresh pool per
 *      new market) and the most replaceable — an unseeded market is thin, not broken.
 *   2. **Market creation** goes second. The catalogue stops growing; everything already live keeps
 *      trading and settling.
 *   3. **Prophet bets** go last, because they are the visible loop. An economy that stops betting
 *      looks dead even if it is merely poor.
 *   4. **Resolution is never throttled.** Settling a matured market pays people what they are owed
 *      and refunds a creation bond; withholding it to save gas would strand user money to protect
 *      the operator's, which is exactly backwards.
 *
 * Pure: a function of balances and per-round costs, so every tier is a table test and nothing here
 * needs a chain to be verified.
 */

import type { MarketCadence } from "@/core/types";
import { cadenceIntervalMs } from "@/core/round-schedule";

export type EconomyCadence = "full" | "reduced" | "minimal" | "paused";

export interface CadenceInput {
  /** Operator/deployer purse, in motes — funds market creation and bet escrow. */
  treasuryMotes: string;
  /** The POOREST agent purse, in motes — the early-warning number the plan reports. */
  minFleetBalanceMotes: string;
  /**
   * The RICHEST agent purse, in motes — "can ANY agent still act?".
   *
   * Betting is gated on this, not on the poorest, because each agent pays for its own turn out of
   * its own purse: one drained Prophet is one Prophet sitting rounds out (`runProphet` checks its
   * own balance and skips), not a reason to stop the other three. Gating the fleet on its weakest
   * member is how a single empty purse silenced an economy that three funded agents could still
   * have run — degrade, don't die.
   *
   * Optional so existing callers keep the old conservative behaviour: absent, it falls back to the
   * poorest purse and the gate is exactly as before.
   */
  maxFleetBalanceMotes?: string;
  /** What one full round costs the treasury, in motes. */
  perRoundTreasuryCostMotes: string;
  /** What one full round costs a single agent, in motes. */
  perRoundAgentCostMotes: string;
  /**
   * Do the agents sign and fund their own bet escrows (S30/W1)?
   *
   * This decides whether the treasury gates betting at all. Under the old two-transaction model the
   * agent paid an x402 stake but the TREASURY signed and funded the escrow, so a dry treasury made
   * every escrow revert after the agent had already paid — which is why betting was gated on both
   * purses. A self-custodial agent spends only its own purse, so a dry treasury can no longer break
   * its bet, and gating on the treasury would idle a funded fleet for no reason.
   *
   * Defaults to `false`: an unconfigured deployment keeps the conservative both-purses rule.
   */
  selfCustodialBets?: boolean;
}

export interface CadencePlan {
  cadence: EconomyCadence;
  /** Rounds the treasury can still fund. `Infinity` when the per-round cost is zero. */
  treasuryRounds: number;
  /** Rounds the poorest agent can still fund. */
  fleetRounds: number;
  allowProphetBets: boolean;
  allowMarketCreation: boolean;
  allowHouseSeeding: boolean;
  /** One sentence an operator can act on. */
  reason: string;
}

/**
 * Rounds of runway at which each capability switches off. At the 10-minute tick cadence these are
 * roughly: 24 h of seeding, 8 h of creation, 2 h of betting — enough warning to refill by hand
 * without a pager, and enough margin that a slow refill never hits the reverting-transaction
 * spiral.
 */
export const SEEDING_FLOOR_ROUNDS = 144;
export const CREATION_FLOOR_ROUNDS = 48;
export const BETTING_FLOOR_ROUNDS = 12;

/**
 * How often the economy actually ticks — the ten-minute `schedule` cron in
 * `.github/workflows/economy.yml`, the only heartbeat in production.
 *
 * Rounds are the natural unit for a spend decision and a useless unit for a human deciding whether
 * to act tonight or in the morning. This is what converts one into the other, and it lives beside
 * the floors so the two can never disagree about what a "round" is worth in wall-clock time.
 */
export const TICK_INTERVAL_MS = 10 * 60 * 1000;

/** Rounds of runway → hours, for an operator deciding how urgent a refill is. */
export function runwayHours(rounds: number): number {
  if (!Number.isFinite(rounds)) return Number.POSITIVE_INFINITY;
  return Math.round(((rounds * TICK_INTERVAL_MS) / 3_600_000) * 10) / 10;
}

/** Whole rounds `balance` can fund at `perRound`. A zero cost is unlimited, not a divide-by-zero. */
export function roundsOfRunway(balanceMotes: string, perRoundMotes: string): number {
  const perRound = BigInt(perRoundMotes);
  if (perRound <= 0n) return Number.POSITIVE_INFINITY;
  const balance = BigInt(balanceMotes);
  if (balance <= 0n) return 0;
  return Number(balance / perRound);
}

/** Decide what this tick may do. */
export function planCadence(input: CadenceInput): CadencePlan {
  const treasuryRounds = roundsOfRunway(input.treasuryMotes, input.perRoundTreasuryCostMotes);
  const fleetRounds = roundsOfRunway(input.minFleetBalanceMotes, input.perRoundAgentCostMotes);
  // "Can anyone still bet?" — the richest purse, falling back to the poorest when the caller does
  // not distinguish them (pre-S31 behaviour, unchanged).
  const bestAgentRounds = roundsOfRunway(
    input.maxFleetBalanceMotes ?? input.minFleetBalanceMotes,
    input.perRoundAgentCostMotes,
  );

  // Seeding and creation are treasury-funded, always.
  //
  // Betting depends on the custody model. Under the two-transaction model it spent from BOTH
  // purses — the agent paid the x402 stake, but the escrow that turned that payment into a bet was
  // signed and funded by the treasury — so gating on the fleet alone let a rich fleet keep paying a
  // dry treasury: every escrow reverted "Insufficient funds", the paid-not-placed breaker tripped,
  // and the agents had bought nothing.
  //
  // A self-custodial agent (S30/W1) signs and funds its own escrow, so a dry treasury cannot break
  // its bet and must not veto it. Keeping the old gate here is what left 755 CSPR of funded agents
  // idle behind an empty operator purse on 2026-08-02.
  const allowHouseSeeding = treasuryRounds >= SEEDING_FLOOR_ROUNDS;
  const allowMarketCreation = treasuryRounds >= CREATION_FLOOR_ROUNDS;
  const betsNeedTreasury = input.selfCustodialBets !== true;
  const allowProphetBets =
    bestAgentRounds >= BETTING_FLOOR_ROUNDS && (!betsNeedTreasury || treasuryRounds >= BETTING_FLOOR_ROUNDS);

  // Betting off is never "full": before this ranked, a starving fleet with a rich treasury
  // reported full cadence while placing nothing.
  let cadence: EconomyCadence;
  if (!allowProphetBets && !allowMarketCreation) cadence = "paused";
  else if (!allowProphetBets || !allowMarketCreation) cadence = "minimal";
  else if (!allowHouseSeeding) cadence = "reduced";
  else cadence = "full";

  const reason =
    cadence === "full"
      ? `full cadence — ${treasuryRounds} treasury rounds and ${fleetRounds} fleet rounds of runway`
      : [
          !allowHouseSeeding && `house seeding off (treasury runway ${treasuryRounds} < ${SEEDING_FLOOR_ROUNDS})`,
          !allowMarketCreation && `market creation off (treasury runway ${treasuryRounds} < ${CREATION_FLOOR_ROUNDS})`,
          !allowProphetBets &&
            `prophet betting off (${
              bestAgentRounds < BETTING_FLOOR_ROUNDS
                ? `fleet runway ${bestAgentRounds} even for the best-funded agent`
                : `treasury runway ${treasuryRounds}`
            } < ${BETTING_FLOOR_ROUNDS})${
              betsNeedTreasury ? "" : " — agents fund their own escrows, so only the fleet gates this"
            }`,
        ]
          .filter(Boolean)
          .join("; ") + " — refill to restore full cadence";

  return {
    cadence,
    treasuryRounds,
    fleetRounds,
    allowProphetBets,
    allowMarketCreation,
    allowHouseSeeding,
    reason,
  };
}

// ── Recurring-round economics ────────────────────────────────────────────────────────────────
//
// Recurring rounds spend real CSPR on a schedule, so the cadence a market advertises is not a
// taste decision — it is whatever the treasury can sustain. These are the numbers that decide it.

const DAY_MS = 86_400_000;
/**
 * Measured on testnet, not estimated: a typical `create_market` costs 3.74 CSPR net (the first
 * call on a fresh vault costs 4.958 — a dictionary-init spike, not the steady state). The earlier
 * "< 1 CSPR" claim was falsified on chain; do not re-estimate this from the gas limit.
 */
const CREATE_COST_MOTES = 3_740_000_000n;

/** How many rounds of a cadence open in a day. Weekly and one-shot do not roll daily. */
export function roundsPerDay(cadence: MarketCadence): number {
  const interval = cadenceIntervalMs(cadence);
  // `> DAY_MS`, not `>=`: a daily cadence is exactly one round a day, not zero.
  if (interval === null || interval > DAY_MS) return 0;
  return Math.floor(DAY_MS / interval);
}

/** What a day of rollover costs the treasury across the given markets' cadences. */
export function dailyRolloverCostMotes(cadences: MarketCadence[]): string {
  let total = 0n;
  for (const c of cadences) total += BigInt(roundsPerDay(c)) * CREATE_COST_MOTES;
  return total.toString();
}

/**
 * Whole days of rollover the treasury can fund.
 *
 * Floored on purpose: a runway figure that rounds up tells an operator they have another day when
 * they do not, and an economy that runs out mid-round burns gas on reverts — it drains FASTER when
 * it is nearly broke than when it is healthy.
 */
export function runwayDays(treasuryMotes: string, dailyCostMotes: string): number {
  const daily = BigInt(dailyCostMotes);
  if (daily === 0n) return Number.POSITIVE_INFINITY;
  return Number(BigInt(treasuryMotes) / daily);
}
