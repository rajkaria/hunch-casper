import { describe, it, expect, beforeEach } from "vitest";
import { POST as followPOST, GET as followGET } from "@/app/api/follow/route";
import { __resetFollows } from "@/lib/copy-betting";

beforeEach(() => __resetFollows());

function post(body: unknown): Promise<Response> {
  return followPOST(new Request("http://localhost/api/follow", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

describe("/api/follow", () => {
  it("creates a follow and reads it back", async () => {
    const created = await post({ follower: "u1", agentId: "agent:momentum", scaleBps: 2500 });
    expect(created.status).toBe(200);
    expect((await created.json()).scaleBps).toBe(2500);

    const read = await followGET(new Request("http://localhost/api/follow?follower=u1&agentId=agent:momentum"));
    const json = await read.json();
    expect(json.following).toBe(true);
    expect(json.config.perBetCapMotes).toBe("10000000000"); // default cap
  });

  it("unwinds by setting active:false", async () => {
    await post({ follower: "u1", agentId: "agent:value" });
    await post({ follower: "u1", agentId: "agent:value", active: false });
    const read = await followGET(new Request("http://localhost/api/follow?follower=u1&agentId=agent:value"));
    expect((await read.json()).config.active).toBe(false);
  });

  it("reports not-following for an unknown pair, 400s missing params", async () => {
    const read = await followGET(new Request("http://localhost/api/follow?follower=x&agentId=y"));
    expect((await read.json()).following).toBe(false);
    expect((await followGET(new Request("http://localhost/api/follow?follower=x"))).status).toBe(400);
    expect((await post({ follower: "u1" })).status).toBe(400);
  });

  it("400s non-string identities instead of storing '[object Object]'", async () => {
    expect((await post({ follower: { a: 1 }, agentId: "agent:x" })).status).toBe(400);
    expect((await post({ follower: "u1", agentId: 42 })).status).toBe(400);
    // Nothing was stored under the stringified object.
    const read = await followGET(
      new Request("http://localhost/api/follow?follower=%5Bobject%20Object%5D&agentId=agent:x"),
    );
    expect((await read.json()).following).toBe(false);
  });

  it("requires scaleBps to be a safe integer in 1..10000", async () => {
    expect((await post({ follower: "u1", agentId: "a", scaleBps: 0 })).status).toBe(400);
    expect((await post({ follower: "u1", agentId: "a", scaleBps: -5 })).status).toBe(400);
    expect((await post({ follower: "u1", agentId: "a", scaleBps: 10_001 })).status).toBe(400);
    expect((await post({ follower: "u1", agentId: "a", scaleBps: 2.5 })).status).toBe(400);
    expect((await post({ follower: "u1", agentId: "a", scaleBps: "2500" })).status).toBe(400);
    const ok = await post({ follower: "u1", agentId: "a", scaleBps: 10_000 });
    expect(ok.status).toBe(200);
    expect((await ok.json()).scaleBps).toBe(10_000);
  });

  it("requires perBetCapMotes (when present) to be a digits-only string", async () => {
    expect((await post({ follower: "u1", agentId: "a", perBetCapMotes: 5 })).status).toBe(400);
    expect((await post({ follower: "u1", agentId: "a", perBetCapMotes: "1e9" })).status).toBe(400);
    expect((await post({ follower: "u1", agentId: "a", perBetCapMotes: "-5" })).status).toBe(400);
    const ok = await post({ follower: "u1", agentId: "a", perBetCapMotes: "5000000000" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).perBetCapMotes).toBe("5000000000");
  });

  it("caps identity lengths at 128 characters", async () => {
    const long = "x".repeat(129);
    expect((await post({ follower: long, agentId: "a" })).status).toBe(400);
    expect((await post({ follower: "u", agentId: long })).status).toBe(400);
    expect((await post({ follower: "x".repeat(128), agentId: "a" })).status).toBe(200);
  });
});
