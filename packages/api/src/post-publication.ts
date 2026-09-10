import { and, eq, not } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { post, postAttachment, user } from "@my-tuums/db/schema";
import { insertNotification } from "./notification-writer.js";
import { invisibleAuthor, privatePostHidden } from "./visibility.js";

export interface CreatedPost {
  id: string;
  content: string;
  createdAt: Date;
  parentId: string | null;
  quotedPostId: string | null;
}

/** The same target visibility applies at submission and delayed publication. */
export async function resolvePostTarget(
  db: Pick<Database, "select">,
  viewerId: string,
  postId: string,
) {
  const [target] = await db
    .select({ id: post.id, authorId: post.authorId })
    .from(post)
    .innerJoin(user, eq(user.id, post.authorId))
    .where(
      and(eq(post.id, postId), not(invisibleAuthor(viewerId)), not(privatePostHidden(viewerId))),
    )
    .limit(1);
  return target;
}

/** Ordinary post effects share one transaction for immediate and video posts. */
export async function publishPost(
  tx: Pick<Database, "insert">,
  args: {
    postId: string;
    authorId: string;
    content: string;
    parentId: string | null;
    quotedPostId: string | null;
    isPrivate: boolean;
    attachments: (typeof postAttachment.$inferInsert)[];
    parentAuthorId?: string;
    quotedAuthorId?: string;
  },
): Promise<CreatedPost> {
  const [inserted] = await tx
    .insert(post)
    .values({
      id: args.postId,
      authorId: args.authorId,
      content: args.content,
      parentId: args.parentId,
      quotedPostId: args.quotedPostId,
      isPrivate: args.isPrivate,
    })
    .returning({
      id: post.id,
      content: post.content,
      createdAt: post.createdAt,
      parentId: post.parentId,
      quotedPostId: post.quotedPostId,
    });
  if (!inserted) throw new Error("Post publication did not return its row.");
  if (args.attachments.length) await tx.insert(postAttachment).values(args.attachments);
  if (args.parentAuthorId)
    await insertNotification(tx, {
      recipientId: args.parentAuthorId,
      actorId: args.authorId,
      type: "reply",
      postId: inserted.id,
    });
  if (args.quotedAuthorId)
    await insertNotification(tx, {
      recipientId: args.quotedAuthorId,
      actorId: args.authorId,
      type: "quote",
      postId: inserted.id,
    });
  return inserted;
}
