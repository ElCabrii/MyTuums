import { randomUUID } from "node:crypto";
import { call } from "@orpc/server";
import { auth } from "@my-tuums/auth";
import { ONBOARDING_REQUIRED_MESSAGE } from "@my-tuums/auth/rules";
import { closeDb } from "@my-tuums/db";
import { user } from "@my-tuums/db/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./router.js";
import {
  anonContext,
  contextFor,
  createTestUser,
  freshSessionFor,
  sessionHeaders,
  truncateAll,
} from "./testing/harness.js";

beforeAll(async () => {
  await truncateAll();
});

afterAll(async () => {
  await truncateAll();
  await closeDb();
});

/**
 * The server half of the onboarding rule (finding 3).
 *
 * `protectedProcedure` refuses a session whose account never claimed a handle
 * or declared a date of birth — OAuth/passkey sign-ups land with neither, and
 * the client-side `/welcome` redirect is a courtesy anyone can skip. These
 * tests prove the refusal happens at the procedure boundary, that the legal
 * consent gate is not what fired (every fixture here has current consent), and
 * that the one surface an incomplete account must be able to reach — the
 * `/welcome` claim through `auth.api.updateUser` — is untouched by the gate.
 */
describe("protectedProcedure onboarding gate", () => {
  it("admits a completed account", async () => {
    const author = await createTestUser();
    const created = await call(
      appRouter.post.create,
      { content: "hello" },
      { context: contextFor(author) },
    );
    expect(created.content).toBe("hello");
  });

  it("refuses a session whose account never declared a date of birth", async () => {
    const incomplete = await createTestUser();
    await anonContext.db.update(user).set({ dateOfBirth: null }).where(eq(user.id, incomplete.id));
    // The fixture's original session still carries the complete user object;
    // a real request would mint a fresh session from the row, so re-fetch it.
    const stale = await freshSessionFor(incomplete);

    await expect(
      call(appRouter.post.create, { content: "hello" }, { context: contextFor(stale) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: ONBOARDING_REQUIRED_MESSAGE });
  });

  it("refuses a session that never claimed a handle", async () => {
    const incomplete = await createTestUser();
    await anonContext.db.update(user).set({ username: null }).where(eq(user.id, incomplete.id));
    const stale = await freshSessionFor(incomplete);

    await expect(
      call(appRouter.post.create, { content: "hello" }, { context: contextFor(stale) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: ONBOARDING_REQUIRED_MESSAGE });
  });

  it("refuses an under-15 date of birth even when the row bypassed the write hook", async () => {
    // The /welcome claim hook refuses this declaration, so the only way the
    // row can hold it is a direct write — which is exactly the case the gate
    // must catch: it is the second half of the 15+ rule, read at use.
    const underage = await createTestUser();
    await anonContext.db
      .update(user)
      .set({ dateOfBirth: new Date("2020-01-01") })
      .where(eq(user.id, underage.id));
    const stale = await freshSessionFor(underage);

    await expect(
      call(appRouter.post.create, { content: "hello" }, { context: contextFor(stale) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: ONBOARDING_REQUIRED_MESSAGE });
  });

  it("lets an incomplete account finish onboarding and immediately pass the gate", async () => {
    // The `/welcome` claim runs through `authClient.updateUser`, which is
    // outside oRPC — so it must remain reachable to exactly the sessions the
    // gate refuses. Claim both missing fields, re-fetch the session, and the
    // same RPC that was forbidden now succeeds.
    const incomplete = await createTestUser();
    await anonContext.db
      .update(user)
      .set({ username: null, dateOfBirth: null })
      .where(eq(user.id, incomplete.id));

    await auth.api.updateUser({
      body: {
        username: `vitest${randomUUID().replace(/-/g, "").slice(0, 8)}`,
        dateOfBirth: new Date("1995-01-01"),
      },
      headers: sessionHeaders(incomplete),
    });

    const completed = await freshSessionFor(incomplete);
    const created = await call(
      appRouter.post.create,
      { content: "hello" },
      { context: contextFor(completed) },
    );
    expect(created.content).toBe("hello");
  });
});
