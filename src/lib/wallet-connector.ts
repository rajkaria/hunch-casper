/**
 * Wallet connector seam — how a human account is obtained, separated from how it is stored.
 *
 * `wallet-context.tsx` owns the SSR-safe store (subscribe, snapshot, localStorage). This module
 * owns the *source* of the account: a deterministic demo account, or a real CSPR.click session.
 * Splitting them is what lets the real integration land without touching a single caller — the
 * store's shape never changes.
 *
 * ## Why CSPR.click arrives via a global, not an npm dependency
 *
 * CSPR.click ships a browser bundle that installs `window.csprclick`; that is its drop-in
 * integration and the one the operator enables with a script tag plus an app id. Taking the npm
 * package instead would put a browser-only SDK, an app id, and a live network handshake into the
 * build — none of which CI can exercise, all of which would ship to every visitor whether or not
 * the operator ever configured a wallet.
 *
 * Reading a global is the honest version of the same coupling: absent, the app falls back to the
 * clearly-labelled demo account; present, real signing works with no rebuild. The interface below
 * is the contract either way, so a future npm-based connector is a swap here and nowhere else.
 */

export interface WalletAccountLike {
  publicKey: string;
  label: string;
}

/**
 * Why connecting resolves an outcome rather than `WalletAccountLike | null`.
 *
 * `null` conflated four different endings — the visitor cancelled, no wallet exists in this browser,
 * the SDK threw, or the transport is still waiting on a phone — and the UI turned all four into the
 * same thing: nothing. That is precisely the bug this type exists to make impossible; a caller has
 * to say what it does with `no-wallet` and `failed`, because they are not the same as `cancelled`.
 */
export type ConnectOutcome =
  | { kind: "connected"; account: WalletAccountLike }
  /** The visitor closed the pairing UI, or rejected the request in their wallet. */
  | { kind: "cancelled" }
  /** No usable transport: no extension, and no wallet answered the pairing request. */
  | { kind: "no-wallet"; reason: string }
  | { kind: "failed"; reason: string };

export interface ConnectOptions {
  /**
   * The transport needs the visitor to do something out of band: scan this WalletConnect URI with a
   * phone. Called before the promise settles, possibly more than once if a session is re-proposed.
   */
  onPairing?: (uri: string) => void;
  /**
   * The paired wallet offered more than one account. Call `choose` with the index to finish; until
   * then the connect promise stays pending. Without this callback the first account is taken.
   */
  onAccounts?: (accounts: WalletAccountLike[], choose: (index: number) => void) => void;
  /** Abort the attempt — the visitor closed the pairing dialog. Resolves `cancelled`. */
  signal?: AbortSignal;
  /** Where CSPR.click's DOM events arrive. Defaults to `window`; injected by tests. */
  events?: CsprClickEventTarget;
}

export interface WalletConnector {
  /** Stable id for diagnostics and the honesty pill. */
  readonly id: "demo" | "csprclick";
  /** Whether this connector can actually run right now (SDK present, app id configured). */
  available(): boolean;
  connect(options?: ConnectOptions): Promise<ConnectOutcome>;
  disconnect(): Promise<void>;
}

/**
 * The demo account. Deliberately not a valid fundable key and deliberately obvious: bets from it
 * settle through the mock adapter, and the UI labels it. A plausible-looking fake key would be
 * strictly worse than one that announces itself.
 */
export const DEMO_ACCOUNT: WalletAccountLike = {
  publicKey: "01demo0000000000000000000000000000000000000000000000000000000000",
  label: "Demo wallet",
};

export const demoConnector: WalletConnector = {
  id: "demo",
  available: () => true,
  connect: async () => ({ kind: "connected", account: DEMO_ACCOUNT }),
  disconnect: async () => {},
};

/** The slice of the CSPR.click global this app uses. */
export interface CsprClickLike {
  /**
   * Connect a specific provider (`"casper-wallet"`, `"ledger"`, …). This — not `signIn()` — is what
   * CSPR.click's own React UI calls when a user picks a wallet: `clickRef.connect(providerKey)`.
   */
  connect?: (provider: string, options?: unknown) => Promise<unknown>;
  /** Whether that provider's extension/transport is actually available in this browser. */
  isProviderPresent?: (provider: string) => boolean;
  signIn?: () => Promise<unknown>;
  /**
   * Finish a sign-in with an account the SDK reported over an event. WalletConnect's `connect()`
   * resolves nothing on success — it announces the paired accounts and expects the app's own picker
   * to hand one back here, which is what turns a pairing into a session.
   */
  signInWithAccount?: (account: unknown) => Promise<unknown>;
  /** Abandons an in-flight sign-in. Closes the popup in popup mode; a no-op otherwise. */
  cancelSignIn?: () => void;
  disconnect?: (provider?: string, options?: unknown) => Promise<unknown>;
  getActiveAccount?: () => { public_key?: string; publicKey?: string; name?: string } | null;
}

