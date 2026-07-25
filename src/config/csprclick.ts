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
