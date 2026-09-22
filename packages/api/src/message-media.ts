/**
 * Private-message attachment rules (issue #408): the image group and voice
 * note validation, the storage key shapes, and the `/media/` authorizer.
 *
 * Deliberately separate from `post-media.ts` for the same reason post media
 * is separate from profile media: a message attachment's visibility follows
 * the CONVERSATION (its participants, and its reports' moderator gate), not a
 * post's visibility filter. The image rules themselves are the shared
 * post-image acceptance — the same formats, byte caps and dimension checks —
 * so a DM photo and a post photo are validated by one definition.
 */
import { and, eq, getTableName, sql, type AnyColumn } from "drizzle-orm";
import type { Database } from "@my-tuums/db";
import {
  conversationParticipant,
  message,
  messageAttachment,
  report,
  user,
  video,
} from "@my-tuums/db/schema";
import { z } from "zod";
import {
  MESSAGE_IMAGE_MAX_BYTES,
  MESSAGE_IMAGE_MAX_TOTAL_BYTES,
  MESSAGE_VOICE_INPUT_TYPES,
  MESSAGE_VOICE_MAX_BYTES,
  type AllowedImageType,
} from "./constants.js";
import { acceptPostImage, type ImageRejection } from "./post-image.js";
import { roleAtLeast } from "./roles.js";

/** One validated image attachment ready for storage. */
export interface MessageImageInput {
  bytes: Uint8Array;
  type: AllowedImageType;
  width: number;
  height: number;
}

/** A voice note as the procedure accepts it: sniffed type, bytes, declared duration. */
export interface MessageVoiceInput {
  bytes: Uint8Array;
  type: MessageVoiceType;
  /** The composer's measured recording length; the byte cap bounds any lie. */
  durationMs: number;
}

export type MessageVoiceType = (typeof MESSAGE_VOICE_INPUT_TYPES)[number];

const VOICE_EXTENSION = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/wav": "wav",
} satisfies Record<MessageVoiceType, string>;

const IMAGE_EXTENSION = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
} satisfies Record<AllowedImageType, string>;

/**
 * Attachment object keys are scoped by the MESSAGE id alone. The conversation
 * id is deliberately absent: on a first send the pair's conversation row is
 * minted idempotently and a concurrent first sender can lose its own minted
 * id to the unique-pair race, so only the message id — fresh and exclusive to
 * this send — is stable at key-minting time. Authorization is row-based, not
 * path-based, so the shorter key loses nothing. Messages derive no image
 * variants (no `messages/` entry in MEDIA_VARIANT_WIDTHS): a bubble renders
 * at bubble size, and a fullscreen view is rare enough to pay the original
 * bytes.
 */
export function messageMediaObjectKey(
  messageId: string,
  attachmentId: string,
  type: AllowedImageType | MessageVoiceType,
): string {
  const extensions = { ...IMAGE_EXTENSION, ...VOICE_EXTENSION };
  const extension = extensions[type];
  return `messages/${messageId}/${attachmentId}.${extension}`;
}

/**
 * The video attachment's stored path — the Stream manifest, exactly the
 * `postAttachment` convention (`stream-publication.ts`), so the playback
 * projection and the media gate treat both identically.
 */
export function messageVideoMediaPath(videoId: string): string {
  return `/media/videos/${videoId}/master.m3u8`;
}

/**
 * Reads and validates the image files before any object is written. The same
 * three rejections as posts — per-file size, sniffed type, batch total — with
 * the message module owning its error surface (the composer shows its own
 * copy, which must not be pinned to post wording).
 */
export function readMessageImages(
  files: readonly File[],
  reject: (reason: ImageRejection | "total") => never,
): Promise<MessageImageInput[]> {
  let declaredTotal = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MESSAGE_IMAGE_MAX_BYTES) {
      reject("size");
    }
    declaredTotal += file.size;
    if (declaredTotal > MESSAGE_IMAGE_MAX_TOTAL_BYTES) reject("total");
  }

  return Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // File.size is declared at the boundary; the bytes are the authority.
      if (bytes.byteLength !== file.size) reject("size");
      const verdict = acceptPostImage(bytes, file.type);
      if (
        !verdict.ok ||
        !verdict.type ||
        verdict.width === undefined ||
        verdict.height === undefined
      ) {
        reject(verdict.reason ?? "content");
      }
      return { bytes, type: verdict.type, width: verdict.width, height: verdict.height };
    }),
  );
}

