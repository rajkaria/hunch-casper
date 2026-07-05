/**
 * The agent PnL leaderboard — pure, deterministic accounting of how each agent is doing, folded
 * from settled markets' escrowed stakes + the payout manifests the pure engine produced. It reads
 * the SAME numbers the on-chain `claim()` pays (via `computeMarketPayouts`), so an agent's realized
 * PnL is money-faithful, never an LLM estimate. This is the board the `prophet-race-weekly` and
 * `momentum-vs-contrarian-weekly` meta-markets resolve against: the economy scoring itself.
 *
 * Realized PnL for an agent = Σ over settled markets (payout received − stake placed). Winners on
 * a resolved market get stake + share of the losing pool; losers get nothing; a void refunds the
 * full stake (PnL 0 on that market). Only `agent:*` bettors are ranked — the house liquidity and
 * human bettors are excluded, so the board is exactly the agent swarm's performance.
 */

/** One settled market's inputs to the board: who staked what, and what the engine paid out. */
export interface SettledStakeEntry {
  /** `bettor -> (outcomeKey -> motes)` — the escrowed stakes for this market. */
  stakesByBettor: Record<string, Record<string, string>>;
  /** The settlement manifest — its `payouts` map (`bettor -> motes`) is the money authority. */
  manifest: { payouts: Record<string, string> };
}

export interface AgentPnl {
  /** Bettor id on the money path, e.g. `agent:momentum`. */
  agent: string;
  /** Display name derived from the id (`agent:momentum` → `Momentum`). */
  name: string;
  /** Total staked across settled markets, in motes. */
  stakedMotes: string;
  /** Total returned (payouts) across settled markets, in motes. */
  returnedMotes: string;
  /** Realized PnL = returned − staked, in motes (signed; may be negative). */
  realizedPnlMotes: string;
  /** Return on stake in basis points (0 when nothing staked; floors toward zero, signed). */
  roiBps: number;
  /** Number of settled markets the agent participated in. */
  settledCount: number;
  /** Of those, how many returned more than was staked (a net-positive market). */
  wins: number;
}

const AGENT_PREFIX = "agent:";

function sumStakes(byOutcome: Record<string, string>): bigint {
  let total = 0n;
  for (const v of Object.values(byOutcome)) total += BigInt(v);
  return total;
}

/** `agent:momentum` → `Momentum`; `agent:quote` → `Quote`. Pure, UI-agnostic. */
function displayName(agentId: string): string {
  const bare = agentId.startsWith(AGENT_PREFIX) ? agentId.slice(AGENT_PREFIX.length) : agentId;
  return bare.replace(/^\w/, (c) => c.toUpperCase());
}

interface Tally {
  staked: bigint;
  returned: bigint;
  settled: number;
  wins: number;
}

/**
 * Compute the agent PnL leaderboard from settled markets. Pure: given the same entries, always the
 * same board. Ranked by realized PnL (desc), tie-broken by less staked (higher ROI) then agent id
 * — fully deterministic. Only `agent:*` bettors are included.
 */
export function computeAgentLeaderboard(entries: readonly SettledStakeEntry[]): AgentPnl[] {
  const tallies = new Map<string, Tally>();

  for (const entry of entries) {
    for (const [bettor, byOutcome] of Object.entries(entry.stakesByBettor)) {
      if (!bettor.startsWith(AGENT_PREFIX)) continue;
      const staked = sumStakes(byOutcome);
      if (staked === 0n) continue;
      const returned = BigInt(entry.manifest.payouts[bettor] ?? "0");
      const t = tallies.get(bettor) ?? { staked: 0n, returned: 0n, settled: 0, wins: 0 };
      t.staked += staked;
      t.returned += returned;
      t.settled += 1;
      if (returned > staked) t.wins += 1;
      tallies.set(bettor, t);
    }
  }

  const board: AgentPnl[] = [];
  for (const [agent, t] of tallies) {
    const pnl = t.returned - t.staked;
    const roiBps = t.staked > 0n ? Number((pnl * 10_000n) / t.staked) : 0;
    board.push({
      agent,
      name: displayName(agent),
      stakedMotes: t.staked.toString(),
      returnedMotes: t.returned.toString(),
      realizedPnlMotes: pnl.toString(),
      roiBps,
      settledCount: t.settled,
      wins: t.wins,
    });
  }

  board.sort((a, b) => {
    const pa = BigInt(a.realizedPnlMotes);
    const pb = BigInt(b.realizedPnlMotes);
    if (pa !== pb) return pb > pa ? 1 : -1; // higher PnL first
    const sa = BigInt(a.stakedMotes);
    const sb = BigInt(b.stakedMotes);
    if (sa !== sb) return sa > sb ? 1 : -1; // less staked (higher ROI) first
    return a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0; // stable by id
  });

  return board;
}
