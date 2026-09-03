import { test, expect } from "../../support/fixtures";
import { ALICE } from "../../support/users";
import { bookmarkButtonFor, likeButtonFor, postCardWithText } from "../../support/post-card";

/**
 * The action bar's hit areas (issue #275): a CSS composition only a real
 * viewport can see. jsdom does no layout, so no component test can tell a
 * 32 px target from a 16 px one — and the bar shipped as five ~16 px
 * targets next to the kebab's 32 px circle, which is what made it easy to
 * mis-tap. This pins that every control is a padded, uniform-height target;
 * the per-glyph optical sizing is a judgment call and stays unpinned. The
 * quote action is absent from the list on purpose: on a top-level post it
 * lives inside the repost menu (its menu item, not a bar control), and the
 * bar itself is four targets.
 */
test.describe("the post action bar", () => {
  test("renders every action as a uniform target of at least 32 px", async ({ page, db }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [seeded] = await db.seedPosts(aliceId, 1, {
      content: () => `Action bar target ${Date.now().toString()}`,
    });
    if (!seeded) throw new Error("seedPosts returned no row");

    await page.goto("/");
    const card = postCardWithText(page, seeded.content);
    const controls = [
      card.getByRole("link", { name: /^Reply to this post/ }),
      card.getByRole("button", { name: /^(Repost this post|Remove your repost)/ }),
      likeButtonFor(page, seeded.content),
      bookmarkButtonFor(page, seeded.content),
    ];

    const heights: number[] = [];
    for (const control of controls) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      if (!box) throw new Error("action control has no bounding box");
      heights.push(box.height);
    }

    // The floor is the tap-target size the fix introduced; the equality is
    // the "uniform" half. Either failing is the #275 regression again — a
    // control shrinking back to its bare glyph height.
    for (const height of heights) {
      expect(height).toBeGreaterThanOrEqual(32);
    }
    expect(new Set(heights).size).toBe(1);
  });
});