/**
 * Providers we attempt, in order. Ledger is omitted deliberately: `isProviderPresent("ledger")`
 * only reports whether WebHID/WebUSB exists, not whether a device is attached and unlocked, so it
 * answers true on most desktops and would shadow an installed extension.
 */
const CONNECT_ORDER = ["casper-wallet", "metamask-snap", "walletconnect"] as const;

/**
 * Providers whose `isProviderPresent()` is true on every browser, wallet or no wallet.
 *
 * WalletConnect's presence check in SDK 2.1 is, verbatim, `static IsPresent(){return!0}` — it is a
 * relay protocol, so there is nothing local to detect. That makes it a genuine last-resort route
 * (any phone with a compatible wallet can pair) and a trap for `firstAvailableProvider`: on a
 * desktop with no extension it is *always* selected, and its connect path does not open anything.
 * It emits a pairing URI and waits. An app that ignores that event has a Connect button that
 * silently does nothing, which is exactly what this app shipped.
 *
 * So the fact is named here rather than worked around: the pairing UI is required, and
 * `hasInstalledWallet()` lets the UI tell "scan this with your phone" apart from "install a wallet".
 */
export const REMOTE_ONLY_PROVIDERS: readonly string[] = ["walletconnect"];

/**
 * Where a visitor with no wallet at all is sent. Plain download page on purpose: the SDK's own
 * `?browse=` variant re-opens the site inside the wallet's in-app browser, which is a different
 * (and, from a desktop, useless) journey.
 */
export const CASPER_WALLET_DOWNLOAD_URL = "https://www.casperwallet.io/download";

/**
 * The deep link Casper Wallet's mobile app answers for a pairing URI — the same one SDK 2.1
 * navigates to on a mobile user agent (`"casperwallet://wc?uri=" + encodeURIComponent(uri)`).
 * Offered as a button beside the QR so a visitor already on their phone has a route that does not
 * involve photographing their own screen.
 */
export function casperWalletPairingDeepLink(uri: string): string {
  return `casperwallet://wc?uri=${encodeURIComponent(uri)}`;
}

/** Human names for the SDK's provider keys, used to label an account the events report. */
export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  "casper-wallet": "Casper Wallet",
  "metamask-snap": "MetaMask",
  walletconnect: "WalletConnect",
  ledger: "Ledger",
};

declare global {
  interface Window {
    csprclick?: CsprClickLike;
    /** Set by the CSPR.click bootstrap script; also readable from NEXT_PUBLIC_CSPR_CLICK_APP_ID. */
    __CSPR_CLICK_APP_ID__?: string;
  }
}

function csprClick(): CsprClickLike | null {
  if (typeof window === "undefined") return null;
  return window.csprclick ?? null;
}

/** Configured app id, from the bootstrap script or the public env. */
export function csprClickAppId(): string | null {
  const fromEnv = process.env.NEXT_PUBLIC_CSPR_CLICK_APP_ID;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (typeof window !== "undefined" && window.__CSPR_CLICK_APP_ID__) return window.__CSPR_CLICK_APP_ID__;
  return null;
}

/**
 * Normalise CSPR.click's active-account shape. It has used both `public_key` and `publicKey`
 * across versions, so both are read — a wallet that silently fails to connect because a field was
 * renamed is a bad afternoon. `cspr_name` is read too: accounts that arrive over WalletConnect have
 * `name: null` and carry their CSPR.name there, if they have one.
 */
export function accountFromCsprClick(
  raw: unknown,
  fallbackLabel = "CSPR.click",
): WalletAccountLike | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as {
    public_key?: unknown;
    publicKey?: unknown;
    name?: unknown;
    cspr_name?: unknown;
  };
  const publicKey = typeof record.public_key === "string" ? record.public_key : record.publicKey;
  if (typeof publicKey !== "string" || publicKey.length === 0) return null;
  const named = [record.name, record.cspr_name].find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return { publicKey, label: named ?? fallbackLabel };
}

// ---------------------------------------------------------------------------------------------
// CSPR.click's event channel
// ---------------------------------------------------------------------------------------------

