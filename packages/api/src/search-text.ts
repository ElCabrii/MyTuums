import { sql, type SQLWrapper } from "drizzle-orm";
import { SEARCH_FOLDING } from "./search-folding.generated.js";

const dictionary = JSON.stringify(Object.fromEntries(SEARCH_FOLDING));

/** Handles remain ASCII; fold the query without wrapping the indexed column. */
export const foldHandleQuery = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

export function matchesUsernamePrefix(column: SQLWrapper, query: string) {
  const prefix = foldHandleQuery(query);
  return sql`${column} >= ${prefix} and ${column} < ${`${prefix}\uffff`}`;
}

/**
 * PostgreSQL accent folding and Unicode simple case matching, with literal
 * substring semantics. ASCII text takes the inexpensive lower() path. Other
 * text is folded one code point at a time using a bound, versioned dictionary;
 * replacements cannot cascade or reinterpret wildcard characters. SQL still
 * applies visibility and keyset limits after matching, with no asynchronous index.
 */
export function containsText(column: SQLWrapper, query: string) {
  const needle = Array.from(
    query,
    (character) =>
      SEARCH_FOLDING.get(character) ??
      character.replace(/[A-Z]/g, (letter) => letter.toLowerCase()),
  ).join("");
  const normalized = sql`case when ${column} not glob '*[^ -~]*' then lower(${column}) else (
    with recursive search_fold(remaining, folded) as (
      select lower(${column}), ''
      union all
      select substr(remaining, 2), folded || case when unicode(remaining) < 128
        then substr(remaining, 1, 1) else coalesce(
          json_extract(${dictionary}, '$.' || substr(remaining, 1, 1)), substr(remaining, 1, 1)) end
      from search_fold where remaining <> ''
    ) select folded from search_fold where remaining = '' limit 1
  ) end`;
  return sql`instr(${normalized}, ${needle}) > 0`;
}
