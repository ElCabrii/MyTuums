import { fileURLToPath } from "node:url";
import { test, expect } from "../../support/fixtures";
import { BOB } from "../../support/users";
import { testPlatform } from "../../support/platform";
import { E2E_STREAM_ORIGIN, streamFixtureKey, streamFixtureUpload } from "../../stream-fixture";

// These crossings require a browser: canvas → multipart → private image,
// MediaRecorder → private audio playback, and tus → a processing message.
test("message images, recorded voice and video survive send and recipient reload", async ({
  page,
  bobPage,
  db,
}) => {
  test.setTimeout(90_000);
  const bobId = await db.getUserId(BOB.username);
  await page.goto(`/messages/new/${bobId}`);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAEElEQVR4nGP4y8AARAwQCgAfrgP19hgqWQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.getByRole("button", { name: "Add media", exact: true }).click();
  await page
    .getByLabel("Choose images or a video", { exact: true })
    .setInputFiles({ name: "message.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(/\/messages\/[0-9a-f-]{36}$/);
  const threadPath = new URL(page.url()).pathname;
  await bobPage.goto(threadPath);
  const image = bobPage.getByRole("img", { name: "Attached image 1", exact: true }).last();
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
    )
    .toBe(true);

  // A generated tone replaces microphone hardware only. The real recorder,
  // UI, multipart upload, authorization and browser decoder remain in use.
  await page.evaluate(() => {
    const audio = new AudioContext();
    const output = audio.createMediaStreamDestination();
    const tone = audio.createOscillator();
    tone.connect(output);
    tone.start();
    navigator.mediaDevices.getUserMedia = async () => {
      await audio.resume();
      return output.stream;
    };
  });
  await page.getByRole("button", { name: "Record a voice message", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /0:0[1-9]/ })).toBeVisible();
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove voice message" })).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(bobPage.getByRole("button", { name: "Play voice message" }).last()).toBeVisible();
  await bobPage.reload();
  await bobPage.getByRole("button", { name: "Play voice message" }).last().click();
  await expect
    .poll(() =>
      bobPage
        .locator("audio")
        .last()
        .evaluate((element: HTMLAudioElement) => element.currentTime > 0 && element.error === null),
    )
    .toBe(true);

  const { bucket } = await testPlatform();
  await page.route(`${E2E_STREAM_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const uid = new URL(request.url()).pathname.slice(1);
    const key = streamFixtureKey(uid);
    const object = await bucket.get(key);
    if (!object) throw new Error("Synthetic message upload was not created");
    const upload = streamFixtureUpload.parse(await object.json());
    if (request.method() === "PATCH") {
      upload.offset += request.postDataBuffer()?.byteLength ?? 0;
      await bucket.put(key, JSON.stringify(upload));
    }
    await route.fulfill({
      status: request.method() === "HEAD" ? 200 : 204,
      headers: {
        "Access-Control-Allow-Origin": "http://localhost:5273",
        "Access-Control-Allow-Methods": "HEAD, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Tus-Resumable, Upload-Offset, Content-Type",
        "Access-Control-Expose-Headers": "Upload-Length, Upload-Offset, Tus-Resumable",
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(upload.byteSize),
        "Upload-Offset": String(upload.offset),
      },
    });
  });
  await page.getByRole("button", { name: "Add media", exact: true }).click();
  await page
    .getByLabel("Choose images or a video", { exact: true })
    .setInputFiles(fileURLToPath(new URL("../../fixtures/transport.mp4", import.meta.url)));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(bobPage.getByRole("status").filter({ hasText: "Video processing…" })).toBeVisible();
  await bobPage.reload();
  await expect(bobPage.getByRole("status").filter({ hasText: "Video processing…" })).toBeVisible();
});
