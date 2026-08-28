import { describe, expect, it } from "vitest";
import { bestEncoding } from "./compression.js";

/**
 * The content-negotiation rule itself, at the layer that owns it.
 *
 * Both callers — the static-file handler and the response decorator — used to
 * re-assert "brotli wins a tie" and "q=0 means refused" through their own HTTP
 * paths, which is the same rule spelled twice while `bestEncoding` had no test
 * of its own. Those handler tests keep only what is theirs: that compression
 * is wired in at all, and at which brotli quality.
 */
describe("bestEncoding", () => {
  it("picks the client's best offer, with ties going to brotli", () => {
    const cases: Array<[string | undefined, ReturnType<typeof bestEncoding>]> = [
      // The common browser header: both offered at q=1, brotli wins on text.
      ["gzip, br", "br"],
      ["br, gzip", "br"],
      ["gzip", "gzip"],
      ["br", "br"],
      // A named q-value beats a tie, in either direction.
      ["gzip;q=1.0, br;q=0.5", "gzip"],
      ["gzip;q=0.5, br;q=1.0", "br"],
      // Encodings this server cannot emit are ignored rather than echoed back.
      ["deflate, zstd", null],
      ["deflate, gzip", "gzip"],
    ];

    expect(cases.map(([header]) => [header, bestEncoding(header)])).toEqual(cases);
  });

  it("treats an absent header and an explicit refusal as identity", () => {
    const identity: Array<string | undefined> = [
      undefined,
      "",
      // Present as a token but refused by its q-value — the case a substring
      // match gets wrong, which is why the q-values are parsed at all.
      "gzip;q=0",
      "gzip;q=0, br;q=0",
      "br;q=0",
      // A malformed q-value must not be read as "accepted at q=1".
      "gzip;q=abc",
    ];

    expect(identity.map((header) => [header, bestEncoding(header)])).toEqual(
      identity.map((header) => [header, null]),
    );
  });
});
