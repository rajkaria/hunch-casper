/**
 * "Live on Casper" proof section — renders the deployed contract packages and hand-picked real
 * transaction receipts as clickable cspr.live links, per network. Server component: the proof is
 * derived from build-time env (`NEXT_PUBLIC_*` contract addresses + `NEXT_PUBLIC_ONCHAIN_RECEIPTS`)
 * via `onchainProof`, and the whole section renders nothing until something real is wired — the
 * proof surface never fabricates a hash.
 */

import { CASPER_NETWORKS, getNetworkConfig } from "@/config/network";
import { onchainProof } from "@/config/onchain-proof";
import type { ProofLink } from "@/config/onchain-proof";

function short(hash: string): string {
  const bare = hash.replace(/^(hash-|contract-package-|contract-)/, "");
  return bare.length > 16 ? `${bare.slice(0, 8)}…${bare.slice(-8)}` : bare;
}

function ProofRow({ link, kind }: { link: ProofLink; kind: "contract" | "tx" }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="card card-hover flex items-center justify-between gap-3 p-4"
    >
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-semibold">{link.label}</span>
        <span className="truncate font-mono text-[11px] text-muted">{short(link.hash)}</span>
      </div>
      <span className="chip shrink-0 border-up/50 px-2.5 py-1 text-[11px] uppercase tracking-wide text-up">
        {kind === "contract" ? "contract ↗" : "tx ↗"}
      </span>
    </a>
  );
}

export function OnchainProofSection() {
  const proofs = CASPER_NETWORKS.map((n) => onchainProof(n)).filter((p) => p.hasAny);
  if (proofs.length === 0) return null;

  return (
    <section className="border-t border-border bg-surface/40">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <div className="mb-10 flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-up">
            Don&rsquo;t trust us — click the explorer
          </span>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Live on Casper.</h2>
          <p className="max-w-2xl text-muted">
            Original Odra contracts, deployed and verifiable. Every link below is a real{" "}
            cspr.live page — the demo economy is deterministic, the chain layer is not.
          </p>
        </div>
        <div className="flex flex-col gap-10">
          {proofs.map((proof) => (
            <div key={proof.network} className="flex flex-col gap-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
                {getNetworkConfig(proof.network).label}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {proof.contracts.map((c) => (
                  <ProofRow key={c.url} link={c} kind="contract" />
                ))}
                {proof.receipts.map((r) => (
                  <ProofRow key={r.url} link={r} kind="tx" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
