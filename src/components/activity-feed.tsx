"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motesToCspr } from "@/core/types";
import { SWARM_REFRESH_EVENT } from "@/components/swarm-triggers";

interface AgentAction {
  seq: number;
  agent: string;
  kind: "market_created" | "bet_placed" | "market_resolved";
  marketId: string;
  marketTitle?: string;
  outcomeKey?: string;
  amountMotes?: string;
  narration?: string;
  explorerUrl?: string;
  ts?: number;
}

/** Compact relative time — "now" / "12s ago" / "4m ago" / "2h ago". */
function relativeTime(ts: number | undefined, nowMs: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

const AGENT_ACCENT: Record<string, string> = {
  Genesis: "text-accent",
  Momentum: "text-up",
  Contrarian: "text-down",
  Value: "text-gold",
  Chaos: "text-accent-2",
  Arbiter: "text-up",
};

const VERB: Record<AgentAction["kind"], string> = {
  market_created: "opened",
  bet_placed: "bet on",
  market_resolved: "resolved",
};

function slugOf(marketId: string): string {
  const i = marketId.indexOf(":");
  return i >= 0 ? marketId.slice(i + 1) : marketId;
}

/** The live agent-action feed — polls `/api/agent/activity` so the swarm's moves stream in. */
export function ActivityFeed() {
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    const load = () =>
      fetch("/api/agent/activity")
        .then((r) => (r.ok ? (r.json() as Promise<{ actions: AgentAction[] }>) : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((j) => {
          if (!active) return;
          setActions(j.actions);
          setNow(Date.now());
          setStatus("ready");
        })
        .catch(() => {
          if (active) setStatus((s) => (s === "loading" ? "error" : s));
        });
    load();
    const timer = setInterval(load, 5000);
    const onRefresh = () => load();
    window.addEventListener(SWARM_REFRESH_EVENT, onRefresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener(SWARM_REFRESH_EVENT, onRefresh);
    };
  }, []);

  if (status === "loading") {
    return (
      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-2 bg-surface/40 p-4">
            <div className="h-4 w-2/3 animate-pulse rounded bg-surface-2" />
            <div className="h-3 w-1/2 animate-pulse rounded bg-surface-2/60" />
          </div>
        ))}
      </div>
    );
  }

  if (status === "error" && actions.length === 0) {
    return (
      <p className="text-sm text-down">
        Couldn’t load the activity feed. Retrying every few seconds…
      </p>
    );
  }

  if (actions.length === 0) {
    return (
      <p className="text-sm text-muted">
        No agent activity yet — the economy runs on a schedule (Genesis opens markets, the Prophets
        bet, the Arbiter resolves).
      </p>
    );
  }

  return (
    <div
      className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border"
      role="log"
      aria-live="polite"
      aria-label="Live agent activity"
    >
      {actions.map((a) => (
        <div key={a.seq} className="flex flex-col gap-1 bg-surface/40 p-4">
          <div className="flex items-center gap-2 text-sm">
            <span className={`font-semibold ${AGENT_ACCENT[a.agent] ?? "text-foreground"}`}>{a.agent}</span>
            <span className="text-muted">{VERB[a.kind]}</span>
            <Link href={`/markets/${slugOf(a.marketId)}`} className="truncate text-foreground hover:text-accent">
              {a.marketTitle ?? a.marketId}
            </Link>
            {a.kind === "bet_placed" && a.outcomeKey && (
              <span className="chip px-2 py-0.5 text-[11px] text-muted">
                {a.outcomeKey}
                {a.amountMotes ? ` · ${motesToCspr(a.amountMotes)} CSPR` : ""}
              </span>
            )}
            {a.ts != null && (
              <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted" title={new Date(a.ts).toLocaleString()}>
                {relativeTime(a.ts, now)}
              </span>
            )}
          </div>
          {a.narration && <p className="text-xs italic text-muted">“{a.narration}”</p>}
          {a.explorerUrl && (
            <a
              href={a.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate font-mono text-[10px] text-muted underline decoration-border underline-offset-2 hover:text-accent"
            >
              {a.explorerUrl}
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
