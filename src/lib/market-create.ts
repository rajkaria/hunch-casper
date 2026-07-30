/**
 * Human market creation, end to end — compose → pay the creation bond via x402 → open on chain →
 * register → seed with fleet liquidity. The counterpart of `agent-bet.ts` for the *creation* money
 * path, and it reuses the same x402 handshake so a human posting a bond and an agent placing a bet
 * settle through one rail.
 *
 * The creation bond is the moderation economics: opening a market costs something, so spamming the
 * board costs money. The vault holds a bond per market and returns it to whoever CALLED
 * `create_market` at clean settlement — which on this path is the operator, not the human whose
 * transfer paid for it. See the warning in `config/creation-bond.ts`: making the visitor's bond
 * genuinely refundable means letting them sign `create_market` themselves, the same self-custodial
 * move `/api/chain/bet/prepare` made for betting.
 *
 * ⚠️ Real-mode safety mirrors `agent-bet.ts`: in `CASPER_CHAIN_MODE=real` an on-chain
 * `create_market` is operator-funded, so the bond must be verifiably paid — the same
 * `CASPER_X402_PAYTO` / `CASPER_REAL_AGENT_X402` gate applies, else the route fails closed.
 */

import type { Container } from "@/lib/container";
import type { X402PaymentProof, X402PaymentRequirement } from "@/ports/payment";
import type { MarketDefinition } from "@/core/catalogue";
import { composeMarket, type ComposeMarketInput, type ComposeReason } from "@/core/market-composer";
import { buildMarket } from "@/core/catalogue";
import { addCreatedMarket, allDefinitions } from "@/adapters/mock/market-source";
import { appendAction } from "@/adapters/mock/activity-log";
import { seedNewMarketByFleet } from "@/agent/prophet";
import { chainMode } from "@/config/chain-mode";
import type { AgentAction } from "@/adapters/mock/activity-log";

// The bond's own module — Genesis reads the same one, so the number the vault is handed and the
// number a visitor is quoted cannot drift. Re-exported because callers and tests import it here.
export {
  DEFAULT_CREATION_BOND_MOTES,
  creationBondMotes,
  creationBondPaymentBlocker,
} from "@/config/creation-bond";
import { creationBondMotes } from "@/config/creation-bond";

/** A Casper public key hex (ed25519 `01…` / secp256k1 `02…`) — a real, signable account. */
const PUBLIC_KEY_HEX = /^0[12][0-9a-fA-F]{64,128}$/;

/**
 * An identifier the vault can store as a market's oracle: a prefixed `account-hash-…`/`hash-…`, or
 * a public key hex the adapter derives the account hash from (`toOracleAddress`).
 *
 * A friendly placeholder like `account-hash-arbiter` is none of those — `Key::newKey` throws on it
 * while building the transaction, i.e. AFTER the bond has been paid. Rejecting the shape up front
 * turns that into a 400 the form can point at the field.
 */
const ORACLE_ADDRESS = /^((account-hash|hash)-[0-9a-fA-F]{64}|0[12][0-9a-fA-F]{64,128})$/;

/** True when the bond must be a REAL on-chain transfer (the transfer-verifying x402 rail is wired). */
function realBondRequired(): boolean {
  return chainMode() === "real" && Boolean(process.env.CASPER_X402_PAYTO);
}

/** Bonds already spent on a created market — one bond payment opens exactly one market. */
const consumedBondPayments = new Set<string>();
export function __resetConsumedBonds(): void {
  consumedBondPayments.clear();
}

export interface CreateMarketRequest extends ComposeMarketInput {
  /** The approved, non-creator oracle to bind (the vault refuses a creator-as-oracle market). */
  oracle: string;
  /** x402 proof for the creation bond; omit on the first call to receive the requirement. */
  paymentProof?: X402PaymentProof;
  /** Whether the fleet seeds the new market with liquidity (default true). */
  seedByFleet?: boolean;
}

export type CreateMarketResult =
  | { status: "payment_required"; requirement: X402PaymentRequirement; bondMotes: string; recipeHash: string }
  | {
      status: "created";
      slug: string;
      recipeHash: string;
      deployHash?: string;
      explorerUrl?: string;
      simulated: boolean;
      seededBets: number;
    }
  | { status: "error"; error: string; code: number; reason?: ComposeReason };

/** The bond `payTo` — the treasury/vault the requirement points at, same as a bet. */
export function bondPayTo(): string {
  return process.env.CASPER_X402_PAYTO ?? "vault-mock-account";
}

