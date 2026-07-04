/**
 * Hunch-on-Casper Agent SDK — the typed client any agent (our Prophets, or a third party) uses
 * to join the economy. It speaks the public HTTP surface: the read model (`/api/markets`,
 * `/api/oracle`) and the x402 rail (`/api/agent/v1/bet`). `placeBet` runs the full x402 exchange
 * — quote (402) → settle → retry with the proof — so a caller just says "bet 5 CSPR on yes".
 *
 * Transport is injectable (`fetchImpl`): production passes the real `fetch`; tests pass a fetch
 * that dispatches straight to the route handlers, so the SDK is exercised against the real
 * endpoints with no server. The demo/Prophets thus dogfood the exact interface external agents use.
 */

import type { CasperNetwork } from "@/config/network";
import type { Market, OutcomeOdds } from "@/core/types";
import { computeOdds } from "@/core/parimutuel-odds";
import type { OracleReputation } from "@/ports/oracle";
import type { X402PaymentProof } from "@/ports/payment";

export interface HunchCasperClientOptions {
  /** Base URL of the economy (default relative — same origin). */
  baseUrl?: string;
  /** Injected fetch (default global fetch). Tests pass an in-process dispatcher. */
  fetchImpl?: typeof fetch;
  /** Casper network (default testnet). */
  network?: CasperNetwork;
}

export interface PlaceBetInput {
  marketId: string;
  outcomeKey: string;
  amountMotes: string;
  bettor: string;
}

export interface BetReceipt {
  deployHash: string;
  explorerUrl: string;
  indexed: boolean;
  totalStakedMotes?: string;
  poolByOutcomeMotes?: Record<string, string>;
}

/**
 * Settle an x402 challenge into a payment proof. In this SDK build the settlement is simulated
 * (the mock rail verifies the payer-bound nonce, not an on-chain transfer). A real agent replaces
 * this with a CSPR transfer to `payTo` and uses the resulting deploy hash as `deployHash`.
 */
function settle(nonce: string): X402PaymentProof {
  return { scheme: "casper-x402", deployHash: `x402-settled-${nonce}`, nonce };
}

export class HunchCasperClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  readonly network: CasperNetwork;

  constructor(opts: HunchCasperClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.network = opts.network ?? "testnet";
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** Discover open markets (optionally filtered by category). */
  async listMarkets(category?: Market["category"]): Promise<Market[]> {
    const q = new URLSearchParams({ network: this.network });
    if (category) q.set("category", category);
    const res = await this.fetchImpl(this.url(`/api/markets?${q.toString()}`));
    if (!res.ok) throw new Error(`listMarkets failed: ${res.status}`);
    return ((await res.json()) as { markets: Market[] }).markets;
  }

  /** Fetch one market by slug. */
  async getMarket(slug: string): Promise<Market | null> {
    const res = await this.fetchImpl(this.url(`/api/markets/${slug}?network=${this.network}`));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getMarket failed: ${res.status}`);
    return ((await res.json()) as { market: Market }).market;
  }

  /** Pool-implied odds for a market. */
  async getOdds(slug: string): Promise<OutcomeOdds[]> {
    const market = await this.getMarket(slug);
    if (!market) throw new Error(`no market '${slug}'`);
    return computeOdds(market);
  }

  /** An oracle's reputation (default the Arbiter). */
  async oracleReputation(oracleId = "arbiter"): Promise<OracleReputation> {
    const res = await this.fetchImpl(this.url(`/api/oracle/${oracleId}`));
    if (!res.ok) throw new Error(`oracleReputation failed: ${res.status}`);
    return ((await res.json()) as { reputation: OracleReputation }).reputation;
  }

  /** Place a bet, running the full x402 exchange (quote → settle → pay). */
  async placeBet(input: PlaceBetInput): Promise<BetReceipt> {
    const body = JSON.stringify({ network: this.network, ...input });

    // Step 1 — challenge.
    const challenge = await this.fetchImpl(this.url("/api/agent/v1/bet"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (challenge.status !== 402) {
      const json = await challenge.json().catch(() => ({}));
      throw new Error(`expected 402 challenge, got ${challenge.status}: ${json.error ?? ""}`);
    }
    const accepts = ((await challenge.json()) as { accepts: { nonce: string }[] }).accepts;
    const nonce = accepts?.[0]?.nonce;
    if (!nonce) throw new Error("x402 challenge missing a nonce");

    // Step 2 — settle + pay.
    const proof = settle(nonce);
    const paid = await this.fetchImpl(this.url("/api/agent/v1/bet"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment": toBase64(JSON.stringify(proof)) },
      body,
    });
    if (!paid.ok) {
      const json = await paid.json().catch(() => ({}));
      throw new Error(`placeBet failed: ${paid.status}: ${json.error ?? ""}`);
    }
    return (await paid.json()) as BetReceipt;
  }
}

function toBase64(s: string): string {
  if (typeof btoa === "function") return btoa(s);
  return Buffer.from(s, "utf8").toString("base64");
}
