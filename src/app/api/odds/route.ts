/**
 * GET /api/odds — the live probability feed (S27). Sell the number.
 *
 * Returns current pool-implied probabilities for open markets (or one, via `?slug=`), x402-metered
 * through the shared meter (`lib/query-meter.ts`): free ecosystem tier, then a 402 challenge. This
 * is the same math the UI and the vault settle with — the number the feed sells is the number the
 * money path uses, never a separate estimate.
 *
 * Response is cache-friendly (short s-maxage) so a widely-embedded feed stays off the origin.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { DEFAULT_NETWORK, isCasperNetwork } from "@/config/network";
import { computeOdds } from "@/core/parimutuel-odds";
import { motesToCspr } from "@/core/types";
import { meterCall, enforcePayment, readPaymentProof } from "@/lib/query-meter";

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;
  const netParam = params.get("network");
  const network = isCasperNetwork(netParam) ? netParam : DEFAULT_NETWORK;
  const slug = params.get("slug");
  const caller = params.get("caller") ?? req.headers.get("x-oracle-key") ?? "anonymous";

  const container = createContainer(network);
  const decision = meterCall(caller, Date.now());

  if (decision.requiresPayment) {
    const gate = await enforcePayment(
      container,
      decision,
      caller,
      `${network}:odds`,
      "/api/odds",
      readPaymentProof(req),
    );
    if (!gate.ok) {
      const payload = "challenge" in gate ? gate.challenge : { error: gate.error };
      return NextResponse.json(payload as object, { status: 402 });
    }
  }

  const markets = slug
    ? [await container.store.get(slug, network)].filter((m): m is NonNullable<typeof m> => m !== null)
    : (await container.store.list({ network, status: "open" }));

  if (slug && markets.length === 0) {
    return NextResponse.json({ error: `no market '${slug}' on ${network}` }, { status: 404 });
  }

  const feed = markets.map((m) => ({
    slug: m.slug,
    question: m.title,
    status: m.status,
    poolCspr: Number(motesToCspr(m.totalStakedMotes).toFixed(2)),
    outcomes: computeOdds(m).map((o) => ({
      outcomeKey: o.outcomeKey,
      probability: Math.round(o.impliedProbability * 10000) / 10000,
      payoutMultiple: Math.round(o.payoutMultiple * 100) / 100,
    })),
  }));

  return NextResponse.json(
    { network, count: feed.length, meter: { tier: decision.free ? "free" : "paid", remainingFree: decision.remainingFree }, odds: feed },
    { status: 200, headers: { "cache-control": "public, max-age=15, s-maxage=30, stale-while-revalidate=120" } },
  );
}
