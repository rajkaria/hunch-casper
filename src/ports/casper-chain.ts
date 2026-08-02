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
 * A transaction built but NOT signed — for the visitor's own wallet to sign.
 *
 * `transactionHash` is known here, before any signature exists, because the hash covers the
 * payload and approvals are appended to it. That is what lets the server bind a prepared bet to
 * the hash it will have on chain (see `lib/bet-ticket.ts`) instead of taking the client's word for
 * what was signed.
 */
export interface UnsignedTransaction {
  /** The transaction as JSON text, ready to hand to a wallet. */
  transactionJson: string;
  transactionHash: string;
  /** Gas limit baked into the transaction, in motes — the visitor pays it, so the UI shows it. */
  gasMotes: string;
}

/** The original name, kept so the bet path's callers read unchanged. */
export type UnsignedBetTransaction = UnsignedTransaction;

/**
 * A `create_market` call built for the CREATOR's own wallet to sign. The initiator is the visitor,
 * so on chain `env().caller()` — and therefore `config.creator`, the account the vault refunds the
 * bond to at clean settlement — is genuinely them. The bond rides as the call's attached value,
 * from their account, in the same transaction.
 */
export interface PrepareCreateMarketInput extends CreateMarketInput {
  /** The creator's Casper public key hex: the initiator, and the account the wallet signs as. */
  creator: string;
}

/** A plain CSPR transfer for a visitor's wallet to sign — today, the x402 creation bond. */
export interface TransferTransactionInput {
  /** The payer's Casper public key hex: the initiator, and the account the wallet signs as. */
  from: string;
  /** Recipient — a public key hex or `account-hash-<64hex>`; the two are different on-chain values. */
  to: string;
  amountMotes: string;
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
   * Can this deployment sign as `bettor` itself, making the bet the bettor's own on-chain act
   * funded from its own purse (S30/W1)?
   *
   * True only for a fleet agent (`agent:<name>`) whose key this deployment holds. A human bettor
   * and an unknown id are always false — the answer is a fact about the deployment's key material,
   * never a claim the caller can assert. The fleet loop reads it to decide whether the bettor still
   * owes the operator an x402 reimbursement for an escrow the operator fronted.
   *
   * Optional: an adapter with no key material (the mock) omits it and every bettor reads as
   * operator-custodied, which is the safe direction.
   */
  canSelfSign?(bettor: string): boolean;
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
   * Build a native CSPR transfer with the PAYER as initiator, unsigned, so their wallet signs and
   * their account is debited — the x402 creation bond's money path.
   *
   * It has to be the visitor's own transfer, not an operator convenience: `real-payment.ts`
   * verifies the on-chain initiator against the requirement's payer, so a bond the server moved
   * would prove nothing about who created the market. Before this existed the create page
   * fabricated a `demo-…` settlement id, which the transfer-verifying rail rejected on sight —
   * every real-mode creation failed with "invalid or unverifiable creation-bond payment".
   *
   * Optional, exactly like `buildBetTransaction`: the mock adapter has no chain to transfer on and
   * does not implement it, and the route answers 501 so the caller falls back rather than
   * inventing a transaction.
   */
  buildTransferTransaction?(input: TransferTransactionInput): Promise<UnsignedTransaction>;
  /**
   * Build a payable `create_market` with the CREATOR as initiator, unsigned, for their own wallet
   * to sign — the self-custodial creation path.
   *
   * This is what makes the creation bond genuinely refundable: `HunchVault::refund_bond` pays
   * `config.creator`, which is `env().caller()` at creation, so the signer of this transaction is
   * who the vault returns the bond to at clean settlement. The operator-submitted `createMarket`
   * above cannot deliver that — its caller is the operator. Same plan, same proxy envelope, same
   * gas as the operator path, exactly as `buildBetTransaction` mirrors `placeBet`: the money
   * path's ABI must not fork by who is paying.
   *
   * Optional for the same reason as the other builders: the mock adapter has no transaction to
   * offer, and the route answers 501 so the page falls back to the demo handshake.
   */
  buildCreateMarketTransaction?(input: PrepareCreateMarketInput): Promise<UnsignedTransaction>;
  /**
   * Build an UNSIGNED `AgentRegistry::register` carrying the bond, for the agent's own wallet
   * (S33/W2) — the public join path for a third-party Casper agent.
   *
   * Unsigned by necessity, not convenience: the contract bonds `env().caller()`, so a registration
   * this server signed would enrol the OPERATOR under the agent's name. The resulting entry would
   * name a key the agent does not hold, which is worse than no registry at all — it would look
   * like accountable identity while being the opposite.
   *
   * Optional: the mock adapter has no chain to register on and the route answers 501.
   */
  buildAgentRegistrationTransaction?(input: {
    name: string;
    metadataUri: string;
    bondMotes: string;
    agentPublicKeyHex: string;
  }): Promise<UnsignedTransaction>;
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
   * Notify every contract bound to a finalised market via `ResolutionHook::dispatch` (S34/W3) —
   * the oracle-as-a-service surface other Casper protocols consume.
   *
   * NEVER throws, exactly like `anchorResolution`, and for the same reason: it runs after winners
   * have been paid, so a consumer integration that breaks must not be able to hold a settled
   * payout hostage. An unconfigured hook returns `skipped` rather than failing.
   *
   * Optional: an adapter with no chain behind it does not implement it and the Arbiter carries on.
   */
  dispatchResolution?(input: {
    marketId: string;
    decidedOutcome: string;
    bundleHash: string;
  }): Promise<{ deployHash?: string; explorerUrl?: string; skipped?: string }>;
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
