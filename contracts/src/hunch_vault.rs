//! HunchVault v2 — the **singleton** escrow + settlement vault for every Hunch market.
//!
//! v1 deployed one `ParimutuelMarket` contract per market (~386 CSPR of Wasm install
//! gas each). v2 restructures markets into **state entries inside one deployed
//! contract**: `create_market` is a cheap entrypoint call (storage writes only), so a
//! long-tail catalogue and agent-initiated creation become economical. The payout math
//! is byte-for-byte the same as v1 (`ParimutuelMarket`) — the TS parity vectors in
//! `test/market-payout.test.ts` and the v1 OdraVM tests remain the spec:
//!
//! * Bettors escrow native CSPR onto an outcome via a `#[odra(payable)]` `bet`.
//! * Each market binds its own oracle at creation; only that oracle `resolve`s/`void`s it.
//! * Payouts are pure, deterministic pool math (pull-pattern `claim`, no iteration).
//! * The parimutuel fee (bps) is taken only from the losing pool, swept on resolution.
//! * Degenerate rounds refund in full, no fee (single side, no winners, explicit void).
//!
//! Cross-market isolation is by construction: every mapping is keyed by `market_id`,
//! and each market's settlement snapshot bounds its claims to its own pool — bets on
//! market A can never pay market B (see the isolation tests).
//!
//! Creation bond: `create_market` is payable and must attach `creation_bond` motes
//! (spam pricing for the S19+ permissionless registry). The bond is held by the vault
//! and refunded to the creator when the market settles. While `open_creation` is
//! false (the default), only the admin (Genesis key) may create.
use odra::casper_types::U512;
use odra::prelude::*;

/// Market lifecycle status.
const STATUS_OPEN: u8 = 0;
const STATUS_RESOLVED: u8 = 1;
const STATUS_VOIDED: u8 = 2;

const BPS_DENOMINATOR: u32 = 10_000;

/// Errors surfaced by the vault.
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
    /// A market with this id already exists.
    MarketExists = 11,
    /// No market under this id.
    UnknownMarket = 12,
    /// Caller may not create markets (creation is admin-only until opened).
    CreationClosed = 13,
    /// `create_market` must attach at least the creation bond.
    InsufficientBond = 14,
    /// A market's deadline must be in the future at creation.
    InvalidDeadline = 15,
    /// Caller is not the vault admin.
    NotAdmin = 16,
    /// `refund` only applies to voided markets — winners use `claim`.
    NotVoided = 17,
}

/// Emitted when a market is created in the vault.
#[odra::event]
pub struct MarketCreated {
    /// Stable market id (the catalogue slug).
    pub market_id: String,
    /// Creator (bond payer).
    pub creator: Address,
    /// The market's oracle.
    pub oracle: Address,
    /// Betting deadline (block time ms).
    pub deadline: u64,
    /// Bond escrowed with the creation.
    pub bond: U512,
}

/// Emitted on every escrowed bet.
#[odra::event]
pub struct BetPlaced {
    /// Market bet on.
    pub market_id: String,
    /// Bettor address.
    pub bettor: Address,
    /// Outcome key staked on.
    pub outcome: String,
    /// Stake in motes.
    pub amount: U512,
}

/// Emitted when a market's oracle resolves it to a winning outcome.
#[odra::event]
pub struct MarketResolved {
    /// Market resolved.
    pub market_id: String,
    /// Winning outcome key.
    pub winning_outcome: String,
    /// Total escrowed pool at resolution.
    pub total_pool: U512,
    /// Pool staked on the winning outcome.
    pub winning_pool: U512,
    /// Fee swept to treasury (bps of the losing pool).
    pub fee: U512,
}

/// Emitted when a market is voided (all stakes refundable).
#[odra::event]
pub struct MarketVoided {
    /// Market voided.
    pub market_id: String,
    /// Total escrowed pool at void time.
    pub total_pool: U512,
}

/// Emitted on each successful claim/refund.
#[odra::event]
pub struct PayoutClaimed {
    /// Market claimed from.
    pub market_id: String,
    /// Claiming address.
    pub bettor: Address,
    /// Amount transferred, in motes.
    pub amount: U512,
}

/// Emitted when a creator's bond is returned at settlement.
#[odra::event]
pub struct BondRefunded {
    /// Market whose bond was returned.
    pub market_id: String,
    /// Creator refunded.
    pub creator: Address,
    /// Bond amount, in motes.
    pub amount: U512,
}

/// Immutable per-market configuration, written once at creation.
#[odra::odra_type]
pub struct MarketConfig {
    /// Human-readable question.
    pub question: String,
    /// Catalogue category (casper-native / provably-fair / rwa / meta).
    pub category: String,
    /// The only address allowed to resolve/void this market.
    pub oracle: Address,
    /// Fee in basis points, taken only from the losing pool.
    pub fee_bps: u32,
    /// Block time (ms) after which bets are rejected.
    pub deadline: u64,
    /// Ordered outcome keys (≥ 2).
    pub outcomes: Vec<String>,
    /// Creator (receives the bond back at settlement).
    pub creator: Address,
}

