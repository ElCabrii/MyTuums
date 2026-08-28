import { test, expect } from "@playwright/test";

// This project's baseURL is the server (E2E.serverUrl), not the web app —
// see the `api` project in playwright.config.ts.

test.describe("GET /health", () => {
  test("returns 200 with a status-ok body", async ({ request }) => {
    const response = await request.get("/health");

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
