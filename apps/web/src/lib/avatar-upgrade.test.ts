import { describe, expect, it } from "vitest";
import { IMAGE_LIMITS } from "@my-tuums/api/constants";
import { isBelowAvatarDisplayCeiling } from "@/lib/avatar-upgrade";

/**
 * Issue #246: the acceptance line "a fresh (>= ceiling) upload never triggers
 * the prompt" rests on this comparison, so it is pinned at the ceiling the
 * encoder itself reads (`IMAGE_LIMITS.avatar`) — raising the ceiling moves the
 * detector with it.
 */
describe("isBelowAvatarDisplayCeiling", () => {
  it("flags a display variant at the pre-#233 ceiling", () => {
    expect(isBelowAvatarDisplayCeiling(512)).toBe(true);
  });

  it("accepts a variant at today's ceiling", () => {
    expect(isBelowAvatarDisplayCeiling(IMAGE_LIMITS.avatar.maxWidth)).toBe(false);
  });

  it("accepts anything larger", () => {
    expect(isBelowAvatarDisplayCeiling(IMAGE_LIMITS.avatar.maxWidth + 1)).toBe(false);
  });

  it("reads no prompt out of a failed measurement", () => {
    expect(isBelowAvatarDisplayCeiling(null)).toBe(false);
  });
});
