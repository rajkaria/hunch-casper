/**
 * The economy's live numbers, folded from chain events at request time.
 *
 * Every figure is derived from the packages' on-chain history, and the section says so with a link
 * to the fold's own endpoint — a traction number nobody can recompute is marketing, and this
 * project's whole claim is that its numbers are auditable.
 *
 * Server component. Renders nothing at all when the fold is empty: a wall of confident zeroes is
 * worse than silence, and an empty fold is exactly the failure mode this codebase already shipped
 * once.
 */

import { createContainer } from "@/lib/container";
import { DEFAULT_NETWORK, getNetworkConfig, type CasperNetwork } from "@/config/network";
import { computeStats, formatCspr, type EconomyStats } from "@/core/stats";
import { AnimatedNumber } from "@/components/animated-number";
import { Reveal } from "@/components/reveal";

/** Motes → whole CSPR as a number, for the count-up (display only; exactness lives in formatCspr). */
function csprNumber(motes: string): number {
  return /^\d+$/.test(motes) ? Number(BigInt(motes) / 1_000_000_000n) : 0;
}

const MAX_EVENTS = 5_000;

async function loadStats(network: CasperNetwork): Promise<EconomyStats | null> {
  try {
    const events = await createContainer(network).events.fetch({ limit: MAX_EVENTS });
    const stats = computeStats(events);
    // A fold that saw nothing has nothing to report. Rendering zeroes would present a blind
    // indexer as a quiet economy — the exact ambiguity that hid a broken board for weeks.
    return stats.eventCount === 0 ? null : stats;
  } catch {
    return null;
  }
}

function Figure({
  value,
  numeric,
  label,
  hint,
  delay = 0,
}: {
  value?: string;
  numeric?: number;
  label: string;
  hint?: string;
  delay?: number;
}) {
  return (
    <Reveal delay={delay} className="h-full">
      <div className="card flex h-full flex-col gap-1 p-5">
        <span className="num text-3xl font-semibold">
          {numeric != null ? <AnimatedNumber value={numeric} /> : value}
        </span>
        <span className="text-sm font-medium">{label}</span>
        {hint ? <span className="font-mono text-[10px] uppercase tracking-wider text-muted-2">{hint}</span> : null}
      </div>
    </Reveal>
  );
}

export async function LiveNumbers({ network = DEFAULT_NETWORK }: { network?: CasperNetwork }) {
  const stats = await loadStats(network);
  if (!stats) return null;

  const cfg = getNetworkConfig(network);

  return (
    <section className="band">
      <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
        <span className="eyebrow text-up">Live, recomputable</span>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">The economy, by the numbers</h2>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Folded from {stats.eventCount.toLocaleString("en-US")} on-chain transactions across the
          deployed contract packages, as of block{" "}
          <span className="font-mono">{stats.lastBlockHeight.toLocaleString("en-US")}</span>. Nothing
          here is asserted — recompute it yourself from{" "}
          <a className="underline underline-offset-2" href={`/api/stats?network=${network}`}>
            /api/stats
          </a>{" "}
          or read the raw history on{" "}
          <a
            className="underline underline-offset-2"
            href={cfg.explorerBaseUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            cspr.live
          </a>
          .
        </p>

        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <Figure numeric={stats.bets} label="Bets placed" hint="on chain, executed" />
          <Figure
            numeric={csprNumber(stats.stakedMotes)}
            label="CSPR staked"
            hint="escrowed by the vault"
            delay={60}
          />
          <Figure numeric={stats.markets} label="Markets" hint={`${stats.rounds} rounds opened`} delay={120} />
          <Figure
            numeric={stats.settled}
            label="Rounds settled"
            hint="resolved or voided on chain"
            delay={180}
          />
          <Figure
            numeric={stats.bettors}
            label="Distinct bettors"
            hint="agents and humans with their own keys"
            delay={240}
          />
          {/*
            The payout TOTAL is only foldable when the source carries amounts. A claim's payout is
            computed inside the vault and published in its own event, not in the deploy's arguments,
            so from deploy history the honest figure is the number of claims — showing "0 CSPR paid
            out" next to a non-zero settled count would be a false number, not a modest one.
          */}
          {stats.paidOutMotes === "0" ? (
            <Figure
              numeric={stats.claims}
              label="Payouts claimed"
              hint="winners settled on chain"
              delay={300}
            />
          ) : (
            <Figure
              value={formatCspr(stats.paidOutMotes)}
              label="CSPR paid out"
              hint="claimed by winners"
              delay={300}
            />
          )}
        </div>
      </div>
    </section>
  );
}
