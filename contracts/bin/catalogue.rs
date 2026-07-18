//! Catalogue deployer + receipts minter — pushes the app's deploy-plan manifest on-chain.
//!
//! `contracts_cli deploy` (bin/cli.rs) bootstraps a network: the two singletons + one sample
//! market. This driver finishes the job — one `ParimutuelMarket` per catalogue market from the
//! `GET /api/deploy-plan?network=` manifest, registered into the `MarketFactory`, optionally
//! seeded with ratio-preserving house bets — plus a full bet → resolve → claim lifecycle on a
//! dedicated receipts market so the site can link real explorer transactions
//! (`NEXT_PUBLIC_ONCHAIN_RECEIPTS`).
//!
//! Livenet config comes from the same env vars as `contracts_cli` (see contracts/.env). Run
//! from the contracts dir so the wasm under `wasm/` is found. Machine-readable `HUNCH_*` lines
//! go to stdout for the ops scripts that wire the resulting hashes into Vercel env.
//!
//! ```bash
//! contracts_catalogue balance
//! contracts_catalogue lifecycle
//! contracts_catalogue catalogue <deploy-plan.json> <slug,...|all> <seed-divisor>
//! # S16 — singleton HunchVault v2 (markets are cheap create_market calls, not installs):
//! contracts_catalogue vault-deploy <bond-motes>
//! contracts_catalogue catalogue-v2 <deploy-plan.json> <slug,...|all> <seed-divisor>
//! contracts_catalogue lifecycle-v2
//! ```
use std::fs;
use std::str::FromStr;

use contracts::hunch_vault::HunchVault;
use contracts::hunch_vault::HunchVaultInitArgs;
use contracts::market_factory::MarketFactory;
use contracts::parimutuel_market::{ParimutuelMarket, ParimutuelMarketInitArgs};
use odra::casper_types::U512;
use odra::host::{Deployer, HostEnv, HostRef, HostRefLoader};
use odra::prelude::*;

// Gas limits are NOT ceilings you get back — testnet runs `pricing_handling =
// payment_limited` with `refund_handling = { refund_ratio = [75, 100] }`, so a transaction
// costs `consumed + 0.25 * (limit - consumed)`. Over-setting a limit burns 25% of the slack,
// and the full limit must be affordable up front or the node rejects the transaction.
// Verified to the mote against the Jul 5 bootstrap + Jul 18 vault-v2 transactions:
//
//   2b0cbe… install ParimutuelMarket  limit 400  consumed 299.023  net 324.268 CSPR
//   43eab0… install HunchVault (S19)  limit 400  consumed 364.099  net 373.074 CSPR
//   40273e… create_market (first)     limit   6  consumed   4.958  net   5.218 CSPR
//   e2bb36… create_market (typical)   limit   8  consumed   2.323  net   3.742 CSPR
//   1515ef… register_market           limit   3  consumed   0.976  net   1.482 CSPR
//   79f232… bet                       limit   8  consumed   1.439  net   3.080 CSPR
//   46312a… resolve (fee+bond sweep)  limit   8  consumed   6.317  net   6.738 CSPR
//   136425… claim                     limit   8  consumed   2.921  net   4.191 CSPR
//
// Limits below are sized at ~3x measured consumption; installs get extra insurance
// because an out-of-gas install burns the whole limit and strands the deployer.

/// Wasm installs. The S19 `HunchVault` (367,617 bytes) consumed 364.099 — the old 400
/// limit had shrunk to 9.9% headroom, unacceptable for a burn-the-whole-limit failure
/// mode. 450 restores ~1.24x at ~+13 CSPR net (25% of the extra slack) per install.
const MARKET_GAS: u64 = 450_000_000_000;
/// Registry writes (`register_market`, `set_vault`, `approve_oracle`, `set_open_creation`).
/// Measured at 0.953–0.976 CSPR consumed; 3 CSPR is ~3.1x and nets ~1.48 per call.
const REGISTRY_GAS: u64 = 3_000_000_000;
/// `bet` — escrow transfer plus pool math. Measured 1.434–1.439 CSPR consumed; 5 is ~3.5x
/// and nets ~2.33 per seed instead of the ~3.08 the old blanket 8-CSPR money limit cost.
const BET_GAS: u64 = 5_000_000_000;
/// `resolve` / `claim` — settlement writes plus fee, bond-refund, and payout transfers.
/// Resolve measured 6.317 CSPR consumed (claim 2.921): the old blanket 8 left resolve
/// only 1.27x headroom, so settlement gets its own 12 (~1.9x resolve, ~4.1x claim).
const SETTLE_GAS: u64 = 12_000_000_000;
/// A v2 `create_market` through the payable proxy. Measured 2.323 CSPR consumed on a
/// typical market — the FIRST create on a fresh vault runs 4.958 (it initializes the
/// vault's dictionaries), so 8 is ~3.4x typical and ~1.6x that first-call spike. The
/// driver prints the measured cost per call (`HUNCH_GAS`) so the docs report what the
/// chain actually charged.
const CREATE_GAS: u64 = 8_000_000_000;

