/**
 * The single switch that keeps the live bots off until an operator turns them on.
 *
 * Decision D2 of this run: the bots are *built*, not *run* — no message is ever posted in the
 * user's name without an explicit, deliberate opt-in. Two things must both be true before a real
 * transport will call a platform API:
 *
 *   1. `HUNCH_BOTS_LIVE=true` — the operator has read the runbook and flipped the master switch;
 *   2. the platform's own credential is present (a bot token / API key).
 *
 * Either missing → `send()` throws a clear, actionable error instead of silently dropping the
 * reply or, worse, posting when it shouldn't. `parseUpdate` is never gated: reading an inbound
 * webhook is free and side-effect-free, and gating it would make the bots untestable end to end.
 */

export function botsLive(): boolean {
  return process.env.HUNCH_BOTS_LIVE === "true";
}

/**
 * Assert a real transport is cleared to send, or throw explaining exactly what is missing. Called
 * at the top of every real `send()` so a misconfigured deployment fails loudly and early.
 */
export function assertLiveSend(platform: string, credential: string | undefined, credentialEnv: string): void {
  if (!botsLive()) {
    throw new Error(
      `${platform} bot is built but not live — set HUNCH_BOTS_LIVE=true to enable outbound posts (see docs/OPS.md §bots)`,
    );
  }
  if (!credential) {
    throw new Error(`${platform} bot is live but ${credentialEnv} is unset — cannot authenticate the send`);
  }
}
