import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@my-tuums/db";
import { video } from "@my-tuums/db/schema";
import { canViewPostMedia } from "./post-media.js";
import type { Storage } from "./storage.js";
import { videoAttemptPrefix } from "./video-lifecycle.js";

export type VideoMedia = { url: string } | { body: string; contentType: string };
const uuid = z.uuid();

/** Every manifest, segment, cover, preview and caption inherits the post gate. */
export async function resolveVideoMedia(
  db: Database,
  storage: Storage | null,
  key: string,
  viewerId: string | null,
): Promise<VideoMedia | null> {
  if (!storage) return null;
  const match = /^videos\/([0-9a-f-]{36})\/attempts\/([0-9a-f-]{36})\/([a-z0-9_.-]+)$/.exec(key);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  if (!uuid.safeParse(match[1]).success || !uuid.safeParse(match[2]).success) return null;
  const [row] = await db
    .select()
    .from(video)
    .where(
      and(eq(video.id, match[1]), eq(video.attemptId, match[2]), eq(video.state, "published")),
    );
  if (!row?.attemptId) return null;
  const prefix = videoAttemptPrefix(row.id, row.attemptId);
  const asset = row.assets.find((item) => item.name === match[3]);
  if (!asset || !(await canViewPostMedia(db, `${prefix}master.m3u8`, viewerId))) return null;
  if (!asset.name.endsWith(".m3u8") && !asset.name.endsWith(".vtt")) {
    return { url: await storage.signedGetUrl(key) };
  }
  // Only small text assets pass through the API. Large bytes go directly from
  // the private bucket to the player after this request's authorization.
  if (asset.byteSize > 1024 * 1024) return null;
  const object = await storage.get(key);
  if (!object || object.bytes.byteLength !== asset.byteSize) return null;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(object.bytes);
  const names = new Set(row.assets.map((item) => item.name));
  function assetPath(reference: string): string {
    const [filename, fragment] = reference.split("#");
    if (
      !filename ||
      !names.has(filename) ||
      (fragment !== undefined && !/^xywh=\d+,\d+,\d+,\d+$/.test(fragment))
    ) {
      throw new Error("Invalid video asset reference.");
    }
    return `/media/${prefix}${filename}${fragment ? `#${fragment}` : ""}`;
  }
  let body = text;
  if (asset.name.endsWith(".m3u8")) {
    body = text
      .split("\n")
      .map((line) => {
        if (!line) return line;
        return line.startsWith("#")
          ? line.replace(
              /URI="([^"]+)"/g,
              (_match: string, reference: string) => `URI="${assetPath(reference)}"`,
            )
          : assetPath(line);
      })
      .join("\n");
  } else if (asset.name === "previews.vtt") {
    body = text
      .split("\n")
      .map((line) => (line.includes("#xywh=") ? assetPath(line) : line))
      .join("\n");
  }
  return { body, contentType: asset.contentType };
}
