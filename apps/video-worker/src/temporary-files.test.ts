import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cleanTemporaryVideoFiles } from "./temporary-files.js";

it("reclaims crash leftovers without deleting live or unrelated directories (issue #368)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "video-cleanup-test-"));
  try {
    for (const name of ["source-stale", "mytuums-video-stale", "source-live", "unrelated"])
      await mkdir(join(directory, name));
    await writeFile(join(directory, "source-stale", "source"), "private source");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const name of ["source-stale", "mytuums-video-stale", "unrelated"])
      await utimes(join(directory, name), old, old);
    expect(await cleanTemporaryVideoFiles(directory)).toBe(2);
    expect((await readdir(directory)).sort()).toEqual(["source-live", "unrelated"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
