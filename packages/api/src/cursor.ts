import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { CURSOR_ID_MAX_LENGTH, CURSOR_MAX_ENCODED_LENGTH } from "./constants.js";

/**
 * Opaque keyset pagination cursors.
 *
 * Every paginated list in this package is keyed on `(created_at, id) DESC`
 * rather than OFFSET: with OFFSET, a row inserted while someone is scrolling
 * shifts every later row down by one and the reader sees a duplicate. The id
 * is in the key only to break ties between rows sharing a timestamp, so the
 * ordering is total and no row can be skipped or repeated.
 *
 * The cursor is encoded rather than exposed as `{ createdAt, id }` so callers
 * treat it as opaque and we stay free to change the key later.
 *
 * The id half is parameterised because the tie-breaker's type varies by table:
 * `post.id` is a uuid, while a `follow` row has no id of its own and breaks
 * ties on the other party's `user.id`, which is BetterAuth's text format. A
 * codec built for one will reject the other's cursors as malformed, which is
 * the intent — a cursor from one feed is meaningless in another.
 */
/** The codec `createCursorCodec` returns — what `keysetPage` in ./pagination.ts takes. */
export type CursorCodec = ReturnType<typeof createCursorCodec>;

interface DecodedCursor {
  createdAt: Date;
  id: string;
}

/**
 * Whether `raw` is a canonical base64url encoding of its own bytes.
 *
 * `Buffer.from(raw, "base64url")` is lenient — it silently drops characters
 * outside the alphabet, which means almost any string decodes to *some*
 * bytes, and a caller could pad or interleave junk that the encoder would
 * never produce. Re-encoding the decoded bytes must reproduce the input
 * exactly, or the cursor is malformed. This also rejects `=` padding,
 * whitespace and the `+`/`/` of ordinary base64 in one comparison.
 */
function isCanonicalBase64Url(raw: string): boolean {
  return Buffer.from(raw, "base64url").toString("base64url") === raw;
}

/** The shared malformed-cursor refusal and payload validation every decode starts with. */
function decodeCursorPayload<T>(raw: string, schema: z.ZodType<T>): T {
  if (raw.length > CURSOR_MAX_ENCODED_LENGTH || !isCanonicalBase64Url(raw)) {
    throw new ORPCError("BAD_REQUEST", { message: "Malformed pagination cursor." });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Malformed pagination cursor." });
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new ORPCError("BAD_REQUEST", { message: "Malformed pagination cursor." });
  }

  return result.data;
}

export function createCursorCodec(idSchema: z.ZodType<string>) {
  const payloadSchema = z.object({
    createdAt: z.iso.datetime(),
    id: z.intersection(idSchema, z.string().max(CURSOR_ID_MAX_LENGTH)),
  });

  return {
    encode(createdAt: Date, id: string): string {
      return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString(
        "base64url",
      );
    },

    decode(raw: string): DecodedCursor {
      const data = decodeCursorPayload(raw, payloadSchema);
      return { createdAt: new Date(data.createdAt), id: data.id };
    },
  };
}

interface DecodedEventCursor {
  createdAt: Date;
  /** The tie-breaker's leading id — the post the event is about. */
  first: string;
  /** The second id when the keyset's tie-breaker is a pair. */
  second: string | undefined;
}

/**
 * A cursor codec for the one list whose tie-breaker is a PAIR of ids rather
 * than one: the merged post/repost home feed (issue #261). The same post can
 * be two events — authored once, reposted by someone once — so naming the
 * stopping point needs both the post id and, for a repost event, the
 * reposter's id. `second` is absent for authored-post events, and the feed's
 * SQL comparison binds that absence as the empty string (the smallest value),
 * keeping the row-value comparison a total order.
 *
 * The `first` half stays parameterised for the same reason `id` is above: a
 * uuid here refuses a cursor minted over a text-id list and vice versa.
 */
