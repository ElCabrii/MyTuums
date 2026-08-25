import { describe, expect, it } from "vitest";
import { MEDIA_SIGNING_WINDOW_MS, secondsUntilWindowEnd } from "./storage.js";
import { profileDisplayRedirectCacheControl } from "./profile-media-authorization.js";

const DISPLAY_KEY = "avatars/user-1/11111111-1111-4111-8111-111111111111.webp";
const GIF_DISPLAY_KEY = "avatars/user-1/11111111-1111-4111-8111-111111111111.gif";
const ORIGINAL_KEY = "avatars/user-1/11111111-1111-4111-8111-111111111111.orig.jpg";

describe("profileDisplayRedirectCacheControl", () => {
  it("gives a display object a private, window-bounded directive", () => {
    const directive = profileDisplayRedirectCacheControl(DISPLAY_KEY);
    expect(directive).toMatch(/^private, max-age=\d+$/);
    // Never cache past the signature: the max-age is at most what remains of
    // the current signing window.
    expect(Number(directive!.match(/max-age=(\d+)/)![1])).toBeLessThanOrEqual(
      MEDIA_SIGNING_WINDOW_MS / 1000,
    );
    expect(Number(directive!.match(/max-age=(\d+)/)![1])).toBeLessThanOrEqual(
      secondsUntilWindowEnd(),
    );
  });

  it("never stores an original's redirect — the owner's file stays off shared browsers", () => {
    expect(profileDisplayRedirectCacheControl(ORIGINAL_KEY)).toBeNull();
  });

  it("recognizes a GIF display object as profile media", () => {
    expect(profileDisplayRedirectCacheControl(GIF_DISPLAY_KEY)).toMatch(/^private, max-age=\d+$/);
  });

  it("declines every non-profile key, post attachments included", () => {
    expect(profileDisplayRedirectCacheControl("posts/author-1/post-1/att-1.png")).toBeNull();
    expect(profileDisplayRedirectCacheControl("avatars/../secret.webp")).toBeNull();
  });
});
