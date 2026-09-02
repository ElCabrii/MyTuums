import { test, expect } from "@playwright/test";

// This project's baseURL is the server (E2E.serverUrl) — see the `api`
// project in playwright.config.ts.

/**
 * The server-side page gate (`apps/server/src/request-handler.ts`): every
 * extension-less GET/HEAD path outside the signed-out allowlist
 * (`isSignedOutPath` in packages/api/src/constants.ts) requires a live
 * session, checked with a real `auth.api.getSession` lookup — not just cookie
 * presence.
 *
 * This has to be an `api`-project spec, not a browser one: `apps/web/
 * vite.config.ts` proxies only `/rpc`, `/api/auth` and `/media` to the server
 * in dev — every page request is served by Vite itself — so a browser spec's
 * navigation never reaches this server at all. The `chromium` project's own
 * signed-out coverage (`like.spec.ts`'s "the site gate holds a visitor at
 * /login", `welcome.spec.ts`'s route guard, `a11y.spec.ts`'s `/login` check)
 * exercises the CLIENT gate, `useRequireSignedIn`; this file is what actually
 * observes the server one, over the wire, the way a production deployment
 * (`WEB_DIST` set) would serve it.
 */
test.describe("page gate", () => {
  test("a signed-out visitor to a page path is redirected to /login with the destination preserved", async ({
    request,
  }) => {
    const response = await request.get("/@alice", { maxRedirects: 0 });

    expect(response.status()).toBe(302);
    expect(response.headers()["location"]).toBe("/login?redirect=%2F%40alice");
  });

  test("a /post permalink is public — no redirect for a signed-out visitor (0.4.0)", async ({
    request,
  }) => {
    // The id does not need to exist: the gate's decision is made before the
    // SPA (or the head transform) ever looks the post up. In the dev stack
    // the server serves no static files, so the non-redirect answer is a 404
    // here and a 200 under a WEB_DIST deployment — what this spec can assert
    // in every environment is that the gate let the request through.
    const response = await request.get("/post/0d97ee29-7896-4c53-9161-c54fc1ca1b51", {
      maxRedirects: 0,
    });

    expect(response.status()).not.toBe(302);
    expect(response.headers()["location"]).toBeUndefined();
  });
});

/**
 * `/media/<key>` (`apps/server/src/request-handler.ts`): session-optional
 * since 0.4.0 — the public post permalink renders media, so an anonymous
 * caller is answered per key by the resolver's authorization (a null viewer:
 * no owner exemptions, no moderator bypass) rather than by a blanket 401.
 * Keys are unguessable uuids, and this spec needs no configured bucket: an
 * unconfigured one answers 404 through the same path.
 */
test.describe("media gate", () => {
  test("an anonymous request for a well-formed unknown key is a plain 404, not an auth error", async ({
    request,
  }) => {
    const response = await request.get(
      "/media/avatars/11111111-2222-3333-4444-555555555555/11111111-2222-3333-4444-555555555555.webp",
      { maxRedirects: 0 },
    );

    expect(response.status()).toBe(404);
  });
});
