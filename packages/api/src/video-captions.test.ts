import { describe, expect, it } from "vitest";
import { normalizeVideoCaptions } from "./video-captions.js";

describe("uploaded WebVTT captions", () => {
  it("keeps timed caption text while removing author styles, regions and positioning", () => {
    expect(
      normalizeVideoCaptions(
        "WEBVTT\n\nSTYLE\n::cue {color:red}\n\ncue-id\n00:00.000 --> 00:01.500 align:start\n<b>Hello</b>\n",
      ),
    ).toBe("WEBVTT\n\n00:00.000 --> 00:01.500\n<b>Hello</b>\n");
  });
  it.each([
    "not a caption",
    "WEBVTT\n\n00:01.000 --> 00:00.000\nbackwards",
    "WEBVTT\n\n00:00.000 --> 00:05:01.000\ntoo long",
    `WEBVTT\n\n00:00.000 --> 00:01.000\n${"x".repeat(200_000)}`,
  ])("refuses malformed or over-limit caption content", (input) => {
    expect(() => normalizeVideoCaptions(input)).toThrow("Invalid captions.");
  });
});
