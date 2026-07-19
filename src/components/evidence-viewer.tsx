"use client";

import { useEffect, useState } from "react";

/**
 * Evidence viewer — renders the replayable resolution evidence for a settled market and shows
 * whether it independently verifies. Fetches `/api/markets/[slug]/evidence`; renders nothing until
 * a market has published evidence (so it is safe to drop onto every market page). The green/red
 * "verified" pill is the point: it reflects a live replay of the recipe against the snapshot, not a
 * claim — "audit this resolution" made a glance.
 */

interface EvidenceResponse {
  link: { recipeHash: string; bundleHash: string; uri: string; resolvedAtIso: string };
  bundle: {
    winningOutcomeKey: string | null;
    sources: { source: string; metric: string; reference: string }[];
    snapshot: Record<string, string>;
    reasoning: string;
  };
  verification: { ok: boolean; recipeHashMatches: boolean; bundleHashMatches: boolean; outcomeMatches: boolean } | null;
}

export function EvidenceViewer({ slug, network }: { slug: string; network: string }) {
  const [data, setData] = useState<EvidenceResponse | null>(null);
  const [state, setState] = useState<"loading" | "none" | "ready">("loading");

  useEffect(() => {
    let live = true;
    fetch(`/api/markets/${slug}/evidence?network=${network}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (!live) return;
        if (!json) {
          setState("none");
        } else {
          setData(json);
          setState("ready");
        }
      })
      .catch(() => live && setState("none"));
    return () => {
      live = false;
    };
  }, [slug, network]);

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
