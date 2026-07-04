"use client";

import { useState } from "react";
import type { Market } from "@/core/types";
import { csprToMotes, motesToCspr } from "@/core/types";
import { previewPayoutMotes } from "@/core/market-payout";
import { useWallet } from "@/components/wallet-context";

interface ChainResult {
  deployHash: string;
  explorerUrl: string;
  simulated?: boolean;
}

function ResultLine({ label, result }: { label: string; result: ChainResult }) {
  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-2 p-3 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-semibold text-up">{label}</span>
        {result.simulated ? (
          <span className="chip px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">simulated</span>
        ) : (
          <span className="chip border-up/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-up">live</span>
        )}
      </div>
      <a
        href={result.explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block truncate font-mono text-muted underline decoration-border underline-offset-2 hover:text-accent"
      >
        {result.deployHash}
      </a>
    </div>
  );
}

/**
 * The S2 thin-slice trade panel: place a bet and (as the oracle) resolve — both through the
 * `CasperChainPort` via `/api/chain/*`. With the mock adapter it returns pseudo hashes; once
 * `CASPER_CHAIN_MODE=real` + testnet contracts are wired the SAME panel submits live Casper
 * transactions, no UI change. Human wallet connect (CSPR.click) + richer betting land in S4.
 */
export function BetPanel({ market }: { market: Market }) {
  const { account, connected, connect } = useWallet();
  const [outcomeKey, setOutcomeKey] = useState(market.outcomes[0]?.key ?? "");
  const [amount, setAmount] = useState("1");
  const [betting, setBetting] = useState(false);
  const [betResult, setBetResult] = useState<ChainResult | null>(null);
  const [betError, setBetError] = useState<string | null>(null);

  const [resolveKey, setResolveKey] = useState(market.outcomes[0]?.key ?? "");
  const [resolving, setResolving] = useState(false);
  const [resolveResult, setResolveResult] = useState<ChainResult | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);

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
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "resolve failed");
    } finally {
      setResolving(false);
    }
  }

  const amountValid = Number(amount) > 0 && Number.isFinite(Number(amount));
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
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2">
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
          disabled={betting || (connected && (!amountValid || !outcomeKey))}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition-opacity disabled:opacity-40"
        >
          {betting ? "Placing…" : connected ? "Place bet" : "Connect wallet"}
        </button>
      </div>

      {amountValid && outcomeKey && (
        <p className="mt-2 text-xs text-muted">
          If <span className="text-foreground">{market.outcomes.find((o) => o.key === outcomeKey)?.label ?? outcomeKey}</span>{" "}
          wins, this stake pays ~<span className="font-semibold text-up">{previewCspr.toFixed(2)} CSPR</span>{" "}
          <span className="text-[10px]">(pool-implied, at current odds)</span>
        </p>
      )}
      {connected && account && (
        <p className="mt-1 text-[11px] text-muted">
          Betting as <span className="font-mono text-foreground">{account.label}</span>
        </p>
      )}
      {betError && <p className="mt-2 text-xs text-down">{betError}</p>}
      {betResult && <ResultLine label="Bet submitted" result={betResult} />}

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
        {resolveResult && <ResultLine label="Resolution submitted" result={resolveResult} />}
      </div>
    </div>
  );
}
