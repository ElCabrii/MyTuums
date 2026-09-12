import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@my-tuums/db";
import { video } from "@my-tuums/db/schema";
import { canViewPostMedia } from "./post-media.js";
import type { StreamService } from "./stream.js";

export type VideoMedia = { url: string } | { body: string; contentType: string };
const uuid = z.uuid();

/**
 * Token issuance and every thumbnail/caption request use the ordinary post
 * authorizer. Direct Stream playback is a bearer capability valid for one hour;
 * subsequent segments do not pass through Access or the application again.
 */
export async function resolveVideoMedia(
  db: Database,
  stream: Pick<StreamService, "signedVideoUrl" | "readCaptions"> | null,
  key: string,
  viewerId: string | null,
): Promise<VideoMedia | null> {
  if (!stream) return null;
  const match =
    /^videos\/([0-9a-f-]{36})\/(master\.m3u8|cover\.jpg|previews\.vtt|captions\.vtt|preview-(0|[1-9]\d{0,2})\.jpg)$/.exec(
      key,
    );
  if (!match?.[1] || !uuid.safeParse(match[1]).success) return null;
  const [row] = await db
    .select()
    .from(video)
    .where(and(eq(video.id, match[1]), eq(video.state, "published")));
  if (!row?.streamUid || !row.playback || !row.postId) return null;
  const prefix = `videos/${row.id}/`;
  const master = `${prefix}master.m3u8`;
  if (!(await canViewPostMedia(db, master, viewerId))) return null;
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
    return { body, contentType: "text/vtt" };
  }
  let result: VideoMedia;
  if (name === "captions.vtt") {
    if (!row.playback.captionLanguage) return null;
    result = {
      body: await stream.readCaptions(row.id, row.streamUid, row.playback.captionLanguage),
      contentType: "text/vtt",
    };
  } else {
    const time = match[3] === undefined ? 0 : Number(match[3]);
    if (match[3] !== undefined && (time >= row.playback.duration || time % 2 !== 0)) return null;
    result = {
      url: await stream.signedVideoUrl(
        row.id,
        row.streamUid,
        name === "master.m3u8" ? "manifest" : name === "cover.jpg" ? "cover" : "preview",
        time,
      ),
    };
  }
  // A provider round-trip must not grant a fresh capability after access changed.
  return (await canViewPostMedia(db, master, viewerId)) ? result : null;
}
