import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import type { ReactNode } from "react";
import { SEARCH_QUERY_MAX_LENGTH } from "@my-tuums/api/constants";
import {
  isAllowedUsernameCharset,
  normalizeUsername,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "@my-tuums/auth/rules";
// The other half of a mutual import: ProfileLink's hover card renders
// LinkedText for the bio. See profile-link.tsx for why the cycle is
// intentional and runtime-safe (hover-card content renders lazily on hover).
import { ProfileLink } from "@/components/profile-link";

type TextSegment = {
  kind: "text";
  start: number;
  value: string;
};

type MentionSegment = {
  kind: "mention";
  label: string;
  start: number;
  username: string;
};

type UrlSegment = {
  kind: "url";
  href: string;
  label: string;
  start: number;
};

type HashtagSegment = {
  kind: "hashtag";
  label: string;
  start: number;
  /** The canonical lowercase tag, without the `#`. */
  tag: string;
};

type Segment = TextSegment | MentionSegment | UrlSegment | HashtagSegment;

/** A recognized token, and the offset the scan resumes at after it. */
type Match = {
  end: number;
  segment: MentionSegment | UrlSegment | HashtagSegment;
};

const UNICODE_WORD_CHARACTER = /[\p{L}\p{M}\p{N}]/u;

/**
 * The only schemes that ever become an anchor. Authored text is stored and
 * returned verbatim, so a `javascript:` or `data:` URL can only ever have been
 * typed literally — recognizing nothing but absolute http(s) is what keeps it
 * inert text instead of an executable link.
 */
const URL_SCHEME = /^https?:\/\//iu;

/** The longest prefix `URL_SCHEME` can match, in characters. */
const URL_SCHEME_MAX_LENGTH = 8;

/**
 * Where a URL stops: whitespace, control characters, and the delimiters no
 * linkifier treats as part of an address.
 */
const NON_URL_CHARACTER = /[\s<>"\p{Cc}]/u;

/** Sentence punctuation an author writes after a URL, never as part of it. */
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "'", "…"]);

/** Closing delimiter to its opening partner, for the balance check below. */
const CLOSING_DELIMITERS = new Map([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);

function isUsernameCharacter(character: string | undefined): boolean {
  return character !== undefined && isAllowedUsernameCharset(character);
}

/**
 * Whether a token may not start or end against this character: a handle
 * character, or any Unicode letter, mark or number. The URL and mention
 * recognizers share it, so `name@example.com` stays an address and
 * `seehttps://example.com` stays a typo.
 */
function isWordCharacter(character: string | undefined): boolean {
  return (
    character !== undefined &&
    (isAllowedUsernameCharset(character) || UNICODE_WORD_CHARACTER.test(character))
  );
}

function isUrlCharacter(character: string | undefined): boolean {
  return character !== undefined && !NON_URL_CHARACTER.test(character);
}

function occurrences(characters: string[], start: number, end: number, character: string): number {
  let count = 0;
  for (let index = start; index < end; index += 1) {
    if (characters[index] === character) count += 1;
  }
  return count;
}

/**
 * Walks the end of a URL run back over punctuation that belongs to the
 * sentence rather than the address. A closing delimiter is kept when the URL
 * opened it itself — `/wiki/Foo_(bar)` would otherwise lose its parenthesis —
 * and dropped when it only wraps it, as in `(see https://example.com)`.
 */
function urlEndWithoutTrailingPunctuation(
  characters: string[],
  start: number,
  end: number,
): number {
  let last = end;
  while (last > start) {
    const character = characters[last - 1];
    if (character === undefined) break;
    if (TRAILING_PUNCTUATION.has(character)) {
      last -= 1;
      continue;
    }
    const opening = CLOSING_DELIMITERS.get(character);
    if (
      opening === undefined ||
      occurrences(characters, start, last, character) <=
        occurrences(characters, start, last, opening)
    ) {
      break;
    }
    last -= 1;
  }
  return last;
}

/**
 * The normalized absolute http(s) URL `candidate` denotes, or `undefined` when
 * it is not one. The platform parser rather than a regex decides: it is what
 * guarantees the rendered `href` carries a scheme the browser cannot execute,
 * and it percent-encodes whatever the author typed.
 */
function safeUrlHref(candidate: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.hostname.length === 0) return undefined;
  return parsed.href;
}

function matchUrl(characters: string[], cursor: number): Match | undefined {
  if (isWordCharacter(characters[cursor - 1])) return undefined;
  if (!URL_SCHEME.test(characters.slice(cursor, cursor + URL_SCHEME_MAX_LENGTH).join(""))) {
    return undefined;
  }

  let end = cursor;
  while (isUrlCharacter(characters[end])) end += 1;
  end = urlEndWithoutTrailingPunctuation(characters, cursor, end);

  const label = characters.slice(cursor, end).join("");
  const href = safeUrlHref(label);
  if (href === undefined) return undefined;

  return { end, segment: { kind: "url", href, label, start: cursor } };
}

