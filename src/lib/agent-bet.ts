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
 *
 * ⚠️ REAL-MODE SAFETY: in `CASPER_CHAIN_MODE=real` the chain adapter submits a real, operator-funded
 * on-chain bet, so the agent rail is OFF by default in real mode and opens through exactly two paths:
 *
 *   1. `CASPER_X402_PAYTO` set → the composition root wires the REAL PaymentPort
 *      (`adapters/casper/real-payment.ts`): a proof must map to a successful on-chain CSPR
 *      transfer from the payer to the operator treasury — trustless verification;
 *   2. `CASPER_REAL_AGENT_X402=true` → the legacy explicit opt-in that keeps the MOCK PaymentPort,
 *      whose `verify` is a nonce-match only — the operator acknowledges verification isn't trustless.
 *
 * Neither configured → fail closed (503). This keeps any mock-vs-real mismatch explicit and
 * safe-by-default rather than a silent operator-funded gap. (Persisting `consumedPayments` across
 * cold starts remains follow-up work for a long-lived real deployment.)
 */

import type { Container } from "@/lib/container";
import type { X402PaymentProof, X402PaymentRequirement } from "@/ports/payment";
import { previewPayoutMotes } from "@/core/market-payout";
import { exceedsBetCap, isCasperNetwork, maxBetCspr } from "@/config/network";
import { chainMode } from "@/config/chain-mode";
import { motesToCspr } from "@/core/types";

/**
 * Payments spent on a placed bet — one payment settles exactly one bet. Keyed by the proof's
 * settlement id (`deployHash`), NOT the challenge nonce: an x402 challenge for a resource is
 * stable and may be paid many times, but each *payment* is one-time. Re-presenting the same proof
 * is the replay we reject; a fresh payment for the same bet (new deployHash) is legitimate. The
 * nonce is still bound to the payer + params (see mock-payment) so a proof can't be redirected to
 * another bettor. In-process for the mock/demo; the real adapter enforces one-time use via the
 * on-chain transfer being unspent + a persisted set.
 */
const consumedPayments = new Set<string>();

/** Test-only: clear the spent-payment registry. */
export function __resetConsumedNonces(): void {
  consumedPayments.clear();
}

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

  // Real-mode safety (see file header): a real, operator-funded on-chain bet is reachable via the
  // agent x402 rail only when payment verification is trustless (CASPER_X402_PAYTO wires the real
  // transfer-verifying PaymentPort) or an operator explicitly opted in to mock nonce-match
  // verification (CASPER_REAL_AGENT_X402=true). Otherwise: fail closed.
  const realPaymentConfigured = Boolean(process.env.CASPER_X402_PAYTO);
  if (chainMode() === "real" && process.env.CASPER_REAL_AGENT_X402 !== "true" && !realPaymentConfigured) {
    return {
      status: "error",
      error:
        "real-mode x402 payment verification is not enabled — set CASPER_X402_PAYTO to verify proofs against on-chain CSPR transfers (trustless), or CASPER_REAL_AGENT_X402=true to opt in to mock nonce-match verification",
      code: 503,
    };
  }

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

  // Mainnet guardrail — the same real-money cap the human bet route enforces. Agents must not be
  // able to route around it via the x402 rail.
  if (exceedsBetCap(container.network, motesToCspr(amountMotes))) {
    return {
      status: "error",
      error: `bet exceeds the ${container.network} cap of ${maxBetCspr(container.network)} CSPR`,
      code: 400,
    };
  }

  // A `network:slug` marketId must be on this container's network — reject a cross-network id
  // rather than silently mis-resolving it (keeps REST + MCP identical).
  const colon = marketId.indexOf(":");
  if (colon > 0) {
    const prefix = marketId.slice(0, colon);
    if (isCasperNetwork(prefix) && prefix !== container.network) {
      return { status: "error", error: `market ${marketId} is not on ${container.network}`, code: 400 };
    }
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

  const requirement = await container.payment.quote({ marketId: market.id, outcomeKey, amountMotes, payer: bettor });

  // Step 1: no proof → hand back the 402 challenge + what this bet would pay if it wins.
  if (!paymentProof) {
    return {
      status: "payment_required",
      requirement,
      previewPayoutMotes: previewPayoutMotes(market.poolByOutcomeMotes, outcomeKey, amountMotes, market.feeBps),
    };
  }

  // Step 2: verify the proof settles this payer's requirement, and that it hasn't already been
  // spent, then escrow + index the bet.
  const ok = await container.payment.verify(requirement, paymentProof);
  if (!ok) return { status: "error", error: "invalid or unverifiable x402 payment proof", code: 402 };
  if (!paymentProof.deployHash) {
    return { status: "error", error: "x402 proof must reference a settlement (deployHash)", code: 402 };
  }
  if (consumedPayments.has(paymentProof.deployHash)) {
    return { status: "error", error: "x402 payment already spent", code: 402 };
  }

  let res;
  try {
    res = await container.chain.placeBet({ marketId: market.id, outcomeKey, amountMotes, bettor });
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "chain submission failed", code: 502 };
  }
  // Money moved on-chain — burn this payment so the same proof can't mint a second bet.
  consumedPayments.add(paymentProof.deployHash);
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
