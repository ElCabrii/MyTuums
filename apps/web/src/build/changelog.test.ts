import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBuiltChangelog, renderChangelogMarkdown } from "@/build/changelog";

describe("renderChangelogMarkdown", () => {
  it("renders headings and lists during the build", () => {
    const html = renderChangelogMarkdown("## Highlights\n\n- Better feeds\n", "test.md");

    expect(html).toContain("<h2>Highlights</h2>");
    expect(html).toContain("<li>Better feeds</li>");
  });

  it("rejects raw HTML in repository changelogs", () => {
    expect(() => renderChangelogMarkdown("<script>alert('no')</script>", "test.md")).toThrow(
      "test.md contains raw HTML",
    );
  });

  it.each(["[Unsafe](javascript:alert('no'))", "![Unsafe](data:image/svg+xml,boom)"])(
    "rejects unsafe link protocols in %s",
    (source) => {
      expect(() => renderChangelogMarkdown(source, "test.md")).toThrow(
        "test.md contains a link with an unsafe protocol",
      );
    },
  );

  it("allows web and relative links", () => {
    expect(
      renderChangelogMarkdown(
        "[Website](https://mytuums.com) [Settings](/settings/account)",
        "test.md",
      ),
    ).toContain('<a href="https://mytuums.com">Website</a>');
  });
});

describe("loadBuiltChangelog", () => {
  const changelogDirectory = path.resolve(import.meta.dirname, "../../changelog");

  it("loads both localized notes for the release", () => {
    const changelog = loadBuiltChangelog(changelogDirectory, "0.5.0");

    expect(changelog.en).toContain("Discover more");
    expect(changelog.fr).toContain("Découvrez davantage");
  });

  it("returns no content when the running version has no release notes", () => {
    expect(loadBuiltChangelog(changelogDirectory, "9.9.9")).toEqual({ en: null, fr: null });
  });
});
