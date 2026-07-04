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
import { isCasperNetwork } from "@/config/network";
import type { X402PaymentProof } from "@/ports/payment";

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

  const { network, marketId, outcomeKey, amountMotes, bettor } = body ?? {};
  if (!isCasperNetwork(network)) {
    return NextResponse.json({ error: "network must be 'testnet' or 'mainnet'" }, { status: 400 });
  }

  const container = createContainer(network);
  const res = await agentBet(container, {
    marketId: String(marketId ?? ""),
    outcomeKey: String(outcomeKey ?? ""),
    amountMotes: String(amountMotes ?? ""),
    bettor: String(bettor ?? ""),
    paymentProof: readPaymentHeader(req),
  });

  if (res.status === "error") {
    return NextResponse.json({ error: res.error }, { status: res.code });
  }

  if (res.status === "payment_required") {
    const r = res.requirement;
    return NextResponse.json(
      {
        x402Version: 1,
        error: "payment required",
        accepts: [
          {
            scheme: "casper-x402",
            network: r.network,
            asset: "CSPR",
            maxAmountRequired: r.amountMotes,
            payTo: r.payTo,
            nonce: r.nonce,
            resource: `/api/agent/v1/bet#${marketId}:${outcomeKey}`,
          },
        ],
        previewPayoutMotes: res.previewPayoutMotes,
      },
      { status: 402 },
    );
  }

  // Placed.
  const paymentResponse = Buffer.from(
    JSON.stringify({ success: true, deployHash: res.deployHash }),
  ).toString("base64");
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
    { status: 200, headers: { "X-PAYMENT-RESPONSE": paymentResponse } },
  );
}
