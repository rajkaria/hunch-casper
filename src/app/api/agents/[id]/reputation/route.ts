/**
 * GET /api/agents/[id]/reputation — "how good is this agent, really?"
 *
 * The seed of the credit bureau for AI agents. Every number here is folded from the vault's own
 * event log, so a consumer can recompute it from the chain instead of trusting this endpoint —
 * which is the only thing that makes a reputation API worth paying for later (S26 meters it).
 *
 * The response leads with **calibration, not PnL**. An agent that only backs 90 % favourites shows
 * a healthy profit and has told you nothing; the Brier score says whether its probabilities are
 * worth reading. `sampleCount` travels with it so a reader can see how much evidence the number
 * rests on rather than trusting a confident-looking score built on two bets.
 *
 * Manipulation signals are returned as evidence, never as a verdict — every heuristic has an
 * innocent explanation, and consumers should apply their own tolerance. Free tier for now.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { DEFAULT_NETWORK, isCasperNetwork } from "@/config/network";
import { buildAgentRecords, type MarketMeta } from "@/core/agent-record";
import { detectWashTrading, signalsFor } from "@/core/wash-trading";
import { BASELINE_BRIER } from "@/core/calibration";
import { MARKET_DEFINITIONS } from "@/core/catalogue";

export const dynamic = "force-dynamic";

const MAX_EVENTS = 5_000;

/** Category and fee per slug, so per-category expertise has categories to group by. */
function catalogueMeta(): Record<string, MarketMeta> {
  const meta: Record<string, MarketMeta> = {};
  for (const definition of MARKET_DEFINITIONS) {
    meta[definition.slug] = { category: definition.category, feeBps: definition.feeBps };
  }
  return meta;
}

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const agent = decodeURIComponent(id);
  const param = new URL(req.url).searchParams.get("network");
  const network = isCasperNetwork(param) ? param : DEFAULT_NETWORK;

  const container = createContainer(network);
  const events = await container.events.fetch({ limit: MAX_EVENTS });
  const record = buildAgentRecords(events, catalogueMeta()).find((r) => r.agent === agent);

  if (!record) {
    // 404 rather than an empty record: "this agent has no history" and "this agent does not exist"
    // are different answers, and a consumer scoring an unknown id as zero would be misled.
    return NextResponse.json(
      { error: `no on-chain betting history for agent '${agent}' on ${network}`, network, agent },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  const signals = signalsFor(detectWashTrading(events), agent);

  return NextResponse.json(
    {
      network,
      agent: record.agent,
      source: "chain-events",
      /** Lower Brier is better; 0.25 is the always-50 % baseline, so `skillBps > 0` beats a coin flip. */
      calibration: { ...record.calibration, baselineBrier: BASELINE_BRIER },
      byCategory: record.byCategory,
      performance: {
        realizedPnlMotes: record.realizedPnlMotes,
        roiBps: record.roiBps,
        stakedMotes: record.stakedMotes,
        returnedMotes: record.returnedMotes,
        volumeMotes: record.volumeMotes,
        settledCount: record.settledCount,
        wins: record.wins,
        winRate: record.winRate,
        betCount: record.betCount,
        marketCount: record.marketCount,
      },
      activity: { firstBetAt: record.firstBetAt, lastBetAt: record.lastBetAt },
      /** Evidence for a human decision, not a verdict. Strongest first. */
      manipulationSignals: signals,
      caveats: [
        record.calibration.sampleCount < 10
          ? "fewer than 10 settled forecasts — the calibration score is not yet meaningful"
          : null,
        signals.length > 0 ? "manipulation heuristics flagged this agent; review the signals" : null,
      ].filter(Boolean),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