/// Aug 1 2026 00:00 UTC — matches the catalogue's one-shot deadlines; far enough that bets
/// stay open for the demo window (resolve is oracle-gated, not deadline-gated).
const RECEIPTS_DEADLINE_MS: u64 = 1_785_542_400_000;

/// Refuse to start a market install that could run the deployer dry mid-flight
/// (install limit 400 CSPR + register/seed calls).
const MIN_MOTES_PER_MARKET: u64 = 650_000_000_000;

/// Already registered by the bootstrap deploy (bin/cli.rs) — re-registering reverts with
/// `DuplicateId` and burns the call gas, so never submit it.
const SKIP_REGISTER: &[&str] = &["coin-flip-5m"];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let command = args.get(1).map(String::as_str).unwrap_or("help");

    // `plan-cost` is a pure arithmetic dry run: it must work with no node, no key, and no
    // deployed contracts, because its whole job is to answer "what will this cost?" BEFORE
    // any of that is set up. Dispatch it before touching the livenet env, which needs a
    // secret-key path and an RPC endpoint just to construct.
    if command == "plan-cost" {
        let manifest = args
            .get(2)
            .expect("usage: plan-cost <deploy-plan.json> <v1|v2|v2-fresh> <slug,...|all> <seed-divisor> [bond-motes]");
        let mode = args.get(3).map(String::as_str).unwrap_or("v2");
        let selector = args.get(4).map(String::as_str).unwrap_or("all");
        let divisor: u64 = args
            .get(5)
            .map(|d| d.parse().expect("seed divisor must be a u64"))
            .unwrap_or(0);
        let bond: u64 = args
            .get(6)
            .map(|b| b.parse().expect("bond must be u64 motes"))
            .unwrap_or(DEFAULT_BOND_MOTES);
        plan_cost(manifest, mode, selector, divisor, bond);
        return;
    }

    let env = odra_casper_livenet_env::env();

    match command {
        "balance" => {
            let caller = env.caller();
            println!("HUNCH_CALLER {}", caller.to_formatted_string());
            println!("HUNCH_BALANCE now {}", env.balance_of(&caller));
        }
        "lifecycle" => lifecycle(&env),
        "catalogue" => {
            let manifest = args.get(2).expect("usage: catalogue <deploy-plan.json> <slug,...|all> <seed-divisor>");
            let selector = args.get(3).expect("missing slug selector (csv or 'all')");
            let divisor: u64 = args
                .get(4)
                .expect("missing seed divisor (0 = no seeding)")
                .parse()
                .expect("seed divisor must be a u64");
            catalogue(&env, manifest, selector, divisor);
        }
        "vault-deploy" => {
            let bond: u64 = args
                .get(2)
                .expect("usage: vault-deploy <bond-motes>")
                .parse()
                .expect("bond must be u64 motes");
            vault_deploy(&env, bond);
        }
        "catalogue-v2" => {
            let manifest = args.get(2).expect("usage: catalogue-v2 <deploy-plan.json> <slug,...|all> <seed-divisor>");
            let selector = args.get(3).expect("missing slug selector (csv or 'all')");
            let divisor: u64 = args
                .get(4)
                .expect("missing seed divisor (0 = no seeding)")
                .parse()
                .expect("seed divisor must be a u64");
            catalogue_v2(&env, manifest, selector, divisor);
        }
        "lifecycle-v2" => lifecycle_v2(&env),
        "list-markets" => list_markets(&env),
        "approve-oracle" => {
            let oracle = args
                .get(2)
                .expect("usage: approve-oracle <oracle-address> <true|false>");
            let approved: bool = args
                .get(3)
                .expect("missing approval flag (true|false)")
                .parse()
                .expect("approval flag must be true or false");
            approve_oracle(&env, oracle, approved);
        }
        "fleet-fund" => {
            let cspr_each: u64 = args
                .get(2)
                .expect("usage: fleet-fund <cspr-each> <account-hash-…,account-hash-…>")
                .parse()
                .expect("cspr-each must be a whole number of CSPR");
            let accounts = args.get(3).expect("missing comma-separated account list");
            fleet_fund(&env, cspr_each, accounts);
        }
        "open-creation" => {
            let open: bool = args
                .get(2)
                .expect("usage: open-creation <true|false>")
                .parse()
                .expect("flag must be true or false");
            open_creation(&env, open);
        }
        _ => {
            eprintln!(
                "usage: contracts_catalogue <balance|lifecycle|catalogue|vault-deploy|\
                 catalogue-v2|lifecycle-v2|list-markets|approve-oracle|open-creation|\
                 fleet-fund|plan-cost> ..."
            );
            std::process::exit(2);
        }
    }
}

