/**
 * Deterministic mock `WalletPort` — every agent gets a stable pseudo-account and an in-memory
 * purse, so CI, local dev, and the credential-free demo exercise the exact same code path the
 * real fleet uses without a funded key anywhere.
 *
 * The purse is real enough to be useful: transfers debit it, and it runs out. That is deliberate
 * — the low-balance behaviour (an agent that skips its turn instead of submitting a transaction
 * it cannot pay for) is the part most likely to be wrong in production and least likely to be
 * exercised by hand, so the mock has to be able to reach it.
 */

import type { CasperNetwork } from "@/config/network";
import { explorerTransactionUrl } from "@/config/network";
import type { AgentAccount, TransferInput, TransferResult, WalletPort } from "@/ports/wallet";
import { pseudoDeployHash } from "./mock-chain";

/**
 * Opening balance per agent, in motes (500 CSPR). Comfortably above the fleet's per-round stakes
 * so a default demo never starves, and finite so a long unattended run still exercises the
 * low-balance path rather than pretending money is infinite.
 */
export const MOCK_OPENING_BALANCE_MOTES = 500_000_000_000n;

const balances = new Map<string, bigint>();
/** Monotone per-agent counter so two identical transfers still produce distinct settlement ids. */
const transferSeq = new Map<string, number>();

/** Test-only: forget every agent's purse so a suite starts from the opening balance. */
export function __resetMockWallet(): void {
  balances.clear();
  transferSeq.clear();
}

/** Test-only: set an agent's balance directly to reach the low-balance path deliberately. */
export function __setMockBalance(agentId: string, motes: bigint): void {
  balances.set(agentId, motes);
}

function balanceOf(agentId: string): bigint {
  const current = balances.get(agentId);
  if (current !== undefined) return current;
  balances.set(agentId, MOCK_OPENING_BALANCE_MOTES);
  return MOCK_OPENING_BALANCE_MOTES;
}

/**
 * A stable Ed25519-shaped public key hex for an agent: the `01` algorithm tag plus 32 bytes
 * derived from the agent id. Shaped like the real thing so anything that parses a public key
 * (or merely eyeballs one) behaves identically against the mock.
 */
export function mockAccountHex(agentId: string): string {
  return `01${pseudoDeployHash(`fleet-account:${agentId}`)}`;
}

/** The matching pseudo account-hash. Distinct from the public key, as on chain. */
export function mockAccountHash(agentId: string): string {
  return `account-hash-${pseudoDeployHash(`fleet-account-hash:${agentId}`)}`;
}

export function createMockWallet(network: CasperNetwork): WalletPort {
  return {
    network,

    async accountFor(agentId: string): Promise<AgentAccount> {
      return { agentId, publicKeyHex: mockAccountHex(agentId), accountHash: mockAccountHash(agentId) };
    },

    async balanceOf(agentId: string): Promise<string> {
      return balanceOf(agentId).toString();
    },

    async transfer(input: TransferInput): Promise<TransferResult> {
      const amount = BigInt(input.amountMotes);
      const available = balanceOf(input.agentId);
      if (amount <= 0n) throw new Error("transfer amount must be positive");
      if (available < amount) {
        throw new Error(
          `insufficient balance for ${input.agentId}: has ${available} motes, needs ${amount}`,
        );
      }
      balances.set(input.agentId, available - amount);
      const seq = (transferSeq.get(input.agentId) ?? 0) + 1;
      transferSeq.set(input.agentId, seq);
      const deployHash = pseudoDeployHash(
        `transfer:${network}:${input.agentId}:${input.toAccount}:${input.amountMotes}:${seq}`,
      );
      return { deployHash, explorerUrl: explorerTransactionUrl(network, deployHash) };
    },
  };
}
