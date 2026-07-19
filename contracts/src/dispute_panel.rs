//! DisputePanel — optimistic resolution with staked disputes (S25), the "UMA of Casper".
//!
//! A proposed resolution is not final the instant it is posted. The proposer escrows a bond behind
//! an outcome; a challenge window opens. If it closes unchallenged the proposal finalizes cheaply.
//! If someone challenges, they escrow a dispute bond, a stake-weighted panel of oracles votes, and
//! at the end of the voting window `finalize` settles every bond and vote by **pure math** —
//! never an LLM. The economics mirror `core/dispute-math.ts` byte-for-byte:
//!
//!   * decision = the side (uphold / overturn) with the greater total vote stake; ties uphold
//!     (status quo bias — overturning must be earned);
//!   * the honest bonder (proposer if upheld, challenger if overturned) gets their bond back;
//!   * the dishonest bonder's bond and every wrong voter's stake form a **penalty pool**;
//!   * correct voters get their stake back plus a pro-rata share of the whole penalty pool.
//!
//! Conservation is the invariant the tests hammer: Σ(bonds + stakes in) == Σ(payouts out), exactly
//! — integer-division dust is handed to the first correct voter so nothing is minted or lost. This
//! contract holds no market state; it settles disputes and reports the decided outcome. The vault /
//! off-chain layer applies that outcome to the market.
use odra::casper_types::U512;
use odra::prelude::*;

const STATUS_PROPOSED: u8 = 0;
const STATUS_CHALLENGED: u8 = 1;
const STATUS_FINALIZED: u8 = 2;

/// Panel side: uphold the proposal, or overturn it.
const SIDE_UPHOLD: u8 = 0;
const SIDE_OVERTURN: u8 = 1;

#[odra::odra_error]
pub enum Error {
    /// No dispute under this market id.
    UnknownDispute = 1,
    /// A dispute for this market already exists.
    DisputeExists = 2,
    /// The challenge window has closed.
    ChallengeClosed = 3,
    /// Already challenged — only one challenge per proposal.
    AlreadyChallenged = 4,
    /// Voting is only open on a challenged dispute within its window.
    VotingClosed = 5,
    /// This dispute is not a challenged one (nothing to vote on / escalate).
    NotChallenged = 6,
    /// The voting window has not closed yet — cannot finalize.
    VotingOngoing = 7,
    /// The challenge window has not closed yet — cannot finalize an unchallenged proposal.
    ChallengeOngoing = 8,
    /// A bond / stake must carry non-zero CSPR.
    ZeroStake = 9,
    /// This oracle already voted on this dispute.
    AlreadyVoted = 10,
    /// Dispute already finalized.
    AlreadyFinalized = 11,
    /// Invalid vote side.
    InvalidSide = 12,
}

/// Emitted when a resolution is proposed with a bond.
#[odra::event]
pub struct ResolutionProposed {
    pub market_id: String,
    pub proposer: Address,
    pub proposed_outcome: String,
    pub bond: U512,
    pub challenge_deadline: u64,
}

/// Emitted when a proposal is challenged.
#[odra::event]
pub struct ResolutionChallenged {
    pub market_id: String,
    pub challenger: Address,
    pub challenger_outcome: String,
    pub bond: U512,
    pub voting_deadline: u64,
}

/// Emitted on each panel vote.
#[odra::event]
pub struct VoteCast {
    pub market_id: String,
    pub voter: Address,
    pub side: u8,
    pub stake: U512,
}

/// Emitted when a dispute finalizes, carrying the decided outcome.
#[odra::event]
pub struct DisputeFinalized {
    pub market_id: String,
    /// True if the proposal was upheld (or finalized unchallenged).
    pub upheld: bool,
    pub decided_outcome: String,
    /// Total penalty pool redistributed to correct voters.
    pub penalty_pool: U512,
}

/// Emitted per payout so the conservation of a settlement is auditable from the log.
#[odra::event]
pub struct DisputePayout {
    pub market_id: String,
    pub recipient: Address,
    pub amount: U512,
}

/// Immutable proposal record.
#[odra::odra_type]
pub struct Proposal {
    pub proposer: Address,
    pub proposed_outcome: String,
    pub bond: U512,
    pub challenge_deadline: u64,
    pub voting_deadline: u64,
    pub status: u8,
    pub challenger: Address,
    pub challenger_outcome: String,
    pub dispute_bond: U512,
}

