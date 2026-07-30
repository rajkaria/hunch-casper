"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useNetwork } from "@/components/network-context";
import { isDemoAccount, useWallet } from "@/components/wallet-context";

type Source = "cspr_cloud" | "coingecko" | "macro_feed" | "drand" | "internal";
type Method = "threshold" | "direction" | "nway_winner" | "coin_flip" | "agent_metric";

/** What creation costs and requires on THIS deployment — served by `GET /api/markets/create`. */
interface CreationTerms {
  bondMotes: string;
  /** True when creating needs a signing wallet (real mode — either path). */
  walletRequired: boolean;
  /**
   * True when the visitor's own wallet signs `create_market` itself — the bond attaches from
   * their account, and the vault refunds it to THEM at clean settlement.
   */
  selfCustodial: boolean;
  /** Gas limit the prepared creation carries, in motes; the signer pays it. */
  createGasMotes?: string;
  payTo: string;
  /** The approved, non-creator oracle the vault will bind; `null` when none is configured. */
  oracle: string | null;
  simulated: boolean;
  /** An operator misconfiguration that makes the bond unpayable — shown verbatim. */
  blocker: string | null;
}

interface Challenge {
  recipeHash: string;
  bondMotes: string;
  nonce: string;
}

/** A composed market + the unsigned `create_market` waiting for the visitor's wallet. */
interface Prepared {
  recipeHash: string;
  bondMotes: string;
  gasMotes: string;
  transactionJson: string;
  transactionHash: string;
  explorerUrl: string;
  ticket: string;
  slug: string;
}
interface BondPayment {
  transactionHash: string;
  explorerUrl: string;
}
interface Created {
  slug: string;
  recipeHash: string;
  seededBets: number;
  simulated: boolean;
  deployHash?: string;
  explorerUrl?: string;
}

/**
 * The demo-mode bond proof: the mock `PaymentPort` accepts any settlement id bound to the
 * challenge nonce, so a deployment with no chain behind it still completes the handshake.
 *
 * Used ONLY when the server says no wallet is required. It used to be the only path, which is the
 * bug this page was fixed for: the real, transfer-verifying rail requires a 64-hex on-chain
 * transaction hash, and a fabricated `demo-…` id fails it before the RPC is even asked.
 */
function demoProof(nonce: string): string {
  let hex = "";
  for (let i = 0; i < 64; i++) hex += Math.floor((i * 2654435761) % 16).toString(16);
  return Buffer.from(
    JSON.stringify({ scheme: "casper-x402", deployHash: `demo-${nonce}-${hex.slice(0, 24)}`, nonce }),
  ).toString("base64");
}

/** The real proof: the hash of the transfer the visitor's wallet just submitted. */
function transferProof(nonce: string, transactionHash: string): string {
  return Buffer.from(JSON.stringify({ scheme: "casper-x402", deployHash: transactionHash, nonce })).toString(
    "base64",
  );
}

function motesToCspr(motes: string): string {
  return (Number(BigInt(motes)) / 1e9).toString();
}

/** How often to ask the chain whether the bond transfer has executed, and when to stop. */
const POLL_INTERVAL_MS = 2_500;
const POLL_TIMEOUT_MS = 180_000;

function explorerHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the block explorer";
  }
}

