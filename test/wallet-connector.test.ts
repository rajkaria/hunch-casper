/**
 * The wallet connector seam.
 *
 * The behaviour worth pinning: the app falls back to the labelled demo account unless CSPR.click
 * is BOTH loaded and configured. An app id with no SDK, or an SDK with no app id, cannot complete
 * a sign-in — and a Connect button that does nothing is worse than one that honestly connects a
 * demo account, because the second at least says what it is.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  CSPR_CLICK_DOM_EVENT,
  CSPR_CLICK_STATUS,
  DEMO_ACCOUNT,
  PROVIDER_STATUS_UPDATE,
  accountAfterConnect,
  accountFromCsprClick,
  activeConnector,
  casperWalletAccount,
  casperWalletInjected,
  csprClickAppId,
  csprClickConnector,
  demoConnector,
  disarmInAppBrowserRedirect,
  detectWalletTransport,
  casperWalletPairingDeepLink,
  isClickConnectReturn,
  parseCsprClickEvent,
  providerNeedsPairing,
  subscribeToCsprClick,
  whenCsprClickReady,
  withoutClickConnect,
  type CasperWalletProviderLike,
  type CsprClickLike,
} from "@/lib/wallet-connector";
import { GET as boardsGET } from "@/app/api/boards/route";

type FakeWindow = {
  csprclick?: CsprClickLike;
  CasperWalletProvider?: () => CasperWalletProviderLike;
};

function fakeWindow(): FakeWindow {
  (globalThis as unknown as { window?: unknown }).window ??= {};
  return (globalThis as unknown as { window: FakeWindow }).window;
}

function installSdk(sdk: CsprClickLike | undefined): void {
  fakeWindow().csprclick = sdk;
}

/** Stand in for the browser extension, which injects exactly this factory. */
function installExtension(provider: CasperWalletProviderLike = {}): void {
  fakeWindow().CasperWalletProvider = () => provider;
}

/** A stand-in for the `window` CSPR.click dispatches its events on. */
function eventBus() {
  const target = new EventTarget();
  return {
    target,
    /** Dispatch what the SDK dispatches: a `csprclick` CustomEvent carrying `detail`. */
    emit(detail: unknown) {
      target.dispatchEvent(new CustomEvent(CSPR_CLICK_DOM_EVENT, { detail }));
    },
    /** The provider-status shape, which is where the WalletConnect flow lives. */
    status(custom: unknown, provider = "walletconnect") {
      this.emit({ provider, providerEvent: PROVIDER_STATUS_UPDATE, custom });
    },
  };
}

/** No real timers in the settle loops — every wait is injected. */
const noWait = async (): Promise<void> => {};

/** WalletConnect's usability is a UA question, so the UA has to be stubbable. */
function stubUserAgent(userAgent: string): void {
  vi.stubGlobal("navigator", { userAgent, maxTouchPoints: 0 });
}

// These flows exercise the wallet as a *fully configured* deployment, WalletConnect included —
// the pairing route is only offered when a WalletConnect Cloud project id is set (the SDK's
// provider constructor throws without one; see `walletConnectConfigured`). The unconfigured
// posture has its own tests in csprclick-appid.test.ts.
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID", "wc-project-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  const w = (globalThis as unknown as { window?: FakeWindow }).window;
  if (w) {
    delete w.csprclick;
    delete w.CasperWalletProvider;
  }
});

describe("accountFromCsprClick", () => {
  it("reads both the snake_case and camelCase key fields the SDK has used", () => {
    // A wallet that silently fails to connect because a field was renamed is a bad afternoon.
    expect(accountFromCsprClick({ public_key: "01aa", name: "Alice" })).toEqual({
      publicKey: "01aa",
      label: "Alice",
    });
    expect(accountFromCsprClick({ publicKey: "01bb" })).toEqual({ publicKey: "01bb", label: "CSPR.click" });
  });

  it("rejects anything without a usable key", () => {
    for (const junk of [null, undefined, 42, {}, { public_key: "" }, { public_key: 7 }]) {
      expect(accountFromCsprClick(junk)).toBeNull();
    }
  });
});

