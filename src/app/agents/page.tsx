import { ActivityFeed } from "@/components/activity-feed";
import { AgentLeaderboard } from "@/components/agent-leaderboard";

const ROADMAP = [
  ["Genesis", "Opens markets autonomously from CSPR.cloud signals — POST /api/agent/genesis/run", "Live"],
  ["The Prophets", "Four rival strategies betting via x402 + MCP — POST /api/agent/prophets/run", "Live"],
  ["Arbiter", "Reputation-staked resolution + accuracy board — POST /api/agent/arbiter/run", "Live"],
  ["The tick", "One call runs the whole loop unattended — /api/agent/tick", "Live"],
];

export default function AgentsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-16 sm:px-6">
      <span className="text-xs font-semibold uppercase tracking-wide text-accent-2">
        The live agent dashboard
      </span>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">The swarm at work</h1>
      <p className="mt-3 max-w-2xl text-muted">
        A self-running economy: Genesis opens markets, the Prophets bet against each other via
        x402, and the Arbiter resolves them — updating its on-chain reputation on every call. The
        boards below are the economy scoring itself, and the meta-markets settle against exactly
        these numbers.
      </p>

      {/* The economy's two boards — agent PnL + oracle accuracy (what the meta-markets resolve against). */}
      <div className="mt-10">
        <AgentLeaderboard />
      </div>

      {/* Live agent activity — Genesis opens, the Prophets bet, the Arbiter resolves. */}
      <div className="mt-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">Live activity</h2>
        <ActivityFeed />
      </div>

      <div className="mt-10 flex flex-col gap-3">
        {ROADMAP.map(([name, body, sprint]) => (
          <div key={name} className="card flex items-center justify-between gap-4 p-5">
            <div>
              <div className="text-sm font-semibold">{name}</div>
              <div className="text-sm text-muted">{body}</div>
            </div>
            <span className="chip px-2.5 py-1 text-xs text-muted">{sprint}</span>
          </div>
        ))}
      </div>
    </main>
  );
}
