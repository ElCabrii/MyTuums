import { test, expect } from "../../support/fixtures";
import { ALICE } from "../../support/users";
import { likeButtonFor } from "../../support/post-card";

const REPLY_PLACEHOLDER = "Post your reply...";

/**
 * Mirrors `THREAD_ANCESTOR_MAX` in packages/api/src/constants.ts.
 *
 * It could be imported — `@my-tuums/api` is a dependency of this package
 * (added for the destructive-storage cleanup in support/db.ts) and exports
 * `./constants` — but the spec pins its own literal: the seeded chain depth
 * and the expected truncation copy both derive from it here, and a mirror
 * that drifts from the server constant fails the truncation test loudly
 * instead of quietly seeding a different depth.
 */
const THREAD_ANCESTOR_MAX = 20;

test.describe("thread", () => {
  test("replying appears below and increments the focused post's reply count", async ({
    page,
    db,
  }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [seeded] = await db.seedPosts(aliceId, 1, {
      content: () => `Reply count target ${Date.now().toString()}`,
    });
    if (!seeded) throw new Error("seedPosts returned no row");

    await page.goto(`/post/${seeded.id}`);
    await expect(page.getByText("0 replies", { exact: true })).toBeVisible();

    const replyText = `A fresh reply ${Date.now().toString()}`;
    await page.getByPlaceholder(REPLY_PLACEHOLDER).fill(replyText);
    await page.getByRole("button", { name: "Reply" }).click();

    await expect(page.getByText(replyText, { exact: true })).toBeVisible();
    // reply_count_one vs reply_count_many (thread-page.tsx) — singular once
    // the count is exactly 1.
    await expect(page.getByText("1 reply", { exact: true })).toBeVisible();
  });

  test("a cold deep-link to a reply renders its ancestor chain above it", async ({ page, db }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const marker = Date.now().toString();
    const [root] = await db.seedPosts(aliceId, 1, { content: () => `Root of chain ${marker}` });
    if (!root) throw new Error("seedPosts returned no row");
    const middle = await db.seedReply(aliceId, root.id, `Middle of chain ${marker}`);
    const leaf = await db.seedReply(aliceId, middle.id, `Leaf of chain ${marker}`);

    // Fresh navigation straight to the leaf — the feed/home page is never
    // visited first, so nothing has warmed a cache with the ancestors ahead
    // of time.
    await page.goto(`/post/${leaf.id}`);

    const rootLocator = page.getByText(root.content, { exact: true });
    const middleLocator = page.getByText(middle.content, { exact: true });
    const leafLocator = page.getByText(leaf.content, { exact: true });
    await expect(rootLocator).toBeVisible();
    await expect(middleLocator).toBeVisible();
    await expect(leafLocator).toBeVisible();

    const [rootBox, middleBox, leafBox] = await Promise.all([
      rootLocator.boundingBox(),
      middleLocator.boundingBox(),
      leafLocator.boundingBox(),
    ]);
    if (!rootBox || !middleBox || !leafBox) throw new Error("expected a layout box for each post");
    expect(rootBox.y).toBeLessThan(middleBox.y);
    expect(middleBox.y).toBeLessThan(leafBox.y);
  });

  test("liking a reply works", async ({ page, db }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [post] = await db.seedPosts(aliceId, 1, {
      content: () => `Parent for reply like ${Date.now().toString()}`,
    });
    if (!post) throw new Error("seedPosts returned no row");
    const reply = await db.seedReply(aliceId, post.id, `Reply to like ${Date.now().toString()}`);

    // This is exactly why replies are a *mode* of post.list rather than
    // their own procedure (see packages/api/src/posts.ts): a separate
    // procedure would sit outside the web app's optimistic like sweep, and
    // this like would silently stop reconciling.
    await page.goto(`/post/${post.id}`);
    const replyLike = likeButtonFor(page, reply.content);
    await expect(replyLike).toHaveAttribute("aria-pressed", "false");

    await replyLike.click();

    await expect(replyLike).toHaveAttribute("aria-pressed", "true");
  });

  test(`a chain deeper than THREAD_ANCESTOR_MAX (${String(THREAD_ANCESTOR_MAX)}) renders as truncated`, async ({
    page,
    db,
  }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const marker = Date.now().toString();
    const [root] = await db.seedPosts(aliceId, 1, { content: () => `Chain root ${marker}` });
    if (!root) throw new Error("seedPosts returned no row");

    let previousId = root.id;
    const depth = THREAD_ANCESTOR_MAX + 5;
    for (let i = 1; i < depth; i += 1) {
      const reply = await db.seedReply(aliceId, previousId, `Chain link ${marker} #${String(i)}`);
      previousId = reply.id;
    }

    await page.goto(`/post/${previousId}`);

    // thread_truncated in the message catalogue: "This conversation
    // continues above the {count} replies shown." — the recursive CTE that
    // builds the ancestor chain caps at THREAD_ANCESTOR_MAX for its own
    // safety (see the doc comment on the constant), not just for the UI.
    await expect(
      page.getByText(`continues above the ${String(THREAD_ANCESTOR_MAX)} replies shown`),
    ).toBeVisible();
  });
});
