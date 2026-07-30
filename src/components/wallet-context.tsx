"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DEMO_ACCOUNT,
  activeConnector,
  casperWalletInjected,
  connectorForConnectAttempt,
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

/**
 * The in-memory session for browsers where localStorage is blocked (lockdown modes, sandboxed
 * iframes, some in-app browsers). There, `getItem` THROWS — and it used to throw from inside
 * getSnapshot, i.e. from inside render — and `setItem` threw out of the connect `.then`, leaving
 * the dialog stuck on "connecting" forever. Storage failure now costs only durability: the
 * session lives here, works for the whole visit, and honestly does not survive a reload.
 */
let memoryAccount: WalletAccount | null = null;

export function readWallet(): WalletAccount | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return memoryAccount; // blocked storage — the in-memory session is all there is
  }
  // No stored session: the in-memory one still counts (it is set when a WRITE failed, which a
  // working read cannot see). `memoryAccount` is a stable reference, so the snapshot contract holds.
  if (raw === null) return memoryAccount;
  if (raw === cachedRaw) return cachedAccount;
  cachedRaw = raw;
  try {
    const parsed = JSON.parse(raw) as WalletAccount;
    cachedAccount = parsed?.publicKey ? parsed : null;
  } catch {
    cachedAccount = null;
  }
  return cachedAccount;
}

/**
 * Persist an account change (or a disconnect, as `null`). The write is best-effort on purpose:
 * blocked storage may cost the session its durability, but it must never cost the state
 * transition — the connect dialog closing, the header flipping — that the caller is mid-way
 * through. `readWallet` serves the in-memory copy whenever storage cannot.
 */
function persistAccount(account: WalletAccount | null): void {
  memoryAccount = account;
  try {
    if (account === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(account));
  } catch {
    /* durability lost, session kept — see memoryAccount */
  }
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

/**
 * The active connector's id as a subscribed snapshot — primitive, so it is referentially stable
 * for `useSyncExternalStore`, and SUBSCRIBED so its changes actually re-render.
 *
 * This is what lets `signAndSend` flip from `null` without user interaction: the SDK bundle
 * finishing its load changes `activeConnector()`'s answer, but nothing re-rendered wallet
 * consumers when it did — a visitor who connected early kept the operator-escrow footnote (and a
 * null signer) until they touched something. `notifyCsprClickArrived` below is the emit that
 * makes this snapshot move.
 */
function readConnectorId(): WalletConnector["id"] {
  return typeof window === "undefined" ? "demo" : activeConnector().id;
}

function serverConnectorId(): WalletConnector["id"] {
  return "demo";
}

/**
 * Announce that the CSPR.click SDK finished loading. Called by the always-mounted watcher in
 * `wallet-resume`; the emit wakes `useSyncExternalStore`, the `connectorId` snapshot flips from
 * "demo" to "csprclick", and every consumer re-derives `signAndSend` from the real connector.
 */
export function notifyCsprClickArrived(): void {
  emit();
}

/**
 * Apply an account change the SDK announced on its own event channel — connected, unlocked,
 * activeKeyChanged, disconnected (as `null`). This is the store side of the always-mounted
 * subscription in `wallet-resume`: without it, a key switched or revoked in the wallet extension
 * left the store — and every "Betting as …" line — stale until a reload.
 */
export function applyExternalWalletAccount(account: WalletAccount | null): void {
  persistAccount(account);
  emit();
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
  // Subscribed — not merely derived at render — so the SDK bundle finishing its load (announced
  // by `notifyCsprClickArrived`) re-renders every consumer and `signAndSend` below flips from
  // null without anyone clicking anything.
  const connectorId = useSyncExternalStore(subscribe, readConnectorId, serverConnectorId);

  const connect = useCallback(() => {
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;
    setConnectState({ phase: "connecting" });

    // `connectorForConnectAttempt`, not `activeConnector()`: a click that lands before the 1.4MB
    // CSPR.click bundle has loaded must WAIT for it (under this same "connecting" phase) rather
    // than silently resolve the demo connector on a fully configured deploy. Demo is still the
    // answer when nothing is configured, the app id is known-rejected, or the wait times out.
    void connectorForConnectAttempt()
      .then((connector) => {
        if (controller.signal.aborted) return null; // the visitor closed the dialog mid-wait
        return connector.connect({
          signal: controller.signal,
          onPairing: (uri) => {
            if (!controller.signal.aborted) setConnectState({ phase: "pairing", uri });
          },
          onAccounts: (accounts, choose) => {
            if (!controller.signal.aborted) setConnectState({ phase: "choosing", accounts, choose });
          },
        });
      })
      .then((outcome) => {
        if (outcome === null) return; // cancelled while waiting for the SDK — state already reset
        if (inFlight !== controller) return; // superseded by a newer attempt
        inFlight = null;
        if (outcome.ok) {
          // Best-effort persistence: blocked storage must not strand the dialog on "connecting".
          persistAccount(outcome.account);
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
    // Clear locally first: the session must end even if the SDK's own disconnect fails — and even
    // if storage is blocked (persistAccount clears the in-memory session regardless).
    persistAccount(null);
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
    connectorId,
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
