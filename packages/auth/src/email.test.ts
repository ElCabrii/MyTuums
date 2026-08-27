import { afterEach, describe, expect, it, vi } from "vitest";
import { moderationRemovalEmail } from "./email.js";

/**
 * The email HTML rendering, tested through the exported builders.
 *
 * `escapeHtml`, `renderHtmlLine`, `renderHtmlCopy` and `brandedEmail` are
 * private on purpose — they are the template's internals, not an interface.
 * What the rest of the repo calls is the builder per flow, so that is what the
 * assertions go through: the copy a moderator or an author supplied has to
 * come out of `moderationRemovalEmail`'s HTML part inert, because that string
 * is what an email client parses.
 *
 * These are `*.test.ts` and not `*.int.test.ts` for the same reason
 * `src/email.ts` is import-safe with no environment: nothing here touches the
 * database, the network or the root `.env`. The delivery path — whether a
 * notice is actually owed and sent — stays in `packages/api`'s integration
 * suites, which run the production instance against a real database.
 */

/** The URLs an email's HTML part links to, in document order. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
}

/** The rendered paragraphs of the HTML part, in document order. */
function paragraphs(html: string): string[] {
  return [...html.matchAll(/<p style="[^"]*">([\s\S]*?)<\/p>/g)].map((match) => match[1]);
}

describe("moderationRemovalEmail", () => {
  it("escapes every markup-significant character in the moderator-supplied reason", () => {
    const email = moderationRemovalEmail(
      {
        postText: "remove me",
        attachmentCount: 0,
        reason: "&<>\"'",
        appealUrl: "https://mytuums.test/appeal",
      },
      "en",
    );

    expect(email.html).toContain("Reason: &amp;&lt;&gt;&quot;&#39;");
  });

  it("escapes & first, so an & next to markup is not double-escaped", () => {
    const email = moderationRemovalEmail(
      {
        postText: "remove me",
        attachmentCount: 0,
        reason: "Tom & <b>Jerry</b>",
        appealUrl: "https://mytuums.test/appeal",
      },
      "en",
    );

    // Escaping `&` first is what keeps the `&lt;`/`&gt;` it produces intact;
    // escaping it last would re-escape its own output and the reason would
    // arrive showing the entity instead of the tag it defanged.
    expect(email.html).toContain("Reason: Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;");
    expect(email.html).not.toContain("&amp;lt;");
  });

  it("keeps a capability URL unchanged in text and equivalent in its escaped HTML link", () => {
    const appealUrl =
      "https://mytuums.test/appeal?token=signed-capability&callbackURL=%2Fmoderation%3Ftab%3Dappeals";

    const email = moderationRemovalEmail(
      { postText: "remove me", attachmentCount: 0, reason: "spam", appealUrl },
      "en",
    );

    expect(email.text).toContain(appealUrl);
    expect(email.html).toContain(`href="${appealUrl.replaceAll("&", "&amp;")}"`);
  });

  it("linkifies each URL in the copy once, with the href escaped and the surrounding prose escaped too", () => {
    const email = moderationRemovalEmail(
      {
        postText: "see <b>both</b> https://a.test/one?x=1&y=2 and http://b.test/two",
        attachmentCount: 0,
        reason: "spam",
        appealUrl: "https://mytuums.test/appeal",
      },
      "en",
    );

    // One anchor per URL, in document order: the two the author embedded and
    // the appeal link. The `&` in a query string survives as a character.
    expect(hrefs(email.html)).toEqual([
      "https://a.test/one?x=1&amp;y=2",
      "http://b.test/two",
      "https://mytuums.test/appeal",
    ]);
    expect(email.html).toContain(
      '&quot;see &lt;b&gt;both&lt;/b&gt; <a href="https://a.test/one?x=1&amp;y=2"',
    );
  });

  it("does not linkify a javascript: or data: URL — it stays escaped text", () => {
    const email = moderationRemovalEmail(
      {
        postText: "javascript:alert(1) data:text/html,<b>x</b>",
        attachmentCount: 0,
        reason: "spam",
        appealUrl: "https://mytuums.test/appeal",
      },
      "en",
    );

    // The appeal link is the only anchor in the message.
    expect(hrefs(email.html)).toEqual(["https://mytuums.test/appeal"]);
    expect(email.html).toContain("javascript:alert(1)");
    expect(email.html).toContain("data:text/html,&lt;b&gt;x&lt;/b&gt;");
  });

  it("preserves the plain text's paragraph and line-break structure", () => {
    const email = moderationRemovalEmail(
      {
        postText: "remove me",
        attachmentCount: 0,
        reason: "spam",
        appealUrl: "https://mytuums.test/appeal",
      },
      "en",
    );

    const rendered = paragraphs(email.html);
    expect(rendered).toHaveLength(4);
    expect(rendered[0]).toBe("A moderator removed your post.");
    expect(rendered[1]).toBe("Reason: spam");
    // A single newline becomes a break, not a new paragraph.
    expect(rendered[2]).toBe("Your post:<br>&quot;remove me&quot;");
    expect(rendered[3]).toContain(
      'you can appeal the decision:<br><a href="https://mytuums.test/appeal"',
    );
  });

  it("renders the French subject into <title> and <h1> while the header stays unescaped", () => {
    const email = moderationRemovalEmail(
      {
        postText: "remove me",
        attachmentCount: 0,
        reason: "spam",
        appealUrl: "https://mytuums.test/appeal",
      },
      "fr",
    );

    // `subject` travels as an email header, where escaping would corrupt it;
    // the same string is what lands in the two markup slots.
    expect(email.subject).toBe("Votre publication a été retirée de MyTuums");
    expect(email.html).toContain(`<title>${email.subject}</title>`);
    expect(email.html).toContain(`>${email.subject}</h1>`);
  });
});

describe("otpEmail", () => {
  // `src/env.ts` resolves `WEB_ORIGIN` when the module loads, so the malformed
  // value has to be in place before a fresh import — and must not outlive the
  // test that needed it.
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("falls back to a usable absolute logo URL when WEB_ORIGIN is malformed", async () => {
    vi.stubEnv("WEB_ORIGIN", "not an origin");
    vi.resetModules();
    const { otpEmail: freshOtpEmail } = await import("./email.js");

    const email = freshOtpEmail("123456", "en");

    // The fallback is the point: a bad origin must cost the email its logo
    // resolution, not the whole send.
    expect(email.html).toContain('src="http://localhost:5173/mytuums-192.png"');
  });
});
