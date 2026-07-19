/**
 * Human market creation, end to end — compose → pay the creation bond via x402 → open on chain →
 * register → seed with fleet liquidity. The counterpart of `agent-bet.ts` for the *creation* money
 * path, and it reuses the same x402 handshake so a human posting a bond and an agent placing a bet
 * settle through one rail.
 *
 * The creation bond is the moderation economics: a market that resolves cleanly refunds it; an
 * unresolvable, duplicate, or abandoned market forfeits it (the vault holds it; slashing is the
 * registry hook). So spamming the board costs money, and the honest creator is made whole.
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

/** Default creation bond (1 CSPR), overridable via `CASPER_CREATION_BOND_MOTES`. Mirrors Genesis. */
export const DEFAULT_CREATION_BOND_MOTES = "1000000000";

export function creationBondMotes(): string {
  const raw = process.env.CASPER_CREATION_BOND_MOTES;
  return raw && /^\d+$/.test(raw) && BigInt(raw) > 0n ? raw : DEFAULT_CREATION_BOND_MOTES;
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
function bondPayTo(): string {
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
