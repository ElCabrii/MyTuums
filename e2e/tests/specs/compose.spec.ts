import { test, expect } from "../../support/fixtures";
import { postCardWithText } from "../../support/post-card";
import { solidPng } from "../../support/image";
import { ALICE } from "../../support/users";

const COMPOSER_PLACEHOLDER = "Share a gaming update, clip, or tournament result...";
const REPLY_PLACEHOLDER = "Post your reply...";

/** Object storage is all-or-nothing in the E2E stack; partial credentials boot without uploads. */
function storageBucketConfigured(): boolean {
  return ["S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].every((key) =>
    Boolean(process.env[key]),
  );
}

test.describe("composing a post", () => {
  test("posting from / adds the new post to the top of the feed", async ({ page, db }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [older] = await db.seedPosts(aliceId, 1, {
      content: () => `Existing feed post ${Date.now().toString()}`,
    });
    if (!older) throw new Error("seedPosts returned no row");

    await page.goto("/");

    const fresh = `Brand new feed post ${Date.now().toString()}`;
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill(fresh);
    await page.getByRole("button", { name: "Post", exact: true }).click();

    const freshLocator = page.getByText(fresh, { exact: true });
    const olderLocator = page.getByText(older.content, { exact: true });
    await expect(freshLocator).toBeVisible();
    await expect(olderLocator).toBeVisible();

    const [freshBox, olderBox] = await Promise.all([
      freshLocator.boundingBox(),
      olderLocator.boundingBox(),
    ]);
    if (!freshBox || !olderBox) throw new Error("expected both posts to have a layout box");
    expect(freshBox.y).toBeLessThan(olderBox.y);
  });

  test("the counter goes negative past 500 characters and disables submit", async ({ page }) => {
    await page.goto("/");
    const textarea = page.getByPlaceholder(COMPOSER_PLACEHOLDER);

    await textarea.fill("x".repeat(505));

    // POST_MAX_LENGTH is 500 (packages/api/src/constants.ts); 505 characters
    // leaves a remaining count of -5.
    await expect(page.getByText("-5", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Post", exact: true })).toBeDisabled();
  });

  test("long multiline drafts grow without horizontal overflow on a mobile viewport", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const textarea = page.getByPlaceholder(COMPOSER_PLACEHOLDER);

    await textarea.fill("Short mobile draft");
    const shortBox = await textarea.boundingBox();
    if (!shortBox) throw new Error("expected the composer textarea to have a layout box");

    const nearLimit = "line\n".repeat(99) + "line";
    await textarea.fill(nearLimit);
    const longMetrics = await textarea.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      overflowY: getComputedStyle(element).overflowY,
    }));

    expect(longMetrics.height).toBeGreaterThan(shortBox.height);
    expect(longMetrics.height).toBeLessThanOrEqual(256);
    expect(longMetrics.overflowY).toBe("auto");
    await expect(page.locator("form").getByText("1", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });

  test("accepting a keyboard mention posts text that LinkedText turns into a profile link", async ({
    page,
  }) => {
    await page.goto("/");
    const prefix = `Keyboard mention ${Date.now().toString()}`;
    const textarea = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await textarea.fill(`${prefix} @al`);

    const suggestion = page.getByRole("option", { name: /Alice Anderson.*@alice/i });
    await expect(suggestion).toBeVisible();
    await textarea.press("ArrowDown");
    await expect(suggestion).toHaveAttribute("aria-selected", "true");
    await textarea.press("Tab");

    const accepted = `${prefix} @alice`;
    await expect(textarea).toHaveValue(accepted);
    await page.getByRole("button", { name: "Post", exact: true }).click();

    const post = page.getByText(accepted, { exact: true });
    await expect(post).toBeVisible();
    await expect(post.getByRole("link", { name: "@alice" })).toHaveAttribute("href", "/@alice");
  });

  test("whitespace-only content cannot be submitted", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill("     ");

    // ComposerForm trims before checking length (components/composer-form.tsx),
    // so an all-whitespace draft never satisfies canSubmit.
    await expect(page.getByRole("button", { name: "Post", exact: true })).toBeDisabled();
  });

  test("the home draft survives a page reload", async ({ page }) => {
    await page.goto("/");
    const draft = `Unsent home draft ${Date.now().toString()}`;
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill(draft);

    await page.reload();

    // composerDraftAtom persists to localStorage (atoms/composer.ts).
    await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toHaveValue(draft);
  });

  test("a reply draft on /post/$id does NOT survive a reload", async ({ page, db }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [seeded] = await db.seedPosts(aliceId, 1, {
      content: () => `Reply draft target ${Date.now().toString()}`,
    });
    if (!seeded) throw new Error("seedPosts returned no row");

    await page.goto(`/post/${seeded.id}`);
    const draft = `Unsent reply draft ${Date.now().toString()}`;
    await page.getByPlaceholder(REPLY_PLACEHOLDER).fill(draft);

    await page.reload();

    // The contrast with the test above is the point: replyDraftAtomFamily is
    // deliberately in-memory (atoms/reply-composer.ts) — a family of
    // localStorage keys, one per post ever replied to, would have nothing
    // able to evict them, so this one empties on reload instead of surviving it.
    await expect(page.getByPlaceholder(REPLY_PLACEHOLDER)).toHaveValue("");
  });
});

test.describe("post image attachments", () => {
  test.skip(!storageBucketConfigured(), "no Storage Bucket configured (S3_* unset)");

  test("uploads a post image and renders the stored /media/posts object", async ({ page }) => {
    await page.goto("/");
    const content = `Post with image ${Date.now().toString()}`;

    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill(content);
    await page.getByLabel("Add images", { exact: true }).setInputFiles({
      name: "post.png",
      mimeType: "image/png",
      buffer: solidPng(800, 600),
    });
    await expect(page.getByRole("img", { name: "post.png" })).toBeVisible();

    await page.getByRole("button", { name: "Post", exact: true }).click();

    const card = postCardWithText(page, content);
    const image = card.getByRole("img", { name: "Attached image 1" });
    await expect(image).toHaveAttribute("src", /^\/media\/posts\//, { timeout: 20_000 });
    const src = await image.getAttribute("src");
    if (!src) throw new Error("expected the stored post image to have a source");
    const response = await page.request.get(src);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image");
  });

  test("uploads and renders the same attachment capability on a reply", async ({ page, db }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [parent] = await db.seedPosts(aliceId, 1, {
      content: () => `Reply image parent ${Date.now().toString()}`,
    });
    if (!parent) throw new Error("seedPosts returned no parent post");

    await page.goto(`/post/${parent.id}`);
    const content = `Reply with image ${Date.now().toString()}`;
    await page.getByPlaceholder(REPLY_PLACEHOLDER).fill(content);
    await page.getByLabel("Add images", { exact: true }).setInputFiles({
      name: "reply.png",
      mimeType: "image/png",
      buffer: solidPng(640, 480),
    });
    await expect(page.getByRole("img", { name: "reply.png" })).toBeVisible();

    await page.getByRole("button", { name: "Reply", exact: true }).click();

    const card = postCardWithText(page, content);
    const image = card.getByRole("img", { name: "Attached image 1" });
    await expect(image).toHaveAttribute("src", /^\/media\/posts\//, { timeout: 20_000 });
    const src = await image.getAttribute("src");
    if (!src) throw new Error("expected the stored reply image to have a source");
    const response = await page.request.get(src);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image");
  });
});
