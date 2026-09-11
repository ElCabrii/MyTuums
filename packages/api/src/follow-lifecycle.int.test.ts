import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { follow, followRequest, notification, user } from "@my-tuums/db/schema";
import { db } from "./testing/runtime.js";
import { contextFor, createTestUser, truncateAll } from "./testing/harness.js";
import { appRouter } from "./router.js";

beforeEach(truncateAll);
afterAll(truncateAll);

describe("D1 follow lifecycle", () => {
  it.each([false, true])(
    "notifies once for concurrent follow and approval retries (private=%s)",
    async (isPrivate) => {
      const target = await createTestUser();
      const requester = await createTestUser();
      await db.update(user).set({ isPrivate }).where(eq(user.id, target.id));
      await Promise.all(
        Array.from({ length: 6 }, () =>
          call(appRouter.user.follow, { userId: target.id }, { context: contextFor(requester) }),
        ),
      );
      expect(
        await db.select().from(notification).where(eq(notification.recipientId, target.id)),
      ).toMatchObject([{ type: isPrivate ? "follow_request" : "follow", actorId: requester.id }]);
      if (isPrivate) {
        await Promise.all(
          Array.from({ length: 6 }, () =>
            call(
              appRouter.user.followRequest.accept,
              { requesterId: requester.id },
              { context: contextFor(target) },
            ),
          ),
        );
        expect(
          await db
            .select()
            .from(notification)
            .where(and(eq(notification.recipientId, target.id), eq(notification.type, "follow"))),
        ).toHaveLength(1);
      }
      expect(await db.select().from(follow).where(eq(follow.followingId, target.id))).toMatchObject(
        [{ followerId: requester.id }],
      );
      expect(await db.select().from(followRequest)).toEqual([]);
    },
  );

  it("withdrawal racing approval leaves neither an edge nor a pending request", async () => {
    const target = await createTestUser();
    const requester = await createTestUser();
    await db.update(user).set({ isPrivate: true }).where(eq(user.id, target.id));
    await call(appRouter.user.follow, { userId: target.id }, { context: contextFor(requester) });
    const [accepted, withdrawn] = await Promise.allSettled([
      call(
        appRouter.user.followRequest.accept,
        { requesterId: requester.id },
        { context: contextFor(target) },
      ),
      call(appRouter.user.unfollow, { userId: target.id }, { context: contextFor(requester) }),
    ]);
    expect(withdrawn).toMatchObject({ status: "fulfilled" });
    if (accepted.status === "rejected")
      expect(accepted).toMatchObject({ reason: { code: "NOT_FOUND" } });
    expect(await db.select().from(follow)).toEqual([]);
    expect(await db.select().from(followRequest)).toEqual([]);
  });

  it("retains the request and rolls back its notice when approval cannot commit", async () => {
    const target = await createTestUser();
    const requester = await createTestUser();
    await db.update(user).set({ isPrivate: true }).where(eq(user.id, target.id));
    await call(appRouter.user.follow, { userId: target.id }, { context: contextFor(requester) });
    const accept = () =>
      call(
        appRouter.user.followRequest.accept,
        { requesterId: requester.id },
        { context: contextFor(target) },
      );
    await db.run(sql`create trigger reject_follow_test before insert on follow
      begin select raise(abort, 'injected follow failure'); end`);
    try {
      await expect(accept()).rejects.toThrow();
      expect(await db.select().from(followRequest)).toHaveLength(1);
      expect(await db.select().from(notification).where(eq(notification.type, "follow"))).toEqual(
        [],
      );
    } finally {
      await db.run(sql`drop trigger reject_follow_test`);
    }
    await accept();
    expect(await db.select().from(followRequest)).toEqual([]);
    expect(await db.select().from(follow)).toHaveLength(1);
  });
});