/**
 * Whether these bytes may be stored as a voice note, sniffed from the
 * container's own leading bytes — the declared MIME is never trusted (the
 * same rule as `sniffImageType`). The size check runs first so a hostile
 * upload is refused on a cheap comparison.
 */
type VoiceVerdict = { ok: true; type: MessageVoiceType } | { ok: false; reason: "size" | "type" };

export function acceptVoiceAudio(bytes: Uint8Array, declaredType: string): VoiceVerdict {
  if (bytes.byteLength <= 0 || bytes.byteLength > MESSAGE_VOICE_MAX_BYTES)
    return { ok: false, reason: "size" };
  if (!MESSAGE_VOICE_INPUT_TYPES.some((type) => type === declaredType))
    return { ok: false, reason: "type" };

  const type = sniffAudioType(bytes);
  if (!type) return { ok: false, reason: "type" };
  return { ok: true, type };
}

/**
 * Container signatures for the voice formats. WebM is EBML; MP4/M4A is ISO
 * BMFF (`ftyp` box); Ogg, WAVE and ID3 are literal. Frame sync distinguishes
 * ADTS AAC from MPEG audio.
 */
function sniffAudioType(bytes: Uint8Array): MessageVoiceType | null {
  const ascii = (offset: number, text: string) =>
    Array.from(text, (character, index) => bytes[offset + index] === character.charCodeAt(0)).every(
      Boolean,
    );
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return "audio/webm";
  }
  // `ftyp` at offset 4 is the ISO BMFF family — every browser's mp4/AAC
  // voice container lands here, whatever the major brand spells.
  if (bytes.length >= 8 && ascii(4, "ftyp")) return "audio/mp4";
  if (bytes.length >= 4 && ascii(0, "OggS")) return "audio/ogg";
  if (bytes.length >= 12 && ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav";
  if (bytes.length >= 3 && ascii(0, "ID3")) return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    // ADTS AAC frames sync on 0xFFF1/0xFFF9; bare MPEG frame syncs are wider.
    if (bytes[1] === 0xf1 || bytes[1] === 0xf9) return "audio/aac";
    return "audio/mpeg";
  }
  return null;
}

/**
 * Authorizes a `/media/` request for a message attachment.
 *
 * Participants of the conversation may see it — pending and hidden sides
 * included, exactly like the thread read they sit beside — for as long as
 * the message is live; a tombstoned message's attachments close with its
 * body (the projections hide both, and report evidence is the moderator's
 * way back in). A named viewer whose account row is gone stays fail-closed.
 *
 * The one moderator pass is report-gated: a moderator may fetch a message's
 * media only when its exact path appears in a submitted report's evidence,
 * including the bounded context captured alongside the reported message.
 * Reports outlive their resolution on purpose (report stamps), so evidence
 * stays reachable through the case that judged it and through nothing else.
 */
export async function canViewMessageMedia(
  db: Database,
  key: string,
  viewerId: string | null,
): Promise<boolean> {
  const path = `/media/${key}`;
  if (!viewerId) return false;
  const [viewer] = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, viewerId))
    .limit(1);
  if (!viewer) return false;
  const isModerator = roleAtLeast(viewer.role ?? "user", "moderator");
  if (isModerator) {
    // Only paths captured in a submitted report (including its context) are
    // evidence. A report must never unlock the rest of the conversation.
    const evidence = await db.all(sql`
      select 1 from ${report},
        json_each(case when ${report.targetType} = 'message' and json_valid(${report.snapshotContent})
          then ${report.snapshotContent} else '{}' end, '$.messages') as entry,
        json_each(entry.value, '$.attachments') as attachment
      where json_extract(attachment.value, '$.url') = ${path} limit 1
    `);
    if (evidence.length > 0) return true;
  }

  const [found] = await db
    .select({ id: messageAttachment.id })
    .from(messageAttachment)
    .leftJoin(message, eq(message.id, messageAttachment.messageId))
    .where(
      and(
        eq(messageAttachment.mediaPath, path),
        sql`(
          (${message.deletedAt} is null and exists (
            select 1 from ${conversationParticipant}
            where ${conversationParticipant.conversationId} = ${message.conversationId}
              and ${conversationParticipant.userId} = ${viewerId}
          ))

        )`,
      ),
    )
    .limit(1);
  return found !== undefined;
}

