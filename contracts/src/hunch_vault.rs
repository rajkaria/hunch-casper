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
//! (spam pricing for the permissionless registry). The bond is held by the vault
//! and refunded to the creator when the market settles.
//!
//! # Permissionless creation (S19)
//!
//! `open_creation` is false at init — only the admin (Genesis key) may create. Flipping
//! it with `set_open_creation(true)` opens creation to anyone, so the guardrails below
//! exist to make that flip safe. **They bind non-admin creators only**; the admin keeps
//! the full parameter range so the curated catalogue is unaffected.
//!
//! * **Approved oracles only.** The oracle bound at creation is the only address that can
//!   resolve the market, i.e. it decides who gets paid. An unconstrained creator would
//!   name themselves, take the other side's money and self-resolve — so a public market's
//!   oracle must be on the admin-curated allowlist (`approve_oracle`), and may never be
//!   the creator. This is the guardrail the whole flip hinges on.
//! * **Fee cap** (`MAX_PUBLIC_FEE_BPS`) — the raw check only bars ≥ 100%, which still
//!   permits a 99% honeypot.
//! * **Deadline horizon** (`MAX_PUBLIC_DEADLINE_HORIZON_MS`) — bettor funds are escrowed
//!   until settlement, so an unbounded deadline is an unbounded lockup.
//! * **Reserved `meta` category** — meta-markets score the agent leaderboards, so letting
//!   the public mint them would contaminate the self-scoring board (see AGENTS.md).
//! * **Concurrent-market cap per creator** (`max_open_markets_per_creator`) — bounds spam
//!   by open markets, not lifetime ones, so the counter frees on settlement alongside the
//!   bond and an honest creator never hits a permanent ceiling.
//!
//! Structural field bounds (id/question/category/outcome lengths, outcome count,
//! duplicate outcome keys) apply to **every** creator, admin included: they are input
//! sanity, not policy, and unbounded strings are a storage-griefing vector.
use odra::casper_types::U512;
use odra::prelude::*;

/// Market lifecycle status.
const STATUS_OPEN: u8 = 0;
const STATUS_RESOLVED: u8 = 1;
const STATUS_VOIDED: u8 = 2;

const BPS_DENOMINATOR: u32 = 10_000;

/// Largest fee a non-admin creator may set (5%). The catalogue ships 200 bps.
const MAX_PUBLIC_FEE_BPS: u32 = 500;
/// Furthest out a non-admin creator may set a deadline (180 days, in ms).
const MAX_PUBLIC_DEADLINE_HORIZON_MS: u64 = 180 * 24 * 60 * 60 * 1_000;
/// Default cap on simultaneously-open markets per non-admin creator.
const DEFAULT_MAX_OPEN_MARKETS_PER_CREATOR: u32 = 5;
/// Category reserved to the admin — meta-markets score the agent boards.
const RESERVED_CATEGORY_META: &str = "meta";

/// Structural field bounds (every creator). Sized well clear of the real catalogue,
/// whose longest slug is 29 chars, longest question 49, and widest market 4 outcomes.
const MAX_MARKET_ID_LEN: usize = 64;
const MAX_QUESTION_LEN: usize = 200;
const MAX_CATEGORY_LEN: usize = 32;
const MAX_OUTCOME_LEN: usize = 32;
const MAX_OUTCOMES: usize = 8;

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
    /// Public creation must bind an admin-approved oracle.
    OracleNotApproved = 18,
    /// A public creator may not be their own market's oracle (self-resolution).
    SelfOracle = 19,
    /// Fee exceeds the public creation cap.
    FeeTooHigh = 20,
    /// Deadline is beyond the public creation horizon.
    DeadlineTooFar = 21,
    /// `meta` is reserved to the admin — it scores the agent boards.
    ReservedCategory = 22,
    /// Creator already holds the maximum number of simultaneously-open markets.
    CreatorMarketCapReached = 23,
    /// A field exceeded its length/count bound, or was empty.
    InvalidField = 24,
    /// Outcome keys must be unique.
    DuplicateOutcome = 25,
    /// The recipe hash is frozen — a bet has already landed on this market (S24).
    RecipeLocked = 26,
    /// Only the market's creator (or admin) may commit its resolution recipe.
    NotCreator = 27,
    /// An evidence bundle may only be committed for a settled market.
    NotYetSettled = 28,
}

