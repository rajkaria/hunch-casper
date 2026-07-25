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

export interface WalletConnector {
  /** Stable id for diagnostics and the honesty pill. */
  readonly id: "demo" | "csprclick";
  /** Whether this connector can actually run right now (SDK present, app id configured). */
  available(): boolean;
  connect(): Promise<WalletAccountLike | null>;
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
  connect: async () => DEMO_ACCOUNT,
  disconnect: async () => {},
};

/**
 * The Casper Wallet extension's own injected API — the *ground truth* for "is a wallet here".
 *
 * The extension installs `window.CasperWalletProvider`, a factory returning the provider object.
 * Only the two calls this app needs are typed; signing still goes through CSPR.click.
 */
export interface CasperWalletProviderLike {
  requestConnection?: () => Promise<boolean>;
  getActivePublicKey?: () => Promise<string>;
}

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
  disconnect?: () => Promise<unknown>;
  getActiveAccount?: () => { public_key?: string; publicKey?: string; name?: string } | null;
  /**
   * The SDK's mobile handoff, and the reason Connect used to open a download page in a new tab.
   * Typed here only so it can be disarmed — see `disarmInAppBrowserRedirect`.
   */
  shouldRedirectToInAppBrowser?: (provider: string) => boolean;
}

const CASPER_WALLET = "casper-wallet";

/**
 * Providers we attempt, in order. Ledger is omitted deliberately: `isProviderPresent("ledger")`
 * only reports whether WebHID/WebUSB exists, not whether a device is attached and unlocked, so it
 * answers true on most desktops and would shadow an installed extension.
 */
const CONNECT_ORDER = [CASPER_WALLET, "metamask-snap", "walletconnect"] as const;

declare global {
  interface Window {
    csprclick?: CsprClickLike;
    /** Set by the CSPR.click bootstrap script; also readable from NEXT_PUBLIC_CSPR_CLICK_APP_ID. */
    __CSPR_CLICK_APP_ID__?: string;
    /** Installed by the Casper Wallet browser extension. Its presence is not a heuristic. */
    CasperWalletProvider?: () => CasperWalletProviderLike;
  }
}

function csprClick(): CsprClickLike | null {
  if (typeof window === "undefined") return null;
  return window.csprclick ?? null;
}

/**
 * Whether the Casper Wallet extension is actually injected into this page.
 *
 * This is deliberately NOT `sdk.isProviderPresent("casper-wallet")`. That call resolves to the
 * SDK's own `IsPresent`, which is, verbatim from `csprclick-sdk-2.1.js`:
 *
 *     static IsPresent(){ const {isIOS:e,isAndroid:t}=E();
 *       return "function"==typeof window.CasperWalletProvider || e || t }
 *
 * — true on *any* mobile-looking user agent whether or not a wallet exists anywhere. The `||` is
 * the whole problem: it makes "present" mean "present, or you look like a phone".
 */
