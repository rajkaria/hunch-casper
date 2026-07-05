#!/usr/bin/env node
/**
 * The economy driver — hits `/api/agent/tick` on an interval so the whole loop (Prophets bet →
 * Arbiter resolves → boards update) runs unattended. This is the plan-independent way to run the
 * live economy during a demo (it works against local dev or prod, no Vercel cron plan required).
 *
 * Usage:
 *   node scripts/economy-loop.mjs [baseUrl] [intervalSeconds]
 *   BASE_URL=https://hunch-casper.vercel.app node scripts/economy-loop.mjs
 *   CRON_SECRET=… node scripts/economy-loop.mjs            # if the deploy is in real mode
 *
 * Defaults: baseUrl http://localhost:3000, interval 20s. Ctrl-C to stop.
 */

const baseUrl = (process.argv[2] || process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const intervalMs = Number(process.argv[3] || process.env.INTERVAL_SECONDS || 20) * 1000;
const secret = process.env.CRON_SECRET || process.env.TICK_CRON_SECRET || "";
const network = process.env.NETWORK || "testnet";

const headers = { "content-type": "application/json" };
if (secret) headers["x-cron-secret"] = secret;

let round = 0;

async function tick() {
  round += 1;
  try {
    const res = await fetch(`${baseUrl}/api/agent/tick`, {
      method: "POST",
      headers,
      body: JSON.stringify({ network }),
    });
    if (!res.ok) {
      console.error(`[tick ${round}] HTTP ${res.status}: ${await res.text()}`);
      return;
    }
    const j = await res.json();
    const top = j.leaderboard?.[0];
    const arbiter = j.oracleAccuracy?.[0];
    console.log(
      `[tick ${round}] placed=${j.placed} resolved=${j.resolved}` +
        (top ? ` · leader=${top.name} ${(Number(top.realizedPnlMotes) / 1e9).toFixed(2)} CSPR` : "") +
        (arbiter ? ` · arbiter=${(arbiter.accuracyBps / 100).toFixed(1)}%` : ""),
    );
  } catch (err) {
    console.error(`[tick ${round}] ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`Economy loop → ${baseUrl}/api/agent/tick every ${intervalMs / 1000}s (network=${network})`);
await tick();
setInterval(tick, intervalMs);
