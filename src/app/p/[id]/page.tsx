/**
 * /p/<buidl-id> — one page per buildathon finalist.
 *
 * This is the surface the other 176 teams actually share: a link with their own project's name,
 * live odds and stake in the preview card, and a bet button that lands on the market already
 * aimed at them. A single 177-row board is something people read once; a page each is something
 * they post.
 *
 * Server-rendered per request so a shared link shows the real numbers when it is opened, not the
 * numbers at build time.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createContainer } from "@/lib/container";
import { DEFAULT_NETWORK, isCasperNetwork, type CasperNetwork } from "@/config/network";
import { BUILDATHON_FINALISTS, BUILDATHON_MARKET_SLUG, buidlUrl, findFinalist } from "@/core/buildathon-field";
import { fieldRowFor } from "@/core/field-board";
import { formatProbability } from "@/core/parimutuel-odds";
import { motesToCspr } from "@/core/types";

/** Odds move with every bet. */
export const dynamic = "force-dynamic";

/** The 177 ids are known at build time, so the routes are enumerable (and crawlable). */
export function generateStaticParams(): { id: string }[] {
  return BUILDATHON_FINALISTS.map((f) => ({ id: f.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const finalist = findFinalist(id);
  if (!finalist) return { title: "Unknown project" };
  return {
    title: `Back ${finalist.name} — Casper Agentic Buildathon 2026`,
    description: `${finalist.name} is one of 177 finalists in the Casper Agentic Buildathon. Back it with testnet CSPR on Hunch — parimutuel, no house liquidity.`,
  };
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-2">{label}</div>
      <div className="num mt-1 text-lg font-semibold">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ network?: string }>;
}) {
  const { id } = await params;
  const { network: netParam } = await searchParams;
  const finalist = findFinalist(id);
  if (!finalist) notFound();

  const network: CasperNetwork = isCasperNetwork(netParam) ? netParam : DEFAULT_NETWORK;
  const market = await createContainer(network).store.get(BUILDATHON_MARKET_SLUG, network);
  if (!market) notFound();

  const row = fieldRowFor(market, id);
  const staked = BigInt(market.totalStakedMotes) > 0n;
  const stake = motesToCspr(row?.stakeMotes ?? "0");
  const backed = BigInt(row?.stakeMotes ?? "0") > 0n;

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <nav className="mb-6 flex items-center gap-2 text-xs text-muted">
        <Link href="/buildathon" className="hover:text-foreground">
          Buildathon
        </Link>
        <span>/</span>
        <span className="truncate text-foreground">{finalist.name}</span>
      </nav>

      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
          <span className="font-semibold text-gold">Finalist</span>
          <span className="chip px-2 py-0.5 text-muted">#{finalist.id}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-4xl">{finalist.name}</h1>
        <p className="text-muted">
          One of {market.outcomes.length} finalists in the Casper Agentic Buildathon 2026. Back it
          with testnet CSPR — if it wins, backers split the whole pool pro-rata.
        </p>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Position"
          value={row?.rank === null || row?.rank === undefined ? "—" : `#${row.rank}`}
          hint={staked ? `of ${market.outcomes.length}` : "nothing staked yet"}
        />
        <Stat label="Staked on it" value={backed ? `${stake.toLocaleString()} CSPR` : "—"} />
        <Stat
          label="Implied chance"
          value={staked && row ? formatProbability(row.impliedProbability) : "—"}
          hint={staked ? "pool-implied" : "the first bet sets the line"}
        />
        <Stat
          label="Pays"
          value={row && row.payoutMultiple > 0 ? `${row.payoutMultiple.toFixed(2)}×` : "—"}
          hint="on a winning stake, fee-inclusive"
        />
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href={`/markets/${BUILDATHON_MARKET_SLUG}#${finalist.id}`}
          className="btn btn-primary px-5 py-2"
        >
          Back {finalist.name.length > 24 ? "this project" : finalist.name}
        </Link>
        <a
          href={buidlUrl(finalist.id)}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg border border-border px-5 py-2 text-sm font-semibold text-foreground transition-colors hover:border-accent/60 hover:text-accent"
        >
          View the BUIDL ↗
        </a>
        <Link
          href="/buildathon"
          className="rounded-lg border border-border px-5 py-2 text-sm font-semibold text-muted transition-colors hover:border-accent/40 hover:text-foreground"
        >
          See all {market.outcomes.length}
        </Link>
      </div>

      <div className="card mt-8 p-5">
        <h2 className="text-sm font-semibold">What backing this means</h2>
        <p className="mt-2 text-xs text-muted">
          Your stake is escrowed on chain by the market&apos;s own contract — you sign and fund the
          transaction from your own Casper wallet, and nobody, including us, can move it. If{" "}
          {finalist.name} is named the grand-prize winner, every backer splits the whole pool in
          proportion to their stake, minus a {(market.feeBps / 100).toFixed(0)}% fee taken from the
          losing side only. If the results name co-winners with no single first place, the market
          voids and every stake is refunded in full.
        </p>
        <p className="mt-2 text-xs text-muted">
          There is no seeded liquidity anywhere on this board: every one of the{" "}
          {market.outcomes.length} pools started at zero.
        </p>
      </div>
    </main>
  );
}
