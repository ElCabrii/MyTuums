import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { MentionText } from "@/components/mention-text";
import { renderWithProviders } from "@/test/render";

describe("MentionText", () => {
  it("links valid handles with canonical lowercase URLs while preserving punctuation and line breaks", async () => {
    const text = "Hello @Alice,\nmeet @BOB-smith!";
    await renderWithProviders(
      <article aria-label="Published content">
        <MentionText text={text} />
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
        <MentionText text={text} />
      </article>,
    );

    expect(screen.getByRole("article", { name: "Published content" })).toHaveTextContent(text);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders untrusted markup as inert text", async () => {
    const text = '<img src=x onerror="alert(1)"> @alice';
    await renderWithProviders(
      <article aria-label="Published content">
        <MentionText text={text} />
      </article>,
    );

    const content = screen.getByRole("article", { name: "Published content" });
    expect(content).toHaveTextContent(text);
    expect(content.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "@alice" })).toHaveAttribute("href", "/@alice");
  });
});
