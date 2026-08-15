import { test, expect } from "@playwright/test";

// This project's baseURL is the server (E2E.serverUrl) — see the `api`
// project in playwright.config.ts.

/**
 * The wire contract carries the CSRF header the real client sends (see
 * apps/web/src/lib/orpc.ts): the server's SimpleCsrfProtectionHandlerPlugin
 * rejects any `/rpc` request without it, which is exactly the point. These
 * raw calls model the client, so they send it too.
 */
const RPC_HEADERS = { "x-csrf-token": "orpc" };

test.describe("oRPC contract", () => {
  test("an unauthenticated call to a protected procedure returns the UNAUTHORIZED envelope", async ({
    request,
  }) => {
    const response = await request.post("/rpc/post/create", {
      headers: RPC_HEADERS,
      data: { json: { content: "should never be created" } },
    });

    expect(response.status()).toBe(401);
    // SAFETY: This test is asserting the oRPC error-envelope contract returned
    // by the endpoint; the field assertions immediately below verify it.
    const body = (await response.json()) as { json: { code: string; status: number } };
    expect(body.json.code).toBe("UNAUTHORIZED");
    expect(body.json.status).toBe(401);
  });

  test("a malformed body is rejected cleanly rather than 500ing", async ({ request }) => {
    // Every procedure is `protectedProcedure` now (issue #36) and auth runs
    // ahead of input validation (see the test above) — an unauthenticated
    // call would 401 before ever attempting to parse the body, which would
    // prove nothing about malformed-body handling itself. A throwaway signed
    // -up user, under its own identity for the same reason the rate-limit
    // test below uses one, gets this past the auth guard so the malformed
    // body actually reaches input parsing.
    const username = `mb${Date.now().toString(36)}`;
    const signUp = await request.post("/api/auth/sign-up/email", {
      data: {
        email: `${username}@example.test`,
        password: "malformed-body-probe-password",
        name: "Malformed Body Probe",
        username,
      },
    });
    expect(signUp.ok(), await signUp.text()).toBe(true);

    // The body has to go over the wire as raw bytes, not Playwright's `data`
    // string handling: passing a plain string still gets JSON-encoded when a
    // `Content-Type: application/json` header is present (turning it into a
    // syntactically valid JSON *string value*, which parses fine and defeats
    // the point). A `Buffer` is sent as-is.
    const response = await request.post("/rpc/post/list", {
      headers: { "Content-Type": "application/json", ...RPC_HEADERS },
      data: Buffer.from("not json at all {"),
    });

    expect(response.status()).toBe(400);
    // SAFETY: This test is asserting the oRPC error-envelope contract returned
    // by the endpoint; the code assertion immediately below verifies it.
    const body = (await response.json()) as { json: { code: string } };
    expect(body.json.code).toBe("BAD_REQUEST");
  });

  // Last in the file, and under its own throwaway identity: the rate limiter
  // is an in-process singleton shared by every caller that hits this server
  // (packages/api/src/rate-limit.ts), including the browser specs proxied
  // through Vite to the same process. Bursting under alice's or bob's
  // identity would leave their `write` bucket part-spent for whatever
  // browser spec runs next; a freshly signed-up user isolates the damage to
  // this test alone.
  test("hammering a write-tier procedure past its budget returns 429 with a retry hint", async ({
    request,
  }) => {
    const username = `rl${Date.now().toString(36)}`;
    const signUp = await request.post("/api/auth/sign-up/email", {
      data: {
        email: `${username}@example.test`,
        password: "rate-limit-probe-password",
        name: "Rate Limit Probe",
        username,
      },
    });
    expect(signUp.ok(), await signUp.text()).toBe(true);

    // RATE_LIMITS.write is 15/minute. 20 attempts is enough headroom to
    // guarantee a 429 without hammering much past the budget.
    let retryAfterSeconds: unknown;

    for (let i = 0; i < 20; i += 1) {
      const response = await request.post("/rpc/post/create", {
        headers: RPC_HEADERS,
        data: { json: { content: `rate limit probe ${String(i)}` } },
      });

      if (response.status() === 429) {
        // SAFETY: A 429 from this oRPC endpoint carries the error envelope whose
        // code and optional retry value are verified before they are consumed.
        const body = (await response.json()) as {
          json: { code: string; data?: { retryAfterSeconds?: unknown } };
        };
        expect(body.json.code).toBe("TOO_MANY_REQUESTS");
        retryAfterSeconds = body.json.data?.retryAfterSeconds;
        break;
      }
    }

    expect(retryAfterSeconds).toEqual(expect.any(Number));
    // SAFETY: The runtime assertion above establishes the retry hint as a number.
    expect(retryAfterSeconds as number).toBeGreaterThan(0);
  });
});
