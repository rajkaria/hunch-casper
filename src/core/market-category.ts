/**
 * Which shelf a market belongs on, derived from how it will actually be settled.
 *
 * Category is a claim about resolution, not decoration: "provably fair" on this site means the
 * drand public randomness beacon decided it — no house, no edge, verifiable by anyone. So the
 * category is read off the frozen resolver recipe rather than asserted alongside it, and cannot
 * drift from the settlement path. A test pins every catalogue market to this derivation.
 */

import type { MarketCategory, ResolverSource } from "@/core/types";

/** The resolver facts the shelf depends on — the recipe's source and the metric it reads. */
export interface ResolverShape {
  source: ResolverSource;
  metric: string;
}

export function categoryForResolver(resolver: ResolverShape): MarketCategory {
  switch (resolver.source) {
    case "drand":
      return "provably-fair";
    case "cspr_cloud":
      return "casper-native";
    case "internal":
      return "meta";
    case "macro_feed":
      return "rwa";
    case "coingecko":
      // A price feed is only Casper-native when the asset is CSPR itself; BTC/ETH/gold are RWA.
      return /^cspr(_|$)/.test(resolver.metric) ? "casper-native" : "rwa";
  }
}