export default function CreateMarketPage() {
  const { network } = useNetwork();
  const { account, connected, connect, connectError, signAndSend, signingDisabledReason } = useWallet();
  const [claim, setClaim] = useState("");
  const [source, setSource] = useState<Source>("coingecko");
  const [metric, setMetric] = useState("cspr_usd");
  const [method, setMethod] = useState<Method>("threshold");
  const [target, setTarget] = useState("0.10");
  const [comparator, setComparator] = useState<"gte" | "lte">("gte");
  const [deadline, setDeadline] = useState("2026-12-31T00:00");
  const [oracle, setOracle] = useState("");

  const [terms, setTerms] = useState<CreationTerms | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [bond, setBond] = useState<BondPayment | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** What the "Pay bond & create" button is doing right now — each step takes real seconds. */
  const [stage, setStage] = useState<string | null>(null);

  // The terms are per-deployment and per-network: a testnet bond, an approved oracle, and whether
  // any of it touches a chain. Fetched rather than assumed — the hardcoded oracle placeholder this
  // replaces was not an address the vault could store.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/markets/create?network=${network}`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as CreationTerms;
        if (cancelled) return;
        setTerms(json);
        setOracle((current) => (current.trim().length > 0 ? current : (json.oracle ?? "")));
      } catch {
        /* the form still composes; the create call reports anything it cannot do */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network]);

  /** The identity the bond is paid from and the market is credited to. */
  const creator = account?.publicKey ?? "";
  const canSign = Boolean(signAndSend) && !isDemoAccount(account);
  const walletRequired = terms?.walletRequired ?? false;
  /** The visitor signs `create_market` themselves — the bond is theirs, held and refunded. */
  const selfCustodial = (terms?.selfCustodial ?? false) && canSign;
  /** Real bond, no signable wallet → nothing on this page can succeed, and it says so up front. */
  const needsWallet = walletRequired && !canSign;

  function bodyBase() {
    return {
      network,
      claim,
      creator: creator || "demo-creator",
      oracle: oracle.trim(),
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
    setPrepared(null);
    setBond(null);
    try {
      if (selfCustodial) {
        // The server composes the market and builds the `create_market` transaction with THIS
        // account as initiator. The preview card renders from what came back — recipe hash, bond,
        // gas — before any wallet opens.
        const res = await fetch("/api/markets/create/prepare", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bodyBase()),
        });
        const json = await res.json();
        if (res.ok) {
          setPrepared({
            recipeHash: json.recipeHash,
            bondMotes: json.bondMotes,
            gasMotes: json.gasMotes,
            transactionJson: json.transactionJson,
            transactionHash: json.transactionHash,
            explorerUrl: json.explorerUrl,
            ticket: json.ticket,
            slug: json.slug,
          });
        } else {
          setError(json.error ?? "could not compose the market");
        }
        return;
      }
      const res = await fetch("/api/markets/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyBase()),
      });
      const json = await res.json();
      if (res.status === 402) {
        setChallenge({
          recipeHash: json.recipeHash,
          bondMotes: json.accepts[0].maxAmountRequired,
          nonce: json.accepts[0].nonce,
        });
      } else {
        setError(json.error ?? "could not compose the market");
      }
    } catch {
      setError("network error");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Pay the bond from the visitor's OWN account: the server builds an unsigned native transfer to
   * the treasury, their wallet signs and submits it, and the resulting hash becomes the x402
   * proof. Returns the transfer, or `null` when this deployment settles bonds off-chain (501) —
   * which the caller reads as "use the demo proof", exactly as the bet panel treats its 501.
   *
   * A *declined signature* is not that case: it throws. Falling back there would be creating a
   * market on a bond the visitor just refused to pay.
   */
  async function payBondWithWallet(): Promise<BondPayment | null> {
    if (!signAndSend || isDemoAccount(account) || !creator) return null;
    setStage("Preparing the bond transfer…");
    const prepared = await fetch("/api/markets/create/bond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ network, creator }),
    });
    const prep = await prepared.json();
    if (prepared.status === 501) return null;
    if (!prepared.ok) throw new Error(prep.error ?? "could not prepare the bond transfer");

    setStage(`Approve the ${motesToCspr(prep.amountMotes)} CSPR bond in your wallet…`);
    const sent = await signAndSend(prep.transactionJson, creator);
    if (!sent.ok) throw new Error(sent.message);
    return { transactionHash: prep.transactionHash, explorerUrl: prep.explorerUrl };
  }

  /**
   * Wait for the bond transfer to EXECUTE before presenting it as a proof.
   *
   * `putTransaction` means a node queued it; the verifier on the other side refuses a transaction
   * with no execution result, and a `402` from that race looks identical, to a visitor, to a bond
   * that was never paid. So the browser holds here — with the hash and explorer link already on
   * screen — until the chain has actually taken it.
   */
  const awaitBond = useCallback(
    async (transactionHash: string): Promise<void> => {
      const deadlineMs = Date.now() + POLL_TIMEOUT_MS;
      for (;;) {
        const res = await fetch(
          `/api/markets/create/bond?network=${network}&hash=${transactionHash}`,
          { cache: "no-store" },
        );
        const json = await res.json();
        if (res.ok && json.status === "confirmed") return;
        if (res.ok && json.status === "reverted") {
          throw new Error(`${json.error ?? "the chain refused the bond transfer"} — no bond was paid`);
        }
        if (Date.now() >= deadlineMs) {
          throw new Error(
            "the bond transfer has not executed yet — it is on the chain, so follow the link above " +
              "to see where it got to before retrying",
          );
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    },
    [network],
  );

  /**
   * The self-custodial creation: the visitor's wallet signs and submits the prepared
   * `create_market` — their account attaches the bond and pays the gas, and the vault will refund
   * the bond to THEM at clean settlement. Then poll `finalize` until the chain has executed it and
   * the server has registered the market. A declined signature throws; nothing was submitted.
   */
  async function signAndCreate() {
    if (!prepared || !signAndSend || !creator) return;
    setBusy(true);
    setError(null);
    try {
      setStage("Approve the creation in your wallet…");
      const sent = await signAndSend(prepared.transactionJson, creator);
      if (!sent.ok) throw new Error(sent.message);

      // The hash was final before the signature — the receipt goes up NOW, and stays up while the
      // chain takes its 8-16s to execute.
      setBond({ transactionHash: prepared.transactionHash, explorerUrl: prepared.explorerUrl });
      setStage("Waiting for the chain to open the market…");

      const deadlineMs = Date.now() + POLL_TIMEOUT_MS;
      for (;;) {
        const res = await fetch("/api/markets/create/finalize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ticket: prepared.ticket }),
          cache: "no-store",
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "the creation could not be confirmed");
        if (json.status === "reverted") throw new Error(json.error ?? "the vault refused this creation");
        if (json.status === "created") {
          setCreated({
            slug: json.slug,
            recipeHash: json.recipeHash,
            seededBets: json.seededBets ?? 0,
            simulated: false,
            deployHash: json.deployHash,
            explorerUrl: json.explorerUrl,
          });
          setPrepared(null);
          return;
        }
        if (Date.now() >= deadlineMs) {
          throw new Error(
            "the creation has not executed yet — it is on the chain, so follow the link above to " +
              "see where it got to before retrying",
          );
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "creation failed");
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  async function payAndCreate() {
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      let paymentHeader: string;
      const paid = await payBondWithWallet();
      if (paid) {
        setBond(paid);
        setStage("Waiting for the bond to land on chain…");
        await awaitBond(paid.transactionHash);
        paymentHeader = transferProof(challenge.nonce, paid.transactionHash);
      } else {
        if (walletRequired) {
          // The server needs a real transfer and this browser cannot make one. Never send the demo
          // proof here: it would fail verification anyway, and the message would blame the payment.
          throw new Error(
            "this deployment settles bonds on chain — connect a Casper wallet that can sign to create a market",
          );
        }
        paymentHeader = demoProof(challenge.nonce);
      }

      setStage("Opening the market on chain…");
      const res = await fetch("/api/markets/create", {
        method: "POST",
        headers: { "content-type": "application/json", "x-payment": paymentHeader },
        body: JSON.stringify(bodyBase()),
      });
      const json = await res.json();
      if (res.status === 201) {
        setCreated({
          slug: json.slug,
          recipeHash: json.recipeHash,
          seededBets: json.seededBets,
          simulated: json.simulated,
          deployHash: json.deployHash,
          explorerUrl: json.explorerUrl,
        });
        setChallenge(null);
      } else {
        setError(json.error ?? "creation failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "creation failed");
    } finally {
      setBusy(false);
      setStage(null);
    }
  }

  const bondMotes = prepared?.bondMotes ?? challenge?.bondMotes ?? terms?.bondMotes ?? null;
  const oracleMissing = walletRequired && oracle.trim().length === 0;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-12 sm:px-6">
      <span className="eyebrow text-accent">Mint your own</span>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-4xl">Create a market</h1>
      <p className="mt-2 text-muted">
        Ask a question, pin how it resolves, post a small bond. The resolution rule is frozen as a
        hashed <span className="font-mono text-foreground">recipe</span> — anyone can replay how it
        settled.
      </p>
      {bondMotes && (
        <p className="mt-2 text-sm text-muted">
          The bond is <span className="font-semibold text-foreground">{motesToCspr(bondMotes)} CSPR</span>
          {terms?.selfCustodial ? (
            // The honest version of "refundable", now that it is true: the visitor's own wallet
            // signs `create_market`, so on chain THEY are the creator — and `refund_bond` pays
            // the creator when the market settles cleanly.
            <>
              , attached from your own wallet when it signs the creation. The vault holds it
              against this market and{" "}
              <span className="text-foreground">
                refunds it to your account when the market settles cleanly
              </span>
              {" — "}spamming the board costs; asking a real question doesn&apos;t.
            </>
          ) : walletRequired ? (
            <>
              , sent from your own wallet to the operator treasury and held against this market —
              which is what makes spamming the board cost something.{" "}
              {/* On the x402 fallback the operator submits `create_market`, so the vault's
                  on-chain refund goes to the operator, not this account. Only said when it is
                  what would actually happen. */}
              <span className="text-foreground">
                The market is opened on chain by the operator, so this bond is not refunded
                automatically.
              </span>
            </>
          ) : (
            <> — simulated on this deployment; no CSPR moves.</>
          )}
        </p>
      )}

      <div className="mt-8 flex flex-col gap-4">
        <Field label="Your question">
          <input
            className="input"
            placeholder="Will CSPR cross $0.10 by year end?"
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Resolution source">
            <select className="input" value={source} onChange={(e) => setSource(e.target.value as Source)}>
              {["coingecko", "cspr_cloud", "macro_feed", "drand", "internal"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Metric">
            <input className="input font-mono" value={metric} onChange={(e) => setMetric(e.target.value)} />
          </Field>
          <Field label="Method">
            <select className="input" value={method} onChange={(e) => setMethod(e.target.value as Method)}>
              {["threshold", "direction", "nway_winner", "coin_flip", "agent_metric"].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </Field>
          {method === "threshold" && (
            <Field label="Target / comparator">
              <div className="flex gap-2">
                <select className="input w-auto" value={comparator} onChange={(e) => setComparator(e.target.value as "gte" | "lte")}>
                  <option value="gte">≥</option>
                  <option value="lte">≤</option>
                </select>
                <input className="input font-mono" value={target} onChange={(e) => setTarget(e.target.value)} />
              </div>
            </Field>
          )}
          <Field label="Resolves at">
            <input type="datetime-local" className="input" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </Field>
          <Field label="Oracle (approved, not you)">
            <input
              className="input font-mono"
              value={oracle}
              placeholder="account-hash-…"
              onChange={(e) => setOracle(e.target.value)}
            />
          </Field>
        </div>

        {/* The vault stores the oracle as a Key; without one configured there is no address to
            bind, and no default is safe — a creator who names themselves can self-resolve. */}
        {oracleMissing && (
          <p className="text-xs text-down">
            No approved oracle is configured on this deployment, so a market cannot be bound to one.
          </p>
        )}
        {terms?.blocker && <p className="text-xs text-down">{terms.blocker}</p>}

        {!challenge && !created && (
          <button
            className="btn btn-primary self-start disabled:opacity-50"
            disabled={busy || claim.trim().length === 0 || oracleMissing || Boolean(terms?.blocker)}
            onClick={requestChallenge}
          >
            {busy ? "Composing…" : "Preview & get bond"}
          </button>
        )}

        {/* Named before anything is composed: with a real bond and no signable wallet, every path
            below ends in a payment that cannot be made. */}
        {needsWallet && (
          <p className="text-sm text-muted">
            {terms?.selfCustodial
              ? `Creating a market is a real transaction on ${network} — your wallet signs it and attaches the bond.`
              : `The creation bond is a real transfer on ${network}.`}{" "}
            <button type="button" onClick={connect} className="text-accent underline underline-offset-2">
              Connect a Casper wallet
            </button>{" "}
            to {terms?.selfCustodial ? "sign it from your own account" : "pay it from your own account"}.
          </p>
        )}
        {signingDisabledReason && <p className="text-[11px] text-muted">{signingDisabledReason}</p>}
        {connectError && (
          <p className="text-xs text-down">
            {connectError}{" "}
            <a
              href="https://www.casperwallet.io/download"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              Get Casper Wallet
            </a>
          </p>
        )}
        {connected && account && walletRequired && canSign && (
          <p className="text-[11px] text-muted">
            Creating as <span className="font-mono text-foreground">{account.label}</span>
            {selfCustodial ? (
              <>
                {" "}· your wallet signs <span className="font-mono">create_market</span> itself — on
                chain you are the creator, and the bond refunds to you at clean settlement
              </>
            ) : (
              <> · you sign and fund the bond from your own account</>
            )}
          </p>
        )}

        {error && <p className="text-sm text-down">{error}</p>}

        {(challenge || prepared) && (
          <div className="card flex flex-col gap-3 p-4">
            <div className="text-sm">
              <div className="text-muted">Resolution recipe hash</div>
              <div className="mt-1 break-all font-mono text-xs text-foreground">
                {(prepared ?? challenge)!.recipeHash}
              </div>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">
                Creation bond{prepared || !walletRequired ? " (refundable)" : ""}
              </span>
              <span className="font-semibold">{motesToCspr((prepared ?? challenge)!.bondMotes)} CSPR</span>
            </div>
            {prepared && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted">Gas limit (unused is mostly refunded)</span>
                <span className="font-semibold">{motesToCspr(prepared.gasMotes)} CSPR</span>
              </div>
            )}
            {/* The receipt: a real hash the moment the wallet submits it, live for the whole time
                the chain takes to execute it and the market takes to open. */}
            {bond && (
              <div className="rounded-lg border border-border bg-surface-2 p-3 text-xs">
                <div className="mb-1 font-semibold text-gold">
                  {prepared ? "Creation submitted — your wallet signed it" : "Bond transfer submitted"}
                </div>
                <div className="truncate font-mono text-muted">{bond.transactionHash}</div>
                <a
                  href={bond.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
                >
                  View it on {explorerHost(bond.explorerUrl)}
                  <span aria-hidden="true">↗</span>
                </a>
              </div>
            )}
            <button
              className="btn btn-primary disabled:opacity-50"
              disabled={busy || needsWallet}
              onClick={prepared ? signAndCreate : payAndCreate}
            >
              {busy
                ? (stage ?? "Creating…")
                : needsWallet
                  ? "Connect a wallet to pay the bond"
                  : prepared
                    ? "Sign & create — bond comes back at settlement"
                    : "Pay bond & create"}
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
            {created.explorerUrl && !created.simulated && (
              <a
                href={created.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
              >
                View the creation on {explorerHost(created.explorerUrl)} ↗
              </a>
            )}
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
