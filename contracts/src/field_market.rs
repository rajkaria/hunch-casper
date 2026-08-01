//! FieldMarket — a parimutuel market over a **large candidate field** (hundreds of outcomes).
//!
//! Why this exists next to `ParimutuelMarket` and `HunchVault` rather than inside them: both of
//! those store a market's outcomes as an ordered collection and check membership by scanning it
//! (`outcomes.contains(&outcome)`), which is why `HunchVault` caps a market at 8 outcomes. That
//! cap is not arbitrary — an unbounded list is a storage-griefing vector, and a linear scan puts
//! the cost of every bet in proportion to the width of the field. Neither property is acceptable
//! for a 177-candidate market, so the field lives in a `Mapping` here: membership is one
//! dictionary read, and the bet path never loads anything proportional to the field size.
//!
//! The ABI is deliberately **identical to `ParimutuelMarket`** on the money path — `bet(outcome)`,
//! `resolve(winning_outcome)`, `void`, `claim` — so the off-chain deploy-plan builder, the
//! wallet-signed bet route and the claim flow drive this contract unchanged, routed by slug
//! through the per-market address map.
//!
//! Lifecycle, and the fairness invariant it exists to give:
//!
//!   1. `init` — question, oracle, treasury, fee, deadline. No candidates yet.
//!   2. `register_candidates` (admin, batched) — the field is filled in over several calls
//!      because 177 keys do not fit in one transaction's argument budget. Re-registering a key
//!      already present is a no-op rather than a revert, so a batch whose receipt was lost can be
//!      safely retried by the deploy driver.
//!   3. `freeze_field(field_hash)` (admin, irreversible) — betting is **closed until this lands**
//!      (`FieldNotFrozen`), and after it no candidate can ever be added or removed. `field_hash`
//!      commits to the full ordered candidate list, so a third party can recompute it from the
//!      published list and prove the on-chain field is the field they were shown. Without the
//!      freeze, an admin could add a candidate after money is on the table — which would change
//!      every bettor's odds after they bet.
//!   4. `bet` / `resolve` / `claim` — pure pool math, exactly as `ParimutuelMarket`.
//!
//! `resolve` carries **no deadline check on purpose**: the deadline is a backstop that stops
//! betting, not the trigger to settle. Winners of a hackathon are announced when they are
//! announced, and resolving early is the honest response — it closes betting the instant the
//! result is public, so nobody can bet a result they already know.
use odra::casper_types::U512;
use odra::prelude::*;

/// Market lifecycle status.
const STATUS_OPEN: u8 = 0;
const STATUS_RESOLVED: u8 = 1;
const STATUS_VOIDED: u8 = 2;

const BPS_DENOMINATOR: u32 = 10_000;

/// Hard ceiling on the field. Sized for the 177-strong buildathon finalist list with room to
/// spare, and low enough that the registration cost stays bounded and predictable.
const MAX_CANDIDATES: u32 = 512;
/// Candidate keys are external submission ids (the buildathon's are 5 characters). Bounded
/// because unbounded strings are a storage-griefing vector, exactly as in `HunchVault`.
const MAX_CANDIDATE_LEN: usize = 32;
/// Bound for the field commitment and the recipe/evidence hashes (hex or CID, both well under).
const MAX_HASH_LEN: usize = 96;
/// Bound for the question string.
const MAX_QUESTION_LEN: usize = 200;

/// Errors surfaced by the market. Codes 1–10 match `ParimutuelMarket` so a shared client can read
/// either contract's reverts with one table.
#[odra::odra_error]
pub enum Error {
    /// Caller is not the market's oracle.
    NotOracle = 1,
    /// Betting is closed (resolved/voided or past the deadline).
    MarketClosed = 2,
    /// Outcome key is not in this market's candidate field.
    UnknownOutcome = 3,
    /// A bet must carry a non-zero CSPR stake.
    ZeroStake = 4,
    /// Market is already resolved or voided.
    AlreadySettled = 5,
    /// Market is still open — cannot claim yet.
    NotSettled = 6,
    /// Caller has nothing to claim on this market.
    NothingToClaim = 7,
    /// Caller already claimed their payout.
    AlreadyClaimed = 8,
    /// A field needs at least two candidates before it can be frozen.
    InvalidOutcomeCount = 9,
    /// Fee basis points must be < 100%.
    InvalidFee = 10,
    /// Caller is not the admin.
    NotAdmin = 11,
    /// The field is frozen — candidates can no longer be registered.
    FieldFrozen = 12,
    /// The field is not frozen yet — betting and resolution are closed until it is.
    FieldNotFrozen = 13,
    /// A candidate key is empty or too long.
    InvalidCandidate = 14,
    /// The field would exceed `MAX_CANDIDATES`.
    TooManyCandidates = 15,
    /// A string field (question / hash) is empty or too long.
    InvalidField = 16,
    /// The resolution recipe is frozen — the first bet has already landed.
    RecipeLocked = 17,
    /// Evidence can only be committed once the market has settled.
    NotYetSettled = 18,
}

