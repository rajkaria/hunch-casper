/**
 * In-memory MarketStorePort backed by the config-driven catalogue + the in-process settlement
 * ledger. Deterministic and credential-free. `list`/`get` overlay live pools + settlement state
 * onto the catalogue seed; `recordBet`/`settle` mutate the ledger through the pure payout engine.
 * The real store (Supabase/SQLite) indexes on-chain state + agent activity behind this same port.
 */

import type { CasperNetwork } from "@/config/network";
import { buildAllMarkets } from "@/adapters/mock/market-source";
import type { Market } from "@/core/types";
import type {
  MarketListFilter,
  MarketStorePort,
  RecordBetInput,
  SettledEntry,
  SettlementRecord,
} from "@/ports/market-store";
import {
  ledgerGet,
  ledgerRecordBet,
  ledgerSettle,
  ledgerSettledEntries,
  ledgerSettlementFor,
} from "./settlement-ledger";
// Importing economy-state also registers the persist hook the state modules fire on mutation, so
// any instance that constructs the store (i.e. any request through the container) is armed.
import { hydrateEconomyState, persistEconomyState } from "@/adapters/persist/economy-state";

export function createMockMarketStore(): MarketStorePort {
  return {
    async list(filter?: MarketListFilter): Promise<Market[]> {
      await hydrateEconomyState(); // restore any persisted economy before the first read (no-op unconfigured)
      const networks: CasperNetwork[] = filter?.network ? [filter.network] : ["testnet", "mainnet"];
      // Overlay any live ledger state (pools, status) onto the seed for every known market
      // (catalogue + Genesis-created).
      let markets = networks.flatMap((n) => buildAllMarkets(n).map((seed) => ledgerGet(seed.id) ?? seed));
      if (filter?.category) markets = markets.filter((m) => m.category === filter.category);
      if (filter?.status) markets = markets.filter((m) => m.status === filter.status);
      return markets;
    },
    async get(slug: string, network: CasperNetwork): Promise<Market | null> {
      await hydrateEconomyState();
      return ledgerGet(`${network}:${slug}`);
    },
    async recordBet(input: RecordBetInput): Promise<Market> {
      await hydrateEconomyState(); // a bet must land ON TOP of the persisted pools, not a fresh seed
      const market = ledgerRecordBet(input);
      void persistEconomyState(); // fire-and-forget: a KV outage never fails the bet
      return market;
    },
    async settle(marketId: string, winningOutcomeKey: string | null): Promise<SettlementRecord> {
      await hydrateEconomyState();
      const record = ledgerSettle(marketId, winningOutcomeKey);
      void persistEconomyState();
      return record;
    },
    async settlementFor(marketId: string): Promise<SettlementRecord | null> {
      await hydrateEconomyState();
      return ledgerSettlementFor(marketId);
    },
    async settledEntries(network?: CasperNetwork): Promise<SettledEntry[]> {
      await hydrateEconomyState();
      return ledgerSettledEntries(network);
    },
  };
}
