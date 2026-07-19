//! ResolutionHook — bind other Casper contracts to a Hunch resolution (S26, oracle-as-a-service).
//!
//! A consumer protocol (a lending market that liquidates on an event, an insurance pool that pays
//! out on an outcome) registers a hook against a `market_id`. When Hunch finalises that market, the
//! authorised resolver calls `dispatch`, which notifies every registered hook with the decided
//! outcome and the evidence-bundle hash.
//!
//! # Why event-emit dispatch, not synchronous callbacks
//!
//! Dispatch **emits an event per hook** rather than making a synchronous cross-contract call, and
//! this is deliberate — it is what makes the two required safety properties true *by construction*:
//!
//!   * **Reentrancy-safe:** `dispatch` marks the market dispatched (effects) BEFORE emitting
//!     (interactions), and makes no external call, so there is nothing to re-enter. A consumer
//!     reacts to the event in its own transaction, on its own gas.
//!   * **A failing consumer cannot block settlement:** because dispatch never calls a consumer
//!     synchronously, a consumer that would revert simply fails to act on the event — Hunch's
//!     settlement is already committed. One broken consumer can never wedge the oracle for everyone.
//!
//! Consumers subscribe to `HookNotified` (via CSPR.cloud / an indexer) and pull the outcome. This
//! is the same decoupled pattern robust oracles use precisely to avoid the callback-reentrancy and
//! griefing-via-revert classes of bug. `dispatch` is idempotent per market (`AlreadyDispatched`),
//! so a retried finalisation cannot double-fire a hook.
use odra::prelude::*;

#[odra::odra_error]
pub enum Error {
    /// Caller is not the authorised resolver.
    NotResolver = 1,
    /// This market has already been dispatched — hooks fire at most once.
    AlreadyDispatched = 2,
    /// A hook for this (market, consumer) is already registered.
    HookExists = 3,
    /// Field exceeded its bound or was empty.
    InvalidField = 4,
}

const MAX_MARKET_ID_LEN: usize = 64;
const MAX_HASH_LEN: usize = 96;

/// Emitted when a consumer registers a hook.
#[odra::event]
pub struct HookRegistered {
    pub market_id: String,
    pub consumer: Address,
}

/// Emitted for each registered hook when a market is dispatched. Consumers act on this.
#[odra::event]
pub struct HookNotified {
    pub market_id: String,
    pub consumer: Address,
    pub decided_outcome: String,
    pub bundle_hash: String,
}

/// Emitted once per market when dispatch runs.
#[odra::event]
pub struct MarketDispatched {
    pub market_id: String,
    pub decided_outcome: String,
    pub hook_count: u32,
}

#[odra::module(
    events = [HookRegistered, HookNotified, MarketDispatched],
    errors = Error
)]
pub struct ResolutionHook {
    /// The authorised resolver (the Hunch operator / vault) allowed to dispatch.
    resolver: Var<Address>,
    /// market -> registered consumer addresses.
    hooks: Mapping<String, Vec<Address>>,
    /// (market, consumer) -> registered, so a consumer can't double-register the same market.
    registered: Mapping<(String, Address), bool>,
    /// market -> already dispatched (idempotency + reentrancy guard).
    dispatched: Mapping<String, bool>,
}

#[odra::module]
impl ResolutionHook {
    /// Initialize with the deploying account as the authorised resolver.
    pub fn init(&mut self) {
        self.resolver.set(self.env().caller());
    }

    /// Register the caller's contract as a hook for `market_id`. Permissionless — any consumer may
    /// bind to any market's resolution. Reverts if this consumer already registered this market.
    pub fn register_hook(&mut self, market_id: String) {
        if market_id.is_empty() || market_id.len() > MAX_MARKET_ID_LEN {
            self.env().revert(Error::InvalidField);
        }
        let consumer = self.env().caller();
        let key = (market_id.clone(), consumer);
        if self.registered.get_or_default(&key) {
            self.env().revert(Error::HookExists);
        }
        self.registered.set(&key, true);
        let mut list = self.hooks.get_or_default(&market_id);
        list.push(consumer);
        self.hooks.set(&market_id, list);
        self.env().emit_event(HookRegistered { market_id, consumer });
    }

