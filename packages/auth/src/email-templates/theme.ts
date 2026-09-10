/**
 * `theme-mytuums` — the email theme for MyTuums mail, in emailcn's shape.
 *
 * emailcn (https://github.com/shadcn-labs/emailcn) ships one theme module
 * per brand (`theme-<id>`) plus composable primitives, installed with the
 * shadcn CLI. This package is not a shadcn project, so the theme and the
 * three primitives in this directory (`button.tsx`, `rich-text.tsx`,
 * `shell.tsx`) are owned copies in that pattern, not registry installs —
 * taking the whole registry would drag its marketing blocks and Tailwind
 * runtime along for twelve transactional emails that need none of it.
 *
 * Deliberate non-use: emailcn's `<Tailwind>` layer. The server bundle
 * (`apps/server/tsup.config.ts`) inlines this package, so the Tailwind
 * compiler would ship inside the production server image and run on every
 * send. The styles below are plain inline-style objects over these tokens —
 * the same output the Tailwind layer inlines to, without the compiler.
 *
 * Tokens match the app's light theme (`apps/branding/src/index.css`):
 * `--primary` is this `primary`, and mail is always light (the shell sets
 * `color-scheme: light`), so there is no dark variant to keep in step.
 */
export const MYTUUMS_EMAIL_THEME = {
  primary: "#c6005c",
  text: "#2d282b",
  muted: "#746b70",
  border: "#e7e0e4",
  background: "#f6f3f5",
  card: "#ffffff",
  codeBackground: "#fbf4f7",
  font: "Arial,Helvetica,sans-serif",
  codeFont: "'Courier New',Courier,monospace",
} as const;
