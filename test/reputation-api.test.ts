/**
 * The reputation surface — REST, MCP, and the SDK typing.
 *
 * The contract worth pinning is the honesty of the answers: an unknown agent must 404 rather than
 * score zero, a thin sample must carry a caveat rather than a confident-looking number, and
 * manipulation heuristics must arrive as evidence rather than as a verdict. A reputation API that
 * quietly rounds those off is worse than none — consumers would rank on it.
 */

import { describe, it, expect } from "vitest";
import { GET as reputationGET } from "@/app/api/agents/[id]/reputation/route";
import { callTool, MCP_TOOLS } from "@/lib/mcp";
import { demoEventLog } from "@/adapters/mock/mock-events";

/** The mock events stream is the demo lifecycle; these are the agents in it. */
const KNOWN_AGENT = "agent:momentum";

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/agents/[id]/reputation", () => {
  it("returns a chain-derived record led by calibration, not PnL", async () => {
    const res = await reputationGET(
      new Request(`http://localhost/api/agents/${encodeURIComponent(KNOWN_AGENT)}/reputation`),
      params(encodeURIComponent(KNOWN_AGENT)),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.agent).toBe(KNOWN_AGENT);
    expect(json.source).toBe("chain-events");
    expect(json.calibration.baselineBrier).toBe(0.25);
    expect(typeof json.calibration.brier).toBe("number");
    expect(json.calibration.sampleCount).toBeGreaterThan(0);
    expect(json.performance.settledCount).toBeGreaterThan(0);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("404s an agent with no history rather than scoring it zero", async () => {
    // A consumer ranking on an empty record would treat "never bet" as "perfectly calibrated".
    const res = await reputationGET(
      new Request("http://localhost/api/agents/agent:ghost/reputation"),
      params("agent:ghost"),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("no on-chain betting history");
  });

  it("caveats a score built on too little evidence", async () => {
    const res = await reputationGET(
      new Request(`http://localhost/api/agents/${encodeURIComponent(KNOWN_AGENT)}/reputation`),
      params(encodeURIComponent(KNOWN_AGENT)),
    );
    const json = await res.json();
    // The demo log has one settled market, so the thin-sample caveat must be present.
    expect(json.calibration.sampleCount).toBeLessThan(10);
    expect(json.caveats.join(" ")).toContain("not yet meaningful");
  });

  it("returns manipulation signals as a list of evidence, never a verdict field", async () => {
    const res = await reputationGET(
      new Request(`http://localhost/api/agents/${encodeURIComponent(KNOWN_AGENT)}/reputation`),
      params(encodeURIComponent(KNOWN_AGENT)),
    );
    const json = await res.json();
    expect(Array.isArray(json.manipulationSignals)).toBe(true);
    expect(json).not.toHaveProperty("banned");
    expect(json).not.toHaveProperty("trustScore");
  });

  it("decodes a URL-encoded agent id", async () => {
    const encoded = encodeURIComponent(KNOWN_AGENT);
    expect(encoded).toContain("%3A");
    const res = await reputationGET(
      new Request(`http://localhost/api/agents/${encoded}/reputation`),
      params(encoded),
    );
    expect(res.status).toBe(200);
  });
});

describe("MCP get_agent_reputation", () => {
  it("is advertised with a schema requiring the agent", () => {
    const tool = MCP_TOOLS.find((t) => t.name === "get_agent_reputation")!;
    expect(tool).toBeDefined();
    expect((tool.inputSchema as { required: string[] }).required).toEqual(["agent"]);
    // The description has to tell an agent which direction is good, or it will rank backwards.
    expect(tool.description).toContain("lower is better");
  });

  it("returns the same chain-derived record as the REST route", async () => {
    const result = await callTool("get_agent_reputation", { agent: KNOWN_AGENT });
    expect(result.ok).toBe(true);
    const data = (result as { ok: true; data: Record<string, unknown> }).data;
    expect(data.agent).toBe(KNOWN_AGENT);
    expect(data.source).toBe("chain-events");
    expect(data).toHaveProperty("calibration");
    expect(data).toHaveProperty("manipulationSignals");
  });

  it("errors on an unknown agent instead of inventing a record", async () => {
    const result = await callTool("get_agent_reputation", { agent: "agent:ghost" });
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toContain("no on-chain betting history");
  });

  it("requires the agent argument", async () => {
    expect(await callTool("get_agent_reputation", {})).toEqual({ ok: false, error: "agent is required" });
  });
});

describe("the event log the records are folded from", () => {
  it("is a complete lifecycle, so the record is actually derivable", () => {
    const kinds = demoEventLog().map((e) => e.kind);
    expect(kinds).toContain("market_created");
    expect(kinds).toContain("bet_placed");
    expect(kinds).toContain("market_resolved");
  });
});
