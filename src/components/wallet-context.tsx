"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DEMO_ACCOUNT,
  activeConnector,
  csprClickConnector,
  hasInstalledWallet,
  type WalletAccountLike,
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

/**
 * What a connection attempt is doing right now.
 *
 * This exists because "connecting" is not instantaneous and, on the WalletConnect route, is not even
 * on this device: the SDK hands back a pairing URI and waits for a phone. Without a state to render,
 * the Connect button appears to do nothing — the exact failure this store now makes impossible,
 * since every ending has a state and `error` is never silent.
 */
export type WalletConnectState =
  | { phase: "idle" }
  | { phase: "connecting" }
  /** Waiting on another device: show `uri` as a QR, with a way out. */
  | { phase: "pairing"; uri: string }
  /** The paired wallet shared more than one account and someone has to pick. */
  | { phase: "choosing"; accounts: WalletAccountLike[]; choose: (index: number) => void }
  | { phase: "error"; message: string; canInstall: boolean };

const IDLE: WalletConnectState = { phase: "idle" };
let connectState: WalletConnectState = IDLE;
let inFlight: AbortController | null = null;

function setConnectState(next: WalletConnectState): void {
  connectState = next;
  emit();
}

function readConnectState(): WalletConnectState {
  return connectState;
}

function idleConnectState(): WalletConnectState {
  return IDLE;
}

export interface WalletContextValue {
  account: WalletAccount | null;
  connected: boolean;
  connect: () => void;
  disconnect: () => void;
  /** Where a connection attempt has got to, so the UI can show a QR, a picker, or an error. */
  connectState: WalletConnectState;
  /** Abandon an in-flight attempt (the visitor closed the pairing dialog), or clear an error. */
  cancelConnect: () => void;
  /** Which connector is live — `"csprclick"` when a real wallet can sign, `"demo"` otherwise. */
  connectorId: WalletConnector["id"];
}

export function useWallet(): WalletContextValue {
  const account = useSyncExternalStore(subscribe, readWallet, serverSnapshot);
  const connectState = useSyncExternalStore(subscribe, readConnectState, idleConnectState);

  const connect = useCallback(() => {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    setConnectState({ phase: "connecting" });

    void activeConnector()
      .connect({
        signal: controller.signal,
        onPairing: (uri) => {
          if (!controller.signal.aborted) setConnectState({ phase: "pairing", uri });
        },
        onAccounts: (accounts, choose) => {
          if (!controller.signal.aborted) setConnectState({ phase: "choosing", accounts, choose });
        },
      })
      .then((outcome) => {
        if (inFlight !== controller) return; // superseded by a newer attempt
        inFlight = null;
        switch (outcome.kind) {
          case "connected":
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(outcome.account));
            setConnectState(IDLE);
            return;
          case "cancelled":
            setConnectState(IDLE);
            return;
          case "no-wallet":
            // The honest dead end: no extension, and nothing answered the pairing request. Say so,
            // and offer the one thing that fixes it.
            setConnectState({ phase: "error", message: outcome.reason, canInstall: true });
            return;
          case "failed":
            setConnectState({ phase: "error", message: outcome.reason, canInstall: false });
        }
      });
  }, []);

  const cancelConnect = useCallback(() => {
    inFlight?.abort();
    inFlight = null;
    setConnectState(IDLE);
  }, []);

  const disconnect = useCallback(() => {
    // Clear locally first: the session must end even if the SDK's own disconnect fails.
    window.localStorage.removeItem(STORAGE_KEY);
    inFlight?.abort();
    inFlight = null;
    setConnectState(IDLE);
    void activeConnector().disconnect();
  }, []);

  return {
    account,
    connected: account !== null,
    connect,
    disconnect,
    connectState,
    cancelConnect,
    connectorId: typeof window === "undefined" ? "demo" : activeConnector().id,
  };
}

/**
 * Whether a wallet the visitor has *locally* could sign — an extension or a snap. False means the
 * only route left is pairing a phone over WalletConnect, which is worth saying out loud rather than
 * discovering by staring at a QR nobody can scan.
 */
export function localWalletAvailable(): boolean {
  if (typeof window === "undefined" || !window.csprclick) return false;
  return csprClickConnector.available() && hasInstalledWallet(window.csprclick);
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
