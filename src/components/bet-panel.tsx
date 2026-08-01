"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Market } from "@/core/types";
import type { CasperNetwork } from "@/config/network";
import { csprToMotes, motesToCspr } from "@/core/types";
import { previewPayoutMotes } from "@/core/market-payout";
import { WIDE_FIELD_THRESHOLD } from "@/core/field-board";
import { exceedsBetCap, maxBetCspr } from "@/config/network";
import { isDemoAccount, useWallet } from "@/components/wallet-context";

/**
 * How far along a submitted bet is.
 *
 * `pending` is a real, showable state, not an absence of one: a node has the transaction and the
 * hash is final, but Casper takes 8-16s to execute it. The receipt appears here — hash, copy
 * button, explorer link — instead of after, which is the whole point. `confirmed` is the only
 * state in which the pools may move.
 *
 * `unconfirmed` is CLIENT-assigned, never sent by the server: the poll window closed (or the
 * confirm route errored) without a verdict, so this page stopped watching. It is terminal here —
 * without it the receipt kept pulsing "confirming" forever under the timeout message — but says
 * nothing about the transaction itself, which the explorer link answers.
 */
type BetStatus = "pending" | "confirmed" | "reverted" | "unconfirmed";

interface ChainResult {
  deployHash: string;
  explorerUrl: string;
  simulated?: boolean;
  /** Absent on a resolve response, which has no lifecycle to show — read as `confirmed`. */
  status?: BetStatus;
  /** The ticket to poll `/api/chain/bet/confirm` with. Present while a bet is still pending. */
  ticket?: string;
  /** Why the chain refused it, when `status === "reverted"`. */
  error?: string;
  /** Present when the chain took the bet but the off-chain read model refused it (see the routes). */
  indexed?: boolean;
  /** Post-write pools, straight from the store — what the page renders without waiting for a refetch. */
  totalStakedMotes?: string;
  poolByOutcomeMotes?: Record<string, string>;
}

/**
 * How often the browser asks the chain whether a submitted bet has executed.
 *
 * Each poll is one cheap RPC read behind our own route. Testnet blocks land every 8s, so 2.5s
 * keeps the confirmation visible within a second or so of the chain having it without hammering
 * the node.
 */
const POLL_INTERVAL_MS = 2_500;
/**
 * When to stop asking and let the visitor take it to the explorer themselves. Generous: the point
 * is never to claim a bet happened, and a transaction still unexecuted after this is a chain
 * problem the receipt's link answers better than a spinner would.
 */
const POLL_TIMEOUT_MS = 180_000;

/**
 * The largest stake the panel will even price: 1 billion CSPR, comfortably past every real bet
 * (total CSPR supply is ~13B) and comfortably inside what the motes math can hold.
 */
export const MAX_STAKE_CSPR = 1_000_000_000;

/**
 * Parse the stake input to a bettable CSPR amount, or `null`.
 *
 * The upper bound is load-bearing, not taste: `Number.isFinite(1e300)` is true, but
 * `csprToMotes(1e300)` rounds to `Infinity` and `BigInt(Infinity)` THROWS — a RangeError from a
 * text field that crashed the page. Anything a wallet could never fund is invalid input, same as
 * a negative number.
 */
