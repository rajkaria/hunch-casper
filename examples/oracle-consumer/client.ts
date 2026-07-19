/**
 * Reference oracle-as-a-service CLIENT — how another protocol *buys* a Hunch resolution answer over
 * the x402-metered query API (S26). Runnable pseudocode against the deployed endpoint.
 *
 *   node client.ts <slug>            # a free-tier query
 *
 * The free tier answers directly. Past the tier the endpoint returns HTTP 402 with an x402
 * requirement; pay the CSPR (attach the transfer's deploy hash as the proof) and retry. The answer
 * carries the evidence-bundle hash so you can independently replay the resolution before trusting
 * it — you verify the math, not our word.
 */

const BASE = process.env.HUNCH_BASE_URL ?? "https://casper.playhunch.xyz";

interface QueryAnswer {
  answer: { resolved: boolean; winningOutcomeKey: string | null; claimResolvedTrue: boolean | null };
  evidence: { recipeHash: string; bundleHash: string; uri: string } | null;
  oracle: { id: string; accuracyBps: number; resolvedCount: number };
}

/** Ask the oracle whether a market's claim resolved true. Handles the x402 upgrade transparently. */
export async function askOracle(slug: string, caller: string): Promise<QueryAnswer> {
  const body = JSON.stringify({ network: "testnet", slug, caller });
  const first = await fetch(`${BASE}/api/oracle/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  if (first.status === 200) return (await first.json()) as QueryAnswer;

  if (first.status === 402) {
    const challenge = await first.json();
    const req = challenge.accepts[0];
    // 1) Send a CSPR transfer of `req.maxAmountRequired` to `req.payTo` on-chain.
    // 2) Attach the resulting deploy hash as the x402 proof, bound to the challenge nonce.
    const deployHash = await payCspr(req.payTo, req.maxAmountRequired); // your wallet
    const proof = Buffer.from(JSON.stringify({ scheme: "casper-x402", deployHash, nonce: req.nonce })).toString("base64");
    const paid = await fetch(`${BASE}/api/oracle/query`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payment": proof },
      body,
    });
    return (await paid.json()) as QueryAnswer;
  }

  throw new Error(`oracle query failed: ${first.status}`);
}

/** Replace with your Casper wallet's transfer. Returns the settlement deploy hash. */
async function payCspr(payTo: string, amountMotes: string): Promise<string> {
  throw new Error(`wire your Casper wallet here: transfer ${amountMotes} motes to ${payTo}, return the deploy hash`);
}
