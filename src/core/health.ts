/**
 * Operator health model — pure. Takes a plain snapshot of how the deployment is wired and
 * returns a verdict per subsystem plus one overall status.
 *
 * Why this is `core/` and not a route: the interesting part of a health check is the *judgement*
 * ("real mode with no cron secret means the economy's heartbeat is dead"), and judgement that
 * lives inside a request handler can only be tested by standing up a request. Gathering lives in
 * `src/lib/health.ts`; everything below is a pure function of its inputs, so every degraded
 * combination is a table-driven test.
 *
 * Severity ladder:
 *   `ok`    — wired and working.
 *   `skip`  — not applicable to this mode (e.g. x402 transfer verification in mock mode).
 *   `warn`  — running, but in a degraded or fallback way an operator should know about.
 *   `fail`  — this deployment cannot do its job; overall status becomes `degraded`.
 */

export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface HealthCheck {
  /** Stable machine name — safe to alert on. */
  name: string;
  status: CheckStatus;
  /** One human sentence: what is true, and what it costs. Never contains a secret value. */
  detail: string;
}

export interface HealthInputs {
  network: "testnet" | "mainnet";
  chainMode: "mock" | "real";
  contracts: {
    marketFactory?: string;
    oracleRegistry?: string;
    vault?: string;
    vaultV2?: string;
  };
  /** Count of per-market package hashes in `NEXT_PUBLIC_*_MARKET_ADDRS`. */
  marketAddressCount: number;
  persistence: { configured: boolean; reachable: boolean; status?: number; latencyMs?: number };
  x402: {
    /** `CASPER_X402_PAYTO` set — the transfer-verifying PaymentPort. */
    payToConfigured: boolean;
    /** `CASPER_REAL_AGENT_X402=true` — the weaker legacy nonce-match opt-in. */
    legacyOptIn: boolean;
  };
  signer: { bettorKeyConfigured: boolean; oracleKeyConfigured: boolean };
  /** `CRON_SECRET`/`TICK_CRON_SECRET` set — required for the tick in real mode. */
  cronSecretConfigured: boolean;
  /** `CSPR_CLOUD_API_KEY` set — live validator signal for Genesis. */
  csprCloudKeyConfigured: boolean;
  economy: {
    /** Actions recorded on this instance (not seeded — a true zero means a cold instance). */
    actionCount: number;
    /** Epoch ms of the newest action, or null when there is none. */
    newestActionTs: number | null;
  };
  /** Per-agent purse balances. Empty when the fleet has no wallet wired. */
  fleet: FleetBalance[];
  /**
   * Motes an agent needs to take its turn (largest stake + gas floor). Below this it sits out —
   * which is correct behaviour, and also the thing an operator must be told about before the
   * whole fleet goes quiet.
   */
  fleetMinBalanceMotes: string;
  /** Epoch ms "now" — injected so tests never race the wall clock. */
  now: number;
}

export interface FleetBalance {
  agentId: string;
  /** The agent's on-chain identity — public, and the account an operator refills. */
  account: string;
  /** The same identity in `account-hash-…` form, which is what the funding tools take. */
  accountHash: string;
  balanceMotes: string;
}

export interface HealthReport {
  status: "ok" | "degraded";
  network: "testnet" | "mainnet";
  chainMode: "mock" | "real";
  /** True when settlement runs against the mock adapter — the `simulated` chip's source. */
  simulated: boolean;
  checks: HealthCheck[];
  /** Names of every non-ok, non-skip check, so an alert body can be one line. */
  problems: string[];
  economy: { actionCount: number; newestActionTs: number | null; ageMs: number | null };
  /** Per-agent balances with their funded/unfunded verdict — the refill worklist. */
  fleet: (FleetBalance & { funded: boolean })[];
  generatedAt: string;
}

/**
 * A tick older than this means the 10-minute economy workflow has stopped firing. Two missed
 * ticks, not one: a single late cron run is noise, two in a row is an outage.
 */
export const TICK_STALE_MS = 25 * 60 * 1000;

function check(name: string, status: CheckStatus, detail: string): HealthCheck {
  return { name, status, detail };
}

