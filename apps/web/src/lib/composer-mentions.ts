import { isAllowedUsernameCharset, USERNAME_MAX_LENGTH } from "@my-tuums/auth/rules";

/** The token currently being completed in a composer. */
export interface MentionToken {
  /** Inclusive offset of the `@` marker. */
  start: number;
  /** Exclusive offset of the whole contiguous handle token. */
  end: number;
  /** The prefix before the caret, without the `@` marker. */
  query: string;
}

const UNICODE_WORD_CHARACTER = /[\p{L}\p{M}\p{N}]/u;

function isWordCharacter(character: string | undefined): boolean {
  return (
    character !== undefined &&
    (isAllowedUsernameCharset(character) || UNICODE_WORD_CHARACTER.test(character))
  );
}

function characterBefore(value: string, offset: number): string | undefined {
  return Array.from(value.slice(0, offset)).at(-1);
}

/**
 * Finds the handle token containing a collapsed caret, if that caret is in a
 * plausible mention prefix. The scan includes the rest of the contiguous
 * handle after the caret so accepting a suggestion replaces the whole token
 * instead of duplicating its suffix when a user moves the caret back into it.
 */
export function mentionAtCaret(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null = selectionStart,
): MentionToken | null {
  if (selectionStart === null || selectionEnd === null || selectionStart !== selectionEnd) {
    return null;
  }

  const caret = Math.max(0, Math.min(selectionStart, value.length));
  let prefixStart = caret;
  while (prefixStart > 0 && isAllowedUsernameCharset(value[prefixStart - 1] ?? "")) {
    prefixStart -= 1;
  }

  if (value[prefixStart - 1] !== "@") return null;

  const start = prefixStart - 1;
  if (value[start - 1] === "@" || isWordCharacter(characterBefore(value, start))) return null;
  const query = value.slice(prefixStart, caret);
  if (query.length === 0 || query.length > USERNAME_MAX_LENGTH) return null;

  let end = caret;
  while (end < value.length && isAllowedUsernameCharset(value[end] ?? "")) end += 1;
  const wholeTokenLength = end - start - 1;
  if (wholeTokenLength > USERNAME_MAX_LENGTH || isWordCharacter(Array.from(value.slice(end))[0])) {
    return null;
  }

  return { start, end, query };
}

/** The result of replacing one mention token, including the caret destination. */
export interface MentionInsertion {
  value: string;
  caret: number;
}

/**
 * Replaces only the active token, preserving all text before and after it.
 * Handles are supplied without `@` so callers cannot accidentally create a
 * double marker from a search result's display value.
 */
export function insertMention(
  value: string,
  token: MentionToken,
  handle: string,
): MentionInsertion {
  const mention = `@${handle}`;
  const nextValue = `${value.slice(0, token.start)}${mention}${value.slice(token.end)}`;
  return { value: nextValue, caret: token.start + mention.length };
}
