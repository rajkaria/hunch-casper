"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import type { Market } from "@/core/types";
import { motesToCspr } from "@/core/types";
import { formatProbability } from "@/core/parimutuel-odds";
import { fieldSummary, isWideField } from "@/core/field-board";
import { BUILDATHON_MARKET_SLUG } from "@/core/buildathon-field";
import { CATEGORY_META, marketHref } from "@/components/market-card";

/** Leaders on the headline card. Five fits the panel without turning it into the standings. */
const HERO_LEADERS = 5;

function formatStaked(motes: string): string {
  const cspr = motesToCspr(motes);
  if (cspr === 0) return "0";
  if (cspr >= 1000) return `${(cspr / 1000).toFixed(1)}k`;
  return cspr.toFixed(cspr < 10 ? 1 : 0);
}

/**
 * Time left, coarse on purpose. "29 days" is the honest resolution of a month-long market, and a
 * ticking second counter on a server-rendered page is a hydration mismatch waiting to happen.
 */
function closesIn(deadlineIso: string, now: number | null): string {
  if (now === null) return "—";
  const ms = new Date(deadlineIso).getTime() - now;
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "closed";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min`;
}

const MINUTE_MS = 60_000;

function subscribeToMinute(onChange: () => void): () => void {
  const timer = setInterval(onChange, MINUTE_MS);
  return () => clearInterval(timer);
}

/**
 * The snapshot is the current MINUTE, not the current millisecond: an external store's snapshot
 * has to be stable between reads, and `Date.now()` would hand React a new value every render and
 * spin forever. A month-long countdown does not need finer than this.
 */
const currentMinute = (): number => Math.floor(Date.now() / MINUTE_MS);

/** No clock on the server — rendering one would disagree with its own hydration. */
const noMinute = (): null => null;

/** Wall clock, floored to the minute and refreshed each minute. `null` until the client has one. */
function useNow(): number | null {
  const minute = useSyncExternalStore(subscribeToMinute, currentMinute, noMinute);
  return minute === null ? null : minute * MINUTE_MS;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/60 px-3 py-2.5">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-2">{label}</div>
      <div className="num mt-0.5 text-sm font-semibold text-foreground">{value}</div>
      {hint && <div className="mt-0.5 font-mono text-[10px] text-muted-2">{hint}</div>}
    </div>
  );
}

/**
 * The pinned market, rendered as the board's headline instead of one card in the grid.
 *
 * Wide fields get the standings panel on the right; anything else gets its outcome bars there, so
 * the same headline works if the pin ever moves to a two-outcome market. The card is a container
 * of links rather than one big link: "back your project" and "browse the field" are different
 * intents and a visitor should be able to aim at either.
 */
export function FeaturedMarket({ market, now: fixedNow }: { market: Market; now?: number }) {
  const clock = useNow();
  const now = fixedNow ?? clock;
  const cat = CATEGORY_META[market.category];
  const wide = isWideField(market);
  const summary = fieldSummary(market, HERO_LEADERS);
  const staked = summary.staked;

  return (
    <section
      aria-label="Featured market"
      className="card card-signal relative mb-8 overflow-hidden p-5 sm:p-6"
      style={
        {
          "--card-accent": cat.color,
          boxShadow: "0 24px 60px -30px rgba(0,0,0,0.9), 0 0 40px -24px var(--gold-wash)",
          borderColor: "color-mix(in srgb, var(--gold) 28%, var(--border))",
        } as React.CSSProperties
      }
    >
      {/* A wash behind the headline so the pin reads as a different surface, not a bigger card. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(120% 100% at 0% 0%, var(--gold-wash), transparent 55%), radial-gradient(90% 80% at 100% 0%, var(--violet-wash), transparent 60%)",
        }}
      />

      <div className="relative grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
            <span className="chip flex items-center gap-1.5 border-gold/50 px-2.5 py-1 font-semibold text-gold">
              <span aria-hidden>★</span> Featured
            </span>
            <span className={`font-semibold ${cat.className}`}>{cat.label}</span>
            <span className="chip px-2 py-0.5 text-muted">{market.network}</span>
            {market.status === "open" && (
              <span className="chip flex items-center gap-1.5 px-2 py-0.5 text-muted">
                <span className="live-dot" aria-hidden /> Open
              </span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <h2 className="text-2xl font-semibold leading-tight tracking-tight sm:text-3xl">
              <Link href={marketHref(market.slug)} className="transition-colors hover:text-gold">
                {market.title}
              </Link>
            </h2>
            {market.subtitle && <p className="max-w-2xl text-sm text-muted">{market.subtitle}</p>}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label={wide ? "Field" : "Outcomes"}
              value={wide ? `${summary.candidates} projects` : String(market.outcomes.length)}
              hint={wide ? `${summary.backed} backed` : undefined}
            />
            <Stat label="Staked" value={`${formatStaked(market.totalStakedMotes)} CSPR`} hint="no house seed" />
            <Stat label="Closes in" value={closesIn(market.deadlineIso, now)} hint="or on the result" />
            <Stat label="Fee" value={`${(market.feeBps / 100).toFixed(0)}%`} hint="losing pool only" />
          </div>

          <div className="mt-auto flex flex-wrap items-center gap-2.5">
            <Link href={marketHref(market.slug)} className="btn btn-primary text-sm">
              {wide ? "Find your project" : "Trade this market"} <span aria-hidden>→</span>
            </Link>
            {market.slug === BUILDATHON_MARKET_SLUG && (
              <Link href="/buildathon" className="btn btn-ghost text-sm">
                The buildathon hub
              </Link>
            )}
          </div>
        </div>

        <div className="flex flex-col rounded-2xl border border-border bg-surface/60 p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold">{wide ? "The field" : "Pool-implied odds"}</h3>
            <span className="num font-mono text-[10px] uppercase tracking-wider text-muted-2">
              {staked ? "by stake" : "unbet"}
            </span>
          </div>

          {staked ? (
            <div className="mt-3 flex flex-col gap-2.5">
              {summary.leaders.map((row) => (
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
                    <span className="num shrink-0 text-muted">
                      {formatProbability(row.impliedProbability)}
                    </span>
                  </div>
                  <div className="odds-track">
                    <div
                      className="odds-fill"
                      style={
                        {
                          width: `${Math.round(row.impliedProbability * 100)}%`,
                          "--bar-color": cat.color,
                        } as React.CSSProperties
                      }
                    />
                  </div>
                </div>
              ))}
              {summary.rest > 0 && (
                <span className="font-mono text-[10px] text-muted-2">
                  +{summary.rest} more in the field
                </span>
              )}
            </div>
          ) : (
            <div className="mt-3 flex flex-1 flex-col justify-center gap-3 rounded-xl border border-dashed border-border px-4 py-5 text-center">
              <div>
                <div className="num text-3xl font-semibold text-gold">{summary.candidates}</div>
                <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-2">
                  candidates, all at zero
                </div>
              </div>
              <p className="text-xs leading-relaxed text-muted">
                Nothing is staked and nothing is seeded — there is no house position on this board.
                The first bet sets the line.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
