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

/** The slice of the CSPR.click global this app uses. */
export interface CsprClickLike {
  signIn?: () => Promise<unknown>;
  disconnect?: () => Promise<unknown>;
  getActiveAccount?: () => { public_key?: string; publicKey?: string; name?: string } | null;
}

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

export const csprClickConnector: WalletConnector = {
  id: "csprclick",
  available: () => csprClick() !== null && csprClickAppId() !== null,
  async connect(): Promise<WalletAccountLike | null> {
    const sdk = csprClick();
    if (!sdk?.signIn) return null;
    try {
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
