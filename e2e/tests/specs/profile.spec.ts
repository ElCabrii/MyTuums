import { test, expect } from "../../support/fixtures";
import { ALICE, uniqueUser } from "../../support/users";

test.describe("profile", () => {
  // The suite's privacy test. `user.byUsername` is public and deliberately
  // returns an explicit column allowlist (`publicUserColumns` in
  // packages/api/src/users.ts) specifically so a profile visit never leaks
  // `email` to an unrelated caller. Reading the handler proves intent; this
  // proves it actually held over the wire, by capturing every real /rpc
  // response body during a profile visit and asserting neither fixture
  // email ever appears in it, or in the rendered page itself.
  test("no email appears in the rendered page or in any /rpc response", async ({ page, db }) => {
    const bodies: string[] = [];
    page.on("response", (response) => {
      if (!response.url().includes("/rpc/")) return;
      void response
        .text()
        .then((text) => {
          bodies.push(text);
        })
        .catch(() => undefined);
    });

    const target = await db.createUser(uniqueUser("privacycheck"));
    const [post] = await db.seedPosts(target.id, 1, {
      content: () => `Privacy check post ${Date.now().toString()}`,
    });
    if (!post) throw new Error("seedPosts returned no row");

    await page.goto(`/@${target.username}`);
    // Waiting for the seeded post's own content is what guarantees both
    // `user.byUsername` (the header) and `post.list` (the profile feed) have
    // actually responded by the time the bodies below are inspected.
    await expect(page.getByText(post.content, { exact: true })).toBeVisible();

    const pageText = await page.locator("body").innerText();
    expect(pageText).not.toContain(target.email);
    expect(pageText).not.toContain(ALICE.email);

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain(target.email);
      expect(body).not.toContain(ALICE.email);
    }
  });
});
