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

export function createMockMarketStore(): MarketStorePort {
  return {
    async list(filter?: MarketListFilter): Promise<Market[]> {
      const networks: CasperNetwork[] = filter?.network ? [filter.network] : ["testnet", "mainnet"];
      // Overlay any live ledger state (pools, status) onto the seed for every known market
      // (catalogue + Genesis-created).
      let markets = networks.flatMap((n) => buildAllMarkets(n).map((seed) => ledgerGet(seed.id) ?? seed));
      if (filter?.category) markets = markets.filter((m) => m.category === filter.category);
      if (filter?.status) markets = markets.filter((m) => m.status === filter.status);
      return markets;
    },
    async get(slug: string, network: CasperNetwork): Promise<Market | null> {
      return ledgerGet(`${network}:${slug}`);
    },
    async recordBet(input: RecordBetInput): Promise<Market> {
      return ledgerRecordBet(input);
    },
    async settle(marketId: string, winningOutcomeKey: string | null): Promise<SettlementRecord> {
      return ledgerSettle(marketId, winningOutcomeKey);
    },
    async settlementFor(marketId: string): Promise<SettlementRecord | null> {
      return ledgerSettlementFor(marketId);
    },
    async settledEntries(network?: CasperNetwork): Promise<SettledEntry[]> {
      return ledgerSettledEntries(network);
    },
  };
}