/// The singleton multi-market vault.
#[odra::module(
    events = [MarketCreated, BetPlaced, MarketResolved, MarketVoided, PayoutClaimed, BondRefunded],
    errors = Error
)]
pub struct HunchVault {
    admin: Var<Address>,
    treasury: Var<Address>,
    creation_bond: Var<U512>,
    open_creation: Var<bool>,
    /// Insertion-ordered market ids (enumeration for indexers/MCP).
    ids: List<String>,
    exists: Mapping<String, bool>,
    config: Mapping<String, MarketConfig>,
    status: Mapping<String, u8>,
    /// market -> escrowed creation bond still held.
    bond_of: Mapping<String, U512>,
    /// (market, outcome) -> total staked on it.
    pool: Mapping<(String, String), U512>,
    total_pool: Mapping<String, U512>,
    /// (market, bettor, outcome) -> stake.
    stake_on: Mapping<(String, Address, String), U512>,
    /// (market, bettor) -> total stake across outcomes (void/refund path).
    bettor_total: Mapping<(String, Address), U512>,
    claimed: Mapping<(String, Address), bool>,
    winning_outcome: Mapping<String, String>,
    /// Snapshots captured at resolution so claims are cheap + deterministic.
    winning_pool: Mapping<String, U512>,
    distributable_losing: Mapping<String, U512>,
}

#[odra::module]
impl HunchVault {
    /// Initialize the vault.
    ///
    /// * `treasury` — recipient of parimutuel fees from every market.
    /// * `creation_bond` — motes `create_market` must attach (0 disables the bond).
    pub fn init(&mut self, treasury: Address, creation_bond: U512) {
        self.admin.set(self.env().caller());
        self.treasury.set(treasury);
        self.creation_bond.set(creation_bond);
        self.open_creation.set(false);
    }

    /// Create a market as a state entry — a cheap entrypoint call, not a Wasm install.
    ///
    /// Payable: must attach at least `creation_bond` motes (held, refunded to the
    /// creator at settlement). Admin-only until `set_open_creation(true)` (S19+).
    #[odra(payable)]
    pub fn create_market(
        &mut self,
        market_id: String,
        question: String,
        category: String,
        oracle: Address,
        fee_bps: u32,
        deadline: u64,
        outcomes: Vec<String>,
    ) {
        let caller = self.env().caller();
        if !self.open_creation.get_or_default()
            && caller != self.admin.get().unwrap_or_revert(self)
        {
            self.env().revert(Error::CreationClosed);
        }
        if self.exists.get_or_default(&market_id) {
            self.env().revert(Error::MarketExists);
        }
        if outcomes.len() < 2 {
            self.env().revert(Error::InvalidOutcomeCount);
        }
        if fee_bps >= BPS_DENOMINATOR {
            self.env().revert(Error::InvalidFee);
        }
        if deadline <= self.env().get_block_time() {
            self.env().revert(Error::InvalidDeadline);
        }
        let bond = self.env().attached_value();
        if bond < self.creation_bond.get_or_default() {
            self.env().revert(Error::InsufficientBond);
        }

        self.exists.set(&market_id, true);
        self.ids.push(market_id.clone());
        self.status.set(&market_id, STATUS_OPEN);
        self.bond_of.set(&market_id, bond);
        self.total_pool.set(&market_id, U512::zero());
        self.config.set(
            &market_id,
            MarketConfig {
                question,
                category,
                oracle,
                fee_bps,
                deadline,
                outcomes,
                creator: caller,
            },
        );

        self.env().emit_event(MarketCreated {
            market_id,
            creator: caller,
            oracle,
            deadline,
            bond,
        });
    }

    /// Escrow a CSPR stake onto `outcome` of `market_id`. Payable — the attached
    /// value is the stake. Same rules and math as v1 `ParimutuelMarket::bet`.
    #[odra(payable)]
    pub fn bet(&mut self, market_id: String, outcome: String) {
        let config = self.get_config_or_revert(&market_id);
        if self.status.get_or_default(&market_id) != STATUS_OPEN {
            self.env().revert(Error::MarketClosed);
        }
        if self.env().get_block_time() >= config.deadline {
            self.env().revert(Error::MarketClosed);
        }
        if !config.outcomes.contains(&outcome) {
            self.env().revert(Error::UnknownOutcome);
        }
        let amount = self.env().attached_value();
        if amount.is_zero() {
            self.env().revert(Error::ZeroStake);
        }
        let bettor = self.env().caller();

        let pool_key = (market_id.clone(), outcome.clone());
        self.pool
            .set(&pool_key, self.pool.get_or_default(&pool_key) + amount);
        self.total_pool
            .set(&market_id, self.total_pool.get_or_default(&market_id) + amount);

        let stake_key = (market_id.clone(), bettor, outcome.clone());
        self.stake_on
            .set(&stake_key, self.stake_on.get_or_default(&stake_key) + amount);
        let bettor_key = (market_id.clone(), bettor);
        self.bettor_total
            .set(&bettor_key, self.bettor_total.get_or_default(&bettor_key) + amount);

        self.env().emit_event(BetPlaced {
            market_id,
            bettor,
            outcome,
            amount,
        });
    }

