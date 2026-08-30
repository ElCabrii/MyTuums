import { BANNER_ASPECT_RATIO } from "@my-tuums/api/constants";

/**
 * How the canonical 3:1 banner is *displayed*, in one place.
 *
 * Every banner display variant encodes at exactly 3:1, and the profile banner
 * renders that composition with its height clamped:
 *
 * - taller than `BANNER_FRAME_MIN_HEIGHT` never — on a narrow phone a strict
 *   3:1 would be a ~125px strip the avatar swallows, so the frame holds a
 *   150px band (about X's mobile header height) and trims the encoded image's
 *   sides instead;
 * - shorter than `BANNER_FRAME_MAX_HEIGHT` never — on a wide monitor a
 *   full-bleed 3:1 would be a 400–850px slab, so past the 1500px content
 *   measure the frame stops growing and trims top and bottom instead.
 *
 * Between those widths (roughly 450–960px, i.e. most phones landscape, tablets
 * and laptops) the frame is exactly 3:1 and shows the whole encoded
 * composition. The extremes trim bounded, opposite edges — never a re-chosen
 * crop — and `BANNER_SAFE_AREA` is the region that survives on every viewport,
 * which the crop editor draws as its safe-area outline.
 */

/** The floor for the profile banner frame's height, in CSS pixels. */
export const BANNER_FRAME_MIN_HEIGHT = 150;

/** The ceiling for the profile banner frame's height, in CSS pixels. */
export const BANNER_FRAME_MAX_HEIGHT = 320;

/** The content measure the profile banner frame's width stops at, in CSS pixels. */
export const BANNER_FRAME_MAX_WIDTH = 1500;

/** The narrowest viewport the safe area is defined against (a small phone). */
const NARROWEST_VIEWPORT = 320;

/**
 * The fraction of the encoded banner every profile frame still shows, as
 * multiples of the encoded image's own width/height (0..1, centered).
 *
 * Width: the narrowest frame is `NARROWEST_VIEWPORT` × `BANNER_FRAME_MIN_HEIGHT`,
 * whose aspect over the encoded 3:1 leaves that fraction of the width visible.
 * Height: the widest frame is `BANNER_FRAME_MAX_WIDTH` × `BANNER_FRAME_MAX_HEIGHT`,
 * so that fraction of the encoded height — 320 of a 1500/3 = 500px image —
 * survives. Both bounds are what the values above produce; keep them derived,
 * not restated, so the outline and the frame cannot drift apart.
 */
export const BANNER_SAFE_AREA = {
  width: NARROWEST_VIEWPORT / BANNER_FRAME_MIN_HEIGHT / BANNER_ASPECT_RATIO,
  height: BANNER_FRAME_MAX_HEIGHT / (BANNER_FRAME_MAX_WIDTH / BANNER_ASPECT_RATIO),
} as const;
