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
 * safe-by-default rather than a silent operator-funded gap. Spent payments are recorded in the
 * ledger's persisted dedupe set (see `paymentDedupeKey`), so a proof stays burnt across cold
 * starts and instances.
 */

import type { Container } from "@/lib/container";
import type { X402PaymentProof, X402PaymentRequirement } from "@/ports/payment";
import { previewPayoutMotes } from "@/core/market-payout";
import { exceedsBetCap, isCasperNetwork, maxBetCspr } from "@/config/network";
import { chainMode } from "@/config/chain-mode";
import { motesToCspr } from "@/core/types";
import { ledgerHasRecordedBet } from "@/adapters/mock/settlement-ledger";

/**
 * Payments spent on a placed bet — one payment settles exactly one bet. Keyed by the proof's
 * settlement id (`deployHash`), NOT the challenge nonce: an x402 challenge for a resource is
 * stable and may be paid many times, but each *payment* is one-time. Re-presenting the same proof
 * is the replay we reject; a fresh payment for the same bet (new deployHash) is legitimate. The
 * nonce is still bound to the payer + params (see mock-payment) so a proof can't be redirected to
 * another bettor.
 *
 * This Set is the in-process fast path only. The durable, cross-instance record is the ledger's
 * persisted `recordedBets` dedupe set (keyed `x402:<deployHash>` via `recordBet`'s `dedupeKey`),
 * which rides the KV envelope and is unioned across instances — without it, replaying one paid
 * proof against N cold lambdas escrowed N operator-funded bets.
 */
const consumedPayments = new Set<string>();

/** The ledger dedupe key one x402 payment burns. Namespaced so it can never collide with the
 * bet-transaction keys (`network:txHash`) the wallet confirm path records. */
function paymentDedupeKey(deployHash: string): string {
  return `x402:${deployHash}`;
}

/** Test-only: clear the spent-payment registry. */
export function __resetConsumedNonces(): void {
  consumedPayments.clear();
}

export interface AgentBetInput {
  marketId: string;
  outcomeKey: string;
  amountMotes: string;
  bettor: string;
  /**
   * The on-chain account that pays, when it differs from the ledger identity. Defaults to
   * `bettor`.
   *
   * The two are the same thing for an external agent, which sends its public key as `bettor`.
   * They differ for the internal fleet: a Prophet's ledger key is its NAME (`"momentum"` — what
   * the boards, the feed, and the meta-markets are keyed by), while the account whose signature
   * the transfer-verifying PaymentPort checks is its derived Casper key. Binding the requirement
   * to the name would make every real-mode fleet proof unverifiable; renaming the ledger key to
   * a public key would make every board unreadable. So the payment binds to the account and the
   * ledger binds to the name.
   */
  payerAccount?: string;
  /** The x402 payment proof; omit on the first call to receive the 402 requirement. */
  paymentProof?: X402PaymentProof;
}

/** A validated bet request: the market it lands on, or the error the caller should return. */
type BetTarget =
  | { ok: true; market: Awaited<ReturnType<Container["store"]["get"]>> & object }
  | { ok: false; error: string; code: number };

/**
 * Everything a bet must satisfy before any money moves — shared verbatim by the x402 rail
 * (`agentBet`) and the self-custodial fleet path (`fleetBet`), because a bet that one would reject
 * and the other would accept is a hole. Deliberately excludes the x402 real-mode gate, which is
 * about who FUNDS the escrow and therefore does not apply when the bettor funds it themselves.
 */
