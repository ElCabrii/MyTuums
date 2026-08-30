import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { firstLinkUrl, LinkedText } from "@/components/linked-text";
import { insertMention, mentionAtCaret } from "@/lib/composer-mentions";

import { renderWithProviders } from "@/test/render";

describe("LinkedText", () => {
  it("links valid handles with canonical lowercase URLs while preserving punctuation and line breaks", async () => {
    const text = "Hello @Alice,\nmeet @BOB-smith!";
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text={text} />
      </article>,
    );

    const content = screen.getByRole("article", { name: "Published content" });
    expect(content.textContent).toBe(text);
    expect(screen.getByRole("link", { name: "@Alice" })).toHaveAttribute("href", "/@alice");
    expect(screen.getByRole("link", { name: "@BOB-smith" })).toHaveAttribute("href", "/@bob-smith");
  });

  it("leaves malformed handles and email addresses as plain text", async () => {
    const text = "@ab name@example.com @@alice @abcdefghijklmnopqrstu @aliçce";
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text={text} />
      </article>,
    );

    expect(screen.getByRole("article", { name: "Published content" })).toHaveTextContent(text);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("checks mention boundaries by Unicode code point", async () => {
    const text = "@alice𐐀 𐐀@example.com";
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text={text} />
      </article>,
    );

    expect(screen.getByRole("article", { name: "Published content" }).textContent).toBe(text);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders untrusted markup as inert text", async () => {
    const text = '<img src=x onerror="alert(1)"> @alice';
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text={text} />
      </article>,
    );

    const content = screen.getByRole("article", { name: "Published content" });
    expect(content).toHaveTextContent(text);
    expect(content.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "@alice" })).toHaveAttribute("href", "/@alice");
  });

  it("links http and https URLs as external anchors, leaving sentence punctuation outside", async () => {
    const text = "Read https://my-tuums.example.com/search?q=a+b#top, then http://localhost:3000!";
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text={text} />
      </article>,
    );

    expect(screen.getByRole("article", { name: "Published content" }).textContent).toBe(text);
    const search = screen.getByRole("link", {
      name: "https://my-tuums.example.com/search?q=a+b#top",
    });
    expect(search).toHaveAttribute("href", "https://my-tuums.example.com/search?q=a+b#top");
    expect(search).toHaveAttribute("target", "_blank");
    expect(search).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
    // The label stays as typed while the href is what the URL parser made of
    // it — here, the origin's implicit root path.
    expect(screen.getByRole("link", { name: "http://localhost:3000" })).toHaveAttribute(
      "href",
      "http://localhost:3000/",
    );
  });

  it("keeps a parenthesis the URL opened and drops one that only wraps it", async () => {
    const text = "(see https://en.wikipedia.org/wiki/Foo_(bar))";
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text={text} />
      </article>,
    );

    expect(screen.getByRole("article", { name: "Published content" }).textContent).toBe(text);
    expect(
      screen.getByRole("link", { name: "https://en.wikipedia.org/wiki/Foo_(bar)" }),
    ).toHaveAttribute("href", "https://en.wikipedia.org/wiki/Foo_(bar)");
  });

  it("leaves every other scheme, bare hosts and glued schemes as plain text", async () => {
    const text =
      "javascript:alert(1) data:text/plain,hi ftp://example.com www.example.com seehttps://example.com https://";
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text={text} />
      </article>,
    );

    expect(screen.getByRole("article", { name: "Published content" }).textContent).toBe(text);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("treats a handle inside a URL as part of the URL, not a mention", async () => {
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text="https://example.com/@alice" />
      </article>,
    );

    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "https://example.com/@alice" })).toHaveAttribute(
      "href",
      "https://example.com/@alice",
    );
  });

  it("renders a mention and a URL in the same text as their own links", async () => {
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text="@alice see https://example.com" />
      </article>,
    );

    expect(screen.getByRole("link", { name: "@alice" })).toHaveAttribute("href", "/@alice");
    const external = screen.getByRole("link", { name: "https://example.com" });
    expect(external).toHaveAttribute("href", "https://example.com/");
    expect(external).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
  });

  it("round-trips an accepted composer mention as a profile link", async () => {
    const draft = "Say hi @al after";
    const token = mentionAtCaret(draft, 10);
    expect(token).not.toBeNull();
    const accepted = insertMention(draft, token!, "alice").value;

    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text={accepted} />
      </article>,
    );

    expect(screen.getByRole("article", { name: "Published content" })).toHaveTextContent(accepted);
    expect(screen.getByRole("link", { name: "@alice" })).toHaveAttribute("href", "/@alice");
  });
});

describe("firstLinkUrl", () => {
  it("returns the first URL's href, and only the first (issue #260)", () => {
    expect(firstLinkUrl("see https://example.com/a then https://example.com/b")).toBe(
      "https://example.com/a",
    );
  });

  it("normalizes exactly as the rendered anchor does", () => {
    // Trailing sentence punctuation stays out of the address; the parser
    // percent-encodes and completes whatever the author typed.
    expect(firstLinkUrl("(https://Example.com/path,)")).toBe("https://example.com/path");
  });

  it("returns null for text with no recognized URL", () => {
    expect(firstLinkUrl("@alice javascript:alert(1) name@example.com")).toBeNull();
    expect(firstLinkUrl("")).toBeNull();
  });
});
