import { Fragment, type ReactNode } from "react";
import { Link, Text } from "react-email";
import { EmailButton, type EmailAction } from "./button.js";
import { MYTUUMS_EMAIL_THEME as theme } from "./theme.js";

/**
 * The copy renderer: plain-text paragraphs in, safe email HTML out.
 *
 * The locale-specific copy in `../email.ts` stays the source of truth for
 * both multipart parts. This module renders that same text for the HTML
 * part with three security behaviors the tests pin:
 *
 * - the primary action URL never appears as visible text — its paragraph
 *   line is dropped from the copy and the URL survives only as the CTA
 *   button's escaped `href` (arbitrary URLs in quoted user content stay
 *   visible as ordinary safe links);
 * - every other string reaches the client as React text children, so
 *   moderator- and author-supplied copy (reasons, quoted posts, notes) is
 *   escaped by construction rather than by a hand-rolled escaper;
 * - the OTP keeps its restrained code-chip emphasis, and the plain-text
 *   fallback keeps the clickable URLs the HTML hides.
 */
export type { EmailAction };

type Token = {
  start: number;
  end: number;
  value: string;
  kind: "url" | "otp";
};

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

/** Turns non-action URLs into safe links and gives the OTP its code-chip emphasis. */
function lineSegments(line: string, otp: string | undefined, keyPrefix: string): ReactNode[] {
  const urlTokens: Token[] = [...line.matchAll(URL_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    value: match[0],
    kind: "url",
  }));
  const tokens = [...urlTokens];

  if (otp) {
    let searchStart = 0;
    while (searchStart < line.length) {
      const start = line.indexOf(otp, searchStart);
      if (start === -1) break;

      const end = start + otp.length;
      const overlapsUrl = urlTokens.some((token) => start < token.end && end > token.start);
      if (!overlapsUrl) {
        tokens.push({ start, end, value: otp, kind: "otp" });
      }
      searchStart = end;
    }
  }

  tokens.sort((left, right) => left.start - right.start || right.end - left.end);

  const segments: ReactNode[] = [];
  let previousEnd = 0;

  for (const token of tokens) {
    if (token.start < previousEnd) continue;

    if (token.start > previousEnd) {
      segments.push(
        <Fragment key={`${keyPrefix}-t${previousEnd}`}>
          {line.slice(previousEnd, token.start)}
        </Fragment>,
      );
    }
    segments.push(
      token.kind === "otp" ? (
        <strong
          key={`${keyPrefix}-o${token.start}`}
          style={{
            display: "inline-block",
            padding: "3px 9px",
            border: `1px solid ${theme.border}`,
            borderRadius: "4px",
            backgroundColor: theme.codeBackground,
            color: theme.text,
            fontFamily: theme.codeFont,
            fontSize: "20px",
            fontWeight: 700,
            letterSpacing: "3px",
            lineHeight: "1.2",
          }}
        >
          {token.value}
        </strong>
      ) : (
        <Link
          key={`${keyPrefix}-u${token.start}`}
          href={token.value}
          style={{
            color: theme.primary,
            fontWeight: 600,
            textDecoration: "underline",
            overflowWrap: "break-word",
          }}
        >
          {token.value}
        </Link>
      ),
    );
    previousEnd = token.end;
  }

  if (previousEnd < line.length) {
    segments.push(
      <Fragment key={`${keyPrefix}-t${previousEnd}`}>{line.slice(previousEnd)}</Fragment>,
    );
  }
  return segments;
}

const PARAGRAPH_STYLE = {
  margin: "0 0 18px",
  color: theme.text,
  fontFamily: theme.font,
  fontSize: "15px",
  lineHeight: "1.65",
} as const;

/**
 * Preserves the plain-text copy's paragraph structure while keeping the
 * primary action URL out of visible HTML: the button lands exactly where the
 * URL's paragraph was, so the CTA reads before the fallback safety note.
 */
export function EmailCopy({
  text,
  action,
  otp,
}: {
  text: string;
  action?: EmailAction;
  otp?: string;
}): ReactNode {
  const actionUrl = action?.url;
  let actionRendered = false;
  const blocks: ReactNode[] = [];

  text.split(/\n{2,}/).forEach((paragraph, paragraphIndex) => {
    const lines = paragraph.split("\n");
    const containsAction =
      !actionRendered && actionUrl !== undefined && lines.some((line) => line.trim() === actionUrl);
    const renderedLines = lines
      .filter((line) => line.trim().length > 0 && line.trim() !== actionUrl)
      .map((line, lineIndex) => (
        <Fragment key={`p${paragraphIndex}-l${lineIndex}`}>
          {lineIndex > 0 ? <br /> : null}
          {lineSegments(line, otp, `p${paragraphIndex}-l${lineIndex}`)}
        </Fragment>
      ));

    if (containsAction) actionRendered = true;

    if (renderedLines.length > 0) {
      blocks.push(
        <Text key={`p${paragraphIndex}`} style={{ ...PARAGRAPH_STYLE }}>
          {renderedLines}
        </Text>,
      );
    }
    if (containsAction && action) {
      blocks.push(<EmailButton key={`p${paragraphIndex}-cta`} action={action} />);
    }
  });

  return <>{blocks}</>;
}
