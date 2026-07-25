/**
 * The wallet connector seam.
 *
 * Two behaviours are worth pinning here.
 *
 * The first is the fallback: the app uses the labelled demo account unless CSPR.click is BOTH
 * loaded and configured. An app id with no SDK, or an SDK with no app id, cannot complete a
 * sign-in — and a Connect button that does nothing is worse than one that honestly connects a demo
 * account, because the second at least says what it is.
 *
 * The second is why this file grew: on a desktop with no extension, CSPR.click always selects
 * WalletConnect, whose presence check is a hardcoded `true`, and whose connect path *emits a
 * pairing URI and waits*. Every ending of that flow — a URI to show, accounts to choose from, a
 * rejection, a failure, a cancel — is now a value the UI can render, and the tests below are that
 * list. `null` used to mean all five at once, which is how a button ends up doing nothing at all.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  CSPR_CLICK_DOM_EVENT,
  CSPR_CLICK_STATUS,
  DEMO_ACCOUNT,
  PROVIDER_STATUS_UPDATE,
  accountFromCsprClick,
  activeConnector,
  casperWalletPairingDeepLink,
  connectViaCsprClick,
  csprClickAppId,
  csprClickConnector,
  demoConnector,
  firstAvailableProvider,
  hasInstalledWallet,
  parseCsprClickEvent,
  providerNeedsPairing,
  subscribeToCsprClick,
  type CsprClickLike,
  type ConnectOutcome,
} from "@/lib/wallet-connector";
import { GET as boardsGET } from "@/app/api/boards/route";

function installSdk(sdk: CsprClickLike | undefined): void {
  (globalThis as unknown as { window?: unknown }).window ??= {};
  (globalThis as unknown as { window: { csprclick?: CsprClickLike } }).window.csprclick = sdk;
}

afterEach(() => {
  vi.unstubAllEnvs();
  const w = (globalThis as unknown as { window?: { csprclick?: unknown } }).window;
  if (w) delete w.csprclick;
});

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

describe("accountFromCsprClick", () => {
  it("reads both the snake_case and camelCase key fields the SDK has used", () => {
    // A wallet that silently fails to connect because a field was renamed is a bad afternoon.
    expect(accountFromCsprClick({ public_key: "01aa", name: "Alice" })).toEqual({
      publicKey: "01aa",
      label: "Alice",
    });
    expect(accountFromCsprClick({ publicKey: "01bb" })).toEqual({ publicKey: "01bb", label: "CSPR.click" });
  });

  it("falls back to cspr_name, which is where WalletConnect accounts carry their name", () => {
    // Accounts the SDK builds from a WalletConnect session always have `name: null`.
    expect(accountFromCsprClick({ public_key: "01cc", name: null, cspr_name: "alice.cspr" })).toEqual(
      { publicKey: "01cc", label: "alice.cspr" },
    );
    expect(accountFromCsprClick({ public_key: "01cc" }, "Casper Wallet")).toEqual({
      publicKey: "01cc",
      label: "Casper Wallet",
    });
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

describe("provider selection", () => {
  it("skips providers that are not installed, and survives the ones that throw", () => {
    // Unknown keys THROW in the real SDK rather than returning false.
    const sdk: CsprClickLike = {
      isProviderPresent: (p: string) => {
        if (p === "casper-wallet") return false;
        if (p === "metamask-snap") throw new Error("Unsupported wallet: " + p);
        return true;
      },
    };
    expect(firstAvailableProvider(sdk)).toBe("walletconnect");
  });

  it("treats WalletConnect as present-but-remote, because its presence check is a literal true", () => {
    // SDK 2.1: `static IsPresent(){return!0}`. Nothing local is detected, so an app that trusts
    // this answer alone concludes "a wallet is available" on a machine with no wallet at all.
    const noExtension: CsprClickLike = { isProviderPresent: (p) => p === "walletconnect" };
    expect(firstAvailableProvider(noExtension)).toBe("walletconnect");
    expect(hasInstalledWallet(noExtension)).toBe(false);
    expect(providerNeedsPairing("walletconnect")).toBe(true);

    const withExtension: CsprClickLike = { isProviderPresent: () => true };
    expect(hasInstalledWallet(withExtension)).toBe(true);
    expect(providerNeedsPairing("casper-wallet")).toBe(false);
  });

  it("builds the deep link Casper Wallet's app answers, escaping the URI", () => {
    expect(casperWalletPairingDeepLink("wc:topic@2?relay-protocol=irn&symKey=ab")).toBe(
      "casperwallet://wc?uri=wc%3Atopic%402%3Frelay-protocol%3Dirn%26symKey%3Dab",
    );
  });
});

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
    expect(status({ status: CSPR_CLICK_STATUS.errorConnectingWallet })).toEqual({
      kind: "failed",
      reason: "the wallet could not connect",
    });
    expect(status({ status: CSPR_CLICK_STATUS.invalidSessionTopic, error: "stale topic" })).toEqual({
      kind: "failed",
      reason: "stale topic",
    });
    expect(status({ status: CSPR_CLICK_STATUS.accountListUpdated, accounts: [] })).toEqual({
      kind: "failed",
      reason: "the wallet paired but shared no account",
    });
  });

  it("reads the extension's own announcement, where the account rides on activeKey", () => {
    expect(
      parseCsprClickEvent({
        detail: { provider: "casper-wallet", providerEvent: "casper-wallet:connected", activeKey: "01dd" },
      }),
    ).toEqual({ kind: "connected", account: { publicKey: "01dd", label: "Casper Wallet" } });
    // A disconnect also carries a key; it is not a connection.
    expect(
      parseCsprClickEvent({
        detail: { provider: "casper-wallet", providerEvent: "casper-wallet:disconnected", activeKey: "01dd" },
      }),
    ).toBeNull();
  });

  it("ignores events it has no opinion about instead of throwing on them", () => {
    for (const junk of [null, 42, {}, { detail: null }, { detail: { providerEvent: "csprclick:loaded" } }]) {
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

describe("connecting", () => {
  it("the demo connector resolves the labelled placeholder", async () => {
    const outcome = await demoConnector.connect();
    expect(outcome).toEqual({ kind: "connected", account: DEMO_ACCOUNT });
    // Obviously fake on sight: a plausible-looking fake key would be strictly worse.
    expect(DEMO_ACCOUNT.publicKey).toContain("demo");
  });

  it("returns the signed-in account from CSPR.click", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({ signIn: async () => ({ public_key: "01aa", name: "Alice" }) });
    expect(await csprClickConnector.connect()).toEqual({
      kind: "connected",
      account: { publicKey: "01aa", label: "Alice" },
    });
  });

  it("falls back to getActiveAccount for SDK versions whose signIn resolves nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({ signIn: async () => undefined, getActiveAccount: () => ({ public_key: "01cc" }) });
    expect(await csprClickConnector.connect()).toEqual({
      kind: "connected",
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
    await expect(csprClickConnector.connect()).resolves.toEqual({ kind: "cancelled" });
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
      kind: "connected",
      account: { publicKey: "01dd", label: "Casper Wallet" },
    });
    expect(calls).toEqual(["casper-wallet"]);
  });

  it("says so when no wallet transport is present at all", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({
      isProviderPresent: () => false,
      connect: async () => ({ public_key: "01ff" }),
      signIn: async () => undefined,
    });
    // This is the ending that used to be `null`, i.e. indistinguishable from "you cancelled".
    expect(await csprClickConnector.connect()).toEqual({
      kind: "no-wallet",
      reason: "no Casper wallet is available in this browser",
    });
  });

  it("still uses signIn when it works and no provider is present", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({
      isProviderPresent: () => false,
      signIn: async () => ({ public_key: "01aa", name: "Alice" }),
    });
    expect(await csprClickConnector.connect()).toEqual({
      kind: "connected",
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

describe("the WalletConnect pairing flow", () => {
  /** An SDK whose only provider is WalletConnect: exactly a desktop with no extension. */
  function pairingSdk(bus: ReturnType<typeof eventBus>, signedIn: unknown[] = []): CsprClickLike {
    return {
      isProviderPresent: (p) => p === "walletconnect",
      // The real one resolves `undefined` on success and reports everything over events.
      connect: async () => {
        bus.status({
          status: CSPR_CLICK_STATUS.showPairingQr,
          pairingUri: "wc:8f4a@2?relay-protocol=irn&symKey=deadbeef",
        });
        return undefined;
      },
      signInWithAccount: async (account) => {
        signedIn.push(account);
        return account;
      },
      getActiveAccount: () => null,
    };
  }

  it("hands the pairing URI to the caller instead of waiting in silence", async () => {
    const bus = eventBus();
    const seen: string[] = [];
    const pending = connectViaCsprClick(pairingSdk(bus), {
      events: bus.target,
      onPairing: (uri) => seen.push(uri),
    });

    // Let `connect()` run; the URI arrives from inside it.
    await Promise.resolve();
    expect(seen).toEqual(["wc:8f4a@2?relay-protocol=irn&symKey=deadbeef"]);

    const account = { public_key: "01aa", name: null, cspr_name: "alice.cspr" };
    bus.status({ status: CSPR_CLICK_STATUS.accountListUpdated, accounts: [account] });
    await expect(pending).resolves.toEqual({
      kind: "connected",
      account: { publicKey: "01aa", label: "alice.cspr" },
    });
  });

  it("finishes the sign-in with the SDK's own account object", async () => {
    // Pairing alone leaves a session with no account: `signInWithAccount` is what completes it, and
    // it must receive the SDK's object — the normalised one has none of the session fields.
    const bus = eventBus();
    const signedIn: unknown[] = [];
    const pending = connectViaCsprClick(pairingSdk(bus, signedIn), { events: bus.target });
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
    const pending = connectViaCsprClick(pairingSdk(bus, signedIn), {
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
      kind: "connected",
      account: { publicKey: "01bb", label: "bob.cspr" },
    });
    expect(offered.map((a) => a.publicKey)).toEqual(["01aa", "01bb"]);
    expect(signedIn).toEqual([accounts[1]]);
  });

  it("takes the first account when the caller offers no picker", async () => {
    const bus = eventBus();
    const pending = connectViaCsprClick(pairingSdk(bus), { events: bus.target });
    await Promise.resolve();
    bus.status({
      status: CSPR_CLICK_STATUS.accountListUpdated,
      accounts: [{ public_key: "01aa" }, { public_key: "01bb" }],
    });
    await expect(pending).resolves.toEqual({
      kind: "connected",
      account: { publicKey: "01aa", label: "WalletConnect" },
    });
  });

  it("reports a rejected pairing as cancelled, not as an error", async () => {
    const bus = eventBus();
    const pending = connectViaCsprClick(pairingSdk(bus), { events: bus.target });
    await Promise.resolve();
    bus.status({ status: CSPR_CLICK_STATUS.userRejectedPairing });
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
  });

  it("reports a failed pairing with the reason the SDK gave", async () => {
    const bus = eventBus();
    const pending = connectViaCsprClick(pairingSdk(bus), { events: bus.target });
    await Promise.resolve();
    bus.status({ status: CSPR_CLICK_STATUS.errorConnectingWallet, error: "relay unreachable" });
    await expect(pending).resolves.toEqual({ kind: "failed", reason: "relay unreachable" });
  });

  it("cancels when the visitor closes the dialog, and tries to clean up the half-open session", async () => {
    // The SDK's pairing promise never settles once it is waiting on a phone — there is no API to
    // cancel it — so the abort has to be the thing that ends the attempt here.
    const bus = eventBus();
    const disconnected: (string | undefined)[] = [];
    let cancelled = 0;
    const sdk: CsprClickLike = {
      ...pairingSdk(bus),
      cancelSignIn: () => {
        cancelled++;
      },
      disconnect: async (provider) => {
        disconnected.push(provider);
        return true;
      },
    };
    const controller = new AbortController();
    const pending = connectViaCsprClick(sdk, { events: bus.target, signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: "cancelled" });
    expect(cancelled).toBe(1);
    expect(disconnected).toEqual(["walletconnect"]);
  });

  it("stops listening once it has an answer", async () => {
    const bus = eventBus();
    const pending = connectViaCsprClick(pairingSdk(bus), { events: bus.target });
    await Promise.resolve();
    bus.status({ status: CSPR_CLICK_STATUS.accountListUpdated, accounts: [{ public_key: "01aa" }] });
    const first = await pending;
    // A late event from an abandoned session must not reopen a settled attempt.
    bus.status({ status: CSPR_CLICK_STATUS.userRejectedPairing });
    await expect(Promise.resolve(first)).resolves.toEqual({
      kind: "connected",
      account: { publicKey: "01aa", label: "WalletConnect" },
    });
  });

  it("keeps waiting when the extension has not answered yet, instead of inventing a failure", async () => {
    // Casper Wallet's `connect()` resolves its own `requestConnection()` — the key arrives later,
    // on an event. Treating that gap as a failure would break the extension flow, which is the one
    // that already worked.
    const bus = eventBus();
    const controller = new AbortController();
    const pending = connectViaCsprClick(
      {
        isProviderPresent: (p) => p === "casper-wallet",
        connect: async () => true,
        getActiveAccount: () => null,
      },
      { events: bus.target, signal: controller.signal },
    );
    const settledEarly = await Promise.race([
      pending.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 20)),
    ]);
    expect(settledEarly).toBe(false);

    // The visitor's cancel is what ends it — and it ends as `cancelled`, not as an error.
    controller.abort();
    const outcome: ConnectOutcome = await pending;
    expect(outcome).toEqual({ kind: "cancelled" });
  });

  it("completes the extension path from its event when connect() resolves nothing", async () => {
    const bus = eventBus();
    const pending = connectViaCsprClick(
      {
        isProviderPresent: (p) => p === "casper-wallet",
        connect: async () => {
          bus.emit({
            provider: "casper-wallet",
            providerEvent: "casper-wallet:connected",
            activeKey: "01dd",
          });
          return undefined;
        },
        getActiveAccount: () => null,
      },
      { events: bus.target },
    );
    await expect(pending).resolves.toEqual({
      kind: "connected",
      account: { publicKey: "01dd", label: "Casper Wallet" },
    });
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