    /// Resolver-only: fire every hook registered for a finalised market. Idempotent per market.
    ///
    /// Checks-effects-interactions: the dispatched flag is set (effect) before any event is emitted
    /// (interaction), and no external contract is called, so there is no reentrancy surface and a
    /// consumer that would fail cannot block this call.
    pub fn dispatch(&mut self, market_id: String, decided_outcome: String, bundle_hash: String) {
        if self.env().caller() != self.resolver.get().unwrap_or_revert(self) {
            self.env().revert(Error::NotResolver);
        }
        if self.dispatched.get_or_default(&market_id) {
            self.env().revert(Error::AlreadyDispatched);
        }
        if decided_outcome.is_empty()
            || decided_outcome.len() > MAX_MARKET_ID_LEN
            || bundle_hash.len() > MAX_HASH_LEN
        {
            self.env().revert(Error::InvalidField);
        }
        // EFFECT first — reentrancy guard set before any interaction.
        self.dispatched.set(&market_id, true);

        let hooks = self.hooks.get_or_default(&market_id);
        for consumer in hooks.iter() {
            self.env().emit_event(HookNotified {
                market_id: market_id.clone(),
                consumer: *consumer,
                decided_outcome: decided_outcome.clone(),
                bundle_hash: bundle_hash.clone(),
            });
        }
        self.env().emit_event(MarketDispatched {
            market_id,
            decided_outcome,
            hook_count: hooks.len() as u32,
        });
    }

    // ---- reads ----

    /// Number of hooks registered for a market.
    pub fn hook_count(&self, market_id: String) -> u32 {
        self.hooks.get_or_default(&market_id).len() as u32
    }

    /// Whether a market has already been dispatched.
    pub fn is_dispatched(&self, market_id: String) -> bool {
        self.dispatched.get_or_default(&market_id)
    }

    /// Whether a specific consumer is hooked to a market.
    pub fn is_registered(&self, market_id: String, consumer: Address) -> bool {
        self.registered.get_or_default(&(market_id, consumer))
    }

    /// The authorised resolver.
    pub fn resolver(&self) -> Address {
        self.resolver.get().unwrap_or_revert(self)
    }
}

#[cfg(test)]
mod tests {
    use super::{Error, ResolutionHook, ResolutionHookHostRef};
    use odra::host::{Deployer, HostEnv, HostRef, NoArgs};

    fn deploy(env: &HostEnv) -> ResolutionHookHostRef {
        env.set_caller(env.get_account(0)); // account(0) is the authorised resolver
        ResolutionHook::deploy(env, NoArgs)
    }

    #[test]
    fn consumers_register_and_dispatch_notifies_all_once() {
        let env = odra_test::env();
        let mut hook = deploy(&env);
        let consumer_a = env.get_account(1);
        let consumer_b = env.get_account(2);

        env.set_caller(consumer_a);
        hook.register_hook("m1".to_string());
        env.set_caller(consumer_b);
        hook.register_hook("m1".to_string());
        assert_eq!(hook.hook_count("m1".to_string()), 2);
        assert!(hook.is_registered("m1".to_string(), consumer_a));

        // Resolver dispatches once.
        env.set_caller(env.get_account(0));
        hook.dispatch("m1".to_string(), "YES".to_string(), "sha256:bundle".to_string());
        assert!(hook.is_dispatched("m1".to_string()));

        // A second dispatch reverts — hooks fire at most once.
        assert_eq!(
            hook.try_dispatch("m1".to_string(), "YES".to_string(), "sha256:bundle".to_string())
                .unwrap_err(),
            Error::AlreadyDispatched.into()
        );
    }

    #[test]
    fn only_the_resolver_may_dispatch() {
        let env = odra_test::env();
        let mut hook = deploy(&env);
        env.set_caller(env.get_account(1));
        hook.register_hook("m1".to_string());
        // A non-resolver cannot dispatch.
        assert_eq!(
            hook.try_dispatch("m1".to_string(), "YES".to_string(), "sha256:b".to_string())
                .unwrap_err(),
            Error::NotResolver.into()
        );
    }

    #[test]
    fn a_market_with_no_hooks_dispatches_cleanly() {
        let env = odra_test::env();
        let mut hook = deploy(&env);
        env.set_caller(env.get_account(0));
        // No consumer ever registered — dispatch still succeeds and marks the market done.
        hook.dispatch("m-empty".to_string(), "NO".to_string(), String::new());
        assert!(hook.is_dispatched("m-empty".to_string()));
        assert_eq!(hook.hook_count("m-empty".to_string()), 0);
    }

    #[test]
    fn double_registration_reverts() {
        let env = odra_test::env();
        let mut hook = deploy(&env);
        env.set_caller(env.get_account(1));
        hook.register_hook("m1".to_string());
        assert_eq!(
            hook.try_register_hook("m1".to_string()).unwrap_err(),
            Error::HookExists.into()
        );
    }
}