describe("connector selection", () => {
  it("falls back to the demo connector when no SDK is present", () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    expect(csprClickConnector.available()).toBe(false);
    expect(activeConnector().id).toBe("demo");
  });

  it("falls back when the SDK is present but no app id is configured", () => {
    installSdk({ signIn: async () => ({ public_key: "01aa" }) });
    expect(csprClickConnector.available()).toBe(false);
    expect(activeConnector().id).toBe("demo");
  });

  it("uses CSPR.click only when both the SDK and an app id are present", () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({ signIn: async () => ({ public_key: "01aa", name: "Alice" }) });
    expect(csprClickAppId()).toBe("app-123");
    expect(activeConnector().id).toBe("csprclick");
  });
});

describe("connecting", () => {
  it("the demo connector resolves the labelled placeholder", async () => {
    const outcome = await demoConnector.connect();
    expect(outcome).toEqual({ ok: true, account: DEMO_ACCOUNT });
    // Obviously fake on sight: a plausible-looking fake key would be strictly worse.
    expect(DEMO_ACCOUNT.publicKey).toContain("demo");
  });

  it("returns the signed-in account from CSPR.click", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({ signIn: async () => ({ public_key: "01aa", name: "Alice" }) });
    expect(await csprClickConnector.connect()).toEqual({
      ok: true,
      account: { publicKey: "01aa", label: "Alice" },
    });
  });

  it("falls back to getActiveAccount for SDK versions whose signIn resolves nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({ signIn: async () => undefined, getActiveAccount: () => ({ public_key: "01cc" }) });
    expect(await csprClickConnector.connect()).toEqual({
      ok: true,
      account: { publicKey: "01cc", label: "CSPR.click" },
    });
  });

  it("leaves the app disconnected — not broken — when a sign-in is cancelled", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({
      signIn: async () => {
        throw new Error("user cancelled");
      },
    });
    // The wallet was there and refused: a cancellation, not something to shout about.
    await expect(csprClickConnector.connect()).resolves.toMatchObject({
      ok: false,
      reason: "failed",
    });
  });

  it("prefers connect(provider) over signIn — signIn's hosted page is a 404", async () => {
    // `accounts.cspr.click/signin.html`, which popup mode opens, was deleted upstream; iframe mode
    // only emits an event for a React package this app does not ship. `connect(providerKey)` is
    // what CSPR.click's own picker calls, and it goes straight to the extension.
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    const calls: string[] = [];
    installSdk({
      isProviderPresent: (p: string) => p === "casper-wallet",
      connect: async (p: string) => {
        calls.push(p);
        return { public_key: "01dd", name: "Casper Wallet" };
      },
      signIn: async () => {
        calls.push("signIn");
        return null;
      },
    });
    expect(await csprClickConnector.connect()).toEqual({
      ok: true,
      account: { publicKey: "01dd", label: "Casper Wallet" },
    });
    expect(calls).toEqual(["casper-wallet"]);
  });

  it("skips providers that are not installed and connects the one that is", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    // WalletConnect is last in the order and reached only when nothing local answered. It is a
    // real transport on every device now that the pairing dialog exists — see the pairing tests
    // below for the route it takes when `connect()` hands back no account.
    stubUserAgent("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36");
    const calls: string[] = [];
    installSdk({
      // Unknown keys THROW in the real SDK rather than returning false.
      isProviderPresent: (p: string) => {
        if (p === "casper-wallet") return false;
        if (p === "metamask-snap") throw new Error("Unsupported wallet: " + p);
        return true;
      },
      connect: async (p: string) => {
        calls.push(p);
        return { public_key: "01ee" };
      },
      getActiveAccount: () => null,
    });
    expect(await csprClickConnector.connect()).toEqual({
      ok: true,
      account: { publicKey: "01ee", label: "WalletConnect" },
    });
    expect(calls).toEqual(["walletconnect"]);
  });

  it("falls back to signIn when no wallet transport is present at all", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({
      connect: async () => ({ public_key: "01ff" }),
      signIn: async () => ({ public_key: "01aa", name: "Alice" }),
    });
    expect(await csprClickConnector.connect()).toEqual({
      ok: true,
      account: { publicKey: "01aa", label: "Alice" },
    });
  });

  it("does not throw when the SDK's own disconnect fails", async () => {
    installSdk({
      disconnect: async () => {
        throw new Error("already gone");
      },
    });
    await expect(csprClickConnector.disconnect()).resolves.toBeUndefined();
  });
});

