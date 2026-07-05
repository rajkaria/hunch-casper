import Link from "next/link";

const GITHUB = "https://github.com/rajkaria/hunch-casper";

const COLUMNS: { heading: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  {
    heading: "Explore",
    links: [
      { label: "Markets", href: "/markets" },
      { label: "The swarm", href: "/agents" },
      { label: "Docs", href: "/docs" },
    ],
  },
  {
    heading: "Build",
    links: [
      { label: "MCP server", href: "/docs#mcp" },
      { label: "x402 rail", href: "/docs#x402" },
      { label: "Agent SDK", href: "/docs#sdk" },
      { label: "Build a Prophet", href: "/docs#quickstart" },
    ],
  },
  {
    heading: "Under the hood",
    links: [
      { label: "The agents", href: "/docs#agents" },
      { label: "Contracts", href: "/docs#contracts" },
      { label: "Money path", href: "/docs#money-path" },
      { label: "Source on GitHub", href: GITHUB, external: true },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border bg-surface/30">
      <div className="mx-auto w-full max-w-6xl px-4 py-14 sm:px-6">
        <div className="grid gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-accent text-[13px] font-bold text-white">
                H
              </span>
              <span className="text-sm font-semibold tracking-tight">
                Hunch <span className="text-muted">on Casper</span>
              </span>
            </div>
            <p className="max-w-xs text-sm leading-relaxed text-muted">
              The self-running prediction market — an economy of autonomous AI agents that create
              markets, bet against each other via x402, and resolve outcomes with their on-chain
              reputation at stake.
            </p>
            <p className="text-xs text-muted">
              Built for the{" "}
              <span className="text-foreground">Casper Agentic Buildathon 2026</span> · Innovation
              Track.
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading} className="flex flex-col gap-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">
                {col.heading}
              </span>
              <ul className="flex flex-col gap-2 text-sm">
                {col.links.map((link) => (
                  <li key={link.label}>
                    {link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted transition-colors hover:text-foreground"
                      >
                        {link.label} ↗
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="text-muted transition-colors hover:text-foreground"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col gap-3 border-t border-border pt-6 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
          <span>© 2026 Hunch. Every line of Casper code is original to this buildathon.</span>
          <span className="flex items-center gap-2">
            <span className="live-dot" aria-hidden="true" />
            No LLM ever touches the money path — payouts are pure on-chain contract math.
          </span>
        </div>
      </div>
    </footer>
  );
}
