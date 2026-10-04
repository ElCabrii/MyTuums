import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@my-tuums/db";
import { video } from "@my-tuums/db/schema";
import { canViewMessageMedia } from "./message-media.js";
import { canViewPostMedia } from "./post-media.js";
import type { StreamService } from "./stream.js";

export type VideoMedia = { url: string } | { body: string; contentType: string };
const uuid = z.uuid();

/**
 * Phase timings for the manifest/poster/caption path (issue #405), so hosted
 * before/after comparisons can attribute time-to-first-byte to the row read,
 * each authorization pass, or provider interaction — never to a key or viewer.
 */
export type VideoMediaTiming = {
  event: "video_media_timing";
  resource: "manifest" | "cover" | "preview" | "previews" | "captions";
  rowsMs: number;
  authorizeMs: number;
  providerMs: number;
  reauthorizeMs: number;
};

const since = (started: number) => Math.round(performance.now() - started);

/**
 * Token issuance and every thumbnail/caption request use the ordinary post
 * authorizer, falling back to the message-participant authorizer for videos
 * attached to a private message (issue #408 — those rows have no post, and
 * their visibility is the conversation's). Direct Stream playback is a bearer
 * capability valid for one hour; subsequent segments do not pass through
 * Access or the application again.
 */
function canViewVideoMedia(
  db: Database,
  master: string,
  viewerId: string | null,
): Promise<boolean> {
  return canViewPostMedia(db, master, viewerId).then((allowed) =>
    allowed ? true : canViewMessageMedia(db, master, viewerId),
  );
}
export async function resolveVideoMedia(
  db: Database,
  stream: Pick<StreamService, "signedVideoUrl" | "readCaptions"> | null,
  key: string,
  viewerId: string | null,
  observe: (timing: VideoMediaTiming) => void = () => {},
): Promise<VideoMedia | null> {
  if (!stream) return null;
  const match =
    /^videos\/([0-9a-f-]{36})\/(master\.m3u8|cover\.jpg|previews\.vtt|captions\.vtt|preview-(0|[1-9]\d{0,2})\.jpg)$/.exec(
      key,
    );
  if (!match?.[1] || !uuid.safeParse(match[1]).success) return null;
  const rowsStarted = performance.now();
  const [row] = await db
    .select()
    .from(video)
    .where(and(eq(video.id, match[1]), eq(video.state, "published")));
  const rowsMs = since(rowsStarted);
  if (!row?.streamUid || !row.playback) return null;
  const prefix = `videos/${row.id}/`;
  const master = `${prefix}master.m3u8`;
  const authorizeStarted = performance.now();
  const authorized = await canViewVideoMedia(db, master, viewerId);
  const authorizeMs = since(authorizeStarted);
  if (!authorized) return null;
  const name = match[2];
  if (name === "previews.vtt") {
    // Stream provides time-addressed thumbnails. This small authorized index
    // preserves timeline previews without a separately encoded sprite inventory.
    const stamp = (seconds: number) => new Date(seconds * 1000).toISOString().slice(11, 23);
    let body = "WEBVTT\n\n";
    for (let time = 0; time < row.playback.duration; time += 2) {
      body += `${stamp(time)} --> ${stamp(Math.min(time + 2, row.playback.duration))}\n`;
      body += `/media/${prefix}preview-${time}.jpg#xywh=0,0,160,90\n\n`;
    }
    observe({
      event: "video_media_timing",
      resource: "previews",
      rowsMs,
      authorizeMs,
      providerMs: 0,
      reauthorizeMs: 0,
    });
    return { body, contentType: "text/vtt" };
  }
  const providerStarted = performance.now();
  let result: VideoMedia;
  let resource: VideoMediaTiming["resource"];
  if (name === "captions.vtt") {
    if (!row.playback.captionLanguage) return null;
    resource = "captions";
    result = {
      body: await stream.readCaptions(row.id, row.streamUid, row.playback.captionLanguage),
      contentType: "text/vtt",
    };
  } else {
    const time = match[3] === undefined ? 0 : Number(match[3]);
    if (match[3] !== undefined && (time >= row.playback.duration || time % 2 !== 0)) return null;
    const kind = name === "master.m3u8" ? "manifest" : name === "cover.jpg" ? "cover" : "preview";
    resource = kind;
    // No provider round-trip remains here (issue #405): signing is a binding
    // call against the stored UID, and the invariants that publication already
    // proved gate issuance. The recheck below still re-evaluates visibility.
    result = { url: await stream.signedVideoUrl(row.streamUid, kind, time) };
  }
  const providerMs = since(providerStarted);
  // A provider round-trip must not grant a fresh capability after access changed.
  const reauthorizeStarted = performance.now();
  const reauthorized = await canViewVideoMedia(db, master, viewerId);
  const reauthorizeMs = since(reauthorizeStarted);
  observe({
    event: "video_media_timing",
    resource,
    rowsMs,
    authorizeMs,
    providerMs,
    reauthorizeMs,
  });
  return reauthorized ? result : null;
}
