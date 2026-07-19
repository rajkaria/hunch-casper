/**
 * The mainnet deploy preflight — a pure, credential-free dry run that answers "what will putting
 * this on mainnet cost, what will it deploy, and is it even allowed yet?" and performs **zero**
 * transactions. This is the S22 mainnet pipeline made safe by construction: there is no code path
 * from here to a signed transaction. Spending mainnet CSPR stays a deliberate operator act (only
 * -stop list / decision D2); this module is the plan they read first.
 *
 * The cost model uses the chain-measured net costs recorded in `contracts/DEPLOY.md` (the same
 * table `contracts/bin/catalogue.rs` cites), for the v2 singleton architecture actually deployed:
 * install the three infra singletons once, then a cheap `create_market` + `register_market` per
 * catalogue market, plus optional house-seed liquidity. Every number is net CSPR (limit minus the
 * measured refund), so the total is what the deployer purse actually loses.
 */

import type { CasperNetwork } from "@/config/network";
import { buildDeployManifest, type DeployManifest } from "@/core/deploy-manifest";
import { auditStatusFromEnv, currentMaxBetCspr, type AuditStatus } from "@/config/caps";

// ── Measured net costs (CSPR), from contracts/DEPLOY.md §4c. ──────────────────────────────────────
/** Install one Odra singleton (MarketFactory / OracleRegistry) — measured ~324 CSPR net. */
const INSTALL_INFRA_CSPR = 324.268;
/** Install the HunchVault v2 singleton — measured ~373 CSPR net. */
const INSTALL_VAULT_CSPR = 373.074;
/** A v2 `create_market` through the payable proxy — measured ~3.742 CSPR net (typical call). */
const CREATE_MARKET_CSPR = 3.742;
/** `register_market` into the factory — measured ~1.482 CSPR net. */
const REGISTER_MARKET_CSPR = 1.482;
/** One house-seed `bet` — measured ~3.08 CSPR net. */
const SEED_BET_CSPR = 3.08;

export interface PreflightLineItem {
  step: string;
  count: number;
  unitCostCspr: number;
  subtotalCspr: number;
}

export interface AddressPlanEntry {
  contract: "MarketFactory" | "OracleRegistry" | "HunchVault v2";
  status: "already-deployed" | "to-deploy";
  address?: string;
}

export interface MainnetPreflight {
  network: CasperNetwork;
  /** ALWAYS false — this module cannot transact. The field exists so a consumer can assert it. */
  transactionsPerformed: false;
  /** Whether a mainnet deploy is advisable right now, from the audit gate. */
  cleared: boolean;
  audit: {
    status: AuditStatus;
    /** Human summary of why the deploy is or isn't cleared. */
    note: string;
    perBetCapCspr: number | null;
  };
  addressPlan: AddressPlanEntry[];
  costPlan: PreflightLineItem[];
  totalCostCspr: number;
  marketCount: number;
  /** The exact operator command that WOULD spend, and the guard that stops it. */
  executionNote: string;
}

function lineItem(step: string, count: number, unitCostCspr: number): PreflightLineItem {
  return { step, count, unitCostCspr, subtotalCspr: round(count * unitCostCspr) };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Build the mainnet preflight. `seedHouseLiquidity` toggles whether the per-market house-seed bet
 * is included in the cost (an operator may bootstrap dry and seed later). Pure — `nowMs` only feeds
 * the cap read.
 */
export function buildMainnetPreflight(opts: { seedHouseLiquidity?: boolean; nowMs?: number } = {}): MainnetPreflight {
  const network: CasperNetwork = "mainnet";
  const manifest: DeployManifest = buildDeployManifest(network);
  const markets = manifest.marketCount;
  const seed = opts.seedHouseLiquidity ?? true;

  const costPlan: PreflightLineItem[] = [
    lineItem("Install MarketFactory + OracleRegistry (singletons)", 2, INSTALL_INFRA_CSPR),
    lineItem("Install HunchVault v2 (singleton)", 1, INSTALL_VAULT_CSPR),
    lineItem("create_market per catalogue market", markets, CREATE_MARKET_CSPR),
    lineItem("register_market per catalogue market", markets, REGISTER_MARKET_CSPR),
  ];
  if (seed) costPlan.push(lineItem("house-seed bet per market", markets, SEED_BET_CSPR));

  const totalCostCspr = round(costPlan.reduce((sum, item) => sum + item.subtotalCspr, 0));

  const status = auditStatusFromEnv();
  const cleared = status === "audited";
  const perBetCapCspr = currentMaxBetCspr(network, opts.nowMs);

  const addressPlan: AddressPlanEntry[] = [
    addr("MarketFactory", manifest.contracts.marketFactory),
    addr("OracleRegistry", manifest.contracts.oracleRegistry),
    addr("HunchVault v2", manifest.contracts.vaultV2),
  ];

  return {
    network,
    transactionsPerformed: false,
    cleared,
    audit: {
      status,
      note: cleared
        ? "contracts marked audited — a mainnet deploy is cleared; still an explicit operator action"
        : `contracts are ${status}: a mainnet deploy is NOT advised. Per-bet cap holds at ${perBetCapCspr} CSPR and the unaudited banner stays up until NEXT_PUBLIC_AUDIT_STATUS=audited`,
      perBetCapCspr,
    },
    addressPlan,
    costPlan,
    totalCostCspr,
    marketCount: markets,
    executionNote:
      "This is a dry run and performs zero transactions. The real deploy is driven by " +
      "`contracts/bin/cli.rs` (odra-cli livenet) with a funded CASPER_BETTOR_KEY against the mainnet " +
      "node — a separate, deliberate command. See docs/OPS.md §10 and contracts/DEPLOY.md.",
  };
}

function addr(contract: AddressPlanEntry["contract"], address: string | undefined): AddressPlanEntry {
  return address
    ? { contract, status: "already-deployed", address }
    : { contract, status: "to-deploy" };
}

/** Render the preflight as a human-readable plan for a terminal/log. */
export function renderPreflight(plan: MainnetPreflight): string {
  const lines: string[] = [];
  lines.push(`Mainnet deploy preflight — DRY RUN (zero transactions)`);
  lines.push(`Audit status: ${plan.audit.status} — ${plan.cleared ? "CLEARED" : "NOT CLEARED"}`);
  lines.push(`  ${plan.audit.note}`);
  lines.push("");
  lines.push("Address plan:");
  for (const e of plan.addressPlan) {
    lines.push(`  ${e.contract.padEnd(24)} ${e.status}${e.address ? ` @ ${e.address}` : ""}`);
  }
  lines.push("");
  lines.push(`Cost plan (${plan.marketCount} markets, net CSPR):`);
  for (const item of plan.costPlan) {
    lines.push(`  ${item.step.padEnd(48)} ${String(item.count).padStart(3)} × ${item.unitCostCspr.toFixed(3)} = ${item.subtotalCspr.toFixed(3)}`);
  }
  lines.push(`  ${"TOTAL".padEnd(48)} ${" ".repeat(6)} ${plan.totalCostCspr.toFixed(3)} CSPR`);
  lines.push("");
  lines.push(plan.executionNote);
  return lines.join("\n");
}
