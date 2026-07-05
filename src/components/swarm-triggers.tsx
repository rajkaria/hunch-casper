"use client";

/**
 * Swarm triggers — the clickable demo. The economy runs on a cron, but a judge shouldn't have to
 * wait for one to fire: these buttons POST the agent endpoints directly (Genesis opens a market,
 * the Prophet fleet bets, the Arbiter resolves, or "Run the whole loop" ticks all three), then
 * broadcast a `swarm:refresh` event so the activity feed + boards above re-poll immediately and the
 * judge watches the economy move within a single click. In real chain mode the endpoints are
 * cron-secret-gated (401) — we surface that as a clean "cron-gated" state rather than an error.
 */

import { useState } from "react";

export const SWARM_REFRESH_EVENT = "swarm:refresh";

interface Trigger {
  key: string;
  label: string;
  desc: string;
  path: string;
  primary?: boolean;
}

const TRIGGERS: readonly Trigger[] = [
  { key: "tick", label: "Run the whole loop", desc: "Prophets bet → Arbiter resolves → boards update — one unattended tick.", path: "/api/agent/tick", primary: true },
  { key: "genesis", label: "Open a market", desc: "Genesis reads a CSPR.cloud signal and lists a fresh market.", path: "/api/agent/genesis/run" },
  { key: "prophets", label: "Send the Prophets", desc: "The four-strategy fleet stakes CSPR at one market via x402.", path: "/api/agent/prophets/run" },
  { key: "arbiter", label: "Resolve matured", desc: "The Arbiter sweeps past-deadline markets, reputation staked.", path: "/api/agent/arbiter/run" },
];

type State = "idle" | "running" | "done" | "gated" | "error";

const STATUS_COPY: Record<Exclude<State, "idle">, string> = {
  running: "running…",
  done: "done ✓",
  gated: "cron-gated",
  error: "retry",
};

export function SwarmTriggers() {
  const [state, setState] = useState<Record<string, State>>({});

  async function fire(t: Trigger) {
    if (state[t.key] === "running") return;
    setState((s) => ({ ...s, [t.key]: "running" }));
    try {
      const res = await fetch(t.path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (res.status === 401) {
        setState((s) => ({ ...s, [t.key]: "gated" }));
        return;
      }
      setState((s) => ({ ...s, [t.key]: res.ok ? "done" : "error" }));
      if (res.ok && typeof window !== "undefined") {
        // Let the feed + boards re-poll right away, then once more after the state settles.
        window.dispatchEvent(new Event(SWARM_REFRESH_EVENT));
        setTimeout(() => window.dispatchEvent(new Event(SWARM_REFRESH_EVENT)), 400);
      }
    } catch {
      setState((s) => ({ ...s, [t.key]: "error" }));
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {TRIGGERS.map((t) => {
        const st = state[t.key] ?? "idle";
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => fire(t)}
            disabled={st === "running"}
            aria-busy={st === "running"}
            className={`card flex items-center justify-between gap-4 p-5 text-left transition-colors hover:border-accent focus-visible:border-accent disabled:opacity-70 ${
              t.primary ? "ring-1 ring-accent/40" : ""
            }`}
          >
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                {t.primary && <span className="live-dot" aria-hidden="true" />}
                {t.label}
              </div>
              <div className="mt-0.5 text-sm text-muted">{t.desc}</div>
            </div>
            <span
              className={`chip shrink-0 px-2.5 py-1 text-[11px] ${
                st === "done" ? "text-up" : st === "gated" || st === "error" ? "text-down" : "text-muted"
              }`}
            >
              {st === "idle" ? "run →" : STATUS_COPY[st]}
            </span>
          </button>
        );
      })}
    </div>
  );
}
