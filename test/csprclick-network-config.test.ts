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
import { resolveCsprClickAppId, csprClickContentMode } from "@/config/csprclick";

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

describe("content mode tracks the network, not a phantom env var", () => {
  it("maps each network to its CSPR.click content mode", () => {
    expect(csprClickContentMode("testnet")).toBe("testnet");
    expect(csprClickContentMode("mainnet")).toBe("mainnet");
  });
});
