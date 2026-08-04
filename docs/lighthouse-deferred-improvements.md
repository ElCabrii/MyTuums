# Lighthouse deferred improvements — implementation plan

**Status (2026-08-04):** the cheap, low-risk items are now implemented in the `feat/lighthouse-deferred` PR — item 5 Phase 1 (security headers: nosniff, Referrer-Policy, X-Frame-Options, HSTS — set once via `apps/server/src/response-decorators.ts`, which wraps the `res` every handler writes through), item 7c (`/rpc` JSON gzip/brotli at the same choke point, sharing the q-value parser extracted into `apps/server/src/compression.ts`), item 4 Phase A + 7b (build-time `modulepreload` for the lazy login chunk and an Inter latin preload, via `apps/web/build-inject-plugin.ts`), item 2 Phase A (non-blocking stylesheet load), and item 7a (dark-mode wordmark contrast). Items 1 and 3 are conclusions, not code, and are recorded in this document itself. Everything else — CSP/COOP (item 5 Phases 2–3), the login static shell (item 4 Phase B), critical-CSS extraction (item 2 Phase B), the CI perf gate (item 6) — remains deferred exactly as drafted below.

**Date:** 2026-08-04
**Derived from:** the Lighthouse audit whose fixes landed in the `ci/security-scan-diagnostics` worktree (scores after the pass: mobile performance 87, desktop 99, accessibility / best-practices / SEO 100). This document covers the six improvements deliberately deferred as "bigger than a perf pass", plus one bundle of smaller leftovers.
**Rule of this document:** each section says whether the work is already planned in a GitHub issue, then gives a concrete plan. Issue drafts for unplanned items live in the last section, ready to copy-paste. **No issues were created** — filing is the repo owner's call.