export function casperWalletInjected(): boolean {
  return typeof window !== "undefined" && typeof window.CasperWalletProvider === "function";
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
 * renamed is a bad afternoon.
 */
export function accountFromCsprClick(raw: unknown): WalletAccountLike | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as { public_key?: unknown; publicKey?: unknown; name?: unknown };
  const publicKey = typeof record.public_key === "string" ? record.public_key : record.publicKey;
  if (typeof publicKey !== "string" || publicKey.length === 0) return null;
  const name = typeof record.name === "string" && record.name.length > 0 ? record.name : null;
  return { publicKey, label: name ?? "CSPR.click" };
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
 * Disarm the SDK's in-app-browser handoff for the duration of one `connect()` call, returning the
 * undo. **This is the fix for the bug where Connect opened a Casper Wallet download page.**
 *
 * From `csprclick-sdk-2.1.js`, verbatim — the first thing `connect()` does:
 *
 *     async connect(e,t){ this.actionState=CONNECT;
 *       if(this.shouldRedirectToInAppBrowser(e)) return;   // ← swallows the connect
 *       ... }
 *
 *     shouldRedirectToInAppBrowser(e){ if(e===CASPER_WALLET){ const {isIOS,isAndroid}=E();
 *       if((isIOS||isAndroid) && _()!==CASPER_WALLET)
 *         return window.open("https://www.casperwallet.io/download?browse="
 *           + encodeURIComponent(window.location.href+"?click=connect"),"_blank"), !0 }
 *       return !1 }
 *
 * and the `isIOS` it consults is:
 *
 *     /iPad|iPhone|iPod/.test(navigator.userAgent)
 *       || (navigator.userAgent.includes("Macintosh") && navigator.maxTouchPoints >= 1)
 *
 * So on any touch-capable device the SDK reads as mobile — a real phone, an iPad, a touchscreen
 * Mac, an Android browser that supports extensions — `connect("casper-wallet")` never reaches the
 * wallet. It opens a download tab, returns `undefined`, and the app is left silently
 * disconnected: precisely the reported symptom, and it fires *even when the extension is
 * installed, unlocked and already connected*, because the redirect is decided before the provider
 * is ever consulted.
 *
 * The heuristic is not wrong in general — on a phone with no extension, the Casper Wallet in-app
 * browser genuinely is the only route, and that case is left exactly as upstream ships it. It is
 * wrong only when the extension is demonstrably right there in `window`. So the override is
 * scoped to that fact, applied for a single call, and reverted afterwards.
 */
export function disarmInAppBrowserRedirect(sdk: CsprClickLike): () => void {
  if (typeof sdk.shouldRedirectToInAppBrowser !== "function") return () => {};
  // The method lives on the prototype; assigning shadows it, so the undo must remove the shadow
  // rather than leave a permanent own-property in its place.
  const wasOwn = Object.prototype.hasOwnProperty.call(sdk, "shouldRedirectToInAppBrowser");
  const previous = sdk.shouldRedirectToInAppBrowser;
  sdk.shouldRedirectToInAppBrowser = () => false;
  return () => {
    if (wasOwn) sdk.shouldRedirectToInAppBrowser = previous;
    else delete sdk.shouldRedirectToInAppBrowser;
  };
}

/** The active key straight from the extension — the fallback that does not depend on CSPR.click. */
export async function casperWalletAccount(): Promise<WalletAccountLike | null> {
  if (!casperWalletInjected()) return null;
  try {
    const key = await window.CasperWalletProvider?.().getActivePublicKey?.();
    // `getActivePublicKey` throws when the site is not connected, so a key here means a key.
    return typeof key === "string" && key.length > 0 ? { publicKey: key, label: "Casper Wallet" } : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to let the account land after `connect()` resolves: 20 × 100ms. */
export const ACCOUNT_SETTLE_ATTEMPTS = 20;
export const ACCOUNT_SETTLE_INTERVAL_MS = 100;

/**
 * The account after a successful `connect(provider)` — which is not simply the resolved value.
 *
 * For an already-connected wallet the SDK's provider takes this branch:
 *
 *     await this.isUnlocked() && await this.isConnected()
 *       ? this.getActivePublicKey().then(async e => { this.triggerEvent("casper-wallet:connected", …) })
 *       : await this.provider?.requestConnection()
 *
 * — note the un-awaited `.then`. `connect()` resolves *before* the event that publishes the
 * account has fired, so reading `getActiveAccount()` on the next line is a race the app loses on
 * exactly the path the user is most likely to take (extension already unlocked and approved).
 * Polling briefly is what makes the fixed button actually connect rather than merely stop
 * opening a tab, and the extension's own `getActivePublicKey()` closes the case where CSPR.click's
 * internal bookkeeping never catches up.
 */
export async function accountAfterConnect(
  sdk: CsprClickLike,
  provider: string,
  result: unknown,
  options: { attempts?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<WalletAccountLike | null> {
  const attempts = options.attempts ?? ACCOUNT_SETTLE_ATTEMPTS;
  const wait = options.wait ?? sleep;
  const immediate = accountFromCsprClick(result);
  if (immediate) return immediate;
  // `requestConnection()` resolves `false` on an explicit refusal in the extension popup. Waiting
  // two seconds for an account the user just declined to give is only a slower way to say no.
  if (result === false) return null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const fromSdk = accountFromCsprClick(sdk.getActiveAccount?.());
    if (fromSdk) return fromSdk;
    if (provider === CASPER_WALLET) {
      const direct = await casperWalletAccount();
      if (direct) return direct;
    }
    if (attempt < attempts - 1) await wait(ACCOUNT_SETTLE_INTERVAL_MS);
  }
  return null;
}

/**
 * The marker CSPR.click appends to its return URL when it sends a visitor to the Casper Wallet
 * in-app browser (`…?click=connect`). Coming back, the app is expected to resume the connect it
 * was asked for; nothing did, so the round trip dead-ended on a page that still said "Connect".
 */
export const CLICK_CONNECT_PARAM = "click";
export const CLICK_CONNECT_VALUE = "connect";
const CLICK_CONNECT_SUFFIX = `?${CLICK_CONNECT_PARAM}=${CLICK_CONNECT_VALUE}`;

/**
 * Whether this URL is the return leg of that handoff.
 *
 * Both spellings are recognised, because the SDK builds the return URL as
 * `window.location.href + "?click=connect"` — a bare concatenation that emits a *second* `?` when
 * the page already had a query string (`/markets?tab=open?click=connect`). That is not a valid
 * query, so `searchParams` cannot see it; the raw suffix can.
 */
export function isClickConnectReturn(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.searchParams.get(CLICK_CONNECT_PARAM) === CLICK_CONNECT_VALUE ||
      parsed.search.endsWith(CLICK_CONNECT_SUFFIX)
    );
  } catch {
    return false;
  }
}

/** The same URL with the marker stripped, so a reload does not replay the handshake. */
export function withoutClickConnect(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.search !== CLICK_CONNECT_SUFFIX && parsed.search.endsWith(CLICK_CONNECT_SUFFIX)) {
      parsed.search = parsed.search.slice(0, -CLICK_CONNECT_SUFFIX.length);
    } else {
      parsed.searchParams.delete(CLICK_CONNECT_PARAM);
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

/**
 * Resolve once CSPR.click is loaded *and* configured, or give up.
 *
 * The SDK script is `afterInteractive`, so on a fresh page load `window.csprclick` does not exist
 * for the first few hundred milliseconds. Anything that auto-connects has to wait for it —
 * otherwise `activeConnector()` answers `demo` and the resume silently signs the visitor in as the
 * placeholder account, which is worse than not resuming at all. Never falls back to demo.
 */
export async function whenCsprClickReady(
  options: { attempts?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const attempts = options.attempts ?? 40;
  const wait = options.wait ?? sleep;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (csprClickConnector.available()) return true;
    if (attempt < attempts - 1) await wait(ACCOUNT_SETTLE_INTERVAL_MS);
  }
  return false;
}

export const csprClickConnector: WalletConnector = {
  id: "csprclick",
  available: () => csprClick() !== null && csprClickAppId() !== null,
  /**
   * Why this drives `connect(provider)` rather than `signIn()`.
   *
   * `signIn()` does one of two things in SDK 2.1, neither of which works here. In `popup` mode it
   * opens `accounts.cspr.click/signin.html` — a page CSPR.click has deleted, verified 404. In
   * `iframe` mode it only *emits* a SIGN_IN event, expecting their React component library to draw
   * the account picker; this app does not ship that package (it pins React 18.3.1 against our
   * React 19). Either way the button does nothing at all, silently.
   *
   * `connect(providerKey)` is the call their own picker makes once a wallet is chosen, and it goes
   * straight to the extension. Our UI is the picker. `signIn()` stays as a last resort so a future
   * SDK that fixes the hosted page still works without a change here.
   */
  async connect(): Promise<WalletAccountLike | null> {
    const sdk = csprClick();
    if (!sdk) return null;
    try {
      const provider = firstAvailableProvider(sdk);
      if (provider && sdk.connect) {
        // Only when the extension is demonstrably in `window` — a real phone with no wallet keeps
        // the SDK's handoff, which is the correct route there. See `disarmInAppBrowserRedirect`.
        const viaExtension = provider === CASPER_WALLET && casperWalletInjected();
        const restore = viaExtension ? disarmInAppBrowserRedirect(sdk) : () => {};
        let result: unknown;
        try {
          result = await sdk.connect(provider);
        } finally {
          restore();
        }
        // `connect` resolves without the account on most paths — and on the already-connected path
        // it resolves *before* the account exists at all. That race is the extension's; the other
        // providers hand back an account or nothing, so there is nothing there to wait for.
        return await accountAfterConnect(sdk, provider, result, {
          attempts: viaExtension ? undefined : 1,
        });
      }
      if (!sdk.signIn) return null;
      const result = await sdk.signIn();
      // Some versions resolve the account; others resolve nothing and expose it separately.
      return accountFromCsprClick(result) ?? accountFromCsprClick(sdk.getActiveAccount?.());
    } catch {
      return null; // a cancelled or failed sign-in leaves the app disconnected, not broken
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
