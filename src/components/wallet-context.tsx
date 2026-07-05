"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * The connected human wallet, shared across the app via a tiny SSR-safe external store — the
 * same pattern as `network-context`. The demo build ships a **mock CSPR.click** adapter:
 * `connect()` resolves a deterministic demo account so the betting flow works offline and in
 * CI with zero credentials. The real integration swaps `connect()` for the CSPR.click AI Agent
 * Skill (`@make-software/csprclick-*`), which returns the user's actual public key and signs
 * transactions — the port shape (`account` / `connect` / `disconnect`) stays identical, so no
 * caller changes. That is the mock-first, one-composition-root discipline applied to the wallet.
 */

export interface WalletAccount {
  /** Casper public key (hex). Demo builds use a fixed, clearly-labelled placeholder. */
  publicKey: string;
  /** Short human label for the header chip. */
  label: string;
}

const STORAGE_KEY = "hunch-casper.wallet";
const listeners = new Set<() => void>();

/**
 * A deterministic, obviously-fake demo account. It is NOT a real fundable key — the demo bets
 * settle through the mock chain adapter (pseudo hashes). Real CSPR.click returns a live key here.
 */
const DEMO_ACCOUNT: WalletAccount = {
  publicKey: "01demo0000000000000000000000000000000000000000000000000000000000",
  label: "Demo wallet",
};

// `useSyncExternalStore` requires getSnapshot to return a referentially-STABLE value while the
// underlying data is unchanged (it calls getSnapshot twice per render and Object.is-compares).
// JSON.parse would mint a new object every call → an infinite re-render loop the moment a wallet
// is connected. So we memoize the parsed account against the raw localStorage string and only
// produce a new reference when that string actually changes — the same primitive-stability that
// `readNetwork` gets for free by returning a string.
let cachedRaw: string | null = null;
let cachedAccount: WalletAccount | null = null;

export function readWallet(): WalletAccount | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === cachedRaw) return cachedAccount;
  cachedRaw = raw;
  if (!raw) {
    cachedAccount = null;
    return cachedAccount;
  }
  try {
    const parsed = JSON.parse(raw) as WalletAccount;
    cachedAccount = parsed?.publicKey ? parsed : null;
  } catch {
    cachedAccount = null;
  }
  return cachedAccount;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}

function emit(): void {
  for (const l of listeners) l();
}

function serverSnapshot(): WalletAccount | null {
  return null;
}

export interface WalletContextValue {
  account: WalletAccount | null;
  connected: boolean;
  connect: () => void;
  disconnect: () => void;
}

export function useWallet(): WalletContextValue {
  const account = useSyncExternalStore(subscribe, readWallet, serverSnapshot);
  const connect = useCallback(() => {
    // Mock CSPR.click: resolve the demo account. Real adapter returns the signed-in key.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(DEMO_ACCOUNT));
    emit();
  }, []);
  const disconnect = useCallback(() => {
    window.localStorage.removeItem(STORAGE_KEY);
    emit();
  }, []);
  return { account, connected: account !== null, connect, disconnect };
}

/** Truncate a public key for display: `01demo…0000`. */
export function shortKey(publicKey: string): string {
  return publicKey.length > 12 ? `${publicKey.slice(0, 6)}…${publicKey.slice(-4)}` : publicKey;
}

/** Whether an account is the mock CSPR.click demo account (so the UI can label it honestly). */
export function isDemoAccount(account: WalletAccount | null): boolean {
  return account?.publicKey === DEMO_ACCOUNT.publicKey;
}
