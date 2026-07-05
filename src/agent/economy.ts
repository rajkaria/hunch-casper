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
import { runProphetFleet } from "@/agent/prophet";
import { runArbiterSweep, resolveMarket } from "@/agent/arbiter";

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
}

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
  // 1. Prophets bet — pools move, rivalry plays out.
  const prophetActions = await runProphetFleet(container, input.seq);

  // 2. Arbiter resolves everything matured (unattended), then any explicit weekly closes. Explicit
  //    closes run last so meta-markets settle against the boards this tick's resolutions produced.
  const arbiterActions = await runArbiterSweep(container);
  for (const slug of input.resolveSlugs ?? []) {
    const action = await resolveMarket(container, slug);
    if (action) arbiterActions.push(action);
  }

  // 3. Snapshot the boards those actions just changed.
  const leaderboard = computeAgentLeaderboard(await container.store.settledEntries(container.network));
  const oracleBoard = await container.oracle.leaderboard();

  return { seq: input.seq, prophetActions, arbiterActions, leaderboard, oracleBoard };
}
