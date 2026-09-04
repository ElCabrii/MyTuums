/**
 * Hashtag-key derivation for the game catalog (issue #314, Q15) — pure, and
 * the ONLY definition: the sync is the sole writer of new keys, so this needs
 * no browser-safe twin.
 *
 * A key is the game's name lowercased with every `[^a-z0-9]` stripped
 * (`FINAL FANTASY VII` → `finalfantasyvii`, `Baldur's Gate 3` →
 * `baldursgate3` — digits and Roman numerals untouched by design). Keys must
 * stay alphanumeric because the client's hashtag tokenizer treats exactly
 * `[a-zA-Z0-9_]` as a tag word (apps/web `linked-text.tsx`): a hyphen or
 * accent would split the very tag the key is meant to resolve.
 *
 * ## Stickiness
 *
 * The issue asks for keys "recomputed every sync" (Q15) while collision
 * assignments "stay permanently stable" (Q29) — and pure recomputation
 * cannot deliver stability when membership changes: a newly synced game with
 * a lower IGDB id would steal `#doom` from the 1993 incumbent. The reading
 * that satisfies both clauses: **derivation runs every sync, but existing
 * assignments are inputs to it, never outputs.** `occupied` carries every
 * key the current rows hold; a new game never displaces an incumbent, and
 * once written (the sync's upsert omits `hashtag_key` from its `set`
 * clause) a key is never rewritten.
 *
 * ## Collisions
 *
 * When a bare key is taken, the candidate walks a deterministic fallback
 * ladder — release year first (the issue's own example: `#doom` and
 * `#doom2016`), then the IGDB id when the year is missing, then year+id for
 * the collision-of-the-collision. Every rung is alphanumeric, every choice
 * depends only on (igdbId, name, year, occupied), so the same inputs always
 * produce the same assignment.
 */

/** The bare resolution key of a name: lowercase, everything non-alphanumeric stripped. */
export function bareHashtagKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A game the sync has no key for yet — the inputs to assignment. */
export interface HashtagCandidate {
  igdbId: number;
  name: string;
  firstReleaseYear: number | null;
}

/**
 * A game (or set of games) that cannot receive a hashtag key — a name that
 * strips to the empty string (punctuation only, or empty), or one whose every
 * fallback spelling is already taken by an unrelated incumbent. Treated as a
 * validation failure by the sync (fail-closed, Q28): a catalog row nobody
 * could ever link a hashtag to is a broken row.
 */
export class HashtagAssignmentError extends Error {
  readonly failures: readonly string[];

  constructor(failures: readonly string[]) {
    super(`Games that cannot receive a unique hashtag key: ${failures.join("; ")}`);
    this.name = "HashtagAssignmentError";
    this.failures = failures;
  }
}

/**
 * Assigns a key to every candidate that does not already hold one, without
 * touching `occupied`. Returns only the NEW assignments (igdbId → key).
 *
 * Candidates are processed in ascending IGDB-id order regardless of input
 * order, which is what makes "the lowest-IGDB-id game keeps the bare key"
 * (Q15) fall out of the free-first-come rule deterministically.
 */
export function assignHashtagKeys(
  candidates: readonly HashtagCandidate[],
  occupied: ReadonlySet<string>,
): Map<number, string> {
  const sorted = [...candidates].sort((a, b) => a.igdbId - b.igdbId);
  const assignments = new Map<number, string>();

  const taken = new Set<string>(occupied);
  const failures: string[] = [];

  for (const candidate of sorted) {
    const bare = bareHashtagKey(candidate.name);
    if (bare === "") {
      failures.push(
        `${JSON.stringify(candidate.name)} (igdb ${candidate.igdbId}) strips to the empty key`,
      );
      continue;
    }

    // The fallback ladder, first free rung wins: bare, bare+year (the
    // issue's own `#doom` / `#doom2016` pair), then bare+year+id. A missing
    // year substitutes the id directly — `${bare}${igdbId}` — so the last
    // rung always embeds this candidate's unique id and cannot collide with
    // another candidate's rung. The one residual way every rung can be taken
    // is an unrelated incumbent holding the exact literal spelling (a game
    // actually named "Doom 50" occupying `doom50`); that is a genuine
    // ambiguity, reported as a failure rather than resolved by inventing a
    // spelling no tokenizer rule would explain.
    const { firstReleaseYear: year, igdbId } = candidate;
    const rungs =
      year === null
        ? [bare, `${bare}${igdbId}`]
        : [bare, `${bare}${year}`, `${bare}${year}${igdbId}`];

    const key = rungs.find((rung) => !taken.has(rung));
    if (key === undefined) {
      failures.push(
        `${JSON.stringify(candidate.name)} (igdb ${igdbId}) has every fallback key taken: ${rungs.join(", ")}`,
      );
      continue;
    }
    assignments.set(igdbId, key);
    taken.add(key);
  }

  if (failures.length > 0) throw new HashtagAssignmentError(failures);

  return assignments;
}