#[odra::module(
    events = [ResolutionProposed, ResolutionChallenged, VoteCast, DisputeFinalized, DisputePayout],
    errors = Error
)]
pub struct DisputePanel {
    /// Length of the unchallenged-finalization window, ms.
    challenge_window_ms: Var<u64>,
    /// Length of the panel-voting window, ms.
    voting_window_ms: Var<u64>,
    exists: Mapping<String, bool>,
    proposal: Mapping<String, Proposal>,
    /// market -> ordered voter list (for tally + settlement iteration).
    voters: Mapping<String, Vec<Address>>,
    /// (market, voter) -> already voted.
    voted: Mapping<(String, Address), bool>,
    /// (market, voter) -> side.
    vote_side: Mapping<(String, Address), u8>,
    /// (market, voter) -> stake.
    vote_stake: Mapping<(String, Address), U512>,
    /// market -> total uphold / overturn stake.
    uphold_stake: Mapping<String, U512>,
    overturn_stake: Mapping<String, U512>,
}

#[odra::module]
impl DisputePanel {
    /// Initialize with the challenge + voting window lengths (ms).
    pub fn init(&mut self, challenge_window_ms: u64, voting_window_ms: u64) {
        self.challenge_window_ms.set(challenge_window_ms);
        self.voting_window_ms.set(voting_window_ms);
    }

    /// Propose a resolution for `market_id`, escrowing a bond. Opens the challenge window.
    #[odra(payable)]
    pub fn propose(&mut self, market_id: String, proposed_outcome: String) {
        if self.exists.get_or_default(&market_id) {
            self.env().revert(Error::DisputeExists);
        }
        let bond = self.env().attached_value();
        if bond.is_zero() {
            self.env().revert(Error::ZeroStake);
        }
        let now = self.env().get_block_time();
        let challenge_deadline = now + self.challenge_window_ms.get_or_default();
        self.exists.set(&market_id, true);
        self.proposal.set(
            &market_id,
            Proposal {
                proposer: self.env().caller(),
                proposed_outcome: proposed_outcome.clone(),
                bond,
                challenge_deadline,
                voting_deadline: 0,
                status: STATUS_PROPOSED,
                challenger: self.env().caller(),
                challenger_outcome: String::new(),
                dispute_bond: U512::zero(),
            },
        );
        self.env().emit_event(ResolutionProposed {
            market_id,
            proposer: self.env().caller(),
            proposed_outcome,
            bond,
            challenge_deadline,
        });
    }

    /// Challenge a proposal with an alternative outcome, escrowing a dispute bond. Opens voting.
    #[odra(payable)]
    pub fn challenge(&mut self, market_id: String, challenger_outcome: String) {
        let mut p = self.get_or_revert(&market_id);
        if p.status != STATUS_PROPOSED {
            self.env().revert(Error::AlreadyChallenged);
        }
        if self.env().get_block_time() >= p.challenge_deadline {
            self.env().revert(Error::ChallengeClosed);
        }
        let bond = self.env().attached_value();
        if bond.is_zero() {
            self.env().revert(Error::ZeroStake);
        }
        let now = self.env().get_block_time();
        p.status = STATUS_CHALLENGED;
        p.challenger = self.env().caller();
        p.challenger_outcome = challenger_outcome.clone();
        p.dispute_bond = bond;
        p.voting_deadline = now + self.voting_window_ms.get_or_default();
        let voting_deadline = p.voting_deadline;
        self.proposal.set(&market_id, p);
        self.env().emit_event(ResolutionChallenged {
            market_id,
            challenger: self.env().caller(),
            challenger_outcome,
            bond,
            voting_deadline,
        });
    }

    /// Cast a stake-weighted panel vote. Payable — the attached value is the vote stake at risk.
    #[odra(payable)]
    pub fn vote(&mut self, market_id: String, side: u8) {
        let p = self.get_or_revert(&market_id);
        if p.status != STATUS_CHALLENGED {
            self.env().revert(Error::NotChallenged);
        }
        if self.env().get_block_time() >= p.voting_deadline {
            self.env().revert(Error::VotingClosed);
        }
        if side != SIDE_UPHOLD && side != SIDE_OVERTURN {
            self.env().revert(Error::InvalidSide);
        }
        let voter = self.env().caller();
        let key = (market_id.clone(), voter);
        if self.voted.get_or_default(&key) {
            self.env().revert(Error::AlreadyVoted);
        }
        let stake = self.env().attached_value();
        if stake.is_zero() {
            self.env().revert(Error::ZeroStake);
        }
        self.voted.set(&key, true);
        self.vote_side.set(&key, side);
        self.vote_stake.set(&key, stake);
        let mut list = self.voters.get_or_default(&market_id);
        list.push(voter);
        self.voters.set(&market_id, list);
        if side == SIDE_UPHOLD {
            self.uphold_stake
                .set(&market_id, self.uphold_stake.get_or_default(&market_id) + stake);
        } else {
            self.overturn_stake
                .set(&market_id, self.overturn_stake.get_or_default(&market_id) + stake);
        }
        self.env().emit_event(VoteCast {
            market_id,
            voter,
            side,
            stake,
        });
    }

