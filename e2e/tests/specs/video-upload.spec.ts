import { test, expect } from "../../support/fixtures";
import { createVideoStorage } from "@my-tuums/api/video-worker";

test("video multipart recovery keeps explicit submission and durable pending UI (issue #368)", async ({
  page,
  bobPage,
}) => {
  test.setTimeout(90_000);
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  test.skip(
    !endpoint || !bucket || !accessKeyId || !secretAccessKey,
    "no Storage Bucket configured",
  );
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return;
  if (!/(?:^|-)(?:dev|ci)(?:-|$)/.test(bucket))
    throw new Error("Video tests require the dev or CI bucket.");
  const storage = createVideoStorage({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: process.env.S3_REGION ?? "auto",
  });
  const uploads = new Map<string, string>();
  let interrupted = false;
  let firstPartRequests = 0;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const key = /videos\/[0-9a-f-]{36}\/source$/.exec(url.pathname)?.[0];
    const uploadId = url.searchParams.get("uploadId");
    if (route.request().method() === "PUT" && key && uploadId) {
      uploads.set(key, uploadId);
      if (url.searchParams.get("partNumber") === "1") firstPartRequests += 1;
      if (url.searchParams.get("partNumber") === "2" && !interrupted) {
        interrupted = true;
        await route.abort("internetdisconnected");
        return;
      }
    }
    await route.continue();
  });
  try {
    await page.goto("/");
    const content = `Pending video browser recovery ${Date.now().toString()}`;
    const composer = page.getByPlaceholder("Share a gaming update, clip, or tournament result...");
    await composer.fill(content);
    // This fixture exercises direct browser multipart transport. Native format
    // validation and playable output are covered by the worker's media tests.
    await page.getByRole("button", { name: "Add media", exact: true }).click();
    await page.getByLabel("Choose images or a video", { exact: true }).setInputFiles({
      name: "transport.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.alloc(9 * 1024 * 1024),
    });
    await expect(
      page.getByText("Upload complete. Submit your post when you’re ready."),
    ).toBeVisible({ timeout: 60_000 });
    expect(interrupted).toBe(true);
    expect(firstPartRequests).toBe(1);
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
    // Only capabilities created by this page are cleaned. A local test database
    // may share the dev bucket, so a bucket-wide video sweep would be unsafe.
    for (const [key, uploadId] of uploads) {
      await storage.abortMultipart(key, uploadId);
      await storage.removePrefix(key.slice(0, -"source".length));
    }
  }
});
