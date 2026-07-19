/**
 * The cap-ramp policy — bet caps as data, tied to audit status and deployment age, with one
 * invariant the property tests enforce above all else: **the cap can only rise above the unaudited
 * ceiling once the contracts are audited.** Age alone never unlocks a bigger bet; a longer-lived
 * unaudited deployment is still an unaudited deployment.
 *
 * This is the single source of truth for both the per-bet cap and the "unaudited build" banner, so
 * the number a user is capped at and the disclosure they are shown can never disagree. `network.ts`
 * delegates `maxBetCspr`/`exceedsBetCap` here; the banner reads `bannerDisclosure` here. The ramp is
 * a pure function of `(status, ageDays)`; the env readers are the only impure part, isolated so the
 * policy itself is trivially testable.
 *
 * Defaults (no env set): mainnet is `unaudited` → the historical 25 CSPR ceiling; testnet is
 * uncapped (a dev network with no real money). Nothing changes until an operator both audits the
 * contracts *and* sets `NEXT_PUBLIC_AUDIT_STATUS=audited` — which is exactly the gate the invariant
 * describes: raising the cap is a deliberate, audit-backed act, never a silent drift.
 */

// Type-only import — erased at runtime, so there is no import cycle with `network.ts` (which
// imports the runtime helpers below).
import type { CasperNetwork } from "./network";

export type AuditStatus = "unaudited" | "in-progress" | "audited";

/** The per-bet ceiling while the contracts are not fully audited. The one number age cannot move. */
export const UNAUDITED_MAINNET_CAP_CSPR = 25;

/** Ramp stages unlocked ONLY by an `audited` status, widening with deployment age. */
const AUDITED_RAMP: readonly { untilDay: number; capCspr: number | null }[] = [
  { untilDay: 30, capCspr: 100 }, // first month audited: 4× the unaudited ceiling
  { untilDay: 90, capCspr: 500 }, // months 2–3
  { untilDay: Infinity, capCspr: null }, // after the shakeout window: uncapped
];

/**
 * The pure ramp: given an audit status and the deployment's age in days, what is the per-bet cap in
 * whole CSPR (`null` = uncapped)? Only `audited` can exceed {@link UNAUDITED_MAINNET_CAP_CSPR}; the
 * property tests assert exactly that, plus monotonicity in age for the audited track.
 */
export function rampedCapCspr(status: AuditStatus, ageDays: number): number | null {
  if (status !== "audited") return UNAUDITED_MAINNET_CAP_CSPR;
  const age = Number.isFinite(ageDays) && ageDays >= 0 ? ageDays : 0;
  for (const stage of AUDITED_RAMP) {
    if (age < stage.untilDay) return stage.capCspr;
  }
  return null;
}

/** Read the audit status from env, defaulting to the safe `unaudited`. */
export function auditStatusFromEnv(): AuditStatus {
  const raw = process.env.NEXT_PUBLIC_AUDIT_STATUS;
  if (raw === "audited" || raw === "in-progress") return raw;
  return "unaudited";
}

/** Days since mainnet launch (`NEXT_PUBLIC_MAINNET_LAUNCH_ISO`), or 0 if unset/invalid/future. */
export function mainnetAgeDays(nowMs: number = Date.now()): number {
  const iso = process.env.NEXT_PUBLIC_MAINNET_LAUNCH_ISO;
  if (!iso) return 0;
  const launched = Date.parse(iso);
  if (!Number.isFinite(launched)) return 0;
  const days = (nowMs - launched) / 86_400_000;
  return days > 0 ? days : 0;
}

/**
 * The effective per-bet cap for a network right now, in whole CSPR (`null` = uncapped). Testnet is
 * always uncapped; mainnet follows the ramp from the current audit status + age.
 */
export function currentMaxBetCspr(network: CasperNetwork, nowMs: number = Date.now()): number | null {
  if (network !== "mainnet") return null;
  return rampedCapCspr(auditStatusFromEnv(), mainnetAgeDays(nowMs));
}

export interface BannerDisclosure {
  /** Whether to show the unaudited-build banner — true until the status is `audited`. */
  show: boolean;
  status: AuditStatus;
  /** The current per-bet cap in CSPR (`null` = uncapped), so the banner and the cap never disagree. */
  capCspr: number | null;
}

/** The banner state for a network, from the same policy that sets the cap. */
export function bannerDisclosure(network: CasperNetwork, nowMs: number = Date.now()): BannerDisclosure {
  const status = network === "mainnet" ? auditStatusFromEnv() : "audited";
  return {
    // Testnet never shows the mainnet disclosure; mainnet shows it until audited.
    show: network === "mainnet" && status !== "audited",
    status,
    capCspr: currentMaxBetCspr(network, nowMs),
  };
}
