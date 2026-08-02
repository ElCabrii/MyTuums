import { test, expect } from "@playwright/test";
import { E2E } from "../../playwright.config";

// This project's baseURL is the server (E2E.serverUrl) — see the `api`
// project in playwright.config.ts.

test.describe("CORS", () => {
  test("a preflight from the configured WEB_ORIGIN gets the allow headers", async ({ request }) => {
    const response = await request.fetch("/rpc/post/list", {
      method: "OPTIONS",
      headers: {
        Origin: E2E.webUrl,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    const headers = response.headers();
    expect(headers["access-control-allow-origin"]).toBe(E2E.webUrl);
    expect(headers["access-control-allow-credentials"]).toBe("true");
  });

  test("the same preflight from a foreign origin does not get an allow-origin for it", async ({
    request,
  }) => {
    const response = await request.fetch("/rpc/post/list", {
      method: "OPTIONS",
      headers: {
        Origin: "http://evil.example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    // No `access-control-allow-origin` at all for an untrusted origin — not
    // "a different value". CORSPlugin only echoes an origin it recognises.
    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
  });

  test("/health carries no CORS headers — the plugin is mounted on the RPC handler only", async ({
    request,
  }) => {
    // A real architectural fact worth pinning: apps/server/src/index.ts
    // checks /health before routing into the oRPC handler at all, so
    // CORSPlugin never runs for it, even when the caller sends an Origin.
    const response = await request.get("/health", { headers: { Origin: E2E.webUrl } });

    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers()["access-control-allow-credentials"]).toBeUndefined();
  });

  test("/api/auth/* carries no CORS headers either", async ({ request }) => {
    const response = await request.get("/api/auth/get-session", {
      headers: { Origin: E2E.webUrl },
    });

    expect(response.headers()["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers()["access-control-allow-credentials"]).toBeUndefined();
  });
});
