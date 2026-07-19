/**
 * The shared query-metering runtime — one meter behind every metered read product (the oracle
 * query API S26, the odds feed S27, and the S19 reputation queries as they move under it). Keeping
 * a single meter + a single spent-settlement set here means "free tier, then x402" behaves
 * identically across surfaces and a caller's free quota is one pool, not one-per-endpoint.
 *
 * In-process for the demo; the same shape (a caller→window map + a spent-hash set) is what a KV
 * backing would implement for a multi-instance deployment. Pure metering logic lives in
 * `core/query-pricing.ts`; this is just the process-wide state + the x402 helper the routes share.
 */

import { meterQuery, queryTierFromEnv, type MeterDecision, type MeterWindow } from "@/core/query-pricing";
import type { Container } from "@/lib/container";
import type { X402PaymentProof } from "@/ports/payment";

const METER = new Map<string, MeterWindow>();
const CONSUMED = new Set<string>();

/** Test-only: reset the shared meter + spent-settlement set. */
export function __resetSharedQueryMeter(): void {
  METER.clear();
  CONSUMED.clear();
}

/** Meter one call for `caller` against the shared free tier. */
export function meterCall(caller: string, nowMs: number): MeterDecision {
  return meterQuery(caller, nowMs, METER, queryTierFromEnv());
}

export type PaidGate =
  | { ok: true }
  | { ok: false; status: 402; challenge: unknown }
  | { ok: false; status: 402; error: string };

/**
 * Enforce the paid gate for a metered call that has exhausted its free tier: with no proof, produce
 * the x402 challenge; with a proof, verify + spend it (replay-protected). `resource` names the
 * endpoint in the challenge; `refId` binds the requirement (any stable id for this call).
 */
export async function enforcePayment(
  container: Container,
  decision: MeterDecision,
  caller: string,
  refId: string,
  resource: string,
  proof: X402PaymentProof | undefined,
): Promise<PaidGate> {
  const requirement = await container.payment.quote({
    marketId: refId,
    outcomeKey: "__meter__",
    amountMotes: decision.priceMotes,
    payer: caller,
  });
  if (!proof) {
    return {
      ok: false,
      status: 402,
      challenge: {
        x402Version: 1,
        error: "payment required — free tier exhausted",
        accepts: [
          {
            scheme: "casper-x402",
            network: requirement.network,
            asset: "CSPR",
            maxAmountRequired: decision.priceMotes,
            payTo: requirement.payTo,
            nonce: requirement.nonce,
            resource,
          },
        ],
      },
    };
  }
  const valid = await container.payment.verify(requirement, proof);
  if (!valid || !proof.deployHash) return { ok: false, status: 402, error: "invalid or unverifiable x402 payment proof" };
  if (CONSUMED.has(proof.deployHash)) return { ok: false, status: 402, error: "x402 payment already spent" };
  CONSUMED.add(proof.deployHash);
  return { ok: true };
}

/** Read + decode the `X-PAYMENT` proof header, if present. */
export function readPaymentProof(req: Request): X402PaymentProof | undefined {
  const header = req.headers.get("x-payment");
  if (!header) return undefined;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as X402PaymentProof;
  } catch {
    return undefined;
  }
}
