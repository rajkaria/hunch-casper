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

export type EconomyCadence = "full" | "reduced" | "minimal" | "paused";

export interface CadenceInput {
  /** Operator/deployer purse, in motes — funds market creation and bet escrow. */
  treasuryMotes: string;
  /** The POOREST agent purse, in motes. The fleet is as healthy as its weakest member. */
  minFleetBalanceMotes: string;
  /** What one full round costs the treasury, in motes. */
  perRoundTreasuryCostMotes: string;
  /** What one full round costs a single agent, in motes. */
  perRoundAgentCostMotes: string;
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

  // Seeding and creation are treasury-funded; betting is agent-funded. Each capability is gated
  // by the purse that actually pays for it, so a rich treasury never masks a starving fleet.
  const allowHouseSeeding = treasuryRounds >= SEEDING_FLOOR_ROUNDS;
  const allowMarketCreation = treasuryRounds >= CREATION_FLOOR_ROUNDS;
  const allowProphetBets = fleetRounds >= BETTING_FLOOR_ROUNDS;

  let cadence: EconomyCadence;
  if (!allowProphetBets && !allowMarketCreation) cadence = "paused";
  else if (!allowMarketCreation) cadence = "minimal";
  else if (!allowHouseSeeding) cadence = "reduced";
  else cadence = "full";

  const reason =
    cadence === "full"
      ? `full cadence — ${treasuryRounds} treasury rounds and ${fleetRounds} fleet rounds of runway`
      : [
          !allowHouseSeeding && `house seeding off (treasury runway ${treasuryRounds} < ${SEEDING_FLOOR_ROUNDS})`,
          !allowMarketCreation && `market creation off (treasury runway ${treasuryRounds} < ${CREATION_FLOOR_ROUNDS})`,
          !allowProphetBets && `prophet betting off (fleet runway ${fleetRounds} < ${BETTING_FLOOR_ROUNDS})`,
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
