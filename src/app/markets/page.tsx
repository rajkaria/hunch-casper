"use client";

import { useMemo, useState } from "react";
import { useNetwork } from "@/components/network-context";
import { useMarkets } from "@/components/use-markets";
import type { MarketCategory } from "@/core/types";
import { MarketCard } from "@/components/market-card";

const FILTERS: { key: MarketCategory | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "casper-native", label: "Casper-native" },
  { key: "provably-fair", label: "Provably fair" },
  { key: "rwa", label: "RWA" },
  { key: "meta", label: "Meta" },
];

export default function MarketsPage() {
  const { network } = useNetwork();
  const { markets, loading, error } = useMarkets(network);
  const [filter, setFilter] = useState<MarketCategory | "all">("all");

  const shown = useMemo(
    () => (filter === "all" ? markets : markets.filter((m) => m.category === filter)),
    [markets, filter],
  );

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
      <div className="mb-8 flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Markets</h1>
        <p className="text-muted">
          {loading ? (
            "Loading markets…"
          ) : (
            <>
              {shown.length} live on Casper <span className="text-foreground">{network}</span> —
              created, traded, and resolved by agents.
            </>
          )}
        </p>
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const active = f.key === filter;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`chip px-3 py-1.5 text-xs font-medium transition-colors ${
                active ? "border-accent/60 text-accent" : "text-muted hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {error ? (
        <p className="text-sm text-down">Couldn’t load markets: {error}</p>
      ) : loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card h-44 animate-pulse bg-surface-2/40" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted">No markets in this category on {network}.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((m) => (
            <MarketCard key={m.id} market={m} />
          ))}
        </div>
      )}
    </main>
  );
}
