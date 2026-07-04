import { describe, it, expect, afterEach } from "vitest";
import { readWallet } from "@/components/wallet-context";

/**
 * Guards the useSyncExternalStore snapshot-caching contract: `readWallet` (the client
 * getSnapshot) must return a referentially-stable value while the stored string is unchanged.
 * A fresh object per call causes an infinite re-render loop the instant a wallet connects — the
 * exact defect the S4 adversarial review caught.
 */
function stubStorage(value: string | null): void {
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: { getItem: () => value },
  };
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("wallet snapshot stability", () => {
  it("returns the SAME reference across calls while the stored string is unchanged", () => {
    stubStorage(JSON.stringify({ publicKey: "01demo", label: "Demo wallet" }));
    const a = readWallet();
    const b = readWallet();
    expect(a).toBe(b);
    expect(a?.publicKey).toBe("01demo");
  });

  it("mints a new reference only when the stored string actually changes", () => {
    stubStorage(JSON.stringify({ publicKey: "01a", label: "x" }));
    const a = readWallet();
    stubStorage(JSON.stringify({ publicKey: "01b", label: "y" }));
    const b = readWallet();
    expect(a).not.toBe(b);
    expect(b?.publicKey).toBe("01b");
  });

  it("is a stable null when disconnected", () => {
    stubStorage(null);
    expect(readWallet()).toBe(null);
  });
});
