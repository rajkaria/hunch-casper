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

// Relative imports (not `@/` aliases) so this file compiles unchanged as the publishable
// `hunch-casper-sdk` package (packages/sdk), whose standalone tsconfig has no alias map.
import type { CasperNetwork } from "../config/network";
import type { Market, OutcomeOdds } from "../core/types";
import { computeOdds } from "../core/parimutuel-odds";
import type { AgentPnl } from "../core/agent-leaderboard";
import type { OracleReputation } from "../ports/oracle";
import type { X402PaymentProof } from "../ports/payment";

/** The economy's two leaderboards, as returned by `GET /api/agent/leaderboard`. */
export interface EconomyLeaderboard {
  network: CasperNetwork;
  agentPnl: AgentPnl[];
  oracleAccuracy: OracleReputation[];
}

/**
 * An agent's economically-verified track record. Every field is derived from the vault's own
 * event log, so a consumer can recompute it from the chain rather than trusting this API — which
 * is the only reason a reputation number is worth anything.
 */
export interface AgentReputation {
  agent: string;
  source: "chain-events";
  calibration: {
    /** Mean squared forecast error. **Lower is better**; 0 is perfect, 1 is maximally wrong. */
    brier: number;
    /** Stake-weighted Brier — what the agent's money actually predicted. */
    weightedBrier: number;
    /** `1 − brier / 0.25` in basis points. Positive beats a coin flip; negative is worse. */
    skillBps: number;
    /** Settled forecasts behind the score. Check this before ranking on it. */
    sampleCount: number;
    meanForecast: number;
    hitRate: number;
    /** The always-50 % reference point, 0.25. */
    baselineBrier: number;
  };
  byCategory: { category: string; brier: number; skillBps: number; sampleCount: number }[];
  performance: {
    realizedPnlMotes: string;
    roiBps: number;
    stakedMotes: string;
    returnedMotes: string;
    volumeMotes: string;
    settledCount: number;
    wins: number;
    winRate: number;
    betCount: number;
    marketCount: number;
  };
  activity: { firstBetAt: number | null; lastBetAt: number | null };
  /** Evidence for a human decision, not a verdict — every heuristic has an innocent explanation. */
  manipulationSignals: { kind: string; agents: string[]; marketIds: string[]; strength: number; detail: string }[];
  caveats: string[];
}

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

  /** The economy's leaderboards — agent realized PnL + oracle accuracy. */
  async leaderboard(): Promise<EconomyLeaderboard> {
    const res = await this.fetchImpl(this.url(`/api/agent/leaderboard?network=${this.network}`));
    if (!res.ok) throw new Error(`leaderboard failed: ${res.status}`);
    return (await res.json()) as EconomyLeaderboard;
  }

  /**
   * An agent's track record, folded from chain events: calibration (Brier — **lower is better**,
   * 0.25 is the always-50 % baseline), per-category expertise, PnL, volume, and any manipulation
   * signals. Returns `null` when the agent has no on-chain betting history, which is a different
   * answer from a score of zero.
   *
   * Read `calibration.sampleCount` before ranking on the score: a confident-looking Brier built on
   * two settled bets is noise, and this endpoint reports the evidence rather than hiding it.
   */
  async agentReputation(agent: string): Promise<AgentReputation | null> {
    const res = await this.fetchImpl(
      this.url(`/api/agents/${encodeURIComponent(agent)}/reputation?network=${this.network}`),
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`agentReputation failed: ${res.status}`);
    return (await res.json()) as AgentReputation;
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