/**
 * How the SDK talks back, and why this app has to listen.
 *
 * SDK 2.1 exposes no subscribe method. Every provider does, verbatim:
 *
 *     window.dispatchEvent(new CustomEvent("csprclick", {cancelable:!1, detail:n}))
 *
 * with `detail = {provider, providerEvent, activeKey, connected, unlocked, custom}`. Two of those
 * shapes matter here:
 *
 *  - `providerEvent === "csprclick:provider-status-update"`, where `custom` carries the
 *    WalletConnect state machine: the pairing URI, the accounts a paired wallet shared, a rejection.
 *  - any event carrying a non-empty `activeKey` — how an *extension* announces the account it just
 *    approved, since `connect()` on that path resolves before the account exists.
 *
 * Both are dispatched on `window`, so subscribing is the only way to observe either.
 */
export const CSPR_CLICK_DOM_EVENT = "csprclick";
export const PROVIDER_STATUS_UPDATE = "csprclick:provider-status-update";

/** The `custom.status` values SDK 2.1's WalletConnect provider emits, verbatim. */
export const CSPR_CLICK_STATUS = {
  showPairingQr: "show-pairing-qr-code",
  walletsPaired: "wallets-paired",
  accountListUpdated: "account-list-updated",
  userRejectedPairing: "user-rejected-pairing",
  errorConnectingWallet: "error-connecting-wallet",
  invalidSessionTopic: "invalid-session-topic",
} as const;

/** Just enough of `window` to subscribe, so tests can pass a plain `EventTarget`. */
export interface CsprClickEventTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

/**
 * `window` when it can actually dispatch events. Node has no `window`, and this repo's tests stub
 * one that is a plain object — neither can carry a listener, and neither should throw for trying.
 */
function defaultEventTarget(): CsprClickEventTarget | null {
  if (typeof window === "undefined") return null;
  const candidate = window as unknown as Partial<CsprClickEventTarget>;
  return typeof candidate.addEventListener === "function" ? (candidate as CsprClickEventTarget) : null;
}

