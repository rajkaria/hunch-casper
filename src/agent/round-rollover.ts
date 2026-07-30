/**
 * Round rollover — open the current round of every recurring market that does not have one yet.
 *
 * This is the step that makes the loop a loop. Without it a recurring market matures, settles, and
 * then simply stops: the catalogue quietly shrinks to whatever is still open, the boards stop
 * gaining settlements, and the league can never reach its qualifying count. Production ran for
 * 2.7 days placing bets and settling nothing, and this is the half of the fix that keeps it from
 * happening again once the deadlines are honest.
 *
 * Creation costs a measured 3.74 CSPR, so rollover is deliberately *idempotent and lazy*: it opens
 * the round the clock is currently in and never backfills missed ones. A serverless economy WILL
 * miss ticks, and paying to open rounds nobody could have bet on would burn the treasury on
 * markets with no possible participants.
 */

import type { Container } from "@/lib/container";
import type { AgentAction } from "@/adapters/mock/activity-log";
import type { MarketDefinition } from "@/core/catalogue";
import { appendAction } from "@/adapters/mock/activity-log";
import { MARKET_DEFINITIONS } from "@/core/catalogue";
import { cadenceIntervalMs, currentRound, roundWindow } from "@/core/round-schedule";
import { roundMarketId } from "@/core/round-id";
import { addCreatedMarket, findDefinition } from "@/adapters/mock/market-source";
import { isQuarantined } from "@/agent/market-quarantine";
import { creationBondMotes, oracleAccount } from "@/agent/genesis";
import { chainMode } from "@/config/chain-mode";

/** One round of a recurring market, as a definition the rest of the app treats as a normal market. */
export function roundDefinitionFor(
  parent: MarketDefinition,
  round: { index: number; deadlineMs: number },
): MarketDefinition {
  return {
    ...parent,
    slug: roundMarketId(parent.slug, round.index),
    // A round INSTANCE never recurs. If it inherited the parent's cadence its own deadline would
    // keep re-deriving forward and it would never lock — the original bug, one level down.
    cadence: "one-shot",
    deadlineIso: new Date(round.deadlineMs).toISOString(),
  };
}

/**
 * Open the current round of every recurring, non-quarantined market that lacks one.
 *
 * Returns the actions appended for each round opened; an empty array simply means every recurring
 * market already has its current round.
 */
export async function rollMaturedRounds(
  container: Container,
  opts: {
    /** False when the cadence planner has throttled market creation off: fresh rounds are real
     * on-chain creates (gas + bond) from the treasury — the ungated version of this drained the
     * operator purse to zero. The free mirror-only backfill of past rounds always runs. */
    allowChainCreation?: boolean;
  } = {},
): Promise<AgentAction[]> {
  const allowChainCreation = opts.allowChainCreation !== false;
  const nowMs = container.clock.now();
  const actions: AgentAction[] = [];

  for (const parent of MARKET_DEFINITIONS) {
    const current = currentRound(parent.cadence, nowMs);
    if (!current) continue; // one-shot: nothing to roll
    // Quarantine is a deliberate human decision. Rolling a quarantined market would silently
    // resurrect the very thing an operator switched off, and charge the treasury to do it.
    if (isQuarantined(parent.slug)) continue;

    // Current round plus a bounded backfill of the two before it. The mirror is rebuildable
    // state; when it is lost (a cold instance, a wiped envelope — it happened), the chain still
    // holds those rounds' entries and their escrowed stakes, and without a mirror definition the
    // arbiter sweep can never see them to settle. Backfilled past rounds materialise as `locked`
    // (deadline already passed) and the next sweep resolves them.
    const rounds = [current.index - 2, current.index - 1, current.index]
      .filter((i) => i >= 0)
      .map((i) => ({ index: i, ...roundWindow(i, cadenceIntervalMs(parent.cadence)!) }));

    for (const round of rounds) {
      const def = roundDefinitionFor(parent, round);
      if (findDefinition(def.slug)) continue; // this round already exists — idempotent by design
      const past = round.index < current.index;
      // A fresh round is a real treasury spend; a throttled planner's word is law here. Past
      // rounds fall through — their registration is mirror-only and free.
      if (!past && !allowChainCreation && chainMode() === "real") continue;

      // Per-market isolation: one revert must not abort every other market's rollover, or a single
      // misconfigured market freezes the whole economy's cadence.
      let receipt: { deployHash: string; explorerUrl: string } | null = null;
      if (chainMode() === "real" && !past) {
        const oracle = oracleAccount();
        if (!oracle) {
          // The vault binds an approved, non-creator oracle to every market; there is no safe
          // default. Without one the round would be unresolvable, which is worse than not opening it.
          console.warn(
            "[rollover] real mode without CASPER_ORACLE_ACCOUNT — skipping %s",
            JSON.stringify(def.slug),
          );
          continue;
        }
        try {
          receipt = await container.chain.createMarket({
            marketId: def.slug,
            question: def.title,
            category: def.category,
            oracle,
            feeBps: def.feeBps,
            deadlineMs: round.deadlineMs,
            outcomeKeys: def.outcomes.map((o) => o.key),
            bondMotes: creationBondMotes(),
          });
        } catch (err) {
          console.warn(
            "[rollover] could not open the next round — skipped this tick, retrying next:",
            JSON.stringify({ slug: def.slug, round: round.index }),
            err,
          );
          continue;
        }
      }
      // A PAST round is registered mirror-only, never created on chain: its deadline has passed,
      // so a create would revert (and re-revert every tick, burning gas). If the chain already
      // holds the round — the lost-mirror case this backfill exists for — the arbiter sweep now
      // sees it and settles its escrow; if the chain never had it, the sweep's single resolve
      // attempt reverts UnknownMarket and quarantine isolates it. Either way the cost is bounded.

      // Register the off-chain mirror only AFTER the chain accepted it, so a reverted create can
      // never leave a round that looks bettable but has no escrow behind it.
      try {
        addCreatedMarket(def, container.network);
      } catch (err) {
        console.warn("[rollover] round already registered:", JSON.stringify(def.slug), err);
        continue;
      }

      actions.push(
        appendAction({
          agent: "Genesis",
          kind: "market_created",
          marketId: `${container.network}:${def.slug}`,
          marketTitle: def.title,
          narration: `Round ${round.index} of "${parent.title}" is open — bets close at ${def.deadlineIso}.`,
          deployHash: receipt?.deployHash,
          explorerUrl: receipt?.explorerUrl,
          simulated: receipt === null,
        }),
      );
    }
  }
  return actions;
}
