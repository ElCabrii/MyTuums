# Security

The trust boundaries, the surfaces that face untrusted input, and the
invariants a change must not quietly break. For the reporting policy, see
[../SECURITY.md](../SECURITY.md).

## Trust boundaries

There are four, and only the first two carry untrusted input:

1. **The public internet → the HTTP server.** One process terminates
   everything: `apps/server/src/request-handler.ts`. There is no separate
   API origin and therefore no CORS surface in production.
2. **The browser → object storage.** Uploaded bytes, and presigned URLs the
   browser follows directly to the bucket.
3. **The server → Postgres.** TLS is required for dotted hostnames and
   disabled for loopback and single-label (Compose-internal) hosts.
4. **The server → third parties** — the OAuth providers and Resend.

## Exposed surfaces

**Reachable without a session** (this list is exhaustive; verify against
`apps/server/src/request-handler.ts` and
`packages/api/src/constants.ts`):

| Surface                       | Notes                                                          |
| ----------------------------- | -------------------------------------------------------------- |
| `GET /health`                 | exact match, DB-backed, returns `{"status":"ok"}`              |
| `/api/auth/*`                 | better-auth's own endpoints, minus `/api/auth/admin/*`         |
| Paths in `SIGNED_OUT_PATHS`   | the auth and legal pages, plus `/appeal`                       |
| Static assets                 | anything with a file extension — the SPA cannot boot otherwise |
| `moderation.appealOpen` (RPC) | the one anonymous RPC — see below                              |

**`/api/auth/admin/*` returns 404 before the auth handler sees it.** The
better-auth admin plugin gates on its own `adminRoles` option, which cannot
express this app's moderator/staff/admin hierarchy. Blocking those endpoints
keeps `/rpc` the only route to a moderation action, so the rank hierarchy and
the audit log stay the only enforcement surface.

**Everything else requires a session.** Every other oRPC procedure is built
from `protectedProcedure`, every non-allowlisted page is gated by the server
before the bundle even downloads, and `/media` is gated too.

### The one anonymous RPC: `moderation.appealOpen`

Do not describe this app as having no anonymous surface. It has exactly one,
and it is deliberate: a banned or suspended user cannot sign in, so the appeal
link in their notification email must work signed out.

`packages/api/src/procedures.ts` exports `baseProcedure` for this single
procedure. It is not unguarded — it is **capability-gated**:

- The link carries an HMAC-SHA256 token signed with `BETTER_AUTH_SECRET`
  (`packages/api/src/appeal-token.ts`): base64url payload, `.`, signature.
- Verification is constant-time (`timingSafeEqual`, with a length check
  first), re-parses the payload against its schema, and enforces a 7-day TTL.
  A tampered, malformed or expired token is indistinguishable from an invalid
  one.
- The endpoint and verifier cap tokens at 4 KiB, and the verifier accepts only
  the canonical unpadded base64url signature. Oversized or alternate textual
  encodings are rejected before HMAC comparison or database work.
- The signature check itself is deliberately unthrottled: it is a cheap HMAC
  comparison performed before any database work, and only a holder of a valid
  link can get past it to consume budget.

Anything else building on `baseProcedure` is a bug.

## Authentication and sessions

**Source:** `packages/auth/src/index.ts`, `packages/auth/src/social.ts`

- **No session cookie cache.** A revoked session must stop authenticating
  immediately; `revokeSessionsOnPasswordReset: true` is the other half of
  that. Every session check is a real lookup, including the `/media` gate.
- **OAuth credentials are all-or-nothing per provider.** A half-configured
  pair must not render a button that fails at the token exchange; the server
  refuses to boot on one.
- **`trustedOrigins` is `[webOrigin]` only.** Automatic account linking is
  restricted to `trustedProviders` in `packages/auth/src/social.ts` — google
  and discord, intersected with the providers actually configured, and gated
  per account by a verified email. That list is the control deciding whether
  an OAuth identity may attach to an existing account; twitch is deliberately
  not on it.
- **Better-auth's own rate limits** are stored in Postgres and cover the
  security-sensitive endpoints (sign-in, the 2FA challenge, mail-sending).
  `AUTH_RATE_LIMIT=false` disables them and exists only for the E2E suite,
  where one IP drives the whole run. Never set it in production.