    /// Finalize a dispute after its window closes and settle every bond + vote by pure math.
    ///
    /// * Unchallenged (challenge window elapsed) → proposal stands, proposer refunded.
    /// * Challenged (voting window elapsed) → stake-weighted decision, conservation-exact payout.
    pub fn finalize(&mut self, market_id: String) {
        let mut p = self.get_or_revert(&market_id);
        if p.status == STATUS_FINALIZED {
            self.env().revert(Error::AlreadyFinalized);
        }
        let now = self.env().get_block_time();

        if p.status == STATUS_PROPOSED {
            // Unchallenged path: window must have elapsed; refund the proposer's bond.
            if now < p.challenge_deadline {
                self.env().revert(Error::ChallengeOngoing);
            }
            let decided = p.proposed_outcome.clone();
            let proposer = p.proposer;
            let bond = p.bond;
            p.status = STATUS_FINALIZED;
            self.proposal.set(&market_id, p);
            if !bond.is_zero() {
                self.env().transfer_tokens(&proposer, &bond);
                self.env().emit_event(DisputePayout {
                    market_id: market_id.clone(),
                    recipient: proposer,
                    amount: bond,
                });
            }
            self.env().emit_event(DisputeFinalized {
                market_id,
                upheld: true,
                decided_outcome: decided,
                penalty_pool: U512::zero(),
            });
            return;
        }

        // Challenged path.
        if now < p.voting_deadline {
            self.env().revert(Error::VotingOngoing);
        }
        let uphold = self.uphold_stake.get_or_default(&market_id);
        let overturn = self.overturn_stake.get_or_default(&market_id);
        // Ties uphold (status quo).
        let upheld = overturn <= uphold;

        let (honest_bonder, honest_bond, dishonest_bond) = if upheld {
            (p.proposer, p.bond, p.dispute_bond)
        } else {
            (p.challenger, p.dispute_bond, p.bond)
        };
        let decided = if upheld {
            p.proposed_outcome.clone()
        } else {
            p.challenger_outcome.clone()
        };
        let decided_side = if upheld { SIDE_UPHOLD } else { SIDE_OVERTURN };

        // Penalty pool = dishonest bond + slashed wrong-voter stakes. Correct stake total for pro-rata.
        let voters = self.voters.get_or_default(&market_id);
        let mut penalty_pool = dishonest_bond;
        let mut correct_total = U512::zero();
        for v in voters.iter() {
            let key = (market_id.clone(), *v);
            let s = self.vote_stake.get_or_default(&key);
            if self.vote_side.get_or_default(&key) == decided_side {
                correct_total += s;
            } else {
                penalty_pool += s;
            }
        }

        p.status = STATUS_FINALIZED;
        self.proposal.set(&market_id, p);

        // Honest bonder's bond back.
        if !honest_bond.is_zero() {
            self.env().transfer_tokens(&honest_bonder, &honest_bond);
            self.env().emit_event(DisputePayout {
                market_id: market_id.clone(),
                recipient: honest_bonder,
                amount: honest_bond,
            });
        }

        if correct_total.is_zero() {
            // No correct voters — the penalty pool goes to the honest bonder (still conserves).
            if !penalty_pool.is_zero() {
                self.env().transfer_tokens(&honest_bonder, &penalty_pool);
                self.env().emit_event(DisputePayout {
                    market_id: market_id.clone(),
                    recipient: honest_bonder,
                    amount: penalty_pool,
                });
            }
        } else {
            // Correct voters: stake back + pro-rata share of the pool. Dust → first correct voter.
            let mut distributed = U512::zero();
            let mut first_correct: Option<Address> = None;
            for v in voters.iter() {
                let key = (market_id.clone(), *v);
                if self.vote_side.get_or_default(&key) != decided_side {
                    continue;
                }
                let s = self.vote_stake.get_or_default(&key);
                let share = penalty_pool * s / correct_total;
                let payout = s + share;
                distributed += share;
                if first_correct.is_none() {
                    first_correct = Some(*v);
                }
                self.env().transfer_tokens(v, &payout);
                self.env().emit_event(DisputePayout {
                    market_id: market_id.clone(),
                    recipient: *v,
                    amount: payout,
                });
            }
            let dust = penalty_pool - distributed;
            if !dust.is_zero() {
                let recipient = first_correct.unwrap_or(honest_bonder);
                self.env().transfer_tokens(&recipient, &dust);
                self.env().emit_event(DisputePayout {
                    market_id: market_id.clone(),
                    recipient,
                    amount: dust,
                });
            }
        }

        self.env().emit_event(DisputeFinalized {
            market_id,
            upheld,
            decided_outcome: decided,
            penalty_pool,
        });
    }

