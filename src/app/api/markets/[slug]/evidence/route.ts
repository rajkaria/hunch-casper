/**
 * GET /api/markets/[slug]/evidence?network= — the published evidence bundle for a settled market,
 * plus an independent replay verification of it.
 *
 * "Audit this resolution" is one request: it returns the recipe hash + bundle hash committed at
 * resolution, the full bundle body (sources, snapshot, reasoning), and a `verification` block that
 * recomputes the recipe hash, recomputes the bundle's content hash, and replays the recipe against
 * the snapshot to confirm the recorded winner. All three must be true for `verification.ok`.
 * `404` when the market has no published evidence (never resolved, or resolved before S24).
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { DEFAULT_NETWORK, isCasperNetwork } from "@/config/network";
import { resolutionEvidenceFor } from "@/adapters/mock/resolution-evidence-ledger";
import { findDefinition } from "@/adapters/mock/market-source";
import { recipeFromBinding } from "@/core/resolution-recipe";
import { verifyResolution } from "@/core/resolution-replay";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  const netParam = new URL(req.url).searchParams.get("network");
  const network = isCasperNetwork(netParam) ? netParam : DEFAULT_NETWORK;
  const container = createContainer(network);

  const marketId = `${network}:${slug}`;
  const link = resolutionEvidenceFor(marketId);
  if (!link) {
    return NextResponse.json({ error: "no published evidence for this market" }, { status: 404 });
  }
  const bundle = await container.evidence.get(link.bundleHash);
  if (!bundle) {
    return NextResponse.json({ error: "evidence bundle not found in the store" }, { status: 404 });
  }

  const def = findDefinition(slug);
  let verification = null;
  if (def) {
    const recipe = recipeFromBinding(def.resolver, def.outcomes.map((o) => o.key), def.deadlineIso);
    verification = verifyResolution(recipe, bundle, link.bundleHash);
  }

  return NextResponse.json(
    { link, bundle, verification },
    { headers: { "cache-control": "public, max-age=30, s-maxage=120" } },
  );
}
