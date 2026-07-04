/**
 * GET /api/markets?network=testnet|mainnet[&category=…] — the market read model.
 *
 * The chain is the source of truth for money; this route serves the off-chain `MarketStore`
 * index (metadata + cached pools) that the explorer renders. Today the store returns the
 * config-driven catalogue; once S5 makes the store record live bets, the SAME endpoint
 * surfaces live pools with no UI change — which is exactly why the explorer reads it rather
 * than the bundled catalogue directly.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { isCasperNetwork } from "@/config/network";
import type { MarketCategory } from "@/core/types";

const CATEGORIES: readonly MarketCategory[] = ["casper-native", "provably-fair", "rwa", "meta"];

function isCategory(v: unknown): v is MarketCategory {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const network = url.searchParams.get("network");
  if (!isCasperNetwork(network)) {
    return NextResponse.json({ error: "network must be 'testnet' or 'mainnet'" }, { status: 400 });
  }
  const categoryParam = url.searchParams.get("category");
  const category = isCategory(categoryParam) ? categoryParam : undefined;

  const container = createContainer(network);
  const markets = await container.store.list({ network, category });
  return NextResponse.json({ network, count: markets.length, markets });
}