function matchMention(characters: string[], cursor: number): Match | undefined {
  if (
    characters[cursor] !== "@" ||
    characters[cursor - 1] === "@" ||
    isWordCharacter(characters[cursor - 1])
  ) {
    return undefined;
  }

  let end = cursor + 1;
  while (isUsernameCharacter(characters[end])) end += 1;

  const username = characters.slice(cursor + 1, end).join("");
  const hasValidLength =
    username.length >= USERNAME_MIN_LENGTH && username.length <= USERNAME_MAX_LENGTH;
  if (!hasValidLength || isWordCharacter(characters[end])) return undefined;

  return {
    end,
    segment: {
      kind: "mention",
      label: characters.slice(cursor, end).join(""),
      start: cursor,
      username: normalizeUsername(username),
    },
  };
}

/**
 * The longest tag a `#` can introduce. Derived from the search query ceiling
 * rather than invented: a tag link's query is `#` plus the canonical tag, so
 * any tag this tokenizer recognizes produces a query `search.posts` accepts
 * instead of one it would reject on length.
 */
const HASHTAG_MAX_LENGTH = SEARCH_QUERY_MAX_LENGTH - 1;

/**
 * The tag charset: ASCII letters, digits and the underscore — the handle
 * charset minus the hyphen, which no tag syntax treats as part of a tag.
 * Unlike `USERNAME_RE` it is never tested against a whole tag, only against
 * one code point at a time, so it carries no anchors. It stays flagless for
 * the same reason as `USERNAME_RE`: a `g` flag would make `.test()` stateful.
 */
const HASHTAG_CHARACTER = /[a-zA-Z0-9_]/;

/**
 * Whether `character` can appear inside a tag. Accented letters are
 * deliberately NOT tag characters even though the app is bilingual: a tag is
 * canonicalized to lowercase in the browser and matched by `ilike` in
 * Postgres, and only ASCII lowercasing is guaranteed to agree between the two
 * under every database collation. `#été` therefore stays plain text rather
 * than linking to a query that might not match the very post it came from.
 */
function isHashtagCharacter(character: string | undefined): boolean {
  return character !== undefined && HASHTAG_CHARACTER.test(character);
}

/**
 * Whether a `#` may not start against this character: a tag character, or
 * any Unicode letter, mark or number. This is `isWordCharacter` narrowed to
 * the tag charset, because the hyphen is a handle character but not a tag
 * character — `x-#tag` links while `x-@handle` stays inert.
 */
function isTagWordCharacter(character: string | undefined): boolean {
  return (
    character !== undefined &&
    (HASHTAG_CHARACTER.test(character) || UNICODE_WORD_CHARACTER.test(character))
  );
}

function matchHashtag(characters: string[], cursor: number): Match | undefined {
  // The `#`-before-`#` guard mirrors the mention recognizer's `@@` guard, so
  // `##tag` is inert text rather than a link buried one character in. The
  // leading boundary is `isTagWordCharacter`, not the mention recognizer's
  // `isWordCharacter`: a hyphen is not a tag character, so it is a valid
  // boundary before a `#` even though it blocks a mention.
  if (
    characters[cursor] !== "#" ||
    characters[cursor - 1] === "#" ||
    isTagWordCharacter(characters[cursor - 1])
  ) {
    return undefined;
  }

  let end = cursor + 1;
  while (isHashtagCharacter(characters[end])) end += 1;

  const tag = characters.slice(cursor + 1, end).join("");
  // The trailing boundary check is what keeps a tag from being linkified as a
  // prefix of what the author wrote: a tag that runs straight into an
  // accented letter (`#café`) or a hyphen (`#tag-way`) is malformed, exactly
  // like `@aliçce`, rather than a link ending mid-word.
  if (tag.length === 0 || tag.length > HASHTAG_MAX_LENGTH || isWordCharacter(characters[end])) {
    return undefined;
  }

  return {
    end,
    segment: {
      kind: "hashtag",
      label: characters.slice(cursor, end).join(""),
      start: cursor,
      // The charset is ASCII, so this lowercase is locale-independent — the
      // same reasoning as `normalizeUsername`.
      tag: tag.toLowerCase(),
    },
  };
}

