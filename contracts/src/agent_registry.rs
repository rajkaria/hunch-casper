//! AgentRegistry — permissionless, bonded on-chain identity for agents.
//!
//! This is the primitive the whole "open the doors" phase rests on. Anyone can stake a CSPR bond
//! and get an identity that their settled bets accrue to; the record is economically verified
//! because building it costs money and faking it costs more.
//!
//! ## Why a bond, and why it is refundable
//!
//! Identity has to cost something or it is not identity — a free registry is a sybil farm, and a
//! reputation score averaged over a thousand throwaway identities means nothing. But the bond is
//! not a fee: an honest agent gets it back. What it buys is that *abandoning* an identity is
//! expensive, which is precisely what a fresh identity after a bad run would be.
//!
//! ## Why deactivation has a cooldown
//!
//! Without one, an agent could deactivate the instant a bad bet settles, reclaim the bond, and
//! re-register clean — laundering its track record for free. The cooldown means the bond stays at
//! risk for a window after the agent stops acting, so slashing can still land on behaviour
//! discovered late (which is when manipulation is usually discovered).
//!
//! ## What this contract deliberately does NOT do
//!
//! It does not compute reputation. PnL, win rate, Brier score and per-category expertise are pure
//! functions of settled markets, computed off-chain in `core/` from chain events — so anyone can
//! recompute them and check. Putting that math on chain would cost gas per bet to produce a number
//! that is already derivable, and would make it *harder* to audit, not easier. The contract owns
//! the two things that must be on chain: who is registered, and whose bond is at risk.
//!
//! Slashing is admin-gated and carries an explicit reason code. That is a real centralisation, and
//! a deliberate one at this stage: the alternative (permissionless slashing) is an attack surface
//! bigger than the one it closes. S25's dispute panel is where slashing authority becomes
//! stake-weighted rather than administrative.
use odra::casper_types::U512;
use odra::prelude::*;

/// Maximum length of an agent's display name — bounded so a registration cannot bloat state.
const MAX_NAME_LEN: usize = 64;
/// Maximum length of an agent's metadata URI.
const MAX_URI_LEN: usize = 256;

/// Errors surfaced by the registry.
#[odra::odra_error]
pub enum Error {
    /// Caller is not the registry admin.
    NotAdmin = 1,
    /// This address already has a registration.
    AlreadyRegistered = 2,
    /// No agent registered at this address.
    UnknownAgent = 3,
    /// Attached value is below the required bond.
    InsufficientBond = 4,
    /// The agent is not active (already deactivating, or withdrawn).
    NotActive = 5,
    /// The cooldown has not elapsed yet.
    CooldownNotElapsed = 6,
    /// Nothing left to withdraw — the bond was slashed, or already returned.
    NothingToWithdraw = 7,
    /// The agent has not started deactivating.
    NotDeactivating = 8,
    /// Name or metadata URI is empty or over the length bound.
    InvalidProfile = 9,
    /// Slash amount exceeds the bond at risk.
    SlashExceedsBond = 10,
}

/// Lifecycle of a registration. A registration is never deleted: the history of who was slashed
/// and why is the point, and a registry you can exit cleanly from is a registry you can launder in.
pub const STATUS_ACTIVE: u8 = 1;
pub const STATUS_DEACTIVATING: u8 = 2;
pub const STATUS_WITHDRAWN: u8 = 3;

/// Why a bond was slashed. Codes rather than free text so an indexer can aggregate them and an
/// operator cannot quietly reclassify an action after the fact.
pub const SLASH_SPAM_MARKETS: u8 = 1;
pub const SLASH_ORACLE_MANIPULATION: u8 = 2;
pub const SLASH_WASH_TRADING: u8 = 3;
pub const SLASH_OTHER: u8 = 9;

