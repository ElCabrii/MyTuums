import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import {
  TranslatedPostContent,
  translatedLangTag,
  type PostTranslation,
} from "@/components/translated-post-content";
import { m } from "@/paraglide/messages.js";
import { setLocale } from "@/paraglide/runtime.js";

// The component reads no query — only the current locale (English under
// jsdom, where no locale cookie is ever set) and its props — so no transport
// fake is needed. The French-source fixtures below therefore always translate
// into English, with `en-x-mtfrom-fr` on the translated snippet.

const FRENCH: PostTranslation = { content: "Hello world", sourceLocale: "fr" };

describe("TranslatedPostContent", () => {
  beforeEach(async () => {
    await setLocale("en", { reload: false });
  });

  it("pins the machine-translation lang tag the markup contract requires", () => {
    expect(translatedLangTag("en", "fr")).toBe("en-x-mtfrom-fr");
    expect(translatedLangTag("fr", "en")).toBe("fr-x-mtfrom-en");
  });

  it("renders the original alone when there is no translation — no toggle, no badge", async () => {
    await renderWithProviders(
      <p>
        <TranslatedPostContent original="Just my own words" translation={null} />
      </p>,
    );

    expect(screen.getByText("Just my own words")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: m.post_translation_view_original() }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: m.post_translation_badge_alt() }),
    ).not.toBeInTheDocument();
  });

  it("treats an empty translation as absent — the original renders alone", async () => {
    await renderWithProviders(
      <p>
        <TranslatedPostContent
          original="Bonjour"
          translation={{ content: "", sourceLocale: "fr" }}
        />
      </p>,
    );

    expect(screen.getByText("Bonjour")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: m.post_translation_view_original() }),
    ).not.toBeInTheDocument();
  });

  it("shows the translation by default, tagged and badged, with a working original toggle", async () => {
    await renderWithProviders(
      <p>
        <TranslatedPostContent original="Bonjour le monde" translation={FRENCH} />
      </p>,
    );

    // The translation is the default view, marked as machine-translated from
    // French; the original is nowhere on screen.
    const translated = screen.getByText("Hello world");
    expect(translated.closest("[lang]")).toHaveAttribute("lang", "en-x-mtfrom-fr");
    expect(screen.queryByText("Bonjour le monde")).not.toBeInTheDocument();

    // The official badge sits adjacent to the translated result and links out
    // to Google Translate; its alt text is the link's accessible name.
    const badge = screen.getByRole("link", { name: m.post_translation_badge_alt() });
    expect(badge).toHaveAttribute("href", "https://translate.google.com/");
    expect(badge).toHaveAttribute("target", "_blank");

    const toggle = screen.getByRole("button", { name: m.post_translation_view_original() });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    const user = userEvent.setup();
    await user.click(toggle);

    // The original replaces the translation and carries its own language; the
    // badge leaves with the translated result it attributes.
    const original = screen.getByText("Bonjour le monde");
    expect(original.closest("[lang]")).toHaveAttribute("lang", "fr");
    expect(screen.queryByText("Hello world")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: m.post_translation_badge_alt() }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: m.post_translation_view_translation() }),
    ).toHaveAttribute("aria-pressed", "true");

    // And back again.
    await user.click(screen.getByRole("button", { name: m.post_translation_view_translation() }));
    expect(screen.getByText("Hello world")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: m.post_translation_badge_alt() })).toBeInTheDocument();
  });

  it("runs translated text through the link path, like authored text", async () => {
    await renderWithProviders(
      <p>
        <TranslatedPostContent
          original="Bonjour"
          translation={{ content: "Hello at https://example.com", sourceLocale: "fr" }}
        />
      </p>,
    );

    expect(screen.getByRole("link", { name: "https://example.com" })).toHaveAttribute(
      "href",
      "https://example.com/",
    );
  });

  it("uses the French target locale in translated markup and controls", async () => {
    await setLocale("fr", { reload: false });
    await renderWithProviders(
      <p>
        <TranslatedPostContent
          original="Hello world"
          translation={{ content: "Bonjour le monde", sourceLocale: "en" }}
        />
      </p>,
    );

    const translated = screen.getByText("Bonjour le monde");
    expect(translated.closest("[lang]")).toHaveAttribute("lang", "fr-x-mtfrom-en");
    expect(
      screen.getByRole("button", { name: m.post_translation_view_original() }),
    ).toBeInTheDocument();
  });
});
