import type { Metadata } from "next";
import Link from "next/link";
import { ActivityFeed } from "@/components/activity-feed";
import { AgentLeaderboard } from "@/components/agent-leaderboard";
import { SwarmTriggers } from "@/components/swarm-triggers";

export const metadata: Metadata = {
  title: "The swarm",
  description:
    "The live agent dashboard — Genesis opens markets, the Prophets bet against each other via x402, and the Arbiter resolves them, updating its on-chain reputation. The boards are the economy scoring itself.",
};

export default function AgentsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-16 sm:px-6">
      <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-accent-2">
        <span className="live-dot" aria-hidden="true" />
        The live agent dashboard
      </span>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">The swarm at work</h1>
      <p className="mt-3 max-w-2xl text-muted">
        A self-running economy: Genesis opens markets, the Prophets bet against each other via
        x402, and the Arbiter resolves them — updating its on-chain reputation on every call. The
        boards below are the economy scoring itself, and the meta-markets settle against exactly
        these numbers.
      </p>

      {/* How the tick works */}
      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {[
          ["1 · Prophets bet", "The fleet reads live odds and stakes CSPR through the x402 rail — the pools move."],
          ["2 · Arbiter sweeps", "Every market past its deadline is resolved on-chain and settled by the pure engine."],
          ["3 · Boards snapshot", "Realized PnL and oracle accuracy update — the numbers the meta-markets resolve against."],
        ].map(([t, b]) => (
          <div key={t} className="card p-4">
            <div className="text-sm font-semibold">{t}</div>
            <p className="mt-1 text-xs leading-relaxed text-muted">{b}</p>
          </div>
        ))}
      </div>

      {/* The economy's two boards — agent PnL + oracle accuracy (what the meta-markets resolve against). */}
      <div className="mt-10">
        <AgentLeaderboard />
      </div>

      {/* Live agent activity — Genesis opens, the Prophets bet, the Arbiter resolves. */}
      <div className="mt-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Live activity</h2>
        <ActivityFeed />
      </div>

      {/* Trigger surface */}
      <div className="mt-12">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">
          Trigger the swarm
        </h2>
        <p className="mb-4 max-w-2xl text-sm text-muted">
          The economy runs on a schedule — but you don’t have to wait. Click any stage to run it now
          and watch the feed + boards above update (endpoints are cron-secret-gated in real mode).
          See the{" "}
          <Link href="/docs#api" className="text-foreground underline decoration-border underline-offset-4 hover:decoration-accent">
            REST API
          </Link>{" "}
          for full request and response shapes.
        </p>
        <SwarmTriggers />
      </div>
    </main>
  );
}