    /// Market-oracle-only: resolve to `winning_outcome`, sweep the fee, snapshot the
    /// split, and return the creator's bond. If nobody staked the winning outcome the
    /// market auto-voids (everyone refunded, no fee) — v1 semantics preserved.
    pub fn resolve(&mut self, market_id: String, winning_outcome: String) {
        let config = self.get_config_or_revert(&market_id);
        self.assert_oracle(&config);
        self.assert_open(&market_id);
        if !config.outcomes.contains(&winning_outcome) {
            self.env().revert(Error::UnknownOutcome);
        }

        let total = self.total_pool.get_or_default(&market_id);
        let winning = self
            .pool
            .get_or_default(&(market_id.clone(), winning_outcome.clone()));

        // No winners → refund everyone (void semantics), no fee.
        if winning.is_zero() {
            self.status.set(&market_id, STATUS_VOIDED);
            self.refund_bond(&market_id, &config);
            self.env().emit_event(MarketVoided {
                market_id,
                total_pool: total,
            });
            return;
        }

        let losing = total - winning;
        let fee = losing * U512::from(config.fee_bps) / U512::from(BPS_DENOMINATOR);
        let distributable_losing = losing - fee;

        self.winning_outcome.set(&market_id, winning_outcome.clone());
        self.winning_pool.set(&market_id, winning);
        self.distributable_losing.set(&market_id, distributable_losing);
        self.status.set(&market_id, STATUS_RESOLVED);
        self.refund_bond(&market_id, &config);

        if !fee.is_zero() {
            let treasury = self.treasury.get().unwrap_or_revert(self);
            self.env().transfer_tokens(&treasury, &fee);
        }

        self.env().emit_event(MarketResolved {
            market_id,
            winning_outcome,
            total_pool: total,
            winning_pool: winning,
            fee,
        });
    }

    /// Market-oracle-only: void the market (flat / undecidable round). Everyone
    /// refunds their stake via `claim`/`refund`; the creator's bond is returned.
    pub fn void(&mut self, market_id: String) {
        let config = self.get_config_or_revert(&market_id);
        self.assert_oracle(&config);
        self.assert_open(&market_id);
        self.status.set(&market_id, STATUS_VOIDED);
        self.refund_bond(&market_id, &config);
        self.env().emit_event(MarketVoided {
            market_id: market_id.clone(),
            total_pool: self.total_pool.get_or_default(&market_id),
        });
    }

    /// Claim the caller's payout (winner share) or refund (voided market) on
    /// `market_id`. Idempotent per (market, address). Identical math to v1.
    pub fn claim(&mut self, market_id: String) {
        self.get_config_or_revert(&market_id);
        let status = self.status.get_or_default(&market_id);
        if status == STATUS_OPEN {
            self.env().revert(Error::NotSettled);
        }
        let bettor = self.env().caller();
        let claim_key = (market_id.clone(), bettor);
        if self.claimed.get_or_default(&claim_key) {
            self.env().revert(Error::AlreadyClaimed);
        }

        let payout = if status == STATUS_VOIDED {
            self.bettor_total.get_or_default(&claim_key)
        } else {
            let winning_outcome = self.winning_outcome.get_or_default(&market_id);
            let stake = self
                .stake_on
                .get_or_default(&(market_id.clone(), bettor, winning_outcome));
            if stake.is_zero() {
                self.env().revert(Error::NothingToClaim);
            }
            let distributable_losing = self.distributable_losing.get_or_default(&market_id);
            if distributable_losing.is_zero() {
                // No losers / no fee → stake back in full.
                stake
            } else {
                let winning_pool = self.winning_pool.get_or_default(&market_id);
                stake + stake * distributable_losing / winning_pool
            }
        };

        if payout.is_zero() {
            self.env().revert(Error::NothingToClaim);
        }

        self.claimed.set(&claim_key, true);
        self.env().transfer_tokens(&bettor, &payout);
        self.env().emit_event(PayoutClaimed {
            market_id,
            bettor,
            amount: payout,
        });
    }

    /// Explicit refund path for **voided** markets (agent-friendly alias of the
    /// voided `claim` branch). Reverts on resolved markets — winners use `claim`.
    pub fn refund(&mut self, market_id: String) {
        self.get_config_or_revert(&market_id);
        let status = self.status.get_or_default(&market_id);
        if status == STATUS_OPEN {
            self.env().revert(Error::NotSettled);
        }
        if status != STATUS_VOIDED {
            self.env().revert(Error::NotVoided);
        }
        self.claim(market_id);
    }

