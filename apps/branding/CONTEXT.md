# apps/branding context

## Cloudflare deployment

Production serves `about.mytuums.com` with product links to `mytuums.com`.
The separate PoC serves `about-cf-poc.mytuums.com` with links to
`cf-poc.mytuums.com`, a disallow crawler policy and mandatory Access.
Production emits its public crawler documents and uses the fixed public origin.

`wrangler.production.jsonc` and `wrangler.jsonc` declare separate Worker names
and Custom Domains. Both disable workers.dev and version preview URLs.
`worker/index.ts` verifies the exact origin and, for PoC, the Access JWT before
serving any asset. Public admission is restricted to the fixed production host.
It reuses the server's Access verifier as a server-side dependency only.
Keep `run_worker_first: true`, `html_handling: none` and `not_found_handling: none`.
Only `/` maps to `/index.html`; missing paths stay 404. Responses are private,
uncached and carry restrictive security headers. Only GET/HEAD are accepted.
Logs contain a failure event and generated request ID; invocation logs are off
and query-string redaction is enabled in native observability.

`pnpm --filter @my-tuums/branding build` builds Vite assets and performs a Wrangler
dry run. It does not publish. `pnpm --filter @my-tuums/branding types` regenerates
`worker/worker-configuration.d.ts` with string-valued variables for the explicit
PoC and production configurations; runtime exact-origin validation remains
authoritative. Run `pnpm format` afterward. Typechecking covers
the browser and Worker independently. The native security/build test lives at
`apps/server/src/native-branding.test.ts`; run it through the server's Vitest
command after building branding. It executes the actual Wrangler bundle with
the built Vite assets and real local asset routing, using ephemeral Access keys.
This proves local behavior, not live Access or Workers Builds configuration.
Remote deployment and the branch-restricted build still need setup.

## Responsibility

The Access-protected landing site served at `about-cf-poc.mytuums.com` ("The social media, for
gamers"). A second, deliberately tiny Vite app — one page, no router, no
state library, no API client — that shares the SPA's entire visual system
(Tailwind v4, the shadcn preset in `components.json`, Inter Variable, the
theme tokens copied verbatim into `src/index.css`) and its Paraglide en/fr
pipeline. The native branding Worker serves the build after Access validation.

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

- **No router, no Jotai, no workspace imports in the browser.** The site links into the app
  with absolute URLs and renders no viewer-relative state; a dependency that
  creeps in here ships to every visitor of the landing page.
- **Every string goes through Paraglide** — en and fr stay complete, and the
  language menu switches by `setLocale` exactly like the app's footer.
- **No inline scripts in `index.html`** — the enforced CSP has no inline
  allowance; the bundle's same-origin module scripts are already covered.
- **The CTA links are absolute to the configured app origin** (`src/lib/site.ts`): a relative
  link would strand a visitor on a host where the app is never served and
  session cookies do not exist.
- **The social URLs exist in exactly two places that must agree**: the
  footer's `SOCIAL_LINKS` (`src/components/social-links.tsx`) and the app's
  Organization JSON-LD `sameAs` (`apps/web/index.html`); the JSON-LD in this
  app's own `index.html` mirrors the same list.
- **`crawler-documents/` owns the production robots, sitemap and llms documents.**
  The shared Vite crawler-documents plugin emits these only for production;
  private builds emit a disallow policy and empty sitemap.

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

The browser remains presentational. The native branding test described above
pins its deployed artifact and asset admission boundary.

## Production build

`VITE_WEB_ORIGIN=https://mytuums.com` selects production app links and branding
metadata. `wrangler.production.jsonc` serves `about.mytuums.com` publicly, with
exact-host and GET/HEAD guards. Only that fixed origin with `ACCESS_MODE=public`
can omit Access. PoC continues to require its Access JWT on every asset.
