import { ORPCError } from "@orpc/server";
import { and, eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "@my-tuums/db";
import { follow, followRequest, user, userBlock } from "@my-tuums/db/schema";
import { FOLLOWER_BADGE_TIERS } from "./badges.js";
import { badgeTierStatements } from "./badge-stamping.js";
import { notificationInsert } from "./notification-writer.js";

/** These predicates execute inside each write batch, never from a stale read. */
function relationship(requesterId: string, targetId: string) {
  const edge = sql<boolean>`exists (select 1 from ${follow}
    where ${follow.followerId} = ${requesterId} and ${follow.followingId} = ${targetId})`.mapWith(
    Boolean,
  );
  const requested = sql<boolean>`exists (select 1 from ${followRequest}
    where ${followRequest.requesterId} = ${requesterId} and ${followRequest.targetId} = ${targetId})`.mapWith(
    Boolean,
  );
  const blocked = sql<boolean>`exists (select 1 from ${userBlock}
    where (${userBlock.blockerId} = ${requesterId} and ${userBlock.blockedId} = ${targetId})
      or (${userBlock.blockerId} = ${targetId} and ${userBlock.blockedId} = ${requesterId}))`.mapWith(
    Boolean,
  );
  const allowed = sql`not (${blocked}) and exists (select 1 from ${user} where ${user.id} = ${targetId})`;
  const privateTarget = sql`exists (select 1 from ${user} where ${user.id} = ${targetId} and ${user.isPrivate} is true)`;
  const count = sql<number>`(select count(*) from ${follow} where ${follow.followingId} = ${targetId})`;
  return { edge, requested, blocked, allowed, privateTarget, count };
}

/** Follow a public account or request approval from a private account. */
export async function followUser(db: Database, requesterId: string, targetId: string) {
  if (requesterId === targetId)
    throw new ORPCError("BAD_REQUEST", { message: "You can't follow yourself." });
  const { edge, requested, blocked, allowed, privateTarget, count } = relationship(
    requesterId,
    targetId,
  );
  const direct = sql`${allowed} and not (${privateTarget})`;
  const pending = sql`${allowed} and (${privateTarget}) and not (${edge})`;
  const fresh = sql`${direct} and not (${edge})`;
  const effects: BatchItem<"sqlite">[] = [];
  const followNotice = notificationInsert(
    db,
    { recipientId: targetId, actorId: requesterId, type: "follow" },
    fresh,
  );
  const requestNotice = notificationInsert(
    db,
    { recipientId: targetId, actorId: requesterId, type: "follow_request" },
    sql`${pending} and not (${requested})`,
  );
  if (followNotice !== undefined) effects.push(followNotice);
  if (requestNotice !== undefined) effects.push(requestNotice);
  effects.push(
    ...badgeTierStatements(db, {
      userId: targetId,
      tiers: FOLLOWER_BADGE_TIERS,
      count: sql<number>`${count} + 1`,
      when: fresh,
    }),
  );

  const [before] = await db.batch([
    db
      .select({ isPrivate: user.isPrivate, edge, blocked, count })
      .from(user)
      .where(eq(user.id, targetId))
      .limit(1),
    ...effects,
    db
      .insert(follow)
      .select(
        sql`select ${requesterId}, ${targetId},
      cast(unixepoch('subsec') * 1000 as integer) where ${direct}`,
      )
      .onConflictDoNothing(),
    // An approved edge makes any old request obsolete, including after a
    // private→public toggle or an idempotent follow of a private account.
    db
      .delete(followRequest)
      .where(
        and(
          eq(followRequest.requesterId, requesterId),
          eq(followRequest.targetId, targetId),
          allowed,
          edge,
        ),
      ),
    db
      .insert(followRequest)
      .select(
        sql`select ${requesterId}, ${targetId},
      cast(unixepoch('subsec') * 1000 as integer) where ${pending}`,
      )
      .onConflictDoNothing(),
  ]);
  const state = before[0];
  if (!state) throw new ORPCError("NOT_FOUND", { message: "No such user." });
  if (state.blocked) throw new ORPCError("BAD_REQUEST", { message: "You can't follow this user." });
  const viewerIsFollowing = !state.isPrivate || state.edge;
  return {
    userId: targetId,
    followerCount: state.count + (!state.isPrivate && !state.edge ? 1 : 0),
    viewerIsFollowing,
    requested: !viewerIsFollowing,
  };
}

/** Approval, its notification, badges and request consumption commit together. */
export async function acceptFollowRequest(db: Database, requesterId: string, targetId: string) {
  const { edge, requested, blocked, allowed, count } = relationship(requesterId, targetId);
  const fresh = sql`${allowed} and (${requested}) and not (${edge})`;
  const effects: BatchItem<"sqlite">[] = [];
  const notice = notificationInsert(
    db,
    { recipientId: targetId, actorId: requesterId, type: "follow" },
    fresh,
  );
  if (notice !== undefined) effects.push(notice);
  effects.push(
    ...badgeTierStatements(db, {
      userId: targetId,
      tiers: FOLLOWER_BADGE_TIERS,
      count: sql<number>`${count} + 1`,
      when: fresh,
    }),
  );
  const [before] = await db.batch([
    db.select({ edge, requested, blocked, count }).from(user).where(eq(user.id, targetId)).limit(1),
    ...effects,
    db
      .insert(follow)
      .select(
        sql`select ${requesterId}, ${targetId},
      cast(unixepoch('subsec') * 1000 as integer)
      where ${allowed} and (${requested})`,
      )
      .onConflictDoNothing(),
    db
      .delete(followRequest)
      .where(
        and(
          eq(followRequest.requesterId, requesterId),
          eq(followRequest.targetId, targetId),
          allowed,
        ),
      ),
  ]);
  const state = before[0];
  if (!state || state.blocked || (!state.edge && !state.requested))
    throw new ORPCError("NOT_FOUND", { message: "No such follow request." });
  return state.count + (state.edge ? 0 : 1);
}
