/**
 * The checks every bet must pass, wherever it is signed.
 *
 * `POST /api/chain/bet` (operator-signed) and `POST /api/chain/bet/prepare` (wallet-signed) accept
 * the same body and must accept exactly the same bets — a cap or a closed-market check that
 * applies to one path and not the other is not a guardrail, it is a bypass. So the validation
 * lives here once and both routes call it.
 */

import { createContainer } from "@/lib/container";
import { exceedsBetCap, isCasperNetwork, maxBetCspr, type CasperNetwork } from "@/config/network";
import { motesToCspr } from "@/core/types";
import type { Market } from "@/core/types";

const MOTES = /^\d+$/;

export interface ValidBetRequest {
  network: CasperNetwork;
  /** The market's canonical id, resolved from the catalogue — not the caller's spelling of it. */
  market: Market;
  outcomeKey: string;
  amountMotes: string;
  bettor: string;
}

export interface BetRequestRejection {
  error: string;
  status: number;
}

export type BetRequestResult =
  | { ok: true; request: ValidBetRequest }
  | { ok: false; rejection: BetRequestRejection };

export async function validateBetRequest(body: Record<string, unknown>): Promise<BetRequestResult> {
  const reject = (error: string, status = 400): BetRequestResult => ({
    ok: false,
    rejection: { error, status },
  });

  const { network, marketId, outcomeKey, amountMotes, bettor } = body ?? {};

  if (!isCasperNetwork(network)) return reject("network must be 'testnet' or 'mainnet'");
  if (typeof marketId !== "string" || marketId.length === 0) return reject("marketId is required");
  if (typeof outcomeKey !== "string" || outcomeKey.length === 0) return reject("outcomeKey is required");
  if (typeof amountMotes !== "string" || !MOTES.test(amountMotes) || BigInt(amountMotes) <= 0n) {
    return reject("amountMotes must be a positive integer motes string");
  }
  if (typeof bettor !== "string" || bettor.length === 0) return reject("bettor is required");

  // Mainnet guardrail: fresh unaudited contracts hold real value, so bets are capped.
  if (exceedsBetCap(network, motesToCspr(amountMotes))) {
    return reject(`bet exceeds the ${network} cap of ${maxBetCspr(network)} CSPR`);
  }

  // Validate against the catalogue read model before touching the chain: the bet must be on a
  // real market and a real outcome of it.
  const container = createContainer(network);
  const slug = marketId.startsWith(`${network}:`) ? marketId.slice(network.length + 1) : marketId;
  const market = await container.store.get(slug, network);
  if (!market) return reject(`unknown market '${marketId}'`);
  if (!market.outcomes.some((o) => o.key === outcomeKey)) {
    return reject(`'${outcomeKey}' is not an outcome of ${marketId}`);
  }
  if (market.status !== "open") return reject(`market ${marketId} is ${market.status}`, 409);

  return { ok: true, request: { network, market, outcomeKey, amountMotes, bettor } };
}