/// Top the fleet's agent wallets up from the deployer.
///
/// Accounts are passed in explicitly rather than derived here on purpose. The derivation
/// (`HMAC-SHA256(seed, "hunch-fleet-v1:<agent>")`) lives in `src/adapters/casper/fleet-keys.ts`,
/// and a second implementation in Rust would be a second thing to keep in sync — a divergence
/// would silently fund addresses no agent signs for, which looks exactly like a successful
/// refill until the fleet goes quiet anyway. Instead the running app is the source of truth:
///
/// ```bash
/// curl -s https://casper.playhunch.xyz/api/health | jq -r '[.fleet[].accountHash] | join(",")'
/// cargo run --bin contracts_catalogue -- fleet-fund 50 "<that list>"
/// ```
///
/// Refuses to start unless the deployer can cover every transfer plus its gas, so a partial
/// refill never leaves half the fleet funded and the operator guessing which half.
fn fleet_fund(env: &HostEnv, cspr_each: u64, accounts: &str) {
    let targets: Vec<&str> = accounts.split(',').map(str::trim).filter(|a| !a.is_empty()).collect();
    if targets.is_empty() {
        eprintln!("fleet-fund: no accounts given");
        std::process::exit(2);
    }
    let each = U512::from(cspr_each) * U512::from(1_000_000_000u64);
    let caller = env.caller();
    let balance = env.balance_of(&caller);
    // Each transfer costs its amount plus the native-transfer gas; check the whole run up front.
    let per_transfer_gas = U512::from(TRANSFER_GAS);
    let required = (each + per_transfer_gas) * U512::from(targets.len() as u64);
    if balance < required {
        eprintln!(
            "fleet-fund needs {required} motes to fund {} account(s) with {cspr_each} CSPR each \
             (plus transfer gas); the deployer holds {balance}. Top up at \
             https://testnet.cspr.live/tools/faucet",
            targets.len()
        );
        std::process::exit(1);
    }

    println!("HUNCH_BALANCE start {balance}");
    for target in targets {
        let address = Address::from_str(target)
            .unwrap_or_else(|e| panic!("bad account '{target}': {e:?} (expected account-hash-<64 hex>)"));
        println!("HUNCH_STEP fleet-fund {target}");
        env.set_gas(TRANSFER_GAS);
        match env.transfer(address, each) {
            Ok(()) => println!("HUNCH_FUNDED account={target} motes={each}"),
            Err(e) => println!("HUNCH_FUND_FAILED account={target} error={e:?}"),
        }
    }
    println!("HUNCH_BALANCE end {}", env.balance_of(&caller));
    println!("HUNCH_STEP done");
}

/// Native transfer gas limit. A native transfer is a fixed-cost operation; 0.1 CSPR is the
/// standard limit and leaves the refund model no slack to shave.
const TRANSFER_GAS: u64 = 100_000_000;

// ── plan-cost: price a catalogue run before paying for it ───────────────────────────────────────
//
// The failure this prevents: a catalogue expansion is kicked off, the deployer runs dry six
// markets in, and the run strands half-created state on chain (a created market with no
// registration, a bond posted against nothing). Every number below is measured from real
// transactions, so the estimate is chain truth arithmetic, not a guess.

/// Testnet `refund_handling` returns this fraction of the UNUSED gas limit. Net cost is
/// therefore `consumed + (1 - ratio) * (limit - consumed)` — over-setting a limit is not free.
const REFUND_NUMERATOR: u64 = 75;
const REFUND_DENOMINATOR: u64 = 100;

/// Measured consumption, in motes, from the transactions cited in the gas-constant comments
/// above. Paired with the `*_GAS` limits, these reproduce the observed net cost to the mote.
const CONSUMED_INSTALL_VAULT: u64 = 364_099_000_000;
const CONSUMED_INSTALL_MARKET: u64 = 299_023_000_000;
const CONSUMED_CREATE_FIRST: u64 = 4_958_000_000;
const CONSUMED_CREATE_TYPICAL: u64 = 2_323_000_000;
const CONSUMED_REGISTER: u64 = 976_000_000;
const CONSUMED_BET: u64 = 1_439_000_000;

/// The vault's creation bond as deployed on testnet (1 CSPR). Escrowed, not spent — it comes
/// back at clean settlement — so it is reported separately from cost.
const DEFAULT_BOND_MOTES: u64 = 1_000_000_000;