/**
 * The reported bug: Connect opened `casperwallet.io/download?browse=…%3Fclick%3Dconnect` in a new
 * tab instead of the installed extension. From the shipped SDK, `connect()` opens with
 * `if (this.shouldRedirectToInAppBrowser(e)) return`, and that guard fires on any touch-capable
 * user agent — before the provider is consulted, so an installed, unlocked, already-connected
 * wallet is redirected past all the same.
 */
describe("the in-app-browser redirect", () => {
  /** Faithful to upstream: the guard runs first, and a redirect swallows the connect. */
  function sdkWithRedirect(redirects: string[]): CsprClickLike {
    const sdk: CsprClickLike = {
      // The SDK's own `IsPresent` answers true here whether or not a wallet exists.
      isProviderPresent: () => true,
      shouldRedirectToInAppBrowser: (provider) => {
        if (provider !== "casper-wallet") return false;
        redirects.push(provider); // stands in for window.open(<download page>)
        return true;
      },
      connect: async (provider) => {
        if (sdk.shouldRedirectToInAppBrowser?.(provider)) return undefined;
        return { public_key: "01aa", name: "Casper Wallet" };
      },
      getActiveAccount: () => null,
    };
    return sdk;
  }

  it("is disarmed when the extension is actually injected, so Connect reaches the wallet", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    const redirects: string[] = [];
    installSdk(sdkWithRedirect(redirects));
    installExtension();

    expect(casperWalletInjected()).toBe(true);
    expect(await csprClickConnector.connect()).toEqual({
      ok: true,
      account: { publicKey: "01aa", label: "Casper Wallet" },
    });
    expect(redirects).toEqual([]); // no download tab
  });

  it("is left alone when no extension is injected — on a phone that handoff is the only route", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    const redirects: string[] = [];
    installSdk(sdkWithRedirect(redirects));

    expect(casperWalletInjected()).toBe(false);
    await expect(csprClickConnector.connect()).resolves.toMatchObject({ ok: false });
    expect(redirects).toEqual(["casper-wallet"]);
  });

  it("restores the SDK's own method afterwards, own-property or prototype", () => {
    // Upstream defines it on the prototype; shadowing it must not leave a permanent own-property
    // behind, or the mobile handoff would stay disarmed for every later call.
    class Sdk {
      shouldRedirectToInAppBrowser(): boolean {
        return true;
      }
    }
    const proto = new Sdk() as unknown as CsprClickLike;
    disarmInAppBrowserRedirect(proto)();
    expect(Object.prototype.hasOwnProperty.call(proto, "shouldRedirectToInAppBrowser")).toBe(false);
    expect(proto.shouldRedirectToInAppBrowser?.("casper-wallet")).toBe(true);

    const own: CsprClickLike = { shouldRedirectToInAppBrowser: () => true };
    disarmInAppBrowserRedirect(own)();
    expect(own.shouldRedirectToInAppBrowser?.("casper-wallet")).toBe(true);

    // An SDK version without the method at all is not a crash.
    expect(() => disarmInAppBrowserRedirect({})()).not.toThrow();
  });
});