/// Longest recipe / evidence hash string the vault stores (`sha256:` + 64 hex = 71). 96 gives
/// headroom for a differently-prefixed or multi-hash scheme without an unbounded storage vector.
const MAX_HASH_LEN: usize = 96;

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

/// Emitted when the admin adds or removes an oracle from the public-creation allowlist.
#[odra::event]
pub struct OracleApproved {
    /// Oracle whose approval changed.
    pub oracle: Address,
    /// Whether it may now back public markets.
    pub approved: bool,
}

/// Emitted when the admin opens or closes permissionless creation.
#[odra::event]
pub struct CreationOpened {
    /// Whether non-admin addresses may now create markets.
    pub open: bool,
}

/// Emitted when a market's resolution recipe hash is committed/updated (S24). Only fires while the
/// market has no bets — once the first bet lands the hash is frozen.
#[odra::event]
pub struct RecipeCommitted {
    /// Market whose recipe was committed.
    pub market_id: String,
    /// The canonical resolution-recipe hash (e.g. `sha256:…`).
    pub recipe_hash: String,
}

/// Emitted when the oracle commits the evidence-bundle hash for a settled market (S24).
#[odra::event]
pub struct EvidenceCommitted {
    /// Market whose evidence bundle was committed.
    pub market_id: String,
    /// The content-addressed evidence-bundle hash.
    pub bundle_hash: String,
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
    events = [
        MarketCreated, BetPlaced, MarketResolved, MarketVoided, PayoutClaimed, BondRefunded,
        OracleApproved, CreationOpened, RecipeCommitted, EvidenceCommitted
    ],
    errors = Error
)]
pub struct HunchVault {
    admin: Var<Address>,
    treasury: Var<Address>,
    creation_bond: Var<U512>,
    open_creation: Var<bool>,
    /// Oracles the admin has cleared to back permissionless markets (S19).
    approved_oracles: Mapping<Address, bool>,
    /// creator -> markets they currently hold open (freed at settlement).
    open_markets_of: Mapping<Address, u32>,
    /// Cap on `open_markets_of` for non-admin creators.
    max_open_markets_per_creator: Var<u32>,
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
    /// market -> canonical resolution-recipe hash. Committed at/after creation, FROZEN once the
    /// first bet lands, so the rule a resolution is replayed against cannot change under bettors (S24).
    recipe_hash: Mapping<String, String>,
    /// market -> content-addressed evidence-bundle hash, committed by the oracle at settlement (S24).
    bundle_hash: Mapping<String, String>,
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
        self.max_open_markets_per_creator
            .set(DEFAULT_MAX_OPEN_MARKETS_PER_CREATOR);
    }

    /// Create a market as a state entry — a cheap entrypoint call, not a Wasm install.
    ///
    /// Payable: must attach at least `creation_bond` motes (held, refunded to the
    /// creator at settlement).
    ///
    /// Admin-only until `set_open_creation(true)`. Once open, non-admin creators are
    /// additionally bound by the S19 guardrails documented on the module — approved
    /// non-self oracle, capped fee, bounded deadline, no `meta` category, and a limit on
    /// simultaneously-open markets. The admin is exempt from those policy caps but not
    /// from the structural field bounds.
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
        let is_admin = caller == self.admin.get().unwrap_or_revert(self);
        if !is_admin && !self.open_creation.get_or_default() {
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
        let now = self.env().get_block_time();
        if deadline <= now {
            self.env().revert(Error::InvalidDeadline);
        }
        self.assert_valid_shape(&market_id, &question, &category, &outcomes);
        if !is_admin {
            self.assert_public_creation_allowed(caller, &category, oracle, fee_bps, deadline, now);
        }
        let bond = self.env().attached_value();
        if bond < self.creation_bond.get_or_default() {
            self.env().revert(Error::InsufficientBond);
        }

        let open_now = self.open_markets_of.get_or_default(&caller);
        self.open_markets_of.set(&caller, open_now + 1);
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

    /// Admin-only: open (or re-close) permissionless market creation.
    ///
    /// Approve at least one oracle first — with an empty allowlist every public
    /// `create_market` reverts `OracleNotApproved`, so the flip would open nothing.
    pub fn set_open_creation(&mut self, open: bool) {
        self.assert_admin();
        self.open_creation.set(open);
        self.env().emit_event(CreationOpened { open });
    }

    /// Admin-only: add or remove an oracle from the public-creation allowlist.
    ///
    /// Only affects markets created *after* the change — a market's oracle is bound at
    /// creation and immutable, so revoking here cannot strand an existing market's
    /// resolution.
    pub fn approve_oracle(&mut self, oracle: Address, approved: bool) {
        self.assert_admin();
        self.approved_oracles.set(&oracle, approved);
        self.env().emit_event(OracleApproved { oracle, approved });
    }

    /// Admin-only: retune the per-creator cap on simultaneously-open markets.
    pub fn set_max_open_markets_per_creator(&mut self, max: u32) {
        self.assert_admin();
        self.max_open_markets_per_creator.set(max);
    }

    // ---- verifiable resolution (S24) ----

    /// Commit (or correct) the market's canonical resolution-recipe hash — the rule a third party
    /// replays a resolution against. Callable by the market's **creator** or the **admin**, and
    /// ONLY while the market has taken no bets: once the first stake lands the hash is frozen
    /// (`RecipeLocked`), so bettors can trust that the rule they bet under is the rule that settles.
    ///
    /// Kept a separate entrypoint (rather than a `create_market` argument) precisely so this
    /// "immutable once the first bet lands" property is explicit and testable, and so the existing
    /// creation ABI is unchanged.
    pub fn commit_recipe(&mut self, market_id: String, recipe_hash: String) {
        let config = self.get_config_or_revert(&market_id);
        let caller = self.env().caller();
        let is_admin = caller == self.admin.get().unwrap_or_revert(self);
        if caller != config.creator && !is_admin {
            self.env().revert(Error::NotCreator);
        }
        // Frozen the moment any stake has landed — the first bet locks the rule.
        if !self.total_pool.get_or_default(&market_id).is_zero() {
            self.env().revert(Error::RecipeLocked);
        }
        if recipe_hash.is_empty() || recipe_hash.len() > MAX_HASH_LEN {
            self.env().revert(Error::InvalidField);
        }
        self.recipe_hash.set(&market_id, recipe_hash.clone());
        self.env().emit_event(RecipeCommitted {
            market_id,
            recipe_hash,
        });
    }

    /// Commit the content-addressed evidence-bundle hash for a **settled** market. Oracle-only, and
    /// only after `resolve`/`void`, so the published evidence is bound to the outcome it justifies.
    /// Re-committable (a richer bundle can supersede an earlier one) — the event log is the history.
    pub fn commit_bundle(&mut self, market_id: String, bundle_hash: String) {
        let config = self.get_config_or_revert(&market_id);
        self.assert_oracle(&config);
        if self.status.get_or_default(&market_id) == STATUS_OPEN {
            self.env().revert(Error::NotYetSettled);
        }
        if bundle_hash.is_empty() || bundle_hash.len() > MAX_HASH_LEN {
            self.env().revert(Error::InvalidField);
        }
        self.bundle_hash.set(&market_id, bundle_hash.clone());
        self.env().emit_event(EvidenceCommitted {
            market_id,
            bundle_hash,
        });
    }

    /// The committed resolution-recipe hash (empty until committed).
    pub fn recipe_hash_of(&self, market_id: String) -> String {
        self.get_config_or_revert(&market_id);
        self.recipe_hash.get_or_default(&market_id)
    }

    /// The committed evidence-bundle hash (empty until committed).
    pub fn bundle_hash_of(&self, market_id: String) -> String {
        self.get_config_or_revert(&market_id);
        self.bundle_hash.get_or_default(&market_id)
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

    /// Whether `oracle` may back permissionlessly-created markets.
    pub fn is_oracle_approved(&self, oracle: Address) -> bool {
        self.approved_oracles.get_or_default(&oracle)
    }

    /// Cap on simultaneously-open markets per non-admin creator.
    pub fn max_open_markets_per_creator(&self) -> u32 {
        self.max_open_markets_per_creator.get_or_default()
    }

    /// Markets `creator` currently holds open (freed as each one settles).
    pub fn open_markets_of(&self, creator: Address) -> u32 {
        self.open_markets_of.get_or_default(&creator)
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

    fn assert_admin(&self) {
        if self.env().caller() != self.admin.get().unwrap_or_revert(self) {
            self.env().revert(Error::NotAdmin);
        }
    }

    fn get_config_or_revert(&self, market_id: &String) -> MarketConfig {
        self.config
            .get(market_id)
            .unwrap_or_revert_with(self, Error::UnknownMarket)
    }

    /// Structural input bounds, applied to every creator (admin included): unbounded
    /// strings and outcome lists are a storage-griefing vector, and duplicate outcome
    /// keys would collapse two pools into one storage slot.
    fn assert_valid_shape(
        &self,
        market_id: &String,
        question: &String,
        category: &String,
        outcomes: &[String],
    ) {
        if market_id.is_empty()
            || market_id.len() > MAX_MARKET_ID_LEN
            || question.is_empty()
            || question.len() > MAX_QUESTION_LEN
            || category.is_empty()
            || category.len() > MAX_CATEGORY_LEN
            || outcomes.len() > MAX_OUTCOMES
        {
            self.env().revert(Error::InvalidField);
        }
        for (i, outcome) in outcomes.iter().enumerate() {
            if outcome.is_empty() || outcome.len() > MAX_OUTCOME_LEN {
                self.env().revert(Error::InvalidField);
            }
            if outcomes[i + 1..].contains(outcome) {
                self.env().revert(Error::DuplicateOutcome);
            }
        }
    }

    /// The S19 policy guardrails that make `open_creation` safe. Non-admin creators only.
    fn assert_public_creation_allowed(
        &self,
        caller: Address,
        category: &str,
        oracle: Address,
        fee_bps: u32,
        deadline: u64,
        now: u64,
    ) {
        if category.trim().eq_ignore_ascii_case(RESERVED_CATEGORY_META) {
            self.env().revert(Error::ReservedCategory);
        }
        // The oracle decides who gets paid; a creator who is their own oracle can take
        // the other side's stake and resolve in their own favour.
        if oracle == caller {
            self.env().revert(Error::SelfOracle);
        }
        if !self.approved_oracles.get_or_default(&oracle) {
            self.env().revert(Error::OracleNotApproved);
        }
        if fee_bps > MAX_PUBLIC_FEE_BPS {
            self.env().revert(Error::FeeTooHigh);
        }
        if deadline.saturating_sub(now) > MAX_PUBLIC_DEADLINE_HORIZON_MS {
            self.env().revert(Error::DeadlineTooFar);
        }
        let open_now = self.open_markets_of.get_or_default(&caller);
        if open_now >= self.max_open_markets_per_creator.get_or_default() {
            self.env().revert(Error::CreatorMarketCapReached);
        }
    }

    /// Return the creation bond to the creator and free their open-market slot. Called
    /// exactly once per market: every call site sits behind `assert_open`, which reverts
    /// once the status has left `STATUS_OPEN`.
    fn refund_bond(&mut self, market_id: &String, config: &MarketConfig) {
        let open_now = self.open_markets_of.get_or_default(&config.creator);
        self.open_markets_of
            .set(&config.creator, open_now.saturating_sub(1));

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
        BondRefunded, CreationOpened, Error, HunchVault, HunchVaultHostRef, HunchVaultInitArgs,
        MarketCreated, MarketResolved, OracleApproved, PayoutClaimed, STATUS_OPEN, STATUS_RESOLVED,
        STATUS_VOIDED,
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
        let arbiter = env.get_account(2);

        env.set_caller(alice);
        assert_eq!(
            vault
                .try_create_market(
                    "m1".to_string(),
                    "q".to_string(),
                    "casper-native".to_string(),
                    arbiter,
                    200,
                    1_000_000,
                    yes_no(),
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
        vault.approve_oracle(arbiter, true);
        vault.set_open_creation(true);
        assert!(env.emitted_event(&vault, CreationOpened { open: true }));

        // Now Alice can create — and she is the creator/bond recipient.
        env.set_caller(alice);
        vault.create_market(
            "m1".to_string(),
            "q".to_string(),
            "casper-native".to_string(),
            arbiter,
            200,
            1_000_000,
            yes_no(),
        );
        assert_eq!(vault.creator_of("m1".to_string()), alice);
        assert_eq!(vault.open_markets_of(alice), 1);
    }

    // ---- S19: guardrails that make permissionless creation safe ----

    /// Deploy with creation open and `account(2)` approved as a public oracle.
    fn deploy_open(env: &HostEnv, creation_bond: u64) -> HunchVaultHostRef {
        let mut vault = deploy(env, creation_bond);
        env.set_caller(env.get_account(0));
        vault.approve_oracle(env.get_account(2), true);
        vault.set_open_creation(true);
        vault
    }

    /// A well-formed public creation by `creator`, bound to the approved oracle.
    fn public_create(
        vault: &mut HunchVaultHostRef,
        env: &HostEnv,
        creator: Address,
        id: &str,
    ) -> Result<(), OdraError> {
        env.set_caller(creator);
        vault.try_create_market(
            id.to_string(),
            "Will it happen?".to_string(),
            "casper-native".to_string(),
            env.get_account(2),
            200,
            1_000_000,
            yes_no(),
        )
    }

    /// The vector the whole flip hinges on: a public creator who names themselves oracle
    /// could take the other side's stake and resolve in their own favour.
    #[test]
    fn public_creator_cannot_be_their_own_oracle() {
        let env = odra_test::env();
        let mut vault = deploy_open(&env, 0);
        let mallory = env.get_account(1);

        env.set_caller(mallory);
        assert_eq!(
            vault
                .try_create_market(
                    "rug".to_string(),
                    "Will I pay myself?".to_string(),
                    "casper-native".to_string(),
                    mallory, // <- self-resolution
                    200,
                    1_000_000,
                    yes_no(),
                )
                .unwrap_err(),
            Error::SelfOracle.into()
        );
        assert!(!vault.market_exists("rug".to_string()));
    }

    /// Even a third-party oracle must be admin-approved — otherwise Mallory just uses a
    /// second address she controls.
    #[test]
    fn public_creation_requires_an_approved_oracle() {
        let env = odra_test::env();
        let mut vault = deploy_open(&env, 0);
        let mallory = env.get_account(1);
        let sockpuppet = env.get_account(4);

        env.set_caller(mallory);
        assert_eq!(
            vault
                .try_create_market(
                    "rug".to_string(),
                    "Will my alt pay me?".to_string(),
                    "casper-native".to_string(),
                    sockpuppet,
                    200,
                    1_000_000,
                    yes_no(),
                )
                .unwrap_err(),
            Error::OracleNotApproved.into()
        );

        // Admin approves it → the same call now succeeds.
        env.set_caller(env.get_account(0));
        vault.approve_oracle(sockpuppet, true);
        assert!(env.emitted_event(
            &vault,
            OracleApproved {
                oracle: sockpuppet,
                approved: true,
            }
        ));
        assert!(vault.is_oracle_approved(sockpuppet));

        env.set_caller(mallory);
        vault.create_market(
            "rug".to_string(),
            "Will my alt pay me?".to_string(),
            "casper-native".to_string(),
            sockpuppet,
            200,
            1_000_000,
            yes_no(),
        );
        assert!(vault.market_exists("rug".to_string()));
    }

    #[test]
    fn approve_oracle_is_admin_only_and_revocable() {
        let env = odra_test::env();
        let mut vault = deploy_open(&env, 0);
        let alice = env.get_account(1);
        let arbiter = env.get_account(2);

        env.set_caller(alice);
        assert_eq!(
            vault.try_approve_oracle(alice, true).unwrap_err(),
            Error::NotAdmin.into()
        );

        env.set_caller(env.get_account(0));
        vault.approve_oracle(arbiter, false);
        assert!(!vault.is_oracle_approved(arbiter));
        assert_eq!(
            public_create(&mut vault, &env, alice, "m1").unwrap_err(),
            Error::OracleNotApproved.into()
        );
    }

    /// Revoking an oracle must not strand markets it already backs — the binding is
    /// captured in the market config at creation and is immutable.
    #[test]
    fn revoking_an_oracle_does_not_strand_existing_markets() {
        let env = odra_test::env();
        let mut vault = deploy_open(&env, 0);
        let alice = env.get_account(1);
        let arbiter = env.get_account(2);

        public_create(&mut vault, &env, alice, "m1").unwrap();

        env.set_caller(env.get_account(0));
        vault.approve_oracle(arbiter, false);

        // The bound oracle can still settle the market it already backs.
        env.set_caller(arbiter);
        vault.resolve("m1".to_string(), "YES".to_string());
        assert_eq!(vault.status("m1".to_string()), STATUS_VOIDED); // no winners → void
    }

    /// `meta` markets score the Prophet/Arbiter boards, so the public may not mint them.
    #[test]
    fn public_creation_rejects_the_reserved_meta_category() {
        let env = odra_test::env();
        let mut vault = deploy_open(&env, 0);
        let alice = env.get_account(1);
        let arbiter = env.get_account(2);

        for (i, category) in ["meta", "META", "Meta", " meta "].iter().enumerate() {
            env.set_caller(alice);
            assert_eq!(
                vault
                    .try_create_market(
                        format!("m{i}"),
                        "Which Prophet wins?".to_string(),
                        category.to_string(),
                        arbiter,
                        200,
                        1_000_000,
                        yes_no(),
                    )
                    .unwrap_err(),
                Error::ReservedCategory.into(),
                "category {category:?} should be reserved"
            );
        }
    }

    /// The admin is exempt from the policy caps — the curated catalogue still ships
    /// meta-markets, and Genesis is legitimately its own oracle.
    #[test]
    fn admin_is_exempt_from_the_public_policy_caps() {
        let env = odra_test::env();
        let mut vault = deploy_open(&env, 0);
        let admin = env.get_account(0);

        env.set_caller(admin);
        vault.create_market(
            "prophet-race-weekly".to_string(),
            "Which Prophet leads the week?".to_string(),
            "meta".to_string(),
            admin, // own oracle, unapproved, and a meta category
            9_000, // far above MAX_PUBLIC_FEE_BPS
            super::MAX_PUBLIC_DEADLINE_HORIZON_MS * 4,
            yes_no(),
        );
        assert!(vault.market_exists("prophet-race-weekly".to_string()));
    }

    #[test]
    fn public_fee_is_capped() {
        let env = odra_test::env();
        let mut vault = deploy_open(&env, 0);
        let alice = env.get_account(1);
        let arbiter = env.get_account(2);

        env.set_caller(alice);
        assert_eq!(
            vault
                .try_create_market(
                    "honeypot".to_string(),
                    "Will the house take 90%?".to_string(),
                    "casper-native".to_string(),
                    arbiter,
                    9_000,
                    1_000_000,
                    yes_no(),
                )
                .unwrap_err(),
            Error::FeeTooHigh.into()
        );

        // Exactly at the cap is allowed.
        vault.create_market(
            "atcap".to_string(),
            "Fee exactly at the cap?".to_string(),
            "casper-native".to_string(),
            arbiter,
            super::MAX_PUBLIC_FEE_BPS,
            1_000_000,
            yes_no(),
        );
        assert!(vault.market_exists("atcap".to_string()));
    }

    /// Stakes are escrowed until settlement, so an unbounded deadline is an unbounded
    /// lockup of other people's money.
    #[test]
    fn public_deadline_horizon_is_bounded() {
        let env = odra_test::env();
        let mut vault = deploy_open(&env, 0);
        let alice = env.get_account(1);
        let arbiter = env.get_account(2);

        env.set_caller(alice);
        assert_eq!(
            vault
                .try_create_market(
                    "forever".to_string(),
                    "Locked until the heat death?".to_string(),
                    "casper-native".to_string(),
                    arbiter,
                    200,
                    super::MAX_PUBLIC_DEADLINE_HORIZON_MS * 2,
                    yes_no(),
                )
                .unwrap_err(),
            Error::DeadlineTooFar.into()
        );
    }

    /// The cap bounds *concurrently open* markets, so settling one frees the slot — an
    /// honest creator never hits a permanent ceiling.
    #[test]
    fn open_market_cap_is_enforced_and_freed_on_settlement() {
        let env = odra_test::env();
        let mut vault = deploy_open(&env, 0);
        let alice = env.get_account(1);
        let arbiter = env.get_account(2);
        let cap = super::DEFAULT_MAX_OPEN_MARKETS_PER_CREATOR;
        assert_eq!(vault.max_open_markets_per_creator(), cap);

        for i in 0..cap {
            public_create(&mut vault, &env, alice, &format!("m{i}")).unwrap();
        }
        assert_eq!(vault.open_markets_of(alice), cap);
        assert_eq!(
            public_create(&mut vault, &env, alice, "one-too-many").unwrap_err(),
            Error::CreatorMarketCapReached.into()
        );

        // A different creator is unaffected — the cap is per-address.
        public_create(&mut vault, &env, env.get_account(4), "bobs").unwrap();

        // Settling one of Alice's frees exactly one slot.
        env.set_caller(arbiter);
        vault.void("m0".to_string());
        assert_eq!(vault.open_markets_of(alice), cap - 1);
        public_create(&mut vault, &env, alice, "one-too-many").unwrap();
        assert_eq!(vault.open_markets_of(alice), cap);
    }

    #[test]
    fn admin_can_retune_the_open_market_cap() {
        let env = odra_test::env();
        let mut vault = deploy_open(&env, 0);
        let alice = env.get_account(1);

        env.set_caller(alice);
        assert_eq!(
            vault.try_set_max_open_markets_per_creator(1).unwrap_err(),
            Error::NotAdmin.into()
        );

        env.set_caller(env.get_account(0));
        vault.set_max_open_markets_per_creator(1);
        assert_eq!(vault.max_open_markets_per_creator(), 1);

        public_create(&mut vault, &env, alice, "m1").unwrap();
        assert_eq!(
            public_create(&mut vault, &env, alice, "m2").unwrap_err(),
            Error::CreatorMarketCapReached.into()
        );
    }

    /// Structural bounds are input sanity, not policy — they bind the admin too.
    #[test]
    fn structural_field_bounds_apply_to_every_creator() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        let admin = env.get_account(0);
        env.set_caller(admin);

        let long_id = "x".repeat(super::MAX_MARKET_ID_LEN + 1);
        let long_question = "q".repeat(super::MAX_QUESTION_LEN + 1);
        let long_category = "c".repeat(super::MAX_CATEGORY_LEN + 1);
        let long_outcome = "o".repeat(super::MAX_OUTCOME_LEN + 1);
        let too_many: Vec<String> = (0..=super::MAX_OUTCOMES).map(|i| format!("o{i}")).collect();

        let cases: Vec<(&str, String, String, String, Vec<String>)> = vec![
            ("long id", long_id, "q".to_string(), "c".to_string(), yes_no()),
            ("empty id", String::new(), "q".to_string(), "c".to_string(), yes_no()),
            ("long question", "m".to_string(), long_question, "c".to_string(), yes_no()),
            ("empty question", "m".to_string(), String::new(), "c".to_string(), yes_no()),
            ("long category", "m".to_string(), "q".to_string(), long_category, yes_no()),
            ("empty category", "m".to_string(), "q".to_string(), String::new(), yes_no()),
            (
                "long outcome",
                "m".to_string(),
                "q".to_string(),
                "c".to_string(),
                vec!["YES".to_string(), long_outcome],
            ),
            (
                "empty outcome",
                "m".to_string(),
                "q".to_string(),
                "c".to_string(),
                vec!["YES".to_string(), String::new()],
            ),
            ("too many outcomes", "m".to_string(), "q".to_string(), "c".to_string(), too_many),
        ];

        for (label, id, question, category, outcomes) in cases {
            assert_eq!(
                vault
                    .try_create_market(id, question, category, admin, 200, 1_000_000, outcomes)
                    .unwrap_err(),
                Error::InvalidField.into(),
                "{label} should be rejected"
            );
        }
    }

    /// Duplicate keys would collapse two outcome pools into one storage slot.
    #[test]
    fn duplicate_outcome_keys_are_rejected() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        let admin = env.get_account(0);
        env.set_caller(admin);

        assert_eq!(
            vault
                .try_create_market(
                    "dupe".to_string(),
                    "q".to_string(),
                    "casper-native".to_string(),
                    admin,
                    200,
                    1_000_000,
                    vec!["YES".to_string(), "NO".to_string(), "YES".to_string()],
                )
                .unwrap_err(),
            Error::DuplicateOutcome.into()
        );
    }

    /// End-to-end money-path proof: with creation open, Mallory has no path to a market
    /// she can both take bets on and resolve herself.
    #[test]
    fn self_resolution_theft_is_unreachable_end_to_end() {
        let env = odra_test::env();
        let mut vault = deploy_open(&env, 0);
        let mallory = env.get_account(1);
        let arbiter = env.get_account(2);
        let victim = env.get_account(4);

        // Every route to naming herself resolver is closed.
        env.set_caller(mallory);
        for (oracle, expected) in [
            (mallory, Error::SelfOracle),
            (env.get_account(5), Error::OracleNotApproved),
        ] {
            assert_eq!(
                vault
                    .try_create_market(
                        "rug".to_string(),
                        "Will Mallory pay herself?".to_string(),
                        "casper-native".to_string(),
                        oracle,
                        200,
                        1_000_000,
                        yes_no(),
                    )
                    .unwrap_err(),
                expected.into()
            );
        }

        // The only market she can create is bound to the approved arbiter.
        public_create(&mut vault, &env, mallory, "fair").unwrap();
        env.set_caller(victim);
        vault
            .with_tokens(U512::from(100u64))
            .bet("fair".to_string(), "YES".to_string());

        // She cannot resolve it in her own favour.
        env.set_caller(mallory);
        assert_eq!(
            vault
                .try_resolve("fair".to_string(), "NO".to_string())
                .unwrap_err(),
            Error::NotOracle.into()
        );
        assert_eq!(
            vault.try_void("fair".to_string()).unwrap_err(),
            Error::NotOracle.into()
        );

        // Only the bound arbiter settles it, and the victim's stake is intact.
        env.set_caller(arbiter);
        vault.resolve("fair".to_string(), "YES".to_string());
        let victim_before = env.balance_of(&victim);
        env.set_caller(victim);
        vault.claim("fair".to_string());
        assert_eq!(env.balance_of(&victim), victim_before + U512::from(100u64));
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

    // ---- S24: verifiable resolution (recipe + evidence hashes) ----

    #[test]
    fn recipe_hash_commits_then_freezes_on_the_first_bet() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "m1", 200, 0); // account(0) is creator + oracle
        env.set_caller(env.get_account(0));
        vault.commit_recipe("m1".to_string(), "sha256:abc123".to_string());
        assert_eq!(
            vault.recipe_hash_of("m1".to_string()),
            "sha256:abc123".to_string()
        );

        // The first bet freezes the rule.
        env.set_caller(env.get_account(1));
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "YES".to_string());

        env.set_caller(env.get_account(0));
        assert_eq!(
            vault
                .try_commit_recipe("m1".to_string(), "sha256:tampered".to_string())
                .unwrap_err(),
            Error::RecipeLocked.into()
        );
        // The committed hash is unchanged — a bettor's rule cannot be rewritten under them.
        assert_eq!(
            vault.recipe_hash_of("m1".to_string()),
            "sha256:abc123".to_string()
        );
    }

    #[test]
    fn recipe_commit_is_gated_and_validated() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "m1", 200, 0);
        // A stranger (not creator, not admin) cannot commit.
        env.set_caller(env.get_account(2));
        assert_eq!(
            vault
                .try_commit_recipe("m1".to_string(), "sha256:x".to_string())
                .unwrap_err(),
            Error::NotCreator.into()
        );
        // Empty hash is rejected.
        env.set_caller(env.get_account(0));
        assert_eq!(
            vault
                .try_commit_recipe("m1".to_string(), String::new())
                .unwrap_err(),
            Error::InvalidField.into()
        );
    }

    #[test]
    fn evidence_bundle_commits_only_after_settlement_by_the_oracle() {
        let env = odra_test::env();
        let mut vault = deploy(&env, 0);
        create(&mut vault, &env, "m1", 200, 0); // oracle = account(0)
        env.set_caller(env.get_account(1));
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "YES".to_string());
        env.set_caller(env.get_account(2));
        vault
            .with_tokens(U512::from(100u64))
            .bet("m1".to_string(), "NO".to_string());

        // Cannot commit evidence before the market settles.
        env.set_caller(env.get_account(0));
        assert_eq!(
            vault
                .try_commit_bundle("m1".to_string(), "cas:bundle1".to_string())
                .unwrap_err(),
            Error::NotYetSettled.into()
        );

        env.set_caller(env.get_account(0));
        vault.resolve("m1".to_string(), "YES".to_string());

        // A non-oracle cannot commit the bundle.
        env.set_caller(env.get_account(1));
        assert_eq!(
            vault
                .try_commit_bundle("m1".to_string(), "cas:bundle1".to_string())
                .unwrap_err(),
            Error::NotOracle.into()
        );

        // The oracle commits the evidence bundle for the settled outcome.
        env.set_caller(env.get_account(0));
        vault.commit_bundle("m1".to_string(), "cas:bundle1".to_string());
        assert_eq!(
            vault.bundle_hash_of("m1".to_string()),
            "cas:bundle1".to_string()
        );
    }
}