    // ---- admin ----

    /// Admin-only: open (or re-close) permissionless market creation (S19+).
    pub fn set_open_creation(&mut self, open: bool) {
        if self.env().caller() != self.admin.get().unwrap_or_revert(self) {
            self.env().revert(Error::NotAdmin);
        }
        self.open_creation.set(open);
    }

    // ---- reads (used by the off-chain adapter / MCP / UI / indexers) ----

    /// The vault admin (Genesis key).
    pub fn admin(&self) -> Address {
        self.admin.get().unwrap_or_revert(self)
    }

    /// Motes `create_market` must attach.
    pub fn creation_bond(&self) -> U512 {
        self.creation_bond.get_or_default()
    }

    /// Whether non-admin creation is open.
    pub fn open_creation(&self) -> bool {
        self.open_creation.get_or_default()
    }

    /// Number of markets ever created in the vault.
    pub fn market_count(&self) -> u32 {
        self.ids.len()
    }

    /// Market id at an index (0-based, insertion order).
    pub fn market_id_at(&self, index: u32) -> String {
        self.ids
            .get(index)
            .unwrap_or_revert_with(self, Error::UnknownMarket)
    }

    /// Whether a market id exists.
    pub fn market_exists(&self, market_id: String) -> bool {
        self.exists.get_or_default(&market_id)
    }

    /// The market question.
    pub fn question(&self, market_id: String) -> String {
        self.get_config_or_revert(&market_id).question
    }

    /// The market category.
    pub fn category(&self, market_id: String) -> String {
        self.get_config_or_revert(&market_id).category
    }

    /// The market's oracle.
    pub fn oracle_of(&self, market_id: String) -> Address {
        self.get_config_or_revert(&market_id).oracle
    }

    /// The market's creator (bond recipient).
    pub fn creator_of(&self, market_id: String) -> Address {
        self.get_config_or_revert(&market_id).creator
    }

    /// The market's betting deadline (block time ms).
    pub fn deadline_of(&self, market_id: String) -> u64 {
        self.get_config_or_revert(&market_id).deadline
    }

    /// Lifecycle status: 0 open, 1 resolved, 2 voided.
    pub fn status(&self, market_id: String) -> u8 {
        self.get_config_or_revert(&market_id);
        self.status.get_or_default(&market_id)
    }

    /// Ordered outcome keys.
    pub fn outcomes(&self, market_id: String) -> Vec<String> {
        self.get_config_or_revert(&market_id).outcomes
    }

    /// Total staked on a given outcome.
    pub fn pool_of(&self, market_id: String, outcome: String) -> U512 {
        self.pool.get_or_default(&(market_id, outcome))
    }

    /// Total escrowed pool across all outcomes of a market.
    pub fn total_pool(&self, market_id: String) -> U512 {
        self.total_pool.get_or_default(&market_id)
    }

    /// The resolved winning outcome (empty until resolved).
    pub fn winning_outcome(&self, market_id: String) -> String {
        self.winning_outcome.get_or_default(&market_id)
    }

    /// A bettor's stake on a specific outcome of a market.
    pub fn stake_of(&self, market_id: String, bettor: Address, outcome: String) -> U512 {
        self.stake_on.get_or_default(&(market_id, bettor, outcome))
    }

    /// Whether an address already claimed on a market.
    pub fn is_claimed(&self, market_id: String, bettor: Address) -> bool {
        self.claimed.get_or_default(&(market_id, bettor))
    }

    /// Bond still escrowed for a market (0 after settlement returns it).
    pub fn bond_held(&self, market_id: String) -> U512 {
        self.bond_of.get_or_default(&market_id)
    }

    // ---- internals ----

    fn assert_oracle(&self, config: &MarketConfig) {
        if self.env().caller() != config.oracle {
            self.env().revert(Error::NotOracle);
        }
    }

    fn assert_open(&self, market_id: &String) {
        if self.status.get_or_default(market_id) != STATUS_OPEN {
            self.env().revert(Error::AlreadySettled);
        }
    }

    fn get_config_or_revert(&self, market_id: &String) -> MarketConfig {
        self.config
            .get(market_id)
            .unwrap_or_revert_with(self, Error::UnknownMarket)
    }