/// Net cost of one transaction: what is consumed, plus the unrefunded share of the slack.
fn net_cost(consumed: u64, limit: u64) -> u64 {
    let slack = limit.saturating_sub(consumed);
    consumed + slack * (REFUND_DENOMINATOR - REFUND_NUMERATOR) / REFUND_DENOMINATOR
}

fn cspr(motes: u64) -> String {
    format!("{:.3}", motes as f64 / 1_000_000_000.0)
}

struct CostLine {
    step: &'static str,
    count: u64,
    /// Net motes per call under the refund model.
    each_net: u64,
    /// Gas limit per call — the amount that must be affordable up front, and the worst case
    /// if the call reverts (a reverted transaction refunds nothing).
    each_limit: u64,
}

/// Price a deploy-plan manifest without touching the chain. Prints an itemised table, the
/// expected total, the revert-everything worst case, the peak single-transaction limit (the
/// balance floor the node enforces at submit time), and the escrowed bond total.
fn plan_cost(manifest_path: &str, mode: &str, selector: &str, divisor: u64, bond: u64) {
    let raw = fs::read_to_string(manifest_path).expect("cannot read manifest");
    let manifest: serde_json::Value = serde_json::from_str(&raw).expect("manifest is not JSON");
    let markets = manifest["markets"].as_array().expect("manifest has no markets[]");

    let selected: Option<Vec<&str>> = (selector != "all").then(|| selector.split(',').collect());
    let mut market_count: u64 = 0;
    let mut seed_bets: u64 = 0;
    for m in markets {
        let slug = m["slug"].as_str().expect("market without slug");
        if let Some(ref only) = selected {
            if !only.contains(&slug) {
                continue;
            }
        }
        market_count += 1;
        if divisor > 0 {
            if let Some(seeds) = m["seedBets"].as_object() {
                for (_, motes) in seeds {
                    let motes: u64 = motes
                        .as_str()
                        .expect("seed motes must be a string")
                        .parse()
                        .expect("seed motes must be numeric");
                    if motes / divisor > 0 {
                        seed_bets += 1;
                    }
                }
            }
        }
    }

    let v2 = mode != "v1";
    // `v2-fresh` prices a bootstrap on a network with no vault yet: the wasm install is by far
    // the largest single line, and leaving it out is exactly how a top-up gets under-ordered.
    let fresh_vault = mode == "v2-fresh";
    let mut lines: Vec<CostLine> = Vec::new();
    if fresh_vault {
        lines.push(CostLine {
            step: "install HunchVault v2 (wasm, one-off)",
            count: 1,
            each_net: net_cost(CONSUMED_INSTALL_VAULT, MARKET_GAS),
            each_limit: MARKET_GAS,
        });
    }
    if v2 {
        // The first create on a fresh vault initialises its dictionaries and costs roughly
        // double; charging every market the typical rate would under-quote a fresh vault.
        if market_count > 0 {
            lines.push(CostLine {
                step: "create_market (first, dictionary init)",
                count: 1,
                each_net: net_cost(CONSUMED_CREATE_FIRST, CREATE_GAS),
                each_limit: CREATE_GAS,
            });
        }
        if market_count > 1 {
            lines.push(CostLine {
                step: "create_market (typical)",
                count: market_count - 1,
                each_net: net_cost(CONSUMED_CREATE_TYPICAL, CREATE_GAS),
                each_limit: CREATE_GAS,
            });
        }
    } else {
        lines.push(CostLine {
            step: "install ParimutuelMarket (wasm)",
            count: market_count,
            each_net: net_cost(CONSUMED_INSTALL_MARKET, MARKET_GAS),
            each_limit: MARKET_GAS,
        });
    }
    lines.push(CostLine {
        step: "register_market",
        count: market_count,
        each_net: net_cost(CONSUMED_REGISTER, REGISTRY_GAS),
        each_limit: REGISTRY_GAS,
    });
    if seed_bets > 0 {
        lines.push(CostLine {
            step: "bet (house seed)",
            count: seed_bets,
            each_net: net_cost(CONSUMED_BET, BET_GAS),
            each_limit: BET_GAS,
        });
    }

    println!("HUNCH_PLAN mode={mode} markets={market_count} seed_bets={seed_bets}");
    println!("{:<40} {:>5} {:>14} {:>14}", "step", "count", "each (CSPR)", "total (CSPR)");
    let mut total_net: u64 = 0;
    let mut total_worst: u64 = 0;
    let mut peak_limit: u64 = 0;
    for l in &lines {
        let line_total = l.each_net * l.count;
        total_net += line_total;
        total_worst += l.each_limit * l.count;
        peak_limit = peak_limit.max(l.each_limit);
        println!(
            "{:<40} {:>5} {:>14} {:>14}",
            l.step,
            l.count,
            cspr(l.each_net),
            cspr(line_total)
        );
    }
    // The creation bond is a vault mechanism; a v1 per-market install posts no bond.
    let bond_total = if v2 { bond * market_count } else { 0 };
    println!("{:-<76}", "");
    println!("HUNCH_PLAN_COST_EXPECTED_MOTES {total_net}   ({} CSPR)", cspr(total_net));
    println!("HUNCH_PLAN_COST_WORST_MOTES {total_worst}   ({} CSPR, every call reverts and burns its limit)", cspr(total_worst));
    println!("HUNCH_PLAN_BOND_ESCROW_MOTES {bond_total}   ({} CSPR, refunded at clean settlement)", cspr(bond_total));
    println!("HUNCH_PLAN_PEAK_TX_LIMIT_MOTES {peak_limit}   ({} CSPR must be affordable when the largest single call is submitted)", cspr(peak_limit));
    let recommended = total_net + bond_total + peak_limit;
    println!(
        "HUNCH_PLAN_RECOMMENDED_BALANCE_MOTES {recommended}   ({} CSPR = expected + bonds + one peak limit of headroom)",
        cspr(recommended)
    );
    if !v2 {
        println!(
            "HUNCH_PLAN_NOTE v1 installs a wasm package per market. The same catalogue through the \
             v2 vault costs ~{}x less — prefer `catalogue-v2` unless a slug needs its own contract.",
            (net_cost(CONSUMED_INSTALL_MARKET, MARKET_GAS) / net_cost(CONSUMED_CREATE_TYPICAL, CREATE_GAS)).max(1)
        );
    }
}

