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
import { DEFAULT_NETWORK, isCasperNetwork } from "@/config/network";
import { ensureDemoSeed } from "@/adapters/mock/demo-seed";
import type { MarketCategory } from "@/core/types";

const CATEGORIES: readonly MarketCategory[] = ["casper-native", "provably-fair", "rwa", "meta"];

function isCategory(v: unknown): v is MarketCategory {
  return typeof v === "string" && (CATEGORIES as readonly string[]).includes(v);
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Missing ⇒ the configured default; present-but-invalid stays a 400 (a typo'd network should
  // fail loudly, not silently serve the wrong catalogue).
  const network = url.searchParams.get("network") ?? DEFAULT_NETWORK;
  if (!isCasperNetwork(network)) {
    return NextResponse.json({ error: "network must be 'testnet' or 'mainnet'" }, { status: 400 });
  }
  const categoryParam = url.searchParams.get("category");
  const category = isCategory(categoryParam) ? categoryParam : undefined;

  ensureDemoSeed(network); // keep /markets consistent with the seeded /agents boards (no-op in test/real)
  const container = createContainer(network);
  const markets = await container.store.list({ network, category });
  return NextResponse.json({ network, count: markets.length, markets });
}