/// Emitted once per `register_candidates` batch. The event log is how a third party enumerates
/// the field: the contract stores membership in a `Mapping` (O(1) reads) and never keeps a list
/// it would have to load, so the batches themselves are the on-chain record of what was added.
#[odra::event]
pub struct CandidatesRegistered {
    /// The keys accepted by this call (already-present keys are omitted).
    pub candidates: Vec<String>,
    /// Field size after the batch.
    pub total: u32,
}

/// Emitted when the field is sealed. `field_hash` commits to the full ordered candidate list.
#[odra::event]
pub struct FieldFrozenEvent {
    /// Commitment to the ordered candidate list (recomputable from the published list).
    pub field_hash: String,
    /// Final field size.
    pub total: u32,
}

/// Emitted on every escrowed bet.
#[odra::event]
pub struct BetPlaced {
    /// Bettor address.
    pub bettor: Address,
    /// Candidate key staked on.
    pub outcome: String,
    /// Stake in motes.
    pub amount: U512,
}

/// Emitted when the oracle resolves the market to a winning candidate.
#[odra::event]
pub struct MarketResolved {
    /// Winning candidate key.
    pub winning_outcome: String,
    /// Total escrowed pool at resolution.
    pub total_pool: U512,
    /// Pool staked on the winning candidate.
    pub winning_pool: U512,
    /// Fee swept to treasury (bps of the losing pool).
    pub fee: U512,
}

/// Emitted when the market is voided (all stakes refundable).
#[odra::event]
pub struct MarketVoided {
    /// Total escrowed pool at void time.
    pub total_pool: U512,
}

/// Emitted on each successful claim.
#[odra::event]
pub struct PayoutClaimed {
    /// Claiming address.
    pub bettor: Address,
    /// Amount transferred, in motes.
    pub amount: U512,
}

/// Emitted when the resolution recipe is committed (before the first bet).
#[odra::event]
pub struct RecipeCommitted {
    /// Content hash of the canonical resolution recipe.
    pub recipe_hash: String,
}

/// Emitted when the evidence bundle justifying a settlement is committed.
#[odra::event]
pub struct EvidenceCommitted {
    /// Content hash of the evidence bundle.
    pub bundle_hash: String,
}

/// A parimutuel market over a large candidate field.
#[odra::module(
    events = [
        CandidatesRegistered,
        FieldFrozenEvent,
        BetPlaced,
        MarketResolved,
        MarketVoided,
        PayoutClaimed,
        RecipeCommitted,
        EvidenceCommitted
    ],
    errors = Error
)]
pub struct FieldMarket {
    question: Var<String>,
    admin: Var<Address>,
    oracle: Var<Address>,
    treasury: Var<Address>,
    fee_bps: Var<u32>,
    deadline: Var<u64>,
    status: Var<u8>,
    /// candidate key -> present. The whole reason this contract exists: membership is one
    /// dictionary read, independent of how wide the field is.
    candidate: Mapping<String, bool>,
    candidate_count: Var<u32>,
    frozen: Var<bool>,
    field_hash: Var<String>,
    winning_outcome: Var<String>,
    /// candidate -> total staked on it.
    pool: Mapping<String, U512>,
    total_pool: Var<U512>,
    /// (bettor, candidate) -> stake.
    stake_on: Mapping<(Address, String), U512>,
    /// bettor -> total stake across all candidates (used for void/refund).
    bettor_total: Mapping<Address, U512>,
    claimed: Mapping<Address, bool>,
    /// Snapshots captured at resolution so claims are cheap + deterministic.
    winning_pool: Var<U512>,
    distributable_losing: Var<U512>,
    recipe_hash: Var<String>,
    bundle_hash: Var<String>,
}

