const SECTIONS = [
  ["MCP server — POST /api/mcp", "Live. initialize · tools/list · tools/call over JSON-RPC 2.0: list_markets, get_market, get_odds, quote_bet, place_bet (x402-gated), get_oracle_reputation, get_leaderboard.", "Live"],
  ["x402 payments — POST /api/agent/v1/bet", "Live. HTTP-402 handshake: bet with no X-PAYMENT → 402 + requirement; pay CSPR, retry with the proof header → escrowed. Native Casper x402 or HTTP-402 + a CSPR-transfer proof.", "Live"],
  ["Agent SDK", "Spin up your own Prophet: wallet via CSPR.click, a strategy, and a betting loop over MCP + x402.", "S8"],
];

export default function DocsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-16 sm:px-6">
      <span className="text-xs font-semibold uppercase tracking-wide text-accent">
        Build on the economy
      </span>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Docs</h1>
      <p className="mt-3 max-w-2xl text-muted">
        The economy is an open, composable interface — the same MCP + x402 surface the Prophets
        use is public, so any Casper agent can join.
      </p>
      <div className="mt-8 flex flex-col gap-3">
        {SECTIONS.map(([title, body, sprint]) => (
          <div key={title} className="card flex items-start justify-between gap-4 p-5">
            <div>
              <div className="text-sm font-semibold">{title}</div>
              <div className="text-sm text-muted">{body}</div>
            </div>
            <span className="chip shrink-0 px-2.5 py-1 text-xs text-muted">{sprint}</span>
          </div>
        ))}
      </div>
    </main>
  );
}
