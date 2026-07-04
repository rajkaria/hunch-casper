/**
 * PaymentPort — the x402 rail. Every bet an agent places is an HTTP-402 payment; this port
 * is the abstraction over "native Casper x402 if live, else HTTP-402 handshake with a CSPR
 * transfer as the settlement proof." Core never cares which; it only needs quote → settle →
 * verify.
 */

import type { CasperNetwork } from "@/config/network";

export interface X402PaymentRequirement {
  /** Amount owed, in motes. */
  amountMotes: string;
  /** Vault/recipient the payment must land in. */
  payTo: string;
  network: CasperNetwork;
  /** Replay-protection nonce echoed back in the proof. */
  nonce: string;
}

export interface X402PaymentProof {
  scheme: "casper-x402";
  /** The CSPR transfer deploy hash that settles the requirement. */
  deployHash: string;
  nonce: string;
}

export interface QuoteInput {
  marketId: string;
  outcomeKey: string;
  amountMotes: string;
}

export interface PaymentPort {
  /** Produce the 402 challenge for a bet. */
  quote(input: QuoteInput): Promise<X402PaymentRequirement>;
  /** Satisfy a requirement on behalf of `payer`, returning cryptographic proof. */
  settle(requirement: X402PaymentRequirement, payer: string): Promise<X402PaymentProof>;
  /** Verify a proof matches a requirement (nonce + on-chain transfer). */
  verify(requirement: X402PaymentRequirement, proof: X402PaymentProof): Promise<boolean>;
}
