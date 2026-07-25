/**
 * The ticket that makes self-custodial betting safe to index.
 *
 * A wallet-signed bet is two calls: prepare, then confirm. If `confirm` believed its caller's
 * numbers, it would be a free-money endpoint for the read model — post any executed transaction
 * hash with a 10,000 CSPR stake attached and the boards would show a bet nobody made. So the terms
 * come from a MAC the server minted over what it actually built, and the tests below are about the
 * ways a forger would try to get around that.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BET_TICKET_TTL_MS,
  betTicketSecret,
  signBetTicket,
  verifyBetTicket,
  type BetTicketClaims,
} from "@/lib/bet-ticket";

const SECRET = "s3cret";
const NOW = 1_800_000_000_000;

const claims: BetTicketClaims = {
  network: "testnet",
  marketId: "testnet:will-it-rain",
  outcomeKey: "yes",
  amountMotes: "1000000000",
  bettor: "01aa",
  transactionHash: "deadbeef",
  issuedAtMs: NOW,
};

afterEach(() => vi.unstubAllEnvs());

describe("bet tickets", () => {
  it("round-trips the claims it was minted with", () => {
    expect(verifyBetTicket(signBetTicket(claims, SECRET), SECRET, NOW)).toEqual(claims);
  });

  it("rejects a ticket whose claims were edited — the whole point", () => {
    const ticket = signBetTicket(claims, SECRET);
    const [payload, mac] = ticket.split(".");
    const tampered = Buffer.from(
      JSON.stringify({ ...claims, amountMotes: "10000000000000" }),
      "utf8",
    ).toString("base64url");
    expect(verifyBetTicket(`${tampered}.${mac}`, SECRET, NOW)).toBeNull();
    // …and re-MACing it needs the secret, which is the part a client does not have.
    expect(verifyBetTicket(`${payload}.${mac.slice(0, -1)}x`, SECRET, NOW)).toBeNull();
  });

  it("rejects a ticket minted with a different secret", () => {
    expect(verifyBetTicket(signBetTicket(claims, "other"), SECRET, NOW)).toBeNull();
  });

  it("expires, so a leaked ticket is not a standing liability", () => {
    const ticket = signBetTicket(claims, SECRET);
    expect(verifyBetTicket(ticket, SECRET, NOW + BET_TICKET_TTL_MS - 1)).toEqual(claims);
    expect(verifyBetTicket(ticket, SECRET, NOW + BET_TICKET_TTL_MS + 1)).toBeNull();
  });

  it("answers null for junk rather than throwing", () => {
    for (const junk of [null, undefined, 42, "", ".", "no-dot", "a.b", {}]) {
      expect(verifyBetTicket(junk, SECRET, NOW)).toBeNull();
    }
  });

  it("takes the first secret that is set, so real mode needs no new env var", () => {
    expect(betTicketSecret({ BET_TICKET_SECRET: "a", CRON_SECRET: "b" })).toBe("a");
    expect(betTicketSecret({ CRON_SECRET: "b", CASPER_BETTOR_KEY: "c" })).toBe("b");
    expect(betTicketSecret({ CASPER_BETTOR_KEY: "c" })).toBe("c");
    // Nothing to sign with: the prepare route refuses rather than minting a forgeable ticket.
    expect(betTicketSecret({})).toBeNull();
    expect(betTicketSecret({ BET_TICKET_SECRET: "" })).toBeNull();
  });
});
