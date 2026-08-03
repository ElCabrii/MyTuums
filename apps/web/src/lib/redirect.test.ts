import { describe, expect, it } from "vitest";
import { sanitizeRedirect } from "@/lib/redirect";

/**
 * The `?redirect=` param round-trips through `window.location` and through
 * the OAuth provider's callback URL, so nothing about its provenance can be
 * trusted — an unsanitized value is an open redirect that ships a valid
 * session off-site. The rules here are the load-bearing half of that.
 */
describe("sanitizeRedirect", () => {
  it("accepts a plain path", () => {
    expect(sanitizeRedirect("/post/abc")).toBe("/post/abc");
  });

  it("accepts the root path", () => {
    expect(sanitizeRedirect("/")).toBe("/");
  });

  it("preserves search and hash — deep links with parameters survive the round trip", () => {
    expect(sanitizeRedirect("/discover?tab=following#top")).toBe("/discover?tab=following#top");
  });

  it("accepts /welcome — harmless, since a complete session bounces to its profile", () => {
    expect(sanitizeRedirect("/welcome")).toBe("/welcome");
  });

  it.each([[null], [undefined], [""]])("rejects %s", (raw) => {
    expect(sanitizeRedirect(raw)).toBeNull();
  });

  it("rejects whitespace anywhere — a URL that needs raw whitespace is not this app's URL", () => {
    expect(sanitizeRedirect("/post/abc def")).toBeNull();
    expect(sanitizeRedirect(" /post/abc")).toBeNull();
  });

  it("rejects an absolute https URL", () => {
    expect(sanitizeRedirect("https://evil.example/")).toBeNull();
  });

  it("rejects a protocol-relative URL — the browser would resolve it as a different host", () => {
    expect(sanitizeRedirect("//evil.example/")).toBeNull();
  });

  it("rejects a scheme-less absolute URL", () => {
    expect(sanitizeRedirect("evil.example/path")).toBeNull();
  });

  it("rejects the auth pages themselves, so a sign-in can't loop into a sign-in", () => {
    expect(sanitizeRedirect("/login")).toBeNull();
    expect(sanitizeRedirect("/login?error=state_mismatch")).toBeNull();
    expect(sanitizeRedirect("/register")).toBeNull();
    expect(sanitizeRedirect("/two-factor")).toBeNull();
  });

  it("rejects an over-long redirect", () => {
    expect(sanitizeRedirect(`/${"a".repeat(2048)}`)).toBeNull();
  });
});
