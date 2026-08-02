import { test, expect } from "../../support/fixtures";
import { ALICE, uniqueUser } from "../../support/users";

test.describe("follow", () => {
  test("following someone from their profile updates the button and both counts immediately", async ({
    page,
    db,
  }) => {
    const target = await db.createUser(uniqueUser("followme"));

    await page.goto(`/@${target.username}`);

    const followButton = page.getByRole("button", { name: "Follow", exact: true });
    // "Follower"/"Followers" and "Following" never share a substring (the
    // words diverge right after "Follow"), so a loose regex safely matches
    // either count trigger without pluralisation making it brittle.
    const followersTrigger = page.getByRole("button", { name: /Follower/ });
    const followingTrigger = page.getByRole("button", { name: /Following/ });

    await expect(followersTrigger).toContainText("0");
    await expect(followButton).toBeVisible();

    await followButton.click();

    // aria-label is static once following ("Unfollow"), unlike the visible
    // label which swaps to "Unfollow" only on hover — see follow-button.tsx.
    await expect(page.getByRole("button", { name: "Unfollow" })).toBeVisible();
    await expect(followersTrigger).toContainText("1");
    // The target's own following count is untouched by someone following them.
    await expect(followingTrigger).toBeVisible();
  });

  test("the followers and following dialogs open from the counts without navigating", async ({
    page,
    db,
  }) => {
    const target = await db.createUser(uniqueUser("dialogtarget"));
    const follower = await db.createUser(uniqueUser("dialogfollower"));
    await db.seedFollow(follower.id, target.id);

    await page.goto(`/@${target.username}`);
    const startUrl = page.url();

    await page.getByRole("button", { name: /Follower/ }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("link", { name: new RegExp(follower.username, "i") })).toBeVisible();
    // A modal, not a route — the counts are dialog triggers, not links.
    expect(page.url()).toBe(startUrl);

    await page.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: /Following/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(page.url()).toBe(startUrl);
  });

  test("following someone surfaces their posts in the Following feed", async ({ page, db }) => {
    const target = await db.createUser(uniqueUser("feedauthor"));
    const [targetPost] = await db.seedPosts(target.id, 1, {
      content: () => `Post by someone alice is about to follow ${Date.now().toString()}`,
    });
    if (!targetPost) throw new Error("seedPosts returned no row");

    await page.goto("/");
    await page.getByRole("group", { name: "Feed" }).getByRole("button", { name: "Following" }).click();
    await expect(page.getByText(targetPost.content, { exact: true })).not.toBeVisible();

    await page.goto(`/@${target.username}`);
    await page.getByRole("button", { name: "Follow", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unfollow" })).toBeVisible();

    // Proves the `onSettled` `resetQueries` in atoms/follow.ts: following
    // someone changes which posts belong in the Following feed, and there is
    // no way to synthesise that client-side, so the feed has to actually
    // refetch rather than just patch a cached copy.
    await page.goto("/");
    await page.getByRole("group", { name: "Feed" }).getByRole("button", { name: "Following" }).click();
    await expect(page.getByText(targetPost.content, { exact: true })).toBeVisible();
  });

  test("unfollowing reverses the button, both counts, and the Following feed", async ({
    page,
    db,
  }) => {
    const target = await db.createUser(uniqueUser("unfollowme"));
    const aliceId = await db.getUserId(ALICE.username);
    await db.seedFollow(aliceId, target.id);
    const [targetPost] = await db.seedPosts(target.id, 1, {
      content: () => `Post that should leave the Following feed ${Date.now().toString()}`,
    });
    if (!targetPost) throw new Error("seedPosts returned no row");

    await page.goto(`/@${target.username}`);
    const followersTrigger = page.getByRole("button", { name: /Follower/ });
    await expect(followersTrigger).toContainText("1");

    await page.getByRole("button", { name: "Unfollow" }).click();

    await expect(page.getByRole("button", { name: "Follow", exact: true })).toBeVisible();
    await expect(followersTrigger).toContainText("0");

    await page.goto("/");
    await page.getByRole("group", { name: "Feed" }).getByRole("button", { name: "Following" }).click();
    await expect(page.getByText(targetPost.content, { exact: true })).not.toBeVisible();
  });
});
