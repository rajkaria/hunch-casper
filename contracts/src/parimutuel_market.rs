//! ParimutuelMarket — the on-chain escrow + settlement vault for a single Hunch market.
//!
//! Design (ported *in spirit* from Hunch's `computeMarketPayouts`, re-implemented
//! original for the Casper Buildathon):
//!
//! * Bettors escrow native CSPR onto an outcome via a `#[odra(payable)]` `bet`.
//! * The oracle (and only the oracle) `resolve`s to a winning outcome — or `void`s.
//! * Payouts are **pure, deterministic pool math** — the contract, never an LLM, is the
//!   payout authority. Winners `claim` (pull pattern → no unbounded iteration on-chain).
//! * A parimutuel fee (bps) is taken **only from the losing pool** and swept to treasury
//!   on resolution; winners split the remainder pro-rata to their winning stake.
//! * Degenerate rounds refund in full, no fee:
//!     - single participant / everyone on the winning side (`losing == 0`) → stake back,
//!     - nobody on the winning side (`winning == 0`) → auto-void, everyone refunded,
//!     - explicit `void` (flat / undecidable round) → everyone refunded.
use odra::casper_types::U512;
use odra::prelude::*;

/// Market lifecycle status.
const STATUS_OPEN: u8 = 0;
const STATUS_RESOLVED: u8 = 1;
const STATUS_VOIDED: u8 = 2;

const BPS_DENOMINATOR: u32 = 10_000;

/// Errors surfaced by the market.
#[odra::odra_error]
pub enum Error {
    /// Caller is not the market's oracle.
    NotOracle = 1,
    /// Betting is closed (resolved/voided or past the deadline).
    MarketClosed = 2,
    /// Outcome key is not one of this market's outcomes.
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
    /// A market needs at least two outcomes.
    InvalidOutcomeCount = 9,
    /// Fee basis points must be < 100%.
    InvalidFee = 10,
}

/// Emitted on every escrowed bet.
#[odra::event]
pub struct BetPlaced {
    /// Bettor address.
    pub bettor: Address,
    /// Outcome key staked on.
    pub outcome: String,
    /// Stake in motes.
    pub amount: U512,
}

/// Emitted when the oracle resolves the market to a winning outcome.
#[odra::event]
pub struct MarketResolved {
    /// Winning outcome key.
    pub winning_outcome: String,
    /// Total escrowed pool at resolution.
    pub total_pool: U512,
    /// Pool staked on the winning outcome.
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

/// A single-market parimutuel vault.
#[odra::module(
    events = [BetPlaced, MarketResolved, MarketVoided, PayoutClaimed],
    errors = Error
)]
pub struct ParimutuelMarket {
    question: Var<String>,
    oracle: Var<Address>,
    treasury: Var<Address>,
    fee_bps: Var<u32>,
    deadline: Var<u64>,
    status: Var<u8>,
    outcomes: List<String>,
    winning_outcome: Var<String>,
    /// outcome -> total staked on it.
    pool: Mapping<String, U512>,
    total_pool: Var<U512>,
    /// (bettor, outcome) -> stake.
    stake_on: Mapping<(Address, String), U512>,
    /// bettor -> total stake across all outcomes (used for void/refund).
    bettor_total: Mapping<Address, U512>,
    claimed: Mapping<Address, bool>,
    /// Snapshots captured at resolution so claims are cheap + deterministic.
    winning_pool: Var<U512>,
    distributable_losing: Var<U512>,
}

