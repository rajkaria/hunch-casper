/**
 * POST /api/agent/v1/bet — the x402 REST rail for agents that don't speak MCP.
 *
 * The HTTP-402 handshake: POST a bet with no `X-PAYMENT` header → 402 with the payment
 * requirements (what to pay, where, the nonce) + a payout preview. Pay the CSPR, then retry with
 * `X-PAYMENT: base64(json({ scheme, deployHash, nonce }))` → the proof is verified and the bet is
 * escrowed + indexed, returning `X-PAYMENT-RESPONSE`. Same money path as the human UI and MCP.
 */

import { NextResponse } from "next/server";
import { createContainer } from "@/lib/container";
import { agentBet } from "@/lib/agent-bet";
import { hydrateEconomyState, persistEconomyState } from "@/adapters/persist/economy-state";
import { isCasperNetwork } from "@/config/network";
// The published `x402-casper` package IS this module — the rail the fleet runs on is the rail
// the package exports, so the two can never drift into "works for us, broken for you".
import {
  encodeChallenge,
  encodePaymentResponse,
  readProof,
  PAYMENT_RESPONSE_HEADER,
} from "@/x402";

export async function POST(req: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { network, marketId, outcomeKey, amountMotes, bettor } = body ?? {};
  if (!isCasperNetwork(network)) {
    return NextResponse.json({ error: "network must be 'testnet' or 'mainnet'" }, { status: 400 });
  }

  // Bet on top of the persisted economy, not a cold instance's seed (no-op when KV is off).
  await hydrateEconomyState();
  const container = createContainer(network);
  const res = await agentBet(container, {
    marketId: String(marketId ?? ""),
    outcomeKey: String(outcomeKey ?? ""),
    amountMotes: String(amountMotes ?? ""),
    bettor: String(bettor ?? ""),
    paymentProof: readProof(req),
  });

  if (res.status === "error") {
    return NextResponse.json({ error: res.error }, { status: res.code });
  }

  if (res.status === "payment_required") {
    return NextResponse.json(
      {
        ...encodeChallenge(res.requirement, `/api/agent/v1/bet#${marketId}:${outcomeKey}`),
        previewPayoutMotes: res.previewPayoutMotes,
      },
      { status: 402 },
    );
  }

  // Placed. Await the KV flush before responding — the escrow is already on chain, and a
  // serverless freeze after a fire-and-forget persist would drop the bet from the app's mirror.
  await persistEconomyState();
  const paymentResponse = encodePaymentResponse(res.deployHash);
  return NextResponse.json(
    {
      deployHash: res.deployHash,
      explorerUrl: res.explorerUrl,
      network,
      marketId: String(marketId),
      outcomeKey: String(outcomeKey),
      indexed: res.indexed,
      totalStakedMotes: res.totalStakedMotes,
      poolByOutcomeMotes: res.poolByOutcomeMotes,
    },
    { status: 200, headers: { [PAYMENT_RESPONSE_HEADER]: paymentResponse } },
  );
}
