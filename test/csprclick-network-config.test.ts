/**
 * The CSPR.click app id is a network-specific value, so it lives where every other one does.
 *
 * The bootstrap script used to derive its `contentMode` from `NEXT_PUBLIC_CASPER_NETWORK` — a
 * variable that exists nowhere: not in `.env.example`, not on the deployment, not anywhere else in
 * `src/`. It therefore always evaluated to "testnet". Correct by accident today, and silently wrong
 * the moment the default network flips, which is the precise failure mode `src/config/network.ts`
 * exists to prevent ("everything that differs between them lives here").
 *
 * CSPR.click also issues a *different* app id per network, so one shared id cannot serve both.
 */

import { describe, expect, it } from "vitest";
import {
  CSPR_CLICK_PROVIDERS,
  csprClickBootstrapScript,
  csprClickBundleUrl,
  csprClickChainName,
  csprClickContentMode,
  csprClickInitOptions,
  DEFAULT_CSPR_CLICK_SDK_URL,
  resolveCsprClickAppId,
  walletPosture,
} from "@/config/csprclick";

describe("app id resolution is per network, with a shared fallback", () => {
  it("prefers the network-specific id", () => {
    expect(
      resolveCsprClickAppId("testnet", { testnet: "test-id", mainnet: "main-id", shared: "shared-id" }),
    ).toBe("test-id");
    expect(
      resolveCsprClickAppId("mainnet", { testnet: "test-id", mainnet: "main-id", shared: "shared-id" }),
    ).toBe("main-id");
  });

  it("falls back to the shared id when the network-specific one is unset", () => {
    expect(resolveCsprClickAppId("mainnet", { shared: "shared-id" })).toBe("shared-id");
  });

  it("never leaks one network's id to the other", () => {
    // A mainnet-only id must not activate the wallet on testnet: signing against the wrong
    // content mode is worse than falling back to the labelled demo account.
    expect(resolveCsprClickAppId("testnet", { mainnet: "main-id" })).toBeNull();
  });

  it("treats an empty string as unset", () => {
    expect(resolveCsprClickAppId("testnet", { testnet: "", shared: "" })).toBeNull();
  });

  it("returns null when nothing is configured — no script is served", () => {
    expect(resolveCsprClickAppId("testnet", {})).toBeNull();
  });
});

describe("contentMode is a presentation mode, and the network is chainName", () => {
  // Read out of the shipped SDK: `const m = {POPUP:"popup", IFRAME:"iframe"}` and
  // `const y = {MAINNET:"casper", TESTNET:"casper-test"}`. The old code sent the *network* as
  // contentMode, a value in neither enum, and never sent chainName at all.
  it("only ever emits a real contentMode member", () => {
    expect(["iframe", "popup"]).toContain(csprClickContentMode());
  });

  it("defaults to iframe, because popup mode opens a page CSPR.click deleted", () => {
    // Probed 2026-07-25 against accounts.cspr.click, the SDK's own default host:
    //   /signin.html         404  ← the page popup mode opens
    //   /v2.1/index.html     200  ← the core frame iframe mode installs
    //   /wallet-ui/sign.html 200  ← the signing UI
    // Neither mode's signIn() is usable without CSPR.click's React package, which is why the
    // connector drives connect(providerKey) instead; but the surviving frames decide this value.
    expect(csprClickContentMode()).toBe("iframe");
    expect(csprClickInitOptions("testnet", "app-123").contentMode).toBe("iframe");
  });

  it("carries the network in chainName, per network", () => {
    expect(csprClickChainName("testnet")).toBe("casper-test");
    expect(csprClickChainName("mainnet")).toBe("casper");
  });

  it("never offers a provider the SDK does not define", () => {
    // `casperdash` and `torus` were offered for months; neither string exists in SDK 2.1, so
    // `init`'s `providers.map` dropped both on the floor.
    expect([...CSPR_CLICK_PROVIDERS]).toEqual([
      "casper-wallet",
      "ledger",
      "metamask-snap",
      "walletconnect",
    ]);
  });
});

describe("the bootstrap defines the one global the SDK actually looks for", () => {
  const script = csprClickBootstrapScript(csprClickInitOptions("testnet", "app-123"));

  it("defines csprClickSDKAsyncInit — without it the SDK loads and does nothing", () => {
    // The SDK's last statement: typeof window.csprClickSDKAsyncInit == "function"
    //   ? (window.csprclick = new Sdk, window.csprClickSDKAsyncInit())
    //   : console.log("CSPRClickSDK not requested.")
    expect(script).toContain("window.csprClickSDKAsyncInit=function()");
    expect(script).toContain("window.csprclick.init(");
  });

  it("passes the app id and the right chain into init", () => {
    expect(script).toContain('"appId":"app-123"');
    expect(script).toContain('"chainName":"casper-test"');
  });

  it("never emits the network as contentMode again", () => {
    expect(script).not.toContain('"contentMode":"testnet"');
    expect(script).not.toContain('"contentMode":"mainnet"');
  });

  it("is a single statement-terminated line — it is inlined into the document head", () => {
    expect(script.endsWith(";")).toBe(true);
    expect(script).not.toContain("\n");
  });
});

describe("the bundle URL defaults to the verified upstream loader", () => {
  it("defaults to the CDN path the official UI bundle builds for itself", () => {
    // Probed 2026-07-25: HTTP 200, 1,439,314 bytes, text/javascript.
    expect(DEFAULT_CSPR_CLICK_SDK_URL).toBe("https://cdn.cspr.click/latest/csprclick-sdk-2.1.js");
    expect(csprClickBundleUrl()).toBe(DEFAULT_CSPR_CLICK_SDK_URL);
  });

  it("posture is 'unconfigured' with no app id — the demo wallet, visibly", () => {
    expect(walletPosture(null, null)).toBe("unconfigured");
    expect(walletPosture(null, "https://cdn.example/bundle.js")).toBe("unconfigured");
  });

  it("still reports 'no-bundle' if an operator blanks the loader", () => {
    // Unreachable through `csprClickBundleUrl()` now that a default exists, but the health check
    // reads this function, and "configured but inert" must stay nameable.
    expect(walletPosture("app-123", null)).toBe("no-bundle");
  });

  it("posture is 'armed' when both halves are present", () => {
    expect(walletPosture("app-123", "https://cdn.example/bundle.js")).toBe("armed");
  });
});
