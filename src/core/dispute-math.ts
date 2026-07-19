/**
 * Dispute settlement math — pure, deterministic, and conservation-exact. This is the money core of
 * optimistic resolution (S25): when a proposed resolution is challenged and a stake-weighted panel
 * decides it, THIS decides who is paid what. Every branch satisfies one invariant above all:
 *
 *     Σ(bonds + vote stakes in)  ==  Σ(payouts out)
 *
 * Not a mote is minted or lost. An LLM may draft a rationale for a vote; it never sizes a payout —
 * the numbers here are integer arithmetic a contract mirrors (`contracts/src/dispute_panel.rs`).
 *
 * ## The model
 *
 * A dispute has a **proposer** (bond `P`, backing the proposed outcome), a **challenger** (bond
 * `D`, betting the proposal is wrong), and a **panel** of oracles who each stake `sᵢ` on a side:
 * `uphold` (proposer right) or `overturn` (challenger right). The panel's decision is the side with
 * the greater total stake; ties uphold the proposal (status quo bias — overturning must be earned).
 *
 * Settlement:
 *   • the **honest bonder** (proposer if upheld, challenger if overturned) gets their bond back;
 *   • the **dishonest bonder**'s bond is forfeit into a **penalty pool**;
 *   • **wrong voters** are slashed — their stake joins the penalty pool;
 *   • **correct voters** get their stake back plus a pro-rata share of the whole penalty pool.
 *
 * That closes the books exactly: penalty pool = dishonest bond + Σ(wrong stakes), and it is fully
 * redistributed to correct voters, so out == in. Integer-division dust is assigned deterministically
 * so the identity is EXACT, not approximate (property-tested).
 */

export type DisputeSide = "uphold" | "overturn";

export interface PanelVote {
  /** The panelist's identity (address / oracle id). */
  voter: string;
  side: DisputeSide;
  /** Stake at risk on this vote, in motes. */
  stakeMotes: string;
}

export interface DisputeInput {
  proposer: string;
  /** Proposer's bond, in motes. */
  proposalBondMotes: string;
  challenger: string;
  /** Challenger's dispute bond, in motes. */
  disputeBondMotes: string;
  votes: PanelVote[];
}

export interface DisputeSettlement {
  /** The side the panel decided. */
  decision: DisputeSide;
  /** Total winning-side vote stake (the tally that decided it). */
  upholdStakeMotes: string;
  overturnStakeMotes: string;
  /** `party -> motes paid out`. Parties absent from the map are paid nothing (fully forfeit). */
  payouts: Record<string, string>;
  /** The penalty pool that was redistributed (dishonest bond + slashed wrong-voter stakes). */
  penaltyPoolMotes: string;
  /** Total motes in (all bonds + all vote stakes) — equals total motes out. */
  totalInMotes: string;
  /** Total motes out (Σ payouts) — equals total in. */
  totalOutMotes: string;
}

function add(map: Record<string, bigint>, party: string, amount: bigint): void {
  map[party] = (map[party] ?? 0n) + amount;
}

/**
 * Tally the panel (stake-weighted) and settle every bond + vote. Deterministic and
 * conservation-exact. `overturnOutcomeKey` is not needed here — this settles the *money*; the
 * caller applies the decided outcome to the market.
 */
export function settleDispute(input: DisputeInput): DisputeSettlement {
  const P = BigInt(input.proposalBondMotes);
  const D = BigInt(input.disputeBondMotes);

  let upholdStake = 0n;
  let overturnStake = 0n;
  for (const v of input.votes) {
    const s = BigInt(v.stakeMotes);
    if (v.side === "uphold") upholdStake += s;
    else overturnStake += s;
  }

  // Stake-weighted decision; ties uphold (status quo).
  const decision: DisputeSide = overturnStake > upholdStake ? "overturn" : "uphold";
  const upheld = decision === "uphold";

  // Honest vs dishonest bonder.
  const honestBonder = upheld ? input.proposer : input.challenger;
  const honestBond = upheld ? P : D;
  const dishonestBond = upheld ? D : P;

  // Penalty pool = dishonest bond + slashed wrong-voter stakes.
  let penaltyPool = dishonestBond;
  const correctVoters: PanelVote[] = [];
  let correctStakeTotal = 0n;
  for (const v of input.votes) {
    const s = BigInt(v.stakeMotes);
    if (v.side === decision) {
      correctVoters.push(v);
      correctStakeTotal += s;
    } else {
      penaltyPool += s; // wrong voter slashed into the pool
    }
  }

  const out: Record<string, bigint> = {};
  // Honest bonder's bond returned.
  add(out, honestBonder, honestBond);

  if (correctStakeTotal > 0n) {
    // Correct voters: stake back + pro-rata share of the penalty pool. Dust → first correct voter.
    let distributed = 0n;
    for (const v of correctVoters) {
      const s = BigInt(v.stakeMotes);
      const share = (penaltyPool * s) / correctStakeTotal;
      add(out, v.voter, s + share);
      distributed += share;
    }
    const dust = penaltyPool - distributed;
    if (dust > 0n) add(out, correctVoters[0].voter, dust);
  } else {
    // No correct voters (e.g. no panel, or the whole panel was wrong): the penalty pool goes to the
    // honest bonder. Still conserves — nothing is minted or burned.
    add(out, honestBonder, penaltyPool);
  }

  const totalIn = P + D + upholdStake + overturnStake;
  const payouts: Record<string, string> = {};
  let totalOut = 0n;
  for (const [party, amt] of Object.entries(out)) {
    payouts[party] = amt.toString();
    totalOut += amt;
  }

  return {
    decision,
    upholdStakeMotes: upholdStake.toString(),
    overturnStakeMotes: overturnStake.toString(),
    payouts,
    penaltyPoolMotes: penaltyPool.toString(),
    totalInMotes: totalIn.toString(),
    totalOutMotes: totalOut.toString(),
  };
}
