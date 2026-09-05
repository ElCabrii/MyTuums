# packages/auth context

## Responsibility

The single better-auth instance the whole app authenticates against, plus its
supporting modules: env resolution, outgoing mail, the user-validation
database hooks, and French translations of better-auth's own messages. It owns
nothing else — no routes, no UI, no queries beyond the adapter.

## Start here

| File                   | Why                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`         | The production instance. Every non-default setting is load-bearing and carries an inline comment.                        |
| `src/rules.ts`         | The account rules, stated once. Browser-safe, import-free, read by the whole repo.                                       |
| `src/social.ts`        | Provider registration and `trustedProviders`, the account-linking control.                                               |
| `src/env.ts`           | Quiet env resolution — missing values make a feature absent, never a crash.                                              |
| `src/email.ts`         | The only place mail is sent, plus the en/fr copy.                                                                        |
| `src/email-templates/` | The owned emailcn-style templates (`theme-mytuums`, shell, button, copy renderer) that render the HTML part.             |
| `src/legal.ts`         | The email/password sign-up consent hook; OAuth/passkey consent is recorded by the web app's global legal consent dialog. |

## Change map

| Intent                            | Primary                                                      | Also touch                                                                                                       |
| --------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Add or change an OAuth provider   | `src/social.ts`                                              | `../../apps/server/src/env.ts`, `../../.env.example`, `VITE_SOCIAL_PROVIDERS`, `apps/web/src/lib/auth-client.ts` |
| Change an auth email              | `src/email.ts` for copy, `src/email-templates/` for the look | both locales in the same file, and `src/email.test.ts` when the rendering changes                                |
| Translate an auth error           | `src/i18n.ts`                                                | `apps/web/src/lib/auth-error-message.ts`                                                                         |
| Change a user-field rule          | `src/rules.ts`                                               | nothing — the hooks, both handle forms and `packages/api` all read it. Keep the file import-free                 |
| Change how a violation is refused | `src/dob.ts`, `src/profile.ts`, `src/legal.ts`               | the `APIError` translation only; the rule itself belongs in `src/rules.ts`                                       |
| Change session or plugin config   | `src/index.ts`                                               | read the inline comment first; several settings are pinned                                                       |
| Change an auth rate limit         | `src/index.ts` (`customRules`)                               | these are security controls, not tuning                                                                          |
| Add a test-only helper            | `src/testing.ts`                                             | never import it from application code                                                                            |

## Invariants

Each of these is a deliberate, non-default setting. The inline comment in
`src/index.ts` is the primary record; this is the index.

- **No `session.cookieCache`.** A revoked session must stop authenticating
  immediately. `revokeSessionsOnPasswordReset: true` is the other half.
- **`requireEmailVerification: true`.** A password sign-up creates the account
  and sends the verification email but issues no session, and a password sign-in
  is rejected (and re-sends the verification email via `sendOnSignIn`) until the
  email is verified. An unverified password account never holds a session, so
  the existing session gates cover every access path; no blanket `emailVerified`
  check is added to `protectedProcedure` because that would lock out OAuth
  accounts whose provider returned an unverified email. Existing accounts were
  grandfathered by the `email_verified = true` backfill migration
  (`packages/db/drizzle`) so flipping this did not lock them out.
- **`additionalFields` are optional and nullable.** OAuth sign-ups arrive with
  none of them. `imageOriginal` and `bannerImageOriginal` are `input: false` —
  only the upload procedure in `packages/api` writes them, via Drizzle,
  bypassing hooks.
- **`image`/`bannerImage` provider URLs are bounded to
  `PROVIDER_IMAGE_MAX_URL_LENGTH` (4 KiB).** The two columns are repeated on
  every feed row that joins their owner (the avatar join), so an unbounded URL
  — a bare `text` column a client could fill with a near-body-limit string via
  `updateUser` — would amplify a single write into a per-row payload on reads.
  The bound lives in `src/profile.ts` (server authority; there is no browser
  counter for it) and applies to both columns and both create and update paths,
  throwing the same `MANAGED_IMAGE_MESSAGE` the other image protections use so
  the client lookup keeps one entry.
- **Handles have one lowercase representation.** `normalizeUsername` in
  `src/rules.ts` is shared by the Better Auth username plugin, the browser's
  three handle-claiming writes and API lookups. The plugin normalises both
  `username` and `displayUsername`; the user update hook also mirrors a changed
  username into the display column because Better Auth otherwise leaves the
  previous display value in place, and rejects an independent display-only
  update. Migration `0015_lowercase_usernames` audits case-folded collisions,
  installs the database form of the invariant for direct and rolling-deploy
  writes, then backfills existing rows.
- **Legal acceptance is required only on `/sign-up/email`, and only on
  create.** The consent timestamp and version are nullable so existing
  accounts and OAuth/passkey sign-ups remain `NULL` until the web app's global
  legal consent dialog records them. The rule is wired to `create.before`
  alone: `lastLoginMethod({ storeInDatabase: true })` updates the row it just
  created from inside the same sign-up request, and that update carries no
  consent fields. Enforcement for every other path is the oRPC gate on
  `protectedProcedure` in `packages/api`, which refuses an account whose
  record is absent or stale; both read `hasCurrentLegalConsent` from
  `src/rules.ts`.
- **OAuth credentials are all-or-nothing per provider.** A half-set pair must
  never render a button that fails at the token exchange; `src/env.ts` treats
  an empty string as absent, and `apps/server/src/env.ts` refuses to boot on a
  partial pair.
- **`trustedProviders` is the account-linking control**, not a convenience
  list: google and discord only, intersected with the providers actually
  configured, and gated per account by a verified email.
- **`oneTap()` registers unconditionally and `trustedOrigins` is
  `[webOrigin]`.** The web client never calls One Tap without
  `VITE_GOOGLE_CLIENT_ID`.
- **The `customRules` rate limits are security controls** — sign-in, the 2FA
  challenge, the mail-sending endpoints. `AUTH_RATE_LIMIT=false` is the E2E
  escape hatch only, because one IP drives that whole suite.
- **`lastLoginMethod` is stored but deliberately not in `publicUserColumns`.**
  Sign-in provider is reconnaissance, not profile data.
- **`src/env.ts` never throws.** This is the quiet reader;
  `apps/server/src/env.ts` is the loud boot-time validator. The split is what
  lets the better-auth CLI import this package with no server around.
- **Every outgoing email is multipart.** `src/email.ts` keeps the English and
  French plain-text copy as the source of truth, then renders the same
  content to HTML through the owned emailcn-style templates in
  `src/email-templates/` (a custom `theme-mytuums` over `react-email`
  primitives — table-based, inline styles, deliberately no Tailwind runtime
  in the server bundle). The builders are async because `react-email`'s
  `render` inlines styles asynchronously, which is also why
  `PendingEmail.build` in `packages/api` returns a promise. The
  verification, password-reset and moderation-appeal capability URLs must
  remain absolute and present in both parts, but appear only as escaped anchor
  `href` values behind localized HTML CTA labels; arbitrary URLs in quoted user
  content remain ordinary escaped links. The no-provider development log
  deliberately prints the clickable text fallback.
- **The `i18n` plugin reads the `PARAGLIDE_LOCALE` cookie** — the same cookie
  the web app sets — so one locale governs both client copy and server error
  messages.
- **The validation hooks are not applied in the test instance.** Fixtures may
  need to mint rows the rules would reject; the rules themselves are pure and
  tested separately.
- **`user.create.after` stamps the join badges (issue #308).** Every creation
  path — email/password and OAuth — runs it, calling
  `stampJoinBadges` from `@my-tuums/db/stamp-join-badges`: creation rank is
  fixed the moment the account exists, and the stamp is the only moment it
  can be earned (accounts that predate the hook were backfilled by migration
  0028). A hook failure fails the sign-up loudly on purpose — pre-deploy
  migrations guarantee `user_badge` exists, so anything thrown is a
  deployment error, not a cosmetic badge worth swallowing. The test instance
  carries no hooks at all, so fixtures never carry join badges; the stamping
  itself is pinned through this production instance in
  `packages/api/src/badges.int.test.ts`.
- **`src/rules.ts` has no imports, and must never gain one.** It is exposed as
  `@my-tuums/auth/rules` and `apps/web` imports it — it is the only part of
  this package the browser may reach. One `@my-tuums/db` import there throws at
  module load in a browser; one `better-auth` import drags server code into the
  SPA bundle. Everything it holds is a plain value or a pure function: nothing
  throws, and nothing knows which side is calling.
- **`src/dob.ts`, `src/profile.ts` and `src/legal.ts` are adapters, not rules.** What belongs
  in them is what only a server does — `APIError` translation, permitting an
  absent date of birth on the OAuth creation path, requiring consent on the
  email/password sign-up path, and the provider-image and `input: false`
  original-image protections, which guard writes no client should be making
  rather than restating something a form also checks.
  Restating a bound or a message in either file re-opens the drift the single
  module closes.
- **`src/testing.ts` is reachable only as `@my-tuums/auth/testing`.** It mints
  sessions and captures OTPs. Never import it from application code.

## Dependencies and boundaries

- `apps/server/src/index.ts` mounts `auth` at `/api/auth` via `toNodeHandler`.
- `packages/api/src/context.ts` resolves every request's session with
  `auth.api.getSession`.
- **`src/rules.ts` is the one module `apps/web` imports from this package**, as
  `@my-tuums/auth/rules`. `apps/web/src/lib/auth-validation.ts` reads the
  handle, date-of-birth and bio rules from it, `apps/web/src/atoms/profile-edit.ts`
  reads `BIO_MAX_LENGTH` for the counter, and `usernameInput` in
  `packages/api/src/users.ts` reads the handle bounds. That is a web → auth
  dependency edge, and it is safe only because the file imports nothing — see
  [docs/architecture.md](../../docs/architecture.md).
- The rejection strings this package throws are the lookup keys in
  `apps/web/src/lib/auth-error-message.ts`. They live in `src/rules.ts` so
  there is one copy; restating one anywhere makes server rejections render
  untranslated.
- The better-auth family is pinned as one unit in the workspace catalog. Bump
  core and plugins together — `packages/api` verifies behaviour against these
  internals.

## Generated files

None here, but `packages/db/src/schema/auth.ts` is generated **from** this
package's config by `pnpm --filter @my-tuums/db db:generate:auth`. A change to
`additionalFields` or a plugin means regenerating that schema and creating a
migration.

## Verification

| Command                                           | Covers                                          |
| ------------------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @my-tuums/auth lint` / `typecheck` | this package alone                              |
| `pnpm --filter @my-tuums/auth test:unit`          | `src/email.ts`'s HTML rendering, pure and local |
| `pnpm test:integration`                           | the real behaviour of this instance             |
| `pnpm --filter @my-tuums/api test:unit`           | `src/rules.ts`, through its interface           |

