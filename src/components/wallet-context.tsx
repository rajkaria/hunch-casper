"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import {
  DEMO_ACCOUNT,
  activeConnector,
  type SendTransactionOutcome,
  type WalletConnector,
} from "@/lib/wallet-connector";

/**
 * The connected human wallet, shared across the app via a tiny SSR-safe external store — the same
 * pattern as `network-context`.
 *
 * The account's *source* is a connector (`lib/wallet-connector.ts`): CSPR.click when its bundle is
 * loaded and an app id is configured, and a deterministic, clearly-labelled demo account
 * otherwise, so the betting flow works offline and in CI with zero credentials. This module owns
 * only storage and observation, and neither shape changes between the two — which is why enabling
 * a real wallet touches no caller.
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
 * Where an account comes from lives in `lib/wallet-connector.ts`; this module owns only how it is
 * stored and observed. CSPR.click is used when it is loaded and configured, and the demo account
 * otherwise — the store's shape is identical either way, so no caller can tell the difference.
 */

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
  /** Which connector is live — `"csprclick"` when a real wallet can sign, `"demo"` otherwise. */
  connectorId: WalletConnector["id"];
  /**
   * Why the last connect attempt did not produce an account — `null` after a success, and `null`
   * for a plain cancellation, which needs no explanation. Set for the case that does: a browser
   * with no wallet in it at all, where the button otherwise looked broken.
   */
  connectError: string | null;
  /**
   * Sign and submit a prepared transaction with the connected wallet, or `null` when this
   * connector has no key of its own (the demo account). `null` is the caller's signal to use the
   * operator-signed route — it is a capability answer, not a failure.
   */
  signAndSend:
    | ((transactionJson: string, publicKey: string) => Promise<SendTransactionOutcome>)
    | null;
}

export function useWallet(): WalletContextValue {
  const account = useSyncExternalStore(subscribe, readWallet, serverSnapshot);
  const [connectError, setConnectError] = useState<string | null>(null);
  const connect = useCallback(() => {
    const connector = activeConnector();
    void connector.connect().then((outcome) => {
      if (outcome.ok) {
        setConnectError(null);
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(outcome.account));
        emit();
        return;
      }
      // A cancelled connect is the visitor's own decision, freshly made. Telling them about it
      // reads as an error message for having changed their mind.
      setConnectError(outcome.reason === "cancelled" ? null : outcome.message);
    });
  }, []);
  const disconnect = useCallback(() => {
    // Clear locally first: the session must end even if the SDK's own disconnect fails.
    window.localStorage.removeItem(STORAGE_KEY);
    setConnectError(null);
    emit();
    void activeConnector().disconnect();
  }, []);
  const connector = typeof window === "undefined" ? null : activeConnector();
  const send = connector?.sendTransaction;
  return {
    account,
    connected: account !== null,
    connect,
    disconnect,
    connectorId: connector?.id ?? "demo",
    connectError,
    signAndSend: send ? (json, publicKey) => send.call(connector, json, publicKey) : null,
  };
}

/** Truncate a public key for display: `01demo…0000`. */
export function shortKey(publicKey: string): string {
  return publicKey.length > 12 ? `${publicKey.slice(0, 6)}…${publicKey.slice(-4)}` : publicKey;
}

/**
 * Whether an account is the demo placeholder, so the UI can label it honestly. A real CSPR.click
 * account returns false and the `demo` pill retires — which is the entire point of the S18 flip:
 * the pill disappears because the wallet became real, not because someone removed the pill.
 */
export function isDemoAccount(account: WalletAccount | null): boolean {
  return account?.publicKey === DEMO_ACCOUNT.publicKey;
}