export function parseStakeCspr(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_STAKE_CSPR) return null;
  return value;
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
  const status = result.status ?? "confirmed";
  const pending = status === "pending";
  const reverted = status === "reverted";
  const unconfirmed = status === "unconfirmed";
  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-2 p-3 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <span
          className={`font-semibold ${
            reverted ? "text-down" : pending || unconfirmed ? "text-gold" : "text-up"
          }`}
        >
          {reverted
            ? "Bet rejected on chain"
            : pending
              ? "Submitted to the chain"
              : unconfirmed
                ? "Submitted — not confirmed here"
                : label}
        </span>
        {result.simulated ? (
          <span className="chip px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">simulated</span>
        ) : reverted ? (
          <span className="chip border-down/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-down">
            reverted · {network}
          </span>
        ) : pending ? (
          // The honest label for the 8-16s a Casper transaction takes to execute. The visitor holds
          // a real hash they can follow to the explorer for the whole of it.
          <span className="chip border-gold/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gold">
            <span className="mr-1 inline-block animate-pulse">●</span>
            confirming · {network}
          </span>
        ) : unconfirmed ? (
          // Deliberately NOT the pulsing "confirming" chip: this page has stopped watching, and a
          // pulse that never resolves would claim otherwise.
          <span className="chip border-gold/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gold">
            unconfirmed · {network}
          </span>
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
      {pending && (
        <p className="mt-2 text-[11px] text-muted">
          Your wallet has sent it and the hash above is final. Casper takes a few seconds to execute
          it — the pools move here the moment it lands.
        </p>
      )}
      {unconfirmed && (
        <p className="mt-2 text-[11px] text-muted">
          Unconfirmed — check the explorer. This page stopped watching, but the transaction is on
          the chain and the link above shows exactly where it got to.
        </p>
      )}
      {reverted && (
        // No value moved, so nothing is on the boards. Say what the chain said rather than leaving
        // a receipt that looks placed.
        <p className="mt-2 text-[11px] text-down">
          {result.error ?? "The chain refused this transaction."} No stake was escrowed.
        </p>
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
  selectedOutcomeKey,
  onSelectOutcome,
}: {
  market: Market;
  /**
   * Fired once the chain accepts a write from this panel (a bet, or an operator resolve), with the
   * route's response. The page uses it to move the pools/odds immediately — a bet response carries
   * the post-write read model — and to refetch behind that. Without it a visitor sees their own
   * stake missing from the board they just moved.
   */
  onChainUpdate?: (result: ChainResult) => void;
  /**
   * Selection, lifted. A two-outcome market picks its side from the chip row in here; a
   * 177-candidate field picks it from the searchable board beside the panel, and rendering 177
   * chips in a betting panel would be neither usable nor honest about what the market is. When
   * this is passed the panel is CONTROLLED: it shows what is selected and drops the chip row.
   */
  selectedOutcomeKey?: string;
  /** Set when controlled — lets the panel clear or change the selection back at the owner. */
  onSelectOutcome?: (key: string) => void;
}) {
  const { account, connected, connect, connectError, signAndSend, signingDisabledReason } = useWallet();
  const controlled = selectedOutcomeKey !== undefined;
  const [ownOutcomeKey, setOwnOutcomeKey] = useState(market.outcomes[0]?.key ?? "");
  const outcomeKey = controlled ? selectedOutcomeKey : ownOutcomeKey;
  const setOutcomeKey = onSelectOutcome ?? setOwnOutcomeKey;
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
  async function betWithWallet(amountMotes: string, bettor: string): Promise<ChainResult | null> {
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

    // Done — as far as this function is concerned. The chain has the transaction and the hash is
    // final, so the receipt goes up NOW and the confirmation effect below carries it to a verdict.
    // Waiting here for execution is what used to leave the panel blank for 15-25 seconds while
    // holding a hash it could have shown from the first moment.
    return {
      deployHash: prep.transactionHash,
      explorerUrl: prep.explorerUrl,
      status: "pending",
      ticket: prep.ticket,
    };
  }

  async function placeBet() {
    if (!account) {
      connect();
      return;
    }
    // The button is disabled for invalid input, but this function must not be one stale render
    // away from `BigInt(Infinity)` — parse again and refuse, never crash.
    const stakeCspr = parseStakeCspr(amount);
    if (stakeCspr === null) return;
    setBetting(true);
    setBetError(null);
    setBetResult(null);
    try {
      const amountMotes = csprToMotes(stakeCspr);
      const self = await betWithWallet(amountMotes, account.publicKey);
      if (self !== null) {
        setBetResult(self);
        return; // pools stay put until the chain confirms — see the poller
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
      const json = (await res.json()) as ChainResult & { error?: string };
      if (!res.ok) throw new Error(json.error ?? "bet failed");
      setBetResult(json);
      // A route that confirmed inline (the simulated chain) already holds the post-write pools.
      // A pending one has moved nothing yet, and the poller reports it when it does.
      if ((json.status ?? "confirmed") === "confirmed") onChainUpdate?.(json);
    } catch (err) {
      setBetError(err instanceof Error ? err.message : "bet failed");
    } finally {
      setBetting(false);
    }
  }

  /**
   * Drive a submitted bet to a verdict.
   *
   * Keyed on the transaction hash, so placing a second bet supersedes the first one's poll rather
   * than racing it. Every terminal answer is the SERVER'S — this only asks; it never decides that
   * a bet landed, and it never moves the pools itself: the confirmed response carries the store's
   * own post-write read model, exactly as the inline path did.
   */
  const pendingHash = betResult?.status === "pending" ? betResult.deployHash : null;
  const pendingTicket = betResult?.status === "pending" ? betResult.ticket : undefined;
  /** A bet is submitted and this panel is still the thing chasing its verdict. */
  const confirming = pendingHash !== null && pendingTicket !== undefined;
  // Held in a ref, not a dependency: a caller that passes an inline arrow would otherwise change
  // identity on every render and restart the poll loop from zero, forever.
  const onChainUpdateRef = useRef(onChainUpdate);
  useEffect(() => {
    onChainUpdateRef.current = onChainUpdate;
  }, [onChainUpdate]);

  useEffect(() => {
    if (!pendingHash || !pendingTicket) return;
    let stopped = false;
    const ctrl = new AbortController();
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    /**
     * Stop chasing this transaction: hash and explorer link stay intact, but the status flips to
     * the terminal `unconfirmed` — a receipt that kept saying "confirming" with nothing confirming
     * it pulsed forever under the timeout message. Dropping the ticket is what disarms this effect
     * AND releases the bet button — a panel that gave up but stayed locked would strand the
     * visitor on a page that can no longer do anything.
     */
    const giveUp = () =>
      setBetResult((prev) =>
        prev && prev.status === "pending" ? { ...prev, status: "unconfirmed", ticket: undefined } : prev,
      );

    const poll = async (): Promise<void> => {
      while (!stopped) {
        try {
          const res = await fetch("/api/chain/bet/confirm", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ticket: pendingTicket }),
            signal: ctrl.signal,
            cache: "no-store",
          });
          const json = (await res.json()) as ChainResult & { error?: string };
          if (stopped) return;
          if (!res.ok) {
            setBetError(json.error ?? "the bet was submitted but could not be confirmed");
            giveUp();
            return;
          }
          if (json.status !== "pending") {
            // Terminal. Keep the ticket off the result so this effect does not re-arm.
            setBetResult({ ...json, ticket: undefined });
            if (json.status === "confirmed") onChainUpdateRef.current?.(json);
            return;
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          // A dropped poll is not a failed bet — the transaction is on the chain either way. Keep
          // asking until the window closes; the receipt on screen stays valid throughout.
        }
        if (Date.now() >= deadline) {
          setBetError(
            "This transaction has not executed yet — it is on the chain, so follow the link above " +
              "to see where it got to.",
          );
          giveUp();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
    };
    void poll();

    return () => {
      stopped = true;
      ctrl.abort();
    };
  }, [pendingHash, pendingTicket]);

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

  // The status gate — AFTER every hook (status can flip open→resolved under a live page, and
  // hooks must keep their order), BEFORE anything that looks bettable. A resolved market used to
  // render the same armed form as an open one: stake input, payout preview, live CTA — and the
  // only thing standing between a visitor and a bet on a 10-day-settled market was a server 409.
  if (market.status !== "open") {
    const winner =
      market.outcomes.find((o) => o.key === market.resolvedOutcomeKey)?.label ??
      market.resolvedOutcomeKey;
    return (
      <div className="card p-5">
        <h3 className="text-sm font-semibold">Betting closed</h3>
        {market.status === "resolved" && (
          <p className="mt-2 text-xs text-muted">
            This market is settled — <span className="font-semibold text-up">{winner ?? "the winning outcome"}</span>{" "}
            won. Winning stakes were paid from the pool; no further bets.
          </p>
        )}
        {market.status === "void" && (
          <p className="mt-2 text-xs text-muted">
            This market was voided and every stake refunded in full. No further bets.
          </p>
        )}
        {market.status === "locked" && (
          <>
            <p className="mt-2 text-xs text-muted">
              This market is locked and awaiting resolution — the deadline has passed, so no
              further bets can enter the pool.
            </p>
            <p className="mt-3 border-t border-border pt-3 text-[11px] text-muted">
              Resolution is the autonomous <span className="text-foreground">Arbiter</span>’s job —
              it posts the winning outcome on-chain with its reputation staked. Watch it on the{" "}
              <Link href="/agents" className="underline decoration-border underline-offset-2 hover:text-accent">
                swarm dashboard
              </Link>
              .
            </p>
          </>
        )}
      </div>
    );
  }

  const stakeCspr = parseStakeCspr(amount);
  const amountValid = stakeCspr !== null;
  const betCap = maxBetCspr(market.network);
  const overCap = stakeCspr !== null && exceedsBetCap(market.network, stakeCspr);
  // Belt over the braces above: parseStakeCspr already bounds what reaches the motes math, but a
  // preview must NEVER be able to take the page down — a broken preview is a missing line, not a
  // crash loop.
  let previewCspr = 0;
  if (stakeCspr !== null && outcomeKey) {
    try {
      previewCspr = motesToCspr(
        previewPayoutMotes(market.poolByOutcomeMotes, outcomeKey, csprToMotes(stakeCspr), market.feeBps),
      );
    } catch {
      previewCspr = 0;
    }
  }

  const selectedLabel = market.outcomes.find((o) => o.key === outcomeKey)?.label ?? null;

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold">Place a bet</h3>
      <p className="mt-1 text-xs text-muted">
        Stake CSPR on an outcome. Settlement runs through the active chain adapter.
      </p>

      {controlled ? (
        <div className="mt-4 rounded-xl border border-border bg-surface-2 px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-muted-2">Backing</div>
          {selectedLabel ? (
            <div className="mt-1 truncate text-sm font-semibold text-foreground" title={selectedLabel}>
              {selectedLabel}
            </div>
          ) : (
            <div className="mt-1 text-sm text-muted">Pick a project from the field →</div>
          )}
        </div>
      ) : (
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
      )}

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
          // Held shut while a bet is confirming, not because the panel is busy — it is not — but
          // because this client is the only thing polling that transaction into the read model.
          // Starting a second bet would abandon the first: escrowed on chain, absent from the
          // boards. It is a few seconds, and the receipt below says exactly what is happening.
          disabled={betting || confirming || (connected && (!amountValid || !outcomeKey || overCap))}
          className="btn btn-primary px-5 py-2 disabled:opacity-40"
        >
          {betting ? "Placing…" : confirming ? "Confirming…" : connected ? "Place bet" : "Connect wallet"}
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
          If <span className="text-foreground">{selectedLabel ?? outcomeKey}</span>{" "}
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
          {/* A wide field gets a typed key, not a chip per candidate: 177 chips is not a control. */}
          {market.outcomes.length > WIDE_FIELD_THRESHOLD ? (
            <input
              value={resolveKey}
              onChange={(e) => setResolveKey(e.target.value.trim())}
              list="resolve-outcome-keys"
              placeholder="Winning outcome key"
              aria-label="Winning outcome key"
              className="flex-1 rounded-full border border-border bg-surface-2 px-4 py-2 font-mono text-xs outline-none focus:border-gold/60"
            />
          ) : (
            market.outcomes.map((o) => {
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
            })
          )}
          <datalist id="resolve-outcome-keys">
            {market.outcomes.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </datalist>
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
