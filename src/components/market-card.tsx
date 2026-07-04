import Link from "next/link";
import type { Market, MarketCategory } from "@/core/types";
import { motesToCspr } from "@/core/types";
import { computeOdds, formatProbability } from "@/core/parimutuel-odds";

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

export function MarketCard({ market }: { market: Market }) {
  const odds = computeOdds(market);
  const cat = CATEGORY_META[market.category];
  return (
    <Link
      href={`/markets/${market.slug}`}
      className="card group flex flex-col gap-4 p-5 transition-colors hover:border-accent/50"
    >
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wide">
        <span className={`font-semibold ${cat.className}`}>{cat.label}</span>
        <span className="chip px-2 py-0.5 text-muted">{market.network}</span>
      </div>

      <h3 className="text-base font-semibold leading-snug">{market.title}</h3>

      <div className="mt-auto flex flex-col gap-2">
        {odds.map((o) => {
          const outcome = market.outcomes.find((x) => x.key === o.outcomeKey);
          return (
            <div key={o.outcomeKey} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-foreground">{outcome?.label ?? o.outcomeKey}</span>
                <span className="font-mono text-muted">{formatProbability(o.impliedProbability)}</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-accent/70"
                  style={{ width: `${Math.round(o.impliedProbability * 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted">
        <span>{formatCspr(market.totalStakedMotes)} CSPR staked</span>
        <span className="transition-colors group-hover:text-accent">Trade →</span>
      </div>
    </Link>
  );
}