/** Contract wiring. In real mode the routing targets are load-bearing; in mock nothing is. */
function contractChecks(i: HealthInputs): HealthCheck[] {
  const real = i.chainMode === "real";
  const out: HealthCheck[] = [];
  const routable = i.marketAddressCount > 0 || Boolean(i.contracts.vaultV2) || Boolean(i.contracts.vault);

  if (!real) {
    out.push(check("contracts", "skip", "mock chain mode — no on-chain routing targets are required"));
    return out;
  }
  out.push(
    routable
      ? check(
          "contracts.routing",
          "ok",
          `bets route to ${i.marketAddressCount} per-market package(s)` +
            (i.contracts.vaultV2 ? " with HunchVault v2 as the fallback" : "") +
            (!i.contracts.vaultV2 && i.contracts.vault ? " with the v1 vault as the fallback" : ""),
        )
      : check(
          "contracts.routing",
          "fail",
          "real mode with no vault and no per-market addresses — every bet and resolve has nowhere to go",
        ),
  );
  out.push(
    i.contracts.vaultV2
      ? check("contracts.vaultV2", "ok", "HunchVault v2 wired — new markets are cheap state entries")
      : check(
          "contracts.vaultV2",
          "warn",
          "HunchVault v2 not wired — market creation falls back to per-market installs (~290+ CSPR each)",
        ),
  );
  out.push(
    i.contracts.oracleRegistry
      ? check("contracts.oracleRegistry", "ok", "OracleRegistry wired — resolutions accrue on-chain reputation")
      : check("contracts.oracleRegistry", "warn", "OracleRegistry not wired — oracle accuracy is off-chain only"),
  );
  out.push(
    i.contracts.marketFactory
      ? check("contracts.marketFactory", "ok", "MarketFactory wired")
      : check("contracts.marketFactory", "warn", "MarketFactory not wired — the on-chain market registry is unreadable"),
  );
  return out;
}

/** Persistence. Unconfigured is fine locally and fatal to board durability in production. */
function persistenceCheck(i: HealthInputs): HealthCheck {
  const { configured, reachable, status, latencyMs } = i.persistence;
  if (!configured) {
    return i.chainMode === "real"
      ? check(
          "persistence",
          "warn",
          "no KV configured — economy state lives in one lambda's memory and dies on every cold start",
        )
      : check("persistence", "skip", "no KV configured (expected for local/CI/mock runs)");
  }
  if (reachable) return check("persistence", "ok", `KV reachable in ${latencyMs ?? "?"}ms`);
  return check(
    "persistence",
    "fail",
    `KV configured but unreachable${status ? ` (HTTP ${status} — rotated token?)` : ""} — boards will not survive cold starts`,
  );
}

/**
 * The x402 rail. The invariant from `AGENTS.md`: in real mode `agentBet` fails closed unless
 * either the transfer-verifying PaymentPort is wired (`CASPER_X402_PAYTO`) or the operator has
 * explicitly opted into the weaker legacy verifier. "Fails closed" is correct behaviour, so it
 * is a `warn` (agents get 402s), never silent success.
 */
function x402Check(i: HealthInputs): HealthCheck {
  if (i.chainMode !== "real") {
    return check("x402", "skip", "mock mode — the deterministic nonce-match verifier is in use by design");
  }
  if (i.x402.payToConfigured) {
    return check("x402", "ok", "transfer-verifying PaymentPort wired — proofs must map to a real CSPR transfer");
  }
  if (i.x402.legacyOptIn) {
    return check(
      "x402",
      "warn",
      "CASPER_REAL_AGENT_X402 legacy opt-in active — proofs are nonce-matched, not transfer-verified",
    );
  }
  return check(
    "x402",
    "warn",
    "real mode with no CASPER_X402_PAYTO and no legacy opt-in — agent bets fail closed (402), which is the safe default",
  );
}

/** Signing keys. In real mode, no bettor key means nothing can be submitted at all. */
function signerChecks(i: HealthInputs): HealthCheck[] {
  if (i.chainMode !== "real") {
    return [check("signer", "skip", "mock mode — no signing key is required")];
  }
  const out = [
    i.signer.bettorKeyConfigured
      ? check("signer.bettor", "ok", "bettor key configured — bets can be signed and submitted")
      : check("signer.bettor", "fail", "real mode with no CASPER_BETTOR_KEY — no transaction can be signed"),
  ];
  out.push(
    i.signer.oracleKeyConfigured
      ? check("signer.oracle", "ok", "dedicated oracle key configured")
      : check("signer.oracle", "warn", "no CASPER_ORACLE_KEY — resolutions are signed by the bettor key (shared custody)"),
  );
  return out;
}

