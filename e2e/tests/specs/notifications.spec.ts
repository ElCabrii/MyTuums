import { test, expect } from "../../support/fixtures";
import type { Page } from "@playwright/test";
import { ALICE, BOB } from "../../support/users";

/**
 * The notifications page journey (issue #259): the events bob causes on
 * alice's side of the stack surface as her unread badge, and opening the
 * page is what clears it. The rules themselves — exactly-once per event,
 * blocks and self-actions never notifying, visibility — are pinned by
 * `packages/api/src/notifications.int.test.ts`; this spec proves only the
 * crossing a browser owns: the badge moving on a live session and the
 * mark-read round trip flipping the rows.
 */

/** The header bell's current unread count, 0 when it carries no badge. */
async function unreadOnBell(page: Page): Promise<number> {
  const bell = page.getByRole("button", { name: /^Notifications/ });
  const label = (await bell.getAttribute("aria-label")) ?? "";
  const match = label.match(/(\d+)/);
  return match ? Number(match[1]) : 0;
}

test.describe("notifications", () => {
  test("bob's like, reply and follow surface on alice's bell and clear when she opens the page", async ({
    page,
    bobPage,
    db,
  }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [seeded] = await db.seedPosts(aliceId, 1, {
      content: () => `Notification target ${Date.now().toString()}`,
    });
    if (!seeded) throw new Error("seedPosts returned no row");

    // The suite shares one database (workers are pinned to 1), so earlier
    // specs may have left alice unread notifications. The baseline makes the
    // assertion a delta rather than an absolute count.
    await page.goto("/");
    const before = await unreadOnBell(page);

    // Bob's earlier same-type rows (from previous specs, or from a failed
    // attempt of this very test being retried) sit inside the badge damper's
    // current minute bucket: his next like, reply and follow would collapse
    // into earlier ticks and never move the badge to before + 3. Aging them
    // into an older bucket makes the three events below deterministic ticks.
    const bobId = await db.getUserId(BOB.username);
    await db.expireNotificationDamperWindow(bobId, aliceId);

    // Three events from bob: a like, a reply on the same post, and a follow.
    // The follow is made fresh first — a leftover edge from another spec
    // would make clicking "Follow" a no-op that notifies nobody.
    await bobPage.goto(`/post/${seeded.id}`);
    await bobPage.getByRole("button", { name: "Like this post" }).click();
    await bobPage.getByPlaceholder("Post your reply...").fill(`a bob reply ${Date.now()}`);
    await bobPage.getByRole("button", { name: "Reply" }).click();
    await bobPage.goto(`/@${ALICE.username}`);
    // Wait for the profile's follow control to render before branching on
    // its label: isVisible() on a still-loading profile returns false, the
    // unfollow would be skipped, and the wait for "Follow" below would then
    // hang on a button that says "Unfollow" for the rest of the run.
    const followControl = bobPage.getByRole("button", { name: /^(Follow|Unfollow)$/ });
    await expect(followControl.first()).toBeVisible();
    const unfollow = bobPage.getByRole("button", { name: "Unfollow" });
    if (await unfollow.isVisible()) {
      await unfollow.click();
      await expect(bobPage.getByRole("button", { name: "Follow", exact: true })).toBeVisible();
    }
    await bobPage.getByRole("button", { name: "Follow", exact: true }).click();

    // Alice's header picks the count up on her next navigation — the badge
    // rides the query's refetch, not a push.
    await page.goto("/");
    await expect.poll(() => unreadOnBell(page), { timeout: 10_000 }).toBe(before + 3);

    await page.getByRole("button", { name: /^Notifications/ }).click();
    await expect(page).toHaveURL(/\/notifications$/);
    await expect(page.getByText(`${BOB.name} liked your post`)).toBeVisible();
    await expect(page.getByText(`${BOB.name} replied to your post`)).toBeVisible();
    await expect(page.getByText(`${BOB.name} followed you`)).toBeVisible();

    // Opening the page advanced the read cursor: the badge — re-fetched on
    // this same navigation — reads as the plain bell again, and the unread
    // markers are gone from the rows. Both assertions poll, and the row one
    // counts to zero rather than checking hidden-ness: a strict-mode
    // resolution error on a multi-match "Unread" locator sends the next
    // debugger hunting a Playwright problem that is really three live rows.
    await expect.poll(() => unreadOnBell(page), { timeout: 10_000 }).toBe(0);
    await expect(page.getByText("Unread")).toHaveCount(0);
  });
});
