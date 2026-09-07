import { useState } from "react";
import { LinkedText } from "@/components/linked-text";
import { getLocale } from "@/paraglide/runtime.js";
import { m } from "@/paraglide/messages.js";
import type { TranslationLocale } from "@/lib/query-definitions";

/**
 * One post row's machine translation, as `post.list`/`post.thread` serve it
 * (issue #310): the translated text plus the language it was translated from.
 * The viewer's own locale is the implicit target — every query asks for it
 * (see `translationTarget` in `lib/query-definitions.ts`).
 */
export interface PostTranslation {
  content: string;
  sourceLocale: TranslationLocale;
}

/**
 * Reads the forthcoming `translation` row field off today's `Post` type. The
 * parameter declares the field as optional next to `content` (which every row
 * carries), so both the current rows (which never carry it) and the translated
 * ones (which do) are assignable with no assertion — the optionality is the
 * whole seam. An empty translation carries nothing to show, so it reads as
 * absent and the original renders alone.
 */
export function postTranslation(row: {
  content: string | null;
  translation?: PostTranslation | null;
}): PostTranslation | null {
  const translation = row.translation;
  return translation?.content ? translation : null;
}

/**
 * The `lang` tag for a machine-translated snippet, per Google's HTML markup
 * requirements (https://cloud.google.com/translate/markup): the target
 * language with the source carried as a private-use subtag, so indexers and
 * assistive technology can tell machine translation from authored text.
 */
export function translatedLangTag(target: TranslationLocale, source: TranslationLocale): string {
  return `${target}-x-mtfrom-${source}`;
}

/**
 * A post's text with its automatic translation (issue #310). The translated
 * text shows by default and runs through the same {@link LinkedText} path as
 * authored text, so mentions, hashtags and URLs keep working; a toggle offers
 * the original, whose language is then the translation's source. The Google
 * attribution badge sits adjacent to the translated result and links to
 * Google Translate, as the Cloud Translation attribution requirements demand
 * — the file under `/powered-by-google-translate.svg` is Google's official
 * badge, served unmodified.
 *
 * Presentational only: which posts carry a translation is the query layer's
 * answer, and link-preview extraction (`firstLinkUrl` in `post-card.tsx`)
 * deliberately keeps reading the original.
 */
export function TranslatedPostContent({
  original,
  translation,
  gameMentions,
}: {
  /** The stored post text — the caller renders this component only when it is non-empty. */
  original: string;
  /** The row's translation, or null when the server sent none. */
  translation?: PostTranslation | null;
  /** The batch's hashtag→slug map, forwarded to {@link LinkedText}. */
  gameMentions?: Record<string, string>;
}) {
  const [showOriginal, setShowOriginal] = useState(false);
  const target = getLocale() === "fr" ? "fr" : "en";

  const resolved = postTranslation({ content: original, translation });
  if (!resolved) {
    return <LinkedText text={original} gameMentions={gameMentions} />;
  }

  const showingTranslation = !showOriginal;
  return (
    <>
      <span
        lang={
          showingTranslation
            ? translatedLangTag(target, resolved.sourceLocale)
            : resolved.sourceLocale
        }
      >
        <LinkedText
          text={showingTranslation ? resolved.content : original}
          gameMentions={gameMentions}
        />
      </span>
      {/* Inline controls inside the card's paragraph: spans and buttons are
          phrasing content, so this stays valid where a div would not. */}
      <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        {showingTranslation && (
          <a
            href="https://translate.google.com/"
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src="/powered-by-google-translate.svg"
              alt={m.post_translation_badge_alt()}
              width={176}
              height={16}
              className="h-4 w-auto"
            />
          </a>
        )}
        <button
          type="button"
          aria-pressed={showOriginal}
          onClick={(e) => {
            e.stopPropagation();
            setShowOriginal((value) => !value);
          }}
          className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2 transition-colors"
        >
          {showOriginal
            ? m.post_translation_view_translation()
            : m.post_translation_view_original()}
        </button>
      </span>
    </>
  );
}
