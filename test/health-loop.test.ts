import { describe, expect, it } from "vitest";
import { loopChecks } from "@/core/health";

const DAY = 86_400_000;

describe("loop liveness checks", () => {
  it("fails when the economy has bet for a day and never resolved", () => {
    const checks = loopChecks({
      nowMs: 10 * DAY,
      betCount: 40,
      resolutionCount: 0,
      oldestBetMs: 7 * DAY,
      distinctAgents: 1,
      distinctMarkets: 1,
      recentActionCount: 40,
    });
    const resolution = checks.find((c) => c.name === "loop.resolution")!;
    expect(resolution.status).toBe("fail");
    expect(resolution.detail).toMatch(/not closing/i);
  });

  it("passes when resolutions are flowing and rotation is healthy", () => {
    const checks = loopChecks({
      nowMs: 10 * DAY,
      betCount: 40,
      resolutionCount: 6,
      oldestBetMs: 9.5 * DAY,
      distinctAgents: 4,
      distinctMarkets: 9,
      recentActionCount: 40,
    });
    expect(checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("fails when one agent placed nearly every recent bet", () => {
    const checks = loopChecks({
      nowMs: 10 * DAY,
      betCount: 40,
      resolutionCount: 6,
      oldestBetMs: 9.5 * DAY,
      distinctAgents: 1,
      distinctMarkets: 1,
      recentActionCount: 40,
    });
    expect(checks.find((c) => c.name === "loop.rotation")!.status).toBe("fail");
  });

  it("stays quiet on a cold economy rather than crying wolf", () => {
    const checks = loopChecks({
      nowMs: 10 * DAY,
      betCount: 0,
      resolutionCount: 0,
      oldestBetMs: null,
      distinctAgents: 0,
      distinctMarkets: 0,
      recentActionCount: 0,
    });
    expect(checks.every((c) => c.status === "ok")).toBe(true);
  });

  it("gives a young economy the benefit of the doubt on resolution", () => {
    const checks = loopChecks({
      nowMs: 10 * DAY,
      betCount: 3,
      resolutionCount: 0,
      oldestBetMs: 10 * DAY - 60_000, // betting for a minute
      distinctAgents: 2,
      distinctMarkets: 3,
      recentActionCount: 3,
    });
    expect(checks.find((c) => c.name === "loop.resolution")!.status).toBe("ok");
  });

  it("reproduces the production report exactly", () => {
    // 40 bets, 0 resolutions, one agent, one market, over 2.7 days — every other check was green.
    const checks = loopChecks({
      nowMs: 1_784_892_059_631,
      betCount: 40,
      resolutionCount: 0,
      oldestBetMs: 1_784_661_757_470,
      distinctAgents: 1,
      distinctMarkets: 1,
      recentActionCount: 40,
    });
    expect(checks.filter((c) => c.status === "fail")).toHaveLength(2);
  });
});
