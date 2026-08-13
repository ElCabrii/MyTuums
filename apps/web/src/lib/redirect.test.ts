import { describe, expect, it } from "vitest";
import { sanitizeRedirect } from "@/lib/redirect";

/**
 * The `?redirect=` param round-trips through `window.location` and through
 * the OAuth provider's callback URL, so nothing about its provenance can be
 * trusted — an unsanitized value is an open redirect that ships a valid
 * session off-site. The rules here are the load-bearing half of that.
 *
 * Grouped accept/reject rather than one test per example: the rule is "a path
 * on this origin that isn't an auth page", and a table shows that shape at a
 * glance while still naming the offending input in the diff when a row fails.
 */
function expectRedirects(
  cases: readonly (readonly [string | null | undefined, string | null])[],
): void {
  expect(cases.map(([input]) => [input, sanitizeRedirect(input)])).toEqual(
    cases.map(([input, expected]) => [input, expected]),
  );
}

describe("sanitizeRedirect", () => {
  it("accepts a same-origin path, preserving search and hash", () => {
    expectRedirects([
      ["/post/abc", "/post/abc"],
      ["/", "/"],
      // Deep links with parameters survive the round trip.
      ["/discover?tab=following#top", "/discover?tab=following#top"],
      // Harmless, since a complete session bounces off /welcome to its profile.
      ["/welcome", "/welcome"],
    ]);
  });

  it("rejects anything that could leave the origin, loop a sign-in, or overflow", () => {
    expectRedirects([
      [null, null],
      [undefined, null],
      ["", null],
      // A URL that needs raw whitespace is not this app's URL.
      ["/post/abc def", null],
      [" /post/abc", null],
      ["https://evil.example/", null],
      // The browser would resolve a protocol-relative URL as a different host.
      ["//evil.example/", null],
      // URL parsing also treats backslashes as authority separators.
      ["/\\evil.example/", null],
      ["evil.example/path", null],
      // The auth pages themselves, so a sign-in can't loop into a sign-in.
      ["/login", null],
      ["/login?error=state_mismatch", null],
      ["/register", null],
      ["/two-factor", null],
      [`/${"a".repeat(2048)}`, null],
    ]);
  });
});
