# apps/branding context

## Responsibility

The public landing site served at `home.mytuums.com` ("The social media, for
gamers"). A second, deliberately tiny Vite app — one page, no router, no
state library, no API client — that shares the SPA's entire visual system
(Tailwind v4, the shadcn preset in `components.json`, Inter Variable, the
theme tokens copied verbatim into `src/index.css`) and its Paraglide en/fr
pipeline. The server serves this app's build when `Host` is the branding
hostname — see `apps/server/src/branding-host.ts`.

## Start here

| File               | Why                                                               |
| ------------------ | ----------------------------------------------------------------- |
| `src/app.tsx`      | The page composition: header, hero, features, CTA, footer.        |
| `messages/*.json`  | Every string the site renders, en and fr.                         |
| `src/lib/site.ts`  | `APP_ORIGIN` and the absolute sign-in/sign-up links.              |
| `src/lib/theme.ts` | Light/dark handling over the app's `mytuums-ui-theme` vocabulary. |

## Change map

| Intent                    | Primary                                                        | Also touch                                                            |
| ------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| Change landing copy       | `messages/en.json`, `fr.json`                                  | regenerate Paraglide; `index.html`'s static head if the tagline moves |
| Change the page structure | `src/app.tsx`, `src/components/`                               | —                                                                     |
| Add a UI primitive        | `pnpm --filter @my-tuums/branding exec shadcn add <component>` | never hand-write into `src/components/ui`                             |
| Change theme behavior     | `src/lib/theme.ts`                                             | `apps/web/src/atoms/theme.ts` keeps the vocabulary                    |

## Invariants

- **No router, no Jotai, no workspace imports.** The site links into the app
  with absolute URLs and renders no viewer-relative state; a dependency that
  creeps in here ships to every visitor of the landing page.
- **Every string goes through Paraglide** — en and fr stay complete, and the
  language menu switches by `setLocale` exactly like the app's footer.
- **No inline scripts in `index.html`** — the enforced CSP has no inline
  allowance; the bundle's same-origin module scripts are already covered.
- **The CTA links are absolute to the apex** (`src/lib/site.ts`): a relative
  link would strand a visitor on a host where the app is never served and
  session cookies do not exist.
- **The social URLs exist in exactly two places that must agree**: the
  footer's `SOCIAL_LINKS` (`src/components/social-links.tsx`) and the app's
  Organization JSON-LD `sameAs` (`apps/web/index.html`); the JSON-LD in this
  app's own `index.html` mirrors the same list.
- **`public/robots.txt`, `sitemap.xml` and `llms.txt` are the crawler- and
  agent-facing surface** — absolute `https://home.mytuums.com/` URLs only,
  and `Allow: /` for every user agent, AI crawlers included.

## Generated files

| Path            | Generator                                                                  | If it is missing                        |
| --------------- | -------------------------------------------------------------------------- | --------------------------------------- |
| `src/paraglide` | the Paraglide Vite plugin, or `pnpm --filter @my-tuums/branding paraglide` | `tsc` cannot resolve a message function |

Git-ignored, and why `lint` and `typecheck` depend on `build` in
`turbo.json` — same arrangement as `apps/web`.

## Verification

| Command                                               | Covers                |
| ----------------------------------------------------- | --------------------- |
| `pnpm --filter @my-tuums/branding build`              | the production bundle |
| `pnpm --filter @my-tuums/branding dev`                | dev server on `:5174` |
| `pnpm --filter @my-tuums/branding lint` / `typecheck` | this package alone    |

There is no test suite: the site is presentational, host routing is pinned
in `apps/server/src/request-handler.test.ts`, and the static handler it is
served through is pinned in `apps/server/src/static-files.test.ts`.
