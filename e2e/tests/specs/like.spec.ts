import { test, expect } from "../../support/fixtures";
import { ALICE } from "../../support/users";
import { likeButtonFor } from "../../support/post-card";

/**
 * The most valuable spec in the suite: it proves the mutation `scope`
 * serialisation in atoms/like.ts plus the intent-atom drop of superseded
 * responses, not just that clicking a heart eventually turns red.
 */
test.describe("liking a post", () => {
  test("flips the heart instantly, then the count reconciles to the server value", async ({
    page,
    db,
  }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [seeded] = await db.seedPosts(aliceId, 1, {
      content: () => `Like target ${Date.now().toString()}`,
    });
    if (!seeded) throw new Error("seedPosts returned no row");

    // Hold the like response until the optimistic assertion below has
    // already run — proving the flip happens on click, synchronously,
    // rather than after the round trip (onMutate is awaited before the
    // scoped-mutation queue gate; see atoms/like.ts).
    let releaseResponse: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    await page.route("**/rpc/post/like", async (route) => {
      await gate;
      await route.continue();
    });

    // The thread page renders exactly one post (this one has no replies),
    // so there is only one like control on the whole page — no card-scoping
    // needed.
    await page.goto(`/post/${seeded.id}`);
    const likeButton = page.getByRole("button", { name: "Like this post" });
    await expect(likeButton).toHaveAttribute("aria-pressed", "false");

    await likeButton.click();

    const unlikeButton = page.getByRole("button", { name: "Unlike this post" });
    await expect(unlikeButton).toHaveAttribute("aria-pressed", "true");
    await expect(unlikeButton).toContainText("1");

    releaseResponse();
    // Reconciles from the response rather than an invalidate+refetch
    // (post.like returns the authoritative count) — should already agree.
    await expect(unlikeButton).toHaveAttribute("aria-pressed", "true");
    await expect(unlikeButton).toContainText("1");
  });

  test("rapid like -> unlike -> like settles on the last intent", async ({ page, db }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [seeded] = await db.seedPosts(aliceId, 1, {
      content: () => `Rapid toggle target ${Date.now().toString()}`,
    });
    if (!seeded) throw new Error("seedPosts returned no row");

    await page.goto(`/post/${seeded.id}`);
    const anyLikeButton = () => page.getByRole("button", { name: /this post/ });

    await anyLikeButton().click(); // like
    await anyLikeButton().click(); // unlike
    await anyLikeButton().click(); // like — the last intent

    // Same-scope mutations queue (atoms/like.ts), and the per-post intent
    // atom drops any response that no longer matches the latest click, so no
    // matter how the three requests interleave on the wire, the UI must
    // settle on "liked".
    await expect(page.getByRole("button", { name: "Unlike this post" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.reload();

    // The server itself — not just the client cache — has to agree: this
    // is what proves the *last* click won, not just that the client stopped
    // flickering.
    await expect(page.getByRole("button", { name: "Unlike this post" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("liking on the home feed is reflected on the author's profile feed too", async ({
    page,
    db,
  }) => {
    const aliceId = await db.getUserId(ALICE.username);
    const [seeded] = await db.seedPosts(aliceId, 1, {
      content: () => `Cross-feed sync target ${Date.now().toString()}`,
    });
    if (!seeded) throw new Error("seedPosts returned no row");

    await page.goto("/");
    const homeLike = likeButtonFor(page, seeded.content);
    await expect(homeLike).toHaveAttribute("aria-pressed", "false");
    await homeLike.click();
    await expect(homeLike).toHaveAttribute("aria-pressed", "true");

    await page.goto(`/@${ALICE.username}`);
    const profileLike = likeButtonFor(page, seeded.content);
    await expect(profileLike).toHaveAttribute("aria-pressed", "true");
  });

  test("signed out, the site gate holds a visitor at /login", async ({ signedOutPage }) => {
    // The site is private (use-require-signed-in.ts): a signed-out visitor to
    // "/" is redirected to /login, so the feed — and its signed-out like
    // controls — never render. This test used to assert on that feed (the
    // heart links to /login); the gate made it unreachable, and the assertion
    // raced the redirect it was trying to observe. Pinning the gate instead
    // asserts the behaviour that actually ships.
    await signedOutPage.goto("/");

    await expect(signedOutPage).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
