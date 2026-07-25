"use client";

import { useState } from "react";
import Link from "next/link";
import type { Market } from "@/core/types";
import type { CasperNetwork } from "@/config/network";
import { csprToMotes, motesToCspr } from "@/core/types";
import { previewPayoutMotes } from "@/core/market-payout";
import { exceedsBetCap, maxBetCspr } from "@/config/network";
import { isDemoAccount, useWallet } from "@/components/wallet-context";

interface ChainResult {
  deployHash: string;
  explorerUrl: string;
  simulated?: boolean;
  /** Present when the chain took the bet but the off-chain read model refused it (see the routes). */
  indexed?: boolean;
  /** Post-write pools, straight from the store — what the page renders without waiting for a refetch. */
  totalStakedMotes?: string;
  poolByOutcomeMotes?: Record<string, string>;
}

/** "cspr.live" / "testnet.cspr.live" — the explorer named, so the link says where it goes. */
function explorerHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the block explorer";
  }
}

function CopyHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(hash).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="shrink-0 text-[10px] uppercase tracking-wide text-muted transition-colors hover:text-foreground"
      aria-label="Copy transaction hash"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function ResultLine({
  label,
  result,
  network,
}: {
  label: string;
  result: ChainResult;
  network: CasperNetwork;
}) {
  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-2 p-3 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-semibold text-up">{label}</span>
        {result.simulated ? (
          <span className="chip px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">simulated</span>
        ) : (
          <span className="chip border-up/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-up">
            live · {network}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-muted">{result.deployHash}</span>
        <CopyHash hash={result.deployHash} />
      </div>
      {result.simulated ? (
        // A simulated hash is not on the live explorer — say so rather than link a judge to a
        // "transaction not found" page. Same rule the activity feed follows.
        <p className="mt-2 text-[11px] text-muted">
          Simulated chain — this hash is not on {explorerHost(result.explorerUrl)}.
        </p>
      ) : (
        <a
          href={result.explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        >
          View the {network} transaction on {explorerHost(result.explorerUrl)}
          <span aria-hidden="true">↗</span>
        </a>
      )}
      {result.indexed === false && (
        // The chain holds the escrow but the boards do not know about it — never let the pools
        // silently disagree with the money.
        <p className="mt-2 text-[11px] text-gold">
          On chain, but not yet reflected in the pools — the boards will catch up from chain state.
        </p>
      )}
    </div>
  );
}

/**
 * The S2 thin-slice trade panel: place a bet and (as the oracle) resolve — both through the
 * `CasperChainPort` via `/api/chain/*`. With the mock adapter it returns pseudo hashes; once
 * `CASPER_CHAIN_MODE=real` + testnet contracts are wired the SAME panel submits live Casper
 * transactions, no UI change.
 *
 * Betting has two paths, and which one runs depends only on whether the visitor has a wallet that
 * can sign. With one, the server prepares an unsigned transaction and THEY sign and fund it —
 * self-custodial, `self.env().caller()` is really them. Without one (the demo account, or a
 * deployment on the simulated chain), it falls back to the operator-signed `/api/chain/bet`, and
 * the panel says so rather than letting "Betting as 01ab…" imply custody it does not have.
 */
/**
 * The operator "Oracle resolve" control is a leftover S2 thin-slice demo aid: it lets whoever holds
 * the page resolve a market. That both confuses the UX (an end-user shouldn't resolve markets) and
 * undercuts the "the autonomous Arbiter resolves, reputation staked" story — so it's OFF by default
 * on the public deploy and only shown when a demoer opts in with NEXT_PUBLIC_SHOW_DEMO_RESOLVE=true.
 */
const SHOW_DEMO_RESOLVE = process.env.NEXT_PUBLIC_SHOW_DEMO_RESOLVE === "true";

export function BetPanel({
  market,
  onChainUpdate,
}: {
  market: Market;
  /**
   * Fired once the chain accepts a write from this panel (a bet, or an operator resolve), with the
   * route's response. The page uses it to move the pools/odds immediately — a bet response carries
   * the post-write read model — and to refetch behind that. Without it a visitor sees their own
   * stake missing from the board they just moved.
   */
  onChainUpdate?: (result: ChainResult) => void;
}) {
  const { account, connected, connect, connectError, signAndSend, signingDisabledReason } = useWallet();
  const [outcomeKey, setOutcomeKey] = useState(market.outcomes[0]?.key ?? "");
  const [amount, setAmount] = useState("1");
  const [betting, setBetting] = useState(false);
  const [betResult, setBetResult] = useState<ChainResult | null>(null);
  const [betError, setBetError] = useState<string | null>(null);

  const [resolveKey, setResolveKey] = useState(market.outcomes[0]?.key ?? "");
  const [resolving, setResolving] = useState(false);
  const [resolveResult, setResolveResult] = useState<ChainResult | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

  /**
   * Bet with the visitor's OWN wallet: the server builds the transaction with them as initiator,
   * their wallet signs and submits it, and the server indexes it against the ticket it signed.
   *
   * Returns `null` when this route is not available on this deployment — a demo account with no
   * key, a simulated chain with no transaction to build — which the caller reads as "fall back to
   * the operator-signed route". A *declined signature* is not that: it throws, because retrying it
   * against the operator's key would place a bet the visitor just refused, with someone else's
   * money.
   */
  async function betWithWallet(amountMotes: string, bettor: string): Promise<unknown | null> {
    // A stale demo account can outlive a page load — it is in localStorage, and the SDK loads
    // after it is read. Its key is not a signable one, so this is a fallback case, not an error.
    if (!signAndSend || isDemoAccount(account)) return null;
    const prepared = await fetch("/api/chain/bet/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ network: market.network, marketId: market.id, outcomeKey, amountMotes, bettor }),
    });
    const prep = await prepared.json();
    // 501 = "this deployment cannot do wallet-signed bets", the one case worth falling back on.
    if (prepared.status === 501) return null;
    if (!prepared.ok) throw new Error(prep.error ?? "could not prepare the bet");

    const sent = await signAndSend(prep.transactionJson, bettor);
    if (!sent.ok) throw new Error(sent.message);

    const confirmed = await fetch("/api/chain/bet/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: prep.ticket }),
    });
    const json = await confirmed.json();
    if (!confirmed.ok) throw new Error(json.error ?? "the bet was submitted but could not be confirmed");
    return json;
  }

  async function placeBet() {
    if (!account) {
      connect();
      return;
    }
    setBetting(true);
    setBetError(null);
    setBetResult(null);
    try {
      const amountMotes = csprToMotes(Number(amount));
      const self = await betWithWallet(amountMotes, account.publicKey);
      if (self !== null) {
        setBetResult(self as ChainResult);
        onChainUpdate?.(self as ChainResult);
        return;
      }
      const res = await fetch("/api/chain/bet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          network: market.network,
          marketId: market.id,
          outcomeKey,
          amountMotes,
          bettor: account.publicKey,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "bet failed");
      setBetResult(json);
      onChainUpdate?.(json as ChainResult);
    } catch (err) {
      setBetError(err instanceof Error ? err.message : "bet failed");
    } finally {
      setBetting(false);
    }
  }

  async function resolve() {
    setResolving(true);
    setResolveError(null);
    setResolveResult(null);
    try {
      const res = await fetch("/api/chain/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          network: market.network,
          marketId: market.id,
          winningOutcomeKey: resolveKey,
          oracleId: "arbiter",
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "resolve failed");
      setResolveResult(json);
      // No pools in a resolve response — the page reads this purely as "refetch, the market moved".
      onChainUpdate?.(json as ChainResult);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "resolve failed");
    } finally {
      setResolving(false);
    }
  }

  const amountValid = Number(amount) > 0 && Number.isFinite(Number(amount));
  const betCap = maxBetCspr(market.network);
  const overCap = amountValid && exceedsBetCap(market.network, Number(amount));
  const previewCspr =
    amountValid && outcomeKey
      ? motesToCspr(previewPayoutMotes(market.poolByOutcomeMotes, outcomeKey, csprToMotes(Number(amount)), market.feeBps))
      : 0;

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold">Place a bet</h3>
      <p className="mt-1 text-xs text-muted">
        Stake CSPR on an outcome. Settlement runs through the active chain adapter.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        {market.outcomes.map((o) => {
          const active = o.key === outcomeKey;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => setOutcomeKey(o.key)}
              className={`chip px-3 py-1.5 text-xs font-medium transition-colors ${
                active ? "border-accent/60 text-accent" : "text-muted hover:text-foreground"
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-full border border-border bg-surface-2 px-4 py-2 transition-colors focus-within:border-accent/60">
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-transparent text-sm outline-none"
            aria-label="Bet amount in CSPR"
          />
          <span className="text-xs text-muted">CSPR</span>
        </div>
        <button
          type="button"
          onClick={placeBet}
          disabled={betting || (connected && (!amountValid || !outcomeKey || overCap))}
          className="btn btn-primary px-5 py-2 disabled:opacity-40"
        >
          {betting ? "Placing…" : connected ? "Place bet" : "Connect wallet"}
        </button>
      </div>

      {betCap != null && (
        <p className="mt-2 text-[11px] text-muted">
          Mainnet is capped at <span className="text-foreground">{betCap} CSPR</span> per bet — an unaudited
          hackathon build holding real value.
        </p>
      )}
      {overCap && (
        <p className="mt-1 text-xs text-down">
          Over the {betCap} CSPR mainnet cap — lower the stake or switch to testnet.
        </p>
      )}

      {amountValid && !overCap && outcomeKey && (
        <p className="mt-2 text-xs text-muted">
          If <span className="text-foreground">{market.outcomes.find((o) => o.key === outcomeKey)?.label ?? outcomeKey}</span>{" "}
          wins, this stake pays ~<span className="font-semibold text-up">{previewCspr.toFixed(2)} CSPR</span>{" "}
          <span className="text-[10px]">(pool-implied, at current odds)</span>
        </p>
      )}
      {connected && account && (
        <p className="mt-1 text-[11px] text-muted">
          Betting as <span className="font-mono text-foreground">{account.label}</span>
          {signAndSend ? (
            <> · you sign and fund this bet from your own account</>
          ) : (
            // Say it rather than let it be assumed. With no wallet key of its own the stake is
            // escrowed by the operator's account and this public key is a label on it.
            <> · escrowed by the operator on your behalf</>
          )}
        </p>
      )}
      {/* The deployment itself is miswired: CSPR.click refused the app id, so real signing is
          impossible no matter what the visitor does. Named out loud because the demo fallback it
          causes would otherwise read as the visitor's fault. */}
      {signingDisabledReason && (
        <p className="mt-2 text-[11px] text-muted">{signingDisabledReason}</p>
      )}
      {/* A browser with no wallet in it: the one connect failure that needs a way forward. */}
      {connectError && (
        <p className="mt-2 text-xs text-down">
          {connectError}{" "}
          <a
            href="https://www.casperwallet.io/download"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            Get Casper Wallet
          </a>
        </p>
      )}
      {betError && <p className="mt-2 text-xs text-down">{betError}</p>}
      {betResult && <ResultLine label="Bet submitted" result={betResult} network={market.network} />}

      {!SHOW_DEMO_RESOLVE && (
        <p className="mt-4 border-t border-border pt-4 text-[11px] text-muted">
          Resolution is the autonomous <span className="text-foreground">Arbiter</span>’s job — it
          posts the winning outcome on-chain with its reputation staked. Watch it on the{" "}
          <Link href="/agents" className="underline decoration-border underline-offset-2 hover:text-accent">
            swarm dashboard
          </Link>
          .
        </p>
      )}

      {SHOW_DEMO_RESOLVE && (
      <div className="mt-6 border-t border-border pt-4">
        <h3 className="text-sm font-semibold">Oracle resolve</h3>
        <p className="mt-1 text-xs text-muted">
          The Arbiter posts the winning outcome, triggering settlement. (Demo control for the S2
          thin slice — the autonomous Arbiter takes this over in the agent economy.)
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {market.outcomes.map((o) => {
            const active = o.key === resolveKey;
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => setResolveKey(o.key)}
                className={`chip px-3 py-1.5 text-xs font-medium transition-colors ${
                  active ? "border-gold/60 text-gold" : "text-muted hover:text-foreground"
                }`}
              >
                {o.label}
              </button>
            );
          })}
          <button
            type="button"
            onClick={resolve}
            disabled={resolving || !resolveKey}
            className="ml-auto rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground transition-colors hover:border-gold/60 hover:text-gold disabled:opacity-40"
          >
            {resolving ? "Resolving…" : "Resolve"}
          </button>
        </div>
        {resolveError && <p className="mt-2 text-xs text-down">{resolveError}</p>}
        {resolveResult && (
          <ResultLine label="Resolution submitted" result={resolveResult} network={market.network} />
        )}
      </div>
      )}
    </div>
  );
}
