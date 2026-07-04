//! OracleRegistry — on-chain oracle identity + reputation for the Hunch economy on Casper.
//!
//! This is the RWA-oracle thesis made concrete: the Arbiter agent carries an on-chain identity
//! and a reputation score that is updated on every resolution. Because a wrong resolution costs
//! bettors real money, that accuracy score has economic teeth — it is the trust signal other
//! protocols (and our own meta-markets, e.g. "arbiter-accuracy-95") read.
//!
//! Design (mirrors the `MarketFactory` registry pattern so it is fully OdraVM-testable):
//!   * an admin (the economy operator / Genesis key) registers oracle identities and records the
//!     accuracy of each resolution — recording is admin-gated because "was this resolution
//!     correct?" is a confirmation decision, not something the oracle grades for itself;
//!   * reputation is pure counting: `accuracy_bps = accurate * 10_000 / resolved` — deterministic,
//!     never an LLM;
//!   * a resolution can be recorded at most once per (oracle, market) so the score can't be
//!     stuffed. Every registration + record emits an event so CSPR.cloud/indexers can follow the
//!     oracle's track record in real time.
use odra::prelude::*;

const BPS_DENOMINATOR: u64 = 10_000;

/// Errors surfaced by the registry.
#[odra::odra_error]
pub enum Error {
    /// Caller is not the registry admin.
    NotAdmin = 1,
    /// An oracle with this address is already registered.
    DuplicateOracle = 2,
    /// No oracle registered at this address.
    UnknownOracle = 3,
    /// This (oracle, market) resolution was already recorded.
    AlreadyRecorded = 4,
}

/// On-chain identity + reputation counters for one oracle.
#[odra::odra_type]
pub struct OracleInfo {
    /// Human-readable oracle name (e.g. "Arbiter").
    pub name: String,
    /// Total resolutions recorded for this oracle.
    pub resolved: u64,
    /// Of those, how many were confirmed accurate.
    pub accurate: u64,
}

/// Emitted when an oracle identity is registered.
#[odra::event]
pub struct OracleRegistered {
    /// Oracle account.
    pub oracle: Address,
    /// Oracle name.
    pub name: String,
}

/// Emitted when a resolution's accuracy is recorded against an oracle.
#[odra::event]
pub struct ResolutionRecorded {
    /// Oracle account.
    pub oracle: Address,
    /// Market id the resolution was for.
    pub market_id: String,
    /// Whether the resolution was confirmed accurate.
    pub accurate: bool,
    /// The oracle's running accuracy after this record, in basis points.
    pub accuracy_bps: u32,
}

/// The reputation registry.
#[odra::module(
    events = [OracleRegistered, ResolutionRecorded],
    errors = Error
)]
pub struct OracleRegistry {
    admin: Var<Address>,
    oracles: List<Address>,
    info: Mapping<Address, OracleInfo>,
    exists: Mapping<Address, bool>,
    /// (oracle, market_id) -> recorded, so each resolution counts at most once.
    recorded: Mapping<(Address, String), bool>,
}

#[odra::module]
impl OracleRegistry {
    /// Initialize with the deploying account as admin (the economy operator).
    pub fn init(&mut self) {
        self.admin.set(self.env().caller());
    }

    /// Admin-only: register an oracle identity.
    pub fn register_oracle(&mut self, oracle: Address, name: String) {
        self.assert_admin();
        if self.exists.get_or_default(&oracle) {
            self.env().revert(Error::DuplicateOracle);
        }
        self.exists.set(&oracle, true);
        self.oracles.push(oracle);
        self.info.set(
            &oracle,
            OracleInfo {
                name: name.clone(),
                resolved: 0,
                accurate: 0,
            },
        );
        self.env().emit_event(OracleRegistered { oracle, name });
    }

    /// Admin-only: record the accuracy of a resolution against an oracle. At most once per
    /// (oracle, market_id). Updates the running reputation and emits the new accuracy.
    pub fn record_resolution(&mut self, oracle: Address, market_id: String, accurate: bool) {
        self.assert_admin();
        let mut info = self.get_or_revert(&oracle);
        let key = (oracle, market_id.clone());
        if self.recorded.get_or_default(&key) {
            self.env().revert(Error::AlreadyRecorded);
        }
        self.recorded.set(&key, true);

        info.resolved += 1;
        if accurate {
            info.accurate += 1;
        }
        let accuracy_bps = accuracy_bps(info.accurate, info.resolved);
        self.info.set(&oracle, info);

        self.env().emit_event(ResolutionRecorded {
            oracle,
            market_id,
            accurate,
            accuracy_bps,
        });
    }

    // ---- reads (used by the off-chain adapter / UI / meta-markets) ----

    /// Whether an oracle address is registered.
    pub fn is_registered(&self, oracle: Address) -> bool {
        self.exists.get_or_default(&oracle)
    }

    /// Full identity + counters for an oracle.
    pub fn get_oracle(&self, oracle: Address) -> OracleInfo {
        self.get_or_revert(&oracle)
    }

    /// The oracle's running accuracy, in basis points (0 if it has resolved nothing yet).
    pub fn accuracy_bps(&self, oracle: Address) -> u32 {
        let info = self.get_or_revert(&oracle);
        accuracy_bps(info.accurate, info.resolved)
    }

