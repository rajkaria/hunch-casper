/**
 * GET /api/boards — the leaderboards, rebuilt from chain events rather than from this server's
 * memory.
 *
 * `/api/agent/leaderboard` serves the in-process boards: fast, and something you have to take our
 * word for. This route folds the vault's own event log through the same pure payout engine the
 * contract pays from, so the numbers are a claim anyone can recompute from the chain. The
 * meta-markets settle against these boards, which is exactly why "trust us" was not good enough.
 *
 * The response carries its own provenance — how many events were folded, from which block, and
 * anything skipped — so a disagreement between the two paths is diagnosable instead of mysterious.
 * `?from=` resumes an incremental fold; `?limit=` caps the read.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { DEFAULT_NETWORK, isCasperNetwork } from "@/config/network";
import { indexEvents, settledEntriesFrom, oracleActivityFrom } from "@/core/indexer";
import { computeAgentLeaderboard } from "@/core/agent-leaderboard";

export const dynamic = "force-dynamic";

/** Cap on a single fold, so a pathological `?limit=` cannot pin the lambda. */
const MAX_EVENTS = 5_000;

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const param = url.searchParams.get("network");
  const network = isCasperNetwork(param) ? param : DEFAULT_NETWORK;
  const fromRaw = Number(url.searchParams.get("from"));
  const limitRaw = Number(url.searchParams.get("limit"));
  const fromBlockHeight = Number.isInteger(fromRaw) && fromRaw >= 0 ? fromRaw : undefined;
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_EVENTS) : MAX_EVENTS;

  const container = createContainer(network);
  const events = await container.events.fetch({ fromBlockHeight, limit });
  const state = indexEvents(events);

  return NextResponse.json(
    {
      network,
      source: "chain-events",
      agentPnl: computeAgentLeaderboard(settledEntriesFrom(state)),
      oracleActivity: oracleActivityFrom(state),
      markets: Object.values(state.markets).map((m) => ({
        marketId: m.marketId,
        status: m.status,
        winningOutcomeKey: m.winningOutcomeKey,
        poolByOutcomeMotes: m.poolByOutcomeMotes,
        resolvedBy: m.resolvedBy,
      })),
      provenance: {
        eventCount: state.eventCount,
        lastBlockHeight: state.lastBlockHeight,
        // Named, not counted: a silent skip is how an event-derived board drifts from the chain
        // while still looking healthy.
        skipped: state.skipped.map((s) => ({
          kind: s.event.kind,
          marketId: s.event.marketId,
          blockHeight: s.event.blockHeight,
          reason: s.reason,
        })),
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
