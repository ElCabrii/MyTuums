import { test, expect } from "@playwright/test";
import { legalConsentBody } from "../../support/users";

// This project's baseURL is the server (E2E.serverUrl) — see the `api`
// project in playwright.config.ts.

/**
 * The server-side page gate (`apps/server/src/request-handler.ts`): every
 * extension-less GET/HEAD path outside `SIGNED_OUT_PATHS` requires a live
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

  test("/login itself is never redirected — the loop guard, over the wire", async ({ request }) => {
    // If SIGNED_OUT_PATHS and the gate's exemption check ever drifted apart,
    // this is the request that would prove it: a signed-out visitor bounced
    // to /login only to have /login redirect them right back.
    const response = await request.get("/login", { maxRedirects: 0 });

    expect(response.status()).not.toBe(302);
    expect(response.headers()["location"]).toBeUndefined();
  });

  test("a request carrying a live session is not redirected", async ({ request }) => {
    const username = `pg${Date.now().toString(36)}`;
    const signUp = await request.post("/api/auth/sign-up/email", {
      data: {
        email: `${username}@example.test`,
        password: "page-gate-probe-password",
        name: "Page Gate Probe",
        username,
        ...legalConsentBody(),
      },
    });
    expect(signUp.ok(), await signUp.text()).toBe(true);

    // The `request` fixture carries the session cookie the sign-up response
    // set, the same way the rate-limit test in rpc-contract.spec.ts relies on
    // it for its own throwaway identity.
    const response = await request.get("/@alice", { maxRedirects: 0 });

    expect(response.status()).not.toBe(302);
    expect(response.headers()["location"]).toBeUndefined();
  });
});

/**
 * `/media/<key>` (`apps/server/src/request-handler.ts`): the last anonymous
 * read of user content, closed the same way as the page gate — a real session
 * check, ahead of even parsing the key. Neither case here needs a configured
 * bucket: the gate runs before `resolveMediaUrl`, so an unconfigured one still
 * answers 404 for a signed-in caller, never masking the 401 a signed-out one
 * gets first.
 */
test.describe("media gate", () => {
  test("an anonymous request for a well-formed key is refused with 401, not 404", async ({
    request,
  }) => {
    // Deliberately well-formed (see isSafeObjectKey in packages/api/src/
    // image.ts) so a 401 here proves the session gate fired ahead of key
    // validation — not that the key merely looked wrong. An anonymous caller
    // must learn nothing about which keys are well-formed or which objects
    // exist.
    const response = await request.get(
      "/media/avatars/11111111-2222-3333-4444-555555555555/11111111-2222-3333-4444-555555555555.webp",
      { maxRedirects: 0 },
    );

    expect(response.status()).toBe(401);
    expect(response.headers()["cache-control"]).toBe("no-store");
  });

  test("a request carrying a live session gets past the gate", async ({ request }) => {
    const username = `mg${Date.now().toString(36)}`;
    const signUp = await request.post("/api/auth/sign-up/email", {
      data: {
        email: `${username}@example.test`,
        password: "media-gate-probe-password",
        name: "Media Gate Probe",
        username,
        ...legalConsentBody(),
      },
    });
    expect(signUp.ok(), await signUp.text()).toBe(true);

    // The key doesn't need to point at a real object — only that the answer
    // is no longer the flat 401 every anonymous caller gets. Whatever the
    // resolver decides after the gate (404 for a nonexistent object here,
    // since no bucket is required for this project — or a 302 in
    // settings.spec.ts's real upload specs) is a separate concern from
    // whether the gate itself let the request through.
    const response = await request.get(
      "/media/avatars/11111111-2222-3333-4444-555555555555/11111111-2222-3333-4444-555555555555.webp",
      { maxRedirects: 0 },
    );

    expect(response.status()).not.toBe(401);
  });
});
