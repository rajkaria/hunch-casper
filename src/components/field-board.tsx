"use client";

import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import type { Market } from "@/core/types";
import { motesToCspr } from "@/core/types";
import { formatProbability } from "@/core/parimutuel-odds";
import { backedCount, fieldRows, searchOutcomes, type FieldRow } from "@/core/field-board";
import { buidlUrl, findFinalist } from "@/core/buildathon-field";

/**
 * How many rows the board shows before "show all". A 177-row list is cheap to render but
 * expensive to read: the visitor's project is almost never in the first screenful, which is what
 * the search box is for. The cap keeps the resting page about the leaders.
 */
const RESTING_ROWS = 25;

function formatStake(motes: string): string {
  const cspr = motesToCspr(motes);
  if (cspr === 0) return "—";
  return cspr >= 1000 ? `${(cspr / 1000).toFixed(1)}k` : cspr.toFixed(cspr < 10 ? 1 : 0);
}

/**
 * A candidate's row. `onSelect` wires it to the bet panel above rather than navigating: a visitor
 * who found their project by typing should not lose the search to place a bet on it.
 */
function Row({
  row,
  selected,
  onSelect,
  betHref,
  staked,
}: {
  row: FieldRow;
  selected: boolean;
  /** Present in bet mode — aims the panel beside the board at this candidate. */
  onSelect?: (key: string) => void;
  /** Present in browse mode — the market page, pre-aimed at this candidate via the hash. */
  betHref?: string;
  staked: boolean;
}) {
  const { outcome } = row;
  const finalist = findFinalist(outcome.key);
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors ${
        selected ? "border-accent/60 bg-surface-2" : "border-border hover:border-accent/30"
      }`}
    >
      <span className="num w-8 shrink-0 text-right font-mono text-xs text-muted-2">
        {row.rank === null ? "—" : `#${row.rank}`}
      </span>
      <div className="min-w-0 flex-1">
        <Link
          href={`/p/${outcome.key}`}
          className="block truncate text-sm text-foreground hover:text-accent"
          title={outcome.label}
        >
          {outcome.label}
        </Link>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] text-muted-2">
          <span>#{outcome.key}</span>
          {finalist && (
            <a
              href={buidlUrl(outcome.key)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-border underline-offset-2 hover:text-accent"
            >
              DoraHacks ↗
            </a>
          )}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="num text-sm font-semibold">{formatStake(row.stakeMotes)}</div>
        <div className="font-mono text-[10px] text-muted-2">CSPR</div>
      </div>
      <div className="hidden w-20 shrink-0 text-right sm:block">
        <div className="num text-sm">{staked ? formatProbability(row.impliedProbability) : "—"}</div>
        <div className="num font-mono text-[10px] text-muted-2">
          {row.payoutMultiple > 0 ? `${row.payoutMultiple.toFixed(2)}×` : "no stake"}
        </div>
      </div>
      {onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(outcome.key)}
          className={`chip shrink-0 px-3 py-1.5 text-xs font-medium transition-colors ${
            selected ? "border-accent/60 text-accent" : "text-muted hover:text-foreground"
          }`}
          aria-pressed={selected}
        >
          {selected ? "Backing" : "Back"}
        </button>
      ) : (
        <Link
          href={betHref ?? "#"}
          className="chip shrink-0 px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:text-foreground"
        >
          Back
        </Link>
      )}
    </div>
  );
}

/**
 * The searchable standings for a wide-field market.
 *
 * Search is the primary interaction, not a filter: with 177 candidates the question a visitor
 * arrives with is "where is mine", and the answer has to be one keystroke away. Everything is
 * derived client-side from the market already on the page — no round trip per keystroke.
 */
export function FieldBoard({
  market,
  selectedKey = "",
  onSelect,
}: {
  market: Market;
  selectedKey?: string;
  /**
   * Bet mode. Omit it for BROWSE mode (the /buildathon hub, which has no bet panel): each row's
   * button becomes a link to the market page with the candidate in the hash, so "Back" from
   * anywhere lands on a bet form already aimed at the right project.
   */
  onSelect?: (key: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  // The input stays responsive while the 177-row list re-derives behind it.
  const deferredQuery = useDeferredValue(query);

  const rows = useMemo(() => fieldRows(market), [market]);
  const searching = deferredQuery.trim().length > 0;
  const shown = useMemo(() => {
    if (!searching) return rows;
    // Search ranks by relevance; the standings order is the tiebreak inside it.
    const ranked = searchOutcomes(
      rows.map((r) => r.outcome),
      deferredQuery,
    );
    const byKey = new Map(rows.map((r) => [r.outcome.key, r]));
    return ranked.map((o) => byKey.get(o.key)).filter((r): r is FieldRow => r !== undefined);
  }, [rows, deferredQuery, searching]);

  const staked = BigInt(market.totalStakedMotes) > 0n;
  const backed = backedCount(market);
  const visible = searching || expanded ? shown : shown.slice(0, RESTING_ROWS);

  return (
    <div className="card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">The field</h3>
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-2">
          {market.outcomes.length} projects · {backed} backed
        </p>
      </div>
      <p className="mt-1 text-xs text-muted">
        {staked
          ? "Ranked by stake. A winning candidate splits the whole pool pro-rata among its backers — no seeded AMM, no house position."
          : "Nothing is staked yet — every pool starts at zero, so the first bet sets the line. There is no house position on this board."}
      </p>

      <label className="mt-4 flex items-center gap-2 rounded-full border border-border bg-surface-2 px-4 py-2 transition-colors focus-within:border-accent/60">
        <span aria-hidden className="text-muted-2">
          ⌕
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter backs the top hit — the fastest path from "find my project" to "bet on it".
            if (e.key === "Enter" && visible[0]) onSelect?.(visible[0].outcome.key);
          }}
          placeholder={`Search ${market.outcomes.length} projects by name or BUIDL id…`}
          className="w-full bg-transparent text-sm outline-none"
          aria-label="Search the field"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="text-xs text-muted hover:text-foreground"
            aria-label="Clear search"
          >
            ✕
          </button>
        )}
      </label>

      {searching && (
        <p className="mt-2 text-[11px] text-muted">
          {visible.length === 0
            ? "No project matches that. Try the BUIDL id."
            : `${visible.length} match${visible.length === 1 ? "" : "es"}${onSelect ? " · Enter backs the first" : ""}`}
        </p>
      )}

      <div className="mt-3 flex flex-col gap-1.5">
        {visible.map((row) => (
          <Row
            key={row.outcome.key}
            row={row}
            selected={row.outcome.key === selectedKey}
            onSelect={onSelect}
            betHref={`/markets/${market.slug}#${row.outcome.key}`}
            staked={staked}
          />
        ))}
      </div>

      {!searching && shown.length > RESTING_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-3 w-full rounded-lg border border-border px-4 py-2 text-xs font-semibold text-muted transition-colors hover:border-accent/40 hover:text-foreground"
        >
          {expanded ? "Show top 25" : `Show all ${shown.length} projects`}
        </button>
      )}
    </div>
  );
}
