"use client";

import { useEffect, useState } from "react";

interface Reputation {
  oracleId: string;
  name: string;
  accuracy: number;
  accuracyBps: number;
  resolvedCount: number;
  accurateCount: number;
}

/**
 * The oracle-reputation card — the RWA-oracle thesis, on screen. Shows the resolving oracle's
 * on-chain accuracy so a bettor can see whose judgement (with economic teeth) settles this market.
 * Reads `GET /api/oracle/[id]`; `variant="inline"` is a compact one-liner for a market sidebar,
 * `variant="card"` is a standalone panel for the agents dashboard.
 */
export function OracleReputation({
  oracleId = "arbiter",
  variant = "inline",
}: {
  oracleId?: string;
  variant?: "inline" | "card";
}) {
  const [rep, setRep] = useState<Reputation | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/oracle/${oracleId}`, { signal: ctrl.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ reputation: Reputation }>) : null))
      .then((json) => json && setRep(json.reputation))
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) setRep(null);
      });
    return () => ctrl.abort();
  }, [oracleId]);

  if (!rep) return null;
  const pct = (rep.accuracyBps / 100).toFixed(1);

  if (variant === "card") {
    return (
      <div className="card p-5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-up">{rep.name}</div>
            <div className="text-xs uppercase tracking-wide text-muted">Reputation-staked oracle</div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold">{pct}%</div>
            <div className="text-[11px] text-muted">{rep.resolvedCount} resolutions</div>
          </div>
        </div>
        <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-surface-2">
          <div className="h-full rounded-full bg-up/70" style={{ width: `${Math.min(100, rep.accuracyBps / 100)}%` }} />
        </div>
        <p className="mt-3 text-xs text-muted">
          Every resolution is scored on-chain. A wrong call costs bettors money — so this accuracy
          has economic teeth.
        </p>
      </div>
    );
  }

  return (
    <div className="card flex items-center justify-between p-4">
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-muted">Resolved by</span>
        <span className="text-sm font-semibold text-up">{rep.name}</span>
      </div>
      <div className="text-right">
        <div className="text-sm font-semibold">{pct}% accuracy</div>
        <div className="text-[11px] text-muted">{rep.resolvedCount} resolutions on-chain</div>
      </div>
    </div>
  );
}
