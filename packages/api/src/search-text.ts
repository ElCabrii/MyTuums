import { sql, type SQLWrapper } from "drizzle-orm";
import { SIMPLE_CASE_GROUPS } from "./unicode-case-folding.generated.js";

const caseGroups = new Map<string, readonly string[]>();
for (const source of SIMPLE_CASE_GROUPS) {
  // D1 lower() already converts ASCII. Keep the remaining Unicode equivalents
  // disjoint so each replacement is independent of the others' order.
  const group = [
    ...new Set(
      Array.from(source, (character) =>
        character.codePointAt(0)! < 128 ? character.toLowerCase() : character,
      ),
    ),
  ];
  for (const character of source) caseGroups.set(character, group);
}

/** Canonical handles are ASCII lowercase; a range preserves their prefix index. */
export function matchesUsernamePrefix(column: SQLWrapper, query: string) {
  const prefix = query.toLowerCase();
  return sql`${column} >= ${prefix} and ${column} < ${`${prefix}\uffff`}`;
}

/**
 * Literal, locale-independent Unicode simple-case matching. D1 lower() folds
 * ASCII only, and LIKE/GLOB cap patterns at 50 bytes. INSTR has neither wildcard
 * syntax nor that pattern limit. Convert only the Unicode case groups present
 * in this query, keeping accents and character count significant (ß ≠ SS).
 *
 * Short queries use direct replacements. A bound JSON sequence handles longer
 * alphabets without exceeding SQL expression depth or parameter limits. Both
 * paths run before SQL visibility, ordering and pagination finish the page.
 */
export function containsText(column: SQLWrapper, query: string) {
  const replacements = new Map<string, string>();
  const needle = Array.from(query, (character) => {
    const group = caseGroups.get(character);
    if (!group) return character;
    const [canonical, ...variants] = group;
    for (const variant of variants) replacements.set(variant, canonical);
    return canonical;
  }).join("");
  let normalized = sql`lower(${column})`;
  if (replacements.size <= 8) {
    for (const [from, to] of replacements) normalized = sql`replace(${normalized}, ${from}, ${to})`;
  } else {
    const sequence = JSON.stringify([...replacements]);
    normalized = sql`(with recursive search_fold(folded_text, step) as (
      select lower(${column}), 0
      union all
      select replace(search_fold.folded_text, json_extract(part.value, '$[0]'), json_extract(part.value, '$[1]')),
        search_fold.step + 1
      from search_fold join json_each(${sequence}) as part on part.key = search_fold.step
    ) select folded_text from search_fold order by step desc limit 1)`;
  }
  return sql`instr(${normalized}, ${needle}) > 0`;
}
