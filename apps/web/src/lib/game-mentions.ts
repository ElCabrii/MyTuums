/** One hashtag key → the slug of the game the catalog answers it with. */
export type GameMentions = Readonly<Record<string, string>>;

/**
 * Merges the per-batch hashtag→slug maps a feed's loaded pages carry
 * (issue #314, Q16): a key maps to exactly one slug, so later pages cannot
 * contradict earlier ones, and pages from older caches without the field
 * contribute nothing. One helper because the feed and the search section
 * merge the same shape.
 */
export function mergedGameMentions(
  pages: ReadonlyArray<{ gameMentions?: Record<string, string> }>,
) {
  const merged: Record<string, string> = {};
  for (const page of pages) Object.assign(merged, page.gameMentions);
  return merged;
}
