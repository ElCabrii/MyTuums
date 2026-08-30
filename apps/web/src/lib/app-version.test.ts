import { describe, expect, it } from "vitest";
import { appStage, type AppStage } from "@/lib/app-version";

/**
 * The version → stage map, as two tables: the boundaries the rule actually
 * has (0.x below 0.5 is alpha, 0.5+ is beta, 1.0+ is untagged) and the
 * degradation rule for anything that does not parse as a version at all.
 * One row per boundary, not one test per example — a row still names the
 * offending input in the diff when it fails.
 */
describe("appStage", () => {
  it("splits 0.x at 0.5 and stops tagging at 1.0", () => {
    const cases: Array<[string, AppStage]> = [
      ["0.0.0", "alpha"],
      ["0.4.2", "alpha"],
      ["0.5.0", "beta"],
      ["0.5.0-beta.1", "beta"],
      ["0.9.9", "beta"],
      ["1.0.0", null],
      ["2.1.3", null],
    ];

    expect(cases.map(([version]) => [version, appStage(version)])).toEqual(cases);
  });

  it("degrades an unparseable version to no tag rather than crashing or guessing", () => {
    // A `v` prefix is the realistic one: it is what a user-supplied or
    // tag-derived string looks like. The rest pin that partial numbers do not
    // fall through to a stage by accident.
    const unparseable = ["v0.4.2", "garbage", "", "1", "0."];

    expect(unparseable.map((version) => [version, appStage(version)])).toEqual(
      unparseable.map((version) => [version, null]),
    );
  });
});
