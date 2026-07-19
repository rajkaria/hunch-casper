import { describe, it, expect } from "vitest";
import { detectAlerts, DEFAULT_ALERT_THRESHOLDS } from "@/core/alerts";
import { narrateAlert, formatAlertMessage, broadcastTickAlerts } from "@/lib/alerts";
import { createContainer } from "@/lib/container";
import { createMockBotTransport } from "@/adapters/mock/mock-bot-transport";
import type { AgentAction } from "@/adapters/mock/activity-log";
import type { Market } from "@/core/types";

function market(over: Partial<Market> = {}): Market {
  return {
    id: "testnet:m",
    slug: "m",
    title: "Test market",
    category: "casper-native",
    outcomes: [
      { key: "yes", label: "Yes" },
      { key: "no", label: "No" },
    ],
    network: "testnet",
    status: "open",
    feeBps: 200,
    deadlineIso: "2026-08-01T00:00:00.000Z",
    totalStakedMotes: "100000000000", // 100 CSPR
    poolByOutcomeMotes: { yes: "70000000000", no: "30000000000" },
    ...over,
  };
}

function action(over: Partial<AgentAction>): AgentAction {
  return { seq: 0, agent: "Momentum", kind: "bet_placed", marketId: "testnet:m", ts: 0, ...over };
}

describe("detectAlerts", () => {
  const markets = new Map([["m", market()]]);

  it("always alerts on a resolution", () => {
    const alerts = detectAlerts([action({ kind: "market_resolved", outcomeKey: "yes" })], markets);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("resolution");
    expect(alerts[0].headline).toContain("Yes");
  });

  it("alerts on a big absolute bet", () => {
    const alerts = detectAlerts([action({ outcomeKey: "yes", amountMotes: "5000000000" })], markets);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("pool_move");
    expect(alerts[0].amountCspr).toBe("5");
  });

  it("suppresses a small bet that is a trivial share of a large pool", () => {
    const big = new Map([["m", market({ totalStakedMotes: "1000000000000" })]]); // 1000 CSPR pool
    const alerts = detectAlerts([action({ outcomeKey: "yes", amountMotes: "1000000000" })], big); // 1 CSPR
    expect(alerts).toHaveLength(0);
  });

  it("alerts on a small bet that is a large share of a small pool", () => {
    const small = new Map([["m", market({ totalStakedMotes: "3000000000" })]]); // 3 CSPR pool
    const alerts = detectAlerts([action({ outcomeKey: "yes", amountMotes: "1000000000" })], small); // 1 CSPR ≈ 33%
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("pool_move");
  });

  it("thresholds are configurable", () => {
    const strict = { ...DEFAULT_ALERT_THRESHOLDS, bigBetCspr: 100, poolShare: 0.99 };
    const alerts = detectAlerts([action({ outcomeKey: "yes", amountMotes: "5000000000" })], markets, strict);
    expect(alerts).toHaveLength(0);
  });
});

describe("alert narration + dispatch", () => {
  it("narrates via the LLM but falls back to the headline shape", async () => {
    const container = createContainer("testnet");
    const alert = detectAlerts([action({ kind: "market_resolved", outcomeKey: "yes" })], new Map([["m", market()]]))[0];
    const narration = await narrateAlert(container, alert);
    expect(typeof narration).toBe("string");
    expect(narration.length).toBeGreaterThan(0);
    const msg = formatAlertMessage(alert, narration);
    expect(msg).toContain("🏁");
    expect(msg).toContain("/markets/m");
  });

  it("broadcastTickAlerts sends one message per detected alert through the transport", async () => {
    const container = createContainer("testnet");
    const transport = createMockBotTransport("telegram");
    const actions = [
      action({ kind: "market_resolved", outcomeKey: "yes" }),
      action({ outcomeKey: "no", amountMotes: "8000000000" }),
      action({ outcomeKey: "yes", amountMotes: "1", marketId: "testnet:m" }), // negligible → suppressed
    ];
    const { alerts, messages } = await broadcastTickAlerts(container, transport, "alerts-chat", actions, [
      market({ totalStakedMotes: "1000000000000" }),
    ]);
    expect(alerts.length).toBe(2);
    expect(messages.length).toBe(2);
    expect(transport.outbox).toHaveLength(2);
    expect(transport.outbox.every((m) => m.replyTo === "alerts-chat")).toBe(true);
  });
});