    /// Return the creation bond to the creator exactly once, at settlement.
    fn refund_bond(&mut self, market_id: &String, config: &MarketConfig) {
        let bond = self.bond_of.get_or_default(market_id);
        if bond.is_zero() {
            return;
        }
        self.bond_of.set(market_id, U512::zero());
        self.env().transfer_tokens(&config.creator, &bond);
        self.env().emit_event(BondRefunded {
            market_id: market_id.clone(),
            creator: config.creator,
            amount: bond,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BondRefunded, Error, HunchVault, HunchVaultHostRef, HunchVaultInitArgs, MarketCreated,
        MarketResolved, PayoutClaimed, STATUS_OPEN, STATUS_RESOLVED, STATUS_VOIDED,
    };
    use odra::casper_types::U512;
    use odra::host::{Deployer, HostEnv, HostRef};
    use odra::prelude::*;

    fn yes_no() -> Vec<String> {
        vec!["YES".to_string(), "NO".to_string()]
    }

    /// Deploy a vault with `account(0)` as admin and `account(3)` as treasury.
    fn deploy(env: &HostEnv, creation_bond: u64) -> HunchVaultHostRef {
        env.set_caller(env.get_account(0));
        HunchVault::deploy(
            env,
            HunchVaultInitArgs {
                treasury: env.get_account(3),
                creation_bond: U512::from(creation_bond),
            },
        )
    }

    /// Create a YES/NO market with `account(0)` as oracle. Attaches `bond`.
    fn create(
        vault: &mut HunchVaultHostRef,
        env: &HostEnv,
        id: &str,
        fee_bps: u32,
        bond: u64,
    ) {
        env.set_caller(env.get_account(0));
        vault
            .with_tokens(U512::from(bond))
            .create_market(
                id.to_string(),
                format!("Will {id} happen?"),
                "casper-native".to_string(),
                env.get_account(0),
                fee_bps,
                1_000_000,
                yes_no(),
            );
    }

    // ---- v1 parity: the ten ParimutuelMarket scenarios, replayed through the vault ----

    #[test]
    fn two_sided_resolve_pays_winners_and_sweeps_fee() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "m1", 200, 0); // 2%
        let alice = env.get_account(1);
        let bob = env.get_account(2);
        let treasury = env.get_account(3);
        let alice_start = env.balance_of(&alice);
        let treasury_start = env.balance_of(&treasury);

        env.set_caller(alice);
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "YES".to_string());
        assert_eq!(env.balance_of(&alice), alice_start - U512::from(100u64));

        env.set_caller(bob);
        vault
            .with_tokens(U512::from(300u64))
            .bet("m1".to_string(), "NO".to_string());

        assert_eq!(vault.total_pool("m1".to_string()), U512::from(400u64));
        assert_eq!(
            vault.pool_of("m1".to_string(), "YES".to_string()),
            U512::from(100u64)
        );

        // Oracle resolves YES. losing=300, fee=6, distributable=294.
        env.set_caller(env.get_account(0));
        vault.resolve("m1".to_string(), "YES".to_string());
        assert_eq!(vault.status("m1".to_string()), STATUS_RESOLVED);
        assert_eq!(vault.winning_outcome("m1".to_string()), "YES".to_string());
        assert_eq!(env.balance_of(&treasury), treasury_start + U512::from(6u64));
        assert!(env.emitted_event(
            &vault,
            MarketResolved {
                market_id: "m1".to_string(),
                winning_outcome: "YES".to_string(),
                total_pool: U512::from(400u64),
                winning_pool: U512::from(100u64),
                fee: U512::from(6u64),
            }
        ));

        // Alice claims 100 + 294 = 394 → net +294.
        env.set_caller(alice);
        vault.claim("m1".to_string());
        assert_eq!(env.balance_of(&alice), alice_start + U512::from(294u64));
        assert!(env.emitted_event(
            &vault,
            PayoutClaimed {
                market_id: "m1".to_string(),
                bettor: alice,
                amount: U512::from(394u64),
            }
        ));