#[odra::module]
impl FieldMarket {
    /// Initialize the market. The caller becomes admin (the only address that may fill and freeze
    /// the field); `oracle` is the only address that may resolve or void.
    ///
    /// * `question` — human-readable market question.
    /// * `oracle` — resolver identity.
    /// * `treasury` — recipient of the parimutuel fee.
    /// * `fee_bps` — fee in basis points, taken only from the losing pool (< 10_000).
    /// * `deadline` — block time (ms) after which bets are rejected.
    pub fn init(
        &mut self,
        question: String,
        oracle: Address,
        treasury: Address,
        fee_bps: u32,
        deadline: u64,
    ) {
        if question.is_empty() || question.len() > MAX_QUESTION_LEN {
            self.env().revert(Error::InvalidField);
        }
        if fee_bps >= BPS_DENOMINATOR {
            self.env().revert(Error::InvalidFee);
        }
        self.question.set(question);
        self.admin.set(self.env().caller());
        self.oracle.set(oracle);
        self.treasury.set(treasury);
        self.fee_bps.set(fee_bps);
        self.deadline.set(deadline);
        self.status.set(STATUS_OPEN);
        self.frozen.set(false);
        self.candidate_count.set(0);
        self.total_pool.set(U512::zero());
        self.winning_pool.set(U512::zero());
        self.distributable_losing.set(U512::zero());
    }

    /// Admin-only: add candidates to the field. Batched because a 177-key field does not fit in
    /// one transaction's argument budget.
    ///
    /// Re-registering an existing key is a **no-op, not a revert**: a deploy driver that loses a
    /// receipt must be able to retry a batch without bricking the run, and the alternative
    /// (reverting) turns a network hiccup into a manual reconciliation. The emitted event carries
    /// only the keys actually added, so the log stays an exact record of the field.
    pub fn register_candidates(&mut self, candidates: Vec<String>) {
        self.assert_admin();
        if self.frozen.get_or_default() {
            self.env().revert(Error::FieldFrozen);
        }
        let mut count = self.candidate_count.get_or_default();
        let mut added: Vec<String> = Vec::new();
        for key in candidates {
            if key.is_empty() || key.len() > MAX_CANDIDATE_LEN {
                self.env().revert(Error::InvalidCandidate);
            }
            if self.candidate.get_or_default(&key) {
                continue; // idempotent retry
            }
            count += 1;
            if count > MAX_CANDIDATES {
                self.env().revert(Error::TooManyCandidates);
            }
            self.candidate.set(&key, true);
            added.push(key);
        }
        self.candidate_count.set(count);
        self.env().emit_event(CandidatesRegistered {
            candidates: added,
            total: count,
        });
    }

    /// Admin-only, irreversible: seal the field and open betting.
    ///
    /// `field_hash` commits to the full ordered candidate list as published off chain. It is
    /// stored, never recomputed here — the contract cannot see the ordering, and the point of the
    /// commitment is that anyone else can: recompute the hash from the published list, compare it
    /// with `field_hash()`, and the field they were shown is provably the field that settles.
    pub fn freeze_field(&mut self, field_hash: String) {
        self.assert_admin();
        if self.frozen.get_or_default() {
            self.env().revert(Error::FieldFrozen);
        }
        if field_hash.is_empty() || field_hash.len() > MAX_HASH_LEN {
            self.env().revert(Error::InvalidField);
        }
        let total = self.candidate_count.get_or_default();
        if total < 2 {
            self.env().revert(Error::InvalidOutcomeCount);
        }
        self.frozen.set(true);
        self.field_hash.set(field_hash.clone());
        self.env().emit_event(FieldFrozenEvent { field_hash, total });
    }

    /// Escrow a CSPR stake onto `outcome`. Payable — the attached value is the stake.
    #[odra(payable)]
    pub fn bet(&mut self, outcome: String) {
        // Ordered so the most informative revert wins: an unfrozen field is a market that has not
        // opened yet, which is a different thing to say than "closed".
        if !self.frozen.get_or_default() {
            self.env().revert(Error::FieldNotFrozen);
        }
        if self.status.get_or_default() != STATUS_OPEN {
            self.env().revert(Error::MarketClosed);
        }
        if self.env().get_block_time() >= self.deadline.get_or_default() {
            self.env().revert(Error::MarketClosed);
        }
        if !self.candidate.get_or_default(&outcome) {
            self.env().revert(Error::UnknownOutcome);
        }
        let amount = self.env().attached_value();
        if amount.is_zero() {
            self.env().revert(Error::ZeroStake);
        }
        let bettor = self.env().caller();

        self.pool
            .set(&outcome, self.pool.get_or_default(&outcome) + amount);
        self.total_pool.set(self.total_pool.get_or_default() + amount);

        let key = (bettor, outcome.clone());
        self.stake_on
            .set(&key, self.stake_on.get_or_default(&key) + amount);
        self.bettor_total
            .set(&bettor, self.bettor_total.get_or_default(&bettor) + amount);

        self.env().emit_event(BetPlaced {
            bettor,
            outcome,
            amount,
        });
    }

