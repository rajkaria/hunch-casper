"use client";

import { useEffect, useMemo, useState } from "react";
import { encodeQr, qrSvgExtent, qrToSvgPath } from "@/lib/qr-code";
import { CASPER_WALLET_DOWNLOAD_URL, casperWalletPairingDeepLink } from "@/lib/wallet-connector";
import { localWalletAvailable, shortKey, useWallet } from "@/components/wallet-context";

/**
 * What a connection attempt looks like while it is happening.
 *
 * The bug this component fixes: with no extension installed, CSPR.click always selects
 * WalletConnect (its `IsPresent()` is a hardcoded `true`), and that path *emits a pairing URI and
 * waits*. Nothing else happens — no popup, no window, no error. An app that draws no pairing UI
 * therefore ships a Connect button that visibly does nothing, forever.
 *
 * So: the URI becomes a QR any Casper wallet on a phone can scan, with a deep link for visitors
 * already on that phone, a copyable string for everyone else, and a cancel that actually cancels.
 * And when there is no route at all, that is said in words instead of being swallowed.
 */
export function WalletPairing() {
  const { connectState, cancelConnect } = useWallet();

  // Escape closes whatever this is showing — it is the only way out of a QR nobody can scan.
  useEffect(() => {
    if (connectState.phase === "idle") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelConnect();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [connectState.phase, cancelConnect]);

  if (connectState.phase === "idle") return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Connect a wallet"
      onClick={(event) => {
        if (event.target === event.currentTarget) cancelConnect();
      }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-2xl">
        {connectState.phase === "connecting" && (
          <Waiting onCancel={cancelConnect} />
        )}
        {connectState.phase === "pairing" && (
          <Pairing uri={connectState.uri} onCancel={cancelConnect} />
        )}
        {connectState.phase === "choosing" && (
          <AccountPicker
            accounts={connectState.accounts}
            onChoose={connectState.choose}
            onCancel={cancelConnect}
          />
        )}
        {connectState.phase === "error" && (
          <Failure
            message={connectState.message}
            canInstall={connectState.canInstall}
            onDismiss={cancelConnect}
          />
        )}
      </div>
    </div>
  );
}

function Heading({ title, hint }: { title: string; hint: string }) {
  return (
    <>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">{hint}</p>
    </>
  );
}

function CancelButton({ onClick, label = "Cancel" }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-4 w-full rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted transition-colors hover:text-foreground"
    >
      {label}
    </button>
  );
}

function Waiting({ onCancel }: { onCancel: () => void }) {
  return (
    <>
      <Heading
        title="Waiting for your wallet"
        hint="Approve the connection in your wallet. If nothing opened, your browser may have blocked it."
      />
      <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
      </div>
      <CancelButton onClick={onCancel} />
    </>
  );
}

function Pairing({ uri, onCancel }: { uri: string; onCancel: () => void }) {
  const [copied, setCopied] = useState(false);
  // Error correction M, so a scan still works with the page's own contrast and a phone at an angle.
  const qr = useMemo(() => encodeQr(uri, "M"), [uri]);
  const extent = qrSvgExtent(qr);
  const noLocalWallet = useMemo(() => !localWalletAvailable(), []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <>
      <Heading
        title="Scan with your Casper wallet"
        hint="This browser has no wallet extension, so the connection has to go through your phone. Open Casper Wallet, choose WalletConnect, and scan."
      />
      <div className="mt-4 flex justify-center">
        {/* White plate on purpose: a dark-on-dark QR is a QR that does not scan. */}
        <svg
          viewBox={`0 0 ${extent} ${extent}`}
          className="h-56 w-56 rounded-lg bg-white p-1"
          role="img"
          aria-label="WalletConnect pairing QR code"
          shapeRendering="crispEdges"
        >
          <path d={qrToSvgPath(qr)} fill="#000" />
        </svg>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(uri).then(() => setCopied(true));
          }}
          className="flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-accent/50"
        >
          {copied ? "Copied" : "Copy pairing link"}
        </button>
        <a
          href={casperWalletPairingDeepLink(uri)}
          className="flex-1 rounded-lg bg-accent px-3 py-2 text-center text-xs font-semibold text-white transition-opacity hover:opacity-90"
        >
          Open wallet app
        </a>
      </div>

      {noLocalWallet && (
        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          No wallet on this device?{" "}
          <a
            className="text-accent underline underline-offset-2"
            href={CASPER_WALLET_DOWNLOAD_URL}
            target="_blank"
            rel="noreferrer noopener"
          >
            Install Casper Wallet
          </a>{" "}
          and reload — the extension connects without a QR.
        </p>
      )}
      <CancelButton onClick={onCancel} />
    </>
  );
}

function AccountPicker({
  accounts,
  onChoose,
  onCancel,
}: {
  accounts: { publicKey: string; label: string }[];
  onChoose: (index: number) => void;
  onCancel: () => void;
}) {
  return (
    <>
      <Heading
        title="Choose an account"
        hint="Your wallet shared more than one account with this site."
      />
      <ul className="mt-4 flex flex-col gap-2">
        {accounts.map((account, index) => (
          <li key={account.publicKey}>
            <button
              type="button"
              onClick={() => onChoose(index)}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2 text-left text-xs transition-colors hover:border-accent/50"
            >
              <span className="font-medium text-foreground">{account.label}</span>
              <span className="font-mono text-[11px] text-muted">
                {shortKey(account.publicKey)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <CancelButton onClick={onCancel} />
    </>
  );
}

function Failure({
  message,
  canInstall,
  onDismiss,
}: {
  message: string;
  canInstall: boolean;
  onDismiss: () => void;
}) {
  return (
    <>
      <Heading
        title="Could not connect a wallet"
        hint={
          // The connector's own words: `no-wallet` and `failed` are different endings and the
          // visitor is told which one happened, rather than being handed a button that did nothing.
          message
        }
      />
      {canInstall && (
        <a
          href={CASPER_WALLET_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-4 block rounded-lg bg-accent px-3 py-2 text-center text-xs font-semibold text-white transition-opacity hover:opacity-90"
        >
          Install Casper Wallet
        </a>
      )}
      <CancelButton onClick={onDismiss} label="Close" />
    </>
  );
}