/// One agent's on-chain registration.
#[odra::odra_type]
pub struct AgentInfo {
    /// Display name, as it appears on the leaderboards.
    pub name: String,
    /// Metadata URI (docs, strategy description, contact) — advisory, never trusted.
    pub metadata_uri: String,
    /// Bond currently held by the registry for this agent, in motes.
    pub bond: U512,
    /// Total slashed from this agent, in motes. Cumulative and permanent.
    pub slashed: U512,
    /// `STATUS_ACTIVE` / `STATUS_DEACTIVATING` / `STATUS_WITHDRAWN`.
    pub status: u8,
    /// Block time (ms) at which the bond becomes withdrawable. 0 while active.
    pub withdrawable_at: u64,
    /// Block time (ms) the agent registered — the age signal a reputation reader wants.
    pub registered_at: u64,
}

#[odra::event]
pub struct AgentRegistered {
    pub agent: Address,
    pub name: String,
    pub bond: U512,
    pub registered_at: u64,
}

#[odra::event]
pub struct AgentProfileUpdated {
    pub agent: Address,
    pub name: String,
    pub metadata_uri: String,
}

#[odra::event]
pub struct AgentDeactivating {
    pub agent: Address,
    /// When the bond becomes withdrawable.
    pub withdrawable_at: u64,
}

#[odra::event]
pub struct AgentBondWithdrawn {
    pub agent: Address,
    pub amount: U512,
}

#[odra::event]
pub struct AgentSlashed {
    pub agent: Address,
    pub amount: U512,
    /// One of the `SLASH_*` codes.
    pub reason: u8,
    /// Bond remaining after the slash.
    pub remaining: U512,
}

/// The permissionless agent registry.
#[odra::module(
    events = [AgentRegistered, AgentProfileUpdated, AgentDeactivating, AgentBondWithdrawn, AgentSlashed],
    errors = Error
)]
pub struct AgentRegistry {
    admin: Var<Address>,
    /// Treasury that slashed bonds are swept to.
    treasury: Var<Address>,
    /// Minimum bond to register, in motes.
    min_bond: Var<U512>,
    /// Milliseconds a bond stays at risk after deactivation begins.
    cooldown_ms: Var<u64>,

    agents: List<Address>,
    exists: Mapping<Address, bool>,
    info: Mapping<Address, AgentInfo>,
}

#[odra::module]
impl AgentRegistry {
    /// Deployer becomes admin. `min_bond` is what registration stakes; `cooldown_ms` is how long
    /// a bond stays slashable after an agent stops.
    pub fn init(&mut self, treasury: Address, min_bond: U512, cooldown_ms: u64) {
        self.admin.set(self.env().caller());
        self.treasury.set(treasury);
        self.min_bond.set(min_bond);
        self.cooldown_ms.set(cooldown_ms);
    }

    /// Stake a bond and take an on-chain identity. Payable: the attached value is the bond.
    ///
    /// Permissionless by design — that is the entire point of the sprint. The only gate is the
    /// bond, which is what makes an identity cost something without making it a fee.
    #[odra(payable)]
    pub fn register(&mut self, name: String, metadata_uri: String) {
        let caller = self.env().caller();
        if self.exists.get_or_default(&caller) {
            self.env().revert(Error::AlreadyRegistered);
        }
        self.assert_profile(&name, &metadata_uri);
        let bond = self.env().attached_value();
        if bond < self.min_bond.get_or_default() {
            self.env().revert(Error::InsufficientBond);
        }
        let now = self.env().get_block_time();
        self.exists.set(&caller, true);
        self.agents.push(caller);
        self.info.set(
            &caller,
            AgentInfo {
                name: name.clone(),
                metadata_uri,
                bond,
                slashed: U512::zero(),
                status: STATUS_ACTIVE,
                withdrawable_at: 0,
                registered_at: now,
            },
        );
        self.env().emit_event(AgentRegistered {
            agent: caller,
            name,
            bond,
            registered_at: now,
        });
    }

