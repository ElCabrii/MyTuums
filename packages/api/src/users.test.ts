import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { inArray } from "drizzle-orm";
import { auth } from "@my-tuums/auth";
import { closeDb, db } from "@my-tuums/db";
import { user as userTable } from "@my-tuums/db/schema";
import { appRouter } from "./router.js";
import type { createContext } from "./context.js";

// Integration tests against real Postgres and real BetterAuth sign-ups, in
// the same spirit as ./router.test.ts. The behaviour worth proving is that
// this procedure is safe to expose publicly: it resolves handles the way the
// username plugin normalises them, and it does not hand out private columns.

type Context = Awaited<ReturnType<typeof createContext>>;

describe("appRouter.user.byUsername", () => {
  const createdUserIds: string[] = [];
  const anonContext: Context = { db, session: null };

  let username: string;
  let displayUsername: string;
  let userId: string;
  let email: string;

  beforeAll(async () => {
    // Mixed case on the way in, so the normalised/display split is real.
    displayUsername = `VitestUser${randomUUID().slice(0, 8).toUpperCase()}`;
    username = displayUsername.toLowerCase();
    email = `vitest+${randomUUID()}@example.com`;

    const { response } = await auth.api.signUpEmail({
      body: {
        email,
        password: "vitest-password-123",
        name: "Vitest Profile",
        username: displayUsername,
      },
      returnHeaders: true,
    });

    userId = response.user.id;
    createdUserIds.push(userId);
  });

  afterAll(async () => {
    await db.delete(userTable).where(inArray(userTable.id, createdUserIds));
    await closeDb();
  });

  it("resolves a profile for an anonymous caller", async () => {
    const result = await call(appRouter.user.byUsername, { username }, { context: anonContext });

    expect(result.id).toBe(userId);
    expect(result.name).toBe("Vitest Profile");
    expect(result.username).toBe(username);
    expect(result.displayUsername).toBe(displayUsername);
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it("is case-insensitive, so /@Alex and /@alex are the same profile", async () => {
    const lower = await call(appRouter.user.byUsername, { username }, { context: anonContext });
    const upper = await call(
      appRouter.user.byUsername,
      { username: displayUsername },
      { context: anonContext },
    );

    expect(upper.id).toBe(lower.id);
  });

  it("never exposes the email address", async () => {
    const result = await call(appRouter.user.byUsername, { username }, { context: anonContext });

    expect(result).not.toHaveProperty("email");
    expect(result).not.toHaveProperty("emailVerified");
    expect(JSON.stringify(result)).not.toContain(email);
  });

  it("returns NOT_FOUND for an unknown handle", async () => {
    await expect(
      call(
        appRouter.user.byUsername,
        { username: `missing${randomUUID().slice(0, 8)}` },
        { context: anonContext },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects a handle that cannot exist rather than querying for it", async () => {
    await expect(
      call(appRouter.user.byUsername, { username: "ab" }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      call(appRouter.user.byUsername, { username: "x".repeat(21) }, { context: anonContext }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
