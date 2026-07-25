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

import { csprClickApplicationUrl } from "@/config/csprclick";

export interface WalletAccountLike {
  publicKey: string;
  label: string;
}

/**
 * Why connecting returns a reason and not just `null`.
 *
 * Every failure used to collapse to `null`, and the button's response to `null` was to do
 * nothing — visually identical to a click that did not register. Three quite different things
 * were hiding behind that: the visitor closed the wallet popup, the visitor has no wallet in this
 * browser at all, and the wallet errored. Only the first is fine to swallow.
 */
export type ConnectOutcome =
  | { ok: true; account: WalletAccountLike }
  /** The visitor declined or closed the wallet. Say nothing; they know what they did. */
  | { ok: false; reason: "cancelled"; message: string }
  /** No wallet transport exists in this browser. The one case that needs an install prompt. */
  | { ok: false; reason: "no-wallet"; message: string }
  | { ok: false; reason: "failed"; message: string };

/**
 * The out-of-band parts of a connection, which only exist because one transport is not on this
 * device: WalletConnect hands back a pairing URI and waits for a phone to answer it.
 */
export interface ConnectOptions {
  /** Show this WalletConnect URI as a QR. May fire more than once if a session is re-proposed. */
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
  /**
   * Sign and submit a prepared transaction with the connected wallet. Absent on the demo
   * connector — a placeholder account has no key, which is exactly why the bet path falls back to
   * the operator-signed route rather than pretending.
   */
  sendTransaction?(transactionJson: string, publicKey: string): Promise<SendTransactionOutcome>;
}

export type SendTransactionOutcome =
  | { ok: true; transactionHash: string }
  | { ok: false; reason: "cancelled" | "failed"; message: string };

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
  connect: async () => ({ ok: true, account: DEMO_ACCOUNT }),
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
  /**
   * The SDK's mobile handoff, and the reason Connect used to open a download page in a new tab.
   * Typed here only so it can be disarmed — see `disarmInAppBrowserRedirect`.
   */
  shouldRedirectToInAppBrowser?: (provider: string) => boolean;
  /**
   * Sign a transaction with the connected wallet and submit it. `send(json, publicKey)` in the
   * SDK, which requires `getActiveAccount().public_key === publicKey` and resolves
   * `{cancelled, error, deployHash, transactionHash}` — it never throws for a declined signature.
   */
  send?: (
    transactionJson: string,
    publicKey: string,
  ) => Promise<{
    cancelled?: boolean;
    error?: string | null;
    deployHash?: string | null;
    transactionHash?: string | null;
  }>;
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
    /** Set by the bootstrap when a WalletConnect Cloud project id is configured. */
    __CSPR_CLICK_WC_PROJECT_ID__?: string;
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

/**
 * Providers that report themselves present on every browser, because there is nothing local to
 * detect — and what this app must therefore do about it.
 *
 * WalletConnect's `IsPresent()` in the SDK is `return !0` — always true, for everyone — so it
 * silently wins the provider race for every desktop visitor without an extension. Its connect path
 * then splits:
 *
 *     const {isIOS,isAndroid}=E();
 *     if((isIOS||isAndroid) && _()!==CASPER_WALLET)
 *       setTimeout(()=>{ window.location.href = "casperwallet://wc?uri=" + encodeURIComponent(uri) },300)
 *     else triggerCustomEvent(PROVIDER_STATUS_UPDATE, {status: ShowPairingQR, pairingUri: uri})
 *
 * On mobile it deep-links into the Casper Wallet app. On desktop it asks the *host app* to render
 * a pairing QR — CSPR.click's React component library draws that one, and this app does not ship
 * it. For a while the desktop branch was therefore a button that fired an event into the void, and
 * this app answered by refusing to select WalletConnect there at all: an honest dead end, but a
 * dead end, and the only route a visitor without an extension had.
 *
 * It is no longer a dead end. `connectViaPairing` below subscribes to that event and
 * `components/wallet-pairing.tsx` draws the QR, so WalletConnect is a real transport on every
 * device — a phone scans it, or a visitor on a phone follows the deep link. What remains true is
 * that its presence answer carries no information about whether the visitor has a wallet at all,
 * which is why the pairing dialog also offers the extension, and why `casperWalletInjected()`
 * rather than `isProviderPresent` is the ground truth everywhere it matters.
 */
export const REMOTE_ONLY_PROVIDERS: readonly string[] = ["walletconnect"];

/** Whether this provider can only reach a wallet on another device, i.e. needs a pairing UI. */
export function providerNeedsPairing(provider: string): boolean {
  return REMOTE_ONLY_PROVIDERS.includes(provider);
}