    /// Update your own display name and metadata URI. Self-service: the profile is advisory copy,
    /// never a trust signal, so gating it on the admin would be ceremony without safety.
    pub fn update_profile(&mut self, name: String, metadata_uri: String) {
        let caller = self.env().caller();
        let mut info = self.get_or_revert(&caller);
        if info.status != STATUS_ACTIVE {
            self.env().revert(Error::NotActive);
        }
        self.assert_profile(&name, &metadata_uri);
        info.name = name.clone();
        info.metadata_uri = metadata_uri.clone();
        self.info.set(&caller, info);
        self.env().emit_event(AgentProfileUpdated {
            agent: caller,
            name,
            metadata_uri,
        });
    }

    /// Begin deactivating: stop being an active agent and start the cooldown.
    ///
    /// The bond is NOT returned here. If it were, an agent could deactivate the moment a bad bet
    /// settled, reclaim the stake, and re-register clean — a free track-record launder. Keeping
    /// the bond at risk through the cooldown means slashing can still land on behaviour that is
    /// discovered after the agent stops, which is when manipulation is usually discovered.
    pub fn deactivate(&mut self) {
        let caller = self.env().caller();
        let mut info = self.get_or_revert(&caller);
        if info.status != STATUS_ACTIVE {
            self.env().revert(Error::NotActive);
        }
        let withdrawable_at = self.env().get_block_time() + self.cooldown_ms.get_or_default();
        info.status = STATUS_DEACTIVATING;
        info.withdrawable_at = withdrawable_at;
        self.info.set(&caller, info);
        self.env().emit_event(AgentDeactivating {
            agent: caller,
            withdrawable_at,
        });
    }

    /// Withdraw the bond once the cooldown has elapsed. Returns whatever survived slashing.
    pub fn withdraw_bond(&mut self) {
        let caller = self.env().caller();
        let mut info = self.get_or_revert(&caller);
        if info.status != STATUS_DEACTIVATING {
            self.env().revert(Error::NotDeactivating);
        }
        if self.env().get_block_time() < info.withdrawable_at {
            self.env().revert(Error::CooldownNotElapsed);
        }
        let amount = info.bond;
        if amount.is_zero() {
            self.env().revert(Error::NothingToWithdraw);
        }
        // Zero the bond and mark withdrawn BEFORE transferring: the state must not still say
        // "withdrawable" while the transfer is in flight.
        info.bond = U512::zero();
        info.status = STATUS_WITHDRAWN;
        self.info.set(&caller, info);
        self.env().transfer_tokens(&caller, &amount);
        self.env().emit_event(AgentBondWithdrawn {
            agent: caller,
            amount,
        });
    }

    /// Admin-only: slash part or all of an agent's bond to the treasury, with a reason code.
    ///
    /// Works on a deactivating agent as well as an active one — that is what the cooldown is for.
    pub fn slash(&mut self, agent: Address, amount: U512, reason: u8) {
        self.assert_admin();
        let mut info = self.get_or_revert(&agent);
        if amount.is_zero() || amount > info.bond {
            self.env().revert(Error::SlashExceedsBond);
        }
        info.bond -= amount;
        info.slashed += amount;
        let remaining = info.bond;
        self.info.set(&agent, info);
        let treasury = self.treasury.get().unwrap_or_revert(self);
        self.env().transfer_tokens(&treasury, &amount);
        self.env().emit_event(AgentSlashed {
            agent,
            amount,
            reason,
            remaining,
        });
    }

    /// Admin-only: change the bond required of NEW registrations. Existing bonds are untouched —
    /// retroactively raising a stake someone already posted would be a rug.
    pub fn set_min_bond(&mut self, min_bond: U512) {
        self.assert_admin();
        self.min_bond.set(min_bond);
    }

    /// Admin-only: change the cooldown applied to FUTURE deactivations. An agent already
    /// deactivating keeps the window it entered under.
    pub fn set_cooldown_ms(&mut self, cooldown_ms: u64) {
        self.assert_admin();
        self.cooldown_ms.set(cooldown_ms);
    }

    // ---- reads ----

    /// Whether an address has ever registered (including withdrawn agents).
    pub fn is_registered(&self, agent: Address) -> bool {
        self.exists.get_or_default(&agent)
    }

