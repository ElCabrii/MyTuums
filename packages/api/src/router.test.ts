import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { auth } from "@my-tuums/auth";
import { closeDb, db } from "@my-tuums/db";
import { user as userTable } from "@my-tuums/db/schema";
import { appRouter } from "./router.js";
import type { createContext } from "./context.js";

// Integration tests for the auth seam that protectedProcedure exists to
// enforce: an unauthenticated caller must be rejected before any handler
// code runs, and an authenticated caller must reach it and see their own
// user. Both cases go through the real appRouter.me procedure and a real
// Postgres-backed BetterAuth session — not mocks — since Postgres is
// available in this environment and a mocked session guard would only prove
// the mock works, not the guard.

type Context = Awaited<ReturnType<typeof createContext>>;

describe("appRouter.me (protectedProcedure)", () => {
  let createdUserId: string | undefined;

  afterAll(async () => {
    if (createdUserId) {
      await db.delete(userTable).where(eq(userTable.id, createdUserId));
    }
    await closeDb();
  });

  it("rejects an unauthenticated call with UNAUTHORIZED", async () => {
    const context: Context = { db, session: null };

    await expect(call(appRouter.me, undefined, { context })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("returns the caller's own user for an authenticated call", async () => {
    const email = `vitest+${randomUUID()}@example.com`;
    const username = `vitest${randomUUID().slice(0, 8)}`;

    const { headers: signUpHeaders, response: signUpResult } = await auth.api.signUpEmail({
      body: {
        email,
        password: "vitest-password-123",
        name: "Vitest User",
        username,
      },
      returnHeaders: true,
    });

    createdUserId = signUpResult.user.id;

    const cookie = signUpHeaders.get("set-cookie");
    if (!cookie) {
      throw new Error("sign-up did not return a session cookie");
    }

    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
    });

    if (!session) {
      throw new Error("expected a session immediately after sign-up");
    }

    const context: Context = { db, session };
    const result = await call(appRouter.me, undefined, { context });

    expect(result.id).toBe(createdUserId);
    expect(result.email).toBe(email);
    expect(result.username).toBe(username);
  });
});
