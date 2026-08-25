import { Fragment } from "react";
import type { ReactNode } from "react";
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

type Segment = TextSegment | MentionSegment | UrlSegment;

/** A recognized token, and the offset the scan resumes at after it. */
type Match = {
  end: number;
  segment: MentionSegment | UrlSegment;
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
 * character, or any Unicode letter, mark or number. Both recognizers share it,
 * so `name@example.com` stays an address and `seehttps://example.com` stays a
 * typo.
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
    // one link rather than a link with a profile mention buried in its path.
    const match = matchUrl(characters, cursor) ?? matchMention(characters, cursor);
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

function renderSegment(segment: Segment): ReactNode {
  switch (segment.kind) {
    case "mention":
      return (
        <ProfileLink username={segment.username} className="text-primary hover:underline">
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
          className="text-primary hover:underline"
        >
          {segment.label}
        </a>
      );
    case "text":
      return segment.value;
  }
}

/**
 * Renders the two link shapes MyTuums recognizes inside otherwise plain,
 * author-written text: syntactically valid `@handles` as profile links, and
 * absolute http(s) URLs as external anchors. Unknown handles deliberately link
 * to the canonical profile route, whose existing not-found state is the
 * fallback; malformed handles and every other scheme stay untouched text.
 * React text children keep the entire surface HTML-safe.
 *
 * Nothing here stops a click from bubbling: the surrounding surfaces that
 * navigate on click (`PostCard`) already ignore clicks landing inside an
 * anchor, so a link opens its destination and nothing else.
 */
export function LinkedText({ text }: { text: string }) {
  return linkedSegments(text).map((segment) => (
    <Fragment key={`${segment.kind}-${segment.start}`}>{renderSegment(segment)}</Fragment>
  ));
}
