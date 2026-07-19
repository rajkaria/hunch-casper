/**
 * WalletPort — an agent's own on-chain identity and purse.
 *
 * The gap this closes: until now the Prophet fleet fabricated its x402 payment proofs locally
 * (`deployHash: "x402-settled-…"`), which the transfer-verifying `PaymentPort` correctly
 * rejects. An agent that cannot pay from a wallet it controls is not really an agent — it is the
 * operator wearing four hats. This port gives each agent an account it signs with, so its
 * payments are genuine CSPR transfers a third party can verify on-chain, and its track record
 * (S19) accrues to an identity that had to spend real money to build it.
 *
 * Implementations: `adapters/mock/mock-wallet.ts` (deterministic pseudo-accounts and an in-memory
 * purse — credential-free, so CI and the demo never need funding) and
 * `adapters/casper/real-wallet.ts` (per-agent Ed25519 keys, real native transfers, real balances).
 * Same interface, same contract tests.
 */

// Relative (not `@/`) so the emitted `.d.ts` resolves inside the published SDK package.
import type { CasperNetwork } from "../config/network";

export interface AgentAccount {
  /** Stable agent id — the ledger/display key (e.g. `"momentum"`). */
  agentId: string;
  /**
   * The agent's Casper public key hex — its on-chain identity, and the `payer` an x402
   * requirement binds to in real mode (the transfer's initiator must equal it).
   */
  publicKeyHex: string;
  /**
   * The same identity as `account-hash-…`. Carried alongside the public key because the two are
   * not interconvertible without blake2b, and the funding tools speak account-hash while the
   * payment verifier speaks public key. An operator refilling a fleet should not have to derive
   * one from the other by hand.
   */
  accountHash: string;
}

export interface TransferInput {
  /** Which agent's purse pays. */
  agentId: string;
  /** Recipient: Casper public key hex or `account-hash-…`. */
  toAccount: string;
  amountMotes: string;
}

export interface TransferResult {
  /** The transaction hash — this is what becomes the x402 proof's `deployHash`. */
  deployHash: string;
  explorerUrl: string;
}

export interface WalletPort {
  network: CasperNetwork;
  /**
   * The agent's on-chain identity. MUST be deterministic: the same agent id always resolves to
   * the same account, on every instance and across restarts. Fleet wallets are funded by hand,
   * so an identity that drifted between deploys would strand the funds.
   */
  accountFor(agentId: string): Promise<AgentAccount>;
  /** Spendable balance in motes. Returns `"0"` for an account that does not exist yet. */
  balanceOf(agentId: string): Promise<string>;
  /** Sign and submit a native CSPR transfer from the agent's own purse. */
  transfer(input: TransferInput): Promise<TransferResult>;
}