function linkedSegments(text: string): Segment[] {
  // Array.from iterates Unicode code points rather than UTF-16 code units.
  // Boundary checks must see a supplementary-plane letter as one character;
  // indexing the string directly would inspect one surrogate half and let an
  // invalid adjacent mention or internationalized email through.
  const characters = Array.from(text);
  const segments: Segment[] = [];
  let textStart = 0;
  let cursor = 0;

  while (cursor < characters.length) {
    // A URL is tried first at every offset, so `https://example.com/@alice` is
    // one link rather than a link with a profile mention buried in its path —
    // and `https://example.com/page#anchor` keeps its fragment out of a tag
    // link the same way. A mention and a hashtag can never match at the same
    // offset (`@` versus `#`), so their relative order is immaterial.
    const match =
      matchUrl(characters, cursor) ??
      matchMention(characters, cursor) ??
      matchHashtag(characters, cursor);
    if (match === undefined) {
      cursor += 1;
      continue;
    }

    if (textStart < cursor) {
      segments.push({
        kind: "text",
        start: textStart,
        value: characters.slice(textStart, cursor).join(""),
      });
    }
    segments.push(match.segment);
    cursor = match.end;
    textStart = match.end;
  }

  if (textStart < characters.length) {
    segments.push({
      kind: "text",
      start: textStart,
      value: characters.slice(textStart).join(""),
    });
  }

  return segments;
}

function renderSegment(segment: Segment, gameMentions?: Record<string, string>): ReactNode {
  switch (segment.kind) {
    case "mention":
      return (
        <ProfileLink
          username={segment.username}
          className="text-link hover:text-link/80 underline underline-offset-2"
        >
          {segment.label}
        </ProfileLink>
      );
    case "url":
      // The label is what the author typed and the `href` is what the parser
      // made of it, so a percent-encoded or punycoded address still reads the
      // way it was written. `noopener`/`noreferrer` keep an untrusted
      // destination away from this tab and its URL; `nofollow ugc` states what
      // the link is.
      return (
        <a
          href={segment.href}
          target="_blank"
          rel="noopener noreferrer nofollow ugc"
          className="text-link hover:text-link/80 underline underline-offset-2"
        >
          {segment.label}
        </a>
      );
    case "hashtag": {
      // A RESOLVED tag is a link to its game's page (issue #314, Q3): the
      // server's per-batch map answers the canonical tag with the catalog's
      // slug, and that answer is the whole mechanism — nothing is guessed
      // client-side. Everything else keeps the original meaning: a link into
      // post search filtered to itself, the query carrying the `#` so it
      // matches hash-marked occurrences rather than the bare word. Post
      // search is a substring scan, so a longer tag (`#tag_expo`), a glued
      // word (`word#tag`) or a URL fragment still matches. The label stays
      // as typed while the link carries the canonical target, the same split
      // as a mention's label versus its `/@handle` href.
      const gameSlug = gameMentions?.[segment.tag];
      if (gameSlug !== undefined) {
        return (
          <Link
            to="/games/$slug"
            params={{ slug: gameSlug }}
            className="text-link hover:text-link/80 underline underline-offset-2"
          >
            {segment.label}
          </Link>
        );
      }
      return (
        <Link
          to="/search"
          search={{ q: `#${segment.tag}` }}
          className="text-link hover:text-link/80 underline underline-offset-2"
        >
          {segment.label}
        </Link>
      );
    }
    case "text":
      return segment.value;
  }
}

/**
 * Renders the three link shapes MyTuums recognizes inside otherwise plain,
 * author-written text: syntactically valid `@handles` as profile links,
 * absolute http(s) URLs as external anchors, and `#tags` as links into post
 * search filtered to the tag. Unknown handles deliberately link to the
 * canonical profile route, whose existing not-found state is the fallback;
 * malformed handles, malformed tags and every other scheme stay untouched
 * text. A tag has no minimum length, unlike a handle (`USERNAME_MIN_LENGTH`):
 * one character after the `#` is a complete tag, a deliberate asymmetry with
 * mentions. React text children keep the entire surface HTML-safe.
 *
 * Nothing here stops a click from bubbling: the surrounding surfaces that
 * navigate on click (`PostCard`) already ignore clicks landing inside an
 * anchor, so a link opens its destination and nothing else.
 */
export function LinkedText({
  text,
  gameMentions,
}: {
  text: string;
  gameMentions?: Record<string, string>;
}) {
  return linkedSegments(text).map((segment) => (
    <Fragment key={`${segment.kind}-${segment.start}`}>
      {renderSegment(segment, gameMentions)}
    </Fragment>
  ));
}

/**
 * The normalized `href` of the first URL this text links, or `null` — the one
 * URL a post may render a link preview card for (issue #260).
 *
 * Same scanner, same normalization, same scheme rule as {@link LinkedText}:
 * the card can only ever describe a URL the renderer itself would have
 * linked, so a `javascript:` or `data:` address is as inert here as it is
 * there, and the second and later URLs of a post are simply not asked about.
 */
export function firstLinkUrl(text: string): string | null {
  for (const segment of linkedSegments(text)) {
    if (segment.kind === "url") return segment.href;
  }
  return null;
}
