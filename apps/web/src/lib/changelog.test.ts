import { describe, expect, it } from "vitest";
import { isNewerAppVersion, shouldShowChangelog } from "@/lib/changelog";

describe("isNewerAppVersion", () => {
  it.each([
    ["0.5.0", null, true],
    ["0.5.0", "0.4.9", true],
    ["0.10.0", "0.9.9", true],
    ["1.0.0", "0.10.0", true],
    ["0.5.0", "0.5.0", false],
    ["0.4.9", "0.5.0", false],
    ["not-a-version", "0.5.0", false],
    ["0.5.0", "not-a-version", true],
  ])("compares %s against %s", (candidate, seen, expected) => {
    expect(isNewerAppVersion(candidate, seen)).toBe(expected);
  });
});

describe("shouldShowChangelog", () => {
  it("shows a current release with content to a new device", () => {
    expect(shouldShowChangelog({ appVersion: "0.5.0", seenVersion: null, hasContent: true })).toBe(
      true,
    );
  });

  it("stays quiet without content and after dismissal or rollback", () => {
    const cases = [
      { appVersion: "0.5.0", seenVersion: null, hasContent: false },
      { appVersion: "0.5.0", seenVersion: "0.5.0", hasContent: true },
      { appVersion: "0.4.0", seenVersion: "0.5.0", hasContent: true },
    ];

    expect(cases.map(shouldShowChangelog)).toEqual([false, false, false]);
  });
});
