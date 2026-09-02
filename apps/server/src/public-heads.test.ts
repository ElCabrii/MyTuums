import type { Database } from "@my-tuums/db";
import { describe, expect, it } from "vitest";
import { createPublicHeadTransform } from "./public-heads.js";

/**
 * The static-route half is pure string surgery over the marker block, so it
 * is pinned here against a realistic head. The post half is pinned at its
 * query (`publicPostHead` in packages/api, imported through the
 * `./public-post-head` subpath precisely so neither this suite nor anything
 * else drags in the database module); here it only has to hold its
 * degrade-on-failure contract — an unfetchable head must leave the document
 * untouched, never serve a broken one.
 */

const FALLBACK_HEAD = [
  '<!doctype html><html lang="en"><head>',
  "<!-- app-head-fallback-start -->",
  "<title data-app-fallback>MyTuums — The social media, for gamers</title>",
  '<meta data-app-fallback name="description" content="The social media, for gamers." />',
  '<meta data-app-fallback property="og:title" content="MyTuums — The social media, for gamers" />',
  "<!-- app-head-fallback-end -->",
  "</head><body></body></html>",
].join("\n");

// SAFETY: the contract under test is the failure branch — an empty double
// makes `publicPostHead`'s first query throw, which the transform's catch
// turns into "leave the document untouched" rather than a broken one.
const unreachableDb = {} as Database;

const transform = createPublicHeadTransform(unreachableDb);

describe("createPublicHeadTransform", () => {
  it("replaces the fallback block for a known static route with route-specific tags", async () => {
    const html = await transform("/login", FALLBACK_HEAD);

    expect(html).toContain("<title data-app-fallback>Log in - MyTuums</title>");
    expect(html).toContain(
      '<link data-app-fallback rel="canonical" href="https://mytuums.com/login" />',
    );
    expect(html).toContain(
      '<meta data-app-fallback property="og:url" content="https://mytuums.com/login" />',
    );
    expect(html).toContain('content="Sign in to MyTuums — the social media, for gamers."');
    // The generic fallback title is gone — one owner per tag.
    expect(html).not.toContain("MyTuums — The social media, for gamers</title>");
  });

  it("leaves an unrecognized route on the generic fallback", async () => {
    // Gated routes never reach a crawler (the page gate 302s them first);
    // anything unlisted here must degrade to the file's own head.
    await expect(transform("/settings/account", FALLBACK_HEAD)).resolves.toBe(FALLBACK_HEAD);
  });

  it("leaves the document untouched when the post head cannot be built", async () => {
    // The unreachable database makes publicPostHead throw; the unfurl
    // degrades to the generic head rather than shipping a broken document.
    await expect(
      transform("/post/0d97ee29-7896-4c53-9161-c54fc1ca1b51", FALLBACK_HEAD),
    ).resolves.toBe(FALLBACK_HEAD);
  });

  it("leaves a build without the markers untouched — never a corrupted document", async () => {
    const unmarked = "<!doctype html><html><head><title>old</title></head></html>";
    await expect(transform("/login", unmarked)).resolves.toBe(unmarked);
  });
});