        // Bob bet the losing side → nothing to claim.
        env.set_caller(bob);
        assert_eq!(
            vault.try_claim("m1".to_string()).unwrap_err(),
            Error::NothingToClaim.into()
        );
    }

    #[test]
    fn double_claim_reverts() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "m1", 200, 0);
        let alice = env.get_account(1);
        let bob = env.get_account(2);

        env.set_caller(alice);
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "YES".to_string());
        env.set_caller(bob);
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "NO".to_string());
        env.set_caller(env.get_account(0));
        vault.resolve("m1".to_string(), "YES".to_string());

        env.set_caller(alice);
        vault.claim("m1".to_string());
        assert_eq!(
            vault.try_claim("m1".to_string()).unwrap_err(),
            Error::AlreadyClaimed.into()
        );
    }

    #[test]
    fn single_participant_refunds_full_gross_no_fee() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "m1", 500, 0); // 5% — must NOT be charged
        let alice = env.get_account(1);
        let treasury = env.get_account(3);
        let alice_start = env.balance_of(&alice);
        let treasury_start = env.balance_of(&treasury);

        env.set_caller(alice);
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "YES".to_string());
        env.set_caller(env.get_account(0));
        vault.resolve("m1".to_string(), "YES".to_string());

        env.set_caller(alice);
        vault.claim("m1".to_string());
        assert_eq!(env.balance_of(&alice), alice_start);
        assert_eq!(env.balance_of(&treasury), treasury_start);
    }

    #[test]
    fn no_winner_auto_voids_and_refunds() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "m1", 200, 0);
        let alice = env.get_account(1);
        let alice_start = env.balance_of(&alice);

        env.set_caller(alice);
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "NO".to_string());
        // Oracle resolves YES, but nobody staked YES → auto-void.
        env.set_caller(env.get_account(0));
        vault.resolve("m1".to_string(), "YES".to_string());
        assert_eq!(vault.status("m1".to_string()), STATUS_VOIDED);

        env.set_caller(alice);
        vault.claim("m1".to_string());
        assert_eq!(env.balance_of(&alice), alice_start);
    }

    #[test]
    fn explicit_void_refunds_all_sides() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "m1", 200, 0);
        let alice = env.get_account(1);
        let bob = env.get_account(2);
        let alice_start = env.balance_of(&alice);
        let bob_start = env.balance_of(&bob);

        env.set_caller(alice);
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "YES".to_string());
        env.set_caller(bob);
        vault
            .with_tokens(U512::from(300u64))
            .bet("m1".to_string(), "NO".to_string());

        env.set_caller(env.get_account(0));
        vault.void("m1".to_string());
        assert_eq!(vault.status("m1".to_string()), STATUS_VOIDED);

        env.set_caller(alice);
        vault.claim("m1".to_string());
        env.set_caller(bob);
        vault.refund("m1".to_string()); // explicit refund path, same outcome
        assert_eq!(env.balance_of(&alice), alice_start);
        assert_eq!(env.balance_of(&bob), bob_start);
    }

    #[test]
    fn all_on_winning_side_returns_stake_no_fee() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "m1", 300, 0);
        let alice = env.get_account(1);
        let bob = env.get_account(2);
        let treasury = env.get_account(3);
        let alice_start = env.balance_of(&alice);
        let treasury_start = env.balance_of(&treasury);

        env.set_caller(alice);
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "YES".to_string());
        env.set_caller(bob);
        vault
            .with_tokens(U512::from(50u64))
            .bet("m1".to_string(), "YES".to_string());
        env.set_caller(env.get_account(0));
        vault.resolve("m1".to_string(), "YES".to_string());

        env.set_caller(alice);
        vault.claim("m1".to_string());
        env.set_caller(bob);
        vault.claim("m1".to_string());
        assert_eq!(env.balance_of(&alice), alice_start);
        assert_eq!(env.balance_of(&treasury), treasury_start);
    }

    #[test]
    fn bet_after_deadline_reverts() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "m1", 200, 0);
        let alice = env.get_account(1);
        env.advance_block_time(1_000_001);
        env.set_caller(alice);
        assert_eq!(
            vault
                .with_tokens(U512::from(100u64))
                .try_bet("m1".to_string(), "YES".to_string())
                .unwrap_err(),
            Error::MarketClosed.into()
        );
    }

    #[test]
    fn unknown_outcome_reverts() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "m1", 200, 0);
        let alice = env.get_account(1);
        env.set_caller(alice);
        assert_eq!(
            vault
                .with_tokens(U512::from(100u64))
                .try_bet("m1".to_string(), "MAYBE".to_string())
                .unwrap_err(),
            Error::UnknownOutcome.into()
        );
    }

    #[test]
    fn non_oracle_resolve_reverts() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "m1", 200, 0);
        let alice = env.get_account(1);
        env.set_caller(alice);
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "YES".to_string());
        // Alice (not the oracle) tries to resolve.
        assert_eq!(
            vault
                .try_resolve("m1".to_string(), "YES".to_string())
                .unwrap_err(),
            Error::NotOracle.into()
        );
    }

    #[test]
    fn claim_before_settlement_reverts() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "m1", 200, 0);
        let alice = env.get_account(1);
        env.set_caller(alice);
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "YES".to_string());
        assert_eq!(
            vault.try_claim("m1".to_string()).unwrap_err(),
            Error::NotSettled.into()
        );
    }

    // ---- singleton semantics: creation, enumeration, cross-market isolation ----

    #[test]
    fn creates_and_enumerates_markets() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        assert_eq!(vault.market_count(), 0);
        create(&mut vault, &env, "alpha", 200, 0);
        create(&mut vault, &env, "beta", 200, 0);

        assert_eq!(vault.market_count(), 2);
        assert_eq!(vault.market_id_at(0), "alpha".to_string());
        assert_eq!(vault.market_id_at(1), "beta".to_string());
        assert!(vault.market_exists("alpha".to_string()));
        assert!(!vault.market_exists("gamma".to_string()));
        assert_eq!(vault.status("alpha".to_string()), STATUS_OPEN);
        assert_eq!(vault.question("alpha".to_string()), "Will alpha happen?");
        assert_eq!(vault.category("alpha".to_string()), "casper-native");
        assert_eq!(vault.oracle_of("alpha".to_string()), env.get_account(0));
        assert_eq!(vault.deadline_of("alpha".to_string()), 1_000_000);
        assert_eq!(vault.outcomes("alpha".to_string()), super::tests::yes_no());
        assert!(env.emitted_event(
            &vault,
            MarketCreated {
                market_id: "beta".to_string(),
                creator: env.get_account(0),
                oracle: env.get_account(0),
                deadline: 1_000_000,
                bond: U512::zero(),
            }
        ));
    }

    #[test]
    fn duplicate_market_id_reverts() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "dup", 200, 0);
        env.set_caller(env.get_account(0));
        assert_eq!(
            vault
                .try_create_market(
                    "dup".to_string(),
                    "q".to_string(),
                    "meta".to_string(),
                    env.get_account(0),
                    200,
                    1_000_000,
                    super::tests::yes_no(),
                )
                .unwrap_err(),
            Error::MarketExists.into()
        );
    }

    #[test]
    fn unknown_market_reverts_everywhere() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        let alice = env.get_account(1);
        env.set_caller(alice);
        assert_eq!(
            vault
                .with_tokens(U512::from(10u64))
                .try_bet("ghost".to_string(), "YES".to_string())
                .unwrap_err(),
            Error::UnknownMarket.into()
        );
        assert_eq!(
            vault.try_claim("ghost".to_string()).unwrap_err(),
            Error::UnknownMarket.into()
        );
        assert_eq!(
            vault.try_question("ghost".to_string()).unwrap_err(),
            Error::UnknownMarket.into()
        );
    }

    /// The isolation gate: bets on market A can never pay market B.
    #[test]
    fn cross_market_isolation_pools_and_payouts() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "a", 200, 0);
        create(&mut vault, &env, "b", 200, 0);
        let alice = env.get_account(1);
        let bob = env.get_account(2);
        let alice_start = env.balance_of(&alice);
        let bob_start = env.balance_of(&bob);

        // Alice bets YES on A; Bob bets NO on A AND YES on B.
        env.set_caller(alice);
        vault
            .with_tokens(U512::from(100u64))
            .bet("a".to_string(), "YES".to_string());
        env.set_caller(bob);
        vault
            .with_tokens(U512::from(300u64))
            .bet("a".to_string(), "NO".to_string());
        vault
            .with_tokens(U512::from(500u64))
            .bet("b".to_string(), "YES".to_string());

        // Pools are independent.
        assert_eq!(vault.total_pool("a".to_string()), U512::from(400u64));
        assert_eq!(vault.total_pool("b".to_string()), U512::from(500u64));
        assert_eq!(
            vault.pool_of("b".to_string(), "NO".to_string()),
            U512::zero()
        );
        assert_eq!(
            vault.stake_of("b".to_string(), alice, "YES".to_string()),
            U512::zero()
        );

        // Resolving A must not touch B.
        env.set_caller(env.get_account(0));
        vault.resolve("a".to_string(), "YES".to_string());
        assert_eq!(vault.status("a".to_string()), STATUS_RESOLVED);
        assert_eq!(vault.status("b".to_string()), STATUS_OPEN);
        assert_eq!(vault.total_pool("b".to_string()), U512::from(500u64));

        // Alice won A (losing=300, fee=6, share=294): claims 394. She has NOTHING on B.
        env.set_caller(alice);
        vault.claim("a".to_string());
        assert_eq!(env.balance_of(&alice), alice_start + U512::from(294u64));
        assert_eq!(
            vault.try_claim("b".to_string()).unwrap_err(),
            Error::NotSettled.into()
        );

        // B resolves YES — Bob is B's sole participant, refunded in full there,
        // and his A claim finds nothing (he lost A).
        env.set_caller(env.get_account(0));
        vault.resolve("b".to_string(), "YES".to_string());
        env.set_caller(bob);
        vault.claim("b".to_string());
        assert_eq!(
            vault.try_claim("a".to_string()).unwrap_err(),
            Error::NothingToClaim.into()
        );
        // Bob net: -300 (lost on A), 500 back from B.
        assert_eq!(env.balance_of(&bob), bob_start - U512::from(300u64));

        // Claim flags are per (market, bettor): Alice's A claim didn't mark B.
        assert!(vault.is_claimed("a".to_string(), alice));
        assert!(!vault.is_claimed("b".to_string(), alice));
    }

    #[test]
    fn same_bettor_same_outcome_key_across_markets_stays_separate() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "a", 0, 0);
        create(&mut vault, &env, "b", 0, 0);
        let alice = env.get_account(1);

        env.set_caller(alice);
        vault
            .with_tokens(U512::from(100u64))
            .bet("a".to_string(), "YES".to_string());
        vault
            .with_tokens(U512::from(70u64))
            .bet("b".to_string(), "YES".to_string());

        assert_eq!(
            vault.stake_of("a".to_string(), alice, "YES".to_string()),
            U512::from(100u64)
        );
        assert_eq!(
            vault.stake_of("b".to_string(), alice, "YES".to_string()),
            U512::from(70u64)
        );
    }

    // ---- creation bond + access control ----

    #[test]
    fn creation_bond_is_required_held_and_refunded_on_resolve() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 50);
        let admin = env.get_account(0);
        let admin_start = env.balance_of(&admin);

        // Underpaying the bond reverts.
        env.set_caller(admin);
        assert_eq!(
            vault
                .with_tokens(U512::from(49u64))
                .try_create_market(
                    "m1".to_string(),
                    "q".to_string(),
                    "meta".to_string(),
                    admin,
                    200,
                    1_000_000,
                    super::tests::yes_no(),
                )
                .unwrap_err(),
            Error::InsufficientBond.into()
        );

        create(&mut vault, &env, "m1", 200, 50);
        assert_eq!(env.balance_of(&admin), admin_start - U512::from(50u64));
        assert_eq!(vault.bond_held("m1".to_string()), U512::from(50u64));

        let alice = env.get_account(1);
        env.set_caller(alice);
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "YES".to_string());

        // Bond comes back to the creator at settlement.
        env.set_caller(admin);
        vault.resolve("m1".to_string(), "YES".to_string());
        assert_eq!(vault.bond_held("m1".to_string()), U512::zero());
        assert_eq!(env.balance_of(&admin), admin_start);
        assert!(env.emitted_event(
            &vault,
            BondRefunded {
                market_id: "m1".to_string(),
                creator: admin,
                amount: U512::from(50u64),
            }
        ));
    }

    #[test]
    fn bond_refunds_on_void_too() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 25);
        let admin = env.get_account(0);
        let admin_start = env.balance_of(&admin);
        create(&mut vault, &env, "m1", 200, 25);
        env.set_caller(admin);
        vault.void("m1".to_string());
        assert_eq!(env.balance_of(&admin), admin_start);
    }

    #[test]
    fn non_admin_creation_closed_until_opened() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        let alice = env.get_account(1);

        env.set_caller(alice);
        assert_eq!(
            vault
                .try_create_market(
                    "m1".to_string(),
                    "q".to_string(),
                    "meta".to_string(),
                    alice,
                    200,
                    1_000_000,
                    super::tests::yes_no(),
                )
                .unwrap_err(),
            Error::CreationClosed.into()
        );

        // Only the admin can open creation.
        assert_eq!(
            vault.try_set_open_creation(true).unwrap_err(),
            Error::NotAdmin.into()
        );
        env.set_caller(env.get_account(0));
        vault.set_open_creation(true);

        // Now Alice can create — and she is the creator/bond recipient.
        env.set_caller(alice);
        vault.create_market(
            "m1".to_string(),
            "q".to_string(),
            "meta".to_string(),
            alice,
            200,
            1_000_000,
            super::tests::yes_no(),
        );
        assert_eq!(vault.creator_of("m1".to_string()), alice);
    }

    #[test]
    fn create_market_validates_inputs() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        let admin = env.get_account(0);
        env.set_caller(admin);

        assert_eq!(
            vault
                .try_create_market(
                    "m1".to_string(),
                    "q".to_string(),
                    "meta".to_string(),
                    admin,
                    200,
                    1_000_000,
                    vec!["ONLY".to_string()],
                )
                .unwrap_err(),
            Error::InvalidOutcomeCount.into()
        );
        assert_eq!(
            vault
                .try_create_market(
                    "m1".to_string(),
                    "q".to_string(),
                    "meta".to_string(),
                    admin,
                    10_000,
                    1_000_000,
                    super::tests::yes_no(),
                )
                .unwrap_err(),
            Error::InvalidFee.into()
        );
        env.advance_block_time(5_000);
        assert_eq!(
            vault
                .try_create_market(
                    "m1".to_string(),
                    "q".to_string(),
                    "meta".to_string(),
                    admin,
                    200,
                    5_000,
                    super::tests::yes_no(),
                )
                .unwrap_err(),
            Error::InvalidDeadline.into()
        );
    }

    #[test]
    fn refund_on_resolved_market_reverts_not_voided() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "m1", 200, 0);
        let alice = env.get_account(1);
        let bob = env.get_account(2);
        env.set_caller(alice);
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "YES".to_string());
        env.set_caller(bob);
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "NO".to_string());
        env.set_caller(env.get_account(0));
        vault.resolve("m1".to_string(), "YES".to_string());

        env.set_caller(alice);
        assert_eq!(
            vault.try_refund("m1".to_string()).unwrap_err(),
            Error::NotVoided.into()
        );
        // Winners still claim normally.
        vault.claim("m1".to_string());
    }
}
