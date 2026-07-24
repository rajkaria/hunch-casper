/**
 * GET /api/stats — the economy's headline numbers, folded from chain events.
 *
 * The same source `/api/boards` uses, so every figure here is recomputable by anyone with the
 * contract hashes. `eventCount` travels with the numbers on purpose: a zero board because nothing
 * has happened and a zero board because the fold is blind look identical without it, and telling
 * those apart is exactly what production could not do for weeks.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { DEFAULT_NETWORK, getNetworkConfig, isCasperNetwork } from "@/config/network";
import { computeStats } from "@/core/stats";

export const dynamic = "force-dynamic";

const MAX_EVENTS = 5_000;

export async function GET(req: Request): Promise<Response> {
  const param = new URL(req.url).searchParams.get("network");
  const network = isCasperNetwork(param) ? param : DEFAULT_NETWORK;
  const cfg = getNetworkConfig(network);

  const container = createContainer(network);
  const events = await container.events.fetch({ limit: MAX_EVENTS });
  const stats = computeStats(events);

  return NextResponse.json(
    {
      network,
      source: "chain-events",
      ...stats,
      /** The packages these numbers were folded from — so a reader can rerun the fold. */
      contracts: {
        vaultV2: cfg.contracts.vaultV2 ?? null,
        marketPackages: Object.values(cfg.marketAddresses ?? {}),
      },
      explorerBaseUrl: cfg.explorerBaseUrl,
    },
    { headers: { "cache-control": "public, max-age=30, stale-while-revalidate=120" } },
  );
}
