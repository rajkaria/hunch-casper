/**
 * Loads the CSPR.click browser bundle — the missing half of the wallet integration.
 *
 * The connector seam (`lib/wallet-connector.ts`) has been complete for a while: it reads
 * `window.csprclick`, normalises the account, and falls back to a labelled demo wallet. But
 * nothing ever loaded the bundle, so `window.csprclick` was never defined, `available()` was
 * always false, and every visitor got the demo pill no matter what was configured. A seam with
 * nothing plugged into it is indistinguishable from no integration at all.
 *
 * Env-gated by design: with no app id this renders nothing and ships no third-party script to
 * anyone.
 *
 * The bundle URL is **operator-supplied and has no default**. The URL hardcoded here previously
 * 404'd — see `config/csprclick.ts` for the evidence — so an app id alone left the app configured
 * and inert *and* made every visitor's page fetch a dead URL. Emitting the config script without a
 * loader is the honest state: the app id is published, `/api/health` reports `no-bundle`, and
 * nothing 404s.
 */

import Script from "next/script";
import { DEFAULT_NETWORK } from "@/config/network";
import {
  csprClickAppIdsFromEnv,
  csprClickBundleUrl,
  csprClickContentMode,
  resolveCsprClickAppId,
} from "@/config/csprclick";

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
  const bundleUrl = csprClickBundleUrl();

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
      {bundleUrl ? (
        <Script id="csprclick-bundle" src={bundleUrl} strategy="afterInteractive" />
      ) : null}
    </>
  );
}
