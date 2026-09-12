import { ORPCError } from "@orpc/server";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "@my-tuums/db";
import type { EmailLocale } from "@my-tuums/auth";
import { appeal, moderationAction, post, postAttachment, report } from "@my-tuums/db/schema";
import { notificationInsert } from "./notification-writer.js";
import { outerPost } from "./post-media.js";
import { moderationEmailInsert } from "./moderation-email.js";

export const POST_AUTHOR_DELETED_MESSAGE =
  "This post was deleted by its author and can no longer be moderated.";

type PostModeration = {
  postId: string;
  actorId: string;
  closeAppeals?: boolean;
  emailLocale?: EmailLocale;
} & (
  | { operation: "remove"; reason: string; note?: never }
  | { operation: "restore"; note?: string; reason?: never }
);

/**
 * The audit row is the batch's change marker. Every dependent write requires
 * that exact row, so a no-op or failed guard cannot leave partial effects.
 * Exposed as statements so appeal review can share the same outer D1 batch.
 */
export function postModerationStatements(db: Database, args: PostModeration, when?: SQL) {
  const actionId = crypto.randomUUID();
  const live = and(eq(post.id, args.postId), sql`${post.deletedAt} is null`, when);
  const changed = and(
    live,
    args.operation === "remove"
      ? sql`${post.removedAt} is null`
      : sql`${post.removedAt} is not null`,
  );
  const applied = sql`exists (select 1 from ${moderationAction} where ${moderationAction.id} = ${actionId})`;
  const snapshot = db
    .select({
      authorId: post.authorId,
      content: post.content,
      removedAt: post.removedAt,
      deletedAt: post.deletedAt,
      attachmentCount: sql<number>`(select count(*) from ${postAttachment}
      where ${postAttachment.postId} = ${outerPost("id")})`,
    })
    .from(post)
    .where(eq(post.id, args.postId));
  const statements: BatchItem<"sqlite">[] = [];
  if (args.closeAppeals)
    statements.push(
      db
        .update(appeal)
        .set({ status: args.operation === "remove" ? "superseded" : "reversed" })
        .where(
          and(
            eq(appeal.status, "open"),
            sql`${appeal.actionId} in (
      select ${moderationAction.id} from ${moderationAction}
      where ${moderationAction.targetPostId} = ${args.postId}
        and ${moderationAction.targetType} = 'post' and ${moderationAction.action} = 'post_removed'
    )`,
            sql`exists (select 1 from ${post} where ${args.operation === "remove" ? changed : live})`,
          ),
        ),
    );
  // INSERT SELECT follows all moderation_action columns in schema order.
  statements.push(
    db.insert(moderationAction).select(sql`select ${actionId},
    ${args.operation === "remove" ? "post_removed" : "post_restored"}, ${args.actorId},
    'post', ${args.postId}, null, ${args.reason ?? null}, ${args.note ?? null}, '{}',
    cast(unixepoch('subsec') * 1000 as integer)
    from ${post} where ${changed}`),
  );
  const notice = notificationInsert(
    db,
    {
      recipientId: sql<string>`(select ${post.authorId} from ${post} where ${post.id} = ${args.postId})`,
      actorId: null,
      type: "moderation",
      actionId,
    },
    applied,
  );
  if (notice) statements.push(notice);
  statements.push(
    moderationEmailInsert(
      db,
      {
        sourceId: actionId,
        recipients: sql`select ${post.authorId} from ${post} where ${post.id} = ${args.postId}`,
        fallbackLocale: args.emailLocale ?? "en",
        content:
          args.operation === "remove"
            ? sql`(select json_object('kind', 'post_removed', 'postText', ${post.content},
          'attachmentCount', (select count(*) from ${postAttachment}
            where ${postAttachment.postId} = ${outerPost("id")}), 'reason', ${args.reason})
          from ${post} where ${post.id} = ${args.postId})`
            : sql`json_object('kind', 'post_restored')`,
      },
      applied,
    ),
  );
  if (args.operation === "remove") {
    statements.push(
      db
        .update(report)
        .set({
          resolvedAt: sql`cast(unixepoch('subsec') * 1000 as integer)`,
          resolvedBy: args.actorId,
          resolvedOutcome: "actioned",
          resolutionNote: args.reason,
        })
        .where(
          and(
            eq(report.targetType, "post"),
            eq(report.targetId, args.postId),
            sql`${report.resolvedAt} is null`,
            applied,
          ),
        ),
    );
    statements.push(
      db
        .update(post)
        .set({
          removedAt: sql`(select ${moderationAction.createdAt} from ${moderationAction} where ${moderationAction.id} = ${actionId})`,
          removedBy: args.actorId,
          removedReason: args.reason,
        })
        .where(and(eq(post.id, args.postId), applied)),
    );
  } else {
    statements.push(
      db
        .update(post)
        .set({ removedAt: null, removedBy: null, removedReason: null })
        .where(and(eq(post.id, args.postId), applied)),
    );
  }
  return { snapshot, statements, actionId };
}

export async function moderatePost(db: Database, args: PostModeration) {
  const plan = postModerationStatements(db, args);
  const [targets] = await db.batch([plan.snapshot, ...plan.statements]);
  const target = targets[0];
  if (!target) throw new ORPCError("NOT_FOUND", { message: "This post doesn't exist." });
  if (target.deletedAt)
    throw new ORPCError("BAD_REQUEST", { message: POST_AUTHOR_DELETED_MESSAGE });
  if (args.operation === "remove" && target.removedAt)
    throw new ORPCError("BAD_REQUEST", { message: "This post is already removed." });
  return {
    ...target,
    actionId: plan.actionId,
    changed: args.operation === "remove" || target.removedAt !== null,
  };
}

/** This stamp must commit even when the caller subsequently refuses moderation. */
export async function withdrawDeletedPostAppeals(db: Database, postId: string) {
  await db
    .update(appeal)
    .set({ status: "withdrawn" })
    .where(
      and(
        eq(appeal.status, "open"),
        sql`${appeal.actionId} in (select ${moderationAction.id} from ${moderationAction}
      where ${moderationAction.targetPostId} = ${postId}
      and ${moderationAction.targetType} = 'post' and ${moderationAction.action} = 'post_removed')`,
        sql`exists (select 1 from ${post} where ${post.id} = ${postId} and ${post.deletedAt} is not null)`,
      ),
    );
}
