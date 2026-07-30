"use client";

import Link from "next/link";
import { useNetwork } from "@/components/network-context";
import { useMarkets } from "@/components/use-markets";
import { marketHref } from "@/components/market-card";
import { computeOdds, formatProbability } from "@/core/parimutuel-odds";
import { motesToCspr } from "@/core/types";
import type { Market } from "@/core/types";

/**
 * The live odds tape under the hero — real markets from the read model scrolling like a
 * terminal ticker. Marquee is pure CSS (`.marquee` in globals.css): edge-masked, pauses on
 * hover, and each entry links straight to its market. Renders nothing until markets load —
 * an empty tape would just be a stripe of dead space.
 */

function TickerEntry({ market, focusable }: { market: Market; focusable: boolean }) {
  const odds = computeOdds(market);
  const top = odds.reduce((a, b) => (b.impliedProbability > a.impliedProbability ? b : a), odds[0]);
  const label = market.outcomes.find((o) => o.key === top?.outcomeKey)?.label ?? top?.outcomeKey ?? "";
  const staked = motesToCspr(market.totalStakedMotes);

  return (
    <Link
      href={marketHref(market.slug)}
      // The duplicate marquee copy is aria-hidden, but hidden links must not stay in the tab order.
      tabIndex={focusable ? undefined : -1}
      className="group flex shrink-0 items-center gap-2.5 px-5 py-2.5 text-xs whitespace-nowrap"
    >
      <span className="text-muted transition-colors group-hover:text-foreground">{market.title}</span>
      <span className="num font-semibold text-up">
        {label} {top ? formatProbability(top.impliedProbability) : ""}
      </span>
      <span className="num text-muted-2">{staked >= 1000 ? `${(staked / 1000).toFixed(1)}k` : staked.toFixed(0)} CSPR</span>
      <span aria-hidden="true" className="pl-2 text-border-strong">
        ◆
      </span>
    </Link>
  );
}

export function MarketTicker() {
  const { network } = useNetwork();
  const { markets, loading } = useMarkets(network);

  if (loading || markets.length === 0) return null;
  const shown = markets.slice(0, 14);

  return (
    <div className="marquee border-y border-border bg-surface/60" aria-label="Live market odds">
      {[0, 1].map((copy) => (
        <div
          key={copy}
          className="marquee-track"
          style={{ "--marquee-duration": `${Math.max(30, shown.length * 5)}s` } as React.CSSProperties}
          aria-hidden={copy === 1}
        >
          {shown.map((m) => (
            <TickerEntry key={`${copy}-${m.id}`} market={m} focusable={copy === 0} />
          ))}
        </div>
      ))}
    </div>
  );
}
