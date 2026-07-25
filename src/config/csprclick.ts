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

import { getNetworkConfig, type CasperNetwork } from "@/config/network";

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

/**
 * `contentMode` is **not the network**. Read from the shipped SDK (2.1.0), the enum is:
 *
 *     const m = { POPUP: "popup", IFRAME: "iframe" };
 *
 * — how the wallet UI is *presented*, nothing to do with which chain is signed against. This file
 * previously passed `"testnet"`/`"mainnet"` here, which is not a member of that enum: the SDK's
 * `init` does `this.contentMode = e.contentMode ? e.contentMode : IFRAME`, so a bogus truthy value
 * is stored verbatim and every later `contentMode == POPUP` comparison silently answers false. The
 * network is carried by `chainName` instead (see below), which we were never sending at all.
 */
export type CsprClickContentMode = "iframe" | "popup";

/**
 * `iframe`, the SDK's own default — because the alternative is verifiably broken upstream.
 *
 * `signIn()` in the shipped SDK branches on exactly this value:
 *
 *     signIn(){ this.actionState = SIGN_IN;
 *       if (this.contentMode == POPUP) { window.open(`${host}/signin.html?app=…`, "cc-signin-popup", …) }
 *       else { this.emit(SIGN_IN, {provider: undefined}) } }
 *
 * Neither branch is usable on its own, which is why `wallet-connector.ts` drives `connect()`
 * instead of `signIn()` — see the note there. What settles the value here is which hosted pages
 * still exist. Probed 2026-07-25 against `https://accounts.cspr.click`, the SDK's own default host:
 *
 *     /signin.html            404 (nginx)   ← the page POPUP mode opens
 *     /v2.1/index.html        200           ← the hidden core frame IFRAME mode installs
 *     /wallet-ui/sign.html    200           ← the signing UI, used to approve a transaction
 *
 * So CSPR.click's SDK 2.1 ships a popup mode pointing at a page they have since deleted: choosing
 * `popup` buys a 404 in a 480×480 window. `iframe` keeps the core frame and the signing UI, both
 * alive, and the account picker is ours to render.
 */
export function csprClickContentMode(): CsprClickContentMode {
  return process.env.NEXT_PUBLIC_CSPR_CLICK_CONTENT_MODE === "popup" ? "popup" : "iframe";
}

/**
 * The chain the wallet signs against. `{ MAINNET: "casper", TESTNET: "casper-test" }` in the SDK —
 * the same two strings `config/network.ts` already owns as `chainName`, so it is read from there
 * rather than re-derived. This is the value that actually makes the wallet network-correct.
 */
export function csprClickChainName(network: CasperNetwork): "casper-test" | "casper" {
  return getNetworkConfig(network).chainName;
}

/**
 * Wallet providers offered in the picker. Exactly the four the shipped SDK defines
 * (`casper-wallet`, `ledger`, `metamask-snap`, `walletconnect`). The list this app used to send
 * also carried `casperdash` and `torus`; neither string appears anywhere in SDK 2.1, and `init`
 * does `e.providers.map(...)` matching against its own enum, so both were silently dropped —
 * offered in our config, absent from the picker.
 */
export const CSPR_CLICK_PROVIDERS = [
  "casper-wallet",
  "ledger",
  "metamask-snap",
  "walletconnect",
] as const;

/**
 * WalletConnect inside CSPR.click needs its own credential, and the SDK is unforgiving about it.
 * The provider's constructor, verbatim from the shipped bundle:
 *
 *     constructor(e){ ...; if(!e.options.walletConnect) throw new Error("WalletConnect settings not present");
 *       this.wcSettings = e.options.walletConnect }
 *     async initializeWCClient(){ ... rf.init({ relayUrl: this.wcSettings.relayUrl || "wss://relay.walletconnect.com",
 *       projectId: this.wcSettings.projectId, ... }) }
 *
 * So without a `walletConnect: { projectId }` block in `init(...)`, `getProviderInstance` throws,
 * the SDK logs "Error getting provider instance", and a desktop visitor with no extension gets
 * "Could not establish a connection with the provider" — a QR flow that can never start. The
 * project id is minted at WalletConnect Cloud (cloud.reown.com), is public like the app id, and
 * arrives via `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`. Absent, the connector stops *offering*
 * WalletConnect at all (see `wallet-connector.ts`) — an install prompt is honest, a doomed
 * pairing attempt is not.
 */
export function csprClickWalletConnectProjectId(): string | null {
  return present(process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID);
}

/** The options object handed to `window.csprclick.init(...)`. */
export interface CsprClickInitOptions {
  appName: string;
  appId: string;
  contentMode: CsprClickContentMode;
  chainName: "casper-test" | "casper";
  providers: readonly string[];
  /** Present only when a WalletConnect Cloud project id is configured — see above. */
  walletConnect?: { projectId: string };
}

export function csprClickInitOptions(network: CasperNetwork, appId: string): CsprClickInitOptions {
  const wcProjectId = csprClickWalletConnectProjectId();
  return {
    appName: "Hunch on Casper",
    appId,
    contentMode: csprClickContentMode(),
    chainName: csprClickChainName(network),
    providers: CSPR_CLICK_PROVIDERS,
    ...(wcProjectId !== null ? { walletConnect: { projectId: wcProjectId } } : {}),
  };
}

