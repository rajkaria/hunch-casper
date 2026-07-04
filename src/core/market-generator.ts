/**
 * Market generator — the on-chain half of the catalogue engine.
 *
 * `buildDeployPlan` turns one `MarketDefinition` into a `MarketDeployPlan`: the exact,
 * SDK-free argument set a deploy driver needs to (1) `ParimutuelMarket.init(...)` the vault
 * and (2) `MarketFactory.register_market(...)` it into the on-chain registry. This is the
 * Casper analog of the live Hunch product's `pnpm new-market` codegen — one config object
 * scaffolds the whole market. The plan is deliberately network-agnostic and address-free:
 * the same contracts deploy to both Casper networks, and the runtime `oracle`/`treasury`
 * signer addresses are injected by the deploy driver, not baked into the catalogue.
 *
 * The builder is also the config **validator**: it rejects anything the deployed Odra ABI
 * would revert on (fee ≥ 100%, < 2 outcomes, duplicate/empty outcome keys, unparseable
 * deadline), so a malformed one-const fails the green gate offline instead of on-chain.
 *
 * ABI (from `contracts/src/parimutuel_market.rs` + `contracts/src/market_factory.rs`):
 *   ParimutuelMarket.init(question, oracle, treasury, fee_bps, deadline, outcomes)
 *   MarketFactory.register_market(id, question, category, market_address, deadline)
 *
 * INVARIANT: `init.outcomeKeys` are the catalogue outcome keys **verbatim**. The vault rejects
 * unknown outcomes and the payable `bet` sends the catalogue key as its `outcome` arg
 * (`adapters/casper/deploy-plan.ts`), so on-chain outcomes must mirror `outcome.key`s exactly.
 */

import type { MarketCadence, MarketCategory, ResolverBinding } from "@/core/types";
import type { MarketDefinition } from "@/core/catalogue";
import { MARKET_DEFINITIONS } from "@/core/catalogue";

const BPS_DENOMINATOR = 10_000;

/** Args for `ParimutuelMarket.init` (minus the runtime oracle/treasury signer addresses). */
export interface MarketInitPlan {
  question: string;
  /** Parimutuel fee in basis points, taken only from the losing pool (< 10_000). */
  feeBps: number;
  /** Betting-close block time, in epoch milliseconds. */
  deadlineMs: number;
  /** Ordered on-chain outcome keys — equal to the catalogue outcome keys, verbatim. */
  outcomeKeys: string[];
}

/** Args for `MarketFactory.register_market` (minus the deployed market's runtime address). */
export interface MarketRegistrationPlan {
  /** Stable market id — the catalogue slug (the factory is per-network). */
  id: string;
  question: string;
  category: MarketCategory;
  deadlineMs: number;
}

/** Everything a deploy driver needs to stand a market up on-chain, derived from one config. */
export interface MarketDeployPlan {
  slug: string;
  category: MarketCategory;
  cadence: MarketCadence;
  /** The declarative resolution rule, carried through for the Arbiter + docs. */
  resolver: ResolverBinding;
  init: MarketInitPlan;
  registration: MarketRegistrationPlan;
}

function deadlineToMs(slug: string, iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error(`market "${slug}": deadlineIso is not a valid ISO date: ${JSON.stringify(iso)}`);
  }
  return ms;
}

function assertValid(def: MarketDefinition, deadlineMs: number): void {
  if (!Number.isInteger(def.feeBps) || def.feeBps < 0 || def.feeBps >= BPS_DENOMINATOR) {
    throw new Error(`market "${def.slug}": feeBps must be an integer in [0, ${BPS_DENOMINATOR}), got ${def.feeBps}`);
  }
  if (deadlineMs <= 0) {
    throw new Error(`market "${def.slug}": deadline must be a positive epoch ms, got ${deadlineMs}`);
  }
  const keys = def.outcomes.map((o) => o.key);
  if (keys.length < 2) {
    throw new Error(`market "${def.slug}": a market needs at least 2 outcomes, got ${keys.length}`);
  }
  if (keys.some((k) => k.length === 0)) {
    throw new Error(`market "${def.slug}": outcome keys must be non-empty`);
  }
  if (new Set(keys).size !== keys.length) {
    throw new Error(`market "${def.slug}": outcome keys must be unique, got [${keys.join(", ")}]`);
  }
  // The seed pool must back exactly the outcomes — no missing key (zero-backs a live outcome),
  // no extra/misspelled key (inflates totalStaked with phantom motes). Both distort odds while
  // passing typecheck, since poolByOutcomeMotes is a loose Record<string,string>.
  const poolKeys = Object.keys(def.seedPoolMotes);
  const keySet = new Set(keys);
  if (poolKeys.length !== keySet.size || !poolKeys.every((k) => keySet.has(k))) {
    throw new Error(
      `market "${def.slug}": seedPoolMotes keys must be exactly the outcome keys [${keys.join(", ")}], got [${poolKeys.join(", ")}]`,
    );
  }
  for (const k of keys) {
    const raw = def.seedPoolMotes[k];
    if (!/^\d+$/.test(raw)) {
      throw new Error(`market "${def.slug}": seedPoolMotes["${k}"] must be a non-negative integer motes string, got ${JSON.stringify(raw)}`);
    }
  }
  // A threshold market must declare what it compares against; an n-way winner needs candidates.
  if (def.resolver.kind === "threshold" && (def.resolver.target == null || def.resolver.comparator == null)) {
    throw new Error(`market "${def.slug}": a threshold resolver requires target + comparator`);
  }
  if (def.resolver.kind === "nway_winner" && keys.length < 2) {
    throw new Error(`market "${def.slug}": an n-way winner needs at least 2 candidate outcomes`);
  }
}

/** Derive the on-chain deploy plan for one market definition (pure, address-free). */
export function buildDeployPlan(def: MarketDefinition): MarketDeployPlan {
  const deadlineMs = deadlineToMs(def.slug, def.deadlineIso);
  assertValid(def, deadlineMs);
  const outcomeKeys = def.outcomes.map((o) => o.key);
  return {
    slug: def.slug,
    category: def.category,
    cadence: def.cadence,
    resolver: def.resolver,
    init: {
      question: def.title,
      feeBps: def.feeBps,
      deadlineMs,
      outcomeKeys,
    },
    registration: {
      id: def.slug,
      question: def.title,
      category: def.category,
      deadlineMs,
    },
  };
}

/** Deploy plans for the whole catalogue — what a full-network deploy driver iterates. */
export function buildAllDeployPlans(): MarketDeployPlan[] {
  return MARKET_DEFINITIONS.map(buildDeployPlan);
}
