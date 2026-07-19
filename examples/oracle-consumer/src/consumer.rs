//! Reference oracle consumer — a minimal Casper/Odra contract that binds to a Hunch resolution and
//! acts on the decided outcome. This is the launch case study for S26 (oracle-as-a-service): it
//! shows the *decoupled* integration pattern the `ResolutionHook` contract is built for.
//!
//! Flow:
//!   1. The consumer calls `ResolutionHook::register_hook(market_id)` (once) to subscribe.
//!   2. When Hunch finalises the market, the authorised resolver calls `ResolutionHook::dispatch`,
//!      which emits a `HookNotified{ market_id, consumer, decided_outcome, bundle_hash }` event.
//!   3. An off-chain relayer (or the consumer's own keeper) observes that event and calls
//!      `on_resolution` here with the outcome — the consumer then does its thing (pays out, unlocks
//!      collateral, settles an insurance claim, …).
//!
//! Why observe an event instead of receiving a synchronous callback: it is reentrancy-free and a
//! failing consumer can never block Hunch's settlement (see `contracts/src/resolution_hook.rs`).
//! The consumer authenticates the outcome by fetching the evidence bundle at `bundle_hash` and
//! replaying the recipe (S24) — it trusts the *math*, not our word.
//!
//! NOTE: this is example/reference code shipped in-repo as documentation. It is not part of the
//! deployed contract set and is not built by the workspace gate.

use odra::prelude::*;

#[odra::odra_error]
pub enum Error {
    /// Only the bound relayer may deliver a resolution.
    NotRelayer = 1,
    /// This market's resolution was already applied.
    AlreadyApplied = 2,
}

/// Emitted when the consumer acts on a delivered resolution.
#[odra::event]
pub struct ResolutionApplied {
    pub market_id: String,
    pub outcome: String,
}

#[odra::module(events = [ResolutionApplied], errors = Error)]
pub struct OracleConsumer {
    /// The relayer authorised to deliver resolutions (observes HookNotified, then calls here).
    relayer: Var<Address>,
    /// market -> the outcome we acted on (idempotency).
    applied: Mapping<String, bool>,
    outcome_of: Mapping<String, String>,
}

#[odra::module]
impl OracleConsumer {
    pub fn init(&mut self, relayer: Address) {
        self.relayer.set(relayer);
    }

    /// Deliver a finalised Hunch resolution. Relayer-only, idempotent per market. A real consumer
    /// would additionally verify `bundle_hash` by replaying the recipe before acting.
    pub fn on_resolution(&mut self, market_id: String, outcome: String, _bundle_hash: String) {
        if self.env().caller() != self.relayer.get().unwrap_or_revert(self) {
            self.env().revert(Error::NotRelayer);
        }
        if self.applied.get_or_default(&market_id) {
            self.env().revert(Error::AlreadyApplied);
        }
        self.applied.set(&market_id, true);
        self.outcome_of.set(&market_id, outcome.clone());
        // ... business logic here: pay out, unlock collateral, settle a claim ...
        self.env().emit_event(ResolutionApplied { market_id, outcome });
    }

    /// The outcome this consumer acted on for a market (empty if none).
    pub fn outcome_of(&self, market_id: String) -> String {
        self.outcome_of.get_or_default(&market_id)
    }
}
