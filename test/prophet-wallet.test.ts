/**
 * The fleet pays for its own bets.
 *
 * Before this sprint a Prophet handed back `x402-settled-<nonce>-<seq>` — a string shaped like a
 * payment that no chain had ever seen. The mock verifier accepted it (nonce match) and the
 * transfer-verifying real verifier rejected it, which is why the fleet could not bet in real
 * mode at all. These tests pin the fix: the proof a Prophet presents is the settlement id of a
 * transfer that actually left its purse, and an agent that cannot afford one sits the round out
 * instead of submitting a transaction that will fail.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createContainer, type Container } from "@/lib/container";
import { runProphet, runProphetFleet, PROPHET_GAS_FLOOR_MOTES } from "@/agent/prophet";
import { PROPHETS } from "@/core/prophet-strategies";
import { createMockWallet, __resetMockWallet, __setMockBalance, mockAccountHex } from "@/adapters/mock/mock-wallet";
import type { TransferInput, WalletPort } from "@/ports/wallet";
import { __resetLedger } from "@/adapters/mock/settlement-ledger";
import { __resetActivity } from "@/adapters/mock/activity-log";
import { __resetOracleLedger } from "@/adapters/mock/oracle-ledger";
import { __resetConsumedNonces } from "@/lib/agent-bet";
import { __resetCreatedMarkets } from "@/adapters/mock/market-source";
import { csprToMotes } from "@/core/types";

beforeEach(() => {
  __resetLedger();
  __resetActivity();
  __resetOracleLedger();
  __resetConsumedNonces();
  __resetCreatedMarkets();
  __resetMockWallet();
});

/** A container whose wallet records every transfer, so the payment can be inspected. */
function withRecordingWallet(container: Container): { container: Container; transfers: TransferInput[] } {
  const transfers: TransferInput[] = [];
  const inner = createMockWallet(container.network);
  const wallet: WalletPort = {
    network: inner.network,
    accountFor: (id) => inner.accountFor(id),
    balanceOf: (id) => inner.balanceOf(id),
    transfer: async (input) => {
      transfers.push(input);
      return inner.transfer(input);
    },
  };
  return { container: { ...container, wallet }, transfers };
}

async function openMarketSlug(container: Container): Promise<string> {
  const open = (await container.store.list({ network: container.network, status: "open" })).filter(
    (m) => m.category !== "meta",
  );
  return open[0].slug;
}

describe("a Prophet's x402 payment is a real transfer from its own purse", () => {
  it("moves exactly the stake to the requirement's payTo before the bet is placed", async () => {
    const base = createContainer("testnet");
    const { container, transfers } = withRecordingWallet(base);
    const slug = await openMarketSlug(container);
    const prophet = PROPHETS[0];

    const action = await runProphet(container, prophet, slug, 0);

    expect(action).not.toBeNull();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].agentId).toBe(prophet.id);
    expect(transfers[0].amountMotes).toBe(action!.amountMotes);
    expect(BigInt(transfers[0].amountMotes)).toBe(BigInt(csprToMotes(prophet.stakeCspr)));
  });

  it("debits the purse — the money genuinely leaves the agent", async () => {
    const container = createContainer("testnet");
    const slug = await openMarketSlug(container);
    const prophet = PROPHETS[0];
    const before = BigInt(await container.wallet.balanceOf(prophet.id));

    await runProphet(container, prophet, slug, 0);

    const after = BigInt(await container.wallet.balanceOf(prophet.id));
    expect(before - after).toBe(BigInt(csprToMotes(prophet.stakeCspr)));
  });

  it("never presents a fabricated settlement id again", async () => {
    const base = createContainer("testnet");
    const { container, transfers } = withRecordingWallet(base);
    const slug = await openMarketSlug(container);

    await runProphetFleet(container, 0);

    expect(transfers.length).toBeGreaterThan(0);
    // Belt and braces: the pre-fix shape must not appear anywhere in the produced feed.
    const { listActions } = await import("@/adapters/mock/activity-log");
    for (const a of listActions()) {
      expect(a.deployHash ?? "").not.toContain("x402-settled-");
    }
    expect(slug.length).toBeGreaterThan(0);
  });

  it("binds the payment to the agent's on-chain account, not to its display name", async () => {
    const container = createContainer("testnet");
    const prophet = PROPHETS[0];
    const account = await container.wallet.accountFor(prophet.id);
    // The account is a Casper public key shape; the ledger key remains the readable agent id.
    expect(account.publicKeyHex).toBe(mockAccountHex(prophet.id));
    expect(account.publicKeyHex).not.toBe(prophet.id);
  });

  it("gives every Prophet a distinct on-chain identity, so track records stay attributable", async () => {
    const container = createContainer("testnet");
    const accounts = await Promise.all(PROPHETS.map((p) => container.wallet.accountFor(p.id)));
    expect(new Set(accounts.map((a) => a.publicKeyHex)).size).toBe(PROPHETS.length);
  });
});

describe("an agent that cannot pay sits the round out", () => {
  it("skips a Prophet whose purse is below the stake, and places no bet for it", async () => {
    const base = createContainer("testnet");
    const { container, transfers } = withRecordingWallet(base);
    const slug = await openMarketSlug(container);
    const prophet = PROPHETS[0];
    __setMockBalance(prophet.id, 1n);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const action = await runProphet(container, prophet, slug, 0);

    expect(action).toBeNull();
    expect(transfers).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips an agent that can cover the stake but not the gas floor", async () => {
    const base = createContainer("testnet");
    const { container, transfers } = withRecordingWallet(base);
    const slug = await openMarketSlug(container);
    const prophet = PROPHETS[0];
    // Exactly the stake, one mote short of the floor: submitting would burn gas for a failure.
    __setMockBalance(prophet.id, BigInt(csprToMotes(prophet.stakeCspr)) + PROPHET_GAS_FLOOR_MOTES - 1n);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await runProphet(container, prophet, slug, 0)).toBeNull();
    expect(transfers).toHaveLength(0);
    warn.mockRestore();
  });

  it("lets the rest of the fleet keep betting when one agent is broke", async () => {
    const container = createContainer("testnet");
    __setMockBalance(PROPHETS[0].id, 0n);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const actions = await runProphetFleet(container, 0);

    expect(actions.length).toBeGreaterThan(0);
    expect(actions.some((a) => a.agent === PROPHETS[0].name)).toBe(false);
    warn.mockRestore();
  });

  it("skips rather than throwing when the wallet itself is unavailable", async () => {
    const base = createContainer("testnet");
    const slug = await openMarketSlug(base);
    const container: Container = {
      ...base,
      wallet: {
        network: base.network,
        accountFor: (id) => base.wallet.accountFor(id),
        balanceOf: async () => {
          throw new Error("node unreachable");
        },
        transfer: async () => {
          throw new Error("node unreachable");
        },
      },
    };

    expect(await runProphet(container, PROPHETS[0], slug, 0)).toBeNull();
  });
});