/// S19: add/remove an oracle on the vault's public-creation allowlist. A permissionlessly
/// created market must bind an approved oracle — that binding is what stops a creator from
/// resolving their own market in their own favour.
fn approve_oracle(env: &HostEnv, oracle: &str, approved: bool) {
    let mut vault = load_vault(env);
    let addr = Address::from_str(oracle).expect("bad oracle address");
    println!("HUNCH_STEP approve-oracle oracle={oracle} approved={approved}");
    env.set_gas(REGISTRY_GAS);
    vault.approve_oracle(addr, approved);
    println!(
        "HUNCH_ORACLE_APPROVED oracle={oracle} approved={}",
        vault.is_oracle_approved(addr)
    );
}

/// S19: open (or re-close) permissionless market creation on the vault.
///
/// Approve at least one oracle FIRST — the allowlist is not enumerable on chain, so the
/// driver cannot verify it for you, and opening with an empty allowlist makes every public
/// `create_market` revert `OracleNotApproved`.
fn open_creation(env: &HostEnv, open: bool) {
    let mut vault = load_vault(env);
    if open {
        println!(
            "HUNCH_NOTE opening creation — confirm at least one `approve-oracle` has landed, \
             or every public create_market will revert OracleNotApproved"
        );
    }
    println!("HUNCH_STEP open-creation open={open}");
    env.set_gas(REGISTRY_GAS);
    vault.set_open_creation(open);
    println!("HUNCH_OPEN_CREATION {}", vault.open_creation());
}

/// Enumerate every registration in the `HUNCH_FACTORY` registry — free state reads, no
/// transactions. `HUNCH_REGISTRY` lines are machine-readable (id → market address), the
/// source of truth for rebuilding `NEXT_PUBLIC_*_MARKET_ADDRS` when the env map is lost.
fn list_markets(env: &HostEnv) {
    let factory_addr = std::env::var("HUNCH_FACTORY")
        .expect("set HUNCH_FACTORY to the deployed MarketFactory package hash");
    let factory =
        MarketFactory::load(env, Address::from_str(&factory_addr).expect("bad HUNCH_FACTORY"));
    let count = factory.market_count();
    println!("HUNCH_REGISTRY_COUNT {count}");
    for i in 0..count {
        let id = factory.market_id_at(i);
        let info = factory.get_market(id.clone());
        println!(
            "HUNCH_REGISTRY id={id} market={} deadline={} resolved={}",
            info.market_address.to_formatted_string(),
            info.deadline,
            info.resolved
        );
    }
}

/// Load the singleton vault from `HUNCH_VAULT_V2`.
fn load_vault(env: &HostEnv) -> contracts::hunch_vault::HunchVaultHostRef {
    let addr = std::env::var("HUNCH_VAULT_V2")
        .expect("set HUNCH_VAULT_V2 to the deployed HunchVault package hash");
    HunchVault::load(env, Address::from_str(&addr).expect("bad HUNCH_VAULT_V2"))
}

