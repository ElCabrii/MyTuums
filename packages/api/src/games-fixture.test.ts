import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bareHashtagKey } from "./games-hashtag.js";
import { stagedGameFixtureSchema } from "./games-sync.js";

/**
 * The fixture's own contract (issue Q27): the file is hand-authored data
 * with no generator to keep it honest, so this suite is the guard — a
 * hand-edit that breaks the catalog's invariants fails here, at the source,
 * instead of surfacing as a confusing e2e failure or a bad dev page. Shape
 * is the seeder's schema; these tests pin the semantics on top of it.
 */

const FIXTURE_DIR = fileURLToPath(new URL("../../db/fixtures", import.meta.url));

const FIXTURE = stagedGameFixtureSchema
  .array()
  .parse(JSON.parse(readFileSync(join(FIXTURE_DIR, "games.json"), "utf8")));

describe("packages/db/fixtures/games.json", () => {
  it("is the size the issue asked for, with unique ids, unique keys and dense ranks", () => {
    expect(FIXTURE.length).toBeGreaterThanOrEqual(20);
    expect(new Set(FIXTURE.map((game) => game.igdbId)).size).toBe(FIXTURE.length);
    expect(new Set(FIXTURE.map((game) => game.hashtagKey)).size).toBe(FIXTURE.length);
    const ranks = FIXTURE.map((game) => game.popularityRank).filter(
      (rank): rank is number => rank !== null,
    );
    expect(ranks).toHaveLength(FIXTURE.length); // every game ranked, densely
    expect([...ranks].sort((a, b) => a - b)).toEqual(
      Array.from({ length: FIXTURE.length }, (_, index) => index + 1),
    );
  });

  it("carries the documented edge cases: the DOOM collision pair, punctuation, a very long name, and exactly one game each missing a cover and a summary", () => {
    for (const game of FIXTURE) {
      expect(game.hashtagKey).toMatch(/^[a-z0-9]+$/);
    }

    const doom = FIXTURE.filter((game) => game.name === "DOOM");
    expect(doom.map((game) => game.hashtagKey).sort()).toEqual(["doom", "doom2016"]);
    expect(doom.map((game) => game.firstReleaseYear).sort()).toEqual([1993, 2016]);

    // Punctuation-heavy names strip to their alphanumeric bones.
    const bg3 = FIXTURE.find((game) => game.name === "Baldur's Gate 3");
    expect(bg3?.hashtagKey).toBe("baldursgate3");
    expect(
      FIXTURE.some(
        (game) => game.name === "FINAL FANTASY VII" && game.hashtagKey === "finalfantasyvii",
      ),
    ).toBe(true);

    // The longest name this catalog expects to render, and its key.
    expect(
      FIXTURE.some(
        (game) => game.name.length > 40 && game.hashtagKey === bareHashtagKey(game.name),
      ),
    ).toBe(true);

    expect(FIXTURE.filter((game) => game.coverImageId === null)).toHaveLength(1);
    expect(FIXTURE.filter((game) => game.summary === null)).toHaveLength(1);
  });

  it("keys are the stripped lowercase names, except the one deliberate collision suffix", () => {
    const keyedByDerivation = FIXTURE.filter((game) => game.hashtagKey !== "doom2016");
    for (const game of keyedByDerivation) {
      expect(game.hashtagKey).toBe(bareHashtagKey(game.name));
    }
  });

  it("every referenced cover exists in the fixture directory and is a real JPEG", () => {
    const stems = new Set(
      FIXTURE.map((game) => game.coverImageId).filter((id): id is string => id !== null),
    );
    expect(stems.size).toBeGreaterThan(1);
    for (const stem of stems) {
      const path = join(FIXTURE_DIR, "covers", `${stem}.jpg`);
      expect(existsSync(path), `${stem}.jpg exists`).toBe(true);
      const bytes = new Uint8Array(readFileSync(path));
      expect([bytes[0], bytes[1], bytes[2]], `${stem}.jpg is a JPEG`).toEqual([0xff, 0xd8, 0xff]);
    }
  });
});