describe("resolving the account after connect", () => {
  it("waits for the account the SDK publishes after connect() has already resolved", async () => {
    // The provider's already-connected branch is `getActivePublicKey().then(…)` — un-awaited — so
    // reading getActiveAccount on the next line is a race the app loses.
    let polls = 0;
    const sdk: CsprClickLike = {
      getActiveAccount: () => (++polls < 3 ? null : { public_key: "01bb", name: "Alice" }),
    };
    expect(await accountAfterConnect(sdk, "casper-wallet", undefined, { wait: noWait })).toEqual({
      publicKey: "01bb",
      label: "Alice",
    });
  });

  it("falls back to the extension's own active key when CSPR.click never catches up", async () => {
    installExtension({ getActivePublicKey: async () => "01cc" });
    const sdk: CsprClickLike = { getActiveAccount: () => null };
    expect(
      await accountAfterConnect(sdk, "casper-wallet", undefined, { attempts: 2, wait: noWait }),
    ).toEqual({ publicKey: "01cc", label: "Casper Wallet" });
  });

  it("treats a refusal as an answer instead of waiting two seconds for it", async () => {
    // `requestConnection()` resolves false when the popup is declined.
    let polls = 0;
    const sdk: CsprClickLike = {
      getActiveAccount: () => {
        polls += 1;
        return null;
      },
    };
    expect(await accountAfterConnect(sdk, "casper-wallet", false, { wait: noWait })).toBeNull();
    expect(polls).toBe(0);
  });

  it("reads nothing from an extension that is not connected to this site", async () => {
    installExtension({
      getActivePublicKey: async () => {
        throw new Error("not connected");
      },
    });
    await expect(casperWalletAccount()).resolves.toBeNull();
  });
});

describe("the ?click=connect return leg", () => {
  it("recognises the marker, including the malformed URL the SDK actually builds", () => {
    // Upstream builds `window.location.href + "?click=connect"` — a bare concatenation, so a page
    // that already had a query comes back with two `?` and searchParams cannot see the marker.
    expect(isClickConnectReturn("https://casper.playhunch.xyz/markets?click=connect")).toBe(true);
    expect(isClickConnectReturn("https://casper.playhunch.xyz/markets?tab=open?click=connect")).toBe(
      true,
    );
    expect(isClickConnectReturn("https://casper.playhunch.xyz/markets")).toBe(false);
    expect(isClickConnectReturn("https://casper.playhunch.xyz/markets?click=other")).toBe(false);
    expect(isClickConnectReturn("not a url")).toBe(false);
  });

  it("strips the marker so a reload does not replay the handshake", () => {
    expect(withoutClickConnect("https://x.dev/markets?click=connect")).toBe("/markets");
    expect(withoutClickConnect("https://x.dev/markets?tab=open?click=connect")).toBe(
      "/markets?tab=open",
    );
    expect(withoutClickConnect("https://x.dev/markets?tab=open&click=connect#bets")).toBe(
      "/markets?tab=open#bets",
    );
  });

  it("never resumes onto the demo wallet while the SDK script is still loading", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    // No `window.csprclick` yet — the loader is `afterInteractive`. Auto-connecting here would
    // sign the visitor in as the placeholder account, which is worse than not resuming.
    await expect(whenCsprClickReady({ attempts: 3, wait: noWait })).resolves.toBe(false);
    installSdk({ connect: async () => ({ public_key: "01dd" }) });
    await expect(whenCsprClickReady({ attempts: 3, wait: noWait })).resolves.toBe(true);
  });
});

/**
 * The other half of the dead Connect button: a browser with no extension in it.
 *
 * WalletConnect's `IsPresent()` in the SDK is `return !0` — always true — so it wins the provider
 * race for every desktop visitor without an extension, and its desktop branch only *emits* a
 * `ShowPairingQR` event, expecting the host app to draw the QR. For a while nothing here listened,
 * so nothing opened, nothing errored, nothing rendered; the app answered by refusing to select
 * WalletConnect on desktop at all, which was honest and still a dead end. Now the event is read
 * and the QR is drawn, so the transport is real everywhere — and "no wallet" means the SDK itself
 * reports nothing present, which is the only case that earns an install prompt.
 */
