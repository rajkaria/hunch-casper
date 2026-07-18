//! MarketFactory — the on-chain **registry** of Hunch markets on Casper.
//!
//! Rather than deploying child contracts on-chain (Odra's `factory=on` feature is not
//! executable on the OdraVM test backend, so it can't be covered by the green gate), the
//! factory is an admin-gated registry: the Genesis agent deploys a `ParimutuelMarket`,
//! then registers its address + metadata here. This contract is the economy's on-chain
//! source of truth for *what markets exist* — exactly what the MCP `list_markets` tool and
//! the off-chain adapter read. It emits an event per registration so indexers/CSPR.cloud
//! can follow the swarm in real time.
use odra::prelude::*;

/// Errors surfaced by the factory.
#[odra::odra_error]
pub enum Error {
    /// Caller is not the factory admin (the Genesis agent).
    NotAdmin = 1,
    /// A market with this id is already registered.
    DuplicateId = 2,
    /// No market registered under this id.
    UnknownId = 3,
    /// v2 vault address not configured — call `set_vault` first.
    VaultNotSet = 4,
}

/// On-chain metadata for a registered market.
#[odra::odra_type]
pub struct MarketInfo {
    /// Stable market id (the catalogue slug).
    pub id: String,
    /// Human-readable question.
    pub question: String,
    /// Catalogue category (casper-native / provably-fair / rwa / meta).
    pub category: String,
    /// Address of the deployed `ParimutuelMarket`.
    pub market_address: Address,
    /// Block time (ms) after which betting closes.
    pub deadline: u64,
    /// Whether the Arbiter has resolved it.
    pub resolved: bool,
}

/// Emitted when a market is registered.
#[odra::event]
pub struct MarketRegistered {
    /// Market id.
    pub id: String,
    /// Deployed market contract address.
    pub market_address: Address,
    /// Catalogue category.
    pub category: String,
}

/// Emitted when a market is flagged resolved in the registry.
#[odra::event]
pub struct MarketResolvedInRegistry {
    /// Market id.
    pub id: String,
}

/// The registry.
#[odra::module(
    events = [MarketRegistered, MarketResolvedInRegistry],
    errors = Error
)]
pub struct MarketFactory {
    admin: Var<Address>,
    ids: List<String>,
    info: Mapping<String, MarketInfo>,
    exists: Mapping<String, bool>,
    /// v2: the singleton `HunchVault` every new market lives in (no more installs).
    vault: Var<Address>,
}

#[odra::module]
impl MarketFactory {
    /// Initialize with the deploying account as admin (the Genesis agent key).
    pub fn init(&mut self) {
        self.admin.set(self.env().caller());
    }

    /// Admin-only: register a freshly deployed market.
    pub fn register_market(
        &mut self,
        id: String,
        question: String,
        category: String,
        market_address: Address,
        deadline: u64,
    ) {
        self.assert_admin();
        if self.exists.get_or_default(&id) {
            self.env().revert(Error::DuplicateId);
        }
        self.exists.set(&id, true);
        self.ids.push(id.clone());
        self.info.set(
            &id,
            MarketInfo {
                id: id.clone(),
                question,
                category: category.clone(),
                market_address,
                deadline,
                resolved: false,
            },
        );
        self.env().emit_event(MarketRegistered {
            id,
            market_address,
            category,
        });
    }

    /// Admin-only (v2): point the registry at the singleton `HunchVault`.
    pub fn set_vault(&mut self, vault: Address) {
        self.assert_admin();
        self.vault.set(vault);
    }

    /// The configured v2 vault address. Reverts until `set_vault` is called.
    pub fn vault(&self) -> Address {
        self.vault.get().unwrap_or_revert_with(self, Error::VaultNotSet)
    }

    /// Admin-only (v2): register a market that lives **inside the vault** — the id is
    /// the vault market key and `market_address` is the vault itself, so creation is
    /// an entrypoint call instead of a per-market Wasm install.
    pub fn register_vault_market(
        &mut self,
        id: String,
        question: String,
        category: String,
        deadline: u64,
    ) {
        let vault = self.vault.get().unwrap_or_revert_with(self, Error::VaultNotSet);
        self.register_market(id, question, category, vault, deadline);
    }

    /// Admin-only: flag a market resolved in the registry.
    pub fn mark_resolved(&mut self, id: String) {
        self.assert_admin();
        let mut info = self.get_market_or_revert(&id);
        info.resolved = true;
        self.info.set(&id, info);
        self.env().emit_event(MarketResolvedInRegistry { id });
    }

    /// Number of registered markets.
    pub fn market_count(&self) -> u32 {
        self.ids.len()
    }

    /// Market id at an index (0-based, insertion order).
    pub fn market_id_at(&self, index: u32) -> String {
        self.ids.get(index).unwrap_or_revert_with(self, Error::UnknownId)
    }

    /// Full metadata for a market id.
    pub fn get_market(&self, id: String) -> MarketInfo {
        self.get_market_or_revert(&id)
    }

    /// Whether a market id is registered.
    pub fn is_registered(&self, id: String) -> bool {
        self.exists.get_or_default(&id)
    }

    /// The factory admin (Genesis agent).
    pub fn admin(&self) -> Address {
        self.admin.get().unwrap_or_revert(self)
    }

