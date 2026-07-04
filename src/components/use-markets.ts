"use client";

import { useEffect, useState } from "react";
import type { CasperNetwork } from "@/config/network";
import type { Market } from "@/core/types";

interface MarketsState {
  markets: Market[];
  loading: boolean;
  error: string | null;
}

interface MarketsData {
  key: string;
  markets: Market[];
  error: string | null;
}

/**
 * Fetch the market read model (`GET /api/markets`) for a network. The explorer + related-markets
 * read this rather than the bundled catalogue so that once the store records live bets (S5) the
 * UI shows live pools with no change here. Refetches when the network toggle flips.
 *
 * `loading` is derived from render state (the loaded key vs the requested key), so the effect
 * only ever calls setState asynchronously — no synchronous set-state-in-effect.
 */
export function useMarkets(network: CasperNetwork): MarketsState {
  const [data, setData] = useState<MarketsData | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/markets?network=${network}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "failed to load markets");
        return res.json() as Promise<{ markets: Market[] }>;
      })
      .then((json) => setData({ key: network, markets: json.markets, error: null }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setData({ key: network, markets: [], error: err instanceof Error ? err.message : "failed to load markets" });
      });
    return () => ctrl.abort();
  }, [network]);

  const loading = data === null || data.key !== network;
  return {
    markets: loading ? [] : data!.markets,
    loading,
    error: loading ? null : data!.error,
  };
}

interface MarketState {
  market: Market | null;
  loading: boolean;
  error: string | null;
}

interface MarketData {
  key: string;
  market: Market | null;
  error: string | null;
}

/** Fetch a single market from the read model (`GET /api/markets/[slug]`). */
export function useMarket(network: CasperNetwork, slug: string): MarketState {
  const [data, setData] = useState<MarketData | null>(null);
  const key = `${network}:${slug}`;

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/markets/${slug}?network=${network}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (res.status === 404) return { market: null };
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "failed to load market");
        return res.json() as Promise<{ market: Market }>;
      })
      .then((json) => setData({ key: `${network}:${slug}`, market: json.market ?? null, error: null }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setData({ key: `${network}:${slug}`, market: null, error: err instanceof Error ? err.message : "failed to load market" });
      });
    return () => ctrl.abort();
  }, [network, slug]);

  const loading = data === null || data.key !== key;
  return {
    market: loading ? null : data!.market,
    loading,
    error: loading ? null : data!.error,
  };
}
