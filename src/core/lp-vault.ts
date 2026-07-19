/**
 * LP vault accounting (S28) — third parties provide the liquidity that backs an LMSR book and earn
 * the spread + fee share, pro-rata to their contribution. Pure, deterministic share math (the
 * Uniswap/ERC-4626 pattern, integer-safe): the first depositor mints shares 1:1 with their deposit;
 * later depositors mint `deposit · totalShares / poolValue`; withdrawals burn shares for
 * `shares · poolValue / totalShares`. Fees accrue to `poolValue` without minting shares, so every
 * LP's share appreciates — that is how they earn.
 *
 * All amounts are motes as bigint-strings, so there is no float drift in anyone's balance. Division
 * floors (dust stays in the pool, never overpays an LP), mirroring the vault's payout discipline.
 */

export interface LpVaultState {
  /** Total LP shares outstanding. */
  totalShares: string;
  /** Total pool value in motes (deposits + accrued fees − withdrawals). */
  poolValueMotes: string;
  /** Per-LP share balance. */
  sharesByLp: Record<string, string>;
}

export function emptyLpVault(): LpVaultState {
  return { totalShares: "0", poolValueMotes: "0", sharesByLp: {} };
}

/** Shares minted for a deposit into the current pool. First deposit mints 1:1. */
export function sharesForDeposit(state: LpVaultState, depositMotes: string): string {
  const deposit = BigInt(depositMotes);
  if (deposit <= 0n) throw new Error("lp-vault: deposit must be positive");
  const total = BigInt(state.totalShares);
  const value = BigInt(state.poolValueMotes);
  if (total === 0n || value === 0n) return deposit.toString(); // bootstrap 1:1
  return ((deposit * total) / value).toString();
}

/** Deposit motes for `lp`, minting shares. Returns the new state + shares minted. */
export function deposit(state: LpVaultState, lp: string, depositMotes: string): { state: LpVaultState; minted: string } {
  const minted = sharesForDeposit(state, depositMotes);
  const next: LpVaultState = {
    totalShares: (BigInt(state.totalShares) + BigInt(minted)).toString(),
    poolValueMotes: (BigInt(state.poolValueMotes) + BigInt(depositMotes)).toString(),
    sharesByLp: { ...state.sharesByLp, [lp]: (BigInt(state.sharesByLp[lp] ?? "0") + BigInt(minted)).toString() },
  };
  return { state: next, minted };
}

/** Motes returned for burning `shares` at the current pool value (floored). */
export function valueForShares(state: LpVaultState, shares: string): string {
  const s = BigInt(shares);
  const total = BigInt(state.totalShares);
  if (total === 0n) return "0";
  return ((s * BigInt(state.poolValueMotes)) / total).toString();
}

/** Withdraw `shares` for `lp`, burning them and returning motes. Returns the new state + motes out. */
export function withdraw(state: LpVaultState, lp: string, shares: string): { state: LpVaultState; motesOut: string } {
  const burn = BigInt(shares);
  const held = BigInt(state.sharesByLp[lp] ?? "0");
  if (burn <= 0n) throw new Error("lp-vault: withdraw must be positive");
  if (burn > held) throw new Error("lp-vault: insufficient shares");
  const motesOut = valueForShares(state, shares);
  const nextShares = { ...state.sharesByLp, [lp]: (held - burn).toString() };
  if (nextShares[lp] === "0") delete nextShares[lp];
  const next: LpVaultState = {
    totalShares: (BigInt(state.totalShares) - burn).toString(),
    poolValueMotes: (BigInt(state.poolValueMotes) - BigInt(motesOut)).toString(),
    sharesByLp: nextShares,
  };
  return { state: next, motesOut };
}

/** Accrue fees/spread to the pool WITHOUT minting shares — every LP's share appreciates. */
export function accrueFees(state: LpVaultState, feeMotes: string): LpVaultState {
  if (BigInt(feeMotes) < 0n) throw new Error("lp-vault: fee must be non-negative");
  return { ...state, poolValueMotes: (BigInt(state.poolValueMotes) + BigInt(feeMotes)).toString() };
}

/** An LP's current withdrawable value in motes. */
export function lpValue(state: LpVaultState, lp: string): string {
  return valueForShares(state, state.sharesByLp[lp] ?? "0");
}