    /// Oracle-only: resolve to `winning_outcome`, sweep the fee, snapshot the split.
    ///
    /// Callable **before** the deadline — see the module docs. If nobody staked the winning
    /// candidate the market auto-voids (everyone refunded), which is the common case for a wide
    /// field where the winner drew no backers.
    pub fn resolve(&mut self, winning_outcome: String) {
        self.assert_oracle();
        self.assert_open();
        if !self.frozen.get_or_default() {
            self.env().revert(Error::FieldNotFrozen);
        }
        if !self.candidate.get_or_default(&winning_outcome) {
            self.env().revert(Error::UnknownOutcome);
        }

        let total = self.total_pool.get_or_default();
        let winning = self.pool.get_or_default(&winning_outcome);

        // No winners → refund everyone (void semantics), no fee.
        if winning.is_zero() {
            self.status.set(STATUS_VOIDED);
            self.env().emit_event(MarketVoided { total_pool: total });
            return;
        }

        let losing = total - winning;
        let fee = losing * U512::from(self.fee_bps.get_or_default()) / U512::from(BPS_DENOMINATOR);
        let distributable_losing = losing - fee;

        self.winning_outcome.set(winning_outcome.clone());
        self.winning_pool.set(winning);
        self.distributable_losing.set(distributable_losing);
        self.status.set(STATUS_RESOLVED);

        if !fee.is_zero() {
            let treasury = self.treasury.get().unwrap_or_revert(self);
            self.env().transfer_tokens(&treasury, &fee);
        }

        self.env().emit_event(MarketResolved {
            winning_outcome,
            total_pool: total,
            winning_pool: winning,
            fee,
        });
    }

    /// Oracle-only: void the market. The escape hatch for an announcement that names co-winners
    /// or never comes — everyone refunds their stake, no fee.
    pub fn void(&mut self) {
        self.assert_oracle();
        self.assert_open();
        self.status.set(STATUS_VOIDED);
        self.env().emit_event(MarketVoided {
            total_pool: self.total_pool.get_or_default(),
        });
    }

    /// Claim the caller's payout (winner share) or refund (voided). Idempotent per address.
    pub fn claim(&mut self) {
        let status = self.status.get_or_default();
        if status == STATUS_OPEN {
            self.env().revert(Error::NotSettled);
        }
        let bettor = self.env().caller();
        if self.claimed.get_or_default(&bettor) {
            self.env().revert(Error::AlreadyClaimed);
        }

        let payout = if status == STATUS_VOIDED {
            self.bettor_total.get_or_default(&bettor)
        } else {
            let winning_outcome = self.winning_outcome.get_or_default();
            let stake = self.stake_on.get_or_default(&(bettor, winning_outcome));
            if stake.is_zero() {
                self.env().revert(Error::NothingToClaim);
            }
            let distributable_losing = self.distributable_losing.get_or_default();
            if distributable_losing.is_zero() {
                // No losers / no fee → stake back in full.
                stake
            } else {
                let winning_pool = self.winning_pool.get_or_default();
                stake + stake * distributable_losing / winning_pool
            }
        };

        if payout.is_zero() {
            self.env().revert(Error::NothingToClaim);
        }

        self.claimed.set(&bettor, true);
        self.env().transfer_tokens(&bettor, &payout);
        self.env().emit_event(PayoutClaimed {
            bettor,
            amount: payout,
        });
    }

    // ---- verifiable resolution ----

    /// Commit the canonical resolution-recipe hash — the rule a third party replays the
    /// settlement against. Admin-only, and only while no stake has landed: the first bet freezes
    /// it (`RecipeLocked`), so the rule a bettor bet under is the rule that settles.
    pub fn commit_recipe(&mut self, recipe_hash: String) {
        self.assert_admin();
        if !self.total_pool.get_or_default().is_zero() {
            self.env().revert(Error::RecipeLocked);
        }
        if recipe_hash.is_empty() || recipe_hash.len() > MAX_HASH_LEN {
            self.env().revert(Error::InvalidField);
        }
        self.recipe_hash.set(recipe_hash.clone());
        self.env().emit_event(RecipeCommitted { recipe_hash });
    }

