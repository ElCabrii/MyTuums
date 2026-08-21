import { test, expect } from "@playwright/test";
import { request as httpRequest } from "node:http";
import { gunzipSync } from "node:zlib";
import { E2E } from "../../playwright.config";
import { RPC_MAX_BODY_BYTES } from "@my-tuums/api/constants";
import { legalConsentBody } from "../../support/users";

// This project's baseURL is the server (E2E.serverUrl) — see the `api`
// project in playwright.config.ts.

/**
 * The wire contract carries the CSRF header the real client sends (see
 * apps/web/src/lib/orpc.ts): the server's SimpleCsrfProtectionHandlerPlugin
 * rejects any `/rpc` request without it, which is exactly the point. These
 * raw calls model the client, so they send it too.
 */
const RPC_HEADERS = { "x-csrf-token": "orpc" };

function expectSecurityHeaders(headers: Record<string, string | string[] | undefined>): void {
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
  expectContentSecurityPolicy(headers);
}

/**
 * Asserts the enforced (not report-only — issue #61) CSP header is present
 * and carries the directives `apps/server/src/response-decorators.ts`
 * derives from what the app actually loads: same-origin by default, `https:`
 * images (own uploads via the `/media` redirect, plus OAuth avatar URLs
 * rendered verbatim), and the `accounts.google.com` allowance Google One Tap
 * needs. The script-src hash is asserted by shape, not by literal value — it
 * moves whenever the shared onload-handler constant does.
 */
function expectContentSecurityPolicy(headers: Record<string, string | string[] | undefined>): void {
  const csp = headers["content-security-policy"];
  expect(csp).toEqual(expect.any(String));
  // SAFETY: The runtime assertion above establishes the Node header value as a string.
  const directives = (csp as string).split("; ");

  expect(directives).toContain("default-src 'self'");
  expect(directives).toContain("base-uri 'self'");
  expect(directives).toContain("object-src 'none'");
  expect(directives).toContain("img-src 'self' https: blob:");
  expect(directives).toContain("style-src 'self' 'unsafe-inline' https://accounts.google.com");
  expect(directives).toContain("connect-src 'self' https://accounts.google.com");
  expect(directives).toContain("frame-src https://accounts.google.com");
  expect(directives).toContain("frame-ancestors 'none'");

  const scriptSrc = directives.find((d) => d.startsWith("script-src "));
  expect(scriptSrc).toContain("'self'");
  expect(scriptSrc).toContain("https://accounts.google.com");
  expect(scriptSrc).toContain("'unsafe-hashes'");
  expect(scriptSrc).toMatch(/'sha256-[\w+/]+=*'/);

  expect(headers["content-security-policy-report-only"]).toBeUndefined();
}

/**
 * A raw `node:http` request — not Playwright's `request` fixture, whose
 * response bodies arrive transparently decompressed, which would make "did
 * the server compress?" unobservable. Raw bytes in, raw bytes out.
 */
function rawRequest(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  const url = new URL(path, E2E.serverUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: init.method ?? "GET",
        headers: init.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

test.describe("security headers", () => {
  test("GET /health carries all five, on the health-check path", async ({ request }) => {
    const response = await request.get("/health");

    expect(response.status()).toBe(200);
    expectSecurityHeaders(response.headers());
  });

  test("a 404 carries them too, on the plain-text path", async ({ request }) => {
    const response = await request.get("/definitely-not-a-route");

    expect(response.status()).toBe(404);
    expectSecurityHeaders(response.headers());
  });

  test("an oRPC response carries them as well, on the RPC path", async ({ request }) => {
    const response = await request.post("/rpc/post/create", {
      headers: RPC_HEADERS,
      data: { json: { content: "should never be created" } },
    });

    expect(response.status()).toBe(401);
    expectSecurityHeaders(response.headers());
  });
});

test.describe("request body cap", () => {
  test("a chunked /rpc body over the cap is refused with 413", async () => {
    // rawRequest sends no Content-Length, so node encodes the body chunked —
    // the framing the router's Content-Length check cannot see (and that Node
    // http clients legitimately use). The cap for that framing lives in
    // oRPC's BodyLimitPlugin (apps/server/src/index.ts), which counts body
    // bytes as they stream and refuses at the same ceiling.
    //
    // RPC_MAX_BODY_BYTES is imported rather than mirrored: it derives from
    // IMAGE_LIMITS, and this test only needs "over the cap", so importing
    // keeps it correct when the image caps change.
    const wire = await rawRequest("/rpc/user/uploadImage", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...RPC_HEADERS },
      body: "x".repeat(RPC_MAX_BODY_BYTES + 1024),
    });

    expect(wire.status).toBe(413);
    expect(wire.body.toString()).toContain("PAYLOAD_TOO_LARGE");
  });
});

test.describe("JSON response compression", () => {
  // The feed response has to clear the server's 1 KB compression threshold,
  // which an empty or sparse feed never would (post.list on an empty DB is
  // ~30 bytes). Seed a throwaway user with three maximum-length posts — the
  // rate limiter is per-identity, so a fresh user's write budget is untouched
  // by the other specs hammering their own identities.
  test("a large /rpc/post/list response is gzip-compressed on the wire", async ({ request }) => {
    const username = `hd${Date.now().toString(36)}`;
    const signUp = await request.post("/api/auth/sign-up/email", {
      data: {
        email: `${username}@example.test`,
        password: "headers-spec-password",
        name: "Headers Spec",
        username,
        ...legalConsentBody(),
      },
    });
    expect(signUp.ok(), await signUp.text()).toBe(true);

    // 490-char bodies stay under POST_MAX_LENGTH (500) while keeping three
    // posts comfortably past the server's 1 KB compression threshold.
    const contents = [0, 1, 2].map((i) => `${"x".repeat(489)}${i}`);
    for (const content of contents) {
      const created = await request.post("/rpc/post/create", {
        headers: RPC_HEADERS,
        data: { json: { content } },
      });
      expect(created.status(), await created.text()).toBe(200);
    }

    // `post.list` is `protectedProcedure` now (issue #36), and `rawRequest`
    // below is a raw `node:http` client — deliberately, so the gzip assertion
    // can see undecoded bytes — which shares no cookie jar with the `request`
    // fixture above. The session cookie has to be forwarded by hand.
    const { cookies } = await request.storageState();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const wire = await rawRequest("/rpc/post/list", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...RPC_HEADERS,
        "accept-encoding": "gzip",
        cookie: cookieHeader,
      },
      body: JSON.stringify({ json: {} }),
    });

    expect(wire.status).toBe(200);
    expect(wire.headers["content-encoding"]).toBe("gzip");
    // The CORS plugin already sets a Vary for the preflight headers; the
    // decorator appends rather than clobbers it.
    expect(wire.headers.vary).toContain("Accept-Encoding");
    const body = gunzipSync(wire.body).toString();
    expect(JSON.parse(body)).toBeDefined();
    for (const content of contents) {
      expect(body).toContain(content);
    }
  });

  test("a small response (GET /health) stays identity even with gzip accepted", async () => {
    const wire = await rawRequest("/health", {
      headers: { "accept-encoding": "gzip" },
    });

    expect(wire.status).toBe(200);
    expect(wire.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(wire.body.toString())).toEqual({ status: "ok" });
  });
});