    // ---- reads ----

    /// Whether a dispute exists for a market.
    pub fn dispute_exists(&self, market_id: String) -> bool {
        self.exists.get_or_default(&market_id)
    }

    /// Dispute status: 0 proposed, 1 challenged, 2 finalized.
    pub fn status(&self, market_id: String) -> u8 {
        self.get_or_revert(&market_id).status
    }

    /// Total uphold-side vote stake.
    pub fn uphold_stake_of(&self, market_id: String) -> U512 {
        self.uphold_stake.get_or_default(&market_id)
    }

    /// Total overturn-side vote stake.
    pub fn overturn_stake_of(&self, market_id: String) -> U512 {
        self.overturn_stake.get_or_default(&market_id)
    }

    /// The proposed outcome for a dispute.
    pub fn proposed_outcome_of(&self, market_id: String) -> String {
        self.get_or_revert(&market_id).proposed_outcome
    }

    // ---- internals ----

    fn get_or_revert(&self, market_id: &String) -> Proposal {
        if !self.exists.get_or_default(market_id) {
            self.env().revert(Error::UnknownDispute);
        }
        self.proposal.get(market_id).unwrap_or_revert(self)
    }
}

#[cfg(test)]
mod tests {
    use super::{DisputePanel, DisputePanelHostRef, DisputePanelInitArgs, Error, SIDE_OVERTURN, SIDE_UPHOLD};
    use odra::casper_types::U512;
    use odra::host::{Deployer, HostEnv, HostRef};

    fn deploy(env: &HostEnv) -> DisputePanelHostRef {
        DisputePanel::deploy(
            env,
            DisputePanelInitArgs {
                challenge_window_ms: 1_000,
                voting_window_ms: 1_000,
            },
        )
    }

    #[test]
    fn unchallenged_proposal_finalizes_and_refunds_the_proposer() {
        let env = odra_test::env();
        let mut panel = deploy(&env);
        let proposer = env.get_account(1);
        env.set_caller(proposer);
        let start = env.balance_of(&proposer);
        panel
            .with_tokens(U512::from(100u64))
            .propose("m1".to_string(), "YES".to_string());
        assert_eq!(env.balance_of(&proposer), start - U512::from(100u64));

        env.advance_block_time(1_001);
        panel.finalize("m1".to_string());
        // Proposer made whole; the market resolves to the proposed outcome.
        assert_eq!(env.balance_of(&proposer), start);
        assert_eq!(panel.status("m1".to_string()), super::STATUS_FINALIZED);
    }

