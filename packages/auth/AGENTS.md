# packages/auth — agent guide

## Responsibility

The single better-auth instance the whole app authenticates against, plus its
supporting modules: env resolution, outgoing mail, the user-validation
database hooks, and French translations of better-auth's own messages. It owns
nothing else — no routes, no UI, no queries beyond the adapter.

## Start here

| File            | Why                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `src/index.ts`  | The production instance. Every non-default setting is load-bearing and carries an inline comment. |
| `src/social.ts` | Provider registration and `trustedProviders`, the account-linking control.                        |
| `src/env.ts`    | Quiet env resolution — missing values make a feature absent, never a crash.                       |
| `src/email.ts`  | The only place mail is sent, plus the en/fr copy.                                                 |

## Change map

| Intent                          | Primary                        | Also touch                                                                                                       |
| ------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Add or change an OAuth provider | `src/social.ts`                | `../../apps/server/src/env.ts`, `../../.env.example`, `VITE_SOCIAL_PROVIDERS`, `apps/web/src/lib/auth-client.ts` |
| Change an auth email            | `src/email.ts`                 | both locales in the same file                                                                                    |
| Translate an auth error         | `src/i18n.ts`                  | `apps/web/src/lib/auth-error-message.ts`                                                                         |
| Change a user-field rule        | `src/dob.ts`, `src/profile.ts` | `apps/web/src/lib/auth-validation.ts` — the strings are shared byte-for-byte                                     |
| Change session or plugin config | `src/index.ts`                 | read the inline comment first; several settings are pinned                                                       |
| Change an auth rate limit       | `src/index.ts` (`customRules`) | these are security controls, not tuning                                                                          |
| Add a test-only helper          | `src/testing.ts`               | never import it from application code                                                                            |

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
- **`src/testing.ts` is reachable only as `@my-tuums/auth/testing`.** It mints
  sessions and captures OTPs. Never import it from application code.

## Dependencies and boundaries

- `apps/server/src/index.ts` mounts `auth` at `/api/auth` via `toNodeHandler`.
- `packages/api/src/context.ts` resolves every request's session with
  `auth.api.getSession`.
- Error and date-of-birth strings are byte-identical with
  `apps/web/src/lib/auth-validation.ts`; change one side alone and server
  rejections render untranslated.
- The better-auth family is pinned as one unit in the workspace catalog. Bump
  core and plugins together — `packages/api` verifies behaviour against these
  internals.

## Generated files

None here, but `packages/db/src/schema/auth.ts` is generated **from** this
package's config by `pnpm --filter @my-tuums/db db:generate:auth`. A change to
`additionalFields` or a plugin means regenerating that schema and creating a
migration.

## Verification

| Command                                           | Covers                              |
| ------------------------------------------------- | ----------------------------------- |
| `pnpm --filter @my-tuums/auth lint` / `typecheck` | this package alone                  |
| `pnpm test:integration`                           | the real behaviour of this instance |

There is no test script here on purpose: the logic is covered by
`packages/api`'s integration suites, which exercise the _production_ instance,
and the validation rules are pure functions tested where they live.

## Further reading

- [docs/architecture.md](../../docs/architecture.md) — auth, sessions, and the build-time versus runtime provider split.
- [docs/security.md](../../docs/security.md) — session, linking and rate-limit controls.
