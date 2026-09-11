import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { call } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import { notification, postLike, userBadge } from "@my-tuums/db/schema";
import { db } from "./testing/runtime.js";
import { contextFor, createTestUser, seedPosts, truncateAll } from "./testing/harness.js";
import { appRouter } from "./router.js";
import { POST_LIKE_BADGE_TIERS } from "./badges.js";
import { badgeTierStatements } from "./badge-stamping.js";

beforeEach(truncateAll);
afterAll(truncateAll);

describe("atomic D1 reactions", () => {
  it.each(["like", "repost"] as const)(
    "notifies once for concurrent %s retries, then again after removal",
    async (kind) => {
      const author = await createTestUser();
      const actor = await createTestUser();
      const [target] = await seedPosts(author.id, 1);
      const add = (context = contextFor(actor)) =>
        kind === "like"
          ? call(appRouter.post.like, { postId: target.id }, { context })
          : call(appRouter.post.repost, { postId: target.id }, { context });
      await Promise.all(Array.from({ length: 8 }, () => add()));
      const notices = () =>
        db
          .select()
          .from(notification)
          .where(and(eq(notification.postId, target.id), eq(notification.type, kind)));
      expect(await notices()).toHaveLength(1);
      if (kind === "like")
        await call(appRouter.post.unlike, { postId: target.id }, { context: contextFor(actor) });
      else
        await call(appRouter.post.unrepost, { postId: target.id }, { context: contextFor(actor) });
      await add();
      expect(await notices()).toHaveLength(2);
      await add(contextFor(author));
      expect(await notices()).toHaveLength(2);
    },
  );

  it("rolls back the reaction and notice on badge failure, then preserves earned tiers across retries and recedes", async () => {
    const author = await createTestUser();
    const actor = await createTestUser();
    const [target] = await seedPosts(author.id, 1);
    const ids = Array.from({ length: POST_LIKE_BADGE_TIERS[0].threshold }, () =>
      crypto.randomUUID(),
    );
    // Bulk fixture data uses one JSON parameter, preserving the real catalog
    // threshold without exceeding D1's per-statement parameter limit.
    await db.run(sql`insert into user (id, name, email)
      select value, 'Badge fixture', value || '@example.invalid' from json_each(${JSON.stringify(ids)})`);
    await db.run(sql`insert into post_like (post_id, user_id)
      select ${target.id}, value from json_each(${JSON.stringify(ids)})`);
    const add = () =>
      call(appRouter.post.like, { postId: target.id }, { context: contextFor(actor) });
    await db.run(sql`create trigger reject_badge_test before insert on user_badge
      begin select raise(abort, 'injected badge failure'); end`);
    try {
      await expect(add()).rejects.toThrow();
      expect(
        await db.select().from(notification).where(eq(notification.postId, target.id)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(postLike)
          .where(and(eq(postLike.postId, target.id), eq(postLike.userId, actor.id))),
      ).toEqual([]);
    } finally {
      await db.run(sql`drop trigger reject_badge_test`);
    }
    await add();
    const earned = await db
      .select()
      .from(userBadge)
      .where(and(eq(userBadge.userId, author.id), eq(userBadge.badge, "noticed")));
    expect(earned).toHaveLength(1);
    await call(appRouter.post.unlike, { postId: target.id }, { context: contextFor(actor) });
    await add();
    expect(
      await db
        .select()
        .from(userBadge)
        .where(and(eq(userBadge.userId, author.id), eq(userBadge.badge, "noticed"))),
    ).toEqual(earned);

    await Promise.all([
      db.batch(
        badgeTierStatements(db, {
          userId: author.id,
          tiers: POST_LIKE_BADGE_TIERS,
          count: sql<number>`100001`,
        }),
      ),
      db.batch(
        badgeTierStatements(db, {
          userId: author.id,
          tiers: POST_LIKE_BADGE_TIERS,
          count: sql<number>`10001`,
        }),
      ),
    ]);
    await call(appRouter.post.unlike, { postId: target.id }, { context: contextFor(actor) });
    await add();
    expect(
      await db
        .select({ badge: userBadge.badge })
        .from(userBadge)
        .where(
          and(eq(userBadge.userId, author.id), sql`${userBadge.badge} in ('noticed', 'trendy')`),
        ),
    ).toEqual([{ badge: "trendy" }]);
  });
});