#[odra::module]
impl ParimutuelMarket {
    /// Initialize a market.
    ///
    /// * `question` — human-readable market question.
    /// * `oracle` — the only address allowed to resolve/void.
    /// * `treasury` — recipient of the parimutuel fee.
    /// * `fee_bps` — fee in basis points, taken only from the losing pool (< 10_000).
    /// * `deadline` — block time (ms) after which bets are rejected.
    /// * `outcomes` — ordered outcome keys (≥ 2), e.g. `["YES","NO"]` or `["HEADS","TAILS","TIE"]`.
    pub fn init(
        &mut self,
        question: String,
        oracle: Address,
        treasury: Address,
        fee_bps: u32,
        deadline: u64,
        outcomes: Vec<String>,
    ) {
        if outcomes.len() < 2 {
            self.env().revert(Error::InvalidOutcomeCount);
        }
        if fee_bps >= BPS_DENOMINATOR {
            self.env().revert(Error::InvalidFee);
        }
        self.question.set(question);
        self.oracle.set(oracle);
        self.treasury.set(treasury);
        self.fee_bps.set(fee_bps);
        self.deadline.set(deadline);
        self.status.set(STATUS_OPEN);
        for outcome in outcomes {
            self.outcomes.push(outcome);
        }
        self.total_pool.set(U512::zero());
        self.winning_pool.set(U512::zero());
        self.distributable_losing.set(U512::zero());
    }

