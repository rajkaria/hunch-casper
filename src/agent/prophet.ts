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
import { PROPHETS, decide, MAX_CONVICTION_MULTIPLIER } from "@/core/prophet-strategies";
import { csprToMotes } from "@/core/types";
import { agentBet } from "@/lib/agent-bet";
import { computeOdds } from "@/core/parimutuel-odds";
import { appendAction } from "@/adapters/mock/activity-log";
import type { AgentAction } from "@/adapters/mock/activity-log";
import type { X402PaymentProof, X402PaymentRequirement } from "@/ports/payment";
import { chainMode } from "@/config/chain-mode";

/**
 * Motes a Prophet must hold ABOVE its stake before it is allowed to bet: the native-transfer
 * payment limit plus a margin. An agent that submits a transfer it cannot pay for burns gas to
 * produce a failed transaction and an unverifiable proof — strictly worse than sitting the round
 * out, which costs nothing and leaves the balance available for the next one.
 */
export const PROPHET_GAS_FLOOR_MOTES = 200_000_000n;

/**
 * What one turn can cost the richest-betting agent: the largest stake in the fleet, at Momentum's
 * doubled conviction, plus the gas on its own x402 transfer.
 *
 * THE SINGLE SOURCE OF TRUTH for "can this purse afford to act". Both the cadence planner (which
 * throttles betting off below `BETTING_FLOOR_ROUNDS` of this) and the health endpoint (which calls
 * a purse funded or not) ask this one function. They used to compute it separately and drifted the
 * moment stakes changed — health reporting every purse funded while the planner had already
 * throttled betting off is the worst kind of green: an operator sees a healthy fleet and no bets,
 * with nothing in either surface explaining the contradiction.
 */
export function prophetTurnCostMotes(): string {
  const largestStake = PROPHETS.reduce((max, p) => Math.max(max, p.stakeCspr), 0);
  const worstCase = BigInt(csprToMotes(largestStake)) * BigInt(MAX_CONVICTION_MULTIPLIER);
  return (worstCase + PROPHET_GAS_FLOOR_MOTES).toString();
}

/**
 * Settle a Prophet's x402 requirement by moving real money from the Prophet's own purse.
 *
 * This is the sprint's whole point. The fleet used to hand back `x402-settled-<nonce>-<seq>` — a
 * string shaped like a proof that no chain had ever seen, which the transfer-verifying
 * PaymentPort correctly rejected, leaving the fleet unable to bet in real mode. Now the Prophet
 * transfers to `requirement.payTo` from the account the requirement is bound to, and the
 * resulting transaction hash IS the proof: verifiable by anyone, against the chain, without
 * trusting this server.
 *
 * Against the mock wallet this is the same code path with a deterministic purse, so CI exercises
 * the real control flow — including running out of money — with no credentials.
 *
 * Returns `null` when the agent cannot afford the payment or the transfer fails; the caller skips
 * the turn.
 */
