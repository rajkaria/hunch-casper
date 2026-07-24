import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/league/route";
import { LEAGUE_EPOCH_MS, seasonAt, WEEK_MS } from "@/core/seasons";

async function league(qs = ""): Promise<Record<string, unknown>> {
  const res = await GET(new Request(`http://x/api/league${qs}`));
  return (await res.json()) as Record<string, unknown>;
}

describe("league season rollover", () => {
  it("serves the CURRENT season when none is requested", async () => {
    // The defect: `Number(url.searchParams.get("season"))` is Number(null) === 0 for an absent
    // param, and 0 passes an `isInteger && >= 0` guard — so the route pinned itself to season 0
    // forever. Production served `weekly-0`, closed six days earlier, with no standings.
    const body = await league();
    const expected = seasonAt("weekly", LEAGUE_EPOCH_MS, Date.now());
    expect((body.season as { id: string }).id).toBe(expected.id);
  });

  it("the current season is never already closed", async () => {
    const body = await league();
    expect(body.closed).toBe(false);
  });

  it("still honours an explicitly requested season", async () => {
    const body = await league("?season=0");
    expect((body.season as { id: string }).id).toBe("weekly-0");
  });

  it("season 0 requested explicitly is distinguishable from no request", async () => {
    const current = (await league()).season as { index: number };
    const zero = (await league("?season=0")).season as { index: number };
    // These must differ, or the guard is still collapsing "unset" onto 0.
    expect(current.index).toBeGreaterThan(zero.index);
  });

  it("rolls forward as weeks pass, without any stored counter", async () => {
    const a = seasonAt("weekly", LEAGUE_EPOCH_MS, Date.now());
    const b = seasonAt("weekly", LEAGUE_EPOCH_MS, Date.now() + WEEK_MS);
    expect(b.index).toBe(a.index + 1);
    expect(b.startMs).toBe(a.endMs);
  });

  it("supports the monthly cadence too", async () => {
    const body = await league("?cadence=monthly");
    expect((body.season as { cadence: string }).cadence).toBe("monthly");
    expect(body.closed).toBe(false);
  });

  it("archives every season up to the current one", async () => {
    const body = await league("?archive=true");
    const seasons = body.seasons as Array<{ index: number }>;
    const current = seasonAt("weekly", LEAGUE_EPOCH_MS, Date.now());
    expect(seasons.length).toBeGreaterThan(0);
    expect(Math.max(...seasons.map((s) => s.index))).toBe(current.index);
  });
});
