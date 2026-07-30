"use client";

import Link from "next/link";
import { useCallback } from "react";
import { useParams } from "next/navigation";
import { useNetwork } from "@/components/network-context";
import { useMarket } from "@/components/use-markets";
import type { Market, MarketCategory } from "@/core/types";
import { motesToCspr } from "@/core/types";
import { computeOdds, formatProbability } from "@/core/parimutuel-odds";
import { BetPanel } from "@/components/bet-panel";
import { RelatedMarkets } from "@/components/related-markets";
import { OracleReputation } from "@/components/oracle-reputation";
import { EvidenceViewer } from "@/components/evidence-viewer";

const CATEGORY_META: Record<MarketCategory, { label: string; className: string; color: string }> = {
  "casper-native": { label: "Casper-native", className: "text-accent", color: "var(--accent)" },
  "provably-fair": { label: "Provably fair", className: "text-gold", color: "var(--gold)" },
  rwa: { label: "RWA", className: "text-up", color: "var(--up)" },
  meta: { label: "Meta", className: "text-accent-2", color: "var(--accent-2)" },
};

function formatCspr(motes: string): string {
  const cspr = motesToCspr(motes);
  return cspr >= 1000 ? `${(cspr / 1000).toFixed(1)}k` : cspr.toFixed(0);
}

