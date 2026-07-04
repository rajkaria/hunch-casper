/**
 * In-memory MarketStorePort backed by the config-driven catalogue. Deterministic and
 * credential-free. The real store (S3+) indexes on-chain state + agent activity.
 */

import type { CasperNetwork } from "@/config/network";
import { buildCatalogue } from "@/core/catalogue";
import type { Market } from "@/core/types";
import type { MarketListFilter, MarketStorePort } from "@/ports/market-store";

export function createMockMarketStore(): MarketStorePort {
  return {
    async list(filter?: MarketListFilter): Promise<Market[]> {
      const networks: CasperNetwork[] = filter?.network
        ? [filter.network]
        : ["testnet", "mainnet"];
      let markets = networks.flatMap((n) => buildCatalogue(n));
      if (filter?.category) markets = markets.filter((m) => m.category === filter.category);
      if (filter?.status) markets = markets.filter((m) => m.status === filter.status);
      return markets;
    },
    async get(slug: string, network: CasperNetwork): Promise<Market | null> {
      return buildCatalogue(network).find((m) => m.slug === slug) ?? null;
    },
  };
}