export async function createMarket(container: Container, req: CreateMarketRequest): Promise<CreateMarketResult> {
  // Real-mode safety gate — identical policy to the agent bet rail.
  const realPaymentConfigured = Boolean(process.env.CASPER_X402_PAYTO);
  if (chainMode() === "real" && process.env.CASPER_REAL_AGENT_X402 !== "true" && !realPaymentConfigured) {
    return {
      status: "error",
      code: 503,
      error:
        "real-mode market creation is disabled — set CASPER_X402_PAYTO (trustless bond verification) or CASPER_REAL_AGENT_X402=true",
    };
  }
  if (typeof req.oracle !== "string" || req.oracle.trim().length === 0) {
    return { status: "error", code: 400, error: "an approved oracle account is required" };
  }
  if (req.oracle.trim() === req.creator.trim()) {
    // The vault enforces this too (I5); rejecting early gives a clean message instead of a revert.
    return { status: "error", code: 400, error: "a creator may not be their own oracle" };
  }
  // Real mode is the only place these two shapes MATTER, and the only place a bad one is
  // expensive: the creator is the account whose transfer must verify, and the oracle is a `Key`
  // the vault stores. Both are checked BEFORE the bond challenge is issued, so nobody pays for a
  // market that could never be opened. In mock mode the labels never reach a chain, so they stand.
  if (realBondRequired() && !PUBLIC_KEY_HEX.test(req.creator.trim())) {
    return {
      status: "error",
      code: 400,
      error:
        "connect a Casper wallet to create a market — the creation bond is a transfer from your " +
        "own account, so the creator must be your public key",
    };
  }
  if (chainMode() === "real" && !ORACLE_ADDRESS.test(req.oracle.trim())) {
    return {
      status: "error",
      code: 400,
      error: `oracle must be an 'account-hash-<64 hex>' address or a Casper public key, got: ${req.oracle.trim()}`,
    };
  }

  const composed = await composeMarket(req, { llm: container.llm, existing: [...allDefinitions()] });
  if (!composed.ok) {
    const code = composed.reason === "duplicate" ? 409 : composed.reason === "category" ? 422 : 400;
    return { status: "error", code, error: composed.message, reason: composed.reason };
  }
  const { definition, recipeHash } = composed;
  const bondMotes = creationBondMotes();

  const requirement = await container.payment.quote({
    marketId: definition.slug,
    outcomeKey: "__bond__",
    amountMotes: bondMotes,
    payer: req.creator,
  });

  // Step 1: no proof → hand back the bond challenge.
  if (!req.paymentProof) {
    return { status: "payment_required", requirement: { ...requirement, payTo: bondPayTo() }, bondMotes, recipeHash };
  }

  // Step 2: verify + spend the bond, then open the market on chain.
  const ok = await container.payment.verify(requirement, req.paymentProof);
  if (!ok) return { status: "error", code: 402, error: "invalid or unverifiable creation-bond payment" };
  if (!req.paymentProof.deployHash) {
    return { status: "error", code: 402, error: "bond proof must reference a settlement (deployHash)" };
  }
  if (consumedBondPayments.has(req.paymentProof.deployHash)) {
    return { status: "error", code: 402, error: "creation bond already spent" };
  }

  let receipt: { deployHash: string; explorerUrl: string } | null = null;
  if (chainMode() === "real") {
    try {
      receipt = await container.chain.createMarket({
        marketId: definition.slug,
        question: definition.title,
        category: definition.category,
        oracle: req.oracle.trim(),
        feeBps: definition.feeBps,
        deadlineMs: Date.parse(definition.deadlineIso),
        outcomeKeys: definition.outcomes.map((o) => o.key),
        bondMotes,
      });
    } catch (err) {
      return { status: "error", code: 502, error: err instanceof Error ? err.message : "on-chain create_market failed" };
    }
  }
  consumedBondPayments.add(req.paymentProof.deployHash);

  // Register the off-chain mirror (throws if the slug somehow already exists — a race we surface).
  try {
    addCreatedMarket(definition);
  } catch (err) {
    return { status: "error", code: 409, error: err instanceof Error ? err.message : "market already exists" };
  }
  const market = buildMarket(definition, container.network);
  appendAction({
    agent: "Community",
    kind: "market_created",
    marketId: market.id,
    marketTitle: market.title,
    narration: `${definition.subtitle ?? "community market"} · recipe ${recipeHash.slice(0, 16)}…`,
    deployHash: receipt?.deployHash,
    explorerUrl: receipt?.explorerUrl,
    simulated: receipt === null,
  });

  // Long-tail liquidity: the fleet seeds the new market so it doesn't open empty.
  let seeded: AgentAction[] = [];
  if (req.seedByFleet !== false) {
    try {
      seeded = await seedNewMarketByFleet(container, definition.slug, { maxProphets: 2, startSeq: req.seq });
    } catch {
      /* seeding is best-effort — a seeding failure never fails the creation */
    }
  }

  return {
    status: "created",
    slug: definition.slug,
    recipeHash,
    deployHash: receipt?.deployHash,
    explorerUrl: receipt?.explorerUrl,
    simulated: receipt === null,
    seededBets: seeded.length,
  };
}

/** Recompute a created market's definition (for the route's confirmation payload). */
export function definitionForSlug(slug: string): MarketDefinition | undefined {
  return allDefinitions().find((d) => d.slug === slug);
}
