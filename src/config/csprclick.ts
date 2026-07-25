/**
 * CSPR.click configuration — the wallet's network-specific values, resolved in one place.
 *
 * CSPR.click issues a **different app id per network**, and boots its bundle in a per-network
 * content mode. Both are exactly the kind of value `config/network.ts` exists to own: "everything
 * that differs between Testnet and Mainnet lives here. Nothing else in the app should hardcode a
 * network-specific value."
 *
 * The bootstrap script previously derived its content mode from `NEXT_PUBLIC_CASPER_NETWORK`, a
 * variable defined nowhere in this repo — not in `.env.example`, not on the deployment. It always
 * evaluated to "testnet": right by accident, and silently wrong the moment the default network
 * flips. Pure functions here, so both behaviours are unit-tested without a browser.
 */

import type { CasperNetwork } from "@/config/network";

/** The configured ids, as read from the environment. Any of them may be absent. */
export interface CsprClickAppIds {
  testnet?: string;
  mainnet?: string;
  /** Legacy single-id variable, kept working: it is what `docs/OPS.md` §3b documents. */
  shared?: string;
}

function present(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * The app id for a network: its own if configured, else the shared one, else `null`.
 *
 * One network's id is NEVER used for the other. An id minted for mainnet would boot the SDK
 * against the wrong content mode, and a wallet that connects to the wrong chain is worse than the
 * labelled demo account the app falls back to.
 */
export function resolveCsprClickAppId(network: CasperNetwork, ids: CsprClickAppIds): string | null {
  return present(network === "mainnet" ? ids.mainnet : ids.testnet) ?? present(ids.shared);
}

/** CSPR.click's `contentMode`, which is simply the network the wallet should sign against. */
export function csprClickContentMode(network: CasperNetwork): "testnet" | "mainnet" {
  return network === "mainnet" ? "mainnet" : "testnet";
}

/**
 * The ids as configured on THIS deployment. Read as static `process.env.X` member expressions on
 * purpose — Next.js only inlines `NEXT_PUBLIC_*` into the bundle when it can see the literal key,
 * so a dynamic `process.env[key]` lookup would come back undefined in the browser.
 */
export function csprClickAppIdsFromEnv(): CsprClickAppIds {
  return {
    testnet: process.env.NEXT_PUBLIC_TESTNET_CSPR_CLICK_APP_ID,
    mainnet: process.env.NEXT_PUBLIC_MAINNET_CSPR_CLICK_APP_ID,
    shared: process.env.NEXT_PUBLIC_CSPR_CLICK_APP_ID,
  };
}

/**
 * The URL of the browser bundle that installs `window.csprclick`. **There is no default**, and
 * that is the point.
 *
 * This file used to hardcode `cdn.jsdelivr.net/npm/@make-software/csprclick-ui@1/dist/
 * csprclick-ui.min.js`. Probed 2026-07-25: it **404s**, and always did — no `1.x` line of that
 * package was ever published (npm's oldest is `2.0.0-beta.7`, latest `2.1.0`), and no version of
 * it ships a UMD/IIFE build at all. `@make-software/csprclick-ui` is a **React component library**
 * with a hard peer dependency on React 18.3.1 (this app is on 19.2.4), and its sibling
 * `@make-software/csprclick-core-client@1.11.0` publishes *only* `.d.ts` declarations — no runtime
 * JavaScript whatsoever, despite naming `./index.js` as its `main`.
 *
 * So the "drop-in browser bundle" this integration was built around does not exist on npm. A
 * guessed CDN path would be the third time this codebase shipped a parser or URL asserted rather
 * than verified. Instead the operator supplies the exact URL their CSPR.click console gives them,
 * and until they do, **no script tag is emitted and no visitor's page 404s**.
 */
export function csprClickBundleUrl(): string | null {
  return present(process.env.NEXT_PUBLIC_CSPR_CLICK_BUNDLE_URL);
}

/** What the wallet can actually do right now, given what is configured. */
export type WalletPosture =
  /** No app id: the demo wallet, deliberately and visibly. */
  | "unconfigured"
  /** App id set but no loader URL — configured and inert. The failure this repo already shipped. */
  | "no-bundle"
  /** Both halves present: real signing is possible. */
  | "armed";

export function walletPosture(appId: string | null, bundleUrl: string | null): WalletPosture {
  if (appId === null) return "unconfigured";
  return bundleUrl === null ? "no-bundle" : "armed";
}
