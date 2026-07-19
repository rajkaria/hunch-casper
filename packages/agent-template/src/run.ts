/**
 * The runner. You should not need to touch this — edit `strategy.ts`.
 *
 * It discovers open markets, asks your strategy about each one, and completes the x402 exchange
 * for the bets it returns. Zero dependencies: plain `fetch` against the public API, so this file
 * runs on a stock Node with nothing installed.
 *
 * ```bash
 * HUNCH_AGENT_ID=agent:yourname npm start
 * ```
 */

import { decide, type Bet, type Market } from "./strategy.ts";

const BASE_URL = process.env.HUNCH_BASE_URL ?? "https://casper.playhunch.xyz";
const NETWORK = process.env.HUNCH_NETWORK ?? "testnet";
/**
 * Your agent's ledger identity — how you appear on the leaderboards. Use a stable value: change
 * it and your track record starts over, which is exactly what the registry's bond is designed to
 * make expensive.
 */
const AGENT_ID = process.env.HUNCH_AGENT_ID ?? "agent:template";
/** Seconds between rounds. */
const INTERVAL_S = Number(process.env.HUNCH_INTERVAL_S ?? 60);

interface X402Requirement {
  amountMotes: string;
  payTo: string;
  network: string;
  payer: string;
  nonce: string;
}

async function listMarkets(): Promise<Market[]> {
  const res = await fetch(`${BASE_URL}/api/markets?network=${NETWORK}&status=open`);
  if (!res.ok) throw new Error(`listMarkets failed: ${res.status}`);
  return ((await res.json()) as { markets: Market[] }).markets;
}

/**
 * Place one bet through the x402 exchange: ask for the challenge (HTTP 402), settle it, present
 * the proof.
 *
 * **The settlement step is where your wallet goes.** On the public demo the server accepts a
 * deterministic proof so this template runs with no funds. Against a real-mode deployment you
 * must send an actual CSPR transfer to `requirement.payTo` from your own key and use that
 * transaction hash as `deployHash` — the server verifies it on chain and will reject anything
 * else. See docs/AGENTS_GUIDE.md.
 */
async function placeBet(market: Market, bet: Bet): Promise<void> {
  const body = {
    network: NETWORK,
    marketId: market.id,
    outcomeKey: bet.outcomeKey,
    amountMotes: bet.amountMotes,
    bettor: AGENT_ID,
  };

  const challenge = await fetch(`${BASE_URL}/api/agent/v1/bet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (challenge.status !== 402) {
    console.warn(`  ! expected a 402 challenge, got ${challenge.status}`);
    return;
  }
  const { accepts } = (await challenge.json()) as { accepts: X402Requirement[] };
  const requirement = accepts?.[0];
  if (!requirement) {
    console.warn("  ! challenge carried no payment requirement");
    return;
  }

  const paid = await fetch(`${BASE_URL}/api/agent/v1/bet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...body,
      paymentProof: {
        scheme: "casper-x402",
        deployHash: await settle(requirement),
        nonce: requirement.nonce,
      },
    }),
  });
  if (!paid.ok) {
    console.warn(`  ! bet rejected: ${paid.status} ${await paid.text()}`);
    return;
  }
  const receipt = (await paid.json()) as { deployHash?: string };
  console.log(`  ✓ ${bet.outcomeKey} on ${market.slug} — ${bet.reason}`);
  if (receipt.deployHash) console.log(`    tx ${receipt.deployHash}`);
}

/**
 * Settle a payment requirement and return the settlement id.
 *
 * REPLACE THIS to bet real money: sign and submit a native CSPR transfer of
 * `requirement.amountMotes` to `requirement.payTo` from your own key, then return that
 * transaction's hash. The deterministic id below only satisfies the demo's mock verifier.
 */
async function settle(requirement: X402Requirement): Promise<string> {
  return `x402-${requirement.nonce}`;
}

async function round(): Promise<void> {
  const markets = await listMarkets();
  console.log(`\n${new Date().toISOString()} — ${markets.length} open market(s)`);
  for (const market of markets) {
    let bet: Bet | null = null;
    try {
      bet = decide(market);
    } catch (err) {
      // A throwing strategy must not take the whole agent down mid-season.
      console.warn(`  ! strategy threw on ${market.slug}:`, err);
      continue;
    }
    if (!bet) continue;
    try {
      await placeBet(market, bet);
    } catch (err) {
      console.warn(`  ! could not bet on ${market.slug}:`, err);
    }
  }
}

async function main(): Promise<void> {
  console.log(`Hunch agent '${AGENT_ID}' against ${BASE_URL} (${NETWORK}), every ${INTERVAL_S}s`);
  console.log(`Track record: ${BASE_URL}/api/agents/${encodeURIComponent(AGENT_ID)}/reputation`);
  for (;;) {
    try {
      await round();
    } catch (err) {
      // Keep running: an outage should cost you a round, not your season.
      console.warn("round failed:", err);
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_S * 1000));
  }
}

// Only run when executed directly, so the strategy stays importable for your own tests.
if (process.argv[1]?.endsWith("run.ts")) {
  void main();
}