    /// Escrow a CSPR stake onto `outcome`. Payable — the attached value is the stake.
    #[odra(payable)]
    pub fn bet(&mut self, outcome: String) {
        if self.status.get_or_default() != STATUS_OPEN {
            self.env().revert(Error::MarketClosed);
        }
        if self.env().get_block_time() >= self.deadline.get_or_default() {
            self.env().revert(Error::MarketClosed);
        }
        if !self.is_known_outcome(&outcome) {
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
    /// If nobody staked the winning outcome, the market auto-voids (everyone refunded).
    pub fn resolve(&mut self, winning_outcome: String) {
        self.assert_oracle();
        self.assert_open();
        if !self.is_known_outcome(&winning_outcome) {
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

    /// Oracle-only: void the market (flat / undecidable round). Everyone refunds their stake.
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
            let stake = self
                .stake_on
                .get_or_default(&(bettor, winning_outcome));
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

    // ---- reads (used by the off-chain adapter / MCP / UI) ----

    /// The market question.
    pub fn question(&self) -> String {
        self.question.get_or_default()
    }

    /// Lifecycle status: 0 open, 1 resolved, 2 voided.
    pub fn status(&self) -> u8 {
        self.status.get_or_default()
    }

    /// Ordered outcome keys.
    pub fn outcomes(&self) -> Vec<String> {
        self.outcomes.iter().collect()
    }

    /// Total staked on a given outcome.
    pub fn pool_of(&self, outcome: String) -> U512 {
        self.pool.get_or_default(&outcome)
    }

    /// Total escrowed pool across all outcomes.
    pub fn total_pool(&self) -> U512 {
        self.total_pool.get_or_default()
    }

    /// The resolved winning outcome (empty until resolved).
    pub fn winning_outcome(&self) -> String {
        self.winning_outcome.get_or_default()
    }

    /// A bettor's stake on a specific outcome.
    pub fn stake_of(&self, bettor: Address, outcome: String) -> U512 {
        self.stake_on.get_or_default(&(bettor, outcome))
    }

    /// Whether an address has already claimed.
    pub fn is_claimed(&self, bettor: Address) -> bool {
        self.claimed.get_or_default(&bettor)
    }

    // ---- internals ----

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

    fn is_known_outcome(&self, outcome: &String) -> bool {
        for known in self.outcomes.iter() {
            if &known == outcome {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Error, MarketResolved, ParimutuelMarket, ParimutuelMarketHostRef,
        ParimutuelMarketInitArgs, PayoutClaimed, STATUS_RESOLVED, STATUS_VOIDED,
    };
    use odra::casper_types::U512;
    use odra::host::{Deployer, HostEnv, HostRef};
    use odra::prelude::*;

    fn yes_no() -> Vec<String> {
        vec!["YES".to_string(), "NO".to_string()]
    }

    /// Deploy a market with `account(0)` as oracle and `account(3)` as treasury.
    fn deploy(env: &HostEnv, fee_bps: u32) -> ParimutuelMarketHostRef {
        env.set_caller(env.get_account(0));
        ParimutuelMarket::deploy(
            env,
            ParimutuelMarketInitArgs {
                question: "Will YES happen?".to_string(),
                oracle: env.get_account(0),
                treasury: env.get_account(3),
                fee_bps,
                deadline: 1_000_000,
                outcomes: yes_no(),
            },
        )
    }

    #[test]
    fn two_sided_resolve_pays_winners_and_sweeps_fee() {
        let env = odra_test::env();
        let mut market = deploy(&env, 200); // 2%
        let alice = env.get_account(1);
        let bob = env.get_account(2);
        let treasury = env.get_account(3);
        let alice_start = env.balance_of(&alice);
        let treasury_start = env.balance_of(&treasury);

        env.set_caller(alice);
        market.with_tokens(U512::from(100u64)).bet("YES".to_string());
        assert_eq!(env.balance_of(&alice), alice_start - U512::from(100u64));

        env.set_caller(bob);
        market.with_tokens(U512::from(300u64)).bet("NO".to_string());

        assert_eq!(market.total_pool(), U512::from(400u64));
        assert_eq!(market.pool_of("YES".to_string()), U512::from(100u64));

        // Oracle resolves YES. losing=300, fee=6, distributable=294.
        env.set_caller(env.get_account(0));
        market.resolve("YES".to_string());
        assert_eq!(market.status(), STATUS_RESOLVED);
        assert_eq!(market.winning_outcome(), "YES".to_string());
        assert_eq!(
            env.balance_of(&treasury),
            treasury_start + U512::from(6u64)
        );
        assert!(env.emitted_event(
            &market,
            MarketResolved {
                winning_outcome: "YES".to_string(),
                total_pool: U512::from(400u64),
                winning_pool: U512::from(100u64),
                fee: U512::from(6u64),
            }
        ));

        // Alice claims 100 + 294 = 394 → net +294.
        env.set_caller(alice);
        market.claim();
        assert_eq!(env.balance_of(&alice), alice_start + U512::from(294u64));
        assert!(env.emitted_event(
            &market,
            PayoutClaimed {
                bettor: alice,
                amount: U512::from(394u64),
            }
        ));

        // Bob bet the losing side → nothing to claim.
        env.set_caller(bob);
        assert_eq!(market.try_claim().unwrap_err(), Error::NothingToClaim.into());
    }

    #[test]
    fn double_claim_reverts() {
        let env = odra_test::env();
        let mut market = deploy(&env, 200);
        let alice = env.get_account(1);
        let bob = env.get_account(2);

        env.set_caller(alice);
        market.with_tokens(U512::from(100u64)).bet("YES".to_string());
        env.set_caller(bob);
        market.with_tokens(U512::from(100u64)).bet("NO".to_string());
        env.set_caller(env.get_account(0));
        market.resolve("YES".to_string());

        env.set_caller(alice);
        market.claim();
        assert_eq!(market.try_claim().unwrap_err(), Error::AlreadyClaimed.into());
    }

    #[test]
    fn single_participant_refunds_full_gross_no_fee() {
        let env = odra_test::env();
        let mut market = deploy(&env, 500); // 5% — must NOT be charged
        let alice = env.get_account(1);
        let treasury = env.get_account(3);
        let alice_start = env.balance_of(&alice);
        let treasury_start = env.balance_of(&treasury);

        env.set_caller(alice);
        market.with_tokens(U512::from(100u64)).bet("YES".to_string());
        env.set_caller(env.get_account(0));
        market.resolve("YES".to_string());

        env.set_caller(alice);
        market.claim();
        // Full refund, no fee.
        assert_eq!(env.balance_of(&alice), alice_start);
        assert_eq!(env.balance_of(&treasury), treasury_start);
    }

    #[test]
    fn no_winner_auto_voids_and_refunds() {
        let env = odra_test::env();
        let mut market = deploy(&env, 200);
        let alice = env.get_account(1);
        let alice_start = env.balance_of(&alice);

        env.set_caller(alice);
        market.with_tokens(U512::from(100u64)).bet("NO".to_string());
        // Oracle resolves YES, but nobody staked YES → auto-void.
        env.set_caller(env.get_account(0));
        market.resolve("YES".to_string());
        assert_eq!(market.status(), STATUS_VOIDED);

        env.set_caller(alice);
        market.claim();
        assert_eq!(env.balance_of(&alice), alice_start);
    }

    #[test]
    fn explicit_void_refunds_all_sides() {
        let env = odra_test::env();
        let mut market = deploy(&env, 200);
        let alice = env.get_account(1);
        let bob = env.get_account(2);
        let alice_start = env.balance_of(&alice);
        let bob_start = env.balance_of(&bob);

        env.set_caller(alice);
        market.with_tokens(U512::from(100u64)).bet("YES".to_string());
        env.set_caller(bob);
        market.with_tokens(U512::from(300u64)).bet("NO".to_string());

        env.set_caller(env.get_account(0));
        market.void();
        assert_eq!(market.status(), STATUS_VOIDED);

        env.set_caller(alice);
        market.claim();
        env.set_caller(bob);
        market.claim();
        assert_eq!(env.balance_of(&alice), alice_start);
        assert_eq!(env.balance_of(&bob), bob_start);
    }

    #[test]
    fn all_on_winning_side_returns_stake_no_fee() {
        let env = odra_test::env();
        let mut market = deploy(&env, 300);
        let alice = env.get_account(1);
        let bob = env.get_account(2);
        let treasury = env.get_account(3);
        let alice_start = env.balance_of(&alice);
        let treasury_start = env.balance_of(&treasury);

        env.set_caller(alice);
        market.with_tokens(U512::from(100u64)).bet("YES".to_string());
        env.set_caller(bob);
        market.with_tokens(U512::from(50u64)).bet("YES".to_string());
        env.set_caller(env.get_account(0));
        market.resolve("YES".to_string());

        env.set_caller(alice);
        market.claim();
        env.set_caller(bob);
        market.claim();
        assert_eq!(env.balance_of(&alice), alice_start);
        assert_eq!(env.balance_of(&treasury), treasury_start);
    }

    #[test]
    fn bet_after_deadline_reverts() {
        let env = odra_test::env();
        let market = deploy(&env, 200);
        let alice = env.get_account(1);
        env.advance_block_time(1_000_001);
        env.set_caller(alice);
        assert_eq!(
            market
                .with_tokens(U512::from(100u64))
                .try_bet("YES".to_string())
                .unwrap_err(),
            Error::MarketClosed.into()
        );
    }

    #[test]
    fn unknown_outcome_reverts() {
        let env = odra_test::env();
        let market = deploy(&env, 200);
        let alice = env.get_account(1);
        env.set_caller(alice);
        assert_eq!(
            market
                .with_tokens(U512::from(100u64))
                .try_bet("MAYBE".to_string())
                .unwrap_err(),
            Error::UnknownOutcome.into()
        );
    }

    #[test]
    fn non_oracle_resolve_reverts() {
        let env = odra_test::env();
        let mut market = deploy(&env, 200);
        let alice = env.get_account(1);
        env.set_caller(alice);
        market.with_tokens(U512::from(100u64)).bet("YES".to_string());
        // Alice (not oracle) tries to resolve.
        assert_eq!(
            market.try_resolve("YES".to_string()).unwrap_err(),
            Error::NotOracle.into()
        );
    }

    #[test]
    fn claim_before_settlement_reverts() {
        let env = odra_test::env();
        let mut market = deploy(&env, 200);
        let alice = env.get_account(1);
        env.set_caller(alice);
        market.with_tokens(U512::from(100u64)).bet("YES".to_string());
        assert_eq!(market.try_claim().unwrap_err(), Error::NotSettled.into());
    }
}
