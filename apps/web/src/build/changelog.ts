import { readFileSync } from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { z } from "zod";

export interface BuiltChangelog {
  readonly en: string | null;
  readonly fr: string | null;
}

function hasSafeProtocol(href: string): boolean {
  try {
    const url = new URL(href, "https://mytuums.invalid");
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const safeHrefSchema = z.string().refine(hasSafeProtocol);

/** Compiles repository-owned release notes and refuses raw HTML in Markdown. */
export function renderChangelogMarkdown(source: string, sourceName: string): string {
  return marked.parse(source, {
    async: false,
    gfm: true,
    walkTokens(token) {
      if (token.type === "html") {
        throw new Error(`${sourceName} contains raw HTML, which changelog files do not allow`);
      }
      if (token.type === "link" || token.type === "image") {
        const parsedHref = safeHrefSchema.safeParse(token.href);
        if (!parsedHref.success) {
          throw new Error(`${sourceName} contains a link with an unsafe protocol`);
        }
      }
    },
  });
}

/** Loads only the running release's notes, with either locale as the other's fallback. */
export function loadBuiltChangelog(directory: string, version: string): BuiltChangelog {
  const readLocale = (locale: "en" | "fr"): string | null => {
    const filePath = path.join(directory, `${version}.${locale}.md`);

    try {
      const source = readFileSync(filePath, "utf8");
      return source.trim() ? renderChangelogMarkdown(source, filePath) : null;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  };

  const en = readLocale("en");
  const fr = readLocale("fr");

  return {
    en: en ?? fr,
    fr: fr ?? en,
  };
}
