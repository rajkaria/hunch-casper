"use client";

import { useState } from "react";
import Link from "next/link";
import { useNetwork } from "@/components/network-context";

type Source = "cspr_cloud" | "coingecko" | "macro_feed" | "drand" | "internal";
type Method = "threshold" | "direction" | "nway_winner" | "coin_flip" | "agent_metric";

interface Challenge {
  recipeHash: string;
  bondMotes: string;
  nonce: string;
}
interface Created {
  slug: string;
  recipeHash: string;
  seededBets: number;
  simulated: boolean;
}

/** A demo-grade proof: the mock PaymentPort accepts any settlement hash bound to the challenge
 * nonce. A real client would attach the hash of an actual CSPR transfer here. */
function demoProof(nonce: string): string {
  let hex = "";
  for (let i = 0; i < 64; i++) hex += Math.floor((i * 2654435761) % 16).toString(16);
  return Buffer.from(JSON.stringify({ scheme: "casper-x402", deployHash: `demo-${nonce}-${hex.slice(0, 24)}`, nonce })).toString(
    "base64",
  );
}

function motesToCspr(motes: string): string {
  return (Number(BigInt(motes)) / 1e9).toString();
}

export default function CreateMarketPage() {
  const { network } = useNetwork();
  const [claim, setClaim] = useState("");
  const [source, setSource] = useState<Source>("coingecko");
  const [metric, setMetric] = useState("cspr_usd");
  const [method, setMethod] = useState<Method>("threshold");
  const [target, setTarget] = useState("0.10");
  const [comparator, setComparator] = useState<"gte" | "lte">("gte");
  const [deadline, setDeadline] = useState("2026-12-31T00:00");
  const [oracle, setOracle] = useState("account-hash-arbiter");

  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function bodyBase() {
    return {
      network,
      claim,
      creator: "demo-creator",
      oracle,
      source,
      metric,
      method,
      target: method === "threshold" ? target : undefined,
      comparator: method === "threshold" ? comparator : undefined,
      deadlineIso: new Date(deadline).toISOString(),
    };
  }

  async function requestChallenge() {
    setBusy(true);
    setError(null);
    setCreated(null);
    setChallenge(null);
    try {
      const res = await fetch("/api/markets/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyBase()),
      });
      const json = await res.json();
      if (res.status === 402) {
        setChallenge({ recipeHash: json.recipeHash, bondMotes: json.accepts[0].maxAmountRequired, nonce: json.accepts[0].nonce });
      } else {
        setError(json.error ?? "could not compose the market");
      }
    } catch {
      setError("network error");
    } finally {
      setBusy(false);
    }
  }

  async function payAndCreate() {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/markets/create", {
        method: "POST",
        headers: { "content-type": "application/json", "x-payment": demoProof(challenge.nonce) },
        body: JSON.stringify(bodyBase()),
      });
      const json = await res.json();
      if (res.status === 201) {
        setCreated({ slug: json.slug, recipeHash: json.recipeHash, seededBets: json.seededBets, simulated: json.simulated });
        setChallenge(null);
      } else {
        setError(json.error ?? "creation failed");
      }
    } catch {
      setError("network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Create a market</h1>
      <p className="mt-2 text-muted">
        Ask a question, pin how it resolves, post a small refundable bond. The resolution rule is
        frozen as a hashed <span className="font-mono text-foreground">recipe</span> — anyone can
        replay how it settled.
      </p>

      <div className="mt-8 flex flex-col gap-4">
        <Field label="Your question">
          <input
            className="w-full rounded-lg border border-surface-2 bg-surface px-3 py-2 text-sm"
            placeholder="Will CSPR cross $0.10 by year end?"
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Resolution source">
            <select className="w-full rounded-lg border border-surface-2 bg-surface px-3 py-2 text-sm" value={source} onChange={(e) => setSource(e.target.value as Source)}>
              {["coingecko", "cspr_cloud", "macro_feed", "drand", "internal"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Metric">
            <input className="w-full rounded-lg border border-surface-2 bg-surface px-3 py-2 text-sm font-mono" value={metric} onChange={(e) => setMetric(e.target.value)} />
          </Field>
          <Field label="Method">
            <select className="w-full rounded-lg border border-surface-2 bg-surface px-3 py-2 text-sm" value={method} onChange={(e) => setMethod(e.target.value as Method)}>
              {["threshold", "direction", "nway_winner", "coin_flip", "agent_metric"].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>
          {method === "threshold" && (
            <Field label="Target / comparator">
              <div className="flex gap-2">
                <select className="rounded-lg border border-surface-2 bg-surface px-2 py-2 text-sm" value={comparator} onChange={(e) => setComparator(e.target.value as "gte" | "lte")}>
                  <option value="gte">≥</option>
                  <option value="lte">≤</option>
                </select>
                <input className="w-full rounded-lg border border-surface-2 bg-surface px-3 py-2 text-sm font-mono" value={target} onChange={(e) => setTarget(e.target.value)} />
              </div>
            </Field>
          )}
          <Field label="Resolves at">
            <input type="datetime-local" className="w-full rounded-lg border border-surface-2 bg-surface px-3 py-2 text-sm" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </Field>
          <Field label="Oracle (approved, not you)">
            <input className="w-full rounded-lg border border-surface-2 bg-surface px-3 py-2 text-sm font-mono" value={oracle} onChange={(e) => setOracle(e.target.value)} />
          </Field>
        </div>

        {!challenge && !created && (
          <button
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={busy || claim.trim().length === 0}
            onClick={requestChallenge}
          >
            {busy ? "Composing…" : "Preview & get bond"}
          </button>
        )}

        {error && <p className="text-sm text-down">{error}</p>}

        {challenge && (
          <div className="card flex flex-col gap-3 p-4">
            <div className="text-sm">
              <div className="text-muted">Resolution recipe hash</div>
              <div className="mt-1 break-all font-mono text-xs text-foreground">{challenge.recipeHash}</div>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">Refundable creation bond</span>
              <span className="font-semibold">{motesToCspr(challenge.bondMotes)} CSPR</span>
            </div>
            <button className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" disabled={busy} onClick={payAndCreate}>
              {busy ? "Creating…" : "Pay bond & create"}
            </button>
          </div>
        )}

        {created && (
          <div className="card flex flex-col gap-2 p-4">
            <p className="text-sm font-semibold text-up">Market created{created.simulated ? " (simulated)" : ""}.</p>
            <p className="text-sm text-muted">
              Seeded with {created.seededBets} fleet bet{created.seededBets === 1 ? "" : "s"}. Recipe{" "}
              <span className="font-mono text-xs">{created.recipeHash.slice(0, 20)}…</span>
            </p>
            <Link href={`/markets/${created.slug}`} className="text-sm text-accent hover:underline">
              View market →
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  );
}
