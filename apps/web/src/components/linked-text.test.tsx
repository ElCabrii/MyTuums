import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { SEARCH_QUERY_MAX_LENGTH } from "@my-tuums/api/constants";
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
    // `x-@alice` pins the mention half of the hyphen asymmetry: `-` is a
    // handle character, so it still blocks a mention even though a tag is
    // allowed to start after one.
    const text = "@ab name@example.com @@alice @abcdefghijklmnopqrstu @aliçce x-@alice";
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

  it("links valid tags to post search filtered to the canonical lowercase tag", async () => {
    const text = "#Tuums day! Join #MY_EVENT_2 x-#after_hyphen now";
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text={text} />
      </article>,
    );

    expect(screen.getByRole("article", { name: "Published content" }).textContent).toBe(text);
    // The query keeps the `#` so it matches hash-marked occurrences rather
    // than the bare word (post search is a substring scan) — and it is
    // lowercased like a handle's route while the label stays as typed.
    expect(screen.getByRole("link", { name: "#Tuums" })).toHaveAttribute(
      "href",
      "/search?q=%23tuums",
    );
    expect(screen.getByRole("link", { name: "#MY_EVENT_2" })).toHaveAttribute(
      "href",
      "/search?q=%23my_event_2",
    );
    // A hyphen is not a tag character, so it is a valid boundary before a
    // `#` — unlike before an `@`, where the hyphen is a handle character.
    expect(screen.getByRole("link", { name: "#after_hyphen" })).toHaveAttribute(
      "href",
      "/search?q=%23after_hyphen",
    );
  });

  it("leaves malformed tags as plain text — a lone #, ##tag, a glued word, accents and hyphens", async () => {
    const text = "# ##tag word#tag #café #été #tag-way #tag𐐀";
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text={text} />
      </article>,
    );

    expect(screen.getByRole("article", { name: "Published content" }).textContent).toBe(text);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  // The issue-#314 resolution (Q3): a tag the server's batch map answers
  // links to its game's page; every other tag — absent from the map, or a
  // render with no map at all — keeps the original search link. The label
  // stays as typed in both cases.
  it("links a resolved tag to its game page while unresolved tags keep their search links", async () => {
    const text = "Playing #doom and #unknownthing";
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text={text} gameMentions={{ doom: "doom" }} />
      </article>,
    );

    expect(screen.getByRole("link", { name: "#doom" })).toHaveAttribute("href", "/games/doom");
    expect(screen.getByRole("link", { name: "#unknownthing" })).toHaveAttribute(
      "href",
      "/search?q=%23unknownthing",
    );

    // No map (a bio, or an older cache): every tag links the original way.
    // Scoped — both renders stay mounted within one test, so the earlier
    // resolved link would otherwise match the same query too.
    await renderWithProviders(
      <article aria-label="Unresolved content">
        <LinkedText text="#doom" />
      </article>,
    );
    const unresolved = within(screen.getByRole("article", { name: "Unresolved content" }));
    expect(unresolved.getByRole("link", { name: "#doom" })).toHaveAttribute(
      "href",
      "/search?q=%23doom",
    );
  });

  it("recognizes a tag only up to the length whose `#tag` query the search procedures still accept", async () => {
    const longest = `#${"a".repeat(SEARCH_QUERY_MAX_LENGTH - 1)}`;
    const tooLong = `#${"a".repeat(SEARCH_QUERY_MAX_LENGTH)}`;
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text={`${longest} ${tooLong}`} />
      </article>,
    );

    // The longest tag links; one character more would link to a query the
    // server rejects on length, so it stays inert text instead.
    expect(screen.getByRole("link", { name: longest })).toHaveAttribute(
      "href",
      `/search?q=%23${"a".repeat(SEARCH_QUERY_MAX_LENGTH - 1)}`,
    );
    expect(screen.queryByRole("link", { name: tooLong })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Published content" }).textContent).toBe(
      `${longest} ${tooLong}`,
    );
  });

  it("treats a # inside a URL as part of the URL, not a tag", async () => {
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text="See https://example.com/docs#section for details" />
      </article>,
    );

    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "https://example.com/docs#section" })).toHaveAttribute(
      "href",
      "https://example.com/docs#section",
    );
  });

  it("renders a mention, a tag and a URL in the same text as their own links", async () => {
    const text = "@alice tagged #Tuums in https://example.com";
    await renderWithProviders(
      <article aria-label="Published content">
        <LinkedText text={text} />
      </article>,
    );

    expect(screen.getByRole("article", { name: "Published content" }).textContent).toBe(text);
    expect(screen.getByRole("link", { name: "@alice" })).toHaveAttribute("href", "/@alice");
    expect(screen.getByRole("link", { name: "#Tuums" })).toHaveAttribute(
      "href",
      "/search?q=%23tuums",
    );
    expect(screen.getByRole("link", { name: "https://example.com" })).toHaveAttribute(
      "href",
      "https://example.com/",
    );
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