describe("when there is no extension in the browser", () => {
  const desktop = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126";
  const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126";

  it("routes a desktop visitor to WalletConnect pairing rather than to nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    stubUserAgent(desktop);
    const uri = "wc:8f4a@2?relay-protocol=irn&symKey=deadbeef";
    const seen: string[] = [];
    const bus = eventBus();
    installSdk({
      // Faithful to the SDK on a desktop with no extension: casper-wallet's IsPresent is
      // `typeof window.CasperWalletProvider === "function" || isIOS || isAndroid` → false;
      // metamask-snap's is `window.ethereum !== undefined` → false; walletconnect's is `return !0`.
      isProviderPresent: (p: string) => p === "walletconnect",
      connect: async () => {
        bus.status({ status: CSPR_CLICK_STATUS.showPairingQr, pairingUri: uri });
        return undefined;
      },
      signInWithAccount: async (a: unknown) => a,
    });

    expect(detectWalletTransport(window.csprclick!)).toEqual({ provider: "walletconnect" });
    const pending = csprClickConnector.connect({ events: bus.target, onPairing: (u) => seen.push(u) });
    await Promise.resolve();
    // The URI reaches the UI instead of being emitted into the void.
    expect(seen).toEqual([uri]);

    bus.status({
      status: CSPR_CLICK_STATUS.accountListUpdated,
      accounts: [{ public_key: "01aa", name: null, cspr_name: "alice.cspr" }],
    });
    await expect(pending).resolves.toEqual({
      ok: true,
      account: { publicKey: "01aa", label: "alice.cspr" },
    });
  });

  it("still says no-wallet, with something to act on, when the SDK reports nothing present", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    stubUserAgent(desktop);
    const calls: string[] = [];
    installSdk({
      isProviderPresent: () => false,
      connect: async (p: string) => {
        calls.push(p);
        return undefined;
      },
    });
    expect(detectWalletTransport(window.csprclick!)).toMatchObject({
      provider: null,
      reason: "no-wallet",
    });
    const outcome = await csprClickConnector.connect();
    expect(outcome).toMatchObject({ ok: false, reason: "no-wallet" });
    // The point: it did not fire a connect into the void, and it says something actionable.
    expect(calls).toEqual([]);
    expect(!outcome.ok && outcome.message).toMatch(/install/i);
  });

  it("prefers a local wallet over pairing wherever one exists", () => {
    stubUserAgent(android);
    installSdk({ isProviderPresent: () => true });
    expect(detectWalletTransport(window.csprclick!)).toEqual({ provider: "casper-wallet" });
    installSdk({ isProviderPresent: (p: string) => p === "walletconnect" });
    expect(detectWalletTransport(window.csprclick!)).toEqual({ provider: "walletconnect" });
    expect(providerNeedsPairing("walletconnect")).toBe(true);
    expect(providerNeedsPairing("casper-wallet")).toBe(false);
  });
});

