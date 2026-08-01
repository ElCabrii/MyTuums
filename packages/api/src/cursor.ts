import { ORPCError } from "@orpc/server";
import { z } from "zod";

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
export function createCursorCodec(idSchema: z.ZodType<string>) {
  const payloadSchema = z.object({
    createdAt: z.iso.datetime(),
    id: idSchema,
  });

  return {
    encode(createdAt: Date, id: string): string {
      return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString(
        "base64url",
      );
    },

    decode(raw: string): { createdAt: Date; id: string } {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      } catch {
        throw new ORPCError("BAD_REQUEST", { message: "Malformed pagination cursor." });
      }

      const result = payloadSchema.safeParse(parsed);
      if (!result.success) {
        throw new ORPCError("BAD_REQUEST", { message: "Malformed pagination cursor." });
      }

      return { createdAt: new Date(result.data.createdAt), id: result.data.id };
    },
  };
}
