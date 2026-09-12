import type { StreamBinding, StreamVideo } from "@cloudflare/workers-types";
import { expect, it } from "vitest";
import { createStreamService, StreamError, streamUploadUrl } from "./stream.js";

const id = "11111111-1111-4111-8111-111111111111";
const uid = "a".repeat(32);
const creator = `mytuums-poc:${id}`;

function provider() {
  let exists = true;
  const value: StreamVideo = {
    id: uid,
    creator,
    thumbnail: "",
    thumbnailTimestampPct: 0,
    readyToStream: true,
    readyToStreamAt: "2026-09-10T00:00:00Z",
    status: { state: "ready", errorReasonCode: "", errorReasonText: "" },
    meta: {},
    created: "2026-09-10T00:00:00Z",
    modified: "2026-09-10T00:00:00Z",
    scheduledDeletion: null,
    size: 100,
    allowedOrigins: [],
    requireSignedURLs: true,
    uploaded: "2026-09-10T00:00:00Z",
    uploadExpiry: null,
    maxSizeBytes: null,
    maxDurationSeconds: 300,
    duration: 15,
    input: { width: 1920, height: 1080 },
    hlsPlaybackUrl: "",
    dashPlaybackUrl: "",
    watermark: null,
    clippedFromId: null,
    publicDetails: null,
  };
  const unused = () => Promise.reject(new Error("Unexpected operation"));
  const binding: Pick<StreamBinding, "video"> = {
    video(requested) {
      return {
        id: requested,
        details() {
          if (!exists) {
            const error = new Error("Missing");
            error.name = "NotFoundError";
            return Promise.reject(error);
          }
          return Promise.resolve(value);
        },
        delete() {
          exists = false;
          return Promise.resolve();
        },
        update: unused,
        generateToken: () => Promise.resolve("synthetic.header.signature"),
        captions: { upload: unused, generate: unused, list: unused, delete: unused },
        downloads: { generate: unused, get: unused, delete: unused },
      };
    },
  };
  return { value, binding, exists: () => exists };
}

