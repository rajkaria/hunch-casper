/**
 * Feed timestamps. The compact relative time must keep making sense as the feed ages — it used
 * to cap at hours, so a two-day-old action read "54h ago" instead of "2d ago".
 */

import { describe, it, expect } from "vitest";
import { relativeTime } from "@/components/activity-feed";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_753_800_000_000;

const ago = (ms: number): string => relativeTime(NOW - ms, NOW);

describe("relativeTime", () => {
  it("is empty without a timestamp", () => {
    expect(relativeTime(undefined, NOW)).toBe("");
  });

  it("says 'now' inside five seconds", () => {
    expect(ago(2 * SEC)).toBe("now");
  });

  it("counts seconds, then minutes, then hours", () => {
    expect(ago(12 * SEC)).toBe("12s ago");
    expect(ago(4 * MIN)).toBe("4m ago");
    expect(ago(2 * HOUR)).toBe("2h ago");
  });

  it("stays in hours up to 47h", () => {
    expect(ago(44 * HOUR)).toBe("44h ago");
    expect(ago(47 * HOUR)).toBe("47h ago");
  });

  it("switches to days from 48h", () => {
    expect(ago(48 * HOUR)).toBe("2d ago");
    expect(ago(3 * DAY)).toBe("3d ago");
    expect(ago(10 * DAY)).toBe("10d ago");
  });

  it("never goes negative on clock skew", () => {
    expect(relativeTime(NOW + 30 * SEC, NOW)).toBe("now");
  });
});