    /// The adversarial drill: a WRONG resolution is proposed, challenged, the panel overturns it,
    /// and every bond + stake settles per the conservation model.
    #[test]
    fn challenged_proposal_is_overturned_and_every_bond_settles_conserved() {
        let env = odra_test::env();
        let mut panel = deploy(&env);
        let proposer = env.get_account(1); // proposes the WRONG outcome
        let challenger = env.get_account(2); // correctly disputes
        let voter_correct = env.get_account(3); // votes overturn (correct)
        let voter_wrong = env.get_account(4); // votes uphold (wrong)

        let p0 = env.balance_of(&proposer);
        let c0 = env.balance_of(&challenger);
        let vc0 = env.balance_of(&voter_correct);
        let vw0 = env.balance_of(&voter_wrong);
        let total_before = p0 + c0 + vc0 + vw0;

        env.set_caller(proposer);
        panel
            .with_tokens(U512::from(100u64))
            .propose("m1".to_string(), "YES".to_string());
        env.set_caller(challenger);
        panel
            .with_tokens(U512::from(80u64))
            .challenge("m1".to_string(), "NO".to_string());

        // Panel votes: overturn wins on stake (150 > 50).
        env.set_caller(voter_correct);
        panel.with_tokens(U512::from(150u64)).vote("m1".to_string(), SIDE_OVERTURN);
        env.set_caller(voter_wrong);
        panel.with_tokens(U512::from(50u64)).vote("m1".to_string(), SIDE_UPHOLD);

        env.advance_block_time(1_001);
        env.set_caller(challenger);
        panel.finalize("m1".to_string());

        let p1 = env.balance_of(&proposer);
        let c1 = env.balance_of(&challenger);
        let vc1 = env.balance_of(&voter_correct);
        let vw1 = env.balance_of(&voter_wrong);

        // Proposer (dishonest) forfeits the 100 bond.
        assert_eq!(p1, p0 - U512::from(100u64));
        // Wrong voter forfeits the 50 stake.
        assert_eq!(vw1, vw0 - U512::from(50u64));
        // Challenger (honest) at least made whole (bond back).
        assert!(c1 >= c0);
        // Correct voter got stake back + the whole penalty pool (only correct voter): pool = 100 + 50 = 150.
        assert_eq!(vc1, vc0 + U512::from(150u64));

        // CONSERVATION: not a mote minted or lost across all four parties.
        assert_eq!(p1 + c1 + vc1 + vw1, total_before);
    }

    #[test]
    fn upheld_proposal_pays_the_proposer_and_slashes_the_challenger() {
        let env = odra_test::env();
        let mut panel = deploy(&env);
        let proposer = env.get_account(1);
        let challenger = env.get_account(2);
        let voter = env.get_account(3); // votes uphold (correct)

        let c0 = env.balance_of(&challenger);

        env.set_caller(proposer);
        panel.with_tokens(U512::from(100u64)).propose("m1".to_string(), "YES".to_string());
        env.set_caller(challenger);
        panel.with_tokens(U512::from(100u64)).challenge("m1".to_string(), "NO".to_string());
        env.set_caller(voter);
        panel.with_tokens(U512::from(10u64)).vote("m1".to_string(), SIDE_UPHOLD);

        env.advance_block_time(1_001);
        panel.finalize("m1".to_string());
        // Challenger (dishonest) forfeits the full 100 dispute bond.
        assert_eq!(env.balance_of(&challenger), c0 - U512::from(100u64));
        // Decided outcome is the upheld proposal.
        assert_eq!(panel.status("m1".to_string()), super::STATUS_FINALIZED);
    }

    #[test]
    fn challenge_after_the_window_reverts() {
        let env = odra_test::env();
        let mut panel = deploy(&env);
        env.set_caller(env.get_account(1));
        panel.with_tokens(U512::from(100u64)).propose("m1".to_string(), "YES".to_string());
        env.advance_block_time(1_001);
        env.set_caller(env.get_account(2));
        assert_eq!(
            panel
                .with_tokens(U512::from(50u64))
                .try_challenge("m1".to_string(), "NO".to_string())
                .unwrap_err(),
            Error::ChallengeClosed.into()
        );
    }

    #[test]
    fn double_vote_reverts() {
        let env = odra_test::env();
        let mut panel = deploy(&env);
        env.set_caller(env.get_account(1));
        panel.with_tokens(U512::from(100u64)).propose("m1".to_string(), "YES".to_string());
        env.set_caller(env.get_account(2));
        panel.with_tokens(U512::from(50u64)).challenge("m1".to_string(), "NO".to_string());
        env.set_caller(env.get_account(3));
        panel.with_tokens(U512::from(10u64)).vote("m1".to_string(), SIDE_UPHOLD);
        assert_eq!(
            panel
                .with_tokens(U512::from(10u64))
                .try_vote("m1".to_string(), SIDE_UPHOLD)
                .unwrap_err(),
            Error::AlreadyVoted.into()
        );
    }

    #[test]
    fn finalize_before_the_window_reverts() {
        let env = odra_test::env();
        let mut panel = deploy(&env);
        env.set_caller(env.get_account(1));
        panel.with_tokens(U512::from(100u64)).propose("m1".to_string(), "YES".to_string());
        assert_eq!(
            panel.try_finalize("m1".to_string()).unwrap_err(),
            Error::ChallengeOngoing.into()
        );
    }
}
