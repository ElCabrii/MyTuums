import { beforeEach, describe, expect, it } from "vitest";
import { m } from "@/paraglide/messages.js";
import {
  SITE_ORIGIN,
  documentTitle,
  fallbackHead,
  pageHead,
  postPageDescription,
  postPageName,
  profilePageDescription,
  setDocumentHead,
} from "@/lib/document-head";

beforeEach(() => {
  document.title = "";
  for (const el of document.head.querySelectorAll("meta")) el.remove();
});

function metaContent(selector: string): string | null {
  return document.head.querySelector(selector)?.getAttribute("content") ?? null;
}

/** Appends the meta tags one route head produces, like <HeadContent /> would. */
function mountHead(head: ReturnType<typeof pageHead>): void {
  for (const tag of head.meta) {
    if (!("title" in tag)) {
      const meta = document.createElement("meta");
      const key = "property" in tag ? "property" : "name";
      meta.setAttribute(key, tag[key]);
      meta.setAttribute("content", tag.content);
      document.head.appendChild(meta);
    }
  }
}

describe("document head resolution", () => {
  it("formats static route names with the localized product suffix", () => {
    expect(documentTitle(m.nav_discover())).toBe(`Discover - ${m.app_title_suffix()}`);
  });

  it("gives a page its own description plus canonical and unfurl metadata", () => {
    const head = pageHead(m.nav_discover(), m.discover_document_description(), "/discover");
    const url = `${SITE_ORIGIN}/discover`;
    expect(head.links).toEqual([{ rel: "canonical", href: url }]);
    expect(head.meta).toEqual([
      { title: `Discover - ${m.app_title_suffix()}` },
      { name: "description", content: m.discover_document_description() },
      { property: "og:url", content: url },
      { property: "og:title", content: `Discover - ${m.app_title_suffix()}` },
      { property: "og:description", content: m.discover_document_description() },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "MyTuums" },
      { property: "og:image", content: `${SITE_ORIGIN}/mytuums-512.png` },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: `Discover - ${m.app_title_suffix()}` },
      { name: "twitter:description", content: m.discover_document_description() },
      { name: "twitter:image", content: `${SITE_ORIGIN}/mytuums-512.png` },
    ]);
  });

  it("defaults to the site root and the app-wide description as fallback only", () => {
    const head = pageHead(m.feed_title());
    expect(head.links).toEqual([{ rel: "canonical", href: `${SITE_ORIGIN}/` }]);
    expect(head.meta).toContainEqual({
      name: "description",
      content: m.app_document_description(),
    });
  });

  it("uses post text for a focused title and collapses authored whitespace", () => {
    expect(postPageName("A\npost   with\tspacing")).toBe("A post with spacing");
    expect(postPageDescription("A\npost   with\tspacing")).toBe("A post with spacing");
  });

  it("truncates long post titles without leaving a trailing space", () => {
    const title = postPageName("word ".repeat(30));
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(68);
  });

  it("falls back to the localized page name and description while data loads", () => {
    expect(postPageName(null)).toBe(m.post_title());
    expect(postPageDescription(null)).toBe(m.app_document_description());
    expect(profilePageDescription(null)).toBe(m.app_document_description());
    const fallback = fallbackHead();
    expect(fallback.meta).toEqual([
      { title: m.app_document_title() },
      { name: "description", content: m.app_document_description() },
      { property: "og:title", content: m.app_document_title() },
      { property: "og:description", content: m.app_document_description() },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "MyTuums" },
      { property: "og:image", content: `${SITE_ORIGIN}/mytuums-512.png` },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: m.app_document_title() },
      { name: "twitter:description", content: m.app_document_description() },
      { name: "twitter:image", content: `${SITE_ORIGIN}/mytuums-512.png` },
    ]);
    // Only child routes own a canonical; a root-level one would double up.
    expect(fallback).not.toHaveProperty("links");
  });

  it("keeps unfurl mirrors in step when data lands after the static head", () => {
    mountHead(pageHead(m.post_title()));
    setDocumentHead(postPageName("A fresh post"), postPageDescription("A fresh post"));
    expect(document.title).toBe(`A fresh post - ${m.app_title_suffix()}`);
    expect(metaContent('meta[name="description"]')).toBe("A fresh post");
    expect(metaContent('meta[property="og:title"]')).toBe(`A fresh post - ${m.app_title_suffix()}`);
    expect(metaContent('meta[property="og:description"]')).toBe("A fresh post");
    expect(metaContent('meta[name="twitter:title"]')).toBe(
      `A fresh post - ${m.app_title_suffix()}`,
    );
    expect(metaContent('meta[name="twitter:description"]')).toBe("A fresh post");
  });
});
