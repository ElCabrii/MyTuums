import { test, expect } from "@playwright/test";

// This project's baseURL is the server (E2E.serverUrl), not the web app —
// see the `api` project in playwright.config.ts.

test.describe("GET /health", () => {
  test("returns 200 with a status-ok body", async ({ request }) => {
    const response = await request.get("/health");

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("a query string 404s — the route is an exact req.url match, not a prefix", async ({
    request,
  }) => {
    // apps/server/src/index.ts checks `req.url === "/health"` literally, so
    // `/health?x=1` (a different `req.url`) falls through to the 404 branch
    // instead of the health check — worth pinning explicitly since it would
    // be an easy thing to "fix" into a prefix match without noticing the
    // consequence for a real query-string probe.
    const response = await request.get("/health?x=1");

    expect(response.status()).toBe(404);
  });

  test("an unknown path 404s as plain text", async ({ request }) => {
    const response = await request.get("/definitely-not-a-route");

    expect(response.status()).toBe(404);
    expect(response.headers()["content-type"]).toContain("text/plain");
    expect(await response.text()).toBe("Not found");
  });
});
