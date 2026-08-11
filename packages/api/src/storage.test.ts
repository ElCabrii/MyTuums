import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIGNED_URL_TTL,
  MEDIA_SIGNING_WINDOW_MS,
  StorageDeleteError,
  createDestructiveStorage,
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

function destructiveStorage() {
  return createDestructiveStorage({
    endpoint: "http://storage.invalid",
    bucket: "test-bucket",
    accessKeyId: "access",
    secretAccessKey: "secret",
    region: "auto",
  });
}

interface DeleteCommandLike {
  input: {
    Delete?: { Objects?: Array<{ Key?: string }> };
  };
}

function deleteInput(command: unknown): DeleteCommandLike["input"] {
  return (command as DeleteCommandLike).input;
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
    expect(secondsUntilWindowEnd(MEDIA_SIGNING_WINDOW_MS / 2)).toBe(
      MEDIA_SIGNING_WINDOW_MS / 2 / 1000,
    );
    expect(secondsUntilWindowEnd(MEDIA_SIGNING_WINDOW_MS - 1)).toBe(1);
  });
});

describe("removeMany", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the number of keys S3 reports as deleted", async () => {
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
      Deleted: [{ Key: "avatars/a" }, { Key: "avatars/b" }],
    } as never);

    await expect(destructiveStorage().removeMany(["avatars/a", "avatars/b"])).resolves.toBe(2);
    expect(send).toHaveBeenCalledOnce();
  });

  it("throws structured details for per-key errors instead of claiming the full batch", async () => {
    vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
      Deleted: [{ Key: "avatars/a" }],
      Errors: [{ Key: "avatars/b", Code: "AccessDenied", Message: "not allowed" }],
    } as never);

    const result = destructiveStorage().removeMany(["avatars/a", "avatars/b"]);

    await expect(result).rejects.toBeInstanceOf(StorageDeleteError);
    await expect(result).rejects.toMatchObject({
      deletedCount: 1,
      failures: [{ key: "avatars/b", code: "AccessDenied", message: "not allowed" }],
    });
  });

  it("keeps 1000-key batching and aggregates successful responses", async () => {
    const keys = Array.from({ length: 2_001 }, (_, index) => `avatars/${index}`);
    const send = vi.spyOn(S3Client.prototype, "send");
    send
      .mockResolvedValueOnce({
        Deleted: keys.slice(0, 1_000).map((Key) => ({ Key })),
      } as never)
      .mockResolvedValueOnce({
        Deleted: keys.slice(1_000, 2_000).map((Key) => ({ Key })),
      } as never)
      .mockResolvedValueOnce({ Deleted: [{ Key: keys[2_000] }] } as never);

    await expect(destructiveStorage().removeMany(keys)).resolves.toBe(keys.length);
    expect(send).toHaveBeenCalledTimes(3);
    for (const [command] of send.mock.calls.slice(0, 2)) {
      expect(deleteInput(command).Delete?.Objects).toHaveLength(1000);
    }
    expect(deleteInput(send.mock.calls[2]?.[0]).Delete?.Objects).toHaveLength(1);
  });

  it("keeps empty input a no-op without touching S3", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");

    await expect(destructiveStorage().removeMany([])).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