it("creates a resumable private upload with fixed limits and only opaque creator metadata", async () => {
  const fake = provider();
  const requests: Request[] = [];
  const service = createStreamService({
    binding: fake.binding,
    accountId: "b".repeat(32),
    apiToken: "synthetic-token",
    namespace: "mytuums-poc",
    fetch: (url, options) => {
      requests.push(new Request(url, options));
      return Promise.resolve(
        new Response(null, {
          status: 201,
          headers: {
            "stream-media-id": uid,
            Location: `https://upload.videodelivery.net/tus/${uid}?capability=synthetic`,
          },
        }),
      );
    },
  });
  const expiresAt = new Date("2026-09-11T00:00:00Z");
  const result = await service.createUpload(id, 500_000_000, expiresAt);
  expect(result.uid).toBe(uid);
  const request = requests[0];
  expect(request.url).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${"b".repeat(32)}/stream?direct_user=true`,
  );
  expect(request.method).toBe("POST");
  expect(request.redirect).toBe("manual");
  expect(request.headers.get("upload-length")).toBe("500000000");
  expect(request.headers.get("upload-creator")).toBe(creator);
  expect(request.headers.get("tus-resumable")).toBe("1.0.0");
  expect(request.headers.get("upload-metadata")).toBe(
    `requiresignedurls,maxDurationSeconds ${btoa("300")},expiry ${btoa(expiresAt.toISOString())}`,
  );
  expect(request.headers.get("authorization")).toBe("Bearer synthetic-token");
  expect(JSON.stringify(result)).not.toContain("synthetic-token");
});

it("rejects a provider redirect without issuing an upload capability", async () => {
  const service = createStreamService({
    binding: provider().binding,
    accountId: "b".repeat(32),
    apiToken: "synthetic-token",
    namespace: "mytuums-poc",
    fetch: () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { Location: "https://example.com/untrusted" },
        }),
      ),
  });
  await expect(service.createUpload(id, 100, new Date(Date.now() + 60_000))).rejects.toMatchObject({
    reason: "unavailable",
  });
});

it("refuses public or differently owned video metadata and cannot delete another environment's video", async () => {
  const fake = provider();
  const service = createStreamService({
    binding: fake.binding,
    accountId: "b".repeat(32),
    apiToken: "synthetic-token",
    namespace: "mytuums-poc",
  });
  fake.value.creator = `production:${id}`;
  await expect(service.status(id, uid)).rejects.toMatchObject({ reason: "ownership" });
  await expect(service.remove(id, uid)).rejects.toMatchObject({ reason: "ownership" });
  expect(fake.exists()).toBe(true);
  fake.value.creator = creator;
  fake.value.requireSignedURLs = false;
  await expect(service.status(id, uid)).rejects.toMatchObject({ reason: "not_private" });
  fake.value.requireSignedURLs = true;
  expect(await service.status(id, uid)).toEqual({
    uploaded: true,
    ready: true,
    failed: false,
    duration: 15,
    width: 1920,
    height: 1080,
  });
  await service.remove(id, uid);
  await service.remove(id, uid);
  expect(fake.exists()).toBe(false);
  expect(await service.status(id, uid)).toBeNull();
});

it("recovers unknown create results only within the exact creator namespace", async () => {
  const fake = provider();
  let returnedCreator = creator;
  const service = createStreamService({
    binding: fake.binding,
    accountId: "b".repeat(32),
    apiToken: "synthetic-token",
    namespace: "mytuums-poc",
    fetch: (url) => {
      const target = new URL(new Request(url).url);
      expect(target.searchParams.get("creator")).toBe(creator);
      expect(target.searchParams.get("limit")).toBe("100");
      return Promise.resolve(
        Response.json({ success: true, result: [{ uid, creator: returnedCreator }] }),
      );
    },
  });
  expect(await service.findUploads(id)).toEqual([uid]);
  returnedCreator = "another-environment";
  await expect(service.findUploads(id)).rejects.toMatchObject({ reason: "ownership" });
});

it("bounds provider responses and keeps provider diagnostics out of application errors", async () => {
  const fake = provider();
  let response = new Response("private diagnostics and capabilities", { status: 500 });
  const service = createStreamService({
    binding: fake.binding,
    accountId: "b".repeat(32),
    apiToken: "synthetic-token",
    namespace: "mytuums-poc",
    fetch: () => Promise.resolve(response),
  });
  await expect(service.findUploads(id)).rejects.toThrow(
    "The video provider could not complete this operation.",
  );
  response = new Response("x".repeat(1024 * 1024 + 1));
  await expect(service.findUploads(id)).rejects.toMatchObject({ reason: "invalid_response" });
});

it.each([
  "http://upload.videodelivery.net/tus/id",
  "https://127.0.0.1/upload",
  "https://videodelivery.net.attacker.test/upload",
  "https://user:password@upload.videodelivery.net/upload",
  "https://upload.videodelivery.net:8443/upload",
  "invalid capability",
])("refuses an unsafe provider upload destination: %s", (url) => {
  expect(() => streamUploadUrl(url)).toThrow(StreamError);
});

it("issues playback and thumbnail URLs only for private ready videos on the provider origin", async () => {
  const fake = provider();
  fake.value.hlsPlaybackUrl = `https://customer-synthetic.cloudflarestream.com/${uid}/manifest/video.m3u8`;
  const service = createStreamService({
    binding: fake.binding,
    accountId: "b".repeat(32),
    apiToken: "synthetic-token",
    namespace: "mytuums-poc",
  });
  expect(await service.signedVideoUrl(id, uid, "manifest")).toBe(
    "https://customer-synthetic.cloudflarestream.com/synthetic.header.signature/manifest/video.m3u8",
  );
  const thumbnail = new URL(await service.signedVideoUrl(id, uid, "preview", 2));
  expect(thumbnail.pathname).toBe("/synthetic.header.signature/thumbnails/thumbnail.jpg");
  expect(Object.fromEntries(thumbnail.searchParams)).toEqual({
    time: "2s",
    width: "160",
    height: "90",
    fit: "crop",
  });
  fake.value.requireSignedURLs = false;
  await expect(service.signedVideoUrl(id, uid, "manifest")).rejects.toMatchObject({
    reason: "not_private",
  });
  fake.value.requireSignedURLs = true;
  fake.value.hlsPlaybackUrl = "https://attacker.invalid/manifest.m3u8";
  await expect(service.signedVideoUrl(id, uid, "manifest")).rejects.toMatchObject({
    reason: "invalid_response",
  });
});

it("fetches bounded private captions using the stored language and refuses malformed responses", async () => {
  const fake = provider();
  let body = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello\n";
  const service = createStreamService({
    binding: fake.binding,
    accountId: "b".repeat(32),
    apiToken: "synthetic-token",
    namespace: "mytuums-poc",
    fetch: (url) => {
      expect(new Request(url).url).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${"b".repeat(32)}/stream/${uid}/captions/en/vtt`,
      );
      return Promise.resolve(new Response(body));
    },
  });
  expect(await service.readCaptions(id, uid, "en")).toBe(body);
  body = "Private provider error";
  await expect(service.readCaptions(id, uid, "en")).rejects.toMatchObject({
    reason: "invalid_response",
  });
  await expect(service.readCaptions(id, uid, "../other")).rejects.toMatchObject({
    reason: "invalid_response",
  });
});
