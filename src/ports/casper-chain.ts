/**
 * CasperChainPort — the only surface `core/` uses to touch the chain.
 *
 * The mock adapter (deterministic, credential-free) satisfies this in tests and local dev.
 * The real Casper/Odra adapter lands behind the SAME interface in S1–S2, verified by the
 * shared contract tests — zero core refactor.
 */

import type { CasperNetwork } from "@/config/network";

export interface DeployResult {
  deployHash: string;
  explorerUrl: string;
}

export interface PlaceBetInput {
  marketId: string;
  outcomeKey: string;
  amountMotes: string;
  /** Bettor public key or `agent:<name>`. */
  bettor: string;
}

export interface ResolveMarketInput {
  marketId: string;
  winningOutcomeKey: string;
  /** Oracle identity performing the resolution. */
  oracleId: string;
}

/**
 * A market created at RUNTIME as a state entry in the singleton `HunchVault` v2 — the S16 unlock
 * that made autonomous creation affordable (a few CSPR per `create_market` call, versus ~337 for
 * a per-market Wasm install). Genesis uses this; there is no v1 equivalent, because installing a
 * contract per idea was never something an agent could do on a schedule.
 */
export interface CreateMarketInput {
  /** The market's id inside the vault — the catalogue slug. */
  marketId: string;
  question: string;
  category: string;
  /**
   * The account allowed to resolve this market (`account-hash-…` or public key hex). It decides
   * who gets paid, which is why the vault refuses a creator who names themselves.
   */
  oracle: string;
  feeBps: number;
  /** Deadline as epoch ms — the vault stores block time in ms. */
  deadlineMs: number;
  /** Outcome keys, verbatim: they must match the catalogue keys the bets will carry. */
  outcomeKeys: string[];
  /** Creation bond to attach, in motes. Held by the vault, refunded at clean settlement. */
  bondMotes: string;
}

/**
 * A bet transaction built but NOT signed — for the visitor's own wallet to sign.
 *
 * `transactionHash` is known here, before any signature exists, because the hash covers the
 * payload and approvals are appended to it. That is what lets the server bind a prepared bet to
 * the hash it will have on chain (see `lib/bet-ticket.ts`) instead of taking the client's word for
 * what was signed.
 */
export interface UnsignedBetTransaction {
  /** The transaction as JSON text, ready to hand to a wallet. */
  transactionJson: string;
  transactionHash: string;
  /** Gas limit baked into the transaction, in motes — the visitor pays it, so the UI shows it. */
  gasMotes: string;
}

/**
 * What the chain says about a transaction right now — the answer to a single poll.
 *
 * `pending` deliberately covers "not executed yet", "no node has heard of it" and "we could not
 * ask": all three mean the caller may not act as though it happened. Only `confirmed` may move
 * money on the boards.
 */
export type TransactionStatus =
  | { status: "pending" }
  | { status: "confirmed"; result: DeployResult }
  | { status: "reverted"; error: string };

export interface CasperChainPort {
  readonly network: CasperNetwork;
  /** Current block height — a cheap liveness probe. */
  getBlockHeight(): Promise<number>;
  /** Escrow a stake into the parimutuel vault. Returns the on-chain deploy, once it has executed. */
  placeBet(input: PlaceBetInput): Promise<DeployResult>;
  /**
   * The same escrow, submitted but NOT waited for: the hash the moment a node accepts it.
   *
   * `placeBet` only answers once the transaction has executed, which on testnet is 8-16s during
   * which the caller holds nothing to show. This hands the hash straight back so a receipt can be
   * rendered, and leaves confirmation to `checkTransaction`. The caller MUST NOT treat the result
   * as a placed bet — a queued transaction can still revert, and indexing one that did is exactly
   * the bug `confirm.ts` exists to prevent.
   *
   * Optional: an adapter whose submits are instantaneous (the mock) has nothing to gain and does
   * not implement it, so the caller uses `placeBet` and pays a wait that costs nothing.
   */
  submitBet?(input: PlaceBetInput): Promise<DeployResult>;
  /**
   * Build the bet transaction with the BETTOR as initiator and hand it back unsigned, so their
   * wallet signs and their account pays — the difference between a bet the user authorised and a
   * bet the operator made on their behalf.
   *
   * Optional: an adapter with no chain behind it (the mock) has no transaction to offer, and the
   * route falls back to the operator-signed path rather than inventing one.
   */
  buildBetTransaction?(input: PlaceBetInput): Promise<UnsignedBetTransaction>;
  /**
   * Wait for a transaction submitted by SOMEONE ELSE (a visitor's wallet) to execute. Same
   * confirmation semantics as `placeBet`: a revert is a failure, not a bet.
   */
  confirmTransaction?(transactionHash: string): Promise<DeployResult>;
  /**
   * Ask ONCE what the chain currently says about a transaction, without waiting for it.
   *
   * The non-blocking half of `confirmTransaction`, and the one a browser should drive: execution
   * takes 8-16s on testnet, and a request that blocks for it holds the receipt — the hash the
   * visitor wants to see and follow to the explorer — hostage for the whole wait. The caller polls
   * this instead and shows the transaction from the moment the chain has it.
   *
   * Same rule as everything else here: only an execution result the chain actually reports counts
   * as confirmed. Anything unreadable — unknown hash, RPC outage — is `pending`, never success.
   */
  checkTransaction?(transactionHash: string): Promise<TransactionStatus>;
  /** Post a resolution and trigger settlement. */
  resolveMarket(input: ResolveMarketInput): Promise<DeployResult>;
  /** Open a market inside the v2 vault. Rejects when no v2 vault is configured. */
  createMarket(input: CreateMarketInput): Promise<DeployResult>;
  /**
   * Anchor a settled resolution's recipe + evidence hashes on chain (S24), so the call is
   * replayable from the chain alone rather than from this server's word.
   *
   * Returns the anchors it managed to write. It NEVER throws: anchoring is an audit improvement,
   * and a market whose payout was withheld because a metadata write failed would strand user
   * money to protect a hash. Requires a v2 vault target — a per-market v1 package has no such
   * entrypoint — so it reports `skipped` there instead of pretending.
   */
  anchorResolution(input: AnchorResolutionInput): Promise<AnchorResult>;
  explorerUrlForDeploy(deployHash: string): string;
}

export interface AnchorResolutionInput {
  marketId: string;
  /** Hash of the deterministic resolution recipe the Arbiter ran under. */
  recipeHash: string;
  /** Content hash of the published evidence bundle. */
  bundleHash: string;
}

export interface AnchorResult {
  /** Deploy hash of the `commit_recipe` call, when it landed. */
  recipeDeployHash?: string;
  /** Deploy hash of the `commit_bundle` call, when it landed. */
  bundleDeployHash?: string;
  /** Why nothing was anchored — absent when at least one anchor landed. */
  skipped?: string;
}