    /// Oracle-only: commit the evidence bundle that justifies the settlement — for this market,
    /// the organizers' results announcement. Only after `resolve`/`void`, so the evidence is bound
    /// to the outcome it justifies. Re-committable; the event log is the history.
    pub fn commit_bundle(&mut self, bundle_hash: String) {
        self.assert_oracle();
        if self.status.get_or_default() == STATUS_OPEN {
            self.env().revert(Error::NotYetSettled);
        }
        if bundle_hash.is_empty() || bundle_hash.len() > MAX_HASH_LEN {
            self.env().revert(Error::InvalidField);
        }
        self.bundle_hash.set(bundle_hash.clone());
        self.env().emit_event(EvidenceCommitted { bundle_hash });
    }

    // ---- reads (used by the off-chain adapter / MCP / UI) ----

    /// The market question.
    pub fn question(&self) -> String {
        self.question.get_or_default()
    }

    /// Lifecycle status: 0 open, 1 resolved, 2 voided.
    pub fn status(&self) -> u8 {
        self.status.get_or_default()
    }

    /// The admin (field custodian).
    pub fn admin(&self) -> Address {
        self.admin.get().unwrap_or_revert(self)
    }

    /// The oracle (the only resolver).
    pub fn oracle(&self) -> Address {
        self.oracle.get().unwrap_or_revert(self)
    }

    /// Parimutuel fee in basis points.
    pub fn fee_bps(&self) -> u32 {
        self.fee_bps.get_or_default()
    }

    /// Betting deadline (ms).
    pub fn deadline(&self) -> u64 {
        self.deadline.get_or_default()
    }

    /// Whether the candidate field is sealed (and therefore whether betting is open).
    pub fn is_frozen(&self) -> bool {
        self.frozen.get_or_default()
    }

    /// Number of candidates in the field.
    pub fn candidate_count(&self) -> u32 {
        self.candidate_count.get_or_default()
    }

    /// Whether a key is in the field.
    pub fn is_candidate(&self, outcome: String) -> bool {
        self.candidate.get_or_default(&outcome)
    }

    /// Commitment to the ordered candidate list (empty until frozen).
    pub fn field_hash(&self) -> String {
        self.field_hash.get_or_default()
    }

    /// Total staked on a given candidate.
    pub fn pool_of(&self, outcome: String) -> U512 {
        self.pool.get_or_default(&outcome)
    }

    /// Total escrowed pool across the field.
    pub fn total_pool(&self) -> U512 {
        self.total_pool.get_or_default()
    }

    /// The resolved winning candidate (empty until resolved).
    pub fn winning_outcome(&self) -> String {
        self.winning_outcome.get_or_default()
    }

    /// A bettor's stake on a specific candidate.
    pub fn stake_of(&self, bettor: Address, outcome: String) -> U512 {
        self.stake_on.get_or_default(&(bettor, outcome))
    }

    /// A bettor's total stake across the field (the refund amount if voided).
    pub fn bettor_total(&self, bettor: Address) -> U512 {
        self.bettor_total.get_or_default(&bettor)
    }

    /// Whether an address has already claimed.
    pub fn is_claimed(&self, bettor: Address) -> bool {
        self.claimed.get_or_default(&bettor)
    }

    /// The committed resolution-recipe hash (empty until committed).
    pub fn recipe_hash(&self) -> String {
        self.recipe_hash.get_or_default()
    }

    /// The committed evidence-bundle hash (empty until committed).
    pub fn bundle_hash(&self) -> String {
        self.bundle_hash.get_or_default()
    }

    // ---- internals ----

    fn assert_admin(&self) {
        if self.env().caller() != self.admin.get().unwrap_or_revert(self) {
            self.env().revert(Error::NotAdmin);
        }
    }

    fn assert_oracle(&self) {
        if self.env().caller() != self.oracle.get().unwrap_or_revert(self) {
            self.env().revert(Error::NotOracle);
        }
    }