    /// Whether an agent may act right now — the check the rails make.
    pub fn is_active(&self, agent: Address) -> bool {
        self.info
            .get(&agent)
            .map(|i| i.status == STATUS_ACTIVE)
            .unwrap_or(false)
    }

    pub fn get_agent(&self, agent: Address) -> AgentInfo {
        self.get_or_revert(&agent)
    }

    pub fn bond_of(&self, agent: Address) -> U512 {
        self.info.get(&agent).map(|i| i.bond).unwrap_or_else(U512::zero)
    }

    pub fn agent_count(&self) -> u32 {
        self.agents.len()
    }

    pub fn agent_at(&self, index: u32) -> Address {
        self.agents.get(index).unwrap_or_revert_with(self, Error::UnknownAgent)
    }

    pub fn min_bond(&self) -> U512 {
        self.min_bond.get_or_default()
    }

    pub fn cooldown_ms(&self) -> u64 {
        self.cooldown_ms.get_or_default()
    }

    pub fn admin(&self) -> Address {
        self.admin.get().unwrap_or_revert(self)
    }

    pub fn treasury(&self) -> Address {
        self.treasury.get().unwrap_or_revert(self)
    }

    // ---- internals ----

    fn assert_admin(&self) {
        if self.env().caller() != self.admin.get().unwrap_or_revert(self) {
            self.env().revert(Error::NotAdmin);
        }
    }

    fn assert_profile(&self, name: &str, metadata_uri: &str) {
        let name_len = name.trim().len();
        if name_len == 0 || name.len() > MAX_NAME_LEN || metadata_uri.len() > MAX_URI_LEN {
            self.env().revert(Error::InvalidProfile);
        }
    }

    fn get_or_revert(&self, agent: &Address) -> AgentInfo {
        self.info
            .get(agent)
            .unwrap_or_revert_with(self, Error::UnknownAgent)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AgentBondWithdrawn, AgentRegistered, AgentRegistry, AgentRegistryHostRef,
        AgentRegistryInitArgs, AgentSlashed, Error, SLASH_WASH_TRADING, STATUS_ACTIVE,
        STATUS_DEACTIVATING, STATUS_WITHDRAWN,
    };
    use odra::casper_types::U512;
    use odra::host::{Deployer, HostEnv, HostRef};
    use odra::prelude::*;

    const BOND: u64 = 100_000_000_000; // 100 CSPR
    const COOLDOWN_MS: u64 = 7 * 24 * 60 * 60 * 1000; // 7 days

    fn deploy(env: &HostEnv) -> AgentRegistryHostRef {
        env.set_caller(env.get_account(0));
        AgentRegistry::deploy(
            env,
            AgentRegistryInitArgs {
                treasury: env.get_account(9),
                min_bond: U512::from(BOND),
                cooldown_ms: COOLDOWN_MS,
            },
        )
    }

    fn register(env: &HostEnv, reg: &mut AgentRegistryHostRef, account: Address, name: &str) {
        env.set_caller(account);
        reg.with_tokens(U512::from(BOND))
            .register(name.to_string(), "https://example.test/agent".to_string());
    }

    #[test]
    fn registration_is_permissionless_and_bonded() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let agent = env.get_account(1);

        assert_eq!(reg.agent_count(), 0);
        register(&env, &mut reg, agent, "Alpha");

