"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DEMO_ACCOUNT,
  activeConnector,
  casperWalletInjected,
  csprClickAppIdRejection,
  probeCsprClickAppId,
  type SendTransactionOutcome,
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
 * A connect is neither instantaneous nor, on the WalletConnect route, even on this device: the SDK
 * hands back a pairing URI and waits for a phone. Without a state to render, the button looks
 * inert for as long as that takes — which is the failure this store exists to make impossible.
 * Every ending has a phase, and the error phase is never silent.
 *
 * It lives outside the hook, next to the account store, because the header renders the button
 * twice and a market page renders a third entry point: they are all one attempt.
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

/**
 * Run the app-id probe once and, if it demotes the connector, wake every subscriber.
 *
 * The probe itself lives in the connector (`probeCsprClickAppId`); what belongs here is the emit.
 * `useWallet()` reads through `useSyncExternalStore`, which only re-renders when a snapshot
 * changes — so when the probe flips `available()` under a component that already rendered
 * "Casper Wallet", something must announce it. The rejection string is that snapshot: primitive,
 * referentially stable, `null` until the moment there is something to say.
 */
let probeStarted = false;

export function runCsprClickAppIdProbe(): void {
  if (probeStarted) return;
  probeStarted = true;
  void probeCsprClickAppId().then((rejection) => {
    if (rejection !== null) emit();
  });
}

function serverRejectionSnapshot(): string | null {
  return null;
}

export interface WalletContextValue {
  account: WalletAccount | null;
  connected: boolean;
  connect: () => void;
  disconnect: () => void;
  /** Which connector is live — `"csprclick"` when a real wallet can sign, `"demo"` otherwise. */
  connectorId: WalletConnector["id"];
  /** Where an attempt has got to, so the UI can show a QR, an account picker, or an error. */
  connectState: WalletConnectState;
  /** Abandon an in-flight attempt (the visitor closed the dialog), or clear an error. */
  cancelConnect: () => void;
  /**
   * Why the last connect attempt did not produce an account — `null` after a success, and `null`
   * for a plain cancellation, which needs no explanation. Set for the case that does: a browser
   * with no wallet in it at all, where the button otherwise looked broken. The same fact as the
   * `error` phase above, kept as a string for callers that only want the inline line.
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
  /**
   * Why real signing is off when the deployment *looks* configured — CSPR.click rejected the app
   * id — or `null`. Distinct from `connectError`: nobody clicked anything, the deployment itself
   * is misconfigured, and the panel should say so rather than quietly hand out the demo account.
   */
  signingDisabledReason: string | null;
}

export function useWallet(): WalletContextValue {
  const account = useSyncExternalStore(subscribe, readWallet, serverSnapshot);
  const connectState = useSyncExternalStore(subscribe, readConnectState, idleConnectState);
  // Subscribed like the rest so the probe's emit reaches every caller: connectorId and
  // signAndSend below are derived from activeConnector(), whose answer this value changes.
  const signingDisabledReason = useSyncExternalStore(
    subscribe,
    csprClickAppIdRejection,
    serverRejectionSnapshot,
  );

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
        if (outcome.ok) {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(outcome.account));
          setConnectState(IDLE);
          return;
        }
        // A cancelled connect is the visitor's own decision, freshly made. Telling them about it
        // reads as an error message for having changed their mind.
        if (outcome.reason === "cancelled") {
          setConnectState(IDLE);
          return;
        }
        setConnectState({
          phase: "error",
          message: outcome.message,
          // The one failure with something to do about it.
          canInstall: outcome.reason === "no-wallet",
        });
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
    connectState,
    cancelConnect,
    connectError: connectState.phase === "error" ? connectState.message : null,
    signAndSend: send ? (json, publicKey) => send.call(connector, json, publicKey) : null,
    signingDisabledReason,
  };
}

/**
 * Whether a wallet the visitor has *locally* could sign — the extension in `window`, not
 * `isProviderPresent`. False means the only route left is pairing a phone over WalletConnect,
 * which the pairing dialog says out loud rather than leaving someone to work out from a QR.
 */
export function localWalletAvailable(): boolean {
  return casperWalletInjected();
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