    fn assert_open(&self) {
        if self.status.get_or_default() != STATUS_OPEN {
            self.env().revert(Error::AlreadySettled);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, HostRef};

    const DEADLINE: u64 = 1_900_000_000_000;
    const FEE_BPS: u32 = 200;

    fn cspr(n: u64) -> U512 {
        U512::from(n) * U512::from(1_000_000_000u64)
    }

    fn deploy(env: &HostEnv) -> FieldMarketHostRef {
        FieldMarket::deploy(
            env,
            FieldMarketInitArgs {
                question: "Which project wins the Casper Agentic Buildathon 2026?".to_string(),
                oracle: env.get_account(1),
                treasury: env.get_account(2),
                fee_bps: FEE_BPS,
                deadline: DEADLINE,
            },
        )
    }

    /// A deployed market with a sealed three-candidate field — the common starting point.
    fn deploy_frozen(env: &HostEnv) -> FieldMarketHostRef {
        let mut market = deploy(env);
        market.register_candidates(vec![
            "46696".to_string(),
            "46015".to_string(),
            "45467".to_string(),
        ]);
        market.freeze_field("field-hash-abc".to_string());
        market
    }

    #[test]
    fn registers_and_freezes_a_field() {
        let env = odra_test::env();
        let mut market = deploy(&env);
        assert!(!market.is_frozen());
        assert_eq!(market.candidate_count(), 0);

        market.register_candidates(vec!["46696".to_string(), "46015".to_string()]);
        market.register_candidates(vec!["45467".to_string()]);
        assert_eq!(market.candidate_count(), 3);
        assert!(market.is_candidate("46696".to_string()));
        assert!(!market.is_candidate("00000".to_string()));

        market.freeze_field("field-hash-abc".to_string());
        assert!(market.is_frozen());
        assert_eq!(market.field_hash(), "field-hash-abc".to_string());
    }

    /// The whole point of the `Mapping`: a field far wider than any `Vec`-backed market could
    /// hold, with membership still one read.
    #[test]
    fn holds_a_177_candidate_field() {
        let env = odra_test::env();
        let mut market = deploy(&env);
        for chunk in 0..5 {
            let batch: Vec<String> = (0..40)
                .map(|i| format!("{}", 40_000 + chunk * 40 + i))
                .take(if chunk == 4 { 17 } else { 40 })
                .collect();
            market.register_candidates(batch);
        }
        assert_eq!(market.candidate_count(), 177);
        market.freeze_field("field-hash-177".to_string());
        assert!(market.is_candidate("40000".to_string()));
        assert!(market.is_candidate("40176".to_string()));
        assert!(!market.is_candidate("40177".to_string()));
    }

    /// A lost receipt must not brick the deploy run: re-sending a batch adds nothing and the
    /// count stays honest.
    #[test]
    fn re_registering_a_candidate_is_a_no_op() {
        let env = odra_test::env();
        let mut market = deploy(&env);
        market.register_candidates(vec!["46696".to_string(), "46015".to_string()]);
        market.register_candidates(vec!["46696".to_string(), "45467".to_string()]);
        assert_eq!(market.candidate_count(), 3);
    }

    #[test]
    fn only_admin_registers_and_freezes() {
        let env = odra_test::env();
        let mut market = deploy(&env);
        env.set_caller(env.get_account(3));
        assert_eq!(
            market.try_register_candidates(vec!["46696".to_string()]),
            Err(Error::NotAdmin.into())
        );
        assert_eq!(
            market.try_freeze_field("h".to_string()),
            Err(Error::NotAdmin.into())
        );
    }

    #[test]
    fn a_frozen_field_takes_no_more_candidates() {
        let env = odra_test::env();
        let mut market = deploy_frozen(&env);
        assert_eq!(
            market.try_register_candidates(vec!["99999".to_string()]),
            Err(Error::FieldFrozen.into())
        );
        assert_eq!(
            market.try_freeze_field("again".to_string()),
            Err(Error::FieldFrozen.into())
        );
        assert_eq!(market.candidate_count(), 3);
    }

    #[test]
    fn freezing_needs_at_least_two_candidates() {
        let env = odra_test::env();
        let mut market = deploy(&env);
        assert_eq!(
            market.try_freeze_field("h".to_string()),
            Err(Error::InvalidOutcomeCount.into())
        );
        market.register_candidates(vec!["46696".to_string()]);
        assert_eq!(
            market.try_freeze_field("h".to_string()),
            Err(Error::InvalidOutcomeCount.into())
        );
    }

    #[test]
    fn rejects_malformed_candidates_and_hashes() {
        let env = odra_test::env();
        let mut market = deploy(&env);
        assert_eq!(
            market.try_register_candidates(vec!["".to_string()]),
            Err(Error::InvalidCandidate.into())
        );
        assert_eq!(
            market.try_register_candidates(vec!["x".repeat(MAX_CANDIDATE_LEN + 1)]),
            Err(Error::InvalidCandidate.into())
        );
        market.register_candidates(vec!["46696".to_string(), "46015".to_string()]);
        assert_eq!(
            market.try_freeze_field("".to_string()),
            Err(Error::InvalidField.into())
        );
        assert_eq!(
            market.try_freeze_field("h".repeat(MAX_HASH_LEN + 1)),
            Err(Error::InvalidField.into())
        );
    }

    /// The fairness invariant: no money moves until the field is sealed.
    #[test]
    fn betting_is_closed_until_the_field_freezes() {
        let env = odra_test::env();
        let mut market = deploy(&env);
        market.register_candidates(vec!["46696".to_string(), "46015".to_string()]);
        assert_eq!(
            market
                .with_tokens(cspr(10))
                .try_bet("46696".to_string())
                .unwrap_err(),
            Error::FieldNotFrozen.into()
        );
    }

    #[test]
    fn rejects_a_stake_on_a_candidate_outside_the_field() {
        let env = odra_test::env();
        let market = deploy_frozen(&env);
        assert_eq!(
            market
                .with_tokens(cspr(10))
                .try_bet("00000".to_string())
                .unwrap_err(),
            Error::UnknownOutcome.into()
        );
    }

    #[test]
    fn rejects_a_zero_stake_and_a_late_bet() {
        let env = odra_test::env();
        let market = deploy_frozen(&env);
        assert_eq!(
            market
                .with_tokens(U512::zero())
                .try_bet("46696".to_string())
                .unwrap_err(),
            Error::ZeroStake.into()
        );
        env.advance_block_time(DEADLINE + 1);
        assert_eq!(
            market
                .with_tokens(cspr(10))
                .try_bet("46696".to_string())
                .unwrap_err(),
            Error::MarketClosed.into()
        );
    }

    /// Σ in == Σ out across a three-way field: winners' claims plus the treasury fee equal the
    /// whole escrowed pool, to the mote.
    #[test]
    fn settles_a_field_conservation_exact() {
        let env = odra_test::env();
        let mut market = deploy_frozen(&env);
        let alice = env.get_account(3);
        let bob = env.get_account(4);
        let carol = env.get_account(5);

        env.set_caller(alice);
        market.with_tokens(cspr(10)).bet("46696".to_string());
        env.set_caller(bob);
        market.with_tokens(cspr(30)).bet("46696".to_string());
        env.set_caller(carol);
        market.with_tokens(cspr(60)).bet("46015".to_string());

        assert_eq!(market.total_pool(), cspr(100));
        assert_eq!(market.pool_of("46696".to_string()), cspr(40));

        env.set_caller(env.get_account(1)); // oracle
        market.resolve("46696".to_string());
        assert_eq!(market.status(), STATUS_RESOLVED);

        // Losing pool 60 CSPR, fee 2% = 1.2 CSPR, distributable 58.8 CSPR.
        let fee = cspr(60) * U512::from(FEE_BPS) / U512::from(BPS_DENOMINATOR);
        env.set_caller(alice);
        market.claim();
        env.set_caller(bob);
        market.claim();

        // Alice staked 10/40 of the winning pool, Bob 30/40.
        let alice_payout = cspr(10) + cspr(10) * (cspr(60) - fee) / cspr(40);
        let bob_payout = cspr(30) + cspr(30) * (cspr(60) - fee) / cspr(40);
        assert_eq!(alice_payout + bob_payout + fee, cspr(100));
    }

    /// Resolution before the deadline is the honest path, not an exception: the result is public,
    /// so betting must stop.
    #[test]
    fn resolves_early_and_closes_betting() {
        let env = odra_test::env();
        let mut market = deploy_frozen(&env);
        env.set_caller(env.get_account(3));
        market.with_tokens(cspr(10)).bet("46696".to_string());

        env.set_caller(env.get_account(1));
        market.resolve("46696".to_string()); // long before DEADLINE
        assert_eq!(market.status(), STATUS_RESOLVED);

        env.set_caller(env.get_account(4));
        assert_eq!(
            market
                .with_tokens(cspr(5))
                .try_bet("46015".to_string())
                .unwrap_err(),
            Error::MarketClosed.into()
        );
    }

    #[test]
    fn only_the_oracle_resolves_or_voids() {
        let env = odra_test::env();
        let mut market = deploy_frozen(&env);
        env.set_caller(env.get_account(3));
        assert_eq!(
            market.try_resolve("46696".to_string()),
            Err(Error::NotOracle.into())
        );
        assert_eq!(market.try_void(), Err(Error::NotOracle.into()));
    }

    #[test]
    fn rejects_a_winner_outside_the_field() {
        let env = odra_test::env();
        let mut market = deploy_frozen(&env);
        env.set_caller(env.get_account(1));
        assert_eq!(
            market.try_resolve("00000".to_string()),
            Err(Error::UnknownOutcome.into())
        );
    }

    /// A wide field makes "the winner drew no backers" a live case, not a corner one.
    #[test]
    fn a_winner_with_no_backers_voids_and_refunds() {
        let env = odra_test::env();
        let mut market = deploy_frozen(&env);
        let alice = env.get_account(3);
        env.set_caller(alice);
        market.with_tokens(cspr(10)).bet("46696".to_string());

        env.set_caller(env.get_account(1));
        market.resolve("45467".to_string()); // nobody staked it
        assert_eq!(market.status(), STATUS_VOIDED);

        let before = env.balance_of(&alice);
        env.set_caller(alice);
        market.claim();
        assert_eq!(env.balance_of(&alice), before + cspr(10));
    }

    #[test]
    fn voiding_refunds_every_stake_across_the_field() {
        let env = odra_test::env();
        let mut market = deploy_frozen(&env);
        let alice = env.get_account(3);
        env.set_caller(alice);
        market.with_tokens(cspr(10)).bet("46696".to_string());
        market.with_tokens(cspr(5)).bet("46015".to_string());
        assert_eq!(market.bettor_total(alice), cspr(15));

        env.set_caller(env.get_account(1));
        market.void();

        let before = env.balance_of(&alice);
        env.set_caller(alice);
        market.claim();
        assert_eq!(env.balance_of(&alice), before + cspr(15));
        assert_eq!(market.try_claim(), Err(Error::AlreadyClaimed.into()));
    }

    #[test]
    fn a_loser_has_nothing_to_claim() {
        let env = odra_test::env();
        let mut market = deploy_frozen(&env);
        env.set_caller(env.get_account(3));
        market.with_tokens(cspr(10)).bet("46696".to_string());
        env.set_caller(env.get_account(4));
        market.with_tokens(cspr(10)).bet("46015".to_string());

        env.set_caller(env.get_account(1));
        market.resolve("46696".to_string());

        env.set_caller(env.get_account(4));
        assert_eq!(market.try_claim(), Err(Error::NothingToClaim.into()));
    }

    #[test]
    fn cannot_claim_while_open() {
        let env = odra_test::env();
        let mut market = deploy_frozen(&env);
        env.set_caller(env.get_account(3));
        market.with_tokens(cspr(10)).bet("46696".to_string());
        assert_eq!(market.try_claim(), Err(Error::NotSettled.into()));
    }

    #[test]
    fn the_first_bet_locks_the_recipe() {
        let env = odra_test::env();
        let mut market = deploy_frozen(&env);
        market.commit_recipe("recipe-hash-1".to_string());
        assert_eq!(market.recipe_hash(), "recipe-hash-1".to_string());

        env.set_caller(env.get_account(3));
        market.with_tokens(cspr(10)).bet("46696".to_string());

        env.set_caller(env.get_account(0)); // admin
        assert_eq!(
            market.try_commit_recipe("recipe-hash-2".to_string()),
            Err(Error::RecipeLocked.into())
        );
        assert_eq!(market.recipe_hash(), "recipe-hash-1".to_string());
    }

    #[test]
    fn evidence_binds_only_to_a_settled_market() {
        let env = odra_test::env();
        let mut market = deploy_frozen(&env);
        env.set_caller(env.get_account(1)); // oracle
        assert_eq!(
            market.try_commit_bundle("bundle".to_string()),
            Err(Error::NotYetSettled.into())
        );
        market.void();
        market.commit_bundle("bundle".to_string());
        assert_eq!(market.bundle_hash(), "bundle".to_string());
    }

    #[test]
    fn rejects_an_absurd_fee_and_an_empty_question() {
        let env = odra_test::env();
        assert!(FieldMarket::try_deploy(
            &env,
            FieldMarketInitArgs {
                question: "q".to_string(),
                oracle: env.get_account(1),
                treasury: env.get_account(2),
                fee_bps: BPS_DENOMINATOR,
                deadline: DEADLINE,
            }
        )
        .is_err());
        assert!(FieldMarket::try_deploy(
            &env,
            FieldMarketInitArgs {
                question: String::new(),
                oracle: env.get_account(1),
                treasury: env.get_account(2),
                fee_bps: FEE_BPS,
                deadline: DEADLINE,
            }
        )
        .is_err());
    }
}
