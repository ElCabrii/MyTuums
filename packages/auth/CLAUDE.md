# CLAUDE.md

Guidance for working in `packages/auth` — the better-auth wiring for MyTuums.

## What this is

The single better-auth instance the whole app authenticates against, plus its
supporting modules (env, email, validation hooks, translations). It owns
nothing else — no routes, no UI, no queries beyond the adapter.

## Key files

- `src/index.ts` — the production `auth` instance. Every non-default setting in
  it is load-bearing and carries an inline comment explaining why; read the
  comments before changing anything (see "Pinned settings" below).
- `src/env.ts` — env resolution, deliberately non-throwing. Anything missing
  makes a provider or feature absent, never the process crash — `apps/server/
  src/env.ts` is the loud boot-time validator, this package is the quiet one.
- `src/social.ts` — OAuth providers (google/discord/twitch), each registered
  only when both credential halves exist; plus `trustedProviders`, the security
  control for automatic account linking.
- `src/email.ts` — the only place mail is sent (Resend, or a dev log / prod
  throw when `RESEND_API_KEY` is unset), plus en/fr copy and `localeFromRequest`.
- `src/i18n.ts` — French translations of better-auth's own error messages, on
  the same `PARAGLIDE_LOCALE` cookie so one locale governs client copy and
  server errors.
- `src/dob.ts` / `src/profile.ts` — the two `databaseHooks` user-validation
  rules (15+ age rule; profile-field rules). Both are pure, tested separately,
  and deliberately *not* applied in the test instance (fixtures may mint rows
  the rules reject).
- `src/testing.ts` — a second better-auth instance with the privileged
  `testUtils` helpers (session minting, OTP capture). Reachable only as
  `@my-tuums/auth/testing`; never import it from application code.

## How it connects

- `apps/server/src/index.ts` mounts `auth` at `/api/auth` (`toNodeHandler`).
- `packages/api/src/context.ts` resolves every request's session with
  `auth.api.getSession`.
- `packages/api/src/auth.int.test.ts` exercises the *production* instance;
  `auth-constants.int.test.ts` imports `@my-tuums/auth/profile`.
- Error and DOB message strings are byte-identical with the client's
  `apps/web/src/lib/auth-validation.ts`; change one side alone and server
  rejections render untranslated.

## Pinned settings (do not "fix" without reading the comment)

- No `session.cookieCache` — a revoked session must stop authenticating
  immediately (`revokeSessionsOnPasswordReset` is the other half of this).
- `requireEmailVerification: false` — every account predates verification.
- `additionalFields` are `required: false` and nullable — OAuth sign-ups arrive
  with none of them; `imageOriginal`/`bannerImageOriginal` are `input: false`
  and only the upload procedure (packages/api) writes them, via Drizzle,
  bypassing hooks.
- `oneTap()` is registered unconditionally and `trustedOrigins` is `[webOrigin]`
  only — the web client never calls oneTap without `VITE_GOOGLE_CLIENT_ID`.
- Rate-limit `customRules` in `src/index.ts` are security controls (sign-in,
  2FA challenge, mail-sending endpoints); `AUTH_RATE_LIMIT=false` is the E2E
  escape hatch (one IP drives the whole suite).
- OAuth creds are all-or-nothing per provider (`env.ts#oauthCredentials`): a
  half-set pair must not render a button that fails at the token exchange.
- `lastLoginMethod` stores in the database but the column is deliberately not
  in `publicUserColumns` — sign-in provider is reconnaissance, not profile data.

## Commands

- `pnpm --filter @my-tuums/auth lint` / `typecheck`

No test script: the package's logic is covered by `packages/api`'s integration
suites (`pnpm test:integration`), and the validation rules are pure functions.
