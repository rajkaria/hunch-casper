/**
 * The wallet integration's activation contract.
 *
 * The connector seam was complete for a long time and still every visitor saw the demo pill,
 * because nothing loaded the CSPR.click bundle: `window.csprclick` was never defined, so
 * `available()` was always false. These tests pin BOTH halves — the seam and the thing that
 * activates it — so a complete-looking integration cannot be inert again.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import {
  activeConnector,
  csprClickConnector,
  demoConnector,
  csprClickAppId,
  accountFromCsprClick,
  DEMO_ACCOUNT,
} from "@/lib/wallet-connector";

const w = globalThis as unknown as {
  window?: { csprclick?: unknown; __CSPR_CLICK_APP_ID__?: string };
};

afterEach(() => {
  delete w.window;
  vi.unstubAllEnvs();
});

function withSdk(sdk: unknown, appId = "app-123") {
  w.window = { csprclick: sdk, __CSPR_CLICK_APP_ID__: appId };
}

describe("activation requires BOTH the bundle and an app id", () => {
  it("falls back to demo with neither", () => {
    expect(activeConnector().id).toBe("demo");
  });

  it("falls back to demo with an app id but no bundle", () => {
    // This is the state production shipped in: configured, and still inert.
    w.window = { __CSPR_CLICK_APP_ID__: "app-123" };
    expect(activeConnector().id).toBe("demo");
  });

  it("falls back to demo with a bundle but no app id", () => {
    w.window = { csprclick: { signIn: async () => null } };
    expect(activeConnector().id).toBe("demo");
  });

  it("activates when both are present", () => {
    withSdk({ signIn: async () => ({ public_key: "01abc" }) });
    expect(activeConnector().id).toBe("csprclick");
  });
});

describe("app id resolution", () => {
  it("prefers the build-time public env", () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "from-env");
    expect(csprClickAppId()).toBe("from-env");
  });

  it("falls back to the bootstrap global", () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "");
    w.window = { __CSPR_CLICK_APP_ID__: "from-script" };
    expect(csprClickAppId()).toBe("from-script");
  });

  it("is null when neither is set", () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "");
    expect(csprClickAppId()).toBeNull();
  });
});

describe("account normalisation", () => {
  it("reads snake_case and camelCase, which the SDK has used across versions", () => {
    expect(accountFromCsprClick({ public_key: "01a" })?.publicKey).toBe("01a");
    expect(accountFromCsprClick({ publicKey: "01b" })?.publicKey).toBe("01b");
  });

  it("carries the wallet's name as the label when it has one", () => {
    expect(accountFromCsprClick({ public_key: "01a", name: "Casper Wallet" })?.label).toBe(
      "Casper Wallet",
    );
  });

  it("rejects a shape with no usable key rather than inventing one", () => {
    for (const junk of [null, undefined, {}, { public_key: "" }, { public_key: 42 }, "x"]) {
      expect(accountFromCsprClick(junk)).toBeNull();
    }
  });
});

describe("connect behaviour", () => {
  it("a cancelled sign-in leaves the app disconnected, not broken", async () => {
    withSdk({
      signIn: async () => {
        throw new Error("user cancelled");
      },
    });
    await expect(csprClickConnector.connect()).resolves.toMatchObject({ ok: false });
  });

  it("reads the account from getActiveAccount when signIn resolves nothing", async () => {
    withSdk({
      signIn: async () => undefined,
      getActiveAccount: () => ({ public_key: "01deadbeef", name: "Ledger" }),
    });
    const outcome = await csprClickConnector.connect();
    expect(outcome.ok && outcome.account.publicKey).toBe("01deadbeef");
  });

  it("the demo account is obviously fake, never a plausible key", () => {
    // A plausible-looking fake would be strictly worse than one that announces itself.
    expect(DEMO_ACCOUNT.publicKey).toContain("demo");
    expect(DEMO_ACCOUNT.label).toMatch(/demo/i);
  });

  it("the demo connector is always available so betting works with zero credentials", async () => {
    expect(demoConnector.available()).toBe(true);
    expect(await demoConnector.connect()).toEqual({ ok: true, account: DEMO_ACCOUNT });
    // And it has no key of its own, which is what sends the bet path to the operator-signed route
    // instead of pretending the placeholder can sign.
    expect(demoConnector.sendTransaction).toBeUndefined();
  });
});