    /// Whether a given (oracle, market_id) resolution has already been recorded.
    pub fn is_recorded(&self, oracle: Address, market_id: String) -> bool {
        self.recorded.get_or_default(&(oracle, market_id))
    }

    /// Number of registered oracles.
    pub fn oracle_count(&self) -> u32 {
        self.oracles.len()
    }

    /// The registry admin (economy operator).
    pub fn admin(&self) -> Address {
        self.admin.get().unwrap_or_revert(self)
    }

    // ---- internals ----

    fn assert_admin(&self) {
        if self.env().caller() != self.admin.get().unwrap_or_revert(self) {
            self.env().revert(Error::NotAdmin);
        }
    }

    fn get_or_revert(&self, oracle: &Address) -> OracleInfo {
        self.info.get(oracle).unwrap_or_revert_with(self, Error::UnknownOracle)
    }
}

/// Pure reputation math: `accurate / resolved` in basis points (0 when nothing resolved). Kept
/// free-standing so the off-chain adapter can reproduce the exact on-chain number.
fn accuracy_bps(accurate: u64, resolved: u64) -> u32 {
    if resolved == 0 {
        return 0;
    }
    ((accurate * BPS_DENOMINATOR) / resolved) as u32
}

#[cfg(test)]
mod tests {
    use super::{Error, OracleRegistered, OracleRegistry, OracleRegistryHostRef, ResolutionRecorded};
    use odra::host::{Deployer, HostEnv, NoArgs};
    use odra::prelude::*;

    fn deploy(env: &HostEnv) -> OracleRegistryHostRef {
        env.set_caller(env.get_account(0));
        OracleRegistry::deploy(env, NoArgs)
    }

    #[test]
    fn registers_and_reads_back() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let arbiter = env.get_account(1);

        assert_eq!(reg.oracle_count(), 0);
        assert_eq!(reg.admin(), env.get_account(0));

        reg.register_oracle(arbiter, "Arbiter".to_string());
        assert_eq!(reg.oracle_count(), 1);
        assert!(reg.is_registered(arbiter));
        assert_eq!(reg.get_oracle(arbiter).name, "Arbiter".to_string());
        assert_eq!(reg.accuracy_bps(arbiter), 0); // nothing resolved yet

        assert!(env.emitted_event(
            &reg,
            OracleRegistered {
                oracle: arbiter,
                name: "Arbiter".to_string(),
            }
        ));
    }

    #[test]
    fn duplicate_registration_reverts() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let arbiter = env.get_account(1);
        reg.register_oracle(arbiter, "Arbiter".to_string());
        assert_eq!(
            reg.try_register_oracle(arbiter, "Again".to_string()).unwrap_err(),
            Error::DuplicateOracle.into()
        );
    }

    #[test]
    fn non_admin_register_reverts() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let arbiter = env.get_account(1);
        env.set_caller(env.get_account(2));
        assert_eq!(
            reg.try_register_oracle(arbiter, "x".to_string()).unwrap_err(),
            Error::NotAdmin.into()
        );
    }

    #[test]
    fn records_resolutions_and_computes_accuracy() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let arbiter = env.get_account(1);
        reg.register_oracle(arbiter, "Arbiter".to_string());

        // 3 of 4 accurate → 7500 bps.
        reg.record_resolution(arbiter, "m1".to_string(), true);
        reg.record_resolution(arbiter, "m2".to_string(), true);
        reg.record_resolution(arbiter, "m3".to_string(), false);
        reg.record_resolution(arbiter, "m4".to_string(), true);

        let info = reg.get_oracle(arbiter);
        assert_eq!(info.resolved, 4);
        assert_eq!(info.accurate, 3);
        assert_eq!(reg.accuracy_bps(arbiter), 7500);

        assert!(env.emitted_event(
            &reg,
            ResolutionRecorded {
                oracle: arbiter,
                market_id: "m4".to_string(),
                accurate: true,
                accuracy_bps: 7500,
            }
        ));
    }

    #[test]
    fn double_record_same_market_reverts() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let arbiter = env.get_account(1);
        reg.register_oracle(arbiter, "Arbiter".to_string());
        reg.record_resolution(arbiter, "m1".to_string(), true);
        assert!(reg.is_recorded(arbiter, "m1".to_string()));
        assert_eq!(
            reg.try_record_resolution(arbiter, "m1".to_string(), false).unwrap_err(),
            Error::AlreadyRecorded.into()
        );
    }

    #[test]
    fn record_for_unknown_oracle_reverts() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let ghost = env.get_account(5);
        assert_eq!(
            reg.try_record_resolution(ghost, "m1".to_string(), true).unwrap_err(),
            Error::UnknownOracle.into()
        );
    }

    #[test]
    fn non_admin_record_reverts() {
        let env = odra_test::env();
        let mut reg = deploy(&env);
        let arbiter = env.get_account(1);
        reg.register_oracle(arbiter, "Arbiter".to_string());
        env.set_caller(env.get_account(2));
        assert_eq!(
            reg.try_record_resolution(arbiter, "m1".to_string(), true).unwrap_err(),
            Error::NotAdmin.into()
        );
    }
}
