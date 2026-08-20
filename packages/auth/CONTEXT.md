# packages/auth context

## Responsibility

The single better-auth instance the whole app authenticates against, plus its
supporting modules: env resolution, outgoing mail, the user-validation
database hooks, and French translations of better-auth's own messages. It owns
nothing else — no routes, no UI, no queries beyond the adapter.

## Start here

| File            | Why                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`  | The production instance. Every non-default setting is load-bearing and carries an inline comment.                        |
| `src/rules.ts`  | The account rules, stated once. Browser-safe, import-free, read by the whole repo.                                       |
| `src/social.ts` | Provider registration and `trustedProviders`, the account-linking control.                                               |
| `src/env.ts`    | Quiet env resolution — missing values make a feature absent, never a crash.                                              |
| `src/email.ts`  | The only place mail is sent, plus the en/fr copy.                                                                        |
| `src/legal.ts`  | The email/password sign-up consent hook; OAuth/passkey consent is recorded by the web app's global legal consent dialog. |

## Change map

| Intent                            | Primary                                        | Also touch                                                                                                       |
| --------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Add or change an OAuth provider   | `src/social.ts`                                | `../../apps/server/src/env.ts`, `../../.env.example`, `VITE_SOCIAL_PROVIDERS`, `apps/web/src/lib/auth-client.ts` |
| Change an auth email              | `src/email.ts`                                 | both locales in the same file                                                                                    |
| Translate an auth error           | `src/i18n.ts`                                  | `apps/web/src/lib/auth-error-message.ts`                                                                         |
| Change a user-field rule          | `src/rules.ts`                                 | nothing — the hooks, both handle forms and `packages/api` all read it. Keep the file import-free                 |
| Change how a violation is refused | `src/dob.ts`, `src/profile.ts`, `src/legal.ts` | the `APIError` translation only; the rule itself belongs in `src/rules.ts`                                       |
| Change session or plugin config   | `src/index.ts`                                 | read the inline comment first; several settings are pinned                                                       |
| Change an auth rate limit         | `src/index.ts` (`customRules`)                 | these are security controls, not tuning                                                                          |
| Add a test-only helper            | `src/testing.ts`                               | never import it from application code                                                                            |

## Invariants

Each of these is a deliberate, non-default setting. The inline comment in
`src/index.ts` is the primary record; this is the index.

- **No `session.cookieCache`.** A revoked session must stop authenticating
  immediately. `revokeSessionsOnPasswordReset: true` is the other half.
- **`requireEmailVerification: false`.** Every existing account predates
  verification; turning it on locks them all out.
- **`additionalFields` are optional and nullable.** OAuth sign-ups arrive with
  none of them. `imageOriginal` and `bannerImageOriginal` are `input: false` —
  only the upload procedure in `packages/api` writes them, via Drizzle,
  bypassing hooks.
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
- **The `i18n` plugin reads the `PARAGLIDE_LOCALE` cookie** — the same cookie
  the web app sets — so one locale governs both client copy and server error
  messages.
- **The validation hooks are not applied in the test instance.** Fixtures may
  need to mint rows the rules would reject; the rules themselves are pure and
  tested separately.
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

| Command                                           | Covers                                |
| ------------------------------------------------- | ------------------------------------- |
| `pnpm --filter @my-tuums/auth lint` / `typecheck` | this package alone                    |
| `pnpm test:integration`                           | the real behaviour of this instance   |
| `pnpm --filter @my-tuums/api test:unit`           | `src/rules.ts`, through its interface |

There is no test script here on purpose. The instance's behaviour is covered by
`packages/api`'s integration suites, which exercise the _production_ instance;
`src/rules.ts` is covered by `packages/api/src/account-rules.test.ts`, a **unit**
test, which is itself the standing proof that the module needs no database, no
environment and no better-auth instance to import.

## Further reading

- [docs/architecture.md](../../docs/architecture.md) — auth, sessions, and the build-time versus runtime provider split.
- [docs/security.md](../../docs/security.md) — session, linking and rate-limit controls.
