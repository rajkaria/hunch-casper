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

/// Gas limits mirror bin/cli.rs.
const MARKET_GAS: u64 = 400_000_000_000;
const CALL_GAS: u64 = 50_000_000_000;
/// A v2 `create_market` is storage writes only — budget far below an install. The driver
/// prints the measured balance delta per call (`HUNCH_GAS`) for the S16 "< 1 CSPR" gate.
const CREATE_GAS: u64 = 15_000_000_000;

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
        _ => {
            eprintln!("usage: contracts_catalogue <balance|lifecycle|catalogue|vault-deploy|catalogue-v2|lifecycle-v2> ...");
            std::process::exit(2);
        }
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
    println!("HUNCH_BALANCE start {}", env.balance_of(&caller));

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
    env.set_gas(CALL_GAS);
    factory.set_vault(vault.address());
    println!("HUNCH_FACTORY_VAULT_SET ok");

    println!("HUNCH_BALANCE end {}", env.balance_of(&caller));
}

/// S16: create + register (+ optionally seed) the selected catalogue markets **inside the
/// singleton vault** — no per-market installs. Prints a `HUNCH_GAS` line per `create_market`
/// (measured balance delta, bond excluded) — the evidence for the "< 1 CSPR" gate.
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
            env.set_gas(CALL_GAS);
            factory.register_vault_market(slug.to_string(), question, category, deadline);
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
                    env.set_gas(CALL_GAS);
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
    env.set_gas(CALL_GAS);
    vault
        .with_tokens(U512::from(120_000_000_000u64))
        .bet(slug.to_string(), "yes".to_string());

    println!("HUNCH_STEP bet-no");
    env.set_gas(CALL_GAS);
    vault
        .with_tokens(U512::from(80_000_000_000u64))
        .bet(slug.to_string(), "no".to_string());

    println!("HUNCH_STEP resolve");
    env.set_gas(CALL_GAS);
    vault.resolve(slug.to_string(), "yes".to_string());

    println!("HUNCH_STEP claim");
    env.set_gas(CALL_GAS);
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
    env.set_gas(CALL_GAS);
    market.with_tokens(U512::from(120_000_000_000u64)).bet("yes".to_string());

    println!("HUNCH_STEP bet-no");
    env.set_gas(CALL_GAS);
    market.with_tokens(U512::from(80_000_000_000u64)).bet("no".to_string());

    println!("HUNCH_STEP resolve");
    env.set_gas(CALL_GAS);
    market.resolve("yes".to_string());

    println!("HUNCH_STEP claim");
    env.set_gas(CALL_GAS);
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
            env.set_gas(CALL_GAS);
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
                    env.set_gas(CALL_GAS);
                    market.with_tokens(U512::from(stake)).bet(outcome.to_string());
                    println!("HUNCH_SEEDED slug={slug} outcome={outcome} motes={stake}");
                }
            }
        }

        println!("HUNCH_BALANCE after-{} {}", slug, env.balance_of(&caller));
    }

    println!("HUNCH_STEP done");
}
