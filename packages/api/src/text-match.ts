import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * The text-matching primitives user search (./search.ts) and game search
 * (./games.ts) share. `search.ts` already imports the game matcher, so the
 * helpers cannot live there without a cycle — and unlike the mechanical
 * three-line `escapeLikePattern` duplicate these fragments replaced, they are
 * one SQL contract with the `search_unaccent` database function
 * (migration `0039_search_unaccent`), which must not drift between the two
 * surfaces that render "this is the thing you typed".
 */

/**
 * Escapes the LIKE metacharacters in a search query so the caller's `%`, `_`
 * and `\` match literally instead of acting as pattern wildcards.
 *
 * `\` is escaped FIRST because it is LIKE's own escape character: replacing
 * it first means the backslashes this function adds for `%`/`_` are not
 * themselves escaped again, and a user-supplied backslash that preceded a
 * wildcard stays a single literal backslash ahead of the now-literal wildcard.
 * Everything else — including multi-byte text — passes through untouched.
 */
export function escapeLikePattern(pattern: string): string {
  return pattern.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Strips diacritics from a query in JS — "poké" becomes "poke".
 *
 * Only for patterns matched against columns that cannot carry accents in the
 * first place (the ASCII-only, pre-lowercased `username`): folding the
 * pattern in JS keeps it a bound literal, which is what lets the
 * left-anchored `like` keep using the username btree index. Columns that do
 * carry accents fold through `search_unaccent` in SQL instead — see
 * {@link unaccentedContains} — because only the database's dictionary folds
 * characters like `ø` that NFD leaves composed.
 */
export const foldAccents = (value: string): string =>
  value.normalize("NFD").replace(/\p{Diacritic}/gu, "");

/**
 * A case-insensitive, accent-insensitive substring match: both the column and
 * the escaped `%query%` pattern fold through `search_unaccent`, so typing
 * "pokemon" finds "Pokémon" and typing "cafe" finds "café".
 *
 * The pattern folds in SQL rather than JS so both sides of the comparison run
 * the same dictionary. The substring scan these feed was already a seq scan
 * by design (see ./search.ts); the immutable wrapper keeps a future
 * expression index over `search_unaccent(col)` possible.
 */
export function unaccentedContains(column: SQLWrapper, q: string): SQL {
  const pattern = `%${escapeLikePattern(q)}%`;
  return sql`search_unaccent(${column}) ilike search_unaccent(${pattern})`;
}
