/**
 * Deterministic mock x402 PaymentPort. Models the quote → settle → verify handshake without
 * touching the chain. The real adapter swaps in native Casper x402 (or HTTP-402 + a CSPR
 * transfer proof) behind this same interface.
 */

import type { CasperNetwork } from "@/config/network";
import type {
  PaymentPort,
  QuoteInput,
  X402PaymentProof,
  X402PaymentRequirement,
} from "@/ports/payment";
import { pseudoDeployHash } from "./mock-chain";

export function createMockPayment(network: CasperNetwork, vaultAddress: string): PaymentPort {
  return {
    async quote(input: QuoteInput): Promise<X402PaymentRequirement> {
      const nonce = pseudoDeployHash(
        `nonce:${network}:${input.marketId}:${input.outcomeKey}:${input.amountMotes}`,
      ).slice(0, 32);
      return { amountMotes: input.amountMotes, payTo: vaultAddress, network, nonce };
    },
    async settle(requirement: X402PaymentRequirement, payer: string): Promise<X402PaymentProof> {
      const deployHash = pseudoDeployHash(
        `settle:${requirement.network}:${requirement.payTo}:${requirement.amountMotes}:${requirement.nonce}:${payer}`,
      );
      return { scheme: "casper-x402", deployHash, nonce: requirement.nonce };
    },
    async verify(
      requirement: X402PaymentRequirement,
      proof: X402PaymentProof,
    ): Promise<boolean> {
      return proof.scheme === "casper-x402" && proof.nonce === requirement.nonce;
    },
  };
}
