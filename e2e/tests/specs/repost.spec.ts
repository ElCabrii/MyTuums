import { test, expect } from "../../support/fixtures";
import { ALICE, BOB } from "../../support/users";

/**
 * Reposts and quote posts (issue #261) — the browser half. The degradation
 * matrix and the merged-feed ordering are pinned at the packages/api
 * integration layer (`src/reposts.int.test.ts`); what only a browser can
 * prove is the optimistic repost flip, the app-wide quote dialog composing
 * the composer with the embedded preview, and a repost event's attribution
 * landing in a real rendered feed.
 */
test.describe("reposts", () => {
  test("flips the control optimistically, and the server agrees after reload", async ({
    page,
    db,
  }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [seeded] = await db.seedPosts(aliceId, 1, {
      content: () => `Repost target ${Date.now().toString()}`,
    });
    if (!seeded) throw new Error("seedPosts returned no row");

    await page.goto(`/post/${seeded.id}`);
    const repostButton = page.getByRole("button", { name: "Repost this post" });
    await expect(repostButton).toHaveAttribute("aria-pressed", "false");

    await repostButton.click();
    const unrepostButton = page.getByRole("button", { name: "Remove your repost" });
    await expect(unrepostButton).toHaveAttribute("aria-pressed", "true");
    await expect(unrepostButton).toContainText("1");

    // The pressed state and the count survive a reload — the server, not the
    // optimistic patch, is what made them true.
    await page.reload();
    await expect(page.getByRole("button", { name: "Remove your repost" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // And back again: the pair is a stated end state, not a toggle accident.
    await page.getByRole("button", { name: "Remove your repost" }).click();
    await expect(page.getByRole("button", { name: "Repost this post" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.getByRole("button", { name: "Repost this post" })).toContainText("0");
  });

  test("a repost places the original in the global feed attributed to the reposter", async ({
    page,
    db,
  }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const bobId = await db.getUserId(BOB.username);
    const content = `Amplification target ${Date.now().toString()}`;
    const [seeded] = await db.seedPosts(aliceId, 1, { content: () => content });
    if (!seeded) throw new Error("seedPosts returned no row");

    await db.seedRepost(seeded.id, bobId);

    await page.goto("/");
    // The attribution sits on the card shell ABOVE the content column, so the
    // deepest-div-containing-the-content trick (support/post-card.ts) would
    // stop one level too deep. Filter for a div holding BOTH the content and
    // the attribution instead — the card shell is the innermost such div.
    const card = page
      .locator("div")
      .filter({ hasText: content })
      .filter({ hasText: `${BOB.name} reposted` })
      .last();
    await expect(card.getByText(`${BOB.name} reposted`)).toBeVisible();
    await expect(card.getByText(content)).toBeVisible();
    // The card the attribution sits on is the ORIGINAL: Alice's own handle
    // stays the author line.
    await expect(card.getByRole("link", { name: new RegExp(`@${ALICE.username}`) })).toBeVisible();
  });
});

test.describe("quoting a post", () => {
  test("composes the quote in the dialog and renders it embedded in the feed", async ({
    page,
    db,
  }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const originalContent = `Quote target ${Date.now().toString()}`;
    const [seeded] = await db.seedPosts(aliceId, 1, { content: () => originalContent });
    if (!seeded) throw new Error("seedPosts returned no row");

    await page.goto(`/post/${seeded.id}`);
    await page.getByRole("button", { name: "Quote this post" }).click();

    const dialog = page.getByRole("dialog");
    // The dialog previews the post being quoted exactly as it will embed.
    await expect(dialog.getByText(originalContent)).toBeVisible();

    // The shared composer's textarea is a plain textbox (a textarea cannot
    // carry the combobox role), the same role the home composer's field
    // carries; the mention autocomplete rides on aria-activedescendant.
    const quoteContent = `My quote on it ${Date.now().toString()}`;
    await dialog.getByRole("textbox").fill(quoteContent);
    await dialog.getByRole("button", { name: "Quote", exact: true }).click();

    // Success closes the dialog and the invalidated feed carries the new
    // quote with the original embedded inside it, linked to its permalink.
    // A quote is a top-level post: it lives on the home feed, not the
    // quoted post's thread — which is still the page we are on.
    await expect(dialog).not.toBeVisible();
    await page.goto("/");
    const quoteCard = page.locator("div").filter({ hasText: quoteContent }).last();
    await expect(quoteCard.getByText(originalContent)).toBeVisible();
    // Two Alice links are correct here: the quote author's profile and the
    // embedded original's permalink. Select the contract under test by its
    // destination rather than an ambiguous accessible-name substring.
    await expect(quoteCard.locator(`a[href="/post/${seeded.id}"]`)).toBeVisible();
  });
});
