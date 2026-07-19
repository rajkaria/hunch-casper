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
});