**Issue verification:** all open issues were read in full via `gh issue list --state open` (5 open: #21, #22, #24, #27) plus a keyword search (`perf OR performance OR lighthouse OR HTTP/2 OR CSP OR security header OR bundle OR paraglide OR i18n OR LCP OR critical css` — no matches). `gh project list` could not run (token lacks `read:project` scope); issue-list coverage is complete regardless. **No existing issue covers any item below.** The two open security bugs (#21 chunked-body cap bypass, #22 rate-limiter map growth) are adjacent but distinct scope.

| # | Item | Issue status |
|---|------|--------------|
| 1 | HTTP/2 (local-only limitation) | No existing issue — draft below (recommendation: document, don't build) |
| 2 | Critical / split CSS | No existing issue — draft below |
| 3 | Paraglide dual-locale main-chunk footprint | No existing issue — draft below (recommendation: accept + document, optional chunk merge) |
| 4 | Static HTML shell for auth pages | No existing issue — draft below |
| 5 | Security headers (CSP, XFO, HSTS, COOP) | No existing issue — draft below |
| 6 | CI performance budgets (LHCI) | No existing issue — draft below |
| 7 | Leftovers bundle (wordmark contrast, fonts, /rpc gzip, forced reflow) | No existing issue — draft below |

---

## 1. HTTP/2

**Status:** No existing issue — draft below.

**Goal:** Decide whether the HTTP/1.1 origin server is worth upgrading, or whether the local-only queue is worth documenting instead.

**Facts from the code (verified):**
- The server is `node:http` `createServer` at `apps/server/src/index.ts:85`. Transport is HTTP/1.1; the ~20 script requests on `/login` (578 KB main chunk + `login-*.js` route chunk + ~15 tiny per-key paraglide message chunks, e.g. 195-byte `auth_log_in-*.js`) queue on 6 connections — that is what the mobile audit saw.
- **Browsers never connect to this server directly in production.** Railway's edge terminates TLS and serves the browser HTTP/2; the origin link is one long-lived connection, so the 6-connection cap cannot bind there. The dev path is the same story: the browser talks to Vite (port 5173/5273), which is also HTTP/1.1 — an h2 origin would not change that either.
- The limitation only binds when a browser hits the origin directly — i.e. a local Lighthouse run (`pnpm lighthouse` → `http://localhost:3001/`) or a raw `docker run`.

**Approach (recommended):** Document, don't build.
1. Add a note to `docs/` or the server's header comment in `apps/server/src/index.ts`: "HTTP/1.1 by design; browsers get HTTP/2 from the Railway edge; the 6-connection queue is a local-only artefact of auditing the origin directly."
2. Attack the *count* side instead — it helps every environment: merge the per-key paraglide chunks (see item 3, option b). ~15 tiny message requests collapsing into 1 makes the h1 queue mostly moot locally too.
3. Explicitly do **not** adopt `node:http2` + `createSecureServer` with a self-signed cert for local audits: it would require cert generation, Chrome/`--ignore-certificate-errors` handling, and rework of the graceful-shutdown path in `index.ts` — for a number that is already 87 mobile / 99 desktop and means nothing in production. The transport-agnostic handler types (`IncomingMessage`/`ServerResponse` in `request-handler.ts`) keep the swap contained to `index.ts` if this is ever revisited, but there is no scenario today where the browser faces the origin.

**Risks / trade-offs:** None for documenting. The queue cost remains for direct-origin audits; it is bounded and local.

**Effort:** S.

---

## 2. Inline / split critical CSS

**Status:** No existing issue — draft below.

**Goal:** Remove the last render-blocking resource, or decide the cost is acceptable.

**Facts from the code (verified):**
- One stylesheet: `apps/web/dist/assets/index-RSuY3-Mz.css`, 67,194 B, 798 rules, ~11.6 KB gzipped. Tailwind v4 (`@import "tailwindcss"` at `apps/web/src/index.css:1`) emits one app-wide stylesheet; there is no per-route CSS splitting to configure.
- The cold-load splash is **already inline** in `apps/web/index.html` — first paint is not blocked by the stylesheet. What the stylesheet blocks is the styled first paint of the login page *after* the splash lifts (the audit's render-blocking-insight score 0 refers to the whole sheet being render-blocking).
- Real transfer cost of the sheet: ~11.6 KB gz — roughly one round trip on mobile 4G plus parse. Small, but it sits in the critical path of every page.

**Approach (phased):**
- **Phase A (cheap, do first):** non-blocking load via `media="print" onload` swap in `apps/web/index.html` (replace the `<link rel="stylesheet">` with `media="print" onload="this.media='all'"` + `<noscript>` fallback). FOUC risk is limited in practice: the splash is inline-styled and hides the document until the session settles, and the sheet starts downloading with the HTML, so it is applied within the same window it would have been before.
- **Phase B (only if Lighthouse still flags it):** true critical-CSS extraction. Tailwind's 798 rules are not analyzable statically against an empty SPA shell, so extraction needs a rendered DOM: a post-build script that loads `/login` headlessly (the repo already has Playwright), collects the rules the above-the-fold DOM uses, inlines ~2–3 KB into `index.html`, and defers the rest (Phase A's trick). This is a new small tool in `apps/web`, not a Vite plugin change.
- **Phase C (fallback):** accept. 11.6 KB gz on HTTP/2 in production is a small, fixed cost, and the splash already gives an unstyled-first-frame-safe cold load.

**Risks / trade-offs:** Phase A trades a blocked first paint for a possible one-frame flash of the *login card* without its background (the splash itself cannot flash). Phase B adds a build step that must stay green with the rest of CI and can silently go stale if the login markup changes; keep the extraction threshold generous.

**Effort:** Phase A S; Phase B M; Phase C zero.

---

## 3. Paraglide dual-locale bundle footprint

**Status:** No existing issue — draft below.

**Goal:** Verify the remaining main-chunk i18n footprint and decide whether per-route splitting or locale stripping is feasible.

**Facts from the code (verified):**
- Per-key message modules **already exist**: 491 modules in `apps/web/src/paraglide/messages/`, emitted as their own tiny chunks (e.g. `auth_log_in-D2K63Bl7.js`, 195 B) that load only on the routes that use them. The login page already loads only its message chunks.
- Each compiled message module embeds **both** locales inline — `en_nav_home` and `fr_nav_home` functions in one module (verified in `apps/web/src/paraglide/messages/nav_home.js`). The dual-locale cost is per-message, not two whole catalogues.
- The **main chunk** (`index-Ri8lTyIn.js`, 578 KB) carries the app-shell messages (nav/theme/locale/footer/legal/user/common/app_* used by `__root`/header/footer) with both locales — `"Accueil"` and `"Découvrir"` confirmed inside the built bundle. That is the ~35 KB raw (~9 KB gz) the audit flagged. Separately, `paraglide/runtime.js` compiles to ~64 KB and also lands in the main chunk.
- Locale resolution is runtime-cookie-driven: strategy `["cookie", "globalVariable", "baseLocale"]`, `PARAGLIDE_LOCALE` cookie, `setLocale()` reloads the document (`project.inlang/settings.json`; `src/paraglide/runtime.js`). There is no URL locale (`/privacy` is the same URL in both languages by design).

**Approach (recommended):**
1. **Accept and document** the main-chunk footprint: ~9 KB gz ≈ 6% of the main chunk's transfer. Log the numbers (and the per-message dual-locale shape) next to the orphan-grep hygiene note in CLAUDE.md's i18n section.
2. **Locale stripping is not feasible** without breaking the cookie-driven runtime switch: a single-locale build would need per-locale builds served by cookie or URL, which conflicts with the deliberate no-URL-locale design and doubles every deploy. Document this conclusion so nobody re-opens it blindly.
3. **Optional (M), and worth doing for item 1's queue:** consolidate the ~15 per-key message chunks that `/login` and `/` fetch into one `i18n` chunk via `build.rollupOptions.output.manualChunks` in `apps/web/vite.config.ts` (match `/src/paraglide/messages/`). Trade-off: a visitor downloads a few message chunks they may not need; in exchange, ~15 tiny HTTP/1.1-queued requests become 1. Measure the request waterfall before/after.

**Risks / trade-offs:** manualChunks on the paraglide dir must not accidentally merge chunks the route-splitting relies on for laziness (the shell messages stay in the main chunk regardless). Verify with a build + `ls dist/assets` and a `-r` headless network capture.

**Effort:** Accept+document S; chunk consolidation M.

---

## 4. Static HTML shell for auth pages (LCP)

**Status:** No existing issue — draft below.

**Goal:** Make the `/login` heading (the LCP element) paint without waiting for JS download + eval + session round trip.

**Facts from the code (verified):**
- The built `apps/web/dist/index.html` has **zero preload/modulepreload hints** — just the entry script tag. `/login`'s LCP (`auth_login_title`: "Welcome Back" / "Bon retour" — `apps/web/messages/{en,fr}.json`) paints only after: main chunk download/parse/eval → router init → dynamic import of `login-CAYpGhMu.js` + message chunks → React mount. Desktop LCP 0.9 s, mobile 3.2 s (lab-throttled).
- `index.html` deliberately carries exactly one non-i18n string — "Loading" in the splash — because Paraglide compiles into the bundle (`apps/web/index.html:24-25`). A static shell that hand-copies the heading would break that invariant and could drift from the catalogue.
- The splash is removed by `sessionSettledEffect` (`apps/web/src/atoms/session.ts:85`) the moment the first `/get-session` lands; `__root.tsx` renders nothing until then. On `/login` the splash currently covers an empty page for the whole round trip.
- `apps/server/src/static-files.ts` already branches per pathname (extension-less paths get the SPA fallback), so serving a per-route HTML variant is a small change.

**Approach (phased):**
- **Phase A (cheap, zero risk — do first):** build-time preload injection. A tiny Vite plugin (or post-build script) in `apps/web` that, after `vite build`, rewrites `dist/index.html` to add `<link rel="modulepreload" href="/assets/login-CAYpGhMu.js">` plus its message-chunk preloads, read from the build manifest/asset dir. The login route chunk then fetches in parallel with the main chunk instead of serially after router init. No HTML string changes, no invariant breakage. **S–M.**
- **Phase B (the real LCP win):** static shell for `/login`. Serve an index variant whose splash *is* the login heading:
  - `static-files.ts` serves a `login-shell.html` for pathname `/login` (locale from the `PARAGLIDE_LOCALE` cookie; default `en`).
  - The shell strings are **generated at build time from the catalogues** (a Vite plugin or build script injects `auth_login_title`/`auth_login_subtitle` for the chosen locale into the template) so the "Loading" invariant becomes "generated from the catalogue, never hand-typed" — drift becomes impossible by construction.
  - The heading lives inside `#app-splash`, which `sessionSettledEffect` already removes wholesale, so no new removal logic is needed; React's own heading replaces it seamlessly.
  - Keep it to the heading (and subtitle) only; no form, no inputs — a shell that duplicates the form would be a maintenance and a11y liability (duplicate fields).
- **Phase C (fallback):** accept — desktop LCP 0.9 s is already good; 3.2 s is the throttled-lab number, and the redirect `302 / → /login` (already server-side for cookie-less visitors, `request-handler.ts:129`) is what most cold sessions actually experience.

**Risks / trade-offs:** Phase B breaks the "one non-i18n string" invariant *for `/login` only*, in a controlled way (generated, not hand-copied). `html lang` stays `en` until JS (`localeDocumentEffect`) — acceptable. The shell heading must not be focusable/duplicated in the a11y tree while the splash is `aria-busy` — keep the shell static text (no links) and let `role="status"` semantics carry it. Extend to `/register` only if `/login` proves out.

**Effort:** Phase A S–M; Phase B M; Phase C zero.

---

## 5. Security headers (CSP, X-Frame-Options, HSTS, COOP)

**Status:** No existing issue — draft below.

**Goal:** Back Lighthouse's four informative security audits with real headers, in phases that cannot break OAuth or One Tap.

**Facts from the code (verified):**
- No security headers exist anywhere. Responses are written from: `request-handler.ts` (health, `/` redirect, 413, 405, media 302, 404, 500), `static-files.ts` `send()`, the BetterAuth node handler, and the oRPC node adapter — which itself wraps `res.end` (verified in `@orpc/server/dist/adapters/node/index.mjs`), i.e. **everything goes through the `ServerResponse`**.
- **Single implementation point:** wrap `res.writeHead` (and, for item 7's gzip, `res.end`) once inside the `createServer` callback at `apps/server/src/index.ts:85-87`. One wrapper covers health, auth, rpc, media, static and 404 — no per-branch edits, and unit tests for `request-handler.ts` stay untouched (the wrapper lives above it).
- Google One Tap: the GSI script (`https://accounts.google.com/gsi/client`) is injected at runtime by better-auth's one-tap client (verified `node_modules/better-auth/dist/plugins/one-tap/client.mjs` — `createElement("script")` + `appendChild`), gated client-side on the returning-visitor cookie `mytuums_returning` (`apps/web/src/lib/returning-visitor.ts:14`, set in `atoms/session.ts`). That cookie is client-set, `SameSite=Lax`, `path=/` — **it is sent to the server**, so the server can vary the CSP per request to match exactly when GSI is allowed to run. GSI also renders an iframe (`frame-src`) and Google avatar URLs come from `lh3.googleusercontent.com` (`img-src`).
- COOP: OAuth uses full-page redirects (not popups), so `same-origin` should not disturb sign-in — but it must be verified end-to-end before shipping.

**Approach (phased):**
- **Phase 1 — cheap, non-negotiable headers (S):**
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `X-Frame-Options: DENY` (fallback; the modern form is `frame-ancestors 'none'` in Phase 2's CSP)
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains` — browsers ignore HSTS received over plain HTTP, so it is harmless on localhost and effective once the edge forwards it. Consider `preload` only after confirming every host (custom domain + `*.up.railway.app`) is TLS.
  - Assert the four headers in the e2e `api` project (e.g. `e2e/tests/api/*.spec.ts`), which already hits the server directly over a real socket.
- **Phase 2 — CSP (M):** baseline for everyone:
  ```
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';   /* inline splash <style> in index.html + React style attributes */
  img-src 'self' data: blob: https://lh3.googleusercontent.com;
  font-src 'self' data:;
  connect-src 'self';
  form-action 'self' https://accounts.google.com https://discord.com https://www.twitch.tv;
  base-uri 'none';
  frame-ancestors 'none';
  ```
  Then, **only when the request carries `mytuums_returning`** (the server can read it — see above), extend with `https://accounts.google.com` in `script-src` and `frame-src` (plus `https://ssl.gstatic.com` if the DevTools network capture during a One Tap prompt shows it — verify before finalizing). This makes the strict default the common case and the Google allowances exactly co-extensive with the moment the app actually injects the GSI script. No `unsafe-inline`/`unsafe-eval` in `script-src`. OAuth full-page redirects are navigations, not fetches — they need no CSP allowances beyond `form-action` if better-auth ever POSTs a form (verify once).
- **Phase 3 — COOP (S after testing):** `Cross-Origin-Opener-Policy: same-origin`. Required test matrix before shipping: full OAuth round trips (Google, Discord, Twitch), the One Tap prompt (iframe — COOP does not govern iframes), password-reset links, and the `errorCallbackURL` cross-origin `?error=` flow. If anything uses `window.open`/popup semantics (better-auth redirect mode does not), fall back to `same-origin-allow-popups` or drop COOP.

**Risks / trade-offs:** CSP is the risky one — a wrong directive silently kills One Tap (fire-and-forget by design, so it fails quietly; that is the point of testing the cookie-gated allowances explicitly). HSTS is a slow-burning change (a bad `max-age` lasts a year on clients) — start with a short `max-age` if the domain story is not final. The writeHead wrapper must merge, never overwrite, headers that inner handlers set (e.g. media 302s).

**Effort:** Phase 1 S; Phase 2 M; Phase 3 S (plus the manual test matrix).

---

## 6. CI performance budgets

**Status:** No existing issue — draft below.

**Goal:** Gate PRs on Lighthouse numbers so the 87/99 scores cannot silently regress.

**Facts from the code (verified):**
- `package.json` already carries `lighthouse@^13.4.1` and the `lighthouse` / `lighthouse:desktop` scripts, targeting `http://localhost:3001/` — which serves the SPA because the Dockerfile bakes `WEB_DIST` (`apps/server/Dockerfile:69`) and the compose `server` container inherits it. So the local scripts audit the production-shaped build; CI can do the same.
- `ci.yml` has five jobs. The `docker` job (lines 213–256) already builds the image with buildx + `cache-from: type=gha` and asserts the bundle/migrations. The `e2e` job brings up a stack — but the **dev-mode** stack (Vite dev server + `tsx`, `e2e/playwright.config.ts` `webServer`), which is not representative for performance budgets.

**Approach:**
1. **New `perf` job in `.github/workflows/ci.yml`** (sixth job): mirror the `docker` job's build steps (gha cache makes the rebuild cheap), add the Postgres service copied from the `integration` job, then:
   ```
   docker run --rm -d -p 3001:3001 -e DATABASE_URL=... -e BETTER_AUTH_SECRET=... -e BETTER_AUTH_URL=http://localhost:3001 -e WEB_ORIGIN=http://localhost:3001 mytuums-server:ci
   (curl retry loop against /health)
   npx lighthouse http://localhost:3001/login --preset=desktop --budgets-file=lighthouse-budgets.json --output=json --output-path=lighthouse-reports/desktop.json
   npx lighthouse http://localhost:3001/login --output=json --output-path=lighthouse-reports/mobile.json   # default = mobile + simulated throttling
   (fail job if either run exits non-zero; upload lighthouse-reports/ as an artifact)
   ```
   Two runs (desktop + mobile) match the audit methodology; simulated throttling is deterministic enough for budgets on the same runner class.
2. **`lighthouse-budgets.json` at the repo root** (checked in): metric budgets, generous at first, tightened as data accumulates — desktop LCP `error: 2.0s` / `warn: 1.2s`, mobile LCP `error: 3.5s` / `warn: 2.5s` (audited 3.2 s), mobile TBT `error: 300ms`, CLS `error: 0.1`, total-weight budget `error: 450 KB` (gz) with per-path entry for `/login` if the format supports it. CI-machine variance argues for "fail on error, warn on warn" rather than tight absolute numbers.
3. **Do not reuse the e2e job** for perf: it serves dev-mode; budgets against the Vite dev server would measure the wrong thing and be flaky.

**Risks / trade-offs:** A perf gate is only as stable as its budget; expect one or two tuning commits after the first runs. The job adds ~2–3 minutes of CI (build with cache + two audits). Treat the budget file as the single source of truth and point the local `lighthouse` scripts' `--budgets-file` at it too, so humans and CI agree.

**Effort:** M.

---

## 7. Leftovers bundle

**Status:** No existing issue — draft below.

### 7a. Header wordmark contrast (dark mode)
- **Facts:** `apps/web/src/components/header.tsx:41` — the wordmark `<span>` uses `text-primary` at 20 px bold (`text-xl font-bold` = 24 px effective → large-text rule, needs 3:1). Dark primary `oklch(0.459 0.187 3.815)` on dark background `oklch(0.141 0.005 285.823)` (`apps/web/src/index.css:102,96`) measures ~2.5:1 — the audit's flag. Light mode is fine (only dark is flagged).
- **Fix:** one class change — `dark:text-foreground` on the wordmark span (`tailwindcss` dark variant is already wired: `@custom-variant dark` in `index.css:6`). The logo image keeps the brand red; the wordmark reads at ~15:1 in dark mode. Light mode unchanged. Optionally add a `--wordmark` token if the brand later wants a dark-specific accent (the `--link` token, 5.02:1, is the precedent for "lighter red for text" — `index.css:104-106`). Effort S.

### 7b. Font preload / subsetting (Inter Variable)
- **Facts:** `apps/web/src/index.css:4` imports `@fontsource-variable/inter` → its `index.css` declares **all** subsets with `unicode-range`, so downloads are already subset-driven: en/fr text fetches only `inter-latin-wght-normal.woff2` (48 KB — the dominant, necessary transfer; `latin-ext` 84 KB only if a glyph outside the latin range appears, e.g. œ). The audit's 48 KB is the latin subset, not waste.
- **Plan:** (1) confirm with a DevTools network capture that only latin (+ latin-ext if used) download — document the finding; (2) optionally preload the latin woff2 (`<link rel="preload" as="font" type="font/woff2" crossorigin>`) via the same build-time injection plugin as item 4 Phase A, shaving the font's swap-in after first paint; (3) do **not** drop the non-latin subsets — user-generated content (bios, posts) can carry any script, and falling back to system fonts there is a product decision, not a perf one. `font-display: swap` is already in the fontsource CSS, so invisible-text is not a risk. Effort S.

### 7c. Compression for /rpc JSON responses
- **Facts:** only static files are compressed (`preferredEncoding` + `COMPRESSIBLE_EXTENSIONS` in `apps/server/src/static-files.ts:49-92`). oRPC JSON responses (feed payloads — the largest text on the wire after the bundle) go out identity-encoded. The oRPC node adapter writes via `res.end` (verified), so the same single-point `res.end`/`writeHead` wrapper as item 5 sees every response.
- **Plan:** in the `createServer` wrapper (`apps/server/src/index.ts:85`), when `accept-encoding` allows br/gzip and the response Content-Type is `application/json` (skip 302s — no body, and skip tiny bodies below a ~1 KB threshold like `/health`), pipe the body through `node:zlib` and set `Content-Encoding` + `Vary: Accept-Encoding`. Reuse the `preferredEncoding` logic by extracting it from `static-files.ts` into a shared module (or duplicating the q-value parser — extraction is cleaner). oRPC responses are single `end()` calls, so buffering to compress is safe. Effort S–M.

### 7d. Mobile forced-reflow insight (38 ms, unattributed)
- **Facts:** no source is attributed and nothing in the code is a known offender yet. Prime suspects to rule out: splash removal (`atoms/session.ts:85`), `themeClassEffect` writes, the header's `backdrop-blur`, and the fixed splash layer's teardown.
- **Plan:** an investigation task, not a change. Runbook: DevTools Performance capture under mobile emulation on `/login` and `/`, filter `Recalculate Style` / `Layout` self-time, attribute to a function, then decide. No issue-worthy fix until attribution exists. Effort S.

---

## Ready-to-file issue drafts

Do NOT file without the owner's go-ahead. Titles and bodies are copy-paste ready.

---

### Draft 1 — Security headers (phased: nosniff/Referrer-Policy/XFO/HSTS, then CSP with One-Tap gating, then COOP)

**Title:** Add security headers: HSTS, X-Frame-Options, nosniff, Referrer-Policy, then CSP with One-Tap gating, then COOP

**Body:**
Lighthouse's four informative security audits currently have no headers behind them.

- Phase 1: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=31536000; includeSubDomains` — all set at one point: wrap `res.writeHead` in the `createServer` callback in `apps/server/src/index.ts` (covers health, auth, rpc, media, static, 404). Assert them in the e2e `api` project.
- Phase 2: CSP. Baseline `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://lh3.googleusercontent.com; font-src 'self' data:; connect-src 'self'; form-action 'self' https://accounts.google.com https://discord.com https://www.twitch.tv; base-uri 'none'; frame-ancestors 'none'`. When the request carries the `mytuums_returning` cookie (the One Tap gate, `lib/returning-visitor.ts`), extend `script-src`/`frame-src` with `https://accounts.google.com` (+ `https://ssl.gstatic.com` if the DevTools capture shows it) — making the Google allowances exactly co-extensive with when the GSI script is actually injected. Verify the OAuth buttons and One Tap after shipping.
- Phase 3: `Cross-Origin-Opener-Policy: same-origin` after testing full OAuth round trips (Google/Discord/Twitch), One Tap, password reset, and the `?error=` callback flow.

Note: `style-src 'unsafe-inline'` is required by the inline splash `<style>` in `index.html` and React style attributes; keep `script-src` free of `unsafe-inline`/`unsafe-eval`.

---

### Draft 2 — Login LCP: build-time preloads, then static shell

**Title:** Improve /login LCP: inject modulepreload hints at build time; consider a generated static HTML shell

**Body:**
`/login`'s LCP (the "Welcome Back" heading) currently waits on: 578 KB main chunk download+eval → router init → dynamic import of the login route chunk + message chunks → React mount. Desktop LCP 0.9 s, mobile 3.2 s. The built `dist/index.html` has zero preload hints.

- Phase A: a small Vite plugin/post-build step in `apps/web` that adds `<link rel="modulepreload">` for the login route chunk (and its message chunks) to `dist/index.html`, so they fetch in parallel with the main chunk.
- Phase B: static shell for `/login` — `apps/server/src/static-files.ts` serves an index variant whose splash carries the real heading, locale from the `PARAGLIDE_LOCALE` cookie, strings generated at build time from `messages/{en,fr}.json` so the "Loading is the only non-i18n string" invariant becomes "generated from the catalogue, never hand-typed". The heading lives inside `#app-splash`, which `sessionSettledEffect` already removes. Keep the shell to static text only (no form).
- Fallback: accept; desktop LCP is already good and cookie-less visitors get a server-side 302 to /login.

---

### Draft 3 — CI Lighthouse budgets

**Title:** Gate PRs on Lighthouse budgets (sixth CI job)

**Body:**
Add a `perf` job to `.github/workflows/ci.yml`: build the server image (buildx + gha cache, as the `docker` job does), run it with a Postgres service container, wait on `/health`, then `npx lighthouse http://localhost:3001/login` twice (desktop preset + default mobile with simulated throttling) with `--budgets-file=lighthouse-budgets.json`, failing the job on budget errors and uploading the reports as artifacts. Budgets start generous (desktop LCP error 2.0 s; mobile LCP error 3.5 s, TBT 300 ms, CLS 0.1, total-weight 450 KB gz) and tighten as CI data accumulates. The `e2e` job is not reused: it serves the dev-mode stack (Vite dev server), which is not a representative perf target. Point the local `lighthouse` scripts at the same budgets file.

---

### Draft 4 — Leftovers: wordmark contrast, fonts, /rpc gzip, forced-reflow trace

**Title:** Perf/UX leftovers: dark-mode wordmark contrast, Inter font verification, /rpc response gzip, forced-reflow attribution

**Body:**
Four small items:
1. Wordmark contrast: `text-primary` at 20 px bold in dark mode is ~2.5:1 vs the 3:1 large-text rule (`components/header.tsx:41`). Add `dark:text-foreground`; logo image keeps the brand color.
2. Fonts: confirm via DevTools that only `inter-latin-wght-normal.woff2` (48 KB) + optionally latin-ext download (unicode-range subsetting already works); optionally preload the latin file via the build-time injection from the login-LCP item. Do not drop non-latin subsets — user content can carry any script.
3. /rpc JSON responses are not compressed (only static files are, `static-files.ts`). Wrap `res.end`/`writeHead` in the `createServer` callback to brotli/gzip JSON bodies over a threshold, with `Vary: Accept-Encoding`; extract the `preferredEncoding` q-value parser from `static-files.ts` to share it.
4. Mobile forced-reflow 38 ms is unattributed. Run a DevTools trace on /login and /, filter Recalculate Style/Layout, and attribute before changing anything. Suspects: splash removal, themeClassEffect, header backdrop-blur.

---

### Draft 5 — HTTP/2: document the local-only limitation (no code change)

**Title:** HTTP/2: document that the origin is HTTP/1.1 by design (edge gives browsers HTTP/2)

**Body:**
The server is `node:http` (`apps/server/src/index.ts`) — HTTP/1.1, 6-connection cap, which queues the ~20 script requests when a browser hits the origin directly (local Lighthouse runs, raw `docker run`). In production browsers never connect to the origin: Railway's edge terminates TLS and serves HTTP/2, and the dev path (browser → Vite) is HTTP/1.1 regardless. Decision: document rather than build `node:http2` + TLS (cert lifecycle, Chrome trust, shutdown rework — for a number that is already 87/99 and meaningless in production). Mitigate the queue locally by merging the tiny paraglide message chunks (see the dual-locale bundle item). Add a short note to the server module header.

---

### Draft 6 — Critical CSS: non-blocking load first, extraction later

**Title:** Render-blocking CSS: switch to non-blocking load; consider critical-CSS extraction if the audit still flags it

**Body:**
The single 67 KB stylesheet (11.6 KB gz, 798 rules, Tailwind v4 — no per-route splitting possible) is the last render-blocking resource. The splash is already inline in `index.html`, so first paint is not blocked; the sheet blocks the login page's styled paint after the splash lifts.
- Phase A: load it with `media="print" onload` + `<noscript>` fallback in `index.html` (FOUC risk is limited: the inline splash hides the document until session settle).
- Phase B: if the audit still flags it, extract critical CSS from a real render of /login (the repo has Playwright), inline ~2–3 KB, defer the rest.
- Fallback: accept — 11.6 KB gz on HTTP/2 in production is a small fixed cost.

---

### Draft 7 — Paraglide: accept dual-locale main-chunk footprint; optionally merge message chunks

**Title:** Paraglide i18n footprint: document the dual-locale main-chunk cost; consider merging per-key message chunks

**Body:**
Verified: per-key message splitting already happened (491 modules; `/login` loads only its message chunks); each module embeds both locales, and the main chunk carries the app-shell messages in both locales (~35 KB raw / ~9 KB gz of the 578 KB main chunk; the compiled paraglide runtime adds ~64 KB). Locale stripping is not feasible without breaking the cookie-driven `PARAGLIDE_LOCALE` runtime switch and the no-URL-locale design. Actions: (1) document the numbers and the conclusion in the i18n CLAUDE.md section; (2) optionally merge the ~15 tiny message chunks fetched by `/` and `/login` into one i18n chunk via `build.rollupOptions.output.manualChunks` in `apps/web/vite.config.ts` — fewer HTTP/1.1-queued requests, at the cost of downloading a few messages the route may not use. Measure the waterfall before/after.
