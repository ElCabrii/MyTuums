import { beforeEach, describe, expect, it } from "vitest";
import { m } from "@/paraglide/messages.js";
import {
  documentTitle,
  fallbackHead,
  pageHead,
  postPageDescription,
  postPageName,
  profilePageDescription,
} from "@/lib/document-head";

beforeEach(() => {
  document.title = "";
  document.head.querySelector('meta[name="description"]')?.remove();
  const description = document.createElement("meta");
  description.setAttribute("name", "description");
  document.head.appendChild(description);
});

describe("document head resolution", () => {
  it("formats static route names with the localized product suffix", () => {
    expect(documentTitle(m.nav_discover())).toBe(`Discover - ${m.app_title_suffix()}`);
    expect(pageHead(m.nav_discover()).meta).toEqual([
      { title: `Discover - ${m.app_title_suffix()}` },
      { name: "description", content: m.app_document_description() },
    ]);
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
    expect(fallbackHead().meta).toEqual([
      { title: m.app_document_title() },
      { name: "description", content: m.app_document_description() },
    ]);
  });
});
