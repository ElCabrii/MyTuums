import { describe, expect, it } from "vitest";
import { appStage, type AppStage } from "@/lib/app-version";

describe("appStage", () => {
  const cases: Array<[string, AppStage]> = [
    ["0.0.0", "alpha"],
    ["0.4.2", "alpha"],
    ["0.5.0", "beta"],
    ["0.9.9", "beta"],
    ["0.5.0-beta.1", "beta"],
    ["1.0.0", null],
    ["2.1.3", null],
  ];

  it.each(cases)("%s", (version, expected) => {
    expect(appStage(version)).toBe(expected);
  });

  // Not semver-ish at all must degrade to no tag rather than crash or lie.
  it.each([
    ["a user-supplied v-prefixed string", "v0.4.2"],
    ["garbage", "garbage"],
    ["empty", ""],
    ["major only", "1"],
    ["dot with no minor", "0."],
  ])("unparseable %s yields no tag", (_label, version) => {
    expect(appStage(version)).toBeNull();
  });
});
