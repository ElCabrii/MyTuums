/**
 * The action bar's "quote this post" glyph (issue #276): a post card with a
 * second card peeking out behind it — the X/Bluesky quote-post convention,
 * and a miniature of how the quoted post actually embeds inside the card.
 * Hand-drawn rather than lucide because the stock `Quote` glyph is two
 * near-full-bleed "comma" marks whose ~2-unit counters collapse into a blob
 * at the action bar's 16 px stroke rendering; both cards here keep counters
 * of 8+ units on the 24-unit grid. The back card omits the edges the front
 * card covers — the lucide `Copy` idiom for overlapping pages — and the
 * stroke attributes mirror the lucide defaults so it sits next to
 * `MessageCircle` and `Repeat2`, and so the action bar can retune
 * `stroke-width` through className or props like any lucide icon.
 */
import type { SVGProps } from "react";

export function QuotePostIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <path d="M10 8V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1" />
      <rect x="3" y="8" width="15" height="12" rx="2" />
    </svg>
  );
}