/**
 * The bootstrap the SDK actually requires, and the reason the wallet stayed dead.
 *
 * The last line of `csprclick-sdk-2.1.js` is, verbatim:
 *
 *     !function(e){"function"==typeof e.csprClickSDKAsyncInit
 *       ? (e.csprclick = new _h, e.csprClickSDKAsyncInit())
 *       : console.log("CSPRClickSDK not requested.")}(window)
 *
 * So `window.csprclick` is installed **only if `window.csprClickSDKAsyncInit` is already a function
 * when the bundle executes** — otherwise the SDK loads a megabyte of JavaScript and deliberately
 * does nothing. This app instead published `window.__CSPR_CLICK_APP_ID__` and
 * `window.__CSPR_CLICK_OPTIONS__`, two globals that appear **zero** times in the SDK. Supplying the
 * loader URL alone would therefore have changed nothing: still no `window.csprclick`, still
 * `available() === false`, still the demo pill — with a 1.4 MB download added to every page.
 */
export function csprClickBootstrapScript(options: CsprClickInitOptions): string {
  return (
    `window.csprClickSDKAsyncInit=function(){window.csprclick.init(${JSON.stringify(options)})};` +
    // Kept for `csprClickAppId()` in the connector, which reads it when the public env was not
    // inlined into the bundle. It is ours, not the SDK's — the SDK never looks at it.
    `window.__CSPR_CLICK_APP_ID__=${JSON.stringify(options.appId)};` +
    // Same contract for the WalletConnect project id: the connector consults it to decide whether
    // offering the pairing route can possibly work (see `walletConnectConfigured`).
    (options.walletConnect
      ? `window.__CSPR_CLICK_WC_PROJECT_ID__=${JSON.stringify(options.walletConnect.projectId)};`
      : "")
  );
}

/**
 * The verified loader. Probed 2026-07-25: **HTTP 200, 1,439,314 bytes, `text/javascript`**.
 *
 * This is the URL the official UI bundle builds for itself at runtime —
 * `` `${options.csprclickHost || "https://cdn.cspr.click/latest"}/csprclick-sdk-${"2.1"}.js` `` —
 * so it is upstream's own path, not a guess. It is the plain SDK: it installs `window.csprclick`
 * and nothing else, with no React peer dependency (the npm `@make-software/csprclick-ui` package
 * is a React 18.3.1 component library that mounts a navbar into `#csprclick-navbar`, and this app
 * runs React 19 — see the note on `csprClickBundleUrl`).
 */
export const DEFAULT_CSPR_CLICK_SDK_URL = "https://cdn.cspr.click/latest/csprclick-sdk-2.1.js";

/**
 * The registration record the SDK fetches before anything else works. First thing `init()` does
 * after installing its listeners, verbatim from the shipped bundle:
 *
 *     fetch(`${host}/application/${this.appId}.json`, {credentials:"include"})
 *       .then(e => (this.digestAuth = e.headers.get("WWW-Authenticate") || "", e.json()))
 *       .then(e => { this.appSettings = {...e, menu_items: e.menu_items.map(...)}; ...
 *         this.getClickFrame(this.digestAuth) })
 *
 * An app id CSPR.click has never issued gets `401 {"error":{"message":"wrong application id"}}`
 * back — a body with no `menu_items` — so `.map` throws inside the promise chain, nothing catches
 * it, and `getClickFrame` never runs. The SDK emits no event for this. It just stops: the signing
 * frame is never installed, `connect()` half-works against the extension, `send()` can never work,
 * and the only witness is an uncaught TypeError in the console. Probed 2026-07-26 with the then-
 * deployed id; that is not a hypothetical, it is what production was doing.
 *
 * This URL is therefore the activation's ground truth, and both probes below (client-side in
 * `wallet-connector.ts`, server-side in `lib/health.ts`) ask it the same question the SDK will:
 * "does this app id exist?" — because the SDK's own answer to a "no" is to die silently.
 */
export const CSPR_CLICK_ACCOUNTS_HOST = "https://accounts.cspr.click";

export function csprClickApplicationUrl(appId: string): string {
  return `${CSPR_CLICK_ACCOUNTS_HOST}/api/application/${appId}.json`;
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
 * The URL of the browser bundle that installs `window.csprclick`.
 *
 * The previous revision of this file concluded that no such bundle existed and refused to ship a
 * default. That conclusion was half right, and the half that was wrong kept the wallet dead.
 *
 * Right: `cdn.jsdelivr.net/npm/@make-software/csprclick-ui@1/dist/csprclick-ui.min.js` 404s and
 * always did — no `1.x` of that package was ever published (npm's oldest is `2.0.0-beta.7`, latest
 * `2.1.0`), no version ships a UMD/IIFE build, it is a React component library pinned to React
 * 18.3.1 (this app is on React 19), and its sibling `@make-software/csprclick-core-client@1.11.0`
 * is a 5.7 KB tarball of **nothing but `.d.ts` files** despite naming `./index.js` as `main`. Its
 * own README says so: "contains type definitions for using CSPR.click SDK".
 *
 * Wrong: "therefore the drop-in bundle does not exist." It is simply not on npm. Upstream serves it
 * from their own CDN, which is where the official UI bundle fetches it from at runtime, and which
 * the `.d.ts`-only package's README points at. Verified by download, not by assertion — see
 * `DEFAULT_CSPR_CLICK_SDK_URL`. A default that has been fetched and read is not the same class of
 * claim as the guessed URL that motivated removing it, so the default is back and the wallet works
 * out of the box. `NEXT_PUBLIC_CSPR_CLICK_BUNDLE_URL` still overrides, for a pinned or self-hosted
 * copy.
 */
export function csprClickBundleUrl(): string | null {
  return present(process.env.NEXT_PUBLIC_CSPR_CLICK_BUNDLE_URL) ?? DEFAULT_CSPR_CLICK_SDK_URL;
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
