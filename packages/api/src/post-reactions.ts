import { ORPCError } from "@orpc/server";
import { and, eq, not, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "@my-tuums/db";
import { post, postLike, postRepost, user } from "@my-tuums/db/schema";
import { POST_LIKE_BADGE_TIERS } from "./badges.js";
import { badgeTierStatements } from "./badge-stamping.js";
import { notificationInsert } from "./notification-writer.js";
import { invisibleAuthor, privatePostHidden } from "./visibility.js";

/** Add an idempotent reaction with its notification and earned badges atomically. */
export async function addPostReaction(
  db: Database,
  args: { postId: string; actorId: string; kind: "like" | "repost" },
): Promise<number> {
  const reaction = args.kind === "like" ? postLike : postRepost;
  const visible = and(
    eq(post.id, args.postId),
    not(invisibleAuthor(args.actorId)),
    not(privatePostHidden(args.actorId)),
  );
  const [target] = await db
    .select({ authorId: post.authorId })
    .from(post)
    .innerJoin(user, eq(user.id, post.authorId))
    .where(visible)
    .limit(1);
  if (!target) throw new ORPCError("NOT_FOUND", { message: "Post not found." });

  const exists = sql<boolean>`exists (
    select 1 from ${reaction} where ${reaction.postId} = ${args.postId} and ${reaction.userId} = ${args.actorId}
  )`.mapWith(Boolean);
  const count = sql<number>`(select count(*) from ${reaction} where ${reaction.postId} = ${args.postId})`;
  const permitted = sql`exists (
    select 1 from ${post} inner join ${user} on ${user.id} = ${post.authorId} where ${visible}
  )`;
  const fresh = sql`not (${exists}) and ${permitted}`;
  const effects: BatchItem<"sqlite">[] = [];
  const notice = notificationInsert(
    db,
    {
      recipientId: target.authorId,
      actorId: args.actorId,
      type: args.kind,
      postId: args.postId,
    },
    fresh,
  );
  if (notice !== undefined) effects.push(notice);
  if (args.kind === "like") {
    effects.push(
      ...badgeTierStatements(db, {
        userId: target.authorId,
        tiers: POST_LIKE_BADGE_TIERS,
        count: sql<number>`${count} + 1`,
        when: fresh,
      }),
    );
  }

  // Effects precede the insert so their NOT EXISTS predicate describes a new
  // event. D1 serializes the entire batch: a concurrent duplicate sees the
  // committed reaction and mints nothing; unlike→like earns a fresh notice.
  // Recheck visibility in the batch, since privacy can change after the read.
  const [state] = await db.batch([
    db
      .select({ count, exists })
      .from(post)
      .innerJoin(user, eq(user.id, post.authorId))
      .where(visible)
      .limit(1),
    ...effects,
    db
      .insert(reaction)
      .select(
        sql`select ${args.postId}, ${args.actorId},
      cast(unixepoch('subsec') * 1000 as integer) where ${permitted}`,
      )
      .onConflictDoNothing(),
  ]);
  if (!state[0]) throw new ORPCError("NOT_FOUND", { message: "Post not found." });
  return state[0].count + (state[0].exists ? 0 : 1);
}
