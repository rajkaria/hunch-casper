/**
 * Pure server-side renderer for the embeddable odds widget. Takes a market and returns a complete,
 * self-contained HTML document — inline CSS, inline SVG bars, zero client JavaScript, zero secrets.
 * Because it is pure (market in, string out) the exact markup is unit-testable without a route, a
 * browser, or a network, and the route handler is a thin cache-header wrapper over it.
 *
 * Design constraints, all load-bearing for an *embed*:
 *   • No external requests — an iframe on someone else's page must not phone home or leak a
 *     referrer to a CDN; fonts are the system stack, colours are literals, the only outbound link
 *     is the "Bet on this" CTA the embedder wants.
 *   • Theme-aware via `prefers-color-scheme`, so the widget looks native in a light or dark host.
 *   • Everything HTML-escaped — a market title is user-influenced (S23 lets humans create markets),
 *     so it is untrusted text and must never reach the document unescaped.
 */

import type { Market } from "./types";
import { computeOdds, formatProbability } from "./parimutuel-odds";
import { motesToCspr } from "./types";

export interface EmbedLinks {
  /** The market's public page — the "Bet on this" target, carrying attribution. */
  marketUrl: string;
  /** The site brand link shown in the footer. */
  siteUrl: string;
}

const BAR_COLORS = ["#6d5efc", "#0bb489", "#e0a213", "#e0556e", "#3b82f6", "#a855f7"];

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCspr(motes: string): string {
  const cspr = motesToCspr(motes);
  if (cspr >= 1000) return `${(cspr / 1000).toFixed(1)}k`;
  return Number(cspr.toFixed(2)).toString();
}

/** Render the full embed document for a market. */
export function renderEmbed(market: Market, links: EmbedLinks): string {
  const odds = computeOdds(market);
  const title = escapeHtml(market.title);
  const statusLabel = market.status === "open" ? "" : ` · ${escapeHtml(market.status)}`;
  const pool = formatCspr(market.totalStakedMotes);
  const betHref = `${links.marketUrl}?utm_source=embed&utm_medium=widget`;

  const rows = odds
    .map((o, i) => {
      const outcome = market.outcomes.find((x) => x.key === o.outcomeKey);
      const label = escapeHtml(outcome ? outcome.label : o.outcomeKey);
      const pct = Math.round(o.impliedProbability * 100);
      const mult = o.payoutMultiple > 0 ? `${o.payoutMultiple.toFixed(2)}×` : "—";
      const color = BAR_COLORS[i % BAR_COLORS.length];
      return `
        <div class="row">
          <div class="row-head">
            <span class="label">${label}</span>
            <span class="num">${formatProbability(o.impliedProbability)} · ${mult}</span>
          </div>
          <div class="track"><div class="fill" style="width:${pct}%;background:${color}"></div></div>
        </div>`;
    })
    .join("");

  // A single self-contained document. `frame-ancestors *` is intentional — the point of an embed is
  // that anyone can frame it; it carries no secrets and no auth, so framing it is harmless.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Hunch on Casper</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #ffffff; color: #16161d; padding: 16px;
  }
  .card { max-width: 480px; margin: 0 auto; border: 1px solid #e6e6ef; border-radius: 14px; padding: 16px; }
  .cat { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #6d5efc; font-weight: 600; }
  h1 { font-size: 16px; line-height: 1.3; margin: 6px 0 12px; font-weight: 650; }
  .row { margin: 10px 0; }
  .row-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
  .label { font-weight: 550; }
  .num { font-variant-numeric: tabular-nums; color: #6b6b7b; font-size: 13px; }
  .track { height: 8px; border-radius: 999px; background: #eeeef4; overflow: hidden; }
  .fill { height: 100%; border-radius: 999px; }
  .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; padding-top: 12px; border-top: 1px solid #eeeef4; }
  .pool { font-size: 12px; color: #6b6b7b; }
  a.bet { display: inline-block; background: #6d5efc; color: #fff; text-decoration: none; font-weight: 600; font-size: 13px; padding: 7px 14px; border-radius: 9px; }
  a.brand { color: #6b6b7b; text-decoration: none; font-size: 11px; }
  @media (prefers-color-scheme: dark) {
    body { background: #0e0e13; color: #ececf3; }
    .card { border-color: #26262f; }
    .track { background: #22222b; }
    .num, .pool { color: #9a9aa8; }
    .foot { border-top-color: #22222b; }
    a.brand { color: #9a9aa8; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="cat">Hunch on Casper${statusLabel}</div>
    <h1>${title}</h1>
    ${rows}
    <div class="foot">
      <span class="pool">${pool} CSPR pool</span>
      <a class="bet" href="${escapeHtml(betHref)}" target="_blank" rel="noopener">Bet on this →</a>
    </div>
    <div style="text-align:center;margin-top:10px">
      <a class="brand" href="${escapeHtml(links.siteUrl)}" target="_blank" rel="noopener">powered by casper.playhunch.xyz</a>
    </div>
  </div>
</body>
</html>`;
}

/** The tiny "market not found" document, so a stale embed degrades to a link rather than a blank. */
export function renderEmbedNotFound(slug: string, siteUrl: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Market not found · Hunch on Casper</title>
<style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0e0e13;color:#ececf3;margin:0;padding:24px;text-align:center}a{color:#6d5efc}</style>
</head><body>
<p>No open market <code>${escapeHtml(slug)}</code>.</p>
<p><a href="${escapeHtml(siteUrl)}/markets" target="_blank" rel="noopener">See what's open →</a></p>
</body></html>`;
}
