/**
 * The binding between a market creation the server prepared and the `create_market` transaction
 * the visitor's wallet will sign — `bet-ticket.ts`'s discipline, applied to creation.
 *
 * ## The hole this closes
 *
 * Self-custodial creation is two round trips: `prepare` composes the market and builds an unsigned
 * payable `create_market` with the VISITOR as initiator; their wallet signs and submits it; then
 * someone has to tell the server "that landed, register it". A naive finalize call —
 * `{spec…, txHash}` — would let a caller register any market definition against any executed
 * transaction: the chain would hold one market and the boards would show another. Confirming the
 * hash executed does not help; *some* transaction executed.
 *
 * So the ENTIRE creation spec rides inside the ticket, HMAC'd with the server secret at prepare
 * time. `finalize`'s only client input is the ticket itself: it recomposes the market from the
 * claims, checks the recompose still lands on the recipe hash the ticket names, confirms the
 * transaction on chain, and only then registers. A tampered field invalidates the MAC; a hash the
 * server never prepared has no ticket at all.
 *
 * The transaction hash can be in the ticket because it is known before signing: it covers the
 * payload, and approvals are appended to it (see `UnsignedTransaction`).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ComposeMarketInput } from "@/core/market-composer";

/**
 * Everything `finalize` needs to rebuild and register the market, plus the two commitments that
 * pin it: the recipe hash the compose must land on again, and the transaction hash the chain must
 * have executed. `spec` is the exact `ComposeMarketInput` prepare composed from — including `seq`,
 * so the slug re-derives identically even if other markets were created in between.
 */
export interface CreationTicketClaims {
  network: string;
  /** The composed slug — also the on-chain `market_id` baked into the prepared transaction. */
  slug: string;
  spec: ComposeMarketInput;
  /** The oracle bound on chain (already shape-validated at prepare). */
  oracle: string;
  recipeHash: string;
  bondMotes: string;
  transactionHash: string;
  /** Whether the fleet seeds the market after registration (the page's default: yes). */
  seedByFleet: boolean;
  /** Epoch ms the ticket was minted. Same TTL policy as bet tickets. */
  issuedAtMs: number;
}

/** Same generous-but-bounded window as a bet ticket: one wallet interaction, not a standing pass. */
export const CREATION_TICKET_TTL_MS = 60 * 60 * 1000;

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mac(payload: string, secret: string): string {
  // Domain-separated from the bet ticket (and everything else the secret signs): a MAC valid in
  // two different contexts is a MAC that means nothing in either.
  return base64url(createHmac("sha256", `hunch-creation-ticket|${secret}`).update(payload).digest());
}

export function signCreationTicket(claims: CreationTicketClaims, secret: string): string {
  const payload = base64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${payload}.${mac(payload, secret)}`;
}

/**
 * The claims inside a ticket this server signed, or `null` for anything else — a forged MAC, a
 * mangled payload, or a ticket past its TTL. Never throws; every rejection is the same answer.
 */
export function verifyCreationTicket(
  ticket: unknown,
  secret: string,
  nowMs: number = Date.now(),
): CreationTicketClaims | null {
  if (typeof ticket !== "string") return null;
  const dot = ticket.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = ticket.slice(0, dot);
  const provided = Buffer.from(ticket.slice(dot + 1), "utf8");
  const expected = Buffer.from(mac(payload, secret), "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CreationTicketClaims;
    if (
      typeof claims?.transactionHash !== "string" ||
      typeof claims?.recipeHash !== "string" ||
      typeof claims?.slug !== "string" ||
      typeof claims?.issuedAtMs !== "number" ||
      typeof claims?.spec !== "object" ||
      claims.spec === null
    ) {
      return null;
    }
    if (nowMs - claims.issuedAtMs > CREATION_TICKET_TTL_MS) return null;
    return claims;
  } catch {
    return null;
  }
}
