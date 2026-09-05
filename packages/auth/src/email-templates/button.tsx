// The default React import is load-bearing under `tsx`: files outside
// `apps/server`'s `include` compile as classic JSX (`React.createElement`),
// so rendering without it throws `React is not defined` in dev/E2E while the
// `tsup` production bundle (automatic runtime) works fine. Referenced as
// `<React.Fragment>` (not a bare `Fragment` import) so the import counts as
// used under `noUnusedLocals` in the web typecheck, which sees these sources
// transitively via `@my-tuums/api`.
import React, { type ReactNode } from "react";
import { MYTUUMS_EMAIL_THEME as theme } from "./theme.js";

/**
 * The primary action of an email — the capability URL (verification,
 * password reset, appeal) behind a localized CTA label.
 *
 * The URL lives in the anchor `href` only and never as visible text; the
 * plain-text fallback carries the clickable URL instead. See `rich-text.tsx`.
 */
export interface EmailAction {
  url: string;
  label: string;
}

/**
 * The emailcn button section, owned: a table-backed CTA so the padding and
 * fill survive Outlook and webmail, which ignore padding on inline anchors.
 * A bare `react-email` Button renders an anchor alone and degrades to a flat
 * link there — same label, much smaller target.
 */
export function EmailButton({ action }: { action: EmailAction }): ReactNode {
  return (
    <React.Fragment>
      <table
        role="presentation"
        cellSpacing="0"
        cellPadding="0"
        border={0}
        style={{ borderCollapse: "separate", margin: "4px 0 12px" }}
      >
        <tr>
          {/* No `bgcolor` attribute: React 19 types dropped it. The inline
            `background-color` below fills the cell in the same clients. */}
          <td align="left" style={{ borderRadius: "6px", backgroundColor: theme.primary }}>
            <a
              href={action.url}
              style={{
                display: "inline-block",
                padding: "12px 20px",
                border: `1px solid ${theme.primary}`,
                borderRadius: "6px",
                backgroundColor: theme.primary,
                color: "#ffffff",
                fontFamily: theme.font,
                fontSize: "14px",
                fontWeight: 700,
                lineHeight: "1.2",
                textDecoration: "none",
                boxSizing: "border-box",
              }}
            >
              {action.label}
            </a>
          </td>
        </tr>
      </table>
    </React.Fragment>
  );
}
