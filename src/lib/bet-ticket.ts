/**
 * The binding between a bet the server prepared and the transaction hash it will carry on chain.
 *
 * ## The hole this closes
 *
 * A self-custodial bet is two round trips: the server builds an unsigned transaction, the
 * visitor's wallet signs and submits it, and then someone has to tell the server "that landed,
 * index it". The naive second call — `{marketId, outcomeKey, amountMotes, bettor, txHash}` — is a
 * free-money endpoint for the read model: nothing stops a caller posting a hash from an unrelated
 * transaction alongside a 10,000 CSPR stake on the outcome they like, and the boards would show a
 * bet no one ever made. Confirming the hash executed does not help; *some* transaction executed.
 *
 * So the terms are never taken from the client. `prepare` mints a ticket over exactly what it
 * built, HMAC'd with a server secret; `confirm` accepts only a ticket it signed and records the
 * claims inside it. A tampered field invalidates the MAC, and a hash the server never prepared has
 * no ticket at all. The client's only real input is *whether* to submit.
 *
 * The transaction hash can be in the ticket because it is known before signing: it covers the
 * payload, and approvals are appended to it (see `UnsignedBetTransaction`).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface BetTicketClaims {
  network: string;
  marketId: string;
  outcomeKey: string;
  amountMotes: string;
  /** The bettor's public key — the transaction's initiator, so also who may claim winnings. */
  bettor: string;
  transactionHash: string;
  /** Epoch ms the ticket was minted. Tickets are short-lived; see `BET_TICKET_TTL_MS`. */
  issuedAtMs: number;
  /**
   * Who signed the transaction this ticket covers. Both bet routes now mint a ticket and let the
   * client poll `confirm` for the result, so the receipt has to know which it is: `"self"` is the
   * visitor's own wallet and their own money, `"operator"` is the operator's key escrowing on
   * their behalf. Absent on tickets minted before the operator path used them — read as `"self"`,
   * which is what only `prepare` used to issue.
   */
  custody?: "self" | "operator";
}

/**
 * A prepared bet is meant to be signed and submitted within a minute or two. An hour is generous
 * for a slow wallet interaction and short enough that a leaked ticket is not a standing liability.
 */
export const BET_TICKET_TTL_MS = 60 * 60 * 1000;

/**
 * The signing secret, from the first of these that is set.
 *
 * `BET_TICKET_SECRET` is the one to configure. The fallbacks exist so that turning on
 * self-custodial betting needs no new environment variable on a deployment that already runs in
 * real mode — `CASPER_BETTOR_KEY` is server-only and always present there. Returns `null` when
 * there is nothing to sign with, and the caller refuses to prepare rather than minting a ticket
 * anyone could forge.
 */
export function betTicketSecret(
  env: Record<string, string | undefined> = process.env,
): string | null {
  for (const key of ["BET_TICKET_SECRET", "CRON_SECRET", "CASPER_BETTOR_KEY"]) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mac(payload: string, secret: string): string {
  // Domain-separated: the same secret may be a cron token elsewhere, and a MAC valid in two
  // different contexts is a MAC that means nothing in either.
  return base64url(createHmac("sha256", `hunch-bet-ticket|${secret}`).update(payload).digest());
}

export function signBetTicket(claims: BetTicketClaims, secret: string): string {
  const payload = base64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${payload}.${mac(payload, secret)}`;
}

/**
 * The claims inside a ticket this server signed, or `null` for anything else — a forged MAC, a
 * mangled payload, or a ticket past its TTL. Never throws: every rejection is the same answer.
 */
export function verifyBetTicket(
  ticket: unknown,
  secret: string,
  nowMs: number = Date.now(),
): BetTicketClaims | null {
  if (typeof ticket !== "string") return null;
  const dot = ticket.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = ticket.slice(0, dot);
  const provided = Buffer.from(ticket.slice(dot + 1), "utf8");
  const expected = Buffer.from(mac(payload, secret), "utf8");
  // Length check first: timingSafeEqual throws on a length mismatch rather than returning false.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as BetTicketClaims;
    if (typeof claims?.transactionHash !== "string" || typeof claims?.issuedAtMs !== "number") {
      return null;
    }
    if (nowMs - claims.issuedAtMs > BET_TICKET_TTL_MS) return null;
    return claims;
  } catch {
    return null;
  }
}
