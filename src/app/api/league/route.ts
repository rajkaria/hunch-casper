/**
 * GET /api/league — the Casper Agent League standings.
 *
 * A permanent all-time board is a closed door: whoever started first is ahead and the gap only
 * grows. Seasons make every window a fresh contest, which is what turns the registry into a reason
 * for a developer to show up.
 *
 * Standings rank **calibration first**, with a participation floor — a season with prize money on
 * it must not be won by one lucky bet, and ranking by PnL would crown whoever took the most risk
 * during a good week rather than whoever forecast best.
 *
 * `?cadence=weekly|monthly`, `?season=<index>` for one season, `?archive=true` for every season to
 * date. Everything is folded from chain events, so any standing here is recomputable.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { DEFAULT_NETWORK, isCasperNetwork } from "@/config/network";
import {
  LEAGUE_EPOCH_MS,
  SEASON_MIN_SETTLED,
  seasonArchive,
  seasonAt,
  seasonByIndex,
  seasonStandings,
  seasonWinner,
  type SeasonCadence,
} from "@/core/seasons";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import type { MarketMeta } from "@/core/agent-record";

export const dynamic = "force-dynamic";

const MAX_EVENTS = 5_000;

function catalogueMeta(): Record<string, MarketMeta> {
  const meta: Record<string, MarketMeta> = {};
  for (const definition of MARKET_DEFINITIONS) {
    meta[definition.slug] = { category: definition.category, feeBps: definition.feeBps };
  }
  return meta;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const param = url.searchParams.get("network");
  const network = isCasperNetwork(param) ? param : DEFAULT_NETWORK;
  const cadence: SeasonCadence = url.searchParams.get("cadence") === "monthly" ? "monthly" : "weekly";
  const seasonParam = Number(url.searchParams.get("season"));
  const wantArchive = url.searchParams.get("archive") === "true";
  const now = Date.now();

  const container = createContainer(network);
  const events = await container.events.fetch({ limit: MAX_EVENTS });
  const meta = catalogueMeta();

  if (wantArchive) {
    const archive = seasonArchive(events, cadence, LEAGUE_EPOCH_MS, now, meta);
    return NextResponse.json(
      {
        network,
        cadence,
        minSettledToWin: SEASON_MIN_SETTLED,
        seasons: archive.map((entry) => ({
          ...entry.season,
          closed: entry.closed,
          winner: entry.winner,
          standings: entry.standings,
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const season =
    Number.isInteger(seasonParam) && seasonParam >= 0
      ? seasonByIndex(cadence, LEAGUE_EPOCH_MS, seasonParam)
      : seasonAt(cadence, LEAGUE_EPOCH_MS, now);
  const standings = seasonStandings(events, season, meta);

  return NextResponse.json(
    {
      network,
      season,
      /** Provisional while the window is open — a UI must not present these as final. */
      closed: now >= season.endMs,
      minSettledToWin: SEASON_MIN_SETTLED,
      /** `null` means nobody cleared the floor: the league meta-market voids rather than crowning. */
      winner: seasonWinner(standings)?.agent ?? null,
      standings,
      source: "chain-events",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
