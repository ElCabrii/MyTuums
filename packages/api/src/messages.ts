import { ORPCError } from "@orpc/server";
import { and, desc, eq, isNull, ne, not, sql, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { Database } from "@my-tuums/db";
import {
  conversation,
  conversationParticipant,
  follow,
  mediaIntent,
  message,
  messageAttachment,
  user,
  userBlock,
  video,
} from "@my-tuums/db/schema";
import {
  CURSOR_MAX_ENCODED_LENGTH,
  MESSAGE_BODY_MAX_LENGTH,
  MESSAGE_IMAGE_MAX_COUNT,
  MESSAGE_PAGE_SIZE,
  MESSAGE_PAGE_SIZE_MAX,
  MESSAGE_VOICE_MAX_DURATION_MS,
} from "./constants.js";
import { createCursorCodec } from "./cursor.js";
import { jobIntentInsert } from "./jobs.js";
import { mediaPathFor } from "./image.js";
import { beginMediaUpload, mediaUploadIsLive } from "./media-intents.js";
import {
  acceptVoiceAudio,
  messageAttachmentsSelection,
  messageMediaObjectKey,
  messageVideoMediaPath,
  previewMediaKind,
  readMessageImages,
  type MessageAttachment,
  type MessageVoiceType,
} from "./message-media.js";
import { publishMessageEvent } from "./message-events.js";
import { keysetPage } from "./pagination.js";
import { protectedProcedure, rateLimit } from "./procedures.js";
import { RATE_LIMITS } from "./rate-limit.js";
import { requireStorage } from "./profile-media.js";
import { effectivelyBanned } from "./visibility.js";

/**
 * The private-message surface (issue #408): one conversation per pair of
 * users, plain-text messages, message requests as the anti-spam gate, and a
 * per-participant read cursor.
 *
 * Every write here re-checks its eligibility inside the same D1 batch it
 * writes in — a block that landed mid-request reads as a missing recipient
 * (`NOT_FOUND`, never a reveal), and a refused send leaves no conversation,
 * participant, or ordering changes behind. Real-time pushes happen strictly
 * after commit through the injected notifier and can fail without losing a
 * message: D1 is the single source of truth.
 */

/**
 * The canonical pair key of any two users: their ids, sorted. BetterAuth ids
 * are ASCII, so JavaScript's `<` orders exactly like SQLite's BINARY
 * collation — the same order the `conversation_pair_ordered` check pins, and
 * what makes "find the pair's conversation" deterministic whoever wrote
 * first.
 */
function pairOf(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** A block between the viewer and the other side, either way. Accepts the other side as an id or as a column expression. */
function blockedBetween(me: string, other: string | SQLWrapper) {
  return sql`exists (select 1 from ${userBlock}
    where (${userBlock.blockerId} = ${me} and ${userBlock.blockedId} = ${other})
       or (${userBlock.blockerId} = ${other} and ${userBlock.blockedId} = ${me}))`;
}

/** The conversation row's other participant, whichever side the viewer is on. */
function otherOfConversation(me: string) {
  return sql`(case when ${conversation.userAId} = ${me}
    then ${conversation.userBId} else ${conversation.userAId} end)`;
}

/**
 * Everything a send re-checks inside its own batch, never from a stale read:
 * the recipient exists, no block stands in either direction, and the sender
 * is not effectively banned (the same predicate post publication guards with
 * — a suspension has no session left to send from).
 */
function sendEligibility(senderId: string, recipientId: string) {
  return sql`exists (select 1 from ${user} where ${user.id} = ${recipientId})
    and not ${blockedBetween(senderId, recipientId)}
    and exists (select 1 from ${user} where ${user.id} = ${senderId} and ${not(effectivelyBanned)})`;
}

/** One page of a keyset-paginated list; see ./cursor.ts for the encoding. */
const pagedInput = z.object({
  cursor: z.string().max(CURSOR_MAX_ENCODED_LENGTH).optional(),
  limit: z.number().int().min(1).max(MESSAGE_PAGE_SIZE_MAX).default(MESSAGE_PAGE_SIZE),
});

/**
 * The inbox and request lists walk `(conversation.lastMessageAt,
 * conversation.id)` DESC; the thread walk `(message.createdAt, message.id)`
 * DESC. Three codecs, so a cursor minted by one list validates nowhere else
 * (all uuid tie-breakers, but separate identities).
 */
const conversationCursor = createCursorCodec(z.uuid());
const requestCursor = createCursorCodec(z.uuid());
const threadCursor = createCursorCodec(z.uuid());

/**
 * The other side of every conversation query: the OTHER participant's row,
 * aliased away from the viewer's own. The pair invariant guarantees it
 * exists whenever the viewer's does, and through it the other user's public
 * summary joins.
 */
function otherParticipant() {
  return alias(conversationParticipant, "other_participant");
}

/**
 * The last message of each conversation on a page, as a preview: tombstoned
 * bodies redact to null (the placeholder is the client's translation), and
 * the sender id tells the list row whose words the preview carries. A
 * media-only message previews through `mediaKind` — the first live
 * attachment's kind — because it has no body to show. One indexed probe per
 * conversation, bounded by the page size — the same page-slice pattern the
 * moderation queue's previews use.
 */
async function lastMessagePreviews(
  db: Database,
  conversationIds: string[],
): Promise<
  Map<string, { senderId: string; body: string | null; mediaKind: string | null; createdAt: Date }>
> {
  const previews = new Map<
    string,
    { senderId: string; body: string | null; mediaKind: string | null; createdAt: Date }
  >();
  if (conversationIds.length === 0) return previews;
  const probe = (conversationId: string) =>
    db
      .select({
        conversationId: message.conversationId,
        senderId: message.senderId,
        body: sql<string | null>`case when ${message.deletedAt} is null then ${message.body} end`,
        mediaKind: sql<string | null>`case when ${message.deletedAt} is null
          then ${previewMediaKind()} end`,
        createdAt: message.createdAt,
      })
      .from(message)
      .where(eq(message.conversationId, conversationId))
      .orderBy(desc(message.createdAt), desc(message.id))
      .limit(1);
  // The length guard above is what makes the non-empty batch honest; the
  // head-then-spread shape is how seedPosts builds its variable-length batch.
  const [firstId, ...restIds] = conversationIds;
  const pages = await db.batch([probe(firstId), ...restIds.map(probe)]);
  for (const page of pages) {
    const row = page[0];
    if (row) previews.set(row.conversationId, row);
  }
  return previews;
}

/** The `message` procedure group: send, the lists, the thread, the participant actions, and the read cursor. */
export const messageRouter = {
  /**
   * Sends one message — text, an image group, a voice note, or a Stream
   * video — creating the pair's conversation idempotently on first contact;
   * there is deliberately no separate "start conversation" step.
   *
   * One guarded batch: seed the conversation (`onConflictDoNothing` on the
   * pair key), upsert the sender's participation to `active` (replying to a
   * pending or hidden thread is the implicit accept of ONE's OWN side — the
   * recipient's status is never touched by the sender's writes), create the
   * recipient's participation only if absent (`active` when they follow the
   * sender at that moment, else `pending`), insert the message, its
   * attachment rows, consume the image/voice upload intent or queue the
   * video's processing job, and advance the ordering cursor only if the
   * message landed. Every statement carries the same eligibility predicate,
   * so a refused send writes nothing at all — and no half-sent media either:
   * leftover objects stay behind the expired intent for the reconciliation
   * recovery to reap.
   *
   * Media arrives one GROUP per message: up to four images (the shared
   * post-image acceptance), or one voice note (sniffed audio), or one video
   * the caller has fully uploaded to Stream (`state = 'uploaded'`). The video
   * path flips the row to `queued` inside this batch and dispatches the
   * existing processing Workflow after commit — the message renders
   * immediately; the bubble shows processing until the video's state turns
   * terminal (`advanceStreamVideo` owns both outcomes).
   *
   * The message's `createdAt` is `max(clock, lastMessageAt + 1)` — strictly
   * increasing per conversation — so the timestamp-only read cursor can never
   * consume a later message that shares a clock reading with a seen one.
   *
   * Blocks read as a missing recipient (`NOT_FOUND`), matching how a blocked
   * profile already reads everywhere else; a banned sender is `FORBIDDEN`.
   * Both codes come from a courtesy pre-read — the batch is the authority.
   */
  send: protectedProcedure
    .use(rateLimit(RATE_LIMITS.messageSend))
    .input(
      z
        .object({
          recipientId: z.string().min(1),
          // Trim first so whitespace never persists as fake content. Empty is
          // legal only beside an attachment (the cross-field rule below) —
          // the database check pins the upper bound alone because it cannot
          // see the attachment table.
          body: z.string().trim().max(MESSAGE_BODY_MAX_LENGTH).default(""),
          images: z.array(z.instanceof(File)).max(MESSAGE_IMAGE_MAX_COUNT).default([]),
          voice: z.instanceof(File).optional(),
          /** The composer's measured recording length; the byte cap bounds any lie. */
          voiceDurationMs: z
            .number()
            .int()
            .min(1)
            .max(MESSAGE_VOICE_MAX_DURATION_MS + 2000)
            .optional(),
          videoId: z.uuid().optional(),
        })
        .refine(
          ({ images, voice, videoId }) =>
            Number(images.length > 0) + Number(Boolean(voice)) + Number(Boolean(videoId)) <= 1,
          { error: "A message can contain one media kind.", path: ["images"] },
        )
        .refine(
          ({ body, images, voice, videoId }) =>
            Boolean(body) || images.length > 0 || Boolean(voice) || Boolean(videoId),
          {
            error: "Write a message or attach media.",
            path: ["body"],
          },
        )
        .refine(({ voice, voiceDurationMs }) => !voice || voiceDurationMs !== undefined, {
          error: "A voice note needs its recorded duration.",
          path: ["voiceDurationMs"],
        }),
    )
    .handler(async ({ input, context }) => {
      const senderId = context.user.id;
      if (input.recipientId === senderId) {
        throw new ORPCError("BAD_REQUEST", { message: "You can't message yourself." });
      }

      // Courtesy error codes only; the batch below re-checks every clause.
      const [state] = await context.db
        .select({
          recipientExists:
            sql<boolean>`exists (select 1 from ${user} where ${user.id} = ${input.recipientId})`.mapWith(
              Boolean,
            ),
          blocked: blockedBetween(senderId, input.recipientId).mapWith(Boolean),
          senderBanned:
            sql<boolean>`exists (select 1 from ${user} where ${user.id} = ${senderId} and ${effectivelyBanned})`.mapWith(
              Boolean,
            ),
        })
        .from(user)
        .where(eq(user.id, senderId))
        .limit(1);
      if (!state || state.senderBanned) {
        throw new ORPCError("FORBIDDEN", { message: "Your account can't send messages." });
      }
      if (!state.recipientExists || state.blocked) {
        // Deliberately one message for both: a block must not be revealed.
        throw new ORPCError("NOT_FOUND", { message: "No such user." });
      }

      // Media preparation reads and validates every byte BEFORE anything is
      // written; a refusal here leaves no record anywhere. Images and voice
      // ride this RPC (the caps above keep the body inside the RPC ceiling);
      // the video is already IN Stream — this only validates its row.
      const messageId = crypto.randomUUID();
      const stagedImages = input.images.length
        ? (
            await readMessageImages(input.images, (reason) => {
              throw new ORPCError("BAD_REQUEST", {
                message:
                  reason === "size" || reason === "total"
                    ? "Those images are too large."
                    : reason === "type"
                      ? "That image format isn't supported."
                      : "That file doesn't look like an image.",
              });
            })
          ).map((image) => {
            const attachmentId = crypto.randomUUID();
            return {
              ...image,
              attachmentId,
              key: messageMediaObjectKey(messageId, attachmentId, image.type),
            };
          })
        : [];
      let stagedVoice: {
        attachmentId: string;
        key: string;
        bytes: Uint8Array;
        type: MessageVoiceType;
        durationMs: number;
      } | null = null;
      if (input.voice) {
        const bytes = new Uint8Array(await input.voice.arrayBuffer());
        const verdict = acceptVoiceAudio(bytes, input.voice.type);
        if (!verdict.ok || !verdict.type || input.voiceDurationMs === undefined) {
          throw new ORPCError("BAD_REQUEST", {
            message:
              !verdict.ok && verdict.reason === "size"
                ? "That voice message is too large."
                : "That file doesn't look like a voice message.",
          });
        }
        const attachmentId = crypto.randomUUID();
        stagedVoice = {
          attachmentId,
          key: messageMediaObjectKey(messageId, attachmentId, verdict.type),
          bytes,
          type: verdict.type,
          durationMs: input.voiceDurationMs,
        };
      }
      let videoRow: { id: string; byteSize: number } | null = null;
      if (input.videoId) {
        const [row] = await context.db
          .select({
            id: video.id,
            byteSize: video.byteSize,
            state: video.state,
            expiresAt: video.expiresAt,
          })
          .from(video)
          .where(and(eq(video.id, input.videoId), eq(video.authorId, senderId)))
          .limit(1);
        if (!row || row.state !== "uploaded" || row.expiresAt.getTime() <= Date.now()) {
          throw new ORPCError("BAD_REQUEST", {
            message: "That video is no longer available. Upload it again.",
          });
        }
        videoRow = { id: row.id, byteSize: row.byteSize };
      }

      // Storage writes happen before the batch, behind a durable intent — the
      // post-image discipline: an ambiguous or failed send leaves the objects
      // to the intent's expiry cleanup and inventory reconciliation, never a
      // delete racing a lost acknowledgement.
      const stagedBlobs = [...stagedImages, ...(stagedVoice ? [stagedVoice] : [])];
      const storage = stagedBlobs.length > 0 ? requireStorage(context) : null;
      const uploadId =
        stagedBlobs.length > 0
          ? await beginMediaUpload(
              context.db,
              `message:${messageId}`,
              stagedBlobs.map(({ key }) => mediaPathFor(key)),
            )
          : null;
      if (storage) {
        try {
          for (const blob of stagedBlobs) {
            await storage.put(blob.key, blob.bytes, blob.type);
          }
        } catch {
          // The intent survives for recovery to clean every attempted key.
          throw new ORPCError("INTERNAL_SERVER_ERROR", {
            message: "Failed to store the attachment.",
          });
        }
      }

      const [userAId, userBId] = pairOf(senderId, input.recipientId);
      const eligible = and(
        sendEligibility(senderId, input.recipientId),
        uploadId ? mediaUploadIsLive(uploadId) : undefined,
      )!;
      const conversationId = crypto.randomUUID();
      const pairRow = sql`from ${conversation} c
        where c.user_a_id = ${userAId} and c.user_b_id = ${userBId} and ${eligible}`;

      // Statement 3's status: `active` when the recipient follows the sender
      // at this moment, else `pending` — the message request. Evaluated once,
      // when the row is created; later messages never re-open a declined
      // conversation, and only the recipient's own reply or accept does.
      const recipientStatus = sql`case when exists (select 1 from ${follow}
        where ${follow.followerId} = ${input.recipientId} and ${follow.followingId} = ${senderId})
        then 'active' else 'pending' end`;

      // The message insert's own extra clause when a video rides along: the
      // video must still be the caller's uploaded row, or the send writes
      // nothing (a message whose video vanished mid-request must not exist).
      const videoEligible = videoRow
        ? sql` and exists (select 1 from ${video} where ${video.id} = ${videoRow.id}
            and ${video.authorId} = ${senderId} and ${video.state} = 'uploaded'
            and ${video.expiresAt} > cast(unixepoch('subsec') * 1000 as integer))`
        : sql``;
      const messageRow = sql`from ${conversation} c
        where c.user_a_id = ${userAId} and c.user_b_id = ${userBId} and ${eligible}${videoEligible}`;
      const videoAttachmentId = crypto.randomUUID();

      // Attachment rows key on the message actually landing (and re-prove the
      // sender, so nothing can attach to a foreign message id).
      const messageLanded = sql`exists (select 1 from ${message}
        where ${message.id} = ${messageId} and ${message.senderId} = ${senderId})`;
      const attachmentInsert = (
        attachmentId: string,
        position: number,
        kind: "image" | "voice" | "video",
        mediaPath: string,
        contentType: string,
        byteSize: number,
        columns: { width?: number; height?: number; durationMs?: number; videoId?: string },
      ) =>
        context.db.insert(messageAttachment).select(
          sql`select ${attachmentId}, m.id, ${position}, ${kind}, ${mediaPath}, ${contentType},
              ${columns.videoId ?? null}, ${byteSize}, ${columns.width ?? null}, ${columns.height ?? null},
              ${columns.durationMs ?? null}, cast(unixepoch('subsec') * 1000 as integer)
              from ${message} m
              where m.id = ${messageId} and m.sender_id = ${senderId}`,
        );

      const [, , , inserted] = await context.db.batch([
        // Seed the pair's conversation; the loser of a concurrent first-send
        // race is a no-op on the unique pair key and every later statement
        // resolves the winner's row by the pair, so both sends land together.
        context.db
          .insert(conversation)
          .select(
            sql`select ${conversationId}, ${userAId}, ${userBId},
              cast(unixepoch('subsec') * 1000 as integer),
              cast(unixepoch('subsec') * 1000 as integer)
              where ${eligible}`,
          )
          .onConflictDoNothing(),
        context.db
          .insert(conversationParticipant)
          .select(
            sql`select c.id, ${senderId}, 'active', null, cast(unixepoch('subsec') * 1000 as integer) ${pairRow}`,
          )
          .onConflictDoUpdate({
            target: [conversationParticipant.conversationId, conversationParticipant.userId],
            // Replying is the implicit accept of the sender's own side.
            set: { status: "active" },
          }),
        context.db
          .insert(conversationParticipant)
          .select(
            sql`select c.id, ${input.recipientId}, ${recipientStatus}, null, cast(unixepoch('subsec') * 1000 as integer) ${pairRow}`,
          )
          .onConflictDoNothing(),
        context.db
          .insert(message)
          .select(
            sql`select ${messageId}, c.id, ${senderId}, ${input.body},
              max(cast(unixepoch('subsec') * 1000 as integer), c.last_message_at + 1), null ${messageRow}`,
          )
          .returning({
            id: message.id,
            conversationId: message.conversationId,
            senderId: message.senderId,
            createdAt: message.createdAt,
          }),
        // The ordering cursor advances to exactly the message's timestamp,
        // and only because the message landed in this conversation.
        context.db
          .update(conversation)
          .set({
            lastMessageAt: sql`(select m.created_at from ${message} m where m.id = ${messageId})`,
          })
          .where(
            and(
              eq(conversation.userAId, userAId),
              eq(conversation.userBId, userBId),
              sql`exists (select 1 from ${message}
                where ${message.id} = ${messageId} and ${message.conversationId} = ${conversation.id})`,
            ),
          ),
        // Attachment rows, upload-intent consumption and the video's queueing
        // land only when the message did.
        ...stagedImages.map((image, position) =>
          attachmentInsert(
            image.attachmentId,
            position,
            "image",
            mediaPathFor(image.key),
            image.type,
            image.bytes.byteLength,
            {
              width: image.width,
              height: image.height,
            },
          ),
        ),
        ...(stagedVoice
          ? [
              attachmentInsert(
                stagedVoice.attachmentId,
                0,
                "voice",
                mediaPathFor(stagedVoice.key),
                stagedVoice.type,
                stagedVoice.bytes.byteLength,
                { durationMs: stagedVoice.durationMs },
              ),
            ]
          : []),
        ...(uploadId
          ? [
              context.db
                .delete(mediaIntent)
                .where(
                  and(
                    eq(mediaIntent.id, uploadId),
                    sql`exists (select 1 from ${message} where ${message.id} = ${messageId})`,
                  ),
                ),
            ]
          : []),
        ...(videoRow
          ? [
              attachmentInsert(
                videoAttachmentId,
                0,
                "video",
                messageVideoMediaPath(videoRow.id),
                "application/vnd.apple.mpegurl",
                videoRow.byteSize,
                { videoId: videoRow.id },
              ),
              context.db
                .update(video)
                .set({
                  state: "queued",
                  expiresAt: sql`cast(unixepoch('subsec') * 1000 as integer) + 1800000`,
                })
                .where(
                  and(
                    eq(video.id, videoRow.id),
                    eq(video.authorId, senderId),
                    eq(video.state, "uploaded"),
                    messageLanded,
                  ),
                ),
              jobIntentInsert(
                context.db,
                { id: `video-${videoRow.id}`, kind: "video", entityId: videoRow.id },
                messageLanded,
              ),
            ]
          : []),
      ]);

      const sent = inserted[0];
      if (!sent) {
        // Eligibility flipped between the pre-read and the batch (a block
        // landed, the recipient vanished, the video vanished). Nothing was
        // written; the objects stay behind the intent for recovery.
        throw new ORPCError("NOT_FOUND", { message: "No such user." });
      }

      // Commit first; the Workflow's own recovery owns a missing dispatch.
      if (videoRow) {
        await context.videoJobs?.dispatch(`video-${videoRow.id}`).catch(() => {
          console.error({ event: "job_dispatch_deferred", jobId: `video-${videoRow.id}` });
        });
      }

      const attachments: MessageAttachment[] = [
        ...stagedImages.map((image, position) => ({
          id: image.attachmentId,
          kind: "image" as const,
          url: mediaPathFor(image.key),
          contentType: image.type,
          byteSize: image.bytes.byteLength,
          position,
          width: image.width,
          height: image.height,
          durationMs: null,
          video: null,
        })),
        ...(stagedVoice
          ? [
              {
                id: stagedVoice.attachmentId,
                kind: "voice" as const,
                url: mediaPathFor(stagedVoice.key),
                contentType: stagedVoice.type,
                byteSize: stagedVoice.bytes.byteLength,
                position: 0,
                width: null,
                height: null,
                durationMs: stagedVoice.durationMs,
                video: null,
              },
            ]
          : []),
        ...(videoRow
          ? [
              {
                id: videoAttachmentId,
                kind: "video" as const,
                url: messageVideoMediaPath(videoRow.id),
                contentType: "application/vnd.apple.mpegurl",
                byteSize: videoRow.byteSize,
                position: 0,
                width: null,
                height: null,
                durationMs: null,
                video: {
                  state: "queued" as const,
                  duration: 0,
                  posterUrl: messageVideoMediaPath(videoRow.id).replace("master.m3u8", "cover.jpg"),
                  previewUrl: messageVideoMediaPath(videoRow.id).replace(
                    "master.m3u8",
                    "previews.vtt",
                  ),
                  captionUrl: null,
                  captionLanguage: null,
                },
              },
            ]
          : []),
      ];

      await Promise.all([
        publishMessageEvent(context.messageNotifier, input.recipientId, {
          kind: "message",
          conversationId: sent.conversationId,
        }),
        publishMessageEvent(context.messageNotifier, senderId, {
          kind: "message",
          conversationId: sent.conversationId,
        }),
      ]);
      return { ...sent, body: input.body, attachments };
    }),

  /**
   * The caller's inbox: active conversations, newest activity first, with the
   * other user's summary, a last-message preview (tombstones redact), and the
   * conversation's unread count. Keyset-paginated on the conversation's
   * `(lastMessageAt, id)` — the cursor the inbox walk's index mirrors.
   */
  conversations: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(pagedInput)
    .handler(async ({ input, context }) => {
      const me = context.user.id;
      const other = otherParticipant();
      const selection = {
        conversationId: conversation.id,
        lastMessageAt: conversation.lastMessageAt,
        lastReadAt: conversationParticipant.lastReadAt,
        // Unread is derived, never stored: the other party's live messages
        // newer than my cursor, counted per row for the list badge. Same
        // comparison `unreadCount` applies — the two can never disagree.
        unreadCount: sql<number>`(select count(*) from ${message}
          where ${message.conversationId} = ${conversation.id}
            and ${message.senderId} <> ${me}
            and ${message.deletedAt} is null
            and ${message.createdAt} > coalesce(${conversationParticipant.lastReadAt}, 0))`.mapWith(
          Number,
        ),
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          displayUsername: user.displayUsername,
          image: user.image,
        },
      };
      const page = await keysetPage({
        codec: conversationCursor,
        cursor: input.cursor,
        limit: input.limit,
        selection,
        createdAt: conversation.lastMessageAt,
        createdAtField: "lastMessageAt",
        id: conversation.id,
        idField: "conversationId",
        fetchPage: (cursorFilter) =>
          context.db
            .select(selection)
            .from(conversationParticipant)
            .innerJoin(conversation, eq(conversation.id, conversationParticipant.conversationId))
            .innerJoin(
              other,
              and(
                eq(other.conversationId, conversationParticipant.conversationId),
                ne(other.userId, me),
              ),
            )
            .innerJoin(user, eq(user.id, other.userId))
            .where(
              and(
                eq(conversationParticipant.userId, me),
                eq(conversationParticipant.status, "active"),
                // A block in either direction hides the conversation from
                // this list — the same read-time rule, never a mutation.
                sql`not ${blockedBetween(me, other.userId)}`,
                cursorFilter,
              ),
            )
            .orderBy(desc(conversation.lastMessageAt), desc(conversation.id))
            .limit(input.limit + 1),
      });
      const previews = await lastMessagePreviews(
        context.db,
        page.items.map((item) => item.conversationId),
      );
      return {
        items: page.items.map((item) => ({
          ...item,
          lastMessage: previews.get(item.conversationId) ?? null,
        })),
        nextCursor: page.nextCursor,
      };
    }),

  /**
   * The caller's message requests: pending conversations — first contact
   * from someone they do not follow. Requests never tick the unread badge;
   * their count is `unreadCount`'s separate `requestCount`. Same walk and
   * cursor shape as the inbox, over `pending` instead of `active`.
   */
  requests: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(pagedInput)
    .handler(async ({ input, context }) => {
      const me = context.user.id;
      const other = otherParticipant();
      const selection = {
        conversationId: conversation.id,
        lastMessageAt: conversation.lastMessageAt,
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          displayUsername: user.displayUsername,
          image: user.image,
        },
      };
      const page = await keysetPage({
        codec: requestCursor,
        cursor: input.cursor,
        limit: input.limit,
        selection,
        createdAt: conversation.lastMessageAt,
        createdAtField: "lastMessageAt",
        id: conversation.id,
        idField: "conversationId",
        fetchPage: (cursorFilter) =>
          context.db
            .select(selection)
            .from(conversationParticipant)
            .innerJoin(conversation, eq(conversation.id, conversationParticipant.conversationId))
            .innerJoin(
              other,
              and(
                eq(other.conversationId, conversationParticipant.conversationId),
                ne(other.userId, me),
              ),
            )
            .innerJoin(user, eq(user.id, other.userId))
            .where(
              and(
                eq(conversationParticipant.userId, me),
                eq(conversationParticipant.status, "pending"),
                sql`not ${blockedBetween(me, other.userId)}`,
                cursorFilter,
              ),
            )
            .orderBy(desc(conversation.lastMessageAt), desc(conversation.id))
            .limit(input.limit + 1),
      });
      const previews = await lastMessagePreviews(
        context.db,
        page.items.map((item) => item.conversationId),
      );
      return {
        items: page.items.map((item) => ({
          ...item,
          lastMessage: previews.get(item.conversationId) ?? null,
        })),
        nextCursor: page.nextCursor,
      };
    }),

  /**
   * One conversation's messages, newest first, for an authorized participant
   * across no block. A HIDDEN side may still read — hiding is the viewer's
   * own list-curation gesture, and the explicit navigation back in (the
   * profile's Message action) must show the history; the header flags
   * `hidden` so the pane can say what sends will do. Tombstones return their
   * metadata with the body redacted; the other party's acceptance, hiding, or
   * read state is never part of the response.
   */
  thread: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(pagedInput.extend({ conversationId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const me = context.user.id;
      const other = otherParticipant();
      const [header] = await context.db
        .select({
          conversationId: conversation.id,
          lastReadAt: conversationParticipant.lastReadAt,
          status: conversationParticipant.status,
          user: {
            id: user.id,
            name: user.name,
            username: user.username,
            displayUsername: user.displayUsername,
            image: user.image,
          },
        })
        .from(conversationParticipant)
        .innerJoin(conversation, eq(conversation.id, conversationParticipant.conversationId))
        .innerJoin(
          other,
          and(
            eq(other.conversationId, conversationParticipant.conversationId),
            ne(other.userId, me),
          ),
        )
        .innerJoin(user, eq(user.id, other.userId))
        .where(
          and(
            eq(conversationParticipant.conversationId, input.conversationId),
            eq(conversationParticipant.userId, me),
            sql`not ${blockedBetween(me, other.userId)}`,
          ),
        )
        .limit(1);
      if (!header) {
        throw new ORPCError("NOT_FOUND", { message: "This conversation doesn't exist." });
      }
      const { status, ...visible } = header;

      const selection = {
        id: message.id,
        senderId: message.senderId,
        body: sql<string | null>`case when ${message.deletedAt} is null then ${message.body} end`,
        createdAt: message.createdAt,
        deletedAt: message.deletedAt,
        // Tombstoned messages redact their attachments with their body — the
        // aggregate gates on the same deletion stamp, so the projection is
        // the only place that decides.
        attachments: messageAttachmentsSelection(),
      };
      const page = await keysetPage({
        codec: threadCursor,
        cursor: input.cursor,
        limit: input.limit,
        selection,
        createdAt: message.createdAt,
        createdAtField: "createdAt",
        id: message.id,
        idField: "id",
        fetchPage: (cursorFilter) =>
          context.db
            .select(selection)
            .from(message)
            .where(and(eq(message.conversationId, input.conversationId), cursorFilter))
            .orderBy(desc(message.createdAt), desc(message.id))
            .limit(input.limit + 1),
      });
      return {
        ...visible,
        hidden: status === "hidden",
        items: page.items,
        nextCursor: page.nextCursor,
      };
    }),

  /**
   * The badge and the requests entry: unread incoming, nondeleted messages in
   * ACTIVE conversations (pending requests never tick the badge), plus the
   * pending-request count the requests entry carries. Both counts apply the
   * same block filter the lists do, so a number never disagrees with the page
   * behind it.
   */
  unreadCount: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(z.object({}))
    .handler(async ({ context }) => {
      const me = context.user.id;
      const notBlocked = sql`not ${blockedBetween(me, otherOfConversation(me))}`;
      const [unreadRows, requestRows] = await context.db.batch([
        context.db
          .select({ count: sql<number>`count(*)` })
          .from(message)
          .innerJoin(
            conversationParticipant,
            and(
              eq(conversationParticipant.conversationId, message.conversationId),
              eq(conversationParticipant.userId, me),
            ),
          )
          .innerJoin(conversation, eq(conversation.id, message.conversationId))
          .where(
            and(
              eq(conversationParticipant.status, "active"),
              sql`${message.senderId} <> ${me}`,
              isNull(message.deletedAt),
              sql`${message.createdAt} > coalesce(${conversationParticipant.lastReadAt}, 0)`,
              notBlocked,
            ),
          ),
        context.db
          .select({ count: sql<number>`count(*)` })
          .from(conversationParticipant)
          .innerJoin(conversation, eq(conversation.id, conversationParticipant.conversationId))
          .where(
            and(
              eq(conversationParticipant.userId, me),
              eq(conversationParticipant.status, "pending"),
              notBlocked,
            ),
          ),
      ]);
      return {
        unreadCount: unreadRows[0]?.count ?? 0,
        requestCount: requestRows[0]?.count ?? 0,
      };
    }),

  /**
   * Moves a pending conversation into the inbox. Guarded by caller
   * membership and the row's own status — a block belongs to the reads (the
   * lists never surface a blocked conversation), not to a state change on
   * the caller's own row. Idempotence is the status guard: accepting twice
   * changes nothing the second time.
   */
  accept: protectedProcedure
    .use(rateLimit(RATE_LIMITS.follow))
    .input(z.object({ conversationId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const accepted = await context.db
        .update(conversationParticipant)
        .set({ status: "active" })
        .where(
          and(
            eq(conversationParticipant.conversationId, input.conversationId),
            eq(conversationParticipant.userId, context.user.id),
            eq(conversationParticipant.status, "pending"),
          ),
        )
        .returning({ conversationId: conversationParticipant.conversationId });
      if (accepted.length === 0) {
        throw new ORPCError("NOT_FOUND", { message: "No such message request." });
      }
      await publishMessageEvent(context.messageNotifier, context.user.id, {
        kind: "conversation",
        conversationId: input.conversationId,
      });
      return { conversationId: input.conversationId };
    }),

  /**
   * Declines a message request: the conversation moves to `hidden` for the
   * decliner only — silently, exactly like blocking. The sender is never
   * told, their own thread keeps working, and messages they keep sending
   * stay invisible to this side. The sender's real defense against that is
   * blocking (which refuses sends); the send budget bounds the volume.
   */
  decline: protectedProcedure
    .use(rateLimit(RATE_LIMITS.follow))
    .input(z.object({ conversationId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const declined = await context.db
        .update(conversationParticipant)
        .set({ status: "hidden" })
        .where(
          and(
            eq(conversationParticipant.conversationId, input.conversationId),
            eq(conversationParticipant.userId, context.user.id),
            eq(conversationParticipant.status, "pending"),
          ),
        )
        .returning({ conversationId: conversationParticipant.conversationId });
      if (declined.length === 0) {
        throw new ORPCError("NOT_FOUND", { message: "No such message request." });
      }
      await publishMessageEvent(context.messageNotifier, context.user.id, {
        kind: "conversation",
        conversationId: input.conversationId,
      });
      return { conversationId: input.conversationId };
    }),

  /**
   * Hides a conversation from the caller's inbox — the same `hidden` state
   * declining writes, applied to an accepted thread. Idempotent: hiding an
   * already-hidden side succeeds. Hidden does not mean sealed: the profile's
   * Message action re-opens the thread with its history, and SENDING is what
   * returns it to the inbox.
   */
  hide: protectedProcedure
    .use(rateLimit(RATE_LIMITS.follow))
    .input(z.object({ conversationId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const hidden = await context.db
        .update(conversationParticipant)
        .set({ status: "hidden" })
        .where(
          and(
            eq(conversationParticipant.conversationId, input.conversationId),
            eq(conversationParticipant.userId, context.user.id),
            ne(conversationParticipant.status, "hidden"),
          ),
        )
        .returning({ conversationId: conversationParticipant.conversationId });
      if (hidden.length === 0) {
        // Not "already hidden" (that is this procedure's own idempotence)
        // but "not mine to hide" reads as missing.
        const [row] = await context.db
          .select({ userId: conversationParticipant.userId })
          .from(conversationParticipant)
          .where(
            and(
              eq(conversationParticipant.conversationId, input.conversationId),
              eq(conversationParticipant.userId, context.user.id),
            ),
          )
          .limit(1);
        if (!row) {
          throw new ORPCError("NOT_FOUND", { message: "This conversation doesn't exist." });
        }
      }
      await publishMessageEvent(context.messageNotifier, context.user.id, {
        kind: "conversation",
        conversationId: input.conversationId,
      });
      return { conversationId: input.conversationId };
    }),

  /**
   * The conversation with one user, if any — what the profile "Message"
   * action resolves before composing. `null` when there is none or across a
   * block (the pair then reads as contactable only one way, and a send will
   * refuse). A HIDDEN side still resolves, flagged: hiding is the viewer's
   * own list-curation gesture, and their explicit navigation back into the
   * thread (this lookup → `/messages/$id`) must show the history they share —
   * only the send re-returns it to the inbox.
   *
   * The conversation resolves by a CORRELATED subselect, not a join: joining
   * the viewer's participation rows would leave one unrelated row per other
   * conversation in the result, and a `limit 1` could hand back that null
   * conversation instead of the pair's real one. The subselect can only
   * answer with the one conversation it names.
   */
  conversationWith: protectedProcedure
    .use(rateLimit(RATE_LIMITS.read))
    .input(z.object({ userId: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const me = context.user.id;
      if (input.userId === me) return { conversationId: null, user: null, hidden: false };
      const [row] = await context.db
        .select({
          conversationId: sql<string | null>`(
            select c.id from ${conversation} c
            where exists (
              select 1 from ${conversationParticipant} p
              where p.conversation_id = c.id
                and p.user_id = ${me}
            )
              and ((c.user_a_id = ${me} and c.user_b_id = ${input.userId})
                or (c.user_a_id = ${input.userId} and c.user_b_id = ${me}))
            limit 1
          )`,
          hidden: sql<boolean>`(
            select p.status = 'hidden'
            from ${conversationParticipant} p
            inner join ${conversation} c on c.id = p.conversation_id
            where p.user_id = ${me}
              and ((c.user_a_id = ${me} and c.user_b_id = ${input.userId})
                or (c.user_a_id = ${input.userId} and c.user_b_id = ${me}))
            limit 1
          )`.mapWith(Boolean),
          user: {
            id: user.id,
            name: user.name,
            username: user.username,
            displayUsername: user.displayUsername,
            image: user.image,
          },
        })
        .from(user)
        .where(and(eq(user.id, input.userId), sql`not ${blockedBetween(me, input.userId)}`))
        .limit(1);
      return {
        conversationId: row?.conversationId ?? null,
        hidden: row?.conversationId ? (row.hidden ?? false) : false,
        user: row?.user ?? null,
      };
    }),

  /**
   * Advances the caller's read cursor THROUGH one message they have actually
   * seen — never to "now": a message arriving after the displayed page must
   * stay unread. The cursor moves monotonically to exactly that message's
   * timestamp (strictly increasing per conversation, so no later message can
   * share it), and the message must belong to the authorized conversation.
   * `advanced: false` is the idempotent no-op — an older or already-seen
   * message, or a concurrent equal advance.
   */
  markRead: protectedProcedure
    .use(rateLimit(RATE_LIMITS.markRead))
    .input(z.object({ conversationId: z.uuid(), lastSeenMessageId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const me = context.user.id;
      const seenAt = sql`(select ${message.createdAt} from ${message}
        where ${message.id} = ${input.lastSeenMessageId}
          and ${message.conversationId} = ${input.conversationId})`;
      // The hidden owner may acknowledge too: they are reading the thread
      // (the thread read allows them), and a cursor left behind would tick
      // the badge retroactively the moment a send re-activates the side.
      const participation = and(
        eq(conversationParticipant.conversationId, input.conversationId),
        eq(conversationParticipant.userId, me),
      );
      const advanced = await context.db
        .update(conversationParticipant)
        .set({ lastReadAt: seenAt })
        .where(
          and(
            participation,
            sql`${seenAt} is not null`,
            sql`${seenAt} > coalesce(${conversationParticipant.lastReadAt}, 0)`,
          ),
        )
        .returning({ lastReadAt: conversationParticipant.lastReadAt });
      if (advanced[0]) {
        // Other tabs of the SAME user clear their badges from this event;
        // the other party learns nothing (no read receipts in v1).
        await publishMessageEvent(context.messageNotifier, me, {
          kind: "read",
          conversationId: input.conversationId,
        });
        return { lastReadAt: advanced[0].lastReadAt, advanced: true };
      }
      // Zero rows updated is one of three things, and only one of them is a
      // success: the seen message is older than (or equal to) the cursor —
      // the idempotent no-op. A participation row that does not exist, or a
      // `lastSeenMessageId` that does not belong to this conversation, reads
      // as missing exactly like every other message surface.
      const [row] = await context.db
        .select({
          lastReadAt: conversationParticipant.lastReadAt,
          seen: sql<boolean>`exists (select 1 from ${message}
            where ${message.id} = ${input.lastSeenMessageId}
              and ${message.conversationId} = ${input.conversationId})`.mapWith(Boolean),
        })
        .from(conversationParticipant)
        .where(participation)
        .limit(1);
      if (!row || !row.seen) {
        throw new ORPCError("NOT_FOUND", { message: "This conversation doesn't exist." });
      }
      return { lastReadAt: row.lastReadAt, advanced: false };
    }),

  /**
   * Tombstones one of the caller's own messages — a stamp, never a row
   * delete, so conversation order and report evidence survive. Idempotent:
   * deleting an already-deleted message succeeds with the existing stamp.
   * Authorization is sender ownership alone; deleting one's own words is not
   * gated on the recipient's later actions.
   */
  deleteMessage: protectedProcedure
    .use(rateLimit(RATE_LIMITS.messageSend))
    .input(z.object({ messageId: z.uuid() }))
    .handler(async ({ input, context }) => {
      const me = context.user.id;
      const tombstoned = await context.db
        .update(message)
        .set({ deletedAt: sql`cast(unixepoch('subsec') * 1000 as integer)` })
        .where(
          and(eq(message.id, input.messageId), eq(message.senderId, me), isNull(message.deletedAt)),
        )
        .returning({
          id: message.id,
          conversationId: message.conversationId,
          deletedAt: message.deletedAt,
        });
      const row =
        tombstoned[0] ??
        (
          await context.db
            .select({
              id: message.id,
              conversationId: message.conversationId,
              deletedAt: message.deletedAt,
            })
            .from(message)
            .where(and(eq(message.id, input.messageId), eq(message.senderId, me)))
            .limit(1)
        )[0];
      if (!row) {
        throw new ORPCError("NOT_FOUND", { message: "This message doesn't exist." });
      }
      const [pair] = await context.db
        .select({ userAId: conversation.userAId, userBId: conversation.userBId })
        .from(conversation)
        .where(eq(conversation.id, row.conversationId))
        .limit(1);
      if (pair) {
        // Both sides' open threads, previews, and unread counts refresh;
        // a tombstone can retire an unread message either side still owes.
        await Promise.all([
          publishMessageEvent(context.messageNotifier, pair.userAId, {
            kind: "message",
            conversationId: row.conversationId,
          }),
          publishMessageEvent(context.messageNotifier, pair.userBId, {
            kind: "message",
            conversationId: row.conversationId,
          }),
        ]);
      }
      return row;
    }),
};
