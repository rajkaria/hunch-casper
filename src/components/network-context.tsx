"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { CasperNetwork } from "@/config/network";
import { DEFAULT_NETWORK, isCasperNetwork } from "@/config/network";

/**
 * The selected Casper network, persisted in localStorage and shared across the app via a tiny
 * external store. `useSyncExternalStore` is the SSR-safe way to read mutable browser state: the
 * server snapshot is the default network, the client snapshot reads localStorage, and React
 * reconciles the two on hydration without a mismatch — and without a setState-in-effect.
 */

const STORAGE_KEY = "hunch-casper.network";
const listeners = new Set<() => void>();

function readNetwork(): CasperNetwork {
  if (typeof window === "undefined") return DEFAULT_NETWORK;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return isCasperNetwork(stored) ? stored : DEFAULT_NETWORK;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

function serverSnapshot(): CasperNetwork {
  return DEFAULT_NETWORK;
}

export interface NetworkContextValue {
  network: CasperNetwork;
  setNetwork: (n: CasperNetwork) => void;
}

export function useNetwork(): NetworkContextValue {
  const network = useSyncExternalStore(subscribe, readNetwork, serverSnapshot);
  const setNetwork = useCallback((n: CasperNetwork) => {
    window.localStorage.setItem(STORAGE_KEY, n);
    for (const l of listeners) l();
  }, []);
  return { network, setNetwork };
}
