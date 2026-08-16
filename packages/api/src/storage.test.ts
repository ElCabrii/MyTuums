import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIGNED_URL_TTL,
  MEDIA_SIGNING_WINDOW_MS,
  createDestructiveStorage,
  secondsUntilWindowEnd,
  StorageDeleteError,
} from "./storage.js";

/**
 * Signing is a local operation — `getSignedUrl` never touches the network —
 * so a throwaway config is enough to pin the one property that matters here:
 * a URL must be a pure function of (key, window), not of the instant it was
 * asked for. That determinism is what makes the object cache reachable at all;
 * without it every redirect signs "now" and the browser re-downloads.
 */

function storageAt(nowMs: number) {
  return createDestructiveStorage(
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

afterEach(() => {
  vi.restoreAllMocks();
});

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
    expect(secondsUntilWindowEnd(MEDIA_SIGNING_WINDOW_MS / 2)).toBe(
      MEDIA_SIGNING_WINDOW_MS / 2 / 1000,
    );
    expect(secondsUntilWindowEnd(MEDIA_SIGNING_WINDOW_MS - 1)).toBe(1);
  });
});

describe("removeMany", () => {
  it("surfaces per-key DeleteObjects failures and reports only confirmed progress", async () => {
    // SAFETY: This fixture implements the DeleteObjects response fields consumed by removeMany;
    // the SDK's generic `send` overload cannot infer a concrete command from a prototype spy.
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
      Deleted: [{ Key: "avatars/u/ok.webp" }],
      Errors: [{ Key: "avatars/u/failed.webp", Code: "AccessDenied", Message: "denied" }],
    } as never);
    const storage = storageAt(WINDOW_START);

    const promise = storage.removeMany(["avatars/u/ok.webp", "avatars/u/failed.webp"]);
    await expect(promise).rejects.toBeInstanceOf(StorageDeleteError);

    try {
      await promise;
    } catch (error) {
      expect(error).toMatchObject({
        name: "StorageDeleteError",
        removed: 1,
        failures: [{ key: "avatars/u/failed.webp", code: "AccessDenied", message: "denied" }],
      });
    }
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("treats a requested key omitted from the response as an unconfirmed failure", async () => {
    // SAFETY: This fixture implements the DeleteObjects response fields consumed by removeMany;
    // the SDK's generic `send` overload cannot infer a concrete command from a prototype spy.
    vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
      Deleted: [{ Key: "avatars/u/confirmed.webp" }],
      Errors: [],
    } as never);
    const storage = storageAt(WINDOW_START);

    await expect(
      storage.removeMany(["avatars/u/confirmed.webp", "avatars/u/omitted.webp"]),
    ).rejects.toMatchObject({
      name: "StorageDeleteError",
      removed: 1,
      failures: [
        {
          key: "avatars/u/omitted.webp",
          code: "UnconfirmedDelete",
          message: "The storage provider did not confirm deletion.",
        },
      ],
    });
  });

  it("returns the submitted count when every key succeeds", async () => {
    // SAFETY: This fixture implements the DeleteObjects response fields consumed by removeMany;
    // the SDK's generic `send` overload cannot infer a concrete command from a prototype spy.
    vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
      Deleted: [{ Key: "avatars/u/one.webp" }, { Key: "avatars/u/two.webp" }],
    } as never);
    const storage = storageAt(WINDOW_START);

    await expect(storage.removeMany(["avatars/u/one.webp", "avatars/u/two.webp"])).resolves.toBe(2);
  });
});
