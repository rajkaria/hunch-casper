/**
 * The market source — the single list of market definitions the app knows about: the static
 * config-driven catalogue PLUS markets the Genesis agent creates at runtime. The store, the
 * settlement ledger, and the oracle all resolve definitions through here, so a Genesis-created
 * market is a first-class citizen everywhere (explorer, MCP, betting, settlement) the instant it
 * is registered — exactly what "an economy where agents open markets autonomously" needs.
 *
 * `created` is a module-level singleton (like the settlement ledger); the on-chain MarketFactory
 * registry is the real source of truth, and the real store indexes it behind the same seam.
 */

import { MARKET_DEFINITIONS, buildMarket } from "@/core/catalogue";
import type { MarketDefinition } from "@/core/catalogue";
import type { CasperNetwork } from "@/config/network";
import type { Market } from "@/core/types";
import { fireEconomyPersistHook } from "@/adapters/persist/economy-persist-hook";

const created: MarketDefinition[] = [];

/** Every known definition — static catalogue first, then Genesis-created (insertion order). */
export function allDefinitions(): readonly MarketDefinition[] {
  return created.length === 0 ? MARKET_DEFINITIONS : [...MARKET_DEFINITIONS, ...created];
}

/** Find a definition by slug across both the catalogue and Genesis-created markets. */
export function findDefinition(slug: string): MarketDefinition | undefined {
  return allDefinitions().find((d) => d.slug === slug);
}

/** Materialise every known market for a network. */
export function buildAllMarkets(network: CasperNetwork): Market[] {
  return allDefinitions().map((d) => buildMarket(d, network));
}

/** Register a Genesis-created market. Throws on a slug collision. */
export function addCreatedMarket(def: MarketDefinition): void {
  if (findDefinition(def.slug)) throw new Error(`market '${def.slug}' already exists`);
  created.push(def);
  fireEconomyPersistHook(); // snapshot to KV when configured (no-op otherwise) — see adapters/persist
}

/** The Genesis-created markets, in creation order. */
export function listCreatedMarkets(): readonly MarketDefinition[] {
  return created;
}

/** Test-only: forget all Genesis-created markets. */
export function __resetCreatedMarkets(): void {
  created.length = 0;
}

/** JSON-safe snapshot of the Genesis-created definitions for KV persistence. */
export interface CreatedMarketsSnapshot {
  created: MarketDefinition[];
}

/** Export the created markets, deep-cloned so later creations never leak into a snapshot. */
export function exportCreatedMarkets(): CreatedMarketsSnapshot {
  return { created: structuredClone(created) };
}

/** Restore a snapshot, REPLACING (not merging) current state. Idempotent. */
export function importCreatedMarkets(snapshot: CreatedMarketsSnapshot): void {
  created.length = 0;
  created.push(...structuredClone(snapshot.created));
}
