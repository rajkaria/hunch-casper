"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo } from "react";
import { useNetwork } from "@/components/network-context";
import { buildCatalogue } from "@/core/catalogue";
import type { MarketCategory } from "@/core/types";
import { motesToCspr } from "@/core/types";
import { computeOdds, formatProbability } from "@/core/parimutuel-odds";
import { BetPanel } from "@/components/bet-panel";

const CATEGORY_META: Record<MarketCategory, { label: string; className: string }> = {
  "casper-native": { label: "Casper-native", className: "text-accent" },
  "provably-fair": { label: "Provably fair", className: "text-gold" },
  rwa: { label: "RWA", className: "text-up" },
  meta: { label: "Meta", className: "text-accent-2" },
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
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

export default function MarketDetailPage() {
  const { network } = useNetwork();
  const params = useParams<{ slug: string }>();
  const slug = params.slug;

  const market = useMemo(
    () => buildCatalogue(network).find((m) => m.slug === slug),
    [network, slug],
  );

  if (!market) {
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
  const odds = computeOdds(market);

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
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide">
          <span className={`font-semibold ${cat.className}`}>{cat.label}</span>
          <span className="chip px-2 py-0.5 text-muted">{market.network}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{market.title}</h1>
        {market.subtitle && <p className="text-muted">{market.subtitle}</p>}
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total staked" value={`${formatCspr(market.totalStakedMotes)} CSPR`} />
        <Stat label="Outcomes" value={String(market.outcomes.length)} />
        <Stat label="Closes" value={formatDeadline(market.deadlineIso)} />
        <Stat label="Network" value={market.network} />
      </div>

      {/* Total-betted block (kept directly under the stat strip, mirroring Hunch's UI rule) */}
      <div className="mt-3 card flex items-center justify-between p-4">
        <span className="text-sm text-muted">Total betted so far</span>
        <span className="text-lg font-semibold">{motesToCspr(market.totalStakedMotes).toLocaleString()} CSPR</span>
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
                    <span className="font-mono text-muted">
                      {formatProbability(o.impliedProbability)} · {o.payoutMultiple.toFixed(2)}×
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full bg-accent/70"
                      style={{ width: `${Math.round(o.impliedProbability * 100)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Thin-slice trade panel */}
        <BetPanel market={market} />
      </div>
    </main>
  );
}