async function settleFromAgentPurse(
  container: Container,
  agentId: string,
  requirement: X402PaymentRequirement,
): Promise<X402PaymentProof | null> {
  const needed = BigInt(requirement.amountMotes) + PROPHET_GAS_FLOOR_MOTES;
  let balance: bigint;
  try {
    balance = BigInt(await container.wallet.balanceOf(agentId));
  } catch {
    return null;
  }
  if (balance < needed) {
    console.warn(
      `[prophet] ${agentId} sits out: balance ${balance} motes is below the ${needed} needed ` +
        `(stake ${requirement.amountMotes} + gas floor ${PROPHET_GAS_FLOOR_MOTES}) — refill the fleet wallet`,
    );
    return null;
  }
  try {
    const transfer = await container.wallet.transfer({
      agentId,
      toAccount: requirement.payTo,
      amountMotes: requirement.amountMotes,
    });
    return { scheme: "casper-x402", deployHash: transfer.deployHash, nonce: requirement.nonce };
  } catch (err) {
    console.warn(`[prophet] ${agentId} could not settle its x402 payment:`, err);
    return null;
  }
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

  // The Prophet's ledger identity is its name; the account that signs its payment is its own
  // derived Casper key. Both travel with the bet — see `AgentBetInput.payerAccount`.
  const account = await container.wallet.accountFor(prophet.id);

  // x402 two-step: quote (get the account-bound requirement) → pay from the agent's purse → place.
  const quote = await agentBet(container, {
    marketId: market.id,
    outcomeKey: decision.outcomeKey,
    amountMotes: decision.amountMotes,
    bettor: prophet.id,
    payerAccount: account.publicKeyHex,
  });
  if (quote.status !== "payment_required") {
    // A quote that is not a 402 challenge means the rail itself is closed (misconfigured real-mode
    // x402, a market that just closed, a cap). Silence here read as "the fleet is quiet" for a
    // whole deployment; say why.
    console.warn(
      "[prophet] %s could not get a payment quote (status %s): %s",
      prophet.id,
      quote.status,
      quote.status === "error" ? quote.error : "unexpected quote status",
    );
    return null;
  }

  const proof = await settleFromAgentPurse(container, prophet.id, quote.requirement);
  if (!proof) return null; // unfunded or transfer failed — sit this round out

  const placed = await agentBet(container, {
    marketId: market.id,
    outcomeKey: decision.outcomeKey,
    amountMotes: decision.amountMotes,
    bettor: prophet.id,
    payerAccount: account.publicKeyHex,
    paymentProof: proof,
  });
  if (placed.status !== "placed") {
    // THE EXPENSIVE ONE. The agent has already paid: money left its purse and landed in the
    // treasury. Dropping this silently is how a live deployment leaked a stake per round while
    // recording no bets and looking merely idle. An operator must be able to see the paid-for-
    // nothing case in the logs, with the settlement hash to reconcile against.
    console.error(
      "[prophet] %s PAID BUT DID NOT PLACE — settlement %s, status %s: %s",
      prophet.id,
      proof.deployHash,
      placed.status,
      placed.status === "error" ? placed.error : "unexpected placement status",
    );
    return null;
  }

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
 * How many Prophets act per round.
 *
 * Mock mode sends the whole fleet: the rivalry playing out inside a single round is the demo, and
 * it costs nothing. Real mode defaults to **one**, because the arithmetic is unforgiving — four
 * bets per tick at the 10-minute cadence is 576 real transactions a day, and at ~2.33 CSPR of net
 * gas each that is ~1,340 CSPR/day of pure gas, well beyond what a faucet-funded testnet deployer
 * can sustain. One Prophet per tick rotates through the fleet instead: every agent still gets its
 * turns, the pool still moves between rivals across the hour, and the burn drops ~4x.
 *
 * `CASPER_PROPHETS_PER_TICK` overrides it for an operator who has funded for more.
 */
export function prophetsPerTick(): number {
  const raw = Number(process.env.CASPER_PROPHETS_PER_TICK);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(Math.floor(raw), PROPHETS.length);
  return chainMode() === "real" ? 1 : PROPHETS.length;
}

export interface FleetOptions {
  /** Override how many Prophets act this round (before the per-agent affordability check). */
  maxProphets?: number;
}

/**
 * Seed a freshly-created market with the fleet's long-tail liquidity (S23). A human-created market
 * is empty at birth; without takers its odds are meaningless and nobody wants to be first. So the
 * fleet steps in — up to `maxProphets` Prophets each place their normal strategy-sized x402 bet on
 * this one market, through the exact same money path as any other bet (so the liquidity is real,
 * not a fabricated pool). Bounded and best-effort: an unfunded Prophet in real mode simply sits out
 * (`runProphet` returns null), and meta-markets are never seeded this way (they aren't user-created).
 * Returns the bets actually placed.
 */
export async function seedNewMarketByFleet(
  container: Container,
  slug: string,
  opts: { maxProphets?: number; startSeq?: number } = {},
): Promise<AgentAction[]> {
  const market = await container.store.get(slug, container.network);
  if (!market || market.category === "meta" || market.status !== "open") return [];
  const count = Math.min(opts.maxProphets ?? 2, PROPHETS.length);
  const start = opts.startSeq ?? 0;
  const actions: AgentAction[] = [];
  for (let i = 0; i < count; i++) {
    // Different seq per prophet so their strategies diverge onto different sides — real two-sided
    // liquidity, not everyone piling onto the favourite.
    const prophet = PROPHETS[i % PROPHETS.length];
    const action = await runProphet(container, prophet, slug, start + i);
    if (action) actions.push(action);
  }
  return actions;
}

/**
 * Run the fleet for one round. Picks a target market (deterministic by `seq`) among the open
 * markets and sends the round's Prophets at it in order, so the pool shifts between them.
 *
 * When fewer than the whole fleet acts, the starting index rotates with `seq`, so the same agent
 * is not the only one ever betting — over a handful of rounds every Prophet takes a turn, and the
 * boards stay a fair comparison rather than a record of who happened to be first.
 */
export async function runProphetFleet(
  container: Container,
  seq: number,
  opts: FleetOptions = {},
): Promise<AgentAction[]> {
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

  const count = Math.min(opts.maxProphets ?? prophetsPerTick(), PROPHETS.length);
  const actions: AgentAction[] = [];
  for (let i = 0; i < count; i++) {
    // Rotate the starting agent with the round so a partial fleet is not always the same agent.
    const prophet = PROPHETS[(seq + i) % PROPHETS.length];
    const action = await runProphet(container, prophet, target.slug, seq + i);
    if (action) actions.push(action);
  }
  return actions;
}
