/**
 * /buildathon — the hub for the Casper Agentic Buildathon 2026 winner market.
 *
 * A share target, not a duplicate of the market page: one URL a finalist can post to their team
 * chat that answers "what is this, who is winning, and how do I bet" without a wallet, a
 * connection, or a scroll through 177 rows. The betting itself stays on the market page, one
 * click away and pre-aimed via the hash.
 *
 * Server-rendered against the live read model so the standings in a shared link are the real ones
 * at the moment it is opened.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createContainer } from "@/lib/container";
import { DEFAULT_NETWORK, getNetworkConfig, isCasperNetwork, type CasperNetwork } from "@/config/network";
import { BUILDATHON_MARKET_SLUG } from "@/core/buildathon-field";
import { backedCount } from "@/core/field-board";
import { motesToCspr } from "@/core/types";
import { isSimulated } from "@/config/chain-mode";
import { FieldBoard } from "@/components/field-board";

export const metadata: Metadata = {
  title: "Casper Agentic Buildathon 2026 — who wins?",
  description:
    "A parimutuel market over all 177 finalists, on Casper testnet. No house liquidity, no seeded bets: every pool starts at zero and the first bet sets the line.",
};

/** Pools move with every bet; a cached render would show a stale board as a live one. */
export const dynamic = "force-dynamic";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-2">{label}</div>
      <div className="num mt-1 text-lg font-semibold">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

export default async function BuildathonPage({
  searchParams,
}: {
  searchParams: Promise<{ network?: string }>;
}) {
  const { network: netParam } = await searchParams;
  const network: CasperNetwork = isCasperNetwork(netParam) ? netParam : DEFAULT_NETWORK;
  const market = await createContainer(network).store.get(BUILDATHON_MARKET_SLUG, network);
  if (!market) notFound();

  const cfg = getNetworkConfig(network);
  const contract = cfg.contracts.fieldMarket;
  // Real mode with no FieldMarket address is a market that cannot take a bet — the routing
  // refuses rather than misdirecting the stake (`resolveMarketTarget`). Say so at the top of the
  // page instead of letting someone find out at the moment they sign.
  const awaitingDeploy = !contract && !isSimulated();
  const total = motesToCspr(market.totalStakedMotes);
  const backed = backedCount(market);
  const deadline = new Date(market.deadlineIso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
          <span className="font-semibold text-gold">Community</span>
          <span className="chip px-2 py-0.5 text-muted">{market.network}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-4xl">
          Which project wins the Casper Agentic Buildathon 2026?
        </h1>
        <p className="max-w-3xl text-muted">
          All {market.outcomes.length} finalists, one parimutuel pool, real testnet CSPR. Back a
          project — your own, or the one you think takes it — and if it wins, the backers split the
          whole pool pro-rata. Nothing is seeded: every pool starts at zero, so the odds on this
          board are entirely what the ecosystem put there.
        </p>
      </div>

      {awaitingDeploy && (
        <div className="card mt-6 flex flex-wrap items-center gap-3 border-gold/40 p-4" role="status">
          <span className="chip border-gold/50 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-gold">
            not live yet
          </span>
          <p className="text-sm text-foreground">
            The market&apos;s contract is not deployed on {network} yet — the board below is the
            field, not a live book. Betting opens the moment the contract is installed and its
            field is frozen.
          </p>
        </div>
      )}

      <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Total staked" value={`${total.toLocaleString()} CSPR`} hint="testnet" />
        <Stat label="Field" value={`${market.outcomes.length} projects`} hint={`${backed} backed so far`} />
        <Stat label="Betting closes" value={deadline} hint="or the moment results are announced" />
        <Stat label="Fee" value={`${(market.feeBps / 100).toFixed(0)}%`} hint="off the losing pool only" />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <FieldBoard market={market} />

        <div className="flex flex-col gap-4">
          <div className="card p-5">
            <h3 className="text-sm font-semibold">How to bet</h3>
            <ol className="mt-3 flex flex-col gap-2 text-xs text-muted">
              <li>
                <span className="text-foreground">1.</span> Get testnet CSPR from the{" "}
                <a
                  href="https://testnet.cspr.live/tools/faucet"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-border underline-offset-2 hover:text-accent"
                >
                  Casper faucet
                </a>{" "}
                — it is free and takes a minute.
              </li>
              <li>
                <span className="text-foreground">2.</span> Find your project above and hit{" "}
                <span className="text-foreground">Back</span>.
              </li>
              <li>
                <span className="text-foreground">3.</span> Connect a Casper wallet and stake. You
                sign and fund the bet yourself — the stake is escrowed by the contract, not by us.
              </li>
              <li>
                <span className="text-foreground">4.</span> When the organizers announce the
                winner, the Arbiter resolves the market on chain and winners claim.
              </li>
            </ol>
            <Link
              href={`/markets/${BUILDATHON_MARKET_SLUG}`}
              className="btn btn-primary mt-4 w-full px-5 py-2 text-center"
            >
              Open the market
            </Link>
          </div>

          <div className="card p-5">
            <h3 className="text-sm font-semibold">How it settles</h3>
            <p className="mt-2 text-xs text-muted">
              The winning outcome is the BUIDL named grand-prize winner in the organizers&apos;
              published results. The Arbiter posts it on chain and commits an evidence bundle — the
              announcement URL and its content hash — so the settlement can be checked against the
              source rather than taken on trust. If the announcement names co-winners with no
              single first place, the market voids and every stake is refunded in full.
            </p>
            <p className="mt-2 text-xs text-muted">
              {awaitingDeploy
                ? `The field of ${market.outcomes.length} is frozen on chain before the first bet is accepted: after the freeze no candidate can be added or removed, so the field you bet into is the field that settles.`
                : `The field of ${market.outcomes.length} was frozen on chain before the first bet: after the freeze no candidate can be added or removed, so the field you bet into is the field that settles.`}
            </p>
            {!contract && (
              <p className="mt-3 font-mono text-[10px] text-muted-2">Contract: not deployed yet</p>
            )}
            {contract && (
              <a
                href={`${cfg.explorerBaseUrl}/contract-package/${contract.replace(/^(hash-|contract-package-)/, "")}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 block truncate font-mono text-[10px] text-muted-2 underline decoration-border underline-offset-2 hover:text-accent"
              >
                Contract: {contract} ↗
              </a>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
