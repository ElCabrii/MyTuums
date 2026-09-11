import { and, eq, not, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Database } from "@my-tuums/db";
import { post, postAttachment, postMediaUpload, user } from "@my-tuums/db/schema";
import { notificationInsert } from "./notification-writer.js";
import { invisibleAuthor, privatePostHidden } from "./visibility.js";

export interface CreatedPost {
  id: string;
  content: string;
  createdAt: Date;
  parentId: string | null;
  quotedPostId: string | null;
}

/** Compose the same target visibility into a read or the publication batch. */
export function postTargetSelection(
  db: Pick<Database, "select">,
  viewerId: string,
  postId: string,
) {
  return db
    .select({ id: post.id, authorId: post.authorId })
    .from(post)
    .innerJoin(user, eq(user.id, post.authorId))
    .where(
      and(eq(post.id, postId), not(invisibleAuthor(viewerId)), not(privatePostHidden(viewerId))),
    )
    .limit(1);
}

export async function resolvePostTarget(
  db: Pick<Database, "select">,
  viewerId: string,
  postId: string,
) {
  const [target] = await postTargetSelection(db, viewerId, postId);
  return target;
}

/** Compose post effects with another domain transition in one D1 batch. */
export function postPublicationStatements(
  db: Database,
  args: {
    postId: string;
    authorId: string;
    content: string;
    parentId: string | null;
    quotedPostId: string | null;
    isPrivate: boolean;
    attachments: (typeof postAttachment.$inferInsert)[];
    parentAuthorId?: string | SQL<string>;
    quotedAuthorId?: string | SQL<string>;
    imageUpload?: boolean;
  },
  when: SQL = sql`true`,
) {
  // The guard must remain stable through the batch. Delayed publication
  // latches eligibility in its first transition; it must not recheck a clock
  // between the post insert and its attachment/notification writes.
  const id = args.imageUpload
    ? sql`(select ${postMediaUpload.postId} from ${postMediaUpload}
        where ${postMediaUpload.postId} = ${args.postId}
        and ${postMediaUpload.expiresAt} > cast(unixepoch('subsec') * 1000 as integer))`
    : args.postId;
  // INSERT SELECT follows post's schema order. A missing/expired image intent
  // yields NULL, so the NOT NULL guard rolls back the whole publication.
  const insertPost = db
    .insert(post)
    .select(
      sql`select ${id}, ${args.authorId}, ${args.content},
    ${args.parentId}, ${args.quotedPostId}, null, null, null, null, null,
    ${args.isPrivate ? 1 : 0}, cast(unixepoch('subsec') * 1000 as integer) where ${when}`,
    )
    .returning({
      id: post.id,
      content: post.content,
      createdAt: post.createdAt,
      parentId: post.parentId,
      quotedPostId: post.quotedPostId,
    });
  const effects: BatchItem<"sqlite">[] = [];
  for (const attachment of args.attachments)
    effects.push(
      db.insert(postAttachment).select(sql`select
    ${attachment.id ?? crypto.randomUUID()}, ${args.postId}, ${attachment.position}, ${attachment.mediaPath},
    ${attachment.contentType}, ${attachment.videoId ?? null}, ${attachment.byteSize}, ${attachment.width},
    ${attachment.height}, cast(unixepoch('subsec') * 1000 as integer) where ${when}`),
    );
  if (args.parentAuthorId) {
    const notice = notificationInsert(
      db,
      {
        recipientId: args.parentAuthorId,
        actorId: args.authorId,
        type: "reply",
        postId: args.postId,
      },
      when,
    );
    if (notice) effects.push(notice);
  }
  if (args.quotedAuthorId) {
    const notice = notificationInsert(
      db,
      {
        recipientId: args.quotedAuthorId,
        actorId: args.authorId,
        type: "quote",
        postId: args.postId,
      },
      when,
    );
    if (notice) effects.push(notice);
  }
  if (args.imageUpload)
    effects.push(
      db.delete(postMediaUpload).where(and(eq(postMediaUpload.postId, args.postId), when)),
    );
  return { insertPost, effects };
}

/** Post, attachments, owed notifications and upload consumption commit together. */
export async function publishPost(
  db: Database,
  args: Parameters<typeof postPublicationStatements>[1],
): Promise<CreatedPost> {
  const statements = postPublicationStatements(db, args);
  const [[inserted]] = await db.batch([statements.insertPost, ...statements.effects]);
  if (!inserted) throw new Error("Post publication did not return its row.");
  return inserted;
}
