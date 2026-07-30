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
import { oracleAccount } from "@/agent/genesis";
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

/**
 * The vault's public-creation deadline horizon (contracts/src/hunch_vault.rs:
 * `MAX_PUBLIC_DEADLINE_HORIZON_MS`, 180 days). Enforced HERE because the operator key that
 * submits `create_market` is the vault ADMIN — the contract's own horizon check never runs for
 * app creations, so without this a visitor could escrow bettor funds for years.
 */
const MAX_DEADLINE_HORIZON_MS = 180 * 24 * 60 * 60 * 1_000;

/** True when the bond must be a REAL on-chain transfer (the transfer-verifying x402 rail is wired). */
function realBondRequired(): boolean {
  return chainMode() === "real" && Boolean(process.env.CASPER_X402_PAYTO);
}

/**
 * One account, one spelling. Public keys collapse to their `account-hash-…` form (what the vault
 * stores as a `Key`), and everything lowercases — so `01AB…`, `01ab…` and the derived
 * `account-hash-…` all compare equal. Without this, a creator could pass their OWN account-hash
 * (or a case-flip of it) as the oracle: the raw string differs from their public-key creator
 * field, the byte-inequality check passes, and they become the oracle of a market they can bet
 * in — bet one side, resolve in their own favour, take the losing pool.
 *
 * The blake2b derivation lives in the chain adapter (`toOracleAddress`), loaded lazily so the
 * chain SDK stays behind the same dynamic-import seam the container uses. Mock-mode labels are
 * not keys; they compare lowercased as-is.
 */
async function normalizeAccountId(value: string, real: boolean): Promise<string> {
  const raw = value.trim();
  if (real) {
    try {
      const { toOracleAddress } = await import("@/adapters/casper/real-chain");
      return toOracleAddress(raw).toLowerCase();
    } catch {
      /* not a derivable key — compare the raw spelling */
    }
  }
  return raw.toLowerCase();
}

/** Bonds already spent on a created market — one bond payment opens exactly one market. */
const consumedBondPayments = new Set<string>();
export function __resetConsumedBonds(): void {
  consumedBondPayments.clear();
}

/** Snapshot for the KV envelope — mirrors `bet-breaker`'s export/import pair, so a serverless
 * instance that never saw a bond spent cannot be replayed against. */
export function exportConsumedBondPayments(): string[] {
  return [...consumedBondPayments];
}

/** Restore from the KV envelope. Unions into the live set (never clears — a hash this instance
 * already claimed stays claimed); junk entries are dropped rather than trusted. */
export function importConsumedBondPayments(hashes: string[]): void {
  if (!Array.isArray(hashes)) return;
  for (const hash of hashes) {
    if (typeof hash === "string" && hash.length > 0) consumedBondPayments.add(hash);
  }
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
  const real = chainMode() === "real";
  // The self-oracle check compares NORMALIZED identities, not raw strings: the creator field is a
  // public key while the oracle may be an account-hash, so the same account has two byte-distinct
  // spellings (plus case-flips) — exactly the gap a self-resolving creator would use.
  const oracleNorm = await normalizeAccountId(req.oracle, real);
  const creatorNorm = await normalizeAccountId(req.creator, real);
  if (oracleNorm === creatorNorm) {
    // The vault enforces this too (I5) — but never for the admin key that submits app creations,
    // so this check is the entire defense. Rejecting early also gives a clean message.
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
  if (real && !ORACLE_ADDRESS.test(req.oracle.trim())) {
    return {
      status: "error",
      code: 400,
      error: `oracle must be an 'account-hash-<64 hex>' address or a Casper public key, got: ${req.oracle.trim()}`,
    };
  }
  if (real) {
    // The submitted oracle must BE the deployment's approved oracle — not merely a valid,
    // non-creator address. The vault's OracleNotApproved guardrail is skipped for the admin key,
    // so any address accepted here becomes the account that decides who gets paid.
    const approved = oracleAccount();
    if (!approved) {
      return {
        status: "error",
        code: 503,
        error:
          "no approved oracle is configured on this deployment (CASPER_ORACLE_ACCOUNT) — a market cannot be bound to one",
      };
    }
    if (oracleNorm !== (await normalizeAccountId(approved, true))) {
      return {
        status: "error",
        code: 400,
        error: `only the deployment's approved oracle is accepted as a market's oracle: ${approved}`,
      };
    }
    // The vault's deadline rules, mirrored for the same skipped-guardrail reason: the deadline
    // must be a real future instant, and no further out than the public horizon — bettor funds
    // are escrowed until it passes. Checked BEFORE the bond challenge is issued.
    const deadlineMs = Date.parse(req.deadlineIso ?? "");
    if (Number.isNaN(deadlineMs) || deadlineMs <= Date.now()) {
      return { status: "error", code: 400, error: "deadline must be a valid future timestamp" };
    }
    if (deadlineMs > Date.now() + MAX_DEADLINE_HORIZON_MS) {
      return {
        status: "error",
        code: 400,
        error: "deadline must be within 180 days — the vault's public-creation horizon",
      };
    }
  }

  const composed = await composeMarket(req, { llm: container.llm, existing: [...allDefinitions()] });
  if (!composed.ok) {
    const code = composed.reason === "duplicate" ? 409 : composed.reason === "category" ? 422 : 400;
    return { status: "error", code, error: composed.message, reason: composed.reason };
  }
  const { definition, recipeHash } = composed;
  const bondMotes = creationBondMotes();

  // The bond is quoted against the RECIPE HASH, never the slug: the slug carries the
  // created-count seq, which moves whenever anything else creates a market (round rollovers do,
  // constantly) — and the x402 nonce is a function of the marketId, so a moved seq between the
  // 402 challenge and the paid retry turned an already-paid bond unverifiable. The recipe hash is
  // stable for the same rule, so both calls derive the same requirement.
  const requirement = await container.payment.quote({
    marketId: `bond:${recipeHash}`,
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
  const bondSettlement = req.paymentProof.deployHash;
  if (consumedBondPayments.has(bondSettlement)) {
    return { status: "error", code: 402, error: "creation bond already spent" };
  }
  // Claim the settlement NOW, before the awaited chain call — check-and-claim with no await
  // between them. The on-chain create takes 20–120s, and two concurrent requests carrying the
  // same deployHash would both pass a has-check that only turned true afterwards: one bond, two
  // markets. A create that FAILS on chain releases the claim below, so a genuinely-failed
  // creation can retry with the same bond.
  consumedBondPayments.add(bondSettlement);

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
      // Nothing was opened for this bond — release the claim so the paid transfer stays usable.
      consumedBondPayments.delete(bondSettlement);
      return { status: "error", code: 502, error: err instanceof Error ? err.message : "on-chain create_market failed" };
    }
  }

  // Register the off-chain mirror (throws if the slug somehow already exists — a race we surface).
  try {
    addCreatedMarket(definition, container.network);
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
