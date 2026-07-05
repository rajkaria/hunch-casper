"use client";

import { useEffect, useState } from "react";
import { motesToCspr } from "@/core/types";
import { PROPHETS } from "@/core/prophet-strategies";

interface AgentPnl {
  agent: string;
  name: string;
  stakedMotes: string;
  returnedMotes: string;
  realizedPnlMotes: string;
  roiBps: number;
  settledCount: number;
  wins: number;
}

interface OracleAccuracy {
  oracleId: string;
  name: string;
  accuracy: number;
  accuracyBps: number;
  resolvedCount: number;
  accurateCount: number;
}

const ACCENT: Record<string, string> = Object.fromEntries(PROPHETS.map((p) => [p.id, p.accent]));

function pnlCspr(motes: string): string {
  const cspr = motesToCspr(motes);
  const sign = cspr > 0 ? "+" : "";
  return `${sign}${cspr.toFixed(2)}`;
}

/**
 * The two boards the economy scores itself with — agent realized PnL and oracle accuracy — the
 * exact numbers the meta-markets resolve against. Polls `GET /api/agent/leaderboard`.
 */
export function AgentLeaderboard() {
  const [agentPnl, setAgentPnl] = useState<AgentPnl[]>([]);
  const [oracle, setOracle] = useState<OracleAccuracy[]>([]);

  useEffect(() => {
    let active = true;
    const load = () =>
      fetch("/api/agent/leaderboard")
        .then((r) => (r.ok ? (r.json() as Promise<{ agentPnl: AgentPnl[]; oracleAccuracy: OracleAccuracy[] }>) : null))
        .then((j) => {
          if (active && j) {
            setAgentPnl(j.agentPnl);
            setOracle(j.oracleAccuracy);
          }
        })
        .catch(() => {});
    load();
    const timer = setInterval(load, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {/* Agent PnL */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Agent PnL</h2>
        {agentPnl.length === 0 ? (
          <p className="text-sm text-muted">
            No settled markets yet — the board fills as the Arbiter resolves the Prophets’ bets.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
            {agentPnl.map((a, i) => {
              const pnl = motesToCspr(a.realizedPnlMotes);
              return (
                <div key={a.agent} className="flex items-center justify-between gap-3 bg-surface/40 p-4">
                  <div className="flex items-center gap-3">
                    <span className="w-5 text-right font-mono text-xs text-muted">{i + 1}</span>
                    <div>
                      <div className={`text-sm font-semibold ${ACCENT[a.agent] ?? "text-foreground"}`}>{a.name}</div>
                      <div className="text-[11px] text-muted">
                        {a.wins}/{a.settledCount} won · {(a.roiBps / 100).toFixed(1)}% ROI
                      </div>
                    </div>
                  </div>
                  <div className={`text-sm font-semibold ${pnl >= 0 ? "text-up" : "text-down"}`}>
                    {pnlCspr(a.realizedPnlMotes)} CSPR
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Oracle accuracy */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Oracle accuracy</h2>
        {oracle.length === 0 ? (
          <p className="text-sm text-muted">No oracles registered yet.</p>
        ) : (
          <div className="flex flex-col divide-y divide-border overflow-hidden rounded-2xl border border-border">
            {oracle.map((o) => (
              <div key={o.oracleId} className="flex items-center justify-between gap-3 bg-surface/40 p-4">
                <div>
                  <div className="text-sm font-semibold text-up">{o.name}</div>
                  <div className="text-[11px] text-muted">{o.resolvedCount} resolutions on-chain</div>
                </div>
                <div className="text-sm font-semibold">{(o.accuracyBps / 100).toFixed(1)}%</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
