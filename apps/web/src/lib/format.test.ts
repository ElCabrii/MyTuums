import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCount, formatJoinDate, formatRelativeTime } from "@/lib/format";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const JOINED = new Date("2026-08-02T00:00:00.000Z");

describe("formatRelativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the justNow argument inside +/-30s, in either direction", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() - 5_000), "en", "just now")).toBe("just now");
    expect(formatRelativeTime(new Date(NOW.getTime() + 5_000), "en", "just now")).toBe("just now");
  });

  it("escalates through minutes, hours, days, weeks, months, years", () => {
    const cases = [
      [5 * 60_000, "5 minutes ago"],
      [3 * 3_600_000, "3 hours ago"],
      [2 * 86_400_000, "2 days ago"],
      [21 * 86_400_000, "3 weeks ago"],
      [60 * 86_400_000, "2 months ago"],
      // 800 days rather than something closer to exactly 1 year: `numeric: "auto"`
      // renders -1 year as the idiom "last year" instead of "1 year ago", which
      // would silently break a substring/regex assertion pinned to "ago".
      [800 * 86_400_000, "2 years ago"],
    ] as const;

    expect(cases.map(([ago]) => formatRelativeTime(new Date(NOW.getTime() - ago), "en"))).toEqual(
      cases.map(([, expected]) => expected),
    );
  });

  it("respects the locale argument", () => {
    const date = new Date(NOW.getTime() - 5 * 60_000);
    expect(formatRelativeTime(date, "en")).toBe("5 minutes ago");
    expect(formatRelativeTime(date, "fr")).toBe("il y a 5 minutes");
  });

  it("reuses one formatter per locale instead of rebuilding per call", () => {
    // The cache is module-level, so "de" (unused elsewhere in this file)
    // starts uncached; three calls must construct exactly one formatter.
    const RealRelativeTimeFormat = Intl.RelativeTimeFormat;
    const spy = vi
      .spyOn(Intl, "RelativeTimeFormat")
      .mockImplementation(function (
        locales?: Intl.LocalesArgument,
        options?: Intl.RelativeTimeFormatOptions,
      ) {
        return new RealRelativeTimeFormat(locales, options);
      });
    try {
      const date = new Date(NOW.getTime() - 5 * 60_000);
      formatRelativeTime(date, "de");
      formatRelativeTime(date, "de");
      formatRelativeTime(date, "de");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("formatJoinDate", () => {
  it("formats month + year only, locale-aware", () => {
    expect(formatJoinDate(JOINED, "en")).toBe("August 2026");
    expect(formatJoinDate(JOINED, "fr")).toBe("août 2026");
  });
});

describe("formatCount", () => {
  it("compacts thousands and millions, leaving small numbers alone", () => {
    const cases = [
      [42, "42"],
      [1200, "1.2K"],
      [3_400_000, "3.4M"],
      // Compact notation already leaves 0-999 alone, so 0 needs no
      // special-casing in `formatCount` itself — this just pins that Intl
      // behaviour.
      [0, "0"],
    ] as const;

    expect(cases.map(([n]) => [n, formatCount(n)])).toEqual(
      cases.map(([n, expected]) => [n, expected]),
    );
  });
});
