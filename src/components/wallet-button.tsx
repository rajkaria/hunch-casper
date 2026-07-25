"use client";

import { isDemoAccount, shortKey, useWallet } from "@/components/wallet-context";

/** Header wallet control: connect (CSPR.click, or the demo account) or show the account + sign out. */
export function WalletButton() {
  const { account, connect, disconnect, connectState } = useWallet();

  if (!account) {
    // An attempt in flight is shown on the button too, not only in the dialog: whichever copy of
    // this button the visitor clicked has to stop looking like it did nothing.
    const busy = connectState.phase !== "idle" && connectState.phase !== "error";
    return (
      <button
        type="button"
        onClick={connect}
        aria-busy={busy}
        className="rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
      >
        {busy ? "Connecting…" : "Connect wallet"}
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
      {isDemoAccount(account) && (
        <span className="rounded bg-surface-2 px-1 text-[9px] font-semibold uppercase tracking-wide text-muted">
          demo
        </span>
      )}
    </button>
  );
}
