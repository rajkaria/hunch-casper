/**
 * The wallet connector seam.
 *
 * The behaviour worth pinning: the app falls back to the labelled demo account unless CSPR.click
 * is BOTH loaded and configured. An app id with no SDK, or an SDK with no app id, cannot complete
 * a sign-in — and a Connect button that does nothing is worse than one that honestly connects a
 * demo account, because the second at least says what it is.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  DEMO_ACCOUNT,
  accountAfterConnect,
  accountFromCsprClick,
  activeConnector,
  casperWalletAccount,
  casperWalletInjected,
  csprClickAppId,
  csprClickConnector,
  demoConnector,
  disarmInAppBrowserRedirect,
  isClickConnectReturn,
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

/** No real timers in the settle loops — every wait is injected. */
const noWait = async (): Promise<void> => {};

afterEach(() => {
  vi.unstubAllEnvs();
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
    const account = await demoConnector.connect();
    expect(account).toEqual(DEMO_ACCOUNT);
    // Obviously fake on sight: a plausible-looking fake key would be strictly worse.
    expect(DEMO_ACCOUNT.publicKey).toContain("demo");
  });

  it("returns the signed-in account from CSPR.click", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({ signIn: async () => ({ public_key: "01aa", name: "Alice" }) });
    expect(await csprClickConnector.connect()).toEqual({ publicKey: "01aa", label: "Alice" });
  });

  it("falls back to getActiveAccount for SDK versions whose signIn resolves nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({ signIn: async () => undefined, getActiveAccount: () => ({ public_key: "01cc" }) });
    expect(await csprClickConnector.connect()).toEqual({ publicKey: "01cc", label: "CSPR.click" });
  });

  it("leaves the app disconnected — not broken — when a sign-in is cancelled", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({
      signIn: async () => {
        throw new Error("user cancelled");
      },
    });
    await expect(csprClickConnector.connect()).resolves.toBeNull();
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
      publicKey: "01dd",
      label: "Casper Wallet",
    });
    expect(calls).toEqual(["casper-wallet"]);
  });

  it("skips providers that are not installed and connects the one that is", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
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
      publicKey: "01ee",
      label: "CSPR.click",
    });
    expect(calls).toEqual(["walletconnect"]);
  });

  it("falls back to signIn when no wallet transport is present at all", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({
      isProviderPresent: () => false,
      connect: async () => ({ public_key: "01ff" }),
      signIn: async () => ({ public_key: "01aa", name: "Alice" }),
    });
    expect(await csprClickConnector.connect()).toEqual({ publicKey: "01aa", label: "Alice" });
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
      publicKey: "01aa",
      label: "Casper Wallet",
    });
    expect(redirects).toEqual([]); // no download tab
  });

  it("is left alone when no extension is injected — on a phone that handoff is the only route", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    const redirects: string[] = [];
    installSdk(sdkWithRedirect(redirects));

    expect(casperWalletInjected()).toBe(false);
    await expect(csprClickConnector.connect()).resolves.toBeNull();
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
