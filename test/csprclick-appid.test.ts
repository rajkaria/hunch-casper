/**
 * The app-id reality check.
 *
 * "App id set + SDK loaded" was the whole availability test, and production shipped a hole in it:
 * an app id CSPR.click never issued. The SDK fetches `application/{appId}.json`, receives
 * `401 {"error":{"message":"wrong application id"}}`, and crashes unhandled on the error body —
 * no event, no fallback, a dead Connect button posing as an armed wallet. These tests pin the
 * probe that turns that silent death into a visible demotion: a definitive rejection flips the
 * connector back to the labelled demo wallet, and *only* a definitive rejection does.
 */

import { describe, expect, it, afterEach, vi } from "vitest";
import { csprClickApplicationUrl, CSPR_CLICK_ACCOUNTS_HOST } from "@/config/csprclick";
import {
  __resetCsprClickAppIdRejection,
  csprClickAppIdRejection,
  csprClickConnector,
  detectWalletTransport,
  markCsprClickAppIdRejected,
  probeCsprClickAppId,
} from "@/lib/wallet-connector";
import { marketMayHaveEvidence } from "@/components/evidence-viewer";

const w = globalThis as unknown as {
  window?: { csprclick?: unknown; __CSPR_CLICK_APP_ID__?: string };
};

afterEach(() => {
  delete w.window;
  vi.unstubAllEnvs();
  __resetCsprClickAppIdRejection();
});

/** CSPR.click's actual answer for an unregistered id, captured 2026-07-26. */
function rejection401(): Response {
  return new Response(JSON.stringify({ error: { code: "unauthorized", message: "wrong application id" } }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

describe("csprClickApplicationUrl — the endpoint the SDK itself asks first", () => {
  it("builds the SDK's own path on the accounts host", () => {
    expect(csprClickApplicationUrl("abc123")).toBe(
      `${CSPR_CLICK_ACCOUNTS_HOST}/api/application/abc123.json`,
    );
  });
});

describe("probeCsprClickAppId — definitive rejections demote, everything else does not", () => {
  it("marks the rejection on a 401 and carries CSPR.click's own reason plus the remedy", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "never-issued");
    const fetchImpl = vi.fn(async () => rejection401()) as unknown as typeof fetch;

    const rejection = await probeCsprClickAppId(fetchImpl);

    expect(rejection).toContain("wrong application id");
    expect(rejection).toContain("console.cspr.click");
    expect(csprClickAppIdRejection()).toBe(rejection);
    expect(fetchImpl).toHaveBeenCalledWith(
      csprClickApplicationUrl("never-issued"),
      expect.objectContaining({ credentials: "omit" }),
    );
  });

  it("remembers a rejection instead of re-probing", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "never-issued");
    const fetchImpl = vi.fn(async () => rejection401()) as unknown as typeof fetch;
    await probeCsprClickAppId(fetchImpl);
    await probeCsprClickAppId(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("accepts a 200 silently — a registered id changes nothing", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "registered");
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await probeCsprClickAppId(fetchImpl)).toBeNull();
    expect(csprClickAppIdRejection()).toBeNull();
  });

  it("treats their Origin-gate 401 ('request not authorized') as inconclusive — it says nothing about the id", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "registered");
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: "unauthorized", message: "request not authorized" } }), {
        status: 401,
      })) as unknown as typeof fetch;
    expect(await probeCsprClickAppId(fetchImpl)).toBeNull();
    expect(csprClickAppIdRejection()).toBeNull();
  });

  it("treats a CSPR.click outage (5xx) as inconclusive, never as a rejection", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "registered");
    const fetchImpl = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    expect(await probeCsprClickAppId(fetchImpl)).toBeNull();
    expect(csprClickAppIdRejection()).toBeNull();
  });

  it("treats a network failure as inconclusive — offline must not demote a working config", async () => {
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "registered");
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await probeCsprClickAppId(fetchImpl)).toBeNull();
    expect(csprClickAppIdRejection()).toBeNull();
  });

  it("does nothing when no app id is configured — there is nothing to ask about", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect(await probeCsprClickAppId(fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("a marked rejection flips the connector back to the demo fallback", () => {
  it("available() answers false even with the SDK loaded and an app id set", () => {
    w.window = { csprclick: { connect: async () => undefined }, __CSPR_CLICK_APP_ID__: "app-123" };
    expect(csprClickConnector.available()).toBe(true);
    markCsprClickAppIdRejected("CSPR.click rejected this site's app id");
    expect(csprClickConnector.available()).toBe(false);
    __resetCsprClickAppIdRejection();
    expect(csprClickConnector.available()).toBe(true);
  });
});

describe("marketMayHaveEvidence — the evidence probe only fires for settled markets", () => {
  it("skips open and locked markets, whose probe is a foregone 404", () => {
    expect(marketMayHaveEvidence("open")).toBe(false);
    expect(marketMayHaveEvidence("locked")).toBe(false);
  });
  it("probes resolved and void markets — both publish a bundle at settlement", () => {
    expect(marketMayHaveEvidence("resolved")).toBe(true);
    expect(marketMayHaveEvidence("void")).toBe(true);
  });
});

describe("the pairing route is only offered when it can possibly work", () => {
  // A desktop with no extension used to race straight into walletconnect (its IsPresent() is a
  // literal true) — but without a WalletConnect Cloud project id in init(...), the SDK's provider
  // constructor throws and the visitor gets "Could not establish a connection with the provider"
  // from a dialog that was never going to show a QR. Unconfigured, the honest answer is the
  // install prompt.
  const sdkWithNothingLocal = {
    isProviderPresent: (p: string) => p === "walletconnect",
    connect: async () => undefined,
  };

  it("falls to no-wallet (install prompt) when WalletConnect is unconfigured", () => {
    const t = detectWalletTransport(sdkWithNothingLocal, undefined, false);
    expect(t.provider).toBeNull();
    expect(t).toMatchObject({ reason: "no-wallet" });
  });

  it("offers walletconnect when a project id is configured", () => {
    const t = detectWalletTransport(sdkWithNothingLocal, undefined, true);
    expect(t.provider).toBe("walletconnect");
  });

  it("never blocks a local extension on WalletConnect configuration", () => {
    const sdkWithExtension = { isProviderPresent: () => true, connect: async () => undefined };
    expect(detectWalletTransport(sdkWithExtension, undefined, false).provider).toBe("casper-wallet");
  });
});
