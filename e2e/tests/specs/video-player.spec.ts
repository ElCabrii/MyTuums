import { test, expect } from "../../support/fixtures";
import { ALICE } from "../../support/users";

for (const [orientation, width, height] of [
  ["portrait", 1080, 1920],
  ["landscape", 1920, 1080],
] as const) {
  test(`${orientation} video fills fullscreen above its controls and restores feed sizing`, async ({
    page,
    db,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.addInitScript(() => localStorage.setItem("my-tuums.video-autoplay", "false"));
    const [post] = await db.seedPosts(await db.getUserId(ALICE.username), 1);
    if (!post) throw new Error("seedPosts returned no row");
    // Supply playback metadata at the HTTP boundary: this regression exercises
    // real fullscreen layout without depending on a bucket or an encoder.
    await page.route("**/rpc/post/thread", async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      // SAFETY: a successful real post.thread response carries this post envelope.
      const body = (await response.json()) as { json: { post: { attachments: unknown[] } } };
      body.json.post.attachments = [
        {
          id: "fullscreen-fixture",
          position: 0,
          url: "/fullscreen-fixture.m3u8",
          contentType: "application/vnd.apple.mpegurl",
          byteSize: 100,
          width,
          height,
          video: {
            duration: 27,
            frameRate: 30,
            renditions: [],
            posterUrl: "/fullscreen-fixture.svg",
            previewUrl: "/fullscreen-fixture.vtt",
            captionUrl: null,
            captionLanguage: null,
          },
        },
      ];
      await route.fulfill({ response, json: body });
    });
    await page.route("**/fullscreen-fixture.svg", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#264653"/></svg>`,
      }),
    );
    await page.goto(`/post/${post.id}`);
    const player = page.getByRole("group", { name: "Post video", exact: true });
    const video = player.locator("video");
    await expect(player).toBeVisible();
    const inline = await video.boundingBox();
    if (!inline) throw new Error("Video has no layout box");
    expect(inline.height).toBeLessThanOrEqual(512);
    await player.getByRole("button", { name: "Toggle fullscreen" }).click();
    await expect
      .poll(() => player.evaluate((element) => element === document.fullscreenElement))
      .toBe(true);
    await expect
      .poll(() => video.evaluate((element) => element.getBoundingClientRect().height))
      .toBeGreaterThan(900);
    await expect
      .poll(() =>
        player.evaluate((element) => {
          const controls = element.lastElementChild;
          return controls
            ? Math.abs(controls.getBoundingClientRect().bottom - innerHeight)
            : Infinity;
        }),
      )
      .toBeLessThanOrEqual(1);
    await expect(player.getByRole("button", { name: "Toggle fullscreen" })).toBeInViewport();
    await player.getByRole("button", { name: "Toggle fullscreen" }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await expect
      .poll(() =>
        video.evaluate(
          (element, inlineHeight) =>
            Math.abs(element.getBoundingClientRect().height - inlineHeight),
          inline.height,
        ),
      )
      .toBeLessThanOrEqual(1);
  });
}
