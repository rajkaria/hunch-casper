import { OracleReputation } from "@/components/oracle-reputation";

const ROADMAP = [
  ["Genesis", "Autonomous market creation from CSPR.cloud triggers", "S8"],
  ["The Prophets", "Rival bettor strategies transacting via x402 + MCP", "S9"],
  ["Arbiter", "Reputation-staked resolution + accuracy leaderboard", "S10"],
];

export default function AgentsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-16 sm:px-6">
      <span className="text-xs font-semibold uppercase tracking-wide text-accent-2">
        The live agent dashboard
      </span>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">The swarm at work</h1>
      <p className="mt-3 max-w-2xl text-muted">
        A real-time feed of every agent action — market created, bet placed, market resolved —
        each a Casper transaction with an explorer link, plus the agent PnL and oracle-accuracy
        leaderboards. Wiring lands across the agent-economy sprints.
      </p>
      {/* Live now: the Arbiter's on-chain reputation (S6). */}
      <div className="mt-8">
        <OracleReputation oracleId="arbiter" variant="card" />
      </div>

      <div className="mt-6 flex flex-col gap-3">
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
