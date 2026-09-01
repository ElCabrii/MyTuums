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
 * crop.
 */

/** The floor for the profile banner frame's height, in CSS pixels. */
export const BANNER_FRAME_MIN_HEIGHT = 150;

/** The ceiling for the profile banner frame's height, in CSS pixels. */
export const BANNER_FRAME_MAX_HEIGHT = 320;

/** The content measure the profile banner frame's width stops at, in CSS pixels. */
export const BANNER_FRAME_MAX_WIDTH = 1500;
