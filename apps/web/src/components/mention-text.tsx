import { Fragment } from "react";
import { Link } from "@tanstack/react-router";
import {
  isAllowedUsernameCharset,
  normalizeUsername,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "@my-tuums/auth/rules";

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

type Segment = TextSegment | MentionSegment;

const UNICODE_WORD_CHARACTER = /[\p{L}\p{M}\p{N}]/u;

function isUsernameCharacter(character: string | undefined): boolean {
  return character !== undefined && isAllowedUsernameCharset(character);
}

function isMentionWordCharacter(character: string | undefined): boolean {
  return (
    character !== undefined &&
    (isAllowedUsernameCharset(character) || UNICODE_WORD_CHARACTER.test(character))
  );
}

function mentionSegments(text: string): Segment[] {
  // Array.from iterates Unicode code points rather than UTF-16 code units.
  // Boundary checks must see a supplementary-plane letter as one character;
  // indexing the string directly would inspect one surrogate half and let an
  // invalid adjacent mention or internationalized email through.
  const characters = Array.from(text);
  const segments: Segment[] = [];
  let textStart = 0;
  let cursor = 0;

  while (cursor < characters.length) {
    if (
      characters[cursor] !== "@" ||
      characters[cursor - 1] === "@" ||
      isMentionWordCharacter(characters[cursor - 1])
    ) {
      cursor += 1;
      continue;
    }

    let end = cursor + 1;
    while (isUsernameCharacter(characters[end])) end += 1;

    const username = characters.slice(cursor + 1, end).join("");
    const hasValidLength =
      username.length >= USERNAME_MIN_LENGTH && username.length <= USERNAME_MAX_LENGTH;
    if (!hasValidLength || isMentionWordCharacter(characters[end])) {
      cursor = end;
      continue;
    }

    if (textStart < cursor) {
      segments.push({
        kind: "text",
        start: textStart,
        value: characters.slice(textStart, cursor).join(""),
      });
    }
    segments.push({
      kind: "mention",
      label: characters.slice(cursor, end).join(""),
      start: cursor,
      username: normalizeUsername(username),
    });
    cursor = end;
    textStart = end;
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

/**
 * Renders syntactically valid @handles as profile links inside otherwise plain
 * text. Unknown handles deliberately link to the canonical profile route,
 * whose existing not-found state is the fallback; malformed handles remain
 * untouched. React text children keep the entire surface HTML-safe.
 */
export function MentionText({ text }: { text: string }) {
  return mentionSegments(text).map((segment) => (
    <Fragment key={`${segment.kind}-${segment.start}`}>
      {segment.kind === "mention" ? (
        <Link
          to="/@{$username}"
          params={{ username: segment.username }}
          className="text-primary hover:underline"
        >
          {segment.label}
        </Link>
      ) : (
        segment.value
      )}
    </Fragment>
  ));
}
