"use client";

import type { Market } from "@/core/types";
import { relatedMarkets } from "@/core/related-markets";
import { useMarkets } from "@/components/use-markets";
import { MarketCard } from "@/components/market-card";

/**
 * Full-width "Related markets" section at the foot of every detail page — same-category and
 * shared-subject siblings, ranked by the pure `relatedMarkets()`. Reads the same read model as
 * the explorer; renders nothing when there are no siblings (e.g. the lone coin-flip market).
 */
export function RelatedMarkets({ market }: { market: Market }) {
  const { markets, loading } = useMarkets(market.network);
  if (loading) return null;
  const related = relatedMarkets(market, markets);
  if (related.length === 0) return null;

  return (
    <section className="mt-14 border-t border-border pt-8">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted">Related markets</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {related.map((m) => (
          <MarketCard key={m.id} market={m} />
        ))}
      </div>
    </section>
  );
}
