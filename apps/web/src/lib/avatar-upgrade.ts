import { IMAGE_LIMITS } from "@my-tuums/api/constants";

/**
 * Detecting a display variant that predates the current avatar ceiling.
 *
 * Profile media persist no dimensions anywhere — the row stores only relative
 * `/media/<key>` paths, the crop is baked into the display object's pixels
 * (there is deliberately no crop column), and the width/height columns that do
 * exist belong to post attachments. So the only signal is the display object
 * itself, measured in the browser: an avatar uploaded before the ceiling was
 * raised (issue #233) is at most the old 512 px, while anything re-encoded
 * today reaches `IMAGE_LIMITS.avatar.maxWidth`.
 *
 * The threshold is read off the live limit rather than hard-coded so the
 * detector follows the next ceiling raise without a second edit. It is a
 * comparison against what a fresh encode would produce, not a birth date:
 * an avatar whose *source* was smaller than the ceiling also encodes below it
 * and will be offered a re-crop that changes nothing. That false positive is
 * accepted — the person is always free to dismiss, and the alternative is a
 * birth date the schema does not have.
 */

/** True when a measured display variant is smaller than today's ceiling can produce. */
export function isBelowAvatarDisplayCeiling(width: number | null): boolean {
  return width !== null && width < IMAGE_LIMITS.avatar.maxWidth;
}

/**
 * The rendered width of an image URL, or `null` when it cannot be measured.
 *
 * Uses a detached `Image` rather than the already-rendered avatar so the
 * detector owns its lifecycle and profile surfaces that render no `<img>`
 * (a broken avatar fallen back to initials, say) can still be measured. The
 * display redirect is cached `private, max-age=…` (see the retrieval rule in
 * `docs/architecture.md`), so this rides the browser cache the profile page
 * just warmed.
 */
export function measureImageWidth(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}
