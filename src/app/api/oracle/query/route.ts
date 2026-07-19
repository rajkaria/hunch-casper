/**
 * POST /api/oracle/query — the oracle as a product (S26). "Is this claim true?" for a market,
 * priced per query via x402, with a free ecosystem tier.
 *
 * Body: `{ network, slug, caller? }`. The answer carries the decided outcome, the evidence-bundle
 * hash (so the buyer can audit it — S24), and the answering oracle's on-chain reputation (so they
 * can weigh it). Metering (`core/query-pricing.ts`): each caller gets N free queries per hour; past
 * that the response is a 402 x402 challenge, and a valid payment proof (replay-protected) unlocks
 * the answer. The same meter fronts the S19 reputation queries.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { isCasperNetwork } from "@/config/network";
import { resolutionEvidenceFor } from "@/adapters/mock/resolution-evidence-ledger";
import { meterCall, enforcePayment, readPaymentProof, __resetSharedQueryMeter } from "@/lib/query-meter";

/** Test-only reset — delegates to the shared meter so this and /api/odds share one pool. */
export function __resetQueryMeter(): void {
  __resetSharedQueryMeter();
}

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { network } = body ?? {};
  if (!isCasperNetwork(network)) {
    return NextResponse.json({ error: "network must be 'testnet' or 'mainnet'" }, { status: 400 });
  }
  const slug = String(body.slug ?? "");
  if (slug.length === 0) return NextResponse.json({ error: "slug is required" }, { status: 400 });
  const caller = String(body.caller ?? req.headers.get("x-oracle-key") ?? "anonymous");

  const container = createContainer(network);
  const decision = meterCall(caller, Date.now());

  // Paid path: a valid, unspent proof is required once the free tier is exhausted.
  if (decision.requiresPayment) {
    const gate = await enforcePayment(
      container,
      decision,
      caller,
      `${network}:${slug}`,
      `/api/oracle/query#${slug}`,
      readPaymentProof(req),
    );
    if (!gate.ok) {
      const payload = "challenge" in gate ? gate.challenge : { error: gate.error };
      return NextResponse.json(payload as object, { status: 402 });
    }
  }

  // Compose the answer.
  const market = await container.store.get(slug, network);
  if (!market) return NextResponse.json({ error: `no market '${slug}' on ${network}` }, { status: 404 });
  const settlement = await container.store.settlementFor(market.id);
  const evidence = resolutionEvidenceFor(market.id);
  const reputation = await container.oracle.reputationOf("arbiter");

  const resolved = settlement?.status === "resolved";
  const winningOutcomeKey = settlement?.winningOutcomeKey ?? null;
  // The affirmative outcome (yes/up/heads) is the first outcome key by convention.
  const claimResolvedTrue = resolved ? winningOutcomeKey === market.outcomes[0]?.key : null;

  return NextResponse.json(
    {
      market: { slug, question: market.title, status: market.status },
      answer: {
        resolved,
        winningOutcomeKey,
        claimResolvedTrue,
      },
      evidence: evidence ? { recipeHash: evidence.recipeHash, bundleHash: evidence.bundleHash, uri: evidence.uri } : null,
      oracle: { id: reputation.oracleId, accuracyBps: reputation.accuracyBps, resolvedCount: reputation.resolvedCount },
      meter: { tier: decision.free ? "free" : "paid", remainingFree: decision.remainingFree },
    },
    { status: 200 },
  );
}