describe("signing a prepared transaction", () => {
  it("returns the hash the wallet reports", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    const seen: Array<[string, string]> = [];
    installSdk({
      send: async (json: string, key: string) => {
        seen.push([json, key]);
        return { transactionHash: "abc123" };
      },
    });
    await expect(csprClickConnector.sendTransaction!("{\"payload\":1}", "01aa")).resolves.toEqual({
      ok: true,
      transactionHash: "abc123",
    });
    expect(seen).toEqual([["{\"payload\":1}", "01aa"]]);
  });

  it("distinguishes a declined signature from a failure — the bet path must never retry a decline", async () => {
    // A cancel that read as a generic failure would be retried against the operator-signed route,
    // placing a bet the visitor had just refused to sign, with someone else's money.
    installSdk({ send: async () => ({ cancelled: true }) });
    await expect(csprClickConnector.sendTransaction!("{}", "01aa")).resolves.toMatchObject({
      ok: false,
      reason: "cancelled",
    });

    installSdk({ send: async () => ({ error: "node rejected the transaction" }) });
    await expect(csprClickConnector.sendTransaction!("{}", "01aa")).resolves.toMatchObject({
      ok: false,
      reason: "failed",
    });

    installSdk({ send: async () => ({}) });
    await expect(csprClickConnector.sendTransaction!("{}", "01aa")).resolves.toMatchObject({
      ok: false,
      reason: "failed",
    });
  });

  it("reports a thrown signer as a failure rather than escaping", async () => {
    installSdk({
      send: async () => {
        throw new Error("extension port closed");
      },
    });
    await expect(csprClickConnector.sendTransaction!("{}", "01aa")).resolves.toEqual({
      ok: false,
      reason: "failed",
      message: "extension port closed",
    });
  });
});

/**
 * Reading CSPR.click's event channel.
 *
 * SDK 2.1 has no subscribe method: every provider dispatches `new CustomEvent("csprclick", …)` on
 * `window`. Subscribing is the only way to see a pairing URI, the accounts a paired wallet shares,
 * or an extension announcing the key it just approved.
 */
describe("reading CSPR.click's events", () => {
  it("recognises the pairing URI, which is the whole reason this app subscribes", () => {
    const signal = parseCsprClickEvent({
      detail: {
        provider: "walletconnect",
        providerEvent: PROVIDER_STATUS_UPDATE,
        custom: { status: CSPR_CLICK_STATUS.showPairingQr, pairingUri: "wc:abc@2?symKey=ff" },
      },
    });
    expect(signal).toEqual({ kind: "pairing", uri: "wc:abc@2?symKey=ff" });
  });

  it("normalises the accounts a paired wallet shares, keeping the SDK's own objects alongside", () => {
    const raw = [{ public_key: "01aa", name: null, cspr_name: "alice.cspr" }, { public_key: "" }];
    const signal = parseCsprClickEvent({
      detail: {
        provider: "walletconnect",
        providerEvent: PROVIDER_STATUS_UPDATE,
        custom: { status: CSPR_CLICK_STATUS.accountListUpdated, accounts: raw },
      },
    });
    // The unusable entry is dropped from BOTH lists, so index i still names the same account —
    // finishing the sign-in means handing the SDK back its own object.
    expect(signal).toEqual({
      kind: "accounts",
      accounts: [{ publicKey: "01aa", label: "alice.cspr" }],
      raw: [raw[0]],
    });
  });

  it("tells a rejection apart from a failure, and reports a pairing that shared nothing", () => {
    const status = (custom: unknown) =>
      parseCsprClickEvent({
        detail: { provider: "walletconnect", providerEvent: PROVIDER_STATUS_UPDATE, custom },
      });
    expect(status({ status: CSPR_CLICK_STATUS.userRejectedPairing })).toEqual({ kind: "rejected" });
    expect(status({ status: CSPR_CLICK_STATUS.errorConnectingWallet })).toMatchObject({
      kind: "failed",
    });
    expect(status({ status: CSPR_CLICK_STATUS.invalidSessionTopic, error: "stale topic" })).toEqual({
      kind: "failed",
      message: "stale topic",
    });
    expect(status({ status: CSPR_CLICK_STATUS.accountListUpdated, accounts: [] })).toMatchObject({
      kind: "failed",
    });
  });

  it("reads the extension's own announcement, where the account rides on activeKey", () => {
    expect(
      parseCsprClickEvent({
        detail: {
          provider: "casper-wallet",
          providerEvent: "casper-wallet:connected",
          activeKey: "01dd",
        },
      }),
    ).toEqual({ kind: "connected", account: { publicKey: "01dd", label: "Casper Wallet" } });
    // A disconnect also carries a key; it is not a connection.
    expect(
      parseCsprClickEvent({
        detail: {
          provider: "casper-wallet",
          providerEvent: "casper-wallet:disconnected",
          activeKey: "01dd",
        },
      }),
    ).toBeNull();
  });

  it("ignores events it has no opinion about instead of throwing on them", () => {
    for (const junk of [
      null,
      42,
      {},
      { detail: null },
      { detail: { providerEvent: "csprclick:loaded" } },
    ]) {
      expect(parseCsprClickEvent(junk)).toBeNull();
    }
  });

  it("subscribes and unsubscribes on the target it is given", () => {
    const bus = eventBus();
    const seen: string[] = [];
    const unsubscribe = subscribeToCsprClick((signal) => seen.push(signal.kind), bus.target);
    bus.status({ status: CSPR_CLICK_STATUS.showPairingQr, pairingUri: "wc:a@2" });
    unsubscribe();
    bus.status({ status: CSPR_CLICK_STATUS.showPairingQr, pairingUri: "wc:b@2" });
    expect(seen).toEqual(["pairing"]);
  });
});

