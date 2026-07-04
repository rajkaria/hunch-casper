/**
 * Agent bet-with-payment orchestration — the shared core of the x402 rail. Both the REST
 * `/api/agent/v1/bet` endpoint (HTTP-402 handshake) and the MCP `place_bet` tool call this, so
 * the two surfaces can never drift: a bet is a two-step x402 exchange —
 *
 *   1. no payment proof yet → return the payment requirement (the 402 challenge) + a payout
 *      preview, so the agent knows exactly what to pay and what it stands to win;
 *   2. valid proof presented → verify it against the requirement, then escrow the bet through
 *      the chain adapter and index it in the store (the same money path humans use).
 *
 * x402 is the settlement rail for the whole agent economy: every agent bet is an HTTP payment
 * carrying a Casper proof. The mock PaymentPort settles deterministically for CI/demo; the real
 * adapter swaps in native Casper x402 (or an HTTP-402 + CSPR-transfer proof) behind the same port.
 */

import type { Container } from "@/lib/container";
import type { X402PaymentProof, X402PaymentRequirement } from "@/ports/payment";
import { previewPayoutMotes } from "@/core/market-payout";

export interface AgentBetInput {
  marketId: string;
  outcomeKey: string;
  amountMotes: string;
  bettor: string;
  /** The x402 payment proof; omit on the first call to receive the 402 requirement. */
  paymentProof?: X402PaymentProof;
}

export type AgentBetResult =
  | { status: "payment_required"; requirement: X402PaymentRequirement; previewPayoutMotes: string }
  | {
      status: "placed";
      deployHash: string;
      explorerUrl: string;
      proof: X402PaymentProof;
      indexed: boolean;
      totalStakedMotes?: string;
      poolByOutcomeMotes?: Record<string, string>;
    }
  | { status: "error"; error: string; code: number };

const MOTES = /^\d+$/;

/** Run the x402 bet exchange for an agent against a container's ports. */
export async function agentBet(container: Container, input: AgentBetInput): Promise<AgentBetResult> {
  const { marketId, outcomeKey, amountMotes, bettor, paymentProof } = input;

  if (typeof marketId !== "string" || marketId.length === 0) {
    return { status: "error", error: "marketId is required", code: 400 };
  }
  if (typeof outcomeKey !== "string" || outcomeKey.length === 0) {
    return { status: "error", error: "outcomeKey is required", code: 400 };
  }
  if (typeof amountMotes !== "string" || !MOTES.test(amountMotes) || BigInt(amountMotes) <= 0n) {
    return { status: "error", error: "amountMotes must be a positive integer motes string", code: 400 };
  }
  if (typeof bettor !== "string" || bettor.length === 0) {
    return { status: "error", error: "bettor is required", code: 400 };
  }

  // Validate against the read model (real market + outcome + still open).
  const slug = marketId.startsWith(`${container.network}:`)
    ? marketId.slice(container.network.length + 1)
    : marketId;
  const market = await container.store.get(slug, container.network);
  if (!market) return { status: "error", error: `unknown market '${marketId}'`, code: 400 };
  if (!market.outcomes.some((o) => o.key === outcomeKey)) {
    return { status: "error", error: `'${outcomeKey}' is not an outcome of ${marketId}`, code: 400 };
  }
  if (market.status !== "open") {
    return { status: "error", error: `market ${marketId} is ${market.status}`, code: 409 };
  }

  const requirement = await container.payment.quote({ marketId: market.id, outcomeKey, amountMotes });

  // Step 1: no proof → hand back the 402 challenge + what this bet would pay if it wins.
  if (!paymentProof) {
    return {
      status: "payment_required",
      requirement,
      previewPayoutMotes: previewPayoutMotes(market.poolByOutcomeMotes, outcomeKey, amountMotes, market.feeBps),
    };
  }

  // Step 2: verify the proof settles the requirement, then escrow + index the bet.
  const ok = await container.payment.verify(requirement, paymentProof);
  if (!ok) return { status: "error", error: "invalid or unverifiable x402 payment proof", code: 402 };

  let res;
  try {
    res = await container.chain.placeBet({ marketId: market.id, outcomeKey, amountMotes, bettor });
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "chain submission failed", code: 502 };
  }
  try {
    const updated = await container.store.recordBet({ marketId: market.id, bettor, outcomeKey, amountMotes });
    return {
      status: "placed",
      deployHash: res.deployHash,
      explorerUrl: res.explorerUrl,
      proof: paymentProof,
      indexed: true,
      totalStakedMotes: updated.totalStakedMotes,
      poolByOutcomeMotes: updated.poolByOutcomeMotes,
    };
  } catch {
    // Chain accepted the escrow; indexing failed (e.g. concurrent resolve). Surface distinctly.
    return { status: "placed", deployHash: res.deployHash, explorerUrl: res.explorerUrl, proof: paymentProof, indexed: false };
  }
}