/**
 * Where a visitor with no wallet at all is sent. Plain download page on purpose: the SDK's own
 * `?browse=` variant re-opens the site inside the wallet's in-app browser, which is the right
 * journey from a phone and a useless one from a desktop.
 */
export const CASPER_WALLET_DOWNLOAD_URL = "https://www.casperwallet.io/download";

/**
 * The deep link Casper Wallet's mobile app answers for a pairing URI — the same one SDK 2.1
 * navigates to on a mobile user agent. Offered beside the QR so a visitor already on their phone
 * has a route that does not involve photographing their own screen.
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

/**
 * What `connect()` will actually do, decided before anything is opened.
 *
 * Split out from `connect()` so the "why is there no wallet" answer is a pure function of the
 * environment and can be asserted without a browser.
 */
export type WalletTransport =
  | { provider: string }
  /** Nothing usable is here. The one case that earns an install prompt. */
  | { provider: null; reason: "no-wallet"; message: string }
  /**
   * The SDK cannot answer — it has no `isProviderPresent` at all. Absence of evidence, so the
   * caller falls through to `signIn()` rather than telling a visitor with a working wallet that
   * they do not have one.
   */
  | { provider: null; reason: "undetectable" };

const NO_WALLET_MESSAGE =
  "No Casper wallet found in this browser. Install the Casper Wallet extension to bet with your own account.";

/**
 * Whether the SDK was booted with a WalletConnect Cloud project id — the precondition for the
 * pairing route to exist at all. The provider's constructor throws "WalletConnect settings not
 * present" without one (`config/csprclick.ts` quotes the source), so offering `walletconnect`
 * unconfigured buys the visitor "Could not establish a connection with the provider" from a QR
 * flow that can never start. Unconfigured, it is simply not offered: a visitor with no extension
 * gets the honest install prompt instead of a broken dialog.
 */
export function walletConnectConfigured(): boolean {
  const fromEnv = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  if (fromEnv && fromEnv.length > 0) return true;
  return typeof window !== "undefined" && typeof window.__CSPR_CLICK_WC_PROJECT_ID__ === "string";
}

export function detectWalletTransport(
  sdk: CsprClickLike,
  order: readonly string[] = CONNECT_ORDER,
  wcConfigured: boolean = walletConnectConfigured(),
): WalletTransport {
  if (!sdk.isProviderPresent) return { provider: null, reason: "undetectable" };
  const usable = wcConfigured ? order : order.filter((p) => !providerNeedsPairing(p));
  const provider = firstAvailableProvider(sdk, usable);
  if (provider !== null) return { provider };
  return { provider: null, reason: "no-wallet", message: NO_WALLET_MESSAGE };
}

/** Configured app id, from the bootstrap script or the public env. */
export function csprClickAppId(): string | null {
  const fromEnv = process.env.NEXT_PUBLIC_CSPR_CLICK_APP_ID;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  if (typeof window !== "undefined" && window.__CSPR_CLICK_APP_ID__) return window.__CSPR_CLICK_APP_ID__;
  return null;
}

// ---------------------------------------------------------------------------------------------
// App-id rejection — the failure the SDK cannot report
// ---------------------------------------------------------------------------------------------

/**
 * Why the app probes CSPR.click's registration endpoint itself.
 *
 * "App id set + SDK loaded" was `available()`'s whole test, and it has a hole: an app id that
 * CSPR.click never issued. The SDK's `init()` fetches `application/{appId}.json`, gets
 * `401 {"error":{"message":"wrong application id"}}`, and crashes unhandled on the error body
 * (`e.menu_items.map` — see `csprClickApplicationUrl` in `config/csprclick.ts` for the verbatim
 * source). No event is emitted, the signing frame is never installed, and this app kept posture
 * "armed" over a wallet that could never sign — worse than the labelled demo fallback, which at
 * least works.
 *
 * So the connector asks the same endpoint the same question, and a conclusive "no" flips
 * `available()` to false: `activeConnector()` hands out the demo wallet again, visibly, and the
 * reason is kept for the UI. Only a definitive rejection (401/403/404) counts — a network burp or
 * a CSPR.click outage (5xx) proves nothing about the id and must not demote a working config.
 */
let appIdRejection: string | null = null;

/** The rejection reason, or `null` while the configured id is not known-bad. */
export function csprClickAppIdRejection(): string | null {
  return appIdRejection;
}

export function markCsprClickAppIdRejected(message: string): void {
  appIdRejection = message;
}

export function __resetCsprClickAppIdRejection(): void {
  appIdRejection = null;
}