- **The page gate must recognise the `__Secure-` cookie prefix** used over
  HTTPS. A mismatch redirects every signed-in visitor on every page.
- **`hasValidSession` fails open.** A database blip degrades to "the client
  gate decides", never to a mass sign-out — a deliberate availability trade
  that the client-side gate still backstops.

### Redirects

`?redirect=` round-trips through OAuth, so nothing in its path is trusted.
`sanitizeRedirect` in `apps/web/src/lib/redirect.ts` accepts only a value that
starts with a single `/`, contains no whitespace, is at most 2048 characters,
and does not point back at an auth page. Everything else — absolute URLs,
protocol-relative `//host` — becomes `null` and the caller falls back to its
default.

## Rate limiting

**Do not state that all limiting is keyed on `user:<id>`.** There are two
mechanisms in `packages/api`, and better-auth has a third of its own.

| Mechanism                                   | Key                                                       |
| ------------------------------------------- | --------------------------------------------------------- |
| `rateLimit(policy)` middleware              | `<policy>:user:<id>`                                      |
| `rateLimitCapability(context, policy, key)` | `<policy>:appeal:<nonce>` or `<policy>:appeal:<actionId>` |
| better-auth's own limiter                   | per IP, stored in Postgres                                |

`rateLimitCapability` is deliberately not a middleware: the appeal key only
exists after the handler's own branch work (an HMAC verify, or the removal
lookup), so deriving it earlier would mean doing that work twice. It is never
keyed on an IP, so the "no anonymous IP-keyed bucket" property holds there
too.

The nine policies in `packages/api/src/rate-limit.ts` are per-minute:
read 300, like 120, follow 60, write 15, upload 10, search 120, report 20,
block 30, moderate 60.

The limiter is **fixed-window and in-memory**: it resets on deploy and
multiplies per replica. That is right for bounding one client and wrong for
anything billed. `maxKeys` is a leak alarm, not an admission gate — at
capacity a brand-new key is let through, never refused, because refusing there
used to 429 every request from a fresh session.

## Media

**Upload validation** (`packages/api/src/image.ts`):

- The stored type is the **sniffed** type, never the declared one, and the two
  must agree or the upload is refused.
- A type that sniffs correctly but has no parseable header is refused — it is
  not an image this app can reason about.
- Bounds: per-slot byte limits for the display and original variants, and a
  50-megapixel ceiling that stops a decompression bomb before any decode.
- `isSafeObjectKey` is the path-traversal guard; `objectKeyFromMediaPath`
  returns `null` for anything that is not one of this app's own keys
  (a provider avatar URL, for instance).
- The `/rpc` Content-Length cap is derived from those limits and enforced
  **before** oRPC buffers a multipart body — which happens before auth or rate
  limiting would otherwise see the request.

**Replacement and removal** (`packages/api/src/profile-media.ts`):

- The lifecycle is one module: prepare/write the new objects, atomically swap
  the row references under a row lock, then best-effort delete the superseded
  pair. The row lock is what makes two concurrent replacements serialize —
  without it, both could read the same old keys, and each would delete them
  after its own swap, orphaning the pair the first to commit wrote (the
  reconciliation script reaps it). The lock makes the final committer observe
  and delete the first committer's superseded pair instead, so the leak never
  happens.
- Cleanup only ever deletes keys derived from the _previous_ row values, and
  only when they are this app's own keys — never the pair the request just
  committed, and never a provider's absolute avatar URL.
- A failed write or a rollback of the lifecycle's own swap transaction leaves
  the profile untouched; the freshly written objects are orphans, reaped by
  the reconciliation script rather than by any request path. The lifecycle
  interface accepts only the bare `Database` handle, not a transaction handle,
  so the swap transaction is always the outermost commit and cleanup cannot
  run ahead of a caller-owned rollback.

**Retrieval:**

- `/media` requires GET or HEAD, then a **live session, checked before the key
  is parsed**. An anonymous caller must not be able to learn which keys are
  well-formed, let alone which objects exist, by watching the response differ.
  The rejection carries `Cache-Control: no-store`, so a cached 401 cannot keep
  an image broken after the visitor signs in.
- The response is a 302 to a presigned URL, cached `private` and bounded by
  `secondsUntilWindowEnd()`. Private because the URL is a **bearer
  credential**; a shared cache handing it on would be handing on access.