/// S16: install the singleton `HunchVault` v2 (the LAST per-contract install this repo needs)
/// and point the `MarketFactory` registry at it. Every market after this is a cheap
/// `create_market` entrypoint call.
fn vault_deploy(env: &HostEnv, bond_motes: u64) {
    let caller = env.caller();
    let balance = env.balance_of(&caller);
    println!("HUNCH_BALANCE start {balance}");

    // The node holds the FULL limit at acceptance, not the (refunded) net cost — submitting
    // below it is rejected before execution. Fail loudly here instead of on a bare RPC error,
    // and leave room for the `set_vault` call that follows the install.
    let required = U512::from(MARKET_GAS) + U512::from(REGISTRY_GAS);
    if balance < required {
        println!("HUNCH_ABORT low-balance have={balance} need={required}");
        eprintln!(
            "vault-deploy needs {required} motes up front ({MARKET_GAS} install limit + \
             {REGISTRY_GAS} set_vault limit); the deployer holds {balance}. Top up at \
             https://testnet.cspr.live/tools/faucet before retrying."
        );
        std::process::exit(1);
    }

    println!("HUNCH_STEP deploy-vault-v2 bond={bond_motes}");
    env.set_gas(MARKET_GAS);
    let vault = HunchVault::deploy(
        env,
        HunchVaultInitArgs {
            treasury: caller,
            creation_bond: U512::from(bond_motes),
        },
    );
    println!("HUNCH_VAULT_V2 package={}", vault.address().to_formatted_string());

    let factory_addr = std::env::var("HUNCH_FACTORY")
        .expect("set HUNCH_FACTORY to the deployed MarketFactory package hash");
    let mut factory =
        MarketFactory::load(env, Address::from_str(&factory_addr).expect("bad HUNCH_FACTORY"));
    println!("HUNCH_STEP factory-set-vault");
    env.set_gas(REGISTRY_GAS);
    // A factory installed before S16 has no `set_vault` entrypoint — and Odra's plain
    // `deploy()` installs locked packages, so it can never grow one. That's fine:
    // `catalogue-v2` registers vault markets through the v1 `register_market` with the
    // vault as the explicit market address, so the registry works either way.
    match factory.try_set_vault(vault.address()) {
        Ok(()) => println!("HUNCH_FACTORY_VAULT_SET ok"),
        Err(e) => println!(
            "HUNCH_NOTE set_vault unavailable on this factory ({e:?}); v2 registrations \
             will carry the vault address explicitly"
        ),
    }

    println!("HUNCH_BALANCE end {}", env.balance_of(&caller));
}

/// S16: create + register (+ optionally seed) the selected catalogue markets **inside the
/// singleton vault** — no per-market installs. Prints a `HUNCH_GAS` line per `create_market`
/// (measured balance delta, bond excluded) — 3.74 CSPR net on the 2026-07-18 run.
fn catalogue_v2(env: &HostEnv, manifest_path: &str, selector: &str, divisor: u64) {
    let raw = fs::read_to_string(manifest_path).expect("cannot read manifest");
    let manifest: serde_json::Value = serde_json::from_str(&raw).expect("manifest is not JSON");
    let markets = manifest["markets"].as_array().expect("manifest has no markets[]");

    let factory_addr = std::env::var("HUNCH_FACTORY")
        .expect("set HUNCH_FACTORY to the deployed MarketFactory package hash");
    let mut factory =
        MarketFactory::load(env, Address::from_str(&factory_addr).expect("bad HUNCH_FACTORY"));
    let vault = load_vault(env);
    let bond = vault.creation_bond();

    let selected: Option<Vec<&str>> = (selector != "all").then(|| selector.split(',').collect());
    let caller = env.caller();

    for m in markets {
        let slug = m["slug"].as_str().expect("market without slug");
        if let Some(ref only) = selected {
            if !only.contains(&slug) {
                continue;
            }
        }
        if vault.market_exists(slug.to_string()) {
            println!("HUNCH_SKIP_CREATE slug={slug} (already in the vault)");
            continue;
        }
        // A slug registered in the factory but absent from the vault has a live v1
        // per-market contract (and the app's per-market map outranks the vault for it) —
        // a vault twin would just strand a bond and seed pools nothing routes to.
        if factory.is_registered(slug.to_string()) {
            println!("HUNCH_SKIP_CREATE slug={slug} (live v1 contract already registered)");
            continue;
        }

        let question = m["init"]["question"].as_str().expect("init.question").to_string();
        let fee_bps = m["init"]["feeBps"].as_u64().expect("init.feeBps") as u32;
        let deadline = m["init"]["deadlineMs"].as_u64().expect("init.deadlineMs");
        let outcomes: Vec<String> = m["init"]["outcomeKeys"]
            .as_array()
            .expect("init.outcomeKeys")
            .iter()
            .map(|o| o.as_str().expect("outcome key").to_string())
            .collect();
        let category = m["registration"]["category"]
            .as_str()
            .unwrap_or("casper-native")
            .to_string();

        println!("HUNCH_STEP create-market {slug}");
        let before = env.balance_of(&caller);
        env.set_gas(CREATE_GAS);
        vault.with_tokens(bond).create_market(
            slug.to_string(),
            question.clone(),
            category.clone(),
            caller,
            fee_bps,
            deadline,
            outcomes,
        );
        // Bond comes back at settlement, so the true creation cost is delta minus bond.
        let spent = before - env.balance_of(&caller) - bond;
        println!("HUNCH_GAS create_market slug={slug} motes={spent}");

        if factory.is_registered(slug.to_string()) {
            println!("HUNCH_SKIP_REGISTER slug={slug} (already in the registry)");
        } else {
            println!("HUNCH_STEP register-v2 {slug}");
            env.set_gas(REGISTRY_GAS);
            // v1-compatible registration: pass the vault as the market address explicitly
            // instead of `register_vault_market`, which a pre-S16 factory doesn't have.
            factory.register_market(
                slug.to_string(),
                question,
                category,
                vault.address(),
                deadline,
            );
            println!("HUNCH_REGISTERED slug={slug}");
        }

        if divisor > 0 {
            if let Some(seeds) = m["seedBets"].as_object() {
                for (outcome, motes) in seeds {
                    let motes: u64 = motes
                        .as_str()
                        .expect("seed motes must be a string")
                        .parse()
                        .expect("seed motes must be numeric");
                    let stake = motes / divisor;
                    if stake == 0 {
                        continue;
                    }
                    println!("HUNCH_STEP seed {slug} {outcome}");
                    env.set_gas(BET_GAS);
                    vault
                        .with_tokens(U512::from(stake))
                        .bet(slug.to_string(), outcome.to_string());
                    println!("HUNCH_SEEDED slug={slug} outcome={outcome} motes={stake}");
                }
            }
        }

        println!("HUNCH_BALANCE after-{} {}", slug, env.balance_of(&caller));
    }

    println!("HUNCH_STEP done");
}