/** What an SDK event means to this app, once the provider-specific shapes are folded together. */
export type CsprClickSignal =
  | { kind: "pairing"; uri: string }
  | { kind: "accounts"; accounts: WalletAccountLike[]; raw: unknown[] }
  | { kind: "connected"; account: WalletAccountLike }
  | { kind: "rejected" }
  | { kind: "failed"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Read one `csprclick` DOM event, or `null` if it says nothing this app acts on. Total by design:
 * the SDK emits a dozen event kinds and adds more between versions, and an unknown one is not an
 * error — it is simply not ours.
 */
export function parseCsprClickEvent(event: unknown): CsprClickSignal | null {
  if (!isRecord(event)) return null;
  const detail = (event as { detail?: unknown }).detail;
  if (!isRecord(detail)) return null;

  const provider = typeof detail.provider === "string" ? detail.provider : "";
  const label = PROVIDER_LABELS[provider] ?? "CSPR.click";
  const providerEvent = typeof detail.providerEvent === "string" ? detail.providerEvent : "";

  if (providerEvent === PROVIDER_STATUS_UPDATE && isRecord(detail.custom)) {
    const custom = detail.custom;
    const status = typeof custom.status === "string" ? custom.status : "";
    switch (status) {
      case CSPR_CLICK_STATUS.showPairingQr: {
        const uri = typeof custom.pairingUri === "string" ? custom.pairingUri : "";
        return uri.length > 0 ? { kind: "pairing", uri } : null;
      }
      case CSPR_CLICK_STATUS.accountListUpdated: {
        // `raw` is kept alongside, in lockstep, because finishing the sign-in means handing the
        // SDK back *its* account object — the normalised one has none of the session fields.
        const accounts: WalletAccountLike[] = [];
        const raw: unknown[] = [];
        for (const entry of Array.isArray(custom.accounts) ? custom.accounts : []) {
          const account = accountFromCsprClick(entry, label);
          if (!account) continue;
          accounts.push(account);
          raw.push(entry);
        }
        return accounts.length > 0
          ? { kind: "accounts", accounts, raw }
          : { kind: "failed", reason: "the wallet paired but shared no account" };
      }
      case CSPR_CLICK_STATUS.userRejectedPairing:
        return { kind: "rejected" };
      case CSPR_CLICK_STATUS.errorConnectingWallet:
      case CSPR_CLICK_STATUS.invalidSessionTopic:
        return {
          kind: "failed",
          reason: typeof custom.error === "string" ? custom.error : "the wallet could not connect",
        };
      default:
        return null;
    }
  }

  // The extension path: `<provider>:connected` / `:unlocked` / `:activeKeyChanged` carry the key.
  const activeKey = typeof detail.activeKey === "string" ? detail.activeKey : "";
  const announcesAccount =
    providerEvent.includes("connected") ||
    providerEvent.includes("unlocked") ||
    providerEvent.includes("activeKeyChanged");
  if (activeKey.length > 0 && announcesAccount && !providerEvent.includes("disconnected")) {
    return { kind: "connected", account: { publicKey: activeKey, label } };
  }
  return null;
}

/** Subscribe to the SDK's DOM events. Returns the unsubscribe. */
export function subscribeToCsprClick(
  handler: (signal: CsprClickSignal) => void,
  target: CsprClickEventTarget | null = defaultEventTarget(),
): () => void {
  if (!target) return () => {};
  const listener = (event: Event): void => {
    const signal = parseCsprClickEvent(event);
    if (signal) handler(signal);
  };
  target.addEventListener(CSPR_CLICK_DOM_EVENT, listener);
  return () => target.removeEventListener(CSPR_CLICK_DOM_EVENT, listener);
}

/**
 * The first provider whose transport is actually present, or `null` if the visitor has no wallet.
 * Defensive around `isProviderPresent`, which *throws* on a key the SDK does not know rather than
 * returning false.
 */
export function firstAvailableProvider(
  sdk: CsprClickLike,
  order: readonly string[] = CONNECT_ORDER,
): string | null {
  if (!sdk.isProviderPresent) return null;
  for (const provider of order) {
    try {
      if (sdk.isProviderPresent(provider)) return provider;
    } catch {
      /* unknown provider key — try the next */
    }
  }
  return null;
}

/**
 * Whether a wallet the visitor actually has locally is present — an extension or a snap, as opposed
 * to WalletConnect, which reports itself present everywhere. This is what lets the UI say the true
 * thing: "scan this with your phone" when pairing is the only route, "install Casper Wallet" when
 * there is no route at all.
 */
export function hasInstalledWallet(
  sdk: CsprClickLike,
  order: readonly string[] = CONNECT_ORDER,
): boolean {
  const local = order.filter((provider) => !REMOTE_ONLY_PROVIDERS.includes(provider));
  return firstAvailableProvider(sdk, local) !== null;
}

/** Whether the chosen provider can only reach a wallet on another device, i.e. needs pairing. */
export function providerNeedsPairing(provider: string): boolean {
  return REMOTE_ONLY_PROVIDERS.includes(provider);
}

function failureFrom(error: unknown): ConnectOutcome {
  const message = error instanceof Error ? error.message : String(error);
  // The extension says "user cancelled"/"User rejected" when someone closes its approval window.
  return /cancel|reject|denied/i.test(message)
    ? { kind: "cancelled" }
    : { kind: "failed", reason: message || "the wallet could not connect" };
}

/**
 * Run one connection attempt against a chosen provider, resolving on whichever finishes first: the
 * `connect()` promise, an SDK event, or the caller's abort signal.
 *
 * Both halves are needed, because neither is sufficient alone. `connect("casper-wallet")` resolves
 * with (or shortly before) the account, and emits nothing this app can wait on; `connect(
 * "walletconnect")` resolves `undefined` on success and reports everything — pairing URI, accounts,
 * rejection — over `window`'s `csprclick` events. Listening starts *before* `connect()` is called,
 * since the pairing URI is emitted synchronously inside it on a warm relay connection.
 */
export async function connectViaCsprClick(
  sdk: CsprClickLike,
  options: ConnectOptions = {},
): Promise<ConnectOutcome> {
  const provider = firstAvailableProvider(sdk);
  const connectProvider = sdk.connect;
  if (provider === null || !connectProvider) {
    return signInFallback(sdk, provider === null);
  }
  const providerLabel = PROVIDER_LABELS[provider] ?? "CSPR.click";

  return new Promise<ConnectOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ConnectOutcome): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const signIn = (raw: unknown, account: WalletAccountLike): void => {
      // WalletConnect pairs, then waits for the app to name the account it wants to use. Without
      // this the session exists and the app never has an account — connected to nothing.
      Promise.resolve(sdk.signInWithAccount?.(raw))
        .then(() => finish({ kind: "connected", account }))
        .catch((error: unknown) => finish(failureFrom(error)));
    };

    const unsubscribe = subscribeToCsprClick((signal) => {
      switch (signal.kind) {
        case "pairing":
          options.onPairing?.(signal.uri);
          return;
        case "accounts": {
          if (signal.accounts.length > 1 && options.onAccounts) {
            options.onAccounts(signal.accounts, (index) => {
              const account = signal.accounts[index];
              if (account) signIn(signal.raw[index], account);
            });
            return;
          }
          signIn(signal.raw[0], signal.accounts[0]);
          return;
        }
        case "connected":
          finish({ kind: "connected", account: signal.account });
          return;
        case "rejected":
          finish({ kind: "cancelled" });
          return;
        case "failed":
          finish({ kind: "failed", reason: signal.reason });
      }
    }, options.events);

    const onAbort = (): void => {
      // Best effort: drop the half-open session so the next attempt starts clean. The SDK's own
      // pairing promise stays pending forever either way — there is no API to cancel it — which is
      // exactly why the caller gets `cancelled` from here rather than waiting on it.
      try {
        sdk.cancelSignIn?.();
        Promise.resolve(sdk.disconnect?.(provider)).catch(() => {});
      } catch {
        /* nothing to clean up */
      }
      finish({ kind: "cancelled" });
    };
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    Promise.resolve(connectProvider.call(sdk, provider))
      .then((result) => {
        const account =
          accountFromCsprClick(result, providerLabel) ??
          accountFromCsprClick(sdk.getActiveAccount?.(), providerLabel);
        if (account) finish({ kind: "connected", account });
        // Resolving without an account is *normal on both routes*, and neither is an error:
        // WalletConnect is waiting on a phone, and Casper Wallet's own `connect()` resolves the
        // extension's `requestConnection()` — the key follows on a `casper-wallet:connected` event.
        // So the attempt stays open and the visitor's cancel is what ends it, rather than a
        // fabricated failure that would fire before the wallet has had time to answer.
      })
      .catch((error: unknown) => finish(failureFrom(error)));
  });
}

