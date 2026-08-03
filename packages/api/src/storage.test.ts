import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIGNED_URL_TTL,
  MEDIA_SIGNING_WINDOW_MS,
  createStorage,
  secondsUntilWindowEnd,
} from "./storage.js";

/**
 * Signing is a local operation — `getSignedUrl` never touches the network —
 * so a throwaway config is enough to pin the one property that matters here:
 * a URL must be a pure function of (key, window), not of the instant it was
 * asked for. That determinism is what makes the object cache reachable at all;
 * without it every redirect signs "now" and the browser re-downloads.
 */

function storageAt(nowMs: number) {
  return createStorage(
    {
      endpoint: "http://storage.invalid",
      bucket: "test-bucket",
      accessKeyId: "access",
      secretAccessKey: "secret",
      region: "auto",
    },
    () => nowMs,
  );
}

/** A millisecond instant near the start of the current window, for determinism. */
const WINDOW_START = Math.floor(Date.now() / MEDIA_SIGNING_WINDOW_MS) * MEDIA_SIGNING_WINDOW_MS;

describe("signedGetUrl", () => {
  it("returns the SAME url for every call within one signing window", async () => {
    const early = await storageAt(WINDOW_START + 1_000).signedGetUrl("avatars/u/1.webp");
    const late = await storageAt(WINDOW_START + MEDIA_SIGNING_WINDOW_MS - 1_000).signedGetUrl(
      "avatars/u/1.webp",
    );

    expect(early).toBe(late);
  });

  it("signs a new url when the window rolls", async () => {
    const before = await storageAt(WINDOW_START - 1_000).signedGetUrl("avatars/u/1.webp");
    const after = await storageAt(WINDOW_START + 1_000).signedGetUrl("avatars/u/1.webp");

    expect(before).not.toBe(after);
  });

  it("keeps the default TTL comfortably above the window, so a URL never dies mid-window", () => {
    // A URL signed at the window start is used until the window rolls; the TTL
    // must cover that plus margin, or a cached redirect would land on an
    // expired signature.
    expect(DEFAULT_SIGNED_URL_TTL).toBeGreaterThan(MEDIA_SIGNING_WINDOW_MS / 1000);
  });
});

describe("secondsUntilWindowEnd", () => {
  it("counts down to the window boundary", () => {
    expect(secondsUntilWindowEnd(0)).toBe(MEDIA_SIGNING_WINDOW_MS / 1000);
    expect(secondsUntilWindowEnd(MEDIA_SIGNING_WINDOW_MS / 2)).toBe(MEDIA_SIGNING_WINDOW_MS / 2 / 1000);
    expect(secondsUntilWindowEnd(MEDIA_SIGNING_WINDOW_MS - 1)).toBe(1);
  });
});