/// Drive the full money path INSIDE the vault on a dedicated receipts market: create →
/// two escrowed bets → oracle resolve (fee sweep) → winner claim — five real transactions
/// proving cross-market-safe settlement on the singleton (`NEXT_PUBLIC_ONCHAIN_RECEIPTS`).
fn lifecycle_v2(env: &HostEnv) {
    let caller = env.caller();
    let mut vault = load_vault(env);
    let bond = vault.creation_bond();
    println!("HUNCH_BALANCE start {}", env.balance_of(&caller));

    let slug = "receipts-vault-v2";
    println!("HUNCH_STEP create-receipts-market");
    env.set_gas(CREATE_GAS);
    vault.with_tokens(bond).create_market(
        slug.to_string(),
        "Hunch receipts: does the singleton vault settle end-to-end?".to_string(),
        "provably-fair".to_string(),
        caller,
        200,
        RECEIPTS_DEADLINE_MS,
        vec!["yes".to_string(), "no".to_string()],
    );
    println!("HUNCH_MARKET slug={slug} vault-entry (no install)");

    println!("HUNCH_STEP bet-yes");
    env.set_gas(BET_GAS);
    vault
        .with_tokens(U512::from(120_000_000_000u64))
        .bet(slug.to_string(), "yes".to_string());

    println!("HUNCH_STEP bet-no");
    env.set_gas(BET_GAS);
    vault
        .with_tokens(U512::from(80_000_000_000u64))
        .bet(slug.to_string(), "no".to_string());

    println!("HUNCH_STEP resolve");
    env.set_gas(SETTLE_GAS);
    vault.resolve(slug.to_string(), "yes".to_string());

    println!("HUNCH_STEP claim");
    env.set_gas(SETTLE_GAS);
    vault.claim(slug.to_string());

    println!("HUNCH_STEP done");
    println!("HUNCH_BALANCE end {}", env.balance_of(&caller));
}