- Gating `/media` does **not** revoke a presigned URL already issued. That URL
  stays valid for its own TTL, because this server never sees it again.

**Response headers** are set at one choke point,
`apps/server/src/response-decorators.ts`: a Content-Security-Policy with
`frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`
and HSTS. Inner handlers win, so a handler setting its own header keeps it.

## Privacy projection

`publicUserColumns` in `packages/api/src/users.ts` is a privacy boundary, not
a convenience selection. It is exactly: `id`, `name`, `username`,
`displayUsername`, `image`, `bio`, `bannerImage`, `createdAt`.

Never add `email`, `twoFactorEnabled`, `lastLoginMethod`, `role` or any
preference column. Sign-in method in particular is reconnaissance, not profile
data. `packages/api/src/users.int.test.ts` pins the exact shape, so widening
it fails a test rather than shipping.

Visibility filtering is centralised in `packages/api/src/visibility.ts` so
banned or blocked content cannot leak through a surface that forgot to filter.
A blocked profile reads as "no such user" — the same response as a handle that
never existed, so the block itself does not leak.

## Moderation authority

- The hierarchy is `user` → `moderator` → `staff` → `admin`
  (`packages/api/src/roles.ts`). `canManageRole` is **strictly greater**: no
  one may appoint or demote a peer.
- The rank guard lives in `packages/api/src/moderation-actions.ts`, on the
  inverse paths as well as the forward ones, so no restore can skip it.
- The audit log is **append-only**. Every effect — forward and inverse —
  reads its guard `FOR UPDATE` inside its own transaction: an unlocked
  pre-read is a TOCTOU that two concurrent restores both pass and both log,
  and a double log is a lie about what happened. The role overturn checks the
  contested grant under that same lock (`restoreRoleEffect`), so a racing
  `setRoleEffect` can never be clobbered by an appeal that already passed its
  currency check. Moving any of these reads out of the transaction re-opens
  the race.
- Appeal review excludes the moderator who took the original action.

## Configuration and secrets

- `apps/server/src/env.ts` is the loud boot-time validator: it refuses to
  start on a partial OAuth pair or a partial `S3_*` group, and requires
  `BETTER_AUTH_SECRET` to be at least 32 characters. `parseEnv` throws but
  never calls `process.exit` — only `apps/server/src/index.ts` turns a bad
  environment into an exit, so tests can inspect the failure.
- `packages/auth/src/env.ts` is the quiet reader: a missing value makes a
  feature absent, never a crash.
- `BETTER_AUTH_SECRET` also keys the appeal-link HMAC. Rotating it signs out
  every session **and** invalidates outstanding appeal links.
- `.gitignore` covers `.env*` — including stray backups like `.env.bak`, which
  would otherwise be untracked-but-committable files holding live credentials.
- The access log records the pathname only, never the raw URL, because query
  strings are where tokens end up.
- Sentry captures 500-class faults only. Capturing 4xx would flood the project
  with callers' own mistakes.
- Every third-party GitHub Action is pinned to a full commit SHA; every
  checkout sets `persist-credentials: false` so the `GITHUB_TOKEN` cannot ride
  out in an uploaded artefact.

## Test and environment isolation

- **Destructive database helpers refuse any database whose name does not end
  in `_test`** (`assertTestDatabase` in `packages/db/src/testing.ts`, and
  `packages/db/scripts/setup-test-db.mjs`). `resolveTestDatabaseUrl` derives
  that name from `DATABASE_URL` when `DATABASE_URL_TEST` is unset.
- **Every Railway environment owns its own bucket** and one environment's
  credentials cannot address another's. This is what keeps the E2E suite's
  prefix deletion away from real users' avatars: dev locally, ci in CI, never
  production.
- **The E2E stack blanks `RESEND_API_KEY`** so fixture sign-ups can never fire
  a live send.
- **`@my-tuums/auth/testing`** exposes privileged helpers (session minting, OTP
  capture) and is reachable only through that subpath. Never import it from
  application code.

## Further reading

- [../SECURITY.md](../SECURITY.md) — how to report a vulnerability.
- [architecture.md](architecture.md) — the route order and flows referenced here.
- [operations.md](operations.md) — environments, secrets, and CI.
