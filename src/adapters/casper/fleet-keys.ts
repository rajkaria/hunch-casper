/**
 * Fleet key material — how each agent gets its own funded Casper identity.
 *
 * ## The layout decision
 *
 * Three options were on the table: one env secret per Prophet, one seed the whole fleet derives
 * from, or one shared key for all of them.
 *
 * **A shared key is the one that looks cheapest and costs the most.** All four Prophets would be
 * the same on-chain account, so every track record the roadmap sells — PnL, calibration,
 * per-category expertise, the whole reputation asset — would collapse into a single
 * indistinguishable blob. Reputation data you cannot attribute is not reputation data.
 *
 * So each agent gets its own key. They are **derived** from one `CASPER_FLEET_SEED` rather than
 * configured individually, because fleet wallets are funded by hand: derivation must be
 * deterministic across restarts, redeploys, and instances, or a rotated address strands its
 * balance. One secret in the deployment, N stable identities on chain.
 *
 * An explicit per-agent override (`CASPER_PROPHET_KEY_<AGENT>`) sits on top, so a key can be
 * moved to separate custody later without touching this code.
 *
 * ## Derivation
 *
 * `HMAC-SHA256(seed, "hunch-fleet-v1:<agentId>")` → 32 bytes → Ed25519 secret key.
 *
 * HMAC (not a bare hash) so the seed is a key, not a prefix — length-extension and related-input
 * games are off the table. The `hunch-fleet-v1` label is domain separation: a future scheme
 * bumps the label and derives a fresh, non-colliding fleet rather than silently reusing keys for
 * a different purpose. Agent ids are lowercased so `Momentum` and `momentum` can never derive
 * two different wallets for the same agent.
 */

import { createHmac } from "node:crypto";

/** Domain-separation label. Bump the version to derive a fresh, non-colliding fleet. */
export const FLEET_KDF_LABEL = "hunch-fleet-v1";

export class FleetKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FleetKeyError";
  }
}

/** Env var holding an explicit key for one agent, e.g. `CASPER_PROPHET_KEY_MOMENTUM`. */
export function agentKeyEnvName(agentId: string): string {
  return `CASPER_PROPHET_KEY_${agentId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

/**
 * Derive an agent's Ed25519 secret key (32-byte hex) from the fleet seed. Pure and
 * SDK-free, so the determinism this whole scheme rests on is asserted offline in CI.
 */
export function deriveAgentKeyHex(seed: string, agentId: string): string {
  const normalizedSeed = seed.trim();
  if (normalizedSeed.length === 0) throw new FleetKeyError("fleet seed must not be empty");
  const normalizedAgent = agentId.trim().toLowerCase();
  if (normalizedAgent.length === 0) throw new FleetKeyError("agent id must not be empty");
  return createHmac("sha256", normalizedSeed)
    .update(`${FLEET_KDF_LABEL}:${normalizedAgent}`)
    .digest("hex");
}

/**
 * The key an agent signs with: an explicit per-agent override if one is set, otherwise derived
 * from the fleet seed. Returns `null` when neither is configured — the caller decides whether
 * that is fatal (real mode) or expected (mock mode).
 *
 * An override may be a PEM or a hex seed; a derived key is always hex. `real-wallet.ts` loads
 * both shapes through the same helper `real-chain.ts` uses.
 */
export function agentSecretKey(
  agentId: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = env[agentKeyEnvName(agentId)];
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const seed = env.CASPER_FLEET_SEED;
  if (seed && seed.trim().length > 0) return deriveAgentKeyHex(seed, agentId);
  return null;
}

/** True when this deployment can sign for at least one agent identity. */
export function fleetConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.CASPER_FLEET_SEED && env.CASPER_FLEET_SEED.trim().length > 0);
}

/**
 * Parse a `query_balance` JSON-RPC response into motes. Defensive and pure: any malformed,
 * error-bearing, or missing payload reads as `null` (unknown), never a throw and never a
 * fabricated zero — "unknown" and "empty" lead to different operator decisions.
 */
export function parseBalanceResult(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const root = json as Record<string, unknown>;
  if (root.error !== undefined) return null;
  const result = root.result;
  if (typeof result !== "object" || result === null) return null;
  const balance = (result as Record<string, unknown>).balance;
  if (typeof balance === "string" && /^\d+$/.test(balance)) return balance;
  if (typeof balance === "number" && Number.isSafeInteger(balance) && balance >= 0) {
    return String(balance);
  }
  return null;
}
