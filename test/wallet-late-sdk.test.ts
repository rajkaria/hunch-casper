/**
 * The late SDK.
 *
 * CSPR.click loads `afterInteractive`, so `window.csprclick` does not exist when the first
 * component renders: the connector resolves to `demo`, and `signAndSend` with it. Two separate
 * mechanisms have to hold for a connected wallet to recover from that without a reload —
 *
 *  1. the emit (`notifyCsprClickArrived`, fired by the watcher in `wallet-resume`), so consumers
 *     re-render at all, and
 *  2. a connector *derived from the snapshot*, because this app builds with `reactCompiler: true`
 *     and a render-time `activeConnector()` call has no reactive input for the compiler to
 *     invalidate on. With (1) alone the re-render handed back a `signAndSend` out of a memo slot
 *     filled before the SDK existed — which is how prod told a connected visitor to "Connect a
 *     Casper wallet" over a disabled Create button while the SDK sat loaded and healthy.
 *
 * (2) cannot be asserted from here — it lives in the compiled output — so what this file pins is
 * the contract that makes it possible: the connector id is a *live* read, and an emit reaches
 * every subscriber.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  notifyCsprClickArrived,
  readConnectorId,
  subscribe,
} from "@/components/wallet-context";
import {
  __resetCsprClickAppIdRejection,
  markCsprClickAppIdRejected,
  type CsprClickLike,
} from "@/lib/wallet-connector";

type FakeWindow = {
  csprclick?: CsprClickLike;
  __CSPR_CLICK_APP_ID__?: string;
  localStorage: { getItem: () => string | null };
  addEventListener: () => void;
  removeEventListener: () => void;
};

function installWindow(): FakeWindow {
  const w: FakeWindow = {
    __CSPR_CLICK_APP_ID__: "app-123",
    localStorage: { getItem: () => null },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as unknown as { window: FakeWindow }).window = w;
  return w;
}

/** The SDK object the bundle installs — only its presence matters to `available()`. */
function sdk(): CsprClickLike {
  return {} as CsprClickLike;
}

beforeEach(() => {
  __resetCsprClickAppIdRejection();
});

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("the connector id snapshot", () => {
  it("is `demo` before the SDK lands and `csprclick` after — read live, never cached", () => {
    const w = installWindow();
    expect(readConnectorId()).toBe("demo");
    w.csprclick = sdk();
    // Same page, same call. An answer frozen at first render is the production bug.
    expect(readConnectorId()).toBe("csprclick");
  });

  it("goes back to `demo` when CSPR.click rejects the app id", () => {
    const w = installWindow();
    w.csprclick = sdk();
    expect(readConnectorId()).toBe("csprclick");
    markCsprClickAppIdRejected("wrong application id");
    // The demotion direction matters too: a half-initialised SDK cannot sign, and the labelled
    // demo fallback is the honest answer.
    expect(readConnectorId()).toBe("demo");
  });

  it("is `demo` off-browser, so SSR never claims a signing wallet", () => {
    expect(readConnectorId()).toBe("demo");
  });
});

describe("notifyCsprClickArrived", () => {
  it("wakes every subscriber, and the next read sees the loaded SDK", () => {
    const w = installWindow();
    let woken = 0;
    const stop = subscribe(() => {
      woken += 1;
    });

    w.csprclick = sdk(); // the bundle lands a few hundred ms into the page's life
    notifyCsprClickArrived();

    expect(woken).toBe(1);
    expect(readConnectorId()).toBe("csprclick");
    stop();
  });

  it("reaches no one after unsubscribe", () => {
    installWindow();
    let woken = 0;
    subscribe(() => {
      woken += 1;
    })();
    notifyCsprClickArrived();
    expect(woken).toBe(0);
  });
});
