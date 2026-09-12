import { auth, closeDb } from "./testing/runtime.js";
import { call, os } from "@orpc/server";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Context } from "./context.js";
import { publicRateLimit } from "./procedures.js";
import { createRateLimiter } from "./rate-limit.js";
import { anonContext, truncateAll } from "./testing/harness.js";

beforeAll(truncateAll);
afterAll(async () => {
  await truncateAll();
  await closeDb();
});

function headers(ip: string, forwarded = "192.0.2.1, 203.0.113.1") {
  return new Headers({
    "content-type": "application/json",
    "x-mytuums-client-ip": ip,
    "x-forwarded-for": forwarded,
  });
}

describe("client IP rate-limit isolation", () => {
  it("keeps authentication budgets separate for visitors behind the same proxy", async () => {
    async function probe(ip: string, forwarded?: string) {
      return auth.handler(
        new Request("http://localhost:3001/api/auth/is-username-available", {
          method: "POST",
          headers: headers(ip, forwarded),
          body: JSON.stringify({ username: "securityreview" }),
        }),
      );
    }
    for (let i = 0; i < 10; i++) {
      expect((await probe("198.51.100.81")).status).toBe(200);
    }
    expect((await probe("198.51.100.81", "192.0.2.99, 203.0.113.1")).status).toBe(429);
    expect((await probe("198.51.100.82")).status).toBe(200);
  });

  it.each([
    ["198.51.100.81", "198.51.100.81", "198.51.100.82"],
    ["2001:db8:1:2::1", "2001:0db8:0001:0002:0:0:0:2", "2001:db8:1:3::1"],
    ["198.51.100.81", "::ffff:198.51.100.81", "198.51.100.82"],
  ])(
    "public reads preserve the budget for %s despite spoofed forwarding",
    async (first, same, other) => {
      const rateLimiter = createRateLimiter();
      const procedure = os
        .$context<Context>()
        .use(publicRateLimit({ name: "fixture", limit: 1, windowMs: 60_000 }))
        .handler(() => "allowed");
      const probe = (ip: string, forwarded?: string) =>
        call(procedure, undefined, {
          context: { ...anonContext, rateLimiter, headers: headers(ip, forwarded) },
        });
      await expect(probe(first)).resolves.toBe("allowed");
      await expect(probe(same, "192.0.2.99, 203.0.113.1")).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
      });
      await expect(probe(other)).resolves.toBe("allowed");
    },
  );
});
