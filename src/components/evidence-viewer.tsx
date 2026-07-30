"use client";

import { useEffect, useState } from "react";
import type { MarketStatus } from "@/core/types";

/**
 * Evidence viewer — renders the replayable resolution evidence for a settled market and shows
 * whether it independently verifies. Fetches `/api/markets/[slug]/evidence`; renders nothing until
 * a market has published evidence (so it is safe to drop onto every market page). The green/red
 * "verified" pill is the point: it reflects a live replay of the recipe against the snapshot, not a
 * claim — "audit this resolution" made a glance.
 *
 * Settled markets only. Evidence is published at resolution, so before then the probe's answer is
 * a foregone 404 — which the component handled, but the browser still printed as a red network
 * error on every open market's console. A guaranteed error on the happy path teaches people to
 * ignore that console, so the fetch is skipped until the market's status says a bundle could
 * exist. (`void` settles too: the Arbiter publishes a bundle with `winningOutcomeKey: null`.)
 */

export function marketMayHaveEvidence(status: MarketStatus): boolean {
  return status === "resolved" || status === "void";
}

export interface EvidenceResponse {
  link: { recipeHash: string; bundleHash: string; uri: string; resolvedAtIso: string };
  bundle: {
    winningOutcomeKey: string | null;
    sources: { source: string; metric: string; reference: string }[];
    snapshot: Record<string, string>;
    reasoning: string;
  };
  verification: { ok: boolean; recipeHashMatches: boolean; bundleHashMatches: boolean; outcomeMatches: boolean } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Accept a payload only when it is actually an evidence bundle; anything else is "no evidence".
 *
 * This guard is load-bearing, not defensive garnish. A round slug carries a `#`
 * (`cspr-hourly-updown#20658`), and interpolated raw into the fetch URL the browser truncated it
 * at the fragment — the request went to `/api/markets/cspr-hourly-updown`, a DIFFERENT endpoint
 * that happily answered `200 {market}`. The old code then dereferenced `data.link.recipeHash` on
 * a shape with no `link`, and that TypeError crash-looped the entire round page. The fetch now
 * encodes the slug, and this parse makes the render's assumptions checked rather than assumed:
 * an unexpected shape settles to the no-evidence state instead of taking the page down.
 */
export function parseEvidenceResponse(json: unknown): EvidenceResponse | null {
  if (!isRecord(json)) return null;
  const link = json.link;
  const bundle = json.bundle;
  if (!isRecord(link) || typeof link.recipeHash !== "string" || typeof link.bundleHash !== "string") {
    return null;
  }
  if (!isRecord(bundle)) return null;
  const verification = json.verification;
  return {
    link: {
      recipeHash: link.recipeHash,
      bundleHash: link.bundleHash,
      uri: typeof link.uri === "string" ? link.uri : "",
      resolvedAtIso: typeof link.resolvedAtIso === "string" ? link.resolvedAtIso : "",
    },
    bundle: {
      winningOutcomeKey:
        typeof bundle.winningOutcomeKey === "string" ? bundle.winningOutcomeKey : null,
      sources: Array.isArray(bundle.sources)
        ? bundle.sources.filter(
            (s): s is EvidenceResponse["bundle"]["sources"][number] =>
              isRecord(s) && typeof s.source === "string" && typeof s.metric === "string",
          )
        : [],
      snapshot: isRecord(bundle.snapshot)
        ? Object.fromEntries(
            Object.entries(bundle.snapshot).filter((e): e is [string, string] => typeof e[1] === "string"),
          )
        : {},
      reasoning: typeof bundle.reasoning === "string" ? bundle.reasoning : "",
    },
    verification:
      isRecord(verification) && typeof verification.ok === "boolean"
        ? {
            ok: verification.ok,
            recipeHashMatches: verification.recipeHashMatches === true,
            bundleHashMatches: verification.bundleHashMatches === true,
            outcomeMatches: verification.outcomeMatches === true,
          }
        : null,
  };
}

export function EvidenceViewer({
  slug,
  network,
  status,
}: {
  slug: string;
  network: string;
  status: MarketStatus;
}) {
  const settled = marketMayHaveEvidence(status);
  const [data, setData] = useState<EvidenceResponse | null>(null);
  // An unsettled market starts (and stays) at "none": no probe, no state transition, no render.
  const [state, setState] = useState<"loading" | "none" | "ready">(settled ? "loading" : "none");

  useEffect(() => {
    if (!settled) return;
    let live = true;
    // The slug MUST be encoded: a round slug's `#` would otherwise truncate the URL at the
    // fragment and send this probe to the market endpoint instead (see parseEvidenceResponse).
    fetch(`/api/markets/${encodeURIComponent(slug)}/evidence?network=${encodeURIComponent(network)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: unknown) => {
        if (!live) return;
        const parsed = parseEvidenceResponse(json);
        if (!parsed) {
          setState("none");
        } else {
          setData(parsed);
          setState("ready");
        }
      })
      .catch(() => live && setState("none"));
    return () => {
      live = false;
    };
  }, [slug, network, settled]);

  if (state !== "ready" || !data) return null;
  const v = data.verification;

  return (
    <section className="card mt-6 p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Resolution evidence</h3>
        {v && (
          <span
            className={`chip px-2 py-0.5 text-[11px] font-semibold ${v.ok ? "text-up" : "text-down"}`}
            title="Recipe hash + bundle hash + replayed outcome all checked"
          >
            {v.ok ? "✓ replay-verified" : "⚠ verification failed"}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">
        Anyone can fetch this bundle, recompute its hash, and replay the recipe to confirm the winner.
      </p>

      <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted">Recipe hash</dt>
          <dd className="mt-0.5 break-all font-mono text-foreground">{data.link.recipeHash}</dd>
        </div>
        <div>
          <dt className="text-muted">Evidence bundle hash</dt>
          <dd className="mt-0.5 break-all font-mono text-foreground">{data.link.bundleHash}</dd>
        </div>
      </dl>

      <div className="mt-4">
        <div className="text-[11px] uppercase tracking-wide text-muted">Snapshot</div>
        <div className="mt-1 flex flex-wrap gap-2">
          {Object.entries(data.bundle.snapshot).map(([k, val]) => (
            <span key={k} className="chip px-2 py-0.5 font-mono text-xs">
              {k} = {val}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-4">
        <div className="text-[11px] uppercase tracking-wide text-muted">Sources</div>
        <ul className="mt-1 flex flex-col gap-1 text-xs">
          {data.bundle.sources.map((s, i) => (
            <li key={i} className="text-foreground">
              <span className="font-mono">{s.source}</span> · {s.metric}
              {s.reference ? <span className="text-muted"> — {s.reference}</span> : null}
            </li>
          ))}
        </ul>
      </div>

      {data.bundle.reasoning && (
        <p className="mt-4 border-l-2 border-surface-2 pl-3 text-xs text-muted">{data.bundle.reasoning}</p>
      )}
    </section>
  );
}
