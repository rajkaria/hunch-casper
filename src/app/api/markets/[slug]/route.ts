/**
 * GET /api/markets/[slug]?network=testnet|mainnet — one market from the read model.
 *
 * Backs the market detail page. Same store as the list route, so the detail page's odds and
 * total-betted block reflect whatever the store knows (seed pools now; live pools after S5).
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { DEFAULT_NETWORK, isCasperNetwork } from "@/config/network";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  // Same contract as the list route: missing ⇒ DEFAULT_NETWORK, invalid ⇒ 400.
  const network = url.searchParams.get("network") ?? DEFAULT_NETWORK;
  if (!isCasperNetwork(network)) {
    return NextResponse.json({ error: "network must be 'testnet' or 'mainnet'" }, { status: 400 });
  }

  const container = createContainer(network);
  const market = await container.store.get(slug, network);
  if (!market) {
    return NextResponse.json({ error: `no market '${slug}' on ${network}` }, { status: 404 });
  }
  return NextResponse.json({ market });
}
