"use client";

import { shortKey, useWallet } from "@/components/wallet-context";

/** Header wallet control: connect (mock CSPR.click) or show the connected account + disconnect. */
export function WalletButton() {
  const { account, connect, disconnect } = useWallet();

  if (!account) {
    return (
      <button
        type="button"
        onClick={connect}
        className="rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
      >
        Connect wallet
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={disconnect}
      title={`${account.label} · ${account.publicKey} — click to disconnect`}
      className="chip inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:text-accent"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-up" aria-hidden />
      <span className="font-mono">{shortKey(account.publicKey)}</span>
    </button>
  );
}
