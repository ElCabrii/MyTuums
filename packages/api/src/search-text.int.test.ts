import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "./testing/runtime.js";
import { containsText, matchesUsernamePrefix } from "./search-text.js";

it.each([
  ["ÉCOLE", "é", true],
  ["école", "ÉCOLE", true],
  ["école", "ecole", true],
  ["ДМИТРИЙ", "дм", true],
  ["ΟΣ", "ος", true],
  ["ος", "ΟΣ", true],
  ["Straẞe", "straße", true],
  ["straße", "STRASSE", true],
  ["Søren café Æsir", "soren cafe aesir", true],
  ["cafe\u0301", "café", true],
  ['Café "été" [2026].', 'cafe "ete" [2026].', true],
  ["東京 🐈", "京 🐈", true],
  ["𐐀", "𐐨", true],
  ["50%_off\\", "%_off\\", true],
  ["50X_off\\", "%_off\\", false],
  ["x[*?]y", "[*?]", true],
  ["xanythingy", "*?", false],
  ["x[a-z]y", "[a-z]", true],
  ["xay", "[a-z]", false],
  ["x]y", "]", true],
  ["x^y", "^", true],
  ["anything", "x' OR 1=1 --", false],
  ["needle", "needle\0suffix", false],
  ["needle]", "needle\0]", false],
] as const)("D1 text %j with literal query %j matches %s", async (text, query, expected) => {
  const rows = await db.all<{ matches: number }>(
    sql`select ${containsText(sql`${text}`, query)} as matches`,
  );
  expect(Boolean(rows[0].matches)).toBe(expected);
});

it("handles use a literal lowercase prefix, with no substring or wildcard expansion", async () => {
  const rows = await db.all<{ matching: number; wildcard: number; substring: number }>(sql`
    select (${matchesUsernamePrefix(sql`'al_user'`, "AL_")}) as matching,
      (${matchesUsernamePrefix(sql`'alice'`, "AL_")}) as wildcard, (${matchesUsernamePrefix(sql`'xxal_user'`, "AL_")}) as substring`);
  expect(rows[0]).toEqual({ matching: 1, wildcard: 0, substring: 0 });
});