        assert_eq!(reg.agent_count(), 1);
        assert!(reg.is_registered(agent));
        assert!(reg.is_active(agent));
        assert_eq!(reg.bond_of(agent), U512::from(BOND));
        assert_eq!(reg.get_agent(agent).status, STATUS_ACTIVE);
        assert_eq!(reg.agent_at(0), agent);
        assert!(env.emitted_event(
            &reg,
            AgentRegistered {
                agent,
                name: "Alpha".to_string(),
                bond: U512::from(BOND),
                registered_at: reg.get_agent(agent).registered_at,
            }
        ));
    }

    #[test]
    fn a_bond_below_the_minimum_is_rejected() {
        // Identity has to cost something or it is not identity.
        let env = odra_test::env();
        let mut reg = deploy(&env);
        env.set_caller(env.get_account(1));
        assert_eq!(
            reg.with_tokens(U512::from(BOND - 1))
                .try_register("Cheap".to_string(), "u".to_string())
                .unwrap_err(),
            Error::InsufficientBond.into()
        );
        assert_eq!(reg.agent_count(), 0);
    }

    #[test]
    fn one_registration_per_address() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let agent = env.get_account(1);
        register(&env, &mut reg, agent, "Alpha");
        env.set_caller(agent);
        assert_eq!(
            reg.with_tokens(U512::from(BOND))
                .try_register("Alpha again".to_string(), "u".to_string())
                .unwrap_err(),
            Error::AlreadyRegistered.into()
        );
    }

    #[test]
    fn profiles_are_bounded_and_self_service() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let agent = env.get_account(1);
        register(&env, &mut reg, agent, "Alpha");

        env.set_caller(agent);
        reg.update_profile("Alpha v2".to_string(), "https://example.test/v2".to_string());
        assert_eq!(reg.get_agent(agent).name, "Alpha v2".to_string());

        // Empty and over-long names are rejected: state bloat and blank leaderboard rows.
        assert_eq!(
            reg.try_update_profile("   ".to_string(), "u".to_string()).unwrap_err(),
            Error::InvalidProfile.into()
        );
        assert_eq!(
            reg.try_update_profile("x".repeat(65), "u".to_string()).unwrap_err(),
            Error::InvalidProfile.into()
        );
    }

    #[test]
    fn deactivation_does_not_return_the_bond_immediately() {
        // The launder this prevents: deactivate the moment a bad bet settles, reclaim the stake,
        // re-register clean, and the track record is gone for free.
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let agent = env.get_account(1);
        register(&env, &mut reg, agent, "Alpha");

        env.set_caller(agent);
        reg.deactivate();
        assert_eq!(reg.get_agent(agent).status, STATUS_DEACTIVATING);
        assert_eq!(reg.bond_of(agent), U512::from(BOND)); // still at risk
        assert!(!reg.is_active(agent));
        assert_eq!(reg.try_withdraw_bond().unwrap_err(), Error::CooldownNotElapsed.into());
    }

    #[test]
    fn the_bond_returns_after_the_cooldown() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let agent = env.get_account(1);
        register(&env, &mut reg, agent, "Alpha");

        env.set_caller(agent);
        reg.deactivate();
        env.advance_block_time(COOLDOWN_MS + 1);
        reg.withdraw_bond();

        assert_eq!(reg.bond_of(agent), U512::zero());
        assert_eq!(reg.get_agent(agent).status, STATUS_WITHDRAWN);
        assert!(env.emitted_event(
            &reg,
            AgentBondWithdrawn {
                agent,
                amount: U512::from(BOND),
            }
        ));
        // …and not twice.
        assert_eq!(reg.try_withdraw_bond().unwrap_err(), Error::NotDeactivating.into());
    }

    #[test]
    fn slashing_moves_the_bond_to_the_treasury_with_a_reason() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let agent = env.get_account(1);
        let treasury = env.get_account(9);
        register(&env, &mut reg, agent, "Alpha");

        let before = env.balance_of(&treasury);
        env.set_caller(env.get_account(0));
        let slash = U512::from(BOND / 4);
        reg.slash(agent, slash, SLASH_WASH_TRADING);

        assert_eq!(reg.bond_of(agent), U512::from(BOND) - slash);
        assert_eq!(reg.get_agent(agent).slashed, slash);
        assert_eq!(env.balance_of(&treasury), before + slash);
        assert!(env.emitted_event(
            &reg,
            AgentSlashed {
                agent,
                amount: slash,
                reason: SLASH_WASH_TRADING,
                remaining: U512::from(BOND) - slash,
            }
        ));
    }

    #[test]
    fn a_deactivating_agent_can_still_be_slashed() {
        // Manipulation is usually discovered after the fact — that is what the cooldown is for.
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let agent = env.get_account(1);
        register(&env, &mut reg, agent, "Alpha");
        env.set_caller(agent);
        reg.deactivate();

        env.set_caller(env.get_account(0));
        reg.slash(agent, U512::from(BOND), SLASH_WASH_TRADING);
        assert_eq!(reg.bond_of(agent), U512::zero());

        // With nothing left, the withdrawal has nothing to return.
        env.set_caller(agent);
        env.advance_block_time(COOLDOWN_MS + 1);
        assert_eq!(reg.try_withdraw_bond().unwrap_err(), Error::NothingToWithdraw.into());
    }

    #[test]
    fn slashing_is_admin_only_and_bounded_by_the_bond() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let agent = env.get_account(1);
        register(&env, &mut reg, agent, "Alpha");

        env.set_caller(env.get_account(2));
        assert_eq!(
            reg.try_slash(agent, U512::from(1u64), SLASH_WASH_TRADING).unwrap_err(),
            Error::NotAdmin.into()
        );

        env.set_caller(env.get_account(0));
        assert_eq!(
            reg.try_slash(agent, U512::from(BOND + 1), SLASH_WASH_TRADING).unwrap_err(),
            Error::SlashExceedsBond.into()
        );
        assert_eq!(
            reg.try_slash(agent, U512::zero(), SLASH_WASH_TRADING).unwrap_err(),
            Error::SlashExceedsBond.into()
        );
    }

    #[test]
    fn raising_the_minimum_bond_does_not_touch_existing_agents() {
        // Retroactively raising a stake someone already posted would be a rug.
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let agent = env.get_account(1);
        register(&env, &mut reg, agent, "Alpha");

        env.set_caller(env.get_account(0));
        reg.set_min_bond(U512::from(BOND * 10));
        assert_eq!(reg.bond_of(agent), U512::from(BOND));
        assert!(reg.is_active(agent));

        // A new agent faces the new floor.
        env.set_caller(env.get_account(2));
        assert_eq!(
            reg.with_tokens(U512::from(BOND))
                .try_register("Bravo".to_string(), "u".to_string())
                .unwrap_err(),
            Error::InsufficientBond.into()
        );
    }

    #[test]
    fn an_agent_already_deactivating_keeps_the_window_it_entered_under() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let agent = env.get_account(1);
        register(&env, &mut reg, agent, "Alpha");
        env.set_caller(agent);
        reg.deactivate();
        let promised = reg.get_agent(agent).withdrawable_at;

        env.set_caller(env.get_account(0));
        reg.set_cooldown_ms(COOLDOWN_MS * 100);
        assert_eq!(reg.get_agent(agent).withdrawable_at, promised);

        env.set_caller(agent);
        env.advance_block_time(COOLDOWN_MS + 1);
        reg.withdraw_bond(); // the promise holds
    }

    #[test]
    fn unknown_agents_read_as_absent_rather_than_reverting_on_the_hot_path() {
        let env = odra_test::env();
        let reg = deploy(&env);
        let stranger = env.get_account(3);
        // The rails call these on every request; they must answer, not revert.
        assert!(!reg.is_registered(stranger));
        assert!(!reg.is_active(stranger));
        assert_eq!(reg.bond_of(stranger), U512::zero());
    }

    #[test]
    fn many_agents_register_independently() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        for i in 1..=5u32 {
            register(&env, &mut reg, env.get_account(i as usize), &format!("Agent{i}"));
        }
        assert_eq!(reg.agent_count(), 5);
        for i in 1..=5u32 {
            assert!(reg.is_active(env.get_account(i as usize)));
        }
        // Slashing one leaves the others untouched.
        env.set_caller(env.get_account(0));
        reg.slash(env.get_account(1), U512::from(BOND), SLASH_WASH_TRADING);
        assert_eq!(reg.bond_of(env.get_account(1)), U512::zero());
        assert_eq!(reg.bond_of(env.get_account(2)), U512::from(BOND));
    }
}
