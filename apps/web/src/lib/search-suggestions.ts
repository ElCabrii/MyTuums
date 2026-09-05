import type { SearchTypeahead, TypeaheadGame } from "@/lib/orpc";

/** One row the search dropdown renders, discriminated on `kind`. */
export type SuggestionRow =
  | { kind: "user"; user: SearchTypeahead["users"][number] }
  | { kind: "game"; game: TypeaheadGame }
  | { kind: "see-all" };

/**
 * The dropdown's rows for a typeahead payload: profiles in the API's ranked
 * order, then games in popularity order, then the terminal see-all row.
 * `undefined` — a query that is pending, disabled, or errored — yields
 * nothing, and so does an empty payload: the dropdown renders its
 * no-results line instead of a lone see-all row.
 */
export function suggestionRows(typeahead: SearchTypeahead | undefined): SuggestionRow[] {
  if (!typeahead || (typeahead.users.length === 0 && typeahead.games.length === 0)) {
    return [];
  }
  return [
    ...typeahead.users.map((user): SuggestionRow => ({ kind: "user", user })),
    ...typeahead.games.map((game): SuggestionRow => ({ kind: "game", game })),
    { kind: "see-all" },
  ];
}

/**
 * Moves the highlighted row by `delta` (ArrowDown +1, ArrowUp -1), wrapping
 * from the final row to the first and vice versa. From no highlight, Down
 * starts at the first row and Up starts at the last. -1 means "nothing
 * highlighted", and an empty row list stays there.
 */
export function nextHighlight(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (current + delta + length) % length;
}
