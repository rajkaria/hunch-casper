"use client";

import { useEffect } from "react";
import {
  applyExternalWalletAccount,
  isDemoAccount,
  notifyCsprClickArrived,
  readWallet,
  runCsprClickAppIdProbe,
  useWallet,
} from "@/components/wallet-context";
import {
  isClickConnectReturn,
  subscribeToCsprClick,
  whenCsprClickReady,
  withoutClickConnect,
} from "@/lib/wallet-connector";

/**
 * The return leg of the Casper Wallet handoff — and the app's one always-mounted wallet watcher.
 *
 * When CSPR.click decides a visitor has no wallet in this browser, it sends them to Casper
 * Wallet's in-app browser with `?click=connect` appended to the URL it wants them back on. That
 * marker is a request: *resume the connect you were asked for*. Nothing in this app ever read it,
 * so the round trip ended on a page that still said "Connect wallet" — the visitor arrived back
 * with a wallet in hand and had to press the button a second time to find that out.
 *
 * Mounted once, next to the SDK loader. Renders nothing.
 */

/**
 * How long the watchers here wait for the SDK bundle. Deliberately much longer than the default
 * 4s: the resume leg mostly runs inside mobile in-app browsers, where fetching the 1.4MB bundle
 * regularly takes longer — and by the time this effect runs, the `?click=connect` marker has
 * already been stripped from the URL, so a resume that gives up early is not retried on reload.
 * It is simply lost, which is worse than a spinner-free 15-second wait that usually ends sooner.
 */
const SDK_WAIT_TIMEOUT_MS = 15_000;

export function WalletResume() {
  const { connected, connect } = useWallet();

  // Also the one always-mounted client component next to the SDK loader, which makes it the
  // right place to ask CSPR.click whether the configured app id exists at all. The SDK asks the
  // same question and dies silently on a "no" (see wallet-connector.ts); this probe is what turns
  // that silence into a visible demo-wallet fallback and a reason in the bet panel.
  useEffect(() => {
    runCsprClickAppIdProbe();
  }, []);

  // The persistent CSPR.click subscription. The SDK announces connects, unlocks, account switches
  // and disconnects as window events; until this listener existed those events were only read
  // during a connect attempt, so a key switched (or revoked) in the wallet extension left the
  // store — and every "Betting as …" line — stale until a reload.
  useEffect(() => {
    return subscribeToCsprClick((signal) => {
      if (signal.kind === "connected") {
        const current = readWallet();
        if (current?.publicKey !== signal.account.publicKey) {
          applyExternalWalletAccount(signal.account);
        }
      } else if (signal.kind === "disconnected") {
        // The demo session has no SDK backing, so no SDK event may end it.
        const current = readWallet();
        if (current !== null && !isDemoAccount(current)) applyExternalWalletAccount(null);
      }
    });
  }, []);

  // Announce the SDK's arrival to the store. `signAndSend` is derived from the active connector
  // at render, and NOTHING else re-renders wallet consumers when the bundle finishes loading —
  // so a visitor with a resumed session kept a null signer (and the "escrowed by the operator"
  // footnote) until they interacted. One emit fixes all of them at once.
  useEffect(() => {
    let live = true;
    void whenCsprClickReady({ timeoutMs: SDK_WAIT_TIMEOUT_MS }).then((ready) => {
      if (live && ready) notifyCsprClickArrived();
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (connected) return;
    if (!isClickConnectReturn(window.location.href)) return;
    // Strip the marker first and unconditionally: a reload must not replay the handshake, and
    // neither must a second render if the connect below is declined.
    window.history.replaceState(null, "", withoutClickConnect(window.location.href));
    // The SDK script is `afterInteractive`, so it is usually not there yet. Connecting before it
    // loads would resolve `activeConnector()` to the demo wallet and sign the visitor in as the
    // placeholder — the one outcome worse than not resuming. The long window matters here: see
    // SDK_WAIT_TIMEOUT_MS.
    void whenCsprClickReady({ timeoutMs: SDK_WAIT_TIMEOUT_MS }).then((ready: boolean) => {
      if (ready) connect();
    });
  }, [connected, connect]);

  return null;
}
