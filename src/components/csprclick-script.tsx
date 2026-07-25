/**
 * Loads the CSPR.click browser SDK — the missing half of the wallet integration.
 *
 * The connector seam (`lib/wallet-connector.ts`) has been complete for a while: it reads
 * `window.csprclick`, normalises the account, and falls back to a labelled demo wallet. But
 * nothing ever loaded the SDK, so `window.csprclick` was never defined, `available()` was always
 * false, and every visitor got the demo pill no matter what was configured.
 *
 * Two things had to be true for that to change, and only one of them was a URL:
 *
 *  1. A loader that exists. It does — `cdn.cspr.click`, verified by download, not by guess.
 *  2. `window.csprClickSDKAsyncInit` defined **before** the loader runs. The SDK installs
 *     `window.csprclick` only when it finds that function, and otherwise logs "CSPRClickSDK not
 *     requested." and returns. See `config/csprclick.ts` for the verbatim source line.
 *
 * Ordering is therefore load-bearing, and it is what the two strategies below buy: the config is
 * `beforeInteractive` (inlined into the document head, runs during parse) and the SDK is
 * `afterInteractive`. The reverse order is not a race that usually works — it is a wallet that
 * never initialises.
 *
 * Env-gated by design: with no app id this renders nothing and ships no third-party script to
 * anyone.
 */

import Script from "next/script";
import { DEFAULT_NETWORK } from "@/config/network";
import {
  csprClickAppIdsFromEnv,
  csprClickBootstrapScript,
  csprClickBundleUrl,
  csprClickInitOptions,
  resolveCsprClickAppId,
} from "@/config/csprclick";

export function CsprClickScript() {
  // CSPR.click issues a different app id per network, and the chain it signs against is resolved
  // from the network config — never from an env var read in this file. See config/csprclick.ts for
  // why (the old `NEXT_PUBLIC_CASPER_NETWORK` read was a phantom).
  const appId = resolveCsprClickAppId(DEFAULT_NETWORK, csprClickAppIdsFromEnv());
  // No app id → no script tag at all. An unconfigured deployment must not pull a third-party
  // bundle into every visitor's page just to fall back to the demo wallet anyway.
  if (!appId) return null;

  const bundleUrl = csprClickBundleUrl();

  return (
    <>
      <Script
        id="csprclick-config"
        strategy="beforeInteractive"
        dangerouslySetInnerHTML={{
          __html: csprClickBootstrapScript(csprClickInitOptions(DEFAULT_NETWORK, appId)),
        }}
      />
      {bundleUrl ? (
        <Script id="csprclick-sdk" src={bundleUrl} strategy="afterInteractive" />
      ) : null}
    </>
  );
}
