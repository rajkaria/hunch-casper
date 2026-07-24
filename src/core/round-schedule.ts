/**
 * Round math for recurring markets — pure, and indexed from the Unix epoch.
 *
 * Epoch-anchored indexing matters more than it looks: a serverless fleet has no shared memory, so
 * two instances must derive the SAME round number for the same instant without coordinating. A
 * counter stored anywhere would drift the moment one instance missed a tick; `floor(now/interval)`
 * cannot.
 *
 * Windows are half-open `[openMs, deadlineMs)`, matching the vault, which reverts a `bet` once
 * `block_time >= deadline`.
 */

import type { MarketCadence } from "@/core/types";

const MINUTE = 60_000;

/** How long one round of each cadence lasts. `null` ⇒ the market does not recur. */
export function cadenceIntervalMs(cadence: MarketCadence): number | null {
  switch (cadence) {
    case "5-minute":
      return 5 * MINUTE;
    case "hourly":
      return 60 * MINUTE;
    case "weekly":
      return 7 * 24 * 60 * MINUTE;
    case "one-shot":
      return null;
  }
}

/** Which round the given instant falls in. */
export function roundIndexAt(epochMs: number, intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`round interval must be a positive number of ms, got ${intervalMs}`);
  }
  return Math.floor(epochMs / intervalMs);
}

/** The half-open `[openMs, deadlineMs)` window of a round. */
export function roundWindow(
  roundIndex: number,
  intervalMs: number,
): { openMs: number; deadlineMs: number } {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`round interval must be a positive number of ms, got ${intervalMs}`);
  }
  const openMs = roundIndex * intervalMs;
  return { openMs, deadlineMs: openMs + intervalMs };
}

/** The round containing `nowMs`, or `null` for a non-recurring market. */
export function currentRound(
  cadence: MarketCadence,
  nowMs: number,
): { index: number; openMs: number; deadlineMs: number } | null {
  const intervalMs = cadenceIntervalMs(cadence);
  if (intervalMs === null) return null;
  const index = roundIndexAt(nowMs, intervalMs);
  return { index, ...roundWindow(index, intervalMs) };
}
