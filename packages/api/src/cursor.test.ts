import { ORPCError } from "@orpc/server";
import { CURSOR_ID_MAX_LENGTH, CURSOR_MAX_ENCODED_LENGTH } from "./constants.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCursorCodec } from "./cursor.js";

const VALID_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function encodeRaw<Payload>(payload: Payload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** Runs `fn`, returns whatever it throws (or fails the test if it doesn't). */
function captureError(fn: () => void): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("expected fn to throw an Error instance", { cause: error });
  }
  throw new Error("expected fn to throw");
}

function expectMalformedCursor(fn: () => void): void {
  const error = captureError(fn);
  expect(error).toBeInstanceOf(ORPCError);
  if (!(error instanceof ORPCError)) throw new Error("expected an ORPCError");
  expect(error.code).toBe("BAD_REQUEST");
  expect(error.message).toBe("Malformed pagination cursor.");
}

describe("createCursorCodec", () => {
  it("round-trips a date and id through encode/decode", () => {
    const codec = createCursorCodec(z.uuid());
    const createdAt = new Date("2026-08-02T12:34:56.000Z");
    const cursor = codec.encode(createdAt, VALID_UUID);
    const decoded = codec.decode(cursor);
    expect(decoded.createdAt).toEqual(createdAt);
    expect(decoded.id).toBe(VALID_UUID);
  });

  it("preserves millisecond precision through the round trip", () => {
    // This is the invariant `precision: 3` on the app tables (see
    // packages/db/CONTEXT.md) exists to protect: a cursor can only ever carry
    // what a JS Date can hold, which is milliseconds. If encode/decode lost
    // or truncated the ms component here, a row stored at finer precision
    // would silently fall out of every subsequent page, the same "skip" the
    // schema comment describes for the DB side.
    const codec = createCursorCodec(z.uuid());
    const createdAt = new Date("2026-08-02T12:34:56.789Z");
    const cursor = codec.encode(createdAt, VALID_UUID);
    const decoded = codec.decode(cursor);
    expect(decoded.createdAt.getTime()).toBe(createdAt.getTime());
  });

  it("encodes as opaque base64url (no +, / or = padding)", () => {
    const codec = createCursorCodec(z.uuid());
    const cursor = codec.encode(new Date(), VALID_UUID);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("enforces the id schema at decode time — a uuid codec rejects a plain string id", () => {
    // encode() doesn't validate the id, only decode()'s payloadSchema does —
    // this is what lets one feed's cursor be rejected as malformed by
    // another's codec instead of silently accepted.
    const uuidCodec = createCursorCodec(z.uuid());
    const stringCodec = createCursorCodec(z.string().min(1));
    const cursor = uuidCodec.encode(new Date(), "not-a-uuid");

    expectMalformedCursor(() => uuidCodec.decode(cursor));
    expect(stringCodec.decode(cursor).id).toBe("not-a-uuid");
  });

  describe("decode: malformed input", () => {
    const codec = createCursorCodec(z.uuid());

    it("throws BAD_REQUEST when base64url-decoded bytes aren't valid JSON", () => {
      // Buffer.from(x, "base64url") is lenient — it decodes almost any
      // string to *some* bytes — so this only fails at JSON.parse.
      expectMalformedCursor(() => codec.decode("!!!not base64!!!"));
    });

    it("throws BAD_REQUEST when valid base64url decodes to non-JSON text", () => {
      expectMalformedCursor(() => codec.decode(Buffer.from("not json").toString("base64url")));
    });

    it("throws BAD_REQUEST when JSON parses but createdAt fails the schema", () => {
      expectMalformedCursor(() => codec.decode(encodeRaw({ createdAt: "nope", id: VALID_UUID })));
    });

    it("throws BAD_REQUEST when JSON parses but id is missing", () => {
      expectMalformedCursor(() => codec.decode(encodeRaw({ createdAt: new Date().toISOString() })));
    });

    it("throws BAD_REQUEST for an offset-bearing timestamp — z.iso.datetime() requires UTC", () => {
      expectMalformedCursor(() =>
        codec.decode(encodeRaw({ createdAt: "2026-08-02T12:00:00+02:00", id: VALID_UUID })),
      );
    });

    it("throws BAD_REQUEST for an oversized cursor — the decode cost is bounded", () => {
      // The cap is generous (a real cursor is a couple of hundred characters);
      // this proves the bound exists at all, so a multi-megabyte cursor query
      // cannot cost a repeated multi-MB decode per request.
      const blob = "a".repeat(CURSOR_MAX_ENCODED_LENGTH + 1);
      expectMalformedCursor(() => codec.decode(blob));
    });

    it("throws BAD_REQUEST for non-canonical base64url, before JSON.parse runs", () => {
      // The encoder emits no `=` padding and no `+`/`/`; base64 with padding
      // and a valid payload inside is still a malformed CURSOR, not a payload
      // detail — re-encoding its bytes must reproduce the input exactly.
      const padded = encodeRaw({ createdAt: new Date().toISOString(), id: VALID_UUID });
      const unpadded = padded.replace(/=+$/, "");
      expect(unpadded.length).toBeGreaterThan(0);
      expectMalformedCursor(() => codec.decode(`${unpadded}=`));
    });

    it("throws BAD_REQUEST for base64 that smuggles non-alphabet characters", () => {
      // `Buffer.from` drops out-of-alphabet characters when decoding; the
      // canonical re-encode catches the interleaved junk that would otherwise
      // silently vanish.
      const payload = encodeRaw({ createdAt: new Date().toISOString(), id: VALID_UUID });
      expectMalformedCursor(() => codec.decode(payload.slice(0, 4) + "!!" + payload.slice(4)));
    });

    it("still accepts an exactly-canonical cursor with no padding", () => {
      // The canonical check must not reject what encode() produces.
      const cursor = codec.encode(new Date(), VALID_UUID);
      expect(codec.decode(cursor).id).toBe(VALID_UUID);
    });

    it("bounds textual ids inside an otherwise small decoded payload", () => {
      const payload = encodeRaw({
        createdAt: new Date().toISOString(),
        id: "x".repeat(CURSOR_ID_MAX_LENGTH + 1),
      });
      expect(payload.length).toBeLessThanOrEqual(CURSOR_MAX_ENCODED_LENGTH);
      expectMalformedCursor(() => codec.decode(payload));
    });
  });
});
