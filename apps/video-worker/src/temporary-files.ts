import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { VIDEO_PROCESS_TIMEOUT_SECONDS } from "@my-tuums/api/video-worker";

/** A dedicated worker directory only; never sweep the system temporary directory. */
export async function cleanTemporaryVideoFiles(directory: string): Promise<number> {
  // Jobs have a 30-minute deadline. Two deadlines leave room for shutdown and
  // avoid touching another live consumer's files after a process restart.
  const cutoff = Date.now() - VIDEO_PROCESS_TIMEOUT_SECONDS * 2 * 1000;
  let removed = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(?:source-|mytuums-video-)[A-Za-z0-9]+$/.test(entry.name))
      continue;
    const path = join(directory, entry.name);
    const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info || info.mtimeMs >= cutoff) continue;
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
