/**
 * POST /api/markets/create — human market creation over the x402 rail.
 *
 * The handshake mirrors the bet route: POST a claim + resolution rule with no `X-PAYMENT` → 402
 * with the creation-bond requirement + the recipe hash; pay the bond and retry with the proof →
 * the market is composed, opened on chain (real mode), registered, and fleet-seeded. The recipe is
 * frozen and its hash returned so the creator can confirm what the market will resolve on (S24
 * commits that same hash on chain).
 *
 * Every rejection is deliberate: `422` category-policy block, `409` duplicate, `400` bad
 * recipe/oracle, `402` bad bond, `503` real-mode-not-configured.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { createMarket } from "@/lib/market-create";
import { hydrateEconomyState, persistEconomyState } from "@/adapters/persist/economy-state";
import { isCasperNetwork } from "@/config/network";
import type { X402PaymentProof } from "@/ports/payment";
import type { ResolverComparator, ResolverKind, ResolverSource, MarketOutcome } from "@/core/types";
import { listCreatedMarkets } from "@/adapters/mock/market-source";

function readPaymentHeader(req: Request): X402PaymentProof | undefined {
  const header = req.headers.get("x-payment");
  if (!header) return undefined;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as X402PaymentProof;
  } catch {
    return undefined;
  }
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
  // Compose on top of the persisted economy, not a cold instance's empty seed — the slug seq and
  // the duplicate check both read the created-markets list (no-op when KV is unconfigured).
  await hydrateEconomyState();
  const container = createContainer(network);

  const res = await createMarket(container, {
    claim: String(body.claim ?? ""),
    creator: String(body.creator ?? ""),
    oracle: String(body.oracle ?? ""),
    network,
    seq: listCreatedMarkets().length,
    deadlineIso: String(body.deadlineIso ?? ""),
    source: body.source as ResolverSource,
    metric: String(body.metric ?? ""),
    method: body.method as ResolverKind,
    target: body.target === undefined ? undefined : String(body.target),
    comparator: body.comparator === undefined ? undefined : (body.comparator as ResolverComparator),
    outcomes: Array.isArray(body.outcomes) ? (body.outcomes as MarketOutcome[]) : undefined,
    feeBps: typeof body.feeBps === "number" ? body.feeBps : undefined,
    seedByFleet: body.seedByFleet !== false,
    paymentProof: readPaymentHeader(req),
  });

  if (res.status === "error") {
    return NextResponse.json({ error: res.error, reason: res.reason }, { status: res.code });
  }
  if (res.status === "payment_required") {
    const r = res.requirement;
    return NextResponse.json(
      {
        x402Version: 1,
        error: "creation bond required",
        recipeHash: res.recipeHash,
        accepts: [
          {
            scheme: "casper-x402",
            network: r.network,
            asset: "CSPR",
            maxAmountRequired: res.bondMotes,
            payTo: r.payTo,
            nonce: r.nonce,
            resource: `/api/markets/create#${r.nonce}`,
          },
        ],
      },
      { status: 402 },
    );
  }

  // Await the KV flush before responding: a 201 names a REAL on-chain market (vault entry, bond
  // spent), and a serverless instance may freeze the moment the response returns — a
  // fire-and-forget persist here is how the app forgot a market the chain still has.
  await persistEconomyState();

  const paymentResponse = Buffer.from(JSON.stringify({ success: true, slug: res.slug })).toString("base64");
  return NextResponse.json(
    {
      slug: res.slug,
      recipeHash: res.recipeHash,
      deployHash: res.deployHash,
      explorerUrl: res.explorerUrl,
      simulated: res.simulated,
      seededBets: res.seededBets,
      network,
    },
    { status: 201, headers: { "X-PAYMENT-RESPONSE": paymentResponse } },
  );
}
