/**
 * The wallet connector seam.
 *
 * The behaviour worth pinning: the app falls back to the labelled demo account unless CSPR.click
 * is BOTH loaded and configured. An app id with no SDK, or an SDK with no app id, cannot complete
 * a sign-in — and a Connect button that does nothing is worse than one that honestly connects a
 * demo account, because the second at least says what it is.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  DEMO_ACCOUNT,
  accountFromCsprClick,
  activeConnector,
  csprClickAppId,
  csprClickConnector,
  demoConnector,
  type CsprClickLike,
} from "@/lib/wallet-connector";
import { GET as boardsGET } from "@/app/api/boards/route";

function installSdk(sdk: CsprClickLike | undefined): void {
  (globalThis as unknown as { window?: unknown }).window ??= {};
  (globalThis as unknown as { window: { csprclick?: CsprClickLike } }).window.csprclick = sdk;
}

afterEach(() => {
  vi.unstubAllEnvs();
  const w = (globalThis as unknown as { window?: { csprclick?: unknown } }).window;
  if (w) delete w.csprclick;
});

describe("accountFromCsprClick", () => {
  it("reads both the snake_case and camelCase key fields the SDK has used", () => {
    // A wallet that silently fails to connect because a field was renamed is a bad afternoon.
    expect(accountFromCsprClick({ public_key: "01aa", name: "Alice" })).toEqual({
      publicKey: "01aa",
      label: "Alice",
    });
    expect(accountFromCsprClick({ publicKey: "01bb" })).toEqual({ publicKey: "01bb", label: "CSPR.click" });
  });

  it("rejects anything without a usable key", () => {
    for (const junk of [null, undefined, 42, {}, { public_key: "" }, { public_key: 7 }]) {
      expect(accountFromCsprClick(junk)).toBeNull();
    }
  });
});

describe("connector selection", () => {
  it("falls back to the demo connector when no SDK is present", () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    expect(csprClickConnector.available()).toBe(false);
    expect(activeConnector().id).toBe("demo");
  });

  it("falls back when the SDK is present but no app id is configured", () => {
    installSdk({ signIn: async () => ({ public_key: "01aa" }) });
    expect(csprClickConnector.available()).toBe(false);
    expect(activeConnector().id).toBe("demo");
  });

  it("uses CSPR.click only when both the SDK and an app id are present", () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({ signIn: async () => ({ public_key: "01aa", name: "Alice" }) });
    expect(csprClickAppId()).toBe("app-123");
    expect(activeConnector().id).toBe("csprclick");
  });
});

describe("connecting", () => {
  it("the demo connector resolves the labelled placeholder", async () => {
    const account = await demoConnector.connect();
    expect(account).toEqual(DEMO_ACCOUNT);
    // Obviously fake on sight: a plausible-looking fake key would be strictly worse.
    expect(DEMO_ACCOUNT.publicKey).toContain("demo");
  });

  it("returns the signed-in account from CSPR.click", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({ signIn: async () => ({ public_key: "01aa", name: "Alice" }) });
    expect(await csprClickConnector.connect()).toEqual({ publicKey: "01aa", label: "Alice" });
  });

  it("falls back to getActiveAccount for SDK versions whose signIn resolves nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({ signIn: async () => undefined, getActiveAccount: () => ({ public_key: "01cc" }) });
    expect(await csprClickConnector.connect()).toEqual({ publicKey: "01cc", label: "CSPR.click" });
  });

  it("leaves the app disconnected — not broken — when a sign-in is cancelled", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
    installSdk({
      signIn: async () => {
        throw new Error("user cancelled");
      },
    });
    await expect(csprClickConnector.connect()).resolves.toBeNull();
  });

  it("does not throw when the SDK's own disconnect fails", async () => {
    installSdk({
      disconnect: async () => {
        throw new Error("already gone");
      },
    });
    await expect(csprClickConnector.disconnect()).resolves.toBeUndefined();
  });
});

describe("GET /api/boards — boards rebuilt from chain events", () => {
  it("serves an event-derived board with its own provenance", async () => {
    const res = await boardsGET(new Request("http://localhost/api/boards?network=testnet"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.source).toBe("chain-events");
    expect(json.agentPnl.length).toBeGreaterThan(0);
    expect(json.provenance.eventCount).toBeGreaterThan(0);
    // Nothing skipped means the fold saw a complete history — the claim is checkable.
    expect(json.provenance.skipped).toEqual([]);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("names anything it skipped, so a drifting board is diagnosable", async () => {
    // `from` past the market's creation leaves bets with no market — exactly the mid-history case.
    const res = await boardsGET(new Request("http://localhost/api/boards?from=101"));
    const json = await res.json();
    expect(json.provenance.skipped.length).toBeGreaterThan(0);
    expect(json.provenance.skipped[0].reason).toContain("no market_created");
  });
});
