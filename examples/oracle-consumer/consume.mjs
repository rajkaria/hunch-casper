#!/usr/bin/env node
/**
 * Runnable oracle-consumer example — the shortest path from "I want Hunch's resolutions" to
 * having one in hand.
 *
 * Deliberately zero-dependency and zero-build: a integration example that first requires an
 * install and a bundler is a worse advertisement than no example. Node 18+ only.
 *
 * It does three things, in the order a real integrator does them:
 *   1. lists what is resolvable,
 *   2. queries one resolution,
 *   3. fetches the evidence behind it and shows you what to verify before trusting it.
 */

const BASE = (process.env.HUNCH_BASE_URL ?? "https://casper.playhunch.xyz").replace(/\/$/, "");

/** Fetch JSON, failing loudly. An integration example that swallows errors teaches the wrong habit. */
async function request(method, path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: payload
      ? { accept: "application/json", "content-type": "application/json" }
      : { accept: "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* handled below */
  }
  // 402 is a normal, expected answer here — not a failure. The query API is metered, and once the
  // free tier is spent the challenge IS the response. An example that treated it as an error
  // would teach integrators to crash on the most common production case.
  if (res.status === 402) return { paymentRequired: true, challenge: parsed };
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}\n${text.slice(0, 400)}`);
  if (parsed === null) throw new Error(`${method} ${path} returned non-JSON:\n${text.slice(0, 200)}`);
  return parsed;
}

const getJson = (path) => request("GET", path);

function line(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

async function main() {
  console.log(`\nHunch oracle consumer — ${BASE}\n${"─".repeat(60)}`);

  // 1. What can be consumed?
  const { markets = [] } = await getJson("/api/markets?network=testnet");
  const resolved = markets.filter((m) => m.status === "resolved");
  console.log(`\n1. Catalogue: ${markets.length} markets, ${resolved.length} resolved.`);

  const target = resolved[0] ?? markets[0];
  if (!target) {
    console.log("\nNothing to consume yet — the catalogue is empty on this deployment.");
    return;
  }

  // 2. Query one resolution. This is the whole "pull" integration.
  console.log(`\n2. Querying "${target.title}" (${target.slug}):`);
  // POST, not GET: the query API is metered per caller, so the request carries who is asking.
  const query = await request("POST", "/api/oracle/query", {
    network: "testnet",
    slug: target.slug,
    caller: process.env.HUNCH_CALLER ?? "example-consumer",
  });

  if (query.paymentRequired) {
    line("status", "402 — free tier spent");
    console.log(
      `\n   The challenge IS the answer: pay the quoted amount over x402 and retry with the proof.\n` +
        `   Tiers and pricing: docs/FEEDS.md`,
    );
  } else {
    line("resolved", String(query.resolved ?? false));
    line("winning outcome", query.winningOutcomeKey ?? "— not settled yet");
    line("claim true?", query.claimResolvedTrue ?? "— not settled yet");
  }

  // 3. Verify before trusting. The point of the whole design.
  console.log(`\n3. Evidence — check this before you build on it:`);
  try {
    const evidence = await getJson(`/api/markets/${encodeURIComponent(target.slug)}/evidence`);
    line("recipe hash", evidence.recipeHash ?? "—");
    line("bundle hash", evidence.bundleHash ?? evidence.hash ?? "—");
    line("readings", Array.isArray(evidence.readings) ? evidence.readings.length : "—");
    console.log(
      `\n   The recipe was frozen before the first bet and anchors on chain. You are not trusting\n` +
        `   our word — you are checking that this rule, on these inputs, yields this outcome.\n` +
        `   If the on-chain recipe hash disagrees with what you were shown, do not integrate.`,
    );
  } catch (err) {
    console.log(`  (no evidence bundle published for this market yet: ${err.message.split("\n")[0]})`);
  }

  console.log(
    `\nPush integration: register your contract against a market id in ResolutionHook and your\n` +
      `callback fires on settlement. A reverting consumer can never block the resolution.\n` +
      `See docs/ORACLE.md §2.\n`,
  );
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}\n`);
  process.exit(1);
});
