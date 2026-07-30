/**
 * The signing pre-flight.
 *
 * CSPR.click 2.1's `send()` reads its account from `localStorage` — which survives a reload — but
 * signs with `this.provider`, an in-memory instance only `connect`/`switchAccount`/`sign` ever
 * build. On any page load that did not itself run a connect, the two disagree, and `send()`'s
 * `else s.status="sent"` then throws a TypeError inside an `async` Promise executor: the promise it
 * returned NEVER SETTLES. Verified against the shipped bundle on prod — `csprclick.send("{}", key)`
 * still pending after six seconds, no popup, no rejection, nothing to catch.
 *
 * That is what froze `/create` on "Approve the creation in your wallet…" with a healthy connected
 * wallet, and it froze every bet the same way. `prepareToSign` resolves the provider first, exactly
 * as the SDK's own `sign()` does, and turns what is left into a message.
 *
 * The tests below are written against a fake shaped like the real `send()` — including its hang —
 * so a regression here fails as a timeout-free assertion rather than a hung suite.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  csprClickConnector,
  prepareToSign,
  type CsprClickLike,
} from "@/lib/wallet-connector";

const KEY = "0203361111111111111111111111111111111111111111111111111111111111aff4";

type Instance = { name: () => string; send?: () => Promise<unknown> };

/**
 * A stand-in for the SDK object, faithful on the two points that matter: `getActiveAccount` is
 * backed by storage (so it answers after a reload), and `provider` is only set by
 * `getProviderInstance` (so it does not).
 */
function fakeSdk(options: {
  account?: { public_key?: string; provider?: string } | null;
  /** Whether the wallet can be instantiated — false is an extension that has gone away. */
  instantiable?: boolean;
  /** Wallet keys the build knows; anything else throws, as the real one does. */
  known?: string[];
  provider?: Instance;
  onSend?: () => Promise<unknown>;
}) {
  const calls: string[] = [];
  const sdk: CsprClickLike & { provider?: Instance } = {
    provider: options.provider,
    getActiveAccount: () => (options.account === undefined ? { public_key: KEY, provider: "casper-wallet" } : options.account),
    getProviderInstance: async (provider: string) => {
      calls.push(`getProviderInstance:${provider}`);
      const known = options.known ?? ["casper-wallet", "walletconnect", "metamask-snap"];
      if (!known.includes(provider)) throw new Error(`Unsupported wallet: ${provider}`);
      if (options.instantiable === false) return undefined; // the SDK swallows the constructor error
      sdk.provider = { name: () => provider, send: async () => ({ transactionHash: "hash-1" }) };
      return sdk.provider;
    },
    signInWithAccount: async (account: unknown) => {
      calls.push("signInWithAccount");
      if (options.instantiable === false) return undefined; // its catch signs out; no provider results
      const provider = (account as { provider?: string }).provider ?? "walletconnect";
      sdk.provider = { name: () => provider };
      return account;
    },
    /**
     * The real `send()`, reduced to its two outcomes: an answer when a provider instance exists,
     * and a promise that never settles when one does not.
     */
    send: async () => {
      calls.push("send");
      if (options.onSend) return (await options.onSend()) as never;
      if (!sdk.provider) return new Promise<never>(() => {}); // the freeze, reproduced
      return { transactionHash: "hash-1" };
    },
  };
  return { sdk, calls };
}

/** Fails the test rather than hanging it — a never-settling promise is the bug under test. */
async function within<T>(promise: Promise<T>, ms = 200): Promise<T> {
  const guard = Symbol("timeout");
  const result = await Promise.race([
    promise,
    new Promise<typeof guard>((r) => setTimeout(() => r(guard), ms)),
  ]);
  if (result === guard) throw new Error(`promise did not settle within ${ms}ms`);
  return result as T;
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
  vi.unstubAllEnvs();
});

