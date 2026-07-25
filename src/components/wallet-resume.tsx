"use client";

import { useEffect } from "react";
import { useWallet } from "@/components/wallet-context";
import {
  isClickConnectReturn,
  whenCsprClickReady,
  withoutClickConnect,
} from "@/lib/wallet-connector";

/**
 * The return leg of the Casper Wallet handoff.
 *
 * When CSPR.click decides a visitor has no wallet in this browser, it sends them to Casper
 * Wallet's in-app browser with `?click=connect` appended to the URL it wants them back on. That
 * marker is a request: *resume the connect you were asked for*. Nothing in this app ever read it,
 * so the round trip ended on a page that still said "Connect wallet" — the visitor arrived back
 * with a wallet in hand and had to press the button a second time to find that out.
 *
 * Mounted once, next to the SDK loader. Renders nothing.
 */
export function WalletResume() {
  const { connected, connect } = useWallet();

  useEffect(() => {
    if (connected) return;
    if (!isClickConnectReturn(window.location.href)) return;
    // Strip the marker first and unconditionally: a reload must not replay the handshake, and
    // neither must a second render if the connect below is declined.
    window.history.replaceState(null, "", withoutClickConnect(window.location.href));
    // The SDK script is `afterInteractive`, so it is usually not there yet. Connecting before it
    // loads would resolve `activeConnector()` to the demo wallet and sign the visitor in as the
    // placeholder — the one outcome worse than not resuming.
    void whenCsprClickReady().then((ready) => {
      if (ready) connect();
    });
  }, [connected, connect]);

  return null;
}