    // ---- internals ----

    fn assert_admin(&self) {
        if self.env().caller() != self.admin.get().unwrap_or_revert(self) {
            self.env().revert(Error::NotAdmin);
        }
    }

    fn get_market_or_revert(&self, id: &String) -> MarketInfo {
        self.info.get(id).unwrap_or_revert_with(self, Error::UnknownId)
    }
}

#[cfg(test)]
mod tests {
    use super::{Error, MarketFactory, MarketRegistered, MarketFactoryHostRef};
    use odra::host::{Deployer, HostEnv, NoArgs};
    use odra::prelude::*;

    fn deploy(env: &HostEnv) -> MarketFactoryHostRef {
        env.set_caller(env.get_account(0));
        MarketFactory::deploy(env, NoArgs)
    }

    fn some_market_address(env: &HostEnv) -> Address {
        // Any address works as the registered target; reuse an account address.
        env.get_account(9)
    }

    #[test]
    fn registers_and_reads_back() {
        let env = odra_test::env();
        let mut factory = deploy(&env);
        let market = some_market_address(&env);

        assert_eq!(factory.market_count(), 0);
        assert_eq!(factory.admin(), env.get_account(0));

        factory.register_market(
            "cspr-hourly-updown".to_string(),
            "Will CSPR close up this hour?".to_string(),
            "casper-native".to_string(),
            market,
            1_000_000,
        );

        assert_eq!(factory.market_count(), 1);
        assert!(factory.is_registered("cspr-hourly-updown".to_string()));
        assert_eq!(factory.market_id_at(0), "cspr-hourly-updown".to_string());

        let info = factory.get_market("cspr-hourly-updown".to_string());
        assert_eq!(info.category, "casper-native".to_string());
        assert_eq!(info.market_address, market);
        assert!(!info.resolved);

        assert!(env.emitted_event(
            &factory,
            MarketRegistered {
                id: "cspr-hourly-updown".to_string(),
                market_address: market,
                category: "casper-native".to_string(),
            }
        ));
    }

    #[test]
    fn duplicate_id_reverts() {
        let env = odra_test::env();
        let mut factory = deploy(&env);
        let market = some_market_address(&env);
        factory.register_market(
            "dup".to_string(),
            "q".to_string(),
            "meta".to_string(),
            market,
            1,
        );
        assert_eq!(
            factory
                .try_register_market(
                    "dup".to_string(),
                    "q2".to_string(),
                    "meta".to_string(),
                    market,
                    2,
                )
                .unwrap_err(),
            Error::DuplicateId.into()
        );
    }

    #[test]
    fn non_admin_register_reverts() {
        let env = odra_test::env();
        let mut factory = deploy(&env);
        let market = some_market_address(&env);
        env.set_caller(env.get_account(1));
        assert_eq!(
            factory
                .try_register_market(
                    "x".to_string(),
                    "q".to_string(),
                    "rwa".to_string(),
                    market,
                    1,
                )
                .unwrap_err(),
            Error::NotAdmin.into()
        );
    }

    #[test]
    fn mark_resolved_updates_flag() {
        let env = odra_test::env();
        let mut factory = deploy(&env);
        let market = some_market_address(&env);
        factory.register_market(
            "r".to_string(),
            "q".to_string(),
            "provably-fair".to_string(),
            market,
            1,
        );
        factory.mark_resolved("r".to_string());
        assert!(factory.get_market("r".to_string()).resolved);
    }

    #[test]
    fn vault_registration_uses_configured_vault_address() {
        let env = odra_test::env();
        let mut factory = deploy(&env);
        let vault = env.get_account(8);

        // Unset vault → both the read and v2 registration revert.
        assert_eq!(factory.try_vault().unwrap_err(), Error::VaultNotSet.into());
        assert_eq!(
            factory
                .try_register_vault_market(
                    "v2-market".to_string(),
                    "q".to_string(),
                    "meta".to_string(),
                    1_000,
                )
                .unwrap_err(),
            Error::VaultNotSet.into()
        );

        factory.set_vault(vault);
        assert_eq!(factory.vault(), vault);
        factory.register_vault_market(
            "v2-market".to_string(),
            "q".to_string(),
            "meta".to_string(),
            1_000,
        );
        let info = factory.get_market("v2-market".to_string());
        assert_eq!(info.market_address, vault);
        assert!(factory.is_registered("v2-market".to_string()));
    }

    #[test]
    fn non_admin_set_vault_and_v2_register_revert() {
        let env = odra_test::env();
        let mut factory = deploy(&env);
        let vault = env.get_account(8);
        factory.set_vault(vault);
        env.set_caller(env.get_account(1));
        assert_eq!(
            factory.try_set_vault(vault).unwrap_err(),
            Error::NotAdmin.into()
        );
        assert_eq!(
            factory
                .try_register_vault_market(
                    "x".to_string(),
                    "q".to_string(),
                    "meta".to_string(),
                    1,
                )
                .unwrap_err(),
            Error::NotAdmin.into()
        );
    }

    #[test]
    fn unknown_id_reverts() {
        let env = odra_test::env();
        let factory = deploy(&env);
        assert_eq!(
            factory.try_get_market("nope".to_string()).unwrap_err(),
            Error::UnknownId.into()
        );
    }
}
