import { test, expect } from "@playwright/test";
import { request as httpRequest } from "node:http";
import { gunzipSync } from "node:zlib";
import { E2E } from "../../playwright.config";
import { RPC_MAX_BODY_BYTES, RPC_SMALL_BODY_BYTES } from "@my-tuums/api/constants";
import { signUpVerifiedSession } from "../../support/auth";

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
  test("an anonymous chunked /rpc body is refused with 401 before it is buffered", async () => {
    // The pre-auth gate treats a lengthless body as over the small-body line
    // by definition — there is no Content-Length to prove otherwise — so an
    // anonymous caller cannot trade a missing header for a buffered request.
    // rawRequest sends no Content-Length, so node encodes the body chunked:
    // exactly the framing the declared-length checks cannot see.
    const wire = await rawRequest("/rpc/user/uploadImage", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...RPC_HEADERS },
      body: JSON.stringify({ json: { padding: "pad" } }),
    });

    expect(wire.status).toBe(401);
  });

  test("a chunked appeal body is refused with 411 — the public surface has no session to demand and no length to compare", async () => {
    // moderation.appealOpen is exempt from the session demand (the appellant
    // cannot sign in), so a chunked body there would otherwise be admitted to
    // buffer against nothing. Every client that legitimately follows the
    // email link sends plain JSON with a Content-Length, so refusing the
    // encoding costs nothing real.
    const wire = await rawRequest("/rpc/moderation/appealOpen", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...RPC_HEADERS },
      body: JSON.stringify({ json: { reason: "x".repeat(RPC_SMALL_BODY_BYTES) } }),
    });

    expect(wire.status).toBe(411);
    expect(wire.body.toString()).toContain("Length required");
  });

  test("a signed-in chunked /rpc body over the cap is refused with 413", async ({ request }) => {
    // After the pre-auth gate, only an authenticated caller can put a chunked
    // body in flight at all; its byte-counting cap remains oRPC's
    // BodyLimitPlugin (apps/server/src/index.ts), which refuses at the same
    // ceiling as the declared-length check. This test signs in precisely so it
    // can reach that plugin past the gate.
    //
    // RPC_MAX_BODY_BYTES is imported rather than mirrored: it derives from
    // IMAGE_LIMITS, and this test only needs "over the cap", so importing
    // keeps it correct when the image caps change.
    await signUpVerifiedSession(request, "bc");
    const { cookies } = await request.storageState();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const wire = await rawRequest("/rpc/user/uploadImage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...RPC_HEADERS,
        cookie: cookieHeader,
      },
      body: "x".repeat(RPC_MAX_BODY_BYTES + 1024),
    });

    expect(wire.status).toBe(413);
    expect(wire.body.toString()).toContain("PAYLOAD_TOO_LARGE");
  });

  test("an anonymous upload-sized /rpc body is refused with 401 before it is buffered", async ({
    request,
  }) => {
    // The pre-auth gate (apps/server/src/request-handler.ts): every upload
    // procedure is session-gated, so a declared body above
    // RPC_SMALL_BODY_BYTES from an anonymous caller has no legitimate use and
    // must be refused before oRPC parses it — not buffered and then rejected
    // as UNAUTHORIZED. Playwright's `request` sends Content-Length, which is
    // what the gate reads.
    const response = await request.post("/rpc/user/uploadImage", {
      headers: RPC_HEADERS,
      data: { json: { padding: "x".repeat(RPC_SMALL_BODY_BYTES) } },
    });

    expect(response.status()).toBe(401);
  });

  test("an oversized appeal body is refused with 413 — the public surface keeps its own low limit", async ({
    request,
  }) => {
    // Pins the appeal wire path the gate holds as a literal
    // (`RPC_APPEAL_OPEN_PATH`) against the real router: a suspended person
    // cannot sign in, so this one procedure is exempt from the session demand
    // and gets the small bound as its own ceiling instead. If the router path
    // ever moved, this body would meet the session demand and answer 401.
    const response = await request.post("/rpc/moderation/appealOpen", {
      headers: RPC_HEADERS,
      data: { json: { reason: "x".repeat(RPC_SMALL_BODY_BYTES) } },
    });

    expect(response.status()).toBe(413);
  });
});

test.describe("JSON response compression", () => {
  // The feed response has to clear the server's 1 KB compression threshold,
  // which an empty or sparse feed never would (post.list on an empty DB is
  // ~30 bytes). Seed a throwaway user with three maximum-length posts — the
  // rate limiter is per-identity, so a fresh user's write budget is untouched
  // by the other specs hammering their own identities.
  test("a large /rpc/post/list response is gzip-compressed on the wire", async ({ request }) => {
    await signUpVerifiedSession(request, "hd");

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