function formatDeadline(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-2">{label}</div>
      <div className="num mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

/**
 * The banner that keeps a settled or locked market from masquerading as an open one. Without it
 * the detail page rendered no status at all: a market resolved days ago looked identical to a live
 * one and invited bets whose only refusal was a cryptic server 409.
 */
function MarketStatusBanner({ market }: { market: Market }) {
  if (market.status === "open") return null;

  if (market.status === "resolved") {
    const winner =
      market.outcomes.find((o) => o.key === market.resolvedOutcomeKey)?.label ??
      market.resolvedOutcomeKey ??
      "the winning outcome";
    return (
      <div className="card mb-6 flex flex-wrap items-center gap-3 border-up/40 p-4" role="status">
        <span className="chip border-up/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-up">
          resolved
        </span>
        <p className="text-sm text-foreground">
          This market is settled — <span className="font-semibold text-up">{winner}</span> won.
          Betting is closed; winning stakes were paid from the pool.
        </p>
      </div>
    );
  }

  if (market.status === "void") {
    return (
      <div className="card mb-6 flex flex-wrap items-center gap-3 border-gold/40 p-4" role="status">
        <span className="chip border-gold/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-gold">
          void
        </span>
        <p className="text-sm text-foreground">
          This market was voided — every stake was refunded in full. Betting is closed.
        </p>
      </div>
    );
  }

  // locked: past its deadline, awaiting the oracle.
  return (
    <div className="card mb-6 flex flex-wrap items-center gap-3 border-gold/40 p-4" role="status">
      <span className="chip border-gold/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-gold">
        locked
      </span>
      <p className="text-sm text-foreground">
        This market is locked and awaiting resolution — no further bets. The Arbiter posts the
        winning outcome on-chain once the deciding data is in.
      </p>
    </div>
  );
}

export default function MarketDetailPage() {
  const { network } = useNetwork();
  const params = useParams<{ slug: string }>();
  const slug = params.slug;
  const { market, loading, error, refresh, applyPools } = useMarket(network, slug);

  /**
   * A write from the trade panel landed. The response already carries the post-write pools, so the
   * stat strip, the total-betted block and the odds bars move at once; the `fresh` refetch behind
   * it re-reads past the read model's warm-instance TTL and confirms (or corrects) them.
   */
  const onChainUpdate = useCallback(
    (result: { totalStakedMotes?: string; poolByOutcomeMotes?: Record<string, string> }) => {
      applyPools(result);
      refresh(true);
    },
    [applyPools, refresh],
  );

  if (loading) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
        <div className="skeleton h-6 w-40" />
        <div className="mt-6 h-8 w-2/3 skeleton" />
        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-20 rounded-2xl" />
          ))}
        </div>
      </main>
    );
  }

  if (error || !market) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-16 sm:px-6">
        <p className="text-muted">
          No market <span className="font-mono text-foreground">{slug}</span> on Casper {network}.
        </p>
        <Link href="/markets" className="mt-4 inline-block text-sm text-accent hover:underline">
          ← Back to markets
        </Link>
      </main>
    );
  }

  const cat = CATEGORY_META[market.category];
  // Fee-inclusive: the multiplier beside an outcome must be the number the bet panel's payout
  // preview (and settlement) actually pays, not the gross pool ratio 2 fee-points above it.
  const odds = computeOdds(market, market.feeBps);

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
      <nav className="mb-6 flex items-center gap-2 text-xs text-muted">
        <Link href="/markets" className="hover:text-foreground">
          Markets
        </Link>
        <span>/</span>
        <span className="truncate text-foreground">{market.title}</span>
      </nav>

      <div className="mb-6 flex flex-col gap-3">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
          <span className={`font-semibold ${cat.className}`}>{cat.label}</span>
          <span className="chip px-2 py-0.5 text-muted">{market.network}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-4xl">{market.title}</h1>
        {market.subtitle && <p className="text-muted">{market.subtitle}</p>}
      </div>

      {/* Settled/locked state — said before anything that looks bettable. */}
      <MarketStatusBanner market={market} />

      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total staked" value={`${formatCspr(market.totalStakedMotes)} CSPR`} />
        <Stat label="Outcomes" value={String(market.outcomes.length)} />
        <Stat label="Closes" value={formatDeadline(market.deadlineIso)} />
        <Stat label="Network" value={market.network} />
      </div>

      {/* Total-betted block (kept directly under the stat strip, mirroring Hunch's UI rule) */}
      <div
        className="card card-signal mt-3 flex items-center justify-between p-4"
        style={{ "--card-accent": cat.color } as React.CSSProperties}
      >
        <span className="text-sm text-muted">Total betted so far</span>
        <span className="num text-lg font-semibold">{motesToCspr(market.totalStakedMotes).toLocaleString()} CSPR</span>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        {/* Odds */}
        <div className="card p-5">
          <h3 className="text-sm font-semibold">Pool-implied odds</h3>
          <p className="mt-1 text-xs text-muted">
            A winning outcome splits the whole pool pro-rata among its backers — no seeded AMM.
          </p>
          <div className="mt-4 flex flex-col gap-3">
            {odds.map((o) => {
              const outcome = market.outcomes.find((x) => x.key === o.outcomeKey);
              return (
                <div key={o.outcomeKey} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-foreground">{outcome?.label ?? o.outcomeKey}</span>
                    <span className="num text-muted">
                      {formatProbability(o.impliedProbability)} · {o.payoutMultiple.toFixed(2)}×
                    </span>
                  </div>
                  <div className="odds-track" style={{ height: "0.5rem" }}>
                    <div
                      className="odds-fill"
                      style={{
                        width: `${Math.round(o.impliedProbability * 100)}%`,
                        "--bar-color": cat.color,
                      } as React.CSSProperties}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Human bet panel (CSPR.click-connected) + the reputation-staked oracle that settles it */}
        <div className="flex flex-col gap-4">
          <BetPanel market={market} onChainUpdate={onChainUpdate} />
          <OracleReputation oracleId="arbiter" variant="inline" />
        </div>
      </div>

      {/* Resolution evidence — renders only once a market has settled + published a bundle.
          Status-gated so open markets never fire the probe (a guaranteed 404 in every console). */}
      <EvidenceViewer slug={market.slug} network={network} status={market.status} />

      {/* Related markets — full-width at the foot, per the Hunch UI rule. */}
      <RelatedMarkets market={market} />
    </main>
  );
}
