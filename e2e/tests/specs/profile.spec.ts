import { test, expect } from "../../support/fixtures";
import { ALICE, uniqueUser } from "../../support/users";

test.describe("profile", () => {
  test("mixed-case input is stored lowercase and either URL casing resolves", async ({
    page,
    db,
  }) => {
    const input = uniqueUser("casetest");
    input.username = `${input.username.charAt(0).toUpperCase()}${input.username.slice(1)}`;
    const target = await db.createUser(input);
    const mixedCase = target.username.charAt(0).toUpperCase() + target.username.slice(1);

    expect(target.username).toBe(input.username.toLowerCase());
    expect(target.displayUsername).toBe(target.username);

    await page.goto(`/@${mixedCase}`);
    await expect(page.getByRole("heading", { name: target.name })).toBeVisible();
    await expect(page.getByText(`@${target.username}`, { exact: true })).toBeVisible();

    await page.goto(`/@${target.username}`);
    await expect(page.getByRole("heading", { name: target.name })).toBeVisible();
  });

  test("an unknown handle shows the not-found state, not a crash", async ({ page }) => {
    // Within the 3-20 character bound `usernameInput` enforces
    // (packages/api/src/users.ts) but never registered — a handle outside
    // that bound would hit input validation (BAD_REQUEST) instead of the
    // NOT_FOUND path this test means to exercise.
    await page.goto("/@unknownuser404");

    await expect(page.getByText("There's nobody here. This handle isn't taken.")).toBeVisible();
    // role="button", not "link": a shadcn Button with nativeButton={false} and
    // render={<Link/>} keeps button semantics regardless of the <a> underneath.
    await expect(page.getByRole("button", { name: "Back to home" })).toBeVisible();
  });

  test("an unmatched URL shows the router's 404, not a redirect", async ({ page }) => {
    // A handle-shaped URL that doesn't exist is the profile's own not-found
    // state above; a path that matches NO route is the router's
    // notFoundComponent (see __root.tsx). This spec file runs signed in
    // (alice's storage state), so the signed-in gate must not send this
    // visitor away either — the 404 renders in place, keeping the URL.
    await page.goto("/no-such-page-anywhere");

    await expect(page).toHaveURL(/\/no-such-page-anywhere$/);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });

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