/**
 * The heartbeat. In real mode `/api/agent/tick` refuses every unauthenticated call, so a missing
 * cron secret does not degrade the economy — it stops it dead. That is a `fail`.
 */
function cronCheck(i: HealthInputs): HealthCheck {
  if (i.chainMode !== "real") {
    return check("cron", "skip", "mock mode — the tick is open so the demo can drive it by hand");
  }
  return i.cronSecretConfigured
    ? check("cron", "ok", "cron secret configured — the scheduled tick is authorized")
    : check("cron", "fail", "real mode with no CRON_SECRET — every scheduled tick 401s and the economy stops advancing");
}

function signalsCheck(i: HealthInputs): HealthCheck {
  return i.csprCloudKeyConfigured
    ? check("signals", "ok", "CSPR.cloud key configured — Genesis reads the live validator set")
    : check("signals", "warn", "no CSPR_CLOUD_API_KEY — Genesis falls back to block height, then to the fixed rotation");
}

function economyCheck(i: HealthInputs): HealthCheck {
  const { actionCount, newestActionTs } = i.economy;
  if (actionCount === 0 || newestActionTs === null) {
    return check("economy", "warn", "no agent activity recorded on this instance yet (cold start, or the tick has never run)");
  }
  const ageMs = i.now - newestActionTs;
  const mins = Math.round(ageMs / 60_000);
  return ageMs > TICK_STALE_MS
    ? check("economy", "warn", `newest agent action is ${mins}m old — the scheduled tick looks stalled`)
    : check("economy", "ok", `newest agent action ${mins}m ago across ${actionCount} recorded action(s)`);
}

/**
 * Fleet funding. An underfunded agent is not an error — it sits the round out on purpose — but a
 * fleet that is quietly starving looks exactly like a fleet that is quietly broken, so it warns
 * loudly enough to prompt a refill and names the accounts to refill.
 */
function fleetCheck(i: HealthInputs, unfunded: FleetBalance[]): HealthCheck {
  if (i.fleet.length === 0) {
    return check("fleet", "skip", "no fleet wallet wired — agents are not paying from their own purses");
  }
  if (unfunded.length === 0) {
    return check("fleet", "ok", `all ${i.fleet.length} agent purses are above the ${i.fleetMinBalanceMotes}-mote turn floor`);
  }
  if (unfunded.length === i.fleet.length) {
    return check(
      "fleet",
      "fail",
      `every agent purse is below the turn floor (${unfunded.map((f) => f.agentId).join(", ")}) — the fleet has stopped betting entirely; refill`,
    );
  }
  return check(
    "fleet",
    "warn",
    `${unfunded.length} of ${i.fleet.length} agent purses are below the turn floor (${unfunded.map((f) => f.agentId).join(", ")}) and are sitting rounds out`,
  );
}

/** Evaluate every subsystem. Overall status is `degraded` iff any check failed. */
export function buildHealthReport(i: HealthInputs): HealthReport {
  const floor = BigInt(i.fleetMinBalanceMotes);
  const fleet = i.fleet.map((f) => ({ ...f, funded: BigInt(f.balanceMotes) >= floor }));
  const unfunded = fleet.filter((f) => !f.funded);
  const checks: HealthCheck[] = [
    ...contractChecks(i),
    persistenceCheck(i),
    x402Check(i),
    ...signerChecks(i),
    cronCheck(i),
    signalsCheck(i),
    fleetCheck(i, unfunded),
    economyCheck(i),
  ];
  const problems = checks.filter((c) => c.status === "fail" || c.status === "warn").map((c) => c.name);
  return {
    status: checks.some((c) => c.status === "fail") ? "degraded" : "ok",
    network: i.network,
    chainMode: i.chainMode,
    simulated: i.chainMode === "mock",
    checks,
    problems,
    economy: {
      actionCount: i.economy.actionCount,
      newestActionTs: i.economy.newestActionTs,
      ageMs: i.economy.newestActionTs === null ? null : i.now - i.economy.newestActionTs,
    },
    fleet,
    generatedAt: new Date(i.now).toISOString(),
  };
}
