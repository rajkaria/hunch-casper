"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useNetwork } from "@/components/network-context";

/**
 * Agent profile — the shareable, calibration-first marketing surface for copy-betting (S29). Leads
 * with the Brier/skill score (is this agent's probability worth reading?), not PnL (which a
 * favourite-backer inflates), then offers a one-click follow that mirrors the agent's future
 * positions.
 */

interface Reputation {
  agent: string;
  calibration: { brier: number; skillBps: number; sampleCount: number; hitRate: number };
  performance: { roiBps: number; winRate: number; betCount: number; settledCount: number; volumeMotes: string };
  caveats: string[];
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export default function AgentProfilePage() {
  const { network } = useNetwork();
  const params = useParams<{ id: string }>();
  const agent = decodeURIComponent(params.id);
  const [rep, setRep] = useState<Reputation | null>(null);
  const [state, setState] = useState<"loading" | "none" | "ready">("loading");
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/agents/${encodeURIComponent(agent)}/reputation?network=${network}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!live) return;
        if (!j) setState("none");
        else {
          setRep(j);
          setState("ready");
        }
      })
      .catch(() => live && setState("none"));
    return () => {
      live = false;
    };
  }, [agent, network]);

  async function toggleFollow() {
    setBusy(true);
    try {
      await fetch("/api/follow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ follower: "demo-follower", agentId: agent, active: !following }),
      });
      setFollowing((f) => !f);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <nav className="mb-6 flex items-center gap-2 text-xs text-muted">
        <Link href="/agents" className="hover:text-foreground">
          Agents
        </Link>
        <span>/</span>
        <span className="truncate font-mono text-foreground">{agent}</span>
      </nav>

      <div className="flex items-center justify-between">
        <h1 className="font-mono text-2xl font-semibold tracking-tight">{agent}</h1>
        <button
          className={`rounded-lg px-4 py-2 text-sm font-semibold ${following ? "bg-surface-2 text-foreground" : "bg-accent text-white"} disabled:opacity-50`}
          disabled={busy || state !== "ready"}
          onClick={toggleFollow}
        >
          {following ? "Following — unwind" : "Copy this agent"}
        </button>
      </div>

      {state === "loading" && <p className="mt-8 text-muted">Loading track record…</p>}
      {state === "none" && <p className="mt-8 text-muted">No on-chain betting history for this agent yet.</p>}

      {state === "ready" && rep && (
        <>
          {/* Calibration first — the headline signal. */}
          <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Brier" value={rep.calibration.brier.toFixed(3)} hint="lower is better · 0.25 = coin flip" />
            <Stat label="Skill" value={`${(rep.calibration.skillBps / 100).toFixed(1)}%`} hint="above a coin flip" />
            <Stat label="Hit rate" value={pct(rep.calibration.hitRate)} />
            <Stat label="Forecasts" value={String(rep.calibration.sampleCount)} hint="evidence behind the score" />
          </section>

          <section className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="ROI" value={`${(rep.performance.roiBps / 100).toFixed(1)}%`} />
            <Stat label="Win rate" value={pct(rep.performance.winRate)} />
            <Stat label="Settled" value={String(rep.performance.settledCount)} />
            <Stat label="Bets" value={String(rep.performance.betCount)} />
          </section>

          {rep.caveats.length > 0 && (
            <ul className="mt-6 flex flex-col gap-1">
              {rep.caveats.map((c, i) => (
                <li key={i} className="text-xs text-gold">
                  ⚠ {c}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-8 text-sm text-muted">
            Copying mirrors this agent&apos;s <em>future</em> positions, sized to your budget and capped per bet.
            Meta-markets are never mirrored. The agent earns a fee share on the volume it drives.
          </p>
        </>
      )}
    </main>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted">{hint}</div>}
    </div>
  );
}