export function createEventCursorCodec(firstSchema: z.ZodType<string>) {
  const payloadSchema = z.object({
    createdAt: z.iso.datetime(),
    first: z.intersection(firstSchema, z.string().max(CURSOR_ID_MAX_LENGTH)),
    second: z.string().min(1).max(CURSOR_ID_MAX_LENGTH).optional(),
  });

  return {
    encode(createdAt: Date, first: string, second: string | undefined): string {
      // Two literals rather than a conditional property, so inference keeps
      // the exact payload shape — no annotation to widen or drift from it.
      const payload =
        second === undefined
          ? { createdAt: createdAt.toISOString(), first }
          : { createdAt: createdAt.toISOString(), first, second };
      return Buffer.from(JSON.stringify(payload)).toString("base64url");
    },

    decode(raw: string): DecodedEventCursor {
      const data = decodeCursorPayload(raw, payloadSchema);
      return {
        createdAt: new Date(data.createdAt),
        first: data.first,
        second: data.second,
      };
    },
  };
}

/** The sort keys `game.list` orders its catalog by (see ./games.ts). */
export type GameSort = "popularity" | "name" | "year" | "favorites" | "upcoming";

/**
 * A decoded `game.list` cursor: the sort it was minted under, that sort's key
 * value, and the `igdb_id` tie-breaker.
 *
 * The games list is the first in this package whose keyset is not
 * `(created_at, id)` DESC: the catalog's three sorts key on rank, name and
 * release year, each with its own column type and nullability — so the
 * cursor carries the sort's own key rather than a timestamp, and `decode`
 * takes the sort the CALLER is listing under: a cursor minted by one sort is
 * meaningless in another and is refused as malformed, the same
 * one-list-one-cursor intent as every codec above.
 */
export interface DecodedGameCursor {
  sort: GameSort;
  /** `popularity` → the rank, `name` → the name, `year` → the year. */
  key: number | string | null;
  igdbId: number;
}

const gameCursorPayload = z.discriminatedUnion("sort", [
  z.object({
    sort: z.literal("popularity"),
    rank: z.number().int().nullable(),
    igdbId: z.number().int(),
  }),
  z.object({ sort: z.literal("name"), name: z.string().min(1).max(300), igdbId: z.number().int() }),
  z.object({
    sort: z.literal("year"),
    year: z.number().int().nullable(),
    igdbId: z.number().int(),
  }),
  // The favorites sort's key is never null — `favorite_count` defaults 0.
  z.object({
    sort: z.literal("favorites"),
    count: z.number().int().min(0),
    igdbId: z.number().int(),
  }),
  // The upcoming sort's key is never null either — `hype_count` defaults 0,
  // and the unreleased filter (see ./games.ts) lives in the WHERE, not the key.
  z.object({
    sort: z.literal("upcoming"),
    hypes: z.number().int().min(0),
    igdbId: z.number().int(),
  }),
]);

/**
 * The cursor codec for `game.list` — see `DecodedGameCursor` for why this
 * one departs from the `(createdAt, id)` shape every other codec shares.
 */
export function createGameCursorCodec() {
  return {
    encode(sort: GameSort, key: number | string | null, igdbId: number): string {
      // SAFETY: the key's type is the one `keyOf` of THIS sort produced —
      // the caller is `gameKeysetPage`, which pairs each sort with its own
      // `keyOf`, and `decode` validates the payload against the same
      // discriminated union below on the way back out.
      const payload =
        sort === "popularity"
          ? { sort, rank: key as number | null, igdbId }
          : sort === "name"
            ? { sort, name: key as string, igdbId }
            : sort === "favorites"
              ? { sort, count: key as number, igdbId }
              : sort === "upcoming"
                ? { sort, hypes: key as number, igdbId }
                : { sort, year: key as number | null, igdbId };
      return Buffer.from(JSON.stringify(payload)).toString("base64url");
    },

    decode(raw: string, sort: GameSort): DecodedGameCursor {
      const data = decodeCursorPayload(raw, gameCursorPayload);
      if (data.sort !== sort) {
        throw new ORPCError("BAD_REQUEST", { message: "Malformed pagination cursor." });
      }
      return {
        sort,
        key:
          data.sort === "name"
            ? data.name
            : data.sort === "popularity"
              ? data.rank
              : data.sort === "favorites"
                ? data.count
                : data.sort === "upcoming"
                  ? data.hypes
                  : data.year,
        igdbId: data.igdbId,
      };
    },
  };
}
