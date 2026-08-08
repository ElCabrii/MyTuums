import type { Post, SearchTypeahead, SearchUser } from "@/lib/orpc";

/** One row the search dropdown renders, discriminated on `kind`. */
export type SuggestionRow =
  { kind: "user"; user: SearchUser } | { kind: "post"; post: Post } | { kind: "see-all" };

/**
 * The dropdown's rows for a typeahead payload: user rows first, then post
 * rows (each in payload order — the API already ranks users prefix-first,
 * so reordering here would only fight it), then the terminal see-all row.
 * `undefined` — a query that is pending, disabled, or errored — yields
 * nothing, and so does an empty payload: the dropdown renders its
 * no-results line instead of a lone see-all row.
 */
export function suggestionRows(typeahead: SearchTypeahead | undefined): SuggestionRow[] {
  if (!typeahead || (typeahead.users.length === 0 && typeahead.posts.length === 0)) {
    return [];
  }
  return [
    ...typeahead.users.map((user): SuggestionRow => ({ kind: "user", user })),
    ...typeahead.posts.map((post): SuggestionRow => ({ kind: "post", post })),
    { kind: "see-all" },
  ];
}

/**
 * Moves the highlighted row by `delta` (ArrowDown +1, ArrowUp -1), clamped to
 * `[-1, length - 1]` and never wrapping: Escape already closes the dropdown,
 * so wrapping the highlight around would buy nothing and only land it on the
 * wrong side of the screen. -1 means "nothing highlighted", and an empty row
 * list stays there.
 */
export function nextHighlight(current: number, delta: number, length: number): number {
  return Math.min(Math.max(current + delta, -1), length - 1);
}
