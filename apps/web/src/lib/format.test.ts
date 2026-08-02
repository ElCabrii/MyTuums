import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCount, formatJoinDate, formatRelativeTime } from "@/lib/format";

const NOW = new Date("2026-08-02T12:00:00.000Z");

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the justNow argument inside +/-30s in the past", () => {
    const date = new Date(NOW.getTime() - 5_000);
    expect(formatRelativeTime(date, "en", "just now")).toBe("just now");
  });

  it("returns the justNow argument inside +/-30s in the future", () => {
    const date = new Date(NOW.getTime() + 5_000);
    expect(formatRelativeTime(date, "en", "just now")).toBe("just now");
  });

  it("escalates through minutes, hours, days, weeks, months, years", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() - 5 * 60_000), "en")).toBe("5 minutes ago");
    expect(formatRelativeTime(new Date(NOW.getTime() - 3 * 3_600_000), "en")).toBe("3 hours ago");
    expect(formatRelativeTime(new Date(NOW.getTime() - 2 * 86_400_000), "en")).toBe("2 days ago");
    expect(formatRelativeTime(new Date(NOW.getTime() - 21 * 86_400_000), "en")).toBe(
      "3 weeks ago",
    );
    expect(formatRelativeTime(new Date(NOW.getTime() - 60 * 86_400_000), "en")).toBe(
      "2 months ago",
    );
    // 800 days rather than something closer to exactly 1 year: `numeric: "auto"`
    // renders -1 year as the idiom "last year" instead of "1 year ago", which
    // would silently break a substring/regex assertion pinned to "ago".
    expect(formatRelativeTime(new Date(NOW.getTime() - 800 * 86_400_000), "en")).toBe(
      "2 years ago",
    );
  });

  it("respects the locale argument", () => {
    const date = new Date(NOW.getTime() - 5 * 60_000);
    expect(formatRelativeTime(date, "en")).toBe("5 minutes ago");
    expect(formatRelativeTime(date, "fr")).toBe("il y a 5 minutes");
    expect(formatRelativeTime(date, "en")).not.toBe(formatRelativeTime(date, "fr"));
  });
});

describe("formatJoinDate", () => {
  it("formats month + year only", () => {
    expect(formatJoinDate(new Date("2026-08-02T00:00:00.000Z"), "en")).toBe("August 2026");
  });

  it("is locale-aware", () => {
    expect(formatJoinDate(new Date("2026-08-02T00:00:00.000Z"), "fr")).toBe("août 2026");
  });
});

describe("formatCount", () => {
  it("leaves small numbers alone", () => {
    expect(formatCount(42)).toBe("42");
  });

  it("compacts thousands", () => {
    expect(formatCount(1200)).toBe("1.2K");
  });

  it("compacts millions", () => {
    expect(formatCount(3_400_000)).toBe("3.4M");
  });

  // Compact notation already leaves 0-999 alone, so 0 needs no special-casing
  // in `formatCount` itself — this just pins that Intl behaviour.
  it("renders 0 as 0", () => {
    expect(formatCount(0)).toBe("0");
  });
});