describe("prepareToSign", () => {
  it("builds the provider instance the reloaded page lacks, so send() can answer", async () => {
    const { sdk, calls } = fakeSdk({});
    expect(sdk.provider).toBeUndefined();
    await expect(prepareToSign(sdk, KEY)).resolves.toBeNull();
    expect(calls).toEqual(["getProviderInstance:casper-wallet"]);
    expect(sdk.provider?.name()).toBe("casper-wallet");
  });

  it("leaves a live provider alone — nothing is rebuilt mid-session", async () => {
    const { sdk, calls } = fakeSdk({ provider: { name: () => "casper-wallet" } });
    await expect(prepareToSign(sdk, KEY)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it("says the session ended instead of letting send() throw 'Sign in first.'", async () => {
    const { sdk } = fakeSdk({ account: null });
    await expect(prepareToSign(sdk, KEY)).resolves.toMatch(/no longer signed in/i);
  });

  it("names an account switch for what it is", async () => {
    const { sdk } = fakeSdk({ account: { public_key: "01other", provider: "casper-wallet" } });
    await expect(prepareToSign(sdk, KEY)).resolves.toMatch(/different account/i);
  });

  it("reports a wallet that can no longer be reached, rather than hanging on it", async () => {
    // The extension was uninstalled or locked away since the session was stored: the SDK's
    // `getProviderInstance` swallows the constructor error and returns undefined, which is the
    // exact state that makes `send()` hang.
    const { sdk } = fakeSdk({ instantiable: false });
    await expect(prepareToSign(sdk, KEY)).resolves.toMatch(/Casper Wallet could not be reached/i);
  });

  it("passes an unknown wallet key's error through", async () => {
    const { sdk } = fakeSdk({ account: { public_key: KEY, provider: "ledger" }, known: [] });
    await expect(prepareToSign(sdk, KEY)).resolves.toBe("Unsupported wallet: ledger");
  });

  it("resumes a WalletConnect session through signInWithAccount, not a bare instance", async () => {
    // A relay session does not survive a reload the way an extension does; `signInWithAccount` is
    // the SDK's own resume (instance + `connect({dontShowUI:true})`).
    const { sdk, calls } = fakeSdk({ account: { public_key: KEY, provider: "walletconnect" } });
    await expect(prepareToSign(sdk, KEY)).resolves.toBeNull();
    expect(calls).toEqual(["signInWithAccount"]);
  });

  it("proceeds when the build cannot be asked at all — absence of evidence", async () => {
    await expect(prepareToSign({ send: async () => ({}) }, KEY)).resolves.toBeNull();
    // Same for an account with no provider key on it: there is nothing to resolve against.
    const { sdk, calls } = fakeSdk({ account: { public_key: KEY } });
    await expect(prepareToSign(sdk, KEY)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("sendTransaction, on a page that did not run the connect", () => {
  function install(sdk: CsprClickLike): void {
    (globalThis as unknown as { window: { csprclick?: CsprClickLike } }).window = { csprclick: sdk };
    vi.stubEnv("NEXT_PUBLIC_CSPR_CLICK_APP_ID", "app-123");
  }

  it("signs instead of hanging — the /create freeze, end to end", async () => {
    const { sdk, calls } = fakeSdk({});
    install(sdk);
    await expect(within(csprClickConnector.sendTransaction!("{}", KEY))).resolves.toEqual({
      ok: true,
      transactionHash: "hash-1",
    });
    // The instance was built BEFORE the send, which is the whole fix.
    expect(calls).toEqual(["getProviderInstance:casper-wallet", "send"]);
  });

  it("never reaches send() when the wallet cannot be revived", async () => {
    const { sdk, calls } = fakeSdk({ instantiable: false });
    install(sdk);
    await expect(within(csprClickConnector.sendTransaction!("{}", KEY))).resolves.toMatchObject({
      ok: false,
      reason: "failed",
    });
    expect(calls).not.toContain("send");
  });
});
