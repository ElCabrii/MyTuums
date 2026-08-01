import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatJoinDate, formatRelativeTime } from "./format";

const NOW = new Date("2026-08-01T12:00:00Z");

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  it("calls anything within half a minute 'just now'", () => {
    expect(formatRelativeTime(NOW)).toBe("just now");
    expect(formatRelativeTime(ago(29_000))).toBe("just now");
  });

  it("counts in minutes, hours and days", () => {
    expect(formatRelativeTime(ago(3 * 60_000))).toBe("3 minutes ago");
    expect(formatRelativeTime(ago(2 * 3_600_000))).toBe("2 hours ago");
    expect(formatRelativeTime(ago(2 * 86_400_000))).toBe("2 days ago");
  });

  it("uses the natural word where the formatter has one", () => {
    expect(formatRelativeTime(ago(86_400_000))).toBe("yesterday");
  });

  // A post's timestamp should never be in the future. It was, before
  // post.created_at became timestamptz: Postgres wrote `now()` as the DB
  // server's local wall clock while Drizzle read the column back as UTC, so
  // on a non-UTC server a fresh post rendered as "in 2 hours". The formatter
  // handling the direction is the last line of defence for that.
  it("still reads sensibly if a timestamp comes back in the future", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + 2 * 3_600_000))).toBe("in 2 hours");
  });

  it("falls back to an absolute date beyond a year", () => {
    const twoYearsAgo = ago(2 * 365 * 86_400_000);
    expect(formatRelativeTime(twoYearsAgo)).toBe("2 years ago");
  });
});

describe("formatJoinDate", () => {
  it("renders month and year only", () => {
    // Constructed in local time so the assertion doesn't hinge on the
    // machine's offset pushing the date into a neighbouring month.
    expect(formatJoinDate(new Date(2026, 7, 15))).toBe("August 2026");
  });
});
