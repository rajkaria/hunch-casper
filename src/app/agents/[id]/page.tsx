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

/** The demo identity follows are keyed under until per-user custody exists. */
const DEMO_FOLLOWER = "demo-follower";

export default function AgentProfilePage() {
  const { network } = useNetwork();
  const params = useParams<{ id: string }>();
  const agent = decodeURIComponent(params.id);
  const [rep, setRep] = useState<Reputation | null>(null);
  const [state, setState] = useState<"loading" | "none" | "error" | "ready">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/agents/${encodeURIComponent(agent)}/reputation?network=${network}`)
      .then(async (r) => {
        if (r.ok) return { kind: "ok" as const, body: (await r.json()) as Reputation };
        // Only a 404 means "no history"; anything else is a failure and must say so.
        if (r.status === 404) return { kind: "none" as const };
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        return { kind: "error" as const, message: body.error ?? `failed to load track record (HTTP ${r.status})` };
      })
      .then((res) => {
        if (!live) return;
        if (res.kind === "ok") {
          setRep(res.body);
          setState("ready");
        } else if (res.kind === "none") {
          setState("none");
        } else {
          setLoadError(res.message);
          setState("error");
        }
      })
      .catch((err: unknown) => {
        if (!live) return;
        setLoadError(err instanceof Error ? err.message : "failed to load track record");
        setState("error");
      });
    return () => {
      live = false;
    };
  }, [agent, network]);

  // Hydrate the follow state so a revisit shows "Following" instead of always resetting the button.
  useEffect(() => {
    let live = true;
    fetch(`/api/follow?follower=${encodeURIComponent(DEMO_FOLLOWER)}&agentId=${encodeURIComponent(agent)}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ following: boolean; config?: { active: boolean } }>) : null))
      .then((j) => {
        if (live && j) setFollowing(j.following && j.config?.active !== false);
      })
      .catch(() => {
        /* leave the default (not following) — the toggle still works */
      });
    return () => {
      live = false;
    };
  }, [agent]);

  async function toggleFollow() {
    setBusy(true);
    try {
      const res = await fetch("/api/follow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ follower: DEMO_FOLLOWER, agentId: agent, active: !following }),
      });
      // Only flip the button when the server actually recorded the change.
      if (res.ok) setFollowing((f) => !f);
    } catch {
      /* network failure — keep the current state rather than lying about it */
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
          className={`btn ${following ? "btn-ghost" : "btn-primary"} px-4 py-2 disabled:opacity-50`}
          disabled={busy || state !== "ready"}
          onClick={toggleFollow}
        >
          {following ? "Following — unwind" : "Copy this agent"}
        </button>
      </div>

      {state === "loading" && <p className="mt-8 text-muted">Loading track record…</p>}
      {state === "none" && <p className="mt-8 text-muted">No on-chain betting history for this agent yet.</p>}
      {state === "error" && (
        <p className="mt-8 text-sm text-down">Couldn&apos;t load the track record: {loadError}</p>
      )}

      {state === "ready" && rep && (
        <>
          {/* Calibration first — the headline signal. */}
          <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Brier"
              value={rep.calibration.sampleCount === 0 ? "—" : rep.calibration.brier.toFixed(3)}
              hint="lower is better · 0.25 = coin flip"
            />
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
            <span className="font-semibold text-gold">Demo preview</span> — this button records your
            follow config, but mirroring goes live with per-agent custody. When it does, copying
            mirrors this agent&apos;s <em>future</em> positions, sized to your budget and capped per
            bet. Meta-markets are never mirrored.
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
