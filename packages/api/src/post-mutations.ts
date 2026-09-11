import { ORPCError } from "@orpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import { post, postAttachment, postEdit, video, videoSubmission } from "@my-tuums/db/schema";
import { outerPost } from "./post-media.js";

/** Editing records the text it actually replaces, including concurrent edits. */
export async function editPost(db: Database, authorId: string, postId: string, content: string) {
  const editId = crypto.randomUUID();
  const hasAttachment = sql<boolean>`exists (
    select 1 from ${postAttachment} where ${postAttachment.postId} = ${outerPost("id")}
  )`.mapWith(Boolean);
  const mayEdit = and(
    eq(post.id, postId),
    eq(post.authorId, authorId),
    isNull(post.removedAt),
    isNull(post.deletedAt),
    sql`(${content.length > 0 ? 1 : 0} or ${hasAttachment})`,
  );
  const [before, , changed] = await db.batch([
    db
      .select({
        authorId: post.authorId,
        content: post.content,
        editedAt: post.editedAt,
        removedAt: post.removedAt,
        deletedAt: post.deletedAt,
        hasAttachment,
      })
      .from(post)
      .where(eq(post.id, postId)),
    // Raw select follows post_edit's four columns in schema order. The
    // database clock is copied back from this exact history row below.
    db.insert(postEdit).select(sql`select ${editId}, ${post.id}, ${post.content},
      cast(unixepoch('subsec') * 1000 as integer) from ${post}
      where ${mayEdit} and ${post.content} <> ${content}`),
    db
      .update(post)
      .set({
        content,
        editedAt: sql`(select ${postEdit.createdAt} from ${postEdit} where ${postEdit.id} = ${editId})`,
      })
      .where(
        and(
          eq(post.id, postId),
          sql`exists (select 1 from ${postEdit} where ${postEdit.id} = ${editId})`,
        ),
      )
      .returning({ content: post.content, editedAt: post.editedAt }),
  ]);
  const target = before[0];
  if (!target) throw new ORPCError("NOT_FOUND", { message: "Post not found." });
  if (target.authorId !== authorId)
    throw new ORPCError("FORBIDDEN", { message: "You can only edit your own posts." });
  if (target.removedAt)
    throw new ORPCError("BAD_REQUEST", {
      message: "This post was removed by a moderator and can no longer be edited.",
    });
  if (target.deletedAt)
    throw new ORPCError("BAD_REQUEST", {
      message: "This post was deleted and can no longer be edited.",
    });
  if (content.length === 0 && !target.hasAttachment)
    throw new ORPCError("BAD_REQUEST", { message: "Post cannot be empty." });
  const result = changed[0] ?? target;
  return { postId, content: result.content, editedAt: result.editedAt };
}

/** A tombstone, attachment removal and durable media cleanup are one commit. */
export async function deletePost(db: Database, authorId: string, postId: string) {
  const ownedUnremoved = and(
    eq(post.id, postId),
    eq(post.authorId, authorId),
    isNull(post.removedAt),
  );
  const deletedByAuthor = sql`exists (
    select 1 from ${post} where ${ownedUnremoved} and ${post.deletedAt} is not null
  )`;
  const ownedVideo = and(eq(video.postId, postId), deletedByAuthor);
  const deletedVideoIds = sql`(select ${video.id} from ${video} where ${ownedVideo})`;
  const [before, changed] = await db.batch([
    db
      .select({ authorId: post.authorId, removedAt: post.removedAt, deletedAt: post.deletedAt })
      .from(post)
      .where(eq(post.id, postId)),
    db
      .update(post)
      .set({ deletedAt: sql`cast(unixepoch('subsec') * 1000 as integer)` })
      .where(and(ownedUnremoved, isNull(post.deletedAt)))
      .returning({ deletedAt: post.deletedAt }),
    // Image-deletion triggers retain their storage obligations independently
    // of posts/accounts. The video-state trigger records Stream cleanup below.
    db.delete(postAttachment).where(and(eq(postAttachment.postId, postId), deletedByAuthor)),
    db.delete(videoSubmission).where(sql`${videoSubmission.videoId} in ${deletedVideoIds}`),
    db.update(video).set({ state: "deleted", playback: null }).where(ownedVideo),
  ]);
  const target = before[0];
  if (!target) throw new ORPCError("NOT_FOUND", { message: "Post not found." });
  if (target.authorId !== authorId)
    throw new ORPCError("FORBIDDEN", { message: "You can only delete your own posts." });
  if (target.removedAt)
    throw new ORPCError("BAD_REQUEST", {
      message: "This post was removed by a moderator and can no longer be deleted.",
    });
  const deletedAt = changed[0]?.deletedAt ?? target.deletedAt;
  if (!deletedAt)
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Failed to delete post." });
  return { postId, deletedAt };
}