/**
 * Ask accounts.cspr.click whether the configured app id exists. Resolves to the rejection message
 * when the answer is a definitive no, `null` otherwise (accepted, unreachable, or nothing to ask).
 * Safe to call more than once; a marked rejection is remembered and not re-probed.
 */
export async function probeCsprClickAppId(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  if (appIdRejection !== null) return appIdRejection;
  const appId = csprClickAppId();
  if (appId === null) return null;
  try {
    // `credentials: "omit"` on purpose: the SDK's own fetch sends cookies to keep a session alive,
    // but this probe only asks whether the registration exists, and the answer is the same.
    const res = await fetchImpl(csprClickApplicationUrl(appId), { credentials: "omit" });
    if (res.ok) return null;
    if (res.status !== 401 && res.status !== 403 && res.status !== 404) return null;
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (typeof body?.error?.message === "string") detail = `: ${body.error.message}`;
    } catch {
      /* a bare status is still a definitive no */
    }
    markCsprClickAppIdRejected(
      `CSPR.click rejected this site's app id (HTTP ${res.status}${detail}). ` +
        `Real signing is off until a registered id is set — mint one at console.cspr.click and ` +
        `redeploy with NEXT_PUBLIC_CSPR_CLICK_APP_ID.`,
    );
    if (typeof window !== "undefined") {
      // The SDK's only symptom is an uncaught TypeError from deep inside its bundle. Say what
      // actually happened, once, next to it.
      console.warn(`[wallet] ${appIdRejection}`);
    }
    return appIdRejection;
  } catch {
    return null; // offline, CORS, DNS — inconclusive, so the config keeps the benefit of the doubt
  }
}