/**
 * `signIn()` as the last resort, kept for the two cases `connect(provider)` cannot serve: an SDK
 * build without `connect`, and a browser where no provider is present at all.
 *
 * It is a last resort because SDK 2.1 breaks it both ways. In `popup` mode it opens
 * `accounts.cspr.click/signin.html` — a page CSPR.click has deleted, verified 404. In `iframe` mode
 * it only *emits* a SIGN_IN event, expecting their React component library to draw the account
 * picker; this app does not ship that package (it pins React 18.3.1 against our React 19). So when
 * it resolves nothing, that is reported as `no-wallet` rather than swallowed.
 */
async function signInFallback(sdk: CsprClickLike, noProvider: boolean): Promise<ConnectOutcome> {
  const reason = noProvider
    ? "no Casper wallet is available in this browser"
    : "this CSPR.click build exposes no way to connect a provider";
  if (!sdk.signIn) return { kind: "no-wallet", reason };
  try {
    const result = await sdk.signIn();
    const account = accountFromCsprClick(result) ?? accountFromCsprClick(sdk.getActiveAccount?.());
    return account ? { kind: "connected", account } : { kind: "no-wallet", reason };
  } catch (error) {
    return failureFrom(error);
  }
}

export const csprClickConnector: WalletConnector = {
  id: "csprclick",
  available: () => csprClick() !== null && csprClickAppId() !== null,
  /**
   * Why this drives `connect(provider)` rather than `signIn()`: `connect(providerKey)` is the call
   * CSPR.click's own picker makes once a wallet is chosen, and it goes straight to the extension —
   * our UI is the picker. See `signInFallback` for what `signIn()` does instead, and why it is only
   * a fallback.
   */
  async connect(options: ConnectOptions = {}): Promise<ConnectOutcome> {
    const sdk = csprClick();
    if (!sdk) return { kind: "no-wallet", reason: "the CSPR.click SDK is not loaded" };
    try {
      return await connectViaCsprClick(sdk, options);
    } catch (error) {
      return failureFrom(error);
    }
  },
  async disconnect(): Promise<void> {
    try {
      await csprClick()?.disconnect?.();
    } catch {
      /* the local session is cleared by the caller regardless */
    }
  },
};

/**
 * The connector to use: CSPR.click when it is actually loaded AND configured, the demo account
 * otherwise. Both conditions matter — an app id with no SDK, or an SDK with no app id, cannot
 * complete a sign-in, and falling back is better than a button that does nothing.
 */
export function activeConnector(): WalletConnector {
  return csprClickConnector.available() ? csprClickConnector : demoConnector;
}