async function resolveBetTarget(container: Container, input: AgentBetInput): Promise<BetTarget> {
  const { marketId, outcomeKey, amountMotes, bettor } = input;

  if (typeof marketId !== "string" || marketId.length === 0) {
    return { ok: false, error: "marketId is required", code: 400 };
  }
  if (typeof outcomeKey !== "string" || outcomeKey.length === 0) {
    return { ok: false, error: "outcomeKey is required", code: 400 };
  }
  if (typeof amountMotes !== "string" || !MOTES.test(amountMotes) || BigInt(amountMotes) <= 0n) {
    return { ok: false, error: "amountMotes must be a positive integer motes string", code: 400 };
  }
  if (typeof bettor !== "string" || bettor.length === 0) {
    return { ok: false, error: "bettor is required", code: 400 };
  }

  // Mainnet guardrail — the same real-money cap the human bet route enforces. Agents must not be
  // able to route around it via the x402 rail, nor by self-signing.
  if (exceedsBetCap(container.network, motesToCspr(amountMotes))) {
    return {
      ok: false,
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
      return { ok: false, error: `market ${marketId} is not on ${container.network}`, code: 400 };
    }
  }

  // Validate against the read model (real market + outcome + still open).
  const slug = marketId.startsWith(`${container.network}:`)
    ? marketId.slice(container.network.length + 1)
    : marketId;
  const market = await container.store.get(slug, container.network);
  if (!market) return { ok: false, error: `unknown market '${marketId}'`, code: 400 };
  if (!market.outcomes.some((o) => o.key === outcomeKey)) {
    return { ok: false, error: `'${outcomeKey}' is not an outcome of ${marketId}`, code: 400 };
  }
  if (market.status !== "open") {
    return { ok: false, error: `market ${marketId} is ${market.status}`, code: 409 };
  }
  return { ok: true, market };
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
  const { outcomeKey, amountMotes, bettor, payerAccount, paymentProof } = input;

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

  const target = await resolveBetTarget(container, input);
  if (!target.ok) return { status: "error", error: target.error, code: target.code };
  const { market } = target;

  const requirement = await container.payment.quote({
    marketId: market.id,
    outcomeKey,
    amountMotes,
    payer: payerAccount && payerAccount.length > 0 ? payerAccount : bettor,
  });

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
  if (consumedPayments.has(paymentProof.deployHash) || ledgerHasRecordedBet(paymentDedupeKey(paymentProof.deployHash))) {
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
    const updated = await container.store.recordBet({
      marketId: market.id,
      bettor,
      outcomeKey,
      amountMotes,
      dedupeKey: paymentDedupeKey(paymentProof.deployHash),
    });
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

/** The ledger dedupe key a self-custodial escrow burns — its own transaction, namespaced apart
 * from x402 settlements so the two can never collide. */
function escrowDedupeKey(deployHash: string): string {
  return `escrow:${deployHash}`;
}

/**
 * Place a bet for a fleet agent that signs its OWN escrow (S30/W1) — no x402 reimbursement leg.
 *
 * ## Why this is a separate function, and why it takes no payment proof
 *
 * The x402 leg was never a stake transfer; it was a **reimbursement**. The operator fronted the
 * escrow out of its own purse, so the agent wired the same amount back to the treasury and the
 * proof of that wire is what authorised the escrow. Once the agent signs the escrow itself, the
 * money already left its purse into the vault — charging it a second, equal transfer to the
 * treasury would take the stake twice for one bet.
 *
 * So the escrow IS the settlement here. It is strictly stronger evidence than the transfer it
 * replaces: a `BetPlaced` event naming the agent as `caller`, for this market and this outcome,
 * rather than a bare transfer that merely happened to precede a bet.
 *
 * ## Why an external caller can never reach it
 *
 * This function is reachable only from the internal fleet loop — no route imports it — and it
 * additionally refuses any bettor `chain.canSelfSign` does not claim. That predicate answers from
 * the deployment's own key material, so "I am `agent:momentum`" is not something an HTTP caller
 * can assert its way into: the public rail (`agentBet`) still demands a paid, verified proof.
 */
export async function fleetBet(
  container: Container,
  input: Omit<AgentBetInput, "paymentProof">,
): Promise<AgentBetResult> {
  const { outcomeKey, amountMotes, bettor } = input;

  // The capability gate. Not an assertion the caller makes — a fact about the keys this
  // deployment holds. Anything else belongs on the x402 rail, where a payment is proof.
  if (container.chain.canSelfSign?.(bettor) !== true) {
    return {
      status: "error",
      error: `this deployment cannot sign as '${bettor}' — self-custodial placement is only for fleet agents whose key it holds`,
      code: 403,
    };
  }

  const target = await resolveBetTarget(container, input);
  if (!target.ok) return { status: "error", error: target.error, code: target.code };
  const { market } = target;

  let res;
  try {
    res = await container.chain.placeBet({ marketId: market.id, outcomeKey, amountMotes, bettor });
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "chain submission failed", code: 502 };
  }

  // The escrow's own hash is the settlement id: one transaction, one bet, and a replayed hash
  // is caught by the same durable dedupe set that guards the x402 rail.
  const proof: X402PaymentProof = { scheme: "casper-x402", deployHash: res.deployHash, nonce: res.deployHash };
  try {
    const updated = await container.store.recordBet({
      marketId: market.id,
      bettor,
      outcomeKey,
      amountMotes,
      dedupeKey: escrowDedupeKey(res.deployHash),
    });
    return {
      status: "placed",
      deployHash: res.deployHash,
      explorerUrl: res.explorerUrl,
      proof,
      indexed: true,
      totalStakedMotes: updated.totalStakedMotes,
      poolByOutcomeMotes: updated.poolByOutcomeMotes,
    };
  } catch {
    return { status: "placed", deployHash: res.deployHash, explorerUrl: res.explorerUrl, proof, indexed: false };
  }
}
