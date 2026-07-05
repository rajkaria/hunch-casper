/**
 * The Prophet fleet runner — turns the pure strategies into live agents. Each Prophet reads a
 * market's current odds, decides via its strategy, narrates *why* through the LlmClient (advisory
 * only), and bets through the x402 rail (`agentBet` — the exact exchange the SDK + external agents
 * use). Every bet is logged to the activity feed. The fleet points all four Prophets at one market
 * per round and runs them in order, re-reading odds each time, so their bets visibly move the pool
 * against each other — the rivalry the demo is built on.
 */

import type { Container } from "@/lib/container";
import type { Prophet } from "@/core/prophet-strategies";
import { PROPHETS, decide } from "@/core/prophet-strategies";
import { agentBet } from "@/lib/agent-bet";
import { computeOdds } from "@/core/parimutuel-odds";
import { appendAction } from "@/adapters/mock/activity-log";
import type { AgentAction } from "@/adapters/mock/activity-log";
import type { X402PaymentProof } from "@/ports/payment";
import { chainMode } from "@/config/chain-mode";

/** Mock x402 settlement — form the payer-bound proof. Each round produces a distinct settlement id
 * (a real agent's CSPR transfer is naturally unique per payment). Real agents transfer to `payTo`. */
function settle(nonce: string, seq: number): X402PaymentProof {
  return { scheme: "casper-x402", deployHash: `x402-settled-${nonce}-${seq}`, nonce };
}

/** Run one Prophet against one market (by slug), placing an x402 bet + logging the narrated action. */
export async function runProphet(
  container: Container,
  prophet: Prophet,
  slug: string,
  seq: number,
): Promise<AgentAction | null> {
  const market = await container.store.get(slug, container.network);
  if (!market) return null;

  const decision = decide(prophet.strategy, market, computeOdds(market), seq, prophet.stakeCspr);
  if (!decision) return null;

  const narration = (
    await container.llm.complete({
      system: `You are ${prophet.name}, a rival prediction-market bettor on Casper. One vivid sentence, first person.`,
      prompt: `Explain why you are betting "${decision.outcomeKey}" on "${market.title}". Angle: ${decision.reason}`,
    })
  ).trim();

  // x402 two-step: quote (get the payer-bound requirement) → settle → place.
  const quote = await agentBet(container, {
    marketId: market.id,
    outcomeKey: decision.outcomeKey,
    amountMotes: decision.amountMotes,
    bettor: prophet.id,
  });
  if (quote.status !== "payment_required") return null;

  const placed = await agentBet(container, {
    marketId: market.id,
    outcomeKey: decision.outcomeKey,
    amountMotes: decision.amountMotes,
    bettor: prophet.id,
    paymentProof: settle(quote.requirement.nonce, seq),
  });
  if (placed.status !== "placed") return null;

  return appendAction({
    agent: prophet.name,
    kind: "bet_placed",
    marketId: market.id,
    marketTitle: market.title,
    outcomeKey: decision.outcomeKey,
    amountMotes: decision.amountMotes,
    narration: narration || decision.reason,
    deployHash: placed.deployHash,
    explorerUrl: placed.explorerUrl,
    simulated: chainMode() !== "real",
  });
}

/**
 * Run the whole fleet for one round. Picks a target market (deterministic by `seq`) among the
 * open markets and sends every Prophet at it in order, so the pool shifts between them.
 */
export async function runProphetFleet(container: Container, seq: number): Promise<AgentAction[]> {
  // Prophets trade only BASE markets — never meta-markets. A meta-market (`prophet-race`,
  // `momentum-vs-contrarian`, `arbiter-accuracy-95`) resolves against the Prophet PnL / oracle
  // boards, so letting the fleet bet them would let their bets contaminate the very board that
  // scores them (a reflexive loop). Meta-markets are for humans + external agents; excluding them
  // here keeps the self-scoring board honest — the same invariant the economy-loop tests assume.
  const open = (await container.store.list({ network: container.network, status: "open" })).filter(
    (m) => m.category !== "meta",
  );
  if (open.length === 0) return [];
  const target = open[seq % open.length];

  const actions: AgentAction[] = [];
  for (let i = 0; i < PROPHETS.length; i++) {
    const action = await runProphet(container, PROPHETS[i], target.slug, seq + i);
    if (action) actions.push(action);
  }
  return actions;
}