/// Deploy a dedicated receipts market and drive the full money path on it: two escrowed bets,
/// an oracle resolution (fee sweep), and a winner claim — five real on-chain transactions.
fn lifecycle(env: &HostEnv) {
    let caller = env.caller();
    println!("HUNCH_BALANCE start {}", env.balance_of(&caller));

    println!("HUNCH_STEP deploy-receipts-market");
    env.set_gas(MARKET_GAS);
    let mut market = ParimutuelMarket::deploy(
        env,
        ParimutuelMarketInitArgs {
            question: "Hunch receipts: does the parimutuel vault settle end-to-end?".to_string(),
            oracle: caller,
            treasury: caller,
            fee_bps: 200,
            deadline: RECEIPTS_DEADLINE_MS,
            outcomes: vec!["yes".to_string(), "no".to_string()],
        },
    );
    println!(
        "HUNCH_MARKET slug=receipts-lifecycle package={}",
        market.address().to_formatted_string()
    );

    println!("HUNCH_STEP bet-yes");
    env.set_gas(BET_GAS);
    market.with_tokens(U512::from(120_000_000_000u64)).bet("yes".to_string());

    println!("HUNCH_STEP bet-no");
    env.set_gas(BET_GAS);
    market.with_tokens(U512::from(80_000_000_000u64)).bet("no".to_string());

    println!("HUNCH_STEP resolve");
    env.set_gas(SETTLE_GAS);
    market.resolve("yes".to_string());

    println!("HUNCH_STEP claim");
    env.set_gas(SETTLE_GAS);
    market.claim();

    println!("HUNCH_STEP done");
    println!("HUNCH_BALANCE end {}", env.balance_of(&caller));
}

/// Deploy + register (+ optionally seed) the selected catalogue markets. Seeds divide the
/// manifest's `seedBets` motes by `divisor`, preserving the catalogue's odds ratios at an
/// affordable stake; `divisor == 0` skips seeding entirely.
fn catalogue(env: &HostEnv, manifest_path: &str, selector: &str, divisor: u64) {
    let raw = fs::read_to_string(manifest_path).expect("cannot read manifest");
    let manifest: serde_json::Value = serde_json::from_str(&raw).expect("manifest is not JSON");
    let markets = manifest["markets"].as_array().expect("manifest has no markets[]");

    let factory_addr = std::env::var("HUNCH_FACTORY")
        .expect("set HUNCH_FACTORY to the deployed MarketFactory package hash");
    let mut factory =
        MarketFactory::load(env, Address::from_str(&factory_addr).expect("bad HUNCH_FACTORY"));

    let selected: Option<Vec<&str>> =
        (selector != "all").then(|| selector.split(',').collect());
    let caller = env.caller();

    for m in markets {
        let slug = m["slug"].as_str().expect("market without slug");
        if let Some(ref only) = selected {
            if !only.contains(&slug) {
                continue;
            }
        }

        let balance = env.balance_of(&caller);
        if balance < U512::from(MIN_MOTES_PER_MARKET) {
            println!("HUNCH_ABORT low-balance {}", balance);
            break;
        }

        let question = m["init"]["question"].as_str().expect("init.question").to_string();
        let fee_bps = m["init"]["feeBps"].as_u64().expect("init.feeBps") as u32;
        let deadline = m["init"]["deadlineMs"].as_u64().expect("init.deadlineMs");
        let outcomes: Vec<String> = m["init"]["outcomeKeys"]
            .as_array()
            .expect("init.outcomeKeys")
            .iter()
            .map(|o| o.as_str().expect("outcome key").to_string())
            .collect();
        let category = m["registration"]["category"]
            .as_str()
            .unwrap_or("casper-native")
            .to_string();

        println!("HUNCH_STEP deploy-market {slug}");
        env.set_gas(MARKET_GAS);
        let market = ParimutuelMarket::deploy(
            env,
            ParimutuelMarketInitArgs {
                question: question.clone(),
                oracle: caller,
                treasury: caller,
                fee_bps,
                deadline,
                outcomes,
            },
        );
        println!(
            "HUNCH_MARKET slug={} package={}",
            slug,
            market.address().to_formatted_string()
        );

        if SKIP_REGISTER.contains(&slug) {
            println!("HUNCH_SKIP_REGISTER slug={slug} (already in the registry)");
        } else {
            println!("HUNCH_STEP register {slug}");
            env.set_gas(REGISTRY_GAS);
            factory.register_market(
                slug.to_string(),
                question,
                category,
                market.address(),
                deadline,
            );
            println!("HUNCH_REGISTERED slug={slug}");
        }

        if divisor > 0 {
            if let Some(seeds) = m["seedBets"].as_object() {
                for (outcome, motes) in seeds {
                    let motes: u64 = motes
                        .as_str()
                        .expect("seed motes must be a string")
                        .parse()
                        .expect("seed motes must be numeric");
                    let stake = motes / divisor;
                    if stake == 0 {
                        continue;
                    }
                    println!("HUNCH_STEP seed {slug} {outcome}");
                    env.set_gas(BET_GAS);
                    market.with_tokens(U512::from(stake)).bet(outcome.to_string());
                    println!("HUNCH_SEEDED slug={slug} outcome={outcome} motes={stake}");
                }
            }
        }

        println!("HUNCH_BALANCE after-{} {}", slug, env.balance_of(&caller));
    }

    println!("HUNCH_STEP done");
}
