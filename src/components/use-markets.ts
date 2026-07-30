"use client";

import { useCallback, useEffect, useState } from "react";
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

/** The pool fields a mutating route hands back — authoritative, straight from the write. */
export interface PoolUpdate {
  totalStakedMotes?: string;
  poolByOutcomeMotes?: Record<string, string>;
}

interface MarketState {
  market: Market | null;
  loading: boolean;
  error: string | null;
  /**
   * Refetch this market from the read model. `fresh` forces the route past its warm-instance
   * hydrate TTL — use it right after a write, where a stale read would look like the write
   * failed. Never flips `loading`: a background refresh must not blank the page out.
   */
  refresh: (fresh?: boolean) => void;
  /**
   * Merge the pools a write already returned into the rendered market, with no round trip. This is
   * not optimism — the numbers come from the server's post-write read model — so the odds bars and
   * the total-betted block move the instant a bet lands, and the refetch behind it only confirms.
   */
  applyPools: (update: PoolUpdate) => void;
}

interface MarketData {
  key: string;
  market: Market | null;
  error: string | null;
}

/**
 * API path for one market, slug percent-encoded — a round slug's `#` (`cspr-hourly-updown#20658`)
 * interpolated raw would truncate the URL at the fragment and drop the query string.
 */
export function marketApiPath(slug: string): string {
  return `/api/markets/${encodeURIComponent(slug)}`;
}

/**
 * Decode a `[slug]` route param. Next hands dynamic segments over still percent-encoded (the same
 * reason `agents/[id]` decodes), so a round slug arrives as `cspr-hourly-updown%2320658` and would
 * miss the store without this. A no-op on already-decoded slugs — catalogue slugs never contain `%`.
 */
export function decodeSlugParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // malformed escapes ("100%zz") — pass through and let the API 404 it honestly
  }
}

/** Fetch a single market from the read model (`GET /api/markets/[slug]`). */
export function useMarket(network: CasperNetwork, slugParam: string): MarketState {
  const slug = decodeSlugParam(slugParam);
  const [data, setData] = useState<MarketData | null>(null);
  // Bumped by `refresh()`. `fresh` rides alongside rather than in the counter so a refetch can ask
  // for a KV-fresh read without that becoming part of the effect's identity.
  const [reload, setReload] = useState({ n: 0, fresh: false });
  const key = `${network}:${slug}`;

  useEffect(() => {
    const ctrl = new AbortController();
    const query = `network=${network}${reload.fresh ? "&fresh=1" : ""}`;
    // `no-store`: a refetch that the browser answers from its own HTTP cache is not a refresh.
    fetch(`${marketApiPath(slug)}?${query}`, { signal: ctrl.signal, cache: "no-store" })
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
  }, [network, slug, reload]);

  const refresh = useCallback((fresh = false) => {
    setReload((r) => ({ n: r.n + 1, fresh }));
  }, []);

  const applyPools = useCallback((update: PoolUpdate) => {
    setData((prev) => {
      if (!prev?.market) return prev;
      return {
        ...prev,
        market: {
          ...prev.market,
          totalStakedMotes: update.totalStakedMotes ?? prev.market.totalStakedMotes,
          poolByOutcomeMotes: update.poolByOutcomeMotes ?? prev.market.poolByOutcomeMotes,
        },
      };
    });
  }, []);

  const loading = data === null || data.key !== key;
  return {
    market: loading ? null : data!.market,
    loading,
    error: loading ? null : data!.error,
    refresh,
    applyPools,
  };
}
