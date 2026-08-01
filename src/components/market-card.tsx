import Link from "next/link";
import type { Market, MarketCategory } from "@/core/types";
import { motesToCspr } from "@/core/types";
import { computeOdds, formatProbability } from "@/core/parimutuel-odds";
import { fieldSummary, isWideField } from "@/core/field-board";

const CATEGORY_META: Record<MarketCategory, { label: string; className: string; color: string }> = {
  "casper-native": { label: "Casper-native", className: "text-accent", color: "var(--accent)" },
  "provably-fair": { label: "Provably fair", className: "text-gold", color: "var(--gold)" },
  rwa: { label: "RWA", className: "text-up", color: "var(--up)" },
  meta: { label: "Meta", className: "text-accent-2", color: "var(--accent-2)" },
  community: { label: "Community", className: "text-gold", color: "var(--gold)" },
};

function formatCspr(motes: string): string {
  const cspr = motesToCspr(motes);
  return cspr >= 1000 ? `${(cspr / 1000).toFixed(1)}k` : cspr.toFixed(0);
}

/**
 * Market page path with the slug percent-encoded. Round slugs contain `#`
 * (`cspr-hourly-updown#20658`), which a raw href would turn into a URL fragment — the link
 * would land on the base market, not the round.
 */
export function marketHref(slug: string): string {
  return `/markets/${encodeURIComponent(slug)}`;
}

/** Status chip copy for a non-open market; `null` for open markets (no chip). */
export function marketStatusChip(market: Market): string | null {
  if (market.status === "resolved") {
    const winner = market.outcomes.find((o) => o.key === market.resolvedOutcomeKey);
    return `Resolved · ${winner?.label ?? market.resolvedOutcomeKey ?? "—"}`;
  }
  if (market.status === "locked") return "Locked";
  if (market.status === "void") return "Void";
  return null;
}

/** How many markets are live — only `open` trades; locked/resolved/void have stopped. */
export function countLiveMarkets(markets: Market[]): number {
  return markets.filter((m) => m.status === "open").length;
}

/** Live (open) market count per category — drives copy that must never contradict the board. */
export function liveCountsByCategory(markets: Market[]): Record<MarketCategory, number> {
  const counts: Record<MarketCategory, number> = { "casper-native": 0, "provably-fair": 0, rwa: 0, meta: 0, community: 0 };
  for (const m of markets) {
    if (m.status === "open") counts[m.category] += 1;
  }
  return counts;
}

/**
 * How many candidates a wide-field card shows. Three keeps the card the same height as a
 * two-to-four-outcome card, which is the whole point: one 177-row card in a three-column grid
 * stretched its entire row and pushed every neighbouring market off the screen.
 */
const FIELD_CARD_LEADERS = 3;

/**
 * The body of a wide-field card: the field's shape (how many candidates, how many actually
 * backed) plus the podium — never the full list. Before anything is staked there is no podium to
 * show, so the card says so rather than printing three arbitrary 0% bars.
 */
function FieldCardBody({ market, color }: { market: Market; color: string }) {
  const { candidates, backed, staked, leaders, rest } = fieldSummary(market, FIELD_CARD_LEADERS);

  return (
    <div className="mt-auto flex flex-col gap-2">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-muted-2">
        <span className="num">{candidates} candidates</span>
        <span className="num">{backed} backed</span>
      </div>

      {staked ? (
        <>
          {leaders.map((row) => (
            <div key={row.outcome.key} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="num shrink-0 font-mono text-[10px] text-muted-2">
                    #{row.rank ?? "—"}
                  </span>
                  <span className="truncate text-foreground" title={row.outcome.label}>
                    {row.outcome.label}
                  </span>
                </span>
                <span className="num shrink-0 text-muted">{formatProbability(row.impliedProbability)}</span>
              </div>
              <div className="odds-track">
                <div
                  className="odds-fill"
                  style={{
                    width: `${Math.round(row.impliedProbability * 100)}%`,
                    "--bar-color": color,
                  } as React.CSSProperties}
                />
              </div>
            </div>
          ))}
          {rest > 0 && (
            <span className="font-mono text-[10px] text-muted-2">+{rest} more in the field</span>
          )}
        </>
      ) : (
        <p className="rounded-xl border border-dashed border-border px-3 py-2.5 text-xs leading-relaxed text-muted">
          Every pool starts at zero — the first bet sets the favourite.
        </p>
      )}
    </div>
  );
}

export function MarketCard({ market }: { market: Market }) {
  const wideField = isWideField(market);
  const odds = wideField ? [] : computeOdds(market);
  const cat = CATEGORY_META[market.category];
  const statusChip = marketStatusChip(market);
  return (
    <Link
      href={marketHref(market.slug)}
      className="card card-hover card-signal group flex flex-col gap-4 p-5"
      style={{ "--card-accent": cat.color } as React.CSSProperties}
    >
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider">
        <span className={`font-semibold ${cat.className}`}>{cat.label}</span>
        <span className="flex items-center gap-1.5">
          {statusChip && (
            <span className={`chip px-2 py-0.5 ${market.status === "resolved" ? "text-gold" : "text-muted"}`}>
              {statusChip}
            </span>
          )}
          <span className="chip px-2 py-0.5 text-muted">{market.network}</span>
        </span>
      </div>

      <h3 className="text-base font-semibold leading-snug">{market.title}</h3>

      {wideField ? (
        <FieldCardBody market={market} color={cat.color} />
      ) : (
      <div className="mt-auto flex flex-col gap-2">
        {odds.map((o) => {
          const outcome = market.outcomes.find((x) => x.key === o.outcomeKey);
          return (
            <div key={o.outcomeKey} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-foreground">{outcome?.label ?? o.outcomeKey}</span>
                <span className="num text-muted">{formatProbability(o.impliedProbability)}</span>
              </div>
              <div className="odds-track">
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
      )}

      <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted">
        <span className="num">{formatCspr(market.totalStakedMotes)} CSPR staked</span>
        <span className="font-semibold transition-colors group-hover:text-accent">
          {market.status === "open" ? "Trade" : "View"}{" "}
          <span aria-hidden="true" className="inline-block transition-transform duration-300 group-hover:translate-x-0.5">
            →
          </span>
        </span>
      </div>
    </Link>
  );
}
