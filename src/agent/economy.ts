/**
 * The economy tick — one turn of the whole self-running loop, in the causal order that makes the
 * recursion visible: the Prophets bet (moving pools), the Arbiter resolves every matured market
 * (paying out + updating its reputation), then we snapshot the boards those actions just changed.
 * A single cron fires this and the economy advances with no human in the loop — "the full loop
 * runs unattended," made checkable. Genesis (new-market creation) is driven separately on its own
 * cadence so the catalogue doesn't grow every tick.
 */

import type { Container } from "@/lib/container";
import type { AgentAction } from "@/adapters/mock/activity-log";
import type { AgentPnl } from "@/core/agent-leaderboard";
import { computeAgentLeaderboard } from "@/core/agent-leaderboard";
import type { OracleReputation } from "@/ports/oracle";
import { runProphetFleet, prophetsPerTick, PROPHET_GAS_FLOOR_MOTES } from "@/agent/prophet";
import { runArbiterSweep, resolveMarket } from "@/agent/arbiter";
import { PROPHETS, MAX_CONVICTION_MULTIPLIER } from "@/core/prophet-strategies";
import { planCadence, type CadencePlan } from "@/core/cadence";
import { OPERATOR_AGENT_ID } from "@/adapters/casper/fleet-keys";
import { csprToMotes } from "@/core/types";
import { chainMode } from "@/config/chain-mode";
import { DEFAULT_BET_GAS_MOTES, DEFAULT_CREATE_GAS_MOTES } from "@/adapters/casper/deploy-plan";

export interface EconomyTickReport {
  seq: number;
  /** Bets the Prophet fleet placed this tick. */
  prophetActions: AgentAction[];
  /** Markets the Arbiter resolved this tick (matured sweep + any explicit closes). */
  arbiterActions: AgentAction[];
  /** The agent PnL leaderboard after this tick. */
  leaderboard: AgentPnl[];
  /** The oracle-accuracy leaderboard after this tick. */
  oracleBoard: OracleReputation[];
  /** What this tick was allowed to do, and why. `null` in mock mode (nothing costs anything). */
  cadence: CadencePlan | null;
}

/**
 * What one round costs the operator treasury: the gas to escrow every Prophet's bet, since escrow
 * is operator-funded (see the two-transaction model in the decision journal). Creation and seeding
 * are charged to the same purse but happen on their own cadence, so they are not in the per-round
 * figure — the floors in `core/cadence.ts` carry enough margin to cover them.
 */
function perRoundTreasuryCostMotes(): string {
  // Charge for the Prophets that ACTUALLY act this round, not the whole roster. Real mode sends
  // one Prophet per tick by default (`prophetsPerTick`), so billing the round at four escrows
  // understated the treasury's runway ~4× — enough to throttle house seeding off against a purse
  // that could comfortably afford it. The cadence planner is only as honest as this number.
  return (BigInt(DEFAULT_BET_GAS_MOTES) * BigInt(prophetsPerTick())).toString();
}

/**
 * What one round costs a single agent: the most it could stake plus the gas on its own x402
 * transfer. "Most it could stake" includes Momentum's conviction multiplier — clearing an agent
 * for a round it can only half-afford is the same mistake as under-funding it.
 */
function perRoundAgentCostMotes(): string {
  const largestStake = PROPHETS.reduce((max, p) => Math.max(max, p.stakeCspr), 0);
  const worstCase = BigInt(csprToMotes(largestStake)) * BigInt(MAX_CONVICTION_MULTIPLIER);
  return (worstCase + PROPHET_GAS_FLOOR_MOTES).toString();
}

/**
 * Read the purses and decide what this tick may afford.
 *
 * Returns `null` in mock mode: nothing there costs anything, and a throttle that could pause the
 * demo economy for lack of imaginary money would be a bug, not a safeguard.
 *
 * A balance read that fails is treated as zero, which throttles *down*. That is the safe
 * direction: the failure mode of under-spending is a quiet economy an operator can see and fix,
 * while the failure mode of over-spending is a purse drained by reverting transactions.
 */
async function currentCadence(container: Container): Promise<CadencePlan | null> {
  if (chainMode() !== "real") return null;
  const read = async (agentId: string): Promise<bigint> => {
    try {
      return BigInt(await container.wallet.balanceOf(agentId));
    } catch {
      return 0n;
    }
  };
  const [treasury, ...fleet] = await Promise.all([
    read(OPERATOR_AGENT_ID),
    ...PROPHETS.map((p) => read(p.id)),
  ]);
  const minFleet = fleet.length > 0 ? fleet.reduce((min, b) => (b < min ? b : min)) : 0n;
  const plan = planCadence({
    treasuryMotes: treasury.toString(),
    minFleetBalanceMotes: minFleet.toString(),
    perRoundTreasuryCostMotes: perRoundTreasuryCostMotes(),
    perRoundAgentCostMotes: perRoundAgentCostMotes(),
  });
  if (plan.cadence !== "full") console.warn(`[economy] throttled: ${plan.reason}`);
  return plan;
}

/** Gas budget one runtime market creation needs — exported so the ops docs cite one number. */
export const CREATE_MARKET_GAS_MOTES = DEFAULT_CREATE_GAS_MOTES;

export interface EconomyTickInput {
  /** Monotone round sequence (the cron passes the activity-log length). */
  seq: number;
  /**
   * Slugs to resolve explicitly this tick regardless of deadline — the weekly close for
   * meta-markets, so their settlement against the freshly-updated boards is demoable on demand.
   */
  resolveSlugs?: string[];
}

/** Run one full turn of the economy against a container's ports and return the combined report. */
export async function runEconomyTick(
  container: Container,
  input: EconomyTickInput,
): Promise<EconomyTickReport> {
  // 0. What can this tick afford? Throttling happens before anything spends, not after.
  const cadence = await currentCadence(container);

  // 1. Prophets bet — pools move, rivalry plays out.
  const prophetActions =
    cadence && !cadence.allowProphetBets ? [] : await runProphetFleet(container, input.seq);

  // 2. Arbiter resolves everything matured (unattended), then any explicit weekly closes. Explicit
  //    closes run last so meta-markets settle against the boards this tick's resolutions produced.
  //    Resolution is NEVER throttled: it pays people what they are owed and refunds creation
  //    bonds. Withholding it to save gas would strand user money to protect the operator's.
  const arbiterActions = await runArbiterSweep(container);
  for (const slug of input.resolveSlugs ?? []) {
    const action = await resolveMarket(container, slug);
    if (action) arbiterActions.push(action);
  }

  // 3. Snapshot the boards those actions just changed.
  const leaderboard = computeAgentLeaderboard(await container.store.settledEntries(container.network));
  const oracleBoard = await container.oracle.leaderboard();

  return { seq: input.seq, prophetActions, arbiterActions, leaderboard, oracleBoard, cadence };
}
