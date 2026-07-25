/**
 * Loads the CSPR.click browser bundle — the missing half of the wallet integration.
 *
 * The connector seam (`lib/wallet-connector.ts`) has been complete for a while: it reads
 * `window.csprclick`, normalises the account, and falls back to a labelled demo wallet. But
 * nothing ever loaded the bundle, so `window.csprclick` was never defined, `available()` was
 * always false, and every visitor got the demo pill no matter what was configured. A seam with
 * nothing plugged into it is indistinguishable from no integration at all.
 *
 * Env-gated by design: with no `NEXT_PUBLIC_CSPR_CLICK_APP_ID` this renders nothing and ships no
 * third-party script to anyone. Setting the app id is the entire activation step — no rebuild of
 * any caller, because the store's shape does not change between the two.
 */

import Script from "next/script";
import { DEFAULT_NETWORK } from "@/config/network";
import {
  csprClickAppIdsFromEnv,
  csprClickContentMode,
  resolveCsprClickAppId,
} from "@/config/csprclick";

/** The CDN bundle CSPR.click documents for drop-in integration. */
const CSPR_CLICK_BUNDLE = "https://cdn.jsdelivr.net/npm/@make-software/csprclick-ui@1/dist/csprclick-ui.min.js";

/** Wallet providers offered in the picker. */
const PROVIDERS = ["casper-wallet", "ledger", "casperdash", "metamask-snap", "torus"];

export function CsprClickScript() {
  // CSPR.click issues a different app id per network, and both it and the content mode are
  // resolved from the network config — never from an env var read in this file. See
  // config/csprclick.ts for why (the old `NEXT_PUBLIC_CASPER_NETWORK` read was a phantom).
  const appId = resolveCsprClickAppId(DEFAULT_NETWORK, csprClickAppIdsFromEnv());
  // No app id → no script tag at all. An unconfigured deployment must not pull a third-party
  // bundle into every visitor's page just to fall back to the demo wallet anyway.
  if (!appId) return null;

  const contentMode = csprClickContentMode(DEFAULT_NETWORK);

  return (
    <>
      <Script
        id="csprclick-config"
        strategy="beforeInteractive"
        // Published before the bundle so the SDK can read it, and so `csprClickAppId()` resolves
        // even in a build where the public env was not inlined.
        dangerouslySetInnerHTML={{
          __html: `window.__CSPR_CLICK_APP_ID__=${JSON.stringify(appId)};window.__CSPR_CLICK_OPTIONS__={appName:"Hunch on Casper",contentMode:${JSON.stringify(contentMode)},providers:${JSON.stringify(PROVIDERS)}};`,
        }}
      />
      <Script id="csprclick-bundle" src={CSPR_CLICK_BUNDLE} strategy="afterInteractive" />
    </>
  );
}