/**
 * The WalletConnect route end to end: a desktop with no extension, a phone that answers, and every
 * way that can end. `connect()` there resolves `undefined` on success and says everything over the
 * event channel, so each of these endings used to be indistinguishable from a click that did not
 * register.
 */
describe("the WalletConnect pairing flow", () => {
  const PAIRING_URI = "wc:8f4a@2?relay-protocol=irn&symKey=deadbeef";

  /** An SDK whose only provider is WalletConnect: exactly a desktop with no extension. */
  function pairingSdk(bus: ReturnType<typeof eventBus>, signedIn: unknown[] = []): CsprClickLike {
    return {
      isProviderPresent: (p) => p === "walletconnect",
      connect: async () => {
        bus.status({ status: CSPR_CLICK_STATUS.showPairingQr, pairingUri: PAIRING_URI });
        return undefined;
      },
      signInWithAccount: async (account) => {
        signedIn.push(account);
        return account;
      },
      getActiveAccount: () => null,
    };
  }

  function connect(sdk: CsprClickLike, options: Parameters<typeof csprClickConnector.connect>[0]) {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk(sdk);
    return csprClickConnector.connect(options);
  }

  it("finishes the sign-in with the SDK's own account object", async () => {
    // Pairing alone leaves a session with no account: `signInWithAccount` completes it, and it must
    // receive the SDK's object — the normalised one has none of the session fields.
    const bus = eventBus();
    const signedIn: unknown[] = [];
    const pending = connect(pairingSdk(bus, signedIn), { events: bus.target });
    await Promise.resolve();
    const account = { public_key: "01aa", custom: { wcSessionTopic: "topic-1" } };
    bus.status({ status: CSPR_CLICK_STATUS.accountListUpdated, accounts: [account] });
    await pending;
    expect(signedIn).toEqual([account]);
  });

  it("asks the caller to pick when a wallet shares more than one account", async () => {
    const bus = eventBus();
    const signedIn: unknown[] = [];
    let offered: { publicKey: string; label: string }[] = [];
    const pending = connect(pairingSdk(bus, signedIn), {
      events: bus.target,
      onAccounts: (accounts, choose) => {
        offered = accounts;
        choose(1);
      },
    });
    await Promise.resolve();
    const accounts = [{ public_key: "01aa" }, { public_key: "01bb", cspr_name: "bob.cspr" }];
    bus.status({ status: CSPR_CLICK_STATUS.accountListUpdated, accounts });
    await expect(pending).resolves.toEqual({
      ok: true,
      account: { publicKey: "01bb", label: "bob.cspr" },
    });
    expect(offered.map((a) => a.publicKey)).toEqual(["01aa", "01bb"]);
    expect(signedIn).toEqual([accounts[1]]);
  });

  it("takes the first account when the caller offers no picker", async () => {
    const bus = eventBus();
    const pending = connect(pairingSdk(bus), { events: bus.target });
    await Promise.resolve();
    bus.status({
      status: CSPR_CLICK_STATUS.accountListUpdated,
      accounts: [{ public_key: "01aa" }, { public_key: "01bb" }],
    });
    await expect(pending).resolves.toEqual({
      ok: true,
      account: { publicKey: "01aa", label: "WalletConnect" },
    });
  });

  it("reports a rejected pairing as cancelled, not as an error", async () => {
    const bus = eventBus();
    const pending = connect(pairingSdk(bus), { events: bus.target });
    await Promise.resolve();
    bus.status({ status: CSPR_CLICK_STATUS.userRejectedPairing });
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "cancelled" });
  });

  it("reports a failed pairing with the reason the SDK gave", async () => {
    const bus = eventBus();
    const pending = connect(pairingSdk(bus), { events: bus.target });
    await Promise.resolve();
    bus.status({ status: CSPR_CLICK_STATUS.errorConnectingWallet, error: "relay unreachable" });
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: "failed",
      message: "relay unreachable",
    });
  });

  it("cancels when the visitor closes the dialog, and cleans up the half-open session", async () => {
    // The SDK's pairing promise never settles once it is waiting on a phone — there is no API to
    // cancel it — so the abort has to be the thing that ends the attempt here.
    const bus = eventBus();
    const disconnected: (string | undefined)[] = [];
    let cancelled = 0;
    const controller = new AbortController();
    const pending = connect(
      {
        ...pairingSdk(bus),
        cancelSignIn: () => {
          cancelled++;
        },
        disconnect: async (provider?: string) => {
          disconnected.push(provider);
          return true;
        },
      },
      { events: bus.target, signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "cancelled" });
    expect(cancelled).toBe(1);
    expect(disconnected).toEqual(["walletconnect"]);
  });

  it("stops listening once it has an answer", async () => {
    const bus = eventBus();
    const pending = connect(pairingSdk(bus), { events: bus.target });
    await Promise.resolve();
    bus.status({ status: CSPR_CLICK_STATUS.accountListUpdated, accounts: [{ public_key: "01aa" }] });
    const first = await pending;
    // A late event from an abandoned session must not reopen a settled attempt.
    bus.status({ status: CSPR_CLICK_STATUS.userRejectedPairing });
    expect(first).toEqual({ ok: true, account: { publicKey: "01aa", label: "WalletConnect" } });
  });

  it("builds the deep link Casper Wallet's app answers, escaping the URI", () => {
    expect(casperWalletPairingDeepLink("wc:topic@2?relay-protocol=irn&symKey=ab")).toBe(
      "casperwallet://wc?uri=wc%3Atopic%402%3Frelay-protocol%3Dirn%26symKey%3Dab",
    );
  });
});

describe("GET /api/boards — boards rebuilt from chain events", () => {
  it("serves an event-derived board with its own provenance", async () => {
    const res = await boardsGET(new Request("http://localhost/api/boards?network=testnet"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toBe("chain-events");
    expect(json.agentPnl.length).toBeGreaterThan(0);
    expect(json.provenance.eventCount).toBeGreaterThan(0);
    // Nothing skipped means the fold saw a complete history — the claim is checkable.
    expect(json.provenance.skipped).toEqual([]);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("names anything it skipped, so a drifting board is diagnosable", async () => {
    // `from` past the market's creation leaves bets with no market — exactly the mid-history case.
    const res = await boardsGET(new Request("http://localhost/api/boards?from=101"));
    const json = await res.json();
    expect(json.provenance.skipped.length).toBeGreaterThan(0);
    expect(json.provenance.skipped[0].reason).toContain("no market_created");
  });
});
