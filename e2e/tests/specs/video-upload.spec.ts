import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "../../support/fixtures";
import { testPlatform } from "../../support/platform";
import { E2E_STREAM_ORIGIN, streamFixtureKey, streamFixtureUpload } from "../../stream-fixture";

/** The committed fixture: a real 2 s, 320×240, 30 fps H.264/AAC MP4. */
const transportFixture = fileURLToPath(new URL("../../fixtures/transport.mp4", import.meta.url));

/**
 * The fixture padded to `bytes` with a legal trailing `free` box. The
 * composer's local preflight (issue #404) reads real container metadata
 * before creating any upload, so synthetic zero bytes are refused; the
 * padding keeps this spec's file above the 8 MiB chunk boundary so the tus
 * transport still splits, gets interrupted and resumes across parts.
 */
function transportVideo(bytes: number): Buffer {
  const base = readFileSync(transportFixture);
  const padding = bytes - base.length - 8;
  if (padding < 0) throw new Error("Transport fixture is larger than the requested size.");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(padding + 8, 0);
  header.write("free", 4, "ascii");
  return Buffer.concat([base, header, Buffer.alloc(padding)]);
}

test("video tus recovery keeps explicit submission and durable pending UI (issue #368)", async ({
  page,
  bobPage,
}) => {
  test.setTimeout(90_000);
  const { bucket } = await testPlatform();
  const uploads = new Set<string>();
  let interrupted = false;
  let firstPartRequests = 0;
  const confirmedOffsets: number[] = [];
  // Every request to the synthetic provider is intercepted, including OPTIONS;
  // route.fulfill never forwards capabilities or source bytes to the Internet.
  await page.route(`${E2E_STREAM_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const uid = new URL(request.url()).pathname.slice(1);
    const key = streamFixtureKey(uid);
    uploads.add(key);
    const object = await bucket.get(key);
    expect(object).not.toBeNull();
    if (!object) throw new Error("Synthetic upload was not created by the API.");
    const upload = streamFixtureUpload.parse(await object.json());
    const headers = {
      "Access-Control-Allow-Origin": "http://localhost:5273",
      "Access-Control-Allow-Methods": "HEAD, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Tus-Resumable, Upload-Offset, Content-Type",
      "Access-Control-Expose-Headers": "Upload-Length, Upload-Offset, Tus-Resumable",
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(upload.byteSize),
      "Upload-Offset": String(upload.offset),
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (request.method() === "HEAD") {
      confirmedOffsets.push(upload.offset);
      await route.fulfill({ status: 200, headers });
      return;
    }
    expect(request.method()).toBe("PATCH");
    expect(request.headers()["upload-offset"]).toBe(String(upload.offset));
    if (upload.offset === 0) firstPartRequests += 1;
    const bytes = request.postDataBuffer()?.byteLength ?? 0;
    expect(bytes).toBeGreaterThan(0);
    upload.offset += bytes;
    expect(upload.offset).toBeLessThanOrEqual(upload.byteSize);
    await bucket.put(key, JSON.stringify(upload));
    if (!interrupted) {
      interrupted = true;
      await route.abort("internetdisconnected");
      return;
    }
    await route.fulfill({
      status: 204,
      headers: { ...headers, "Upload-Offset": String(upload.offset) },
    });
  });
  try {
    await page.goto("/");
    const content = `Pending video browser recovery ${Date.now().toString()}`;
    const composer = page.getByPlaceholder("Share a gaming update, clip, or tournament result...");
    await composer.fill(content);
    // Synthetic bytes exercise tus transport only; they do not prove hosted
    // Stream codec processing or playback.
    await page.getByRole("button", { name: "Add media", exact: true }).click();
    await page.getByLabel("Choose images or a video", { exact: true }).setInputFiles({
      name: "transport.mp4",
      mimeType: "video/mp4",
      buffer: transportVideo(9 * 1024 * 1024),
    });
    await expect(
      page.getByText("Upload complete. Submit your post when you’re ready."),
    ).toBeVisible({ timeout: 60_000 });
    expect(interrupted).toBe(true);
    expect(firstPartRequests).toBe(1);
    expect(confirmedOffsets).toEqual([0, 8 * 1024 * 1024]);
    await expect(page.locator("p").filter({ hasText: content })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Post", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await expect(composer).toHaveValue("");
    await expect(page.getByText("Processing video", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(content, { exact: true })).toBeVisible();
    await bobPage.goto("/");
    await expect(bobPage.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(bobPage.getByText(content, { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel pending post" }).click();
    await expect(page.getByText(content, { exact: true })).toHaveCount(0);
  } finally {
    for (const key of uploads) await bucket.delete(key);
  }
});
