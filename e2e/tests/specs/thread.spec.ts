import { test, expect } from "../../support/fixtures";
import { ALICE } from "../../support/users";

const REPLY_PLACEHOLDER = "Post your reply...";

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
});