The instance's behaviour is covered by `packages/api`'s integration suites,
which exercise the _production_ instance; `src/rules.ts` is covered by
`packages/api/src/account-rules.test.ts`, a **unit** test, which is itself the
standing proof that the module needs no database, no environment and no
better-auth instance to import.

The one test suite owned here is `src/email.test.ts`, run by `vitest.config.ts`'s
single **unit** project. The email HTML rendering (`EmailCopy`,
`EmailButton`, `MytuumsShell`, `renderBrandedEmail` in
`src/email-templates/`) is the
only thing standing between moderator- and user-supplied copy and an email
client's HTML parser, and it is pure — so it belongs in `pnpm test:unit`, which
runs with no database service. The tests pin the localized CTA labels, escaped
action `href` values, the absence of visible action URLs in HTML, retention of
URLs in the plain-text fallback, safe quoted-content rendering and OTP
emphasis. There is deliberately no integration project here: delivery
behaviour already has one in `packages/api`, and giving this package a second
would hand it a database dependency its modules do not have. Nothing in the
unit project may read the root `.env`: `vitest.config.ts`, unlike
`packages/api`'s, never dotenv-loads it, and `src/env.ts` resolves every
variable at module load with a usable default, which is what keeps the package
import-safe with no environment at all. `src/email.test.ts` re-imports the
module under a stubbed `WEB_ORIGIN` when it needs to pin a value; the
malformed-origin fallback those tests pin lives in `src/email.ts`'s
`emailLogoUrl`, not in `env.ts`.

## Further reading

- [docs/architecture.md](../../docs/architecture.md) — auth, sessions, and the build-time versus runtime provider split.
- [docs/security.md](../../docs/security.md) — session, linking and rate-limit controls.
