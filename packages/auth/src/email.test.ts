import { afterEach, describe, expect, it, vi } from "vitest";
import {
  moderationRemovalEmail,
  otpEmail,
  passwordResetEmail,
  verificationEmail,
} from "./email.js";

/**
 * The email HTML rendering, tested through the exported builders.
 *
 * `escapeHtml`, `renderHtmlLine`, `renderHtmlCopy`, `renderActionButton` and
 * `brandedEmail` are private on purpose — they are the template's internals,
 * not an interface. What the rest of the repo calls is the builder per flow,
 * so that is what the assertions go through: action URLs become buttons,
 * while moderator- and author-supplied copy stays inert in an email client.
 *
 * These are `*.test.ts` and not `*.int.test.ts` for the same reason
 * `src/email.ts` is import-safe with no environment: nothing here touches the
 * database, the network or the root `.env`. The delivery path — whether a
 * notice is actually owed and sent — stays in `packages/api`'s integration
 * suites, which run the production instance against a real database.
 */

type Anchor = {
  href: string;
  text: string;
};

/** The anchors in an email's HTML part, in document order. */
function anchors(html: string): Anchor[] {
  return [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({
    href: match[1],
    text: match[2],
  }));
}

/** The rendered paragraphs of the HTML part, in document order. */
function paragraphs(html: string): string[] {
  return [...html.matchAll(/<p style="[^"]*">([\s\S]*?)<\/p>/g)].map((match) => match[1]);
}

/** Removes tags so assertions inspect visible copy rather than attributes. */
function visibleHtml(html: string): string {
  return html.replaceAll(/<[^>]*>/g, "");
}

describe("branded email HTML", () => {
  it("uses an accessible, table-based letter layout", () => {
    const email = verificationEmail("https://mytuums.test/verify", "en");

    expect(email.html).toContain('<table role="article" aria-labelledby="email-title"');
    expect(email.html).toContain('<h1 id="email-title"');
    expect(email.html).toContain('alt="MyTuums logo"');
    expect(email.html).toContain("border-top:3px solid #c6005c");
  });

  it("keeps supplied moderator and author content escaped in the HTML part", () => {
    const email = moderationRemovalEmail(
      {
        postText: '<img src="x" onerror="alert(1)"> & "quoted"',
        attachmentCount: 0,
        reason: "&<>\"'",
        appealUrl: "https://mytuums.test/appeal",
      },
      "en",
    );

    expect(email.html).toContain("Reason: &amp;&lt;&gt;&quot;&#39;");
    expect(email.html).toContain(
      "&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quoted&quot;",
    );
    expect(email.html).not.toContain('<img src="x"');
    expect(email.html).not.toContain('onerror="alert(1)"');
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

    expect(email.html).toContain("Reason: Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;");
    expect(email.html).not.toContain("&amp;lt;");
  });

  it.each([
    {
      name: "English verification",
      build: () => verificationEmail("https://mytuums.test/action?token=one&next=%2Fhome", "en"),
      label: "Verify my email address",
    },
    {
      name: "French verification",
      build: () => verificationEmail("https://mytuums.test/action?token=one&next=%2Fhome", "fr"),
      label: "Vérifier mon adresse e-mail",
    },
    {
      name: "English password reset",
      build: () => passwordResetEmail("https://mytuums.test/action?token=two&next=%2Fhome", "en"),
      label: "Reset my password",
    },
    {
      name: "French password reset",
      build: () => passwordResetEmail("https://mytuums.test/action?token=two&next=%2Fhome", "fr"),
      label: "Réinitialiser mon mot de passe",
    },
  ])("renders a localized $name CTA instead of visible URL text", ({ build, label }) => {
    const email = build();
    const actionUrl = email.text.match(/https?:\/\/\S+/)?.[0];

    if (!actionUrl) throw new Error("expected the text fallback to contain an action URL");

    const escapedActionUrl = actionUrl.replaceAll("&", "&amp;");
    expect(email.text).toContain(actionUrl);
    expect(anchors(email.html)).toContainEqual({
      href: escapedActionUrl,
      text: label,
    });
    expect(email.html).toContain(`href="${escapedActionUrl}"`);
    expect(visibleHtml(email.html)).not.toContain(actionUrl);
  });

  it("keeps a moderation appeal URL in text and as an escaped CTA href", () => {
    const appealUrl =
      "https://mytuums.test/appeal?token=signed-capability&callbackURL=%2Fmoderation%3Ftab%3Dappeals";

    const email = moderationRemovalEmail(
      { postText: "remove me", attachmentCount: 0, reason: "spam", appealUrl },
      "en",
    );

    expect(email.text).toContain(appealUrl);
    expect(anchors(email.html)).toContainEqual({
      href: appealUrl.replaceAll("&", "&amp;"),
      text: "Appeal this decision",
    });
    expect(email.html).not.toContain(`href="${appealUrl}"`);
    expect(visibleHtml(email.html)).not.toContain(appealUrl);
  });

  it("places the primary action before the fallback safety note", () => {
    const email = verificationEmail("https://mytuums.test/verify", "en");

    expect(email.html.indexOf(">Verify my email address</a>")).toBeLessThan(
      email.html.indexOf("If you didn&#39;t create a MyTuums account"),
    );
  });

  it("keeps arbitrary URLs in quoted posts as ordinary safe links, separate from the CTA", () => {
    const postUrl = "https://author.test/post?ref=moderation&part=quote";
    const appealUrl = "https://mytuums.test/appeal?token=signed-capability";
    const email = moderationRemovalEmail(
      {
        postText: `See ${postUrl}`,
        attachmentCount: 0,
        reason: "spam",
        appealUrl,
      },
      "en",
    );

    expect(anchors(email.html)).toContainEqual({
      href: postUrl.replaceAll("&", "&amp;"),
      text: postUrl.replaceAll("&", "&amp;"),
    });
    expect(anchors(email.html)).toContainEqual({
      href: appealUrl,
      text: "Appeal this decision",
    });
    expect(visibleHtml(email.html)).toContain("https://author.test/post");
    expect(visibleHtml(email.html)).not.toContain(appealUrl);
  });

  it("preserves the plain text's paragraph structure while placing the CTA after the copy", () => {
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
    expect(rendered[2]).toBe("Your post:<br>&quot;remove me&quot;");
    expect(rendered[3]).toBe("If you believe this was a mistake, you can appeal the decision:");
    expect(email.html).toContain(">Appeal this decision</a>");
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

  it("keeps the code in the text fallback and gives it restrained emphasis in HTML", () => {
    const email = otpEmail("123456", "en");

    expect(email.text).toContain("123456");
    expect(email.html).toContain(">123456</strong>");
    expect(email.html).toContain("letter-spacing:3px");
    expect(email.html).not.toContain("href=");
  });

  it("falls back to a usable absolute logo URL when WEB_ORIGIN is malformed", async () => {
    vi.stubEnv("WEB_ORIGIN", "not an origin");
    vi.resetModules();
    const { otpEmail: freshOtpEmail } = await import("./email.js");

    const email = freshOtpEmail("123456", "en");

    expect(email.html).toContain('src="http://localhost:5173/mytuums-192.png"');
  });

  // Positive control for the fallback test above: the fallback URL equals
  // `env.ts`'s default `WEB_ORIGIN` (and the one CI exports), so only a
  // distinct valid origin proves the stub actually reached the module and the
  // logo is resolved against it — on the happy path, not just the catch.
  it("resolves the logo against a valid WEB_ORIGIN", async () => {
    vi.stubEnv("WEB_ORIGIN", "https://mail.example.test");
    vi.resetModules();
    const { otpEmail: freshOtpEmail } = await import("./email.js");

    const email = freshOtpEmail("123456", "en");

    expect(email.html).toContain('src="https://mail.example.test/mytuums-192.png"');
  });
});
