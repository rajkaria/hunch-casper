/**
 * House seeding — real-mode cold-start liquidity.
 *
 * The deterministic demo seed (`adapters/mock/demo-seed.ts`) deliberately refuses to run in real
 * mode: fabricating activity where real value moves would be a lie. But that leaves a real-mode
 * market with two empty pools, which is not merely unattractive — with nothing staked there are no
 * odds to read, so the first Prophet has nothing to have an opinion *about* and the strategies
 * have no signal to trade against.
 *
 * So real mode gets real seeding: the operator stakes genuine CSPR on both sides of a new market,
 * in the catalogue's own ratio, scaled down. Every seed is an on-chain transaction with an
 * explorer link — it is labelled `house seed` for honesty, not because it is fake.
 *
 * The house bets under the `house` bettor id, which the PnL board excludes by construction (only
 * `agent:*` bettors are ranked). Seed liquidity must never appear as an agent's skill.
 */

import type { Container } from "@/lib/container";
import type { MarketDefinition } from "@/core/catalogue";
import { appendAction, type AgentAction } from "@/adapters/mock/activity-log";
import { motesToCspr } from "@/core/types";

/** Ledger id for house liquidity. Deliberately not `agent:*`, so no board ever ranks it. */
export const HOUSE_BETTOR = "house";

/**
 * The catalogue's seed pools are sized for a demo (~500 CSPR a side). Dividing by 500 stakes
 * ~1 CSPR per outcome — enough to give a market real odds, small enough that seeding every new
 * market costs a couple of CSPR rather than a thousand.
 */
export const DEFAULT_HOUSE_SEED_DIVISOR = 500;

export function houseSeedDivisor(): number {
  const raw = Number(process.env.CASPER_HOUSE_SEED_DIVISOR);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_HOUSE_SEED_DIVISOR;
}

/**
 * Scale a market's catalogue seed pools down, preserving the ratio between outcomes.
 *
 * Ratio-preserving matters: the seed pools ARE the market's opening odds, so scaling them
 * unevenly would silently move the starting price. Outcomes that round to zero are dropped rather
 * than bumped to one mote — a token stake would distort the ratio it was meant to preserve.
 */
export function scaleSeedPools(
  seedPoolMotes: Record<string, string> | undefined,
  divisor: number,
): { outcomeKey: string; amountMotes: string }[] {
  if (!seedPoolMotes || divisor < 1) return [];
  const out: { outcomeKey: string; amountMotes: string }[] = [];
  for (const [outcomeKey, motes] of Object.entries(seedPoolMotes)) {
    if (!/^\d+$/.test(motes)) continue;
    const scaled = BigInt(motes) / BigInt(divisor);
    if (scaled > 0n) out.push({ outcomeKey, amountMotes: scaled.toString() });
  }
  return out;
}

/**
 * Stake the house's opening liquidity into a freshly created market.
 *
 * Best-effort per outcome: a failed seed leaves the market thinner, which is a far better outcome
 * than aborting the creation that already succeeded on chain. Returns the actions it logged.
 */
export async function seedMarketPools(
  container: Container,
  def: MarketDefinition,
  marketId: string,
): Promise<AgentAction[]> {
  const seeds = scaleSeedPools(def.seedPoolMotes, houseSeedDivisor());
  const actions: AgentAction[] = [];
  for (const seed of seeds) {
    try {
      const receipt = await container.chain.placeBet({
        marketId,
        outcomeKey: seed.outcomeKey,
        amountMotes: seed.amountMotes,
        bettor: HOUSE_BETTOR,
      });
      await container.store.recordBet({
        marketId,
        bettor: HOUSE_BETTOR,
        outcomeKey: seed.outcomeKey,
        amountMotes: seed.amountMotes,
      });
      actions.push(
        appendAction({
          agent: "House",
          kind: "bet_placed",
          marketId,
          marketTitle: def.title,
          outcomeKey: seed.outcomeKey,
          amountMotes: seed.amountMotes,
          narration: `House seed — ${motesToCspr(seed.amountMotes)} CSPR of opening liquidity on ${seed.outcomeKey}, so the market has odds to trade against.`,
          deployHash: receipt.deployHash,
          explorerUrl: receipt.explorerUrl,
          simulated: false, // a genuine on-chain stake; "house seed" describes its purpose, not its reality
        }),
      );
    } catch (err) {
      // The market id can come from user input; keep it out of the format string and escape it.
      console.warn("[house-seed] could not seed", JSON.stringify(`${marketId}/${seed.outcomeKey}`), "—", err);
    }
  }
  return actions;
}