/**
 * Normalise CSPR.click's active-account shape. It has used both `public_key` and `publicKey`
 * across versions, so both are read — a wallet that silently fails to connect because a field was
 * renamed is a bad afternoon.
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
  // Accounts the SDK builds from a WalletConnect session always have `name: null`; their CSPR.name,
  // if they have one, arrives as `cspr_name`.
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
  return typeof candidate.addEventListener === "function"
    ? (candidate as CsprClickEventTarget)
    : null;
}

/** What an SDK event means to this app, once the provider-specific shapes are folded together. */
export type CsprClickSignal =
  | { kind: "pairing"; uri: string }
  | { kind: "accounts"; accounts: WalletAccountLike[]; raw: unknown[] }
  | { kind: "connected"; account: WalletAccountLike }
  | { kind: "rejected" }
  | { kind: "failed"; message: string };

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
          : { kind: "failed", message: "The wallet paired but shared no account" };
      }
      case CSPR_CLICK_STATUS.userRejectedPairing:
        return { kind: "rejected" };
      case CSPR_CLICK_STATUS.errorConnectingWallet:
      case CSPR_CLICK_STATUS.invalidSessionTopic:
        return {
          kind: "failed",
          message: typeof custom.error === "string" ? custom.error : "The wallet could not connect",
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
 * The WalletConnect route: hand the pairing URI to the UI, then resolve on whichever comes first —
 * an SDK event, or the visitor giving up.
 *
 * Nothing here can be awaited from `connect()` alone. WalletConnect's `connect()` resolves
 * `undefined` on success and reports *everything* over the event channel above, and its pairing
 * promise never settles once it is waiting on a phone — there is no API to cancel it. So listening
 * starts before `connect()` is called (the URI is emitted from inside it), and the visitor's own
 * cancel is what ends an attempt nobody answered.
 */
async function connectViaPairing(
  sdk: CsprClickLike,
  provider: string,
  options: ConnectOptions,
): Promise<ConnectOutcome> {
  const connectProvider = sdk.connect;
  if (!connectProvider) {
    return { ok: false, reason: "failed", message: "This CSPR.click build cannot connect a provider" };
  }

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
      // Pairing alone leaves a session with no account: `signInWithAccount` is what completes it,
      // and it must receive the SDK's own object, not our normalised one.
      Promise.resolve(sdk.signInWithAccount?.(raw))
        .then(() => finish({ ok: true, account }))
        .catch((error: unknown) =>
          finish({
            ok: false,
            reason: "failed",
            message: error instanceof Error ? error.message : "Wallet sign-in failed",
          }),
        );
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
          finish({ ok: true, account: signal.account });
          return;
        case "rejected":
          finish({ ok: false, reason: "cancelled", message: "The pairing was rejected in the wallet" });
          return;
        case "failed":
          finish({ ok: false, reason: "failed", message: signal.message });
      }
    }, options.events);

    const onAbort = (): void => {
      // Best effort: drop the half-open session so the next attempt starts clean.
      try {
        sdk.cancelSignIn?.();
        Promise.resolve(sdk.disconnect?.(provider)).catch(() => {});
      } catch {
        /* nothing to clean up */
      }
      finish({ ok: false, reason: "cancelled", message: "Pairing was cancelled" });
    };
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    Promise.resolve(connectProvider.call(sdk, provider))
      .then((result) => {
        const account = accountFromCsprClick(result, PROVIDER_LABELS[provider] ?? "CSPR.click");
        if (account) finish({ ok: true, account });
        // Resolving without an account is the normal case here — the events above carry the rest.
      })
      .catch((error: unknown) =>
        finish({
          ok: false,
          reason: /cancel|reject|denied/i.test(error instanceof Error ? error.message : "")
            ? "cancelled"
            : "failed",
          message: error instanceof Error ? error.message : "Wallet connection failed",
        }),
      );
  });
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
    // `walletconnect` reports itself present unconditionally (see REMOTE_ONLY_PROVIDERS), so it
    // is last in the order and reached only when nothing local answered — at which point the
    // pairing dialog is the route, and a genuine one.
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
  // Loaded, configured, AND not known-rejected: an app id CSPR.click refuses leaves the SDK
  // half-initialised with no signing frame, and pretending that is "available" was this app's
  // production posture for a while. See the app-id rejection block above.
  available: () =>
    csprClick() !== null && csprClickAppId() !== null && csprClickAppIdRejection() === null,
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
  async connect(options: ConnectOptions = {}): Promise<ConnectOutcome> {
    const sdk = csprClick();
    if (!sdk) return { ok: false, reason: "failed", message: "CSPR.click is not loaded" };
    try {
      const transport = detectWalletTransport(sdk);
      if (transport.provider === null && transport.reason === "no-wallet") {
        return { ok: false, reason: "no-wallet", message: transport.message };
      }
      const provider = transport.provider;
      // WalletConnect reaches a wallet on another device, so it cannot be awaited like an
      // extension: it needs the pairing UI and the event channel. Everything else goes the direct
      // route below, redirect fix and settle-poll included.
      if (provider !== null && providerNeedsPairing(provider)) {
        return await connectViaPairing(sdk, provider, options);
      }
      if (provider !== null && sdk.connect) {
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
        const account = await accountAfterConnect(sdk, provider, result, {
          attempts: viaExtension ? undefined : 1,
        });
        return account
          ? { ok: true, account }
          : // The wallet was there and we got nothing back: the popup was closed, or the request
            // was declined. Not an error to shout about.
            { ok: false, reason: "cancelled", message: "Wallet connection was not completed" };
      }
      if (!sdk.signIn) {
        return { ok: false, reason: "no-wallet", message: NO_WALLET_MESSAGE };
      }
      const result = await sdk.signIn();
      // Some versions resolve the account; others resolve nothing and expose it separately.
      const account =
        accountFromCsprClick(result) ?? accountFromCsprClick(sdk.getActiveAccount?.());
      return account
        ? { ok: true, account }
        : { ok: false, reason: "cancelled", message: "Wallet sign-in was not completed" };
    } catch (err) {
      return {
        ok: false,
        reason: "failed",
        message: err instanceof Error ? err.message : "Wallet connection failed",
      };
    }
  },
  async disconnect(): Promise<void> {
    try {
      await csprClick()?.disconnect?.();
    } catch {
      /* the local session is cleared by the caller regardless */
    }
  },
  /**
   * Sign and submit through the connected wallet. `send()` never throws for a declined signature
   * — it resolves `{cancelled:true}` — so a cancel is reported as a cancel and NEVER retried
   * against the operator-signed route. Falling back there would place a bet the visitor had just
   * refused to sign, with someone else's money.
   */
  async sendTransaction(transactionJson: string, publicKey: string): Promise<SendTransactionOutcome> {
    const sdk = csprClick();
    if (!sdk?.send) {
      return { ok: false, reason: "failed", message: "This wallet cannot sign transactions" };
    }
    try {
      const res = await sdk.send(transactionJson, publicKey);
      if (res?.cancelled) {
        return { ok: false, reason: "cancelled", message: "Signature declined in the wallet" };
      }
      if (res?.error) return { ok: false, reason: "failed", message: res.error };
      const hash = res?.transactionHash ?? res?.deployHash;
      if (typeof hash !== "string" || hash.length === 0) {
        return { ok: false, reason: "failed", message: "The wallet returned no transaction hash" };
      }
      return { ok: true, transactionHash: hash };
    } catch (err) {
      return {
        ok: false,
        reason: "failed",
        message: err instanceof Error ? err.message : "Signing failed",
      };
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
