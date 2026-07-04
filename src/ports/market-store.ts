/**
 * MarketStorePort — the read model for markets. The chain is the source of truth for money;
 * this store is an index for UX + demo speed (market metadata, cached pools, agent activity).
 */

import type { CasperNetwork } from "@/config/network";
import type { Market, MarketCategory } from "@/core/types";

export interface MarketListFilter {
  network?: CasperNetwork;
  category?: MarketCategory;
  status?: Market["status"];
}

export interface MarketStorePort {
  list(filter?: MarketListFilter): Promise<Market[]>;
  get(slug: string, network: CasperNetwork): Promise<Market | null>;
}
