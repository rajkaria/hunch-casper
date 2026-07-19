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
import { meterQuery, queryTierFromEnv, type MeterWindow } from "@/core/query-pricing";
import { resolutionEvidenceFor } from "@/adapters/mock/resolution-evidence-ledger";
import type { X402PaymentProof } from "@/ports/payment";

/** Per-caller free-tier meter state (in-process demo; KV behind the same shape in production). */
const METER = new Map<string, MeterWindow>();
/** Spent paid-query settlements — a proof settles exactly one query. */
const CONSUMED = new Set<string>();

/** Test-only resets. */
export function __resetQueryMeter(): void {
  METER.clear();
  CONSUMED.clear();
}

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
  const slug = String(body.slug ?? "");
  if (slug.length === 0) return NextResponse.json({ error: "slug is required" }, { status: 400 });
  const caller = String(body.caller ?? req.headers.get("x-oracle-key") ?? "anonymous");

  const container = createContainer(network);
  const tier = queryTierFromEnv();
  const decision = meterQuery(caller, Date.now(), METER, tier);

  // Paid path: a valid, unspent proof is required once the free tier is exhausted.
  if (decision.requiresPayment) {
    const proof = readPaymentHeader(req);
    if (!proof) {
      const requirement = await container.payment.quote({
        marketId: `${network}:${slug}`,
        outcomeKey: "__query__",
        amountMotes: decision.priceMotes,
        payer: caller,
      });
      return NextResponse.json(
        {
          x402Version: 1,
          error: "payment required — free query tier exhausted",
          accepts: [
            {
              scheme: "casper-x402",
              network: requirement.network,
              asset: "CSPR",
              maxAmountRequired: decision.priceMotes,
              payTo: requirement.payTo,
              nonce: requirement.nonce,
              resource: `/api/oracle/query#${slug}`,
            },
          ],
        },
        { status: 402 },
      );
    }
    const requirement = await container.payment.quote({
      marketId: `${network}:${slug}`,
      outcomeKey: "__query__",
      amountMotes: decision.priceMotes,
      payer: caller,
    });
    const ok = await container.payment.verify(requirement, proof);
    if (!ok || !proof.deployHash) {
      return NextResponse.json({ error: "invalid or unverifiable x402 payment proof" }, { status: 402 });
    }
    if (CONSUMED.has(proof.deployHash)) {
      return NextResponse.json({ error: "x402 payment already spent" }, { status: 402 });
    }
    CONSUMED.add(proof.deployHash);
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