/** The zod shape of one attachment row as every thread reader serves it. */
export const messageAttachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "voice", "video"]),
  url: z.string(),
  contentType: z.string(),
  byteSize: z.number(),
  position: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  durationMs: z.number().nullable(),
  video: z
    .object({
      state: z.enum([
        "uploading",
        "uploaded",
        "queued",
        "processing",
        "ready",
        "published",
        "failed",
        "cancelled",
        "deleted",
      ]),
      duration: z.number(),
      posterUrl: z.string(),
      previewUrl: z.string(),
      // The post video object's shape, mirrored so one player renders both
      // (a DM video carries no captions — these stay null).
      captionUrl: z.string().nullable(),
      captionLanguage: z.string().nullable(),
    })
    .nullable(),
});
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;

/**
 * Joins strip the table qualifier from column references (issue #368, the
 * same trap `postAttachmentsSelection` documents): inside the correlated
 * aggregates below every column is therefore qualified EXPLICITLY, never by
 * drizzle's mood — `message.id` left bare would resolve against the INNER
 * `message_attachment` scope and every attachment list would come back empty.
 */
function qualified(table: string, column: string) {
  return sql`${sql.identifier(table)}.${sql.identifier(column)}`;
}

function outerMessage(column: "id" | "deleted_at") {
  return qualified("message", column);
}

function attachmentColumn(column: AnyColumn) {
  return qualified(getTableName(column.table), column.name);
}

/**
 * Every attachment of one message as a single correlated aggregate — the same
 * shape discipline as the posts' `postAttachmentsSelection`: one JSON
 * projection that the thread walk, the inbox previews and the report
 * snapshots share, so no second hand-maintained copy can drift (the quote
 * preview's drift was issue #403). Video attachments join the video row for
 * its live processing state and playback metadata — a message lands while its
 * video is still `queued`, and the bubble renders processing until the state
 * turns terminal. Tombstoned messages expose no attachments (the report
 * snapshot and the report-gated moderator pass are the evidence path).
 */
export function messageAttachmentsSelection(includeDeleted = false) {
  const attachment = sql`json_object(
    'id', ${attachmentColumn(messageAttachment.id)},
    'kind', ${attachmentColumn(messageAttachment.kind)},
    'url', ${attachmentColumn(messageAttachment.mediaPath)},
    'contentType', ${attachmentColumn(messageAttachment.contentType)},
    'byteSize', ${attachmentColumn(messageAttachment.byteSize)},
    'position', ${attachmentColumn(messageAttachment.position)},
    'width', coalesce(${attachmentColumn(messageAttachment.width)}, ${attachmentColumn(video.playback)} -> 'width'),
    'height', coalesce(${attachmentColumn(messageAttachment.height)}, ${attachmentColumn(video.playback)} -> 'height'),
    'durationMs', ${attachmentColumn(messageAttachment.durationMs)},
    'video', case when ${attachmentColumn(video.id)} is null then null else json_object(
      'state', ${attachmentColumn(video.state)},
      'duration', coalesce(${attachmentColumn(video.playback)} -> 'duration', 0),
      'posterUrl', replace(${attachmentColumn(messageAttachment.mediaPath)}, 'master.m3u8', 'cover.jpg'),
      'previewUrl', replace(${attachmentColumn(messageAttachment.mediaPath)}, 'master.m3u8', 'previews.vtt'),
      'captionUrl', null,
      'captionLanguage', null
    ) end
  )`;
  return sql`coalesce((
    select json_group_array(json(${attachment}) order by ${attachmentColumn(messageAttachment.position)})
    from ${messageAttachment}
    left join ${video} on ${attachmentColumn(video.id)} = ${attachmentColumn(messageAttachment.videoId)}
    where ${attachmentColumn(messageAttachment.messageId)} = ${outerMessage("id")}
      and ${includeDeleted ? sql`true` : sql`${outerMessage("deleted_at")} is null`}
  ), '[]')`.mapWith((raw: string | null): MessageAttachment[] =>
    messageAttachmentSchema.array().parse(JSON.parse(raw ?? "[]")),
  );
}

/**
 * The preview line's media marker: the newest live message's first attachment
 * kind, or null for a text message. Media-only messages have no body to
 * preview, so the inbox needs the kind to show a localized placeholder. The
 * caller gates on the message's own deletion stamp.
 */
export function previewMediaKind() {
  return sql<string | null>`(
    select ${attachmentColumn(messageAttachment.kind)} from ${messageAttachment}
    where ${attachmentColumn(messageAttachment.messageId)} = ${outerMessage("id")}
    order by ${attachmentColumn(messageAttachment.position)}
    limit 1
  )`;
}
