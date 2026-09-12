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

### The edge gate (preview only)

On preview, boundary 1 has a second half: **Cloudflare → the origin**, held
by a shared secret rather than by network position. The origin's ingress is
a public Railway hostname — the zone's CNAME is public DNS — so anyone can
connect to it directly with the right SNI and skip Cloudflare entirely,
Access included. When `EDGE_SECRET` is set (preview only), the server
answers 404 to every request whose `x-edge-secret` header does not carry
that exact value, before any routing branch runs — `/health` included. A
Cloudflare Transform Rule scoped to `preview.mytuums.com` sets the header
on every request it forwards, overwriting whatever the client sent, so the
header is proof the request passed through the edge. It must be a shared
secret and not a proxy-header presence check (`cf-connecting-ip` & co.):
on a direct connection the client controls every header, so those can be
forged. Unset in dev, CI, and production, which serve direct traffic by
design — production is the public site and has no edge layer to prove.

`GET /live` is the one route above the gate: Railway's healthchecker probes
the deployment's ingress directly, through no edge proxy, so it can never
carry the secret. It reports process liveness only — the DB-backed
`/health` sits below the gate, and a blipping database must not make
Railway roll back a deploy whose process is up.

## Exposed surfaces

**Reachable without a session** (this list is exhaustive; verify against
`apps/server/src/request-handler.ts` and
`packages/api/src/constants.ts`):

| Surface                       | Notes                                                              |
| ----------------------------- | ------------------------------------------------------------------ |
| `GET /live`                   | deploy liveness for Railway's healthchecker; no DB, no session     |
| `GET /health`                 | exact match, DB-backed, returns `{"status":"ok"}`                  |
| `/api/auth/*`                 | better-auth's own endpoints, minus `/api/auth/admin/*`             |
| Paths in `SIGNED_OUT_PATHS`   | the auth and legal pages, plus `/verify-email` and `/appeal`       |
| `/post/<id>` permalinks       | the app's public read surface (0.4.0) — see below                  |
| `/media/*`                    | session-optional; every key is still authorized per viewer         |
| The branding page             | `about.mytuums.com` — one script-free HTML document, host-routed   |
| `game.list`/`game.bySlug`     | public game catalog reads                                          |
| Static assets                 | anything with a file extension — the SPA cannot boot otherwise     |
| `moderation.appealOpen` (RPC) | capability-gated, not session-gated — see below                    |
| `post.thread`/`post.list`     | session-optional reads; `list` admits an anonymous caller only on  |
| (reply modes)/`post.linkCard` | its `parentId`/`continuationRootId` modes — the permalink's halves |

**`/api/auth/admin/*` returns 404 before the auth handler sees it.** The
better-auth admin plugin gates on its own `adminRoles` option, which cannot
express this app's moderator/staff/admin hierarchy. Blocking those endpoints
keeps `/rpc` the only route to a moderation action, so the rank hierarchy and
the audit log stay the only enforcement surface.

On the Cloudflare PoC branch, post and account moderation check target state
and rank inside D1 write batches. Audit records, in-app notices, report stamps,
session revocation and applicable appeal closure roll back together. The role
catalog remains the authority for rank checks; restoring a contested role must
not overwrite a newer grant. Emails are sent only after commit. Appeal intake
and review are still being migrated and are not deployment-ready.

**Everything else requires a session.** Every other oRPC procedure is built
from `protectedProcedure`, and every page outside `isSignedOutPath` is gated
by the server before the bundle even downloads. The public permalink's own
gates are the ones that replaced the blanket session demand: an anonymous
caller of `post.list`'s feed modes is refused UNAUTHORIZED exactly as before,
`/media` answers an anonymous caller per key through the same authorizers
(a null viewer gets no owner exemptions and no moderator bypass), and the
same visibility rules that hide a post from a signed-in reader hide it — and
its head, and its media — from an anonymous one.

The branding site (`apps/branding`) is the one deliberately public
**document**: it is routed by Host header ahead of the page gate, so it opens
no path on the app's own hostnames, and it reads nothing — no session, no
database, no bucket. Its scripts are same-origin module scripts from its own
build, already covered by the enforced CSP's `script-src 'self'` (which has
no inline allowance), and HSTS `includeSubDomains` — sent by the apex all
along — now
does real work keeping the subdomain HTTPS-only, which is intended.

### The one anonymous RPC: `moderation.appealOpen`

Do not describe this app as having no anonymous surface. It has exactly one,
and it is deliberate: a banned or suspended user cannot sign in, so the appeal
link in their notification email must work signed out.

`packages/api/src/procedures.ts` exports `baseProcedure` for this single
procedure. It is not unguarded — it is **capability-gated**:

- The link carries an HMAC-SHA256 token signed with `APPEAL_TOKEN_SECRET`
  (`packages/api/src/appeal-token.ts`): base64url payload, `.`, signature.
  The Worker entrypoint must pass this secret explicitly to its signer and bind
  it through API context. There is no environment lookup or built-in fallback;
  empty/short secrets are rejected.
- Verification uses Web Crypto `subtle.verify` after size and encoding
  checks, re-parses the payload against its schema, and enforces a 7-day TTL.
  A tampered, malformed or expired token is indistinguishable from an invalid
  one.
- The endpoint and verifier cap tokens at 4 KiB, and the verifier accepts only
  canonical unpadded base64url payload and signature. Oversized or alternate textual
  encodings are rejected before HMAC comparison or database work.
- The signature check itself is deliberately unthrottled: it is a cheap HMAC
  comparison performed before any database work, and only a holder of a valid
  link can get past it to consume budget.

The procedure itself only validates the input shape. Everything the paragraph
above describes is enforced in `packages/api/src/appeal-intake.ts`, which owns
intake as one module: the two capability sources (the email link, and a
signed-in author's own removed post — never a session on the token path, and
never the post path for an anonymous caller), the budget each spends, the
appealable/current/latest gates, the replay policy and the insert whose unique
constraints settle a race the pre-read cannot. That ordering — verify, then
charge, then read — is the module's invariant, not the procedure's.

Anything else building on `baseProcedure` is a bug.

## Authentication and sessions

**Source:** `packages/auth/src/index.ts`, `packages/auth/src/social.ts`

- **No session cookie cache.** A revoked session must stop authenticating
  immediately; `revokeSessionsOnPasswordReset: true` is the other half of
  that. Every session check is a real lookup, including the `/media` gate.
- **Password accounts must prove their email before they can do anything.**
  `emailAndPassword.requireEmailVerification` is `true`, so a password sign-up
  creates the account but issues **no session** — and a sign-in with the
  correct password is refused until the address is verified. That single
  control is what gates every access path: with no session, the server page
  gate and `protectedProcedure` already refuse the account, so no separate
  `emailVerified` check exists (and must not be added to `protectedProcedure`
  — it would lock out OAuth accounts whose provider reports an unverified
  address, a flow this app deliberately keeps). `sendOnSignIn: true` makes the
  refused sign-in re-send the link, which is the whole recovery path; the
  resend and the failure states are worded generically so neither becomes an
  account-existence oracle. Every account predating this rule was
  grandfathered by the `0014_grandfather_email_verified` migration rather than
  locked out.
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
  security-sensitive endpoints (sign-in, sign-up, handle lookups, the 2FA
  challenge, mail-sending).
  `AUTH_RATE_LIMIT=false` disables them and exists only for the E2E suite,
  where one IP drives the whole run. Never set it in production.
- **Handle availability is deliberately observable, with bounded probing
  (issue #380).** Keep the actionable `USERNAME_IS_ALREADY_TAKEN` response
  so someone registering or changing their handle can choose another.
  `/sign-up/email` accepts three attempts per 60 seconds, including failures;
  `/is-username-available` and `/update-user` each accept ten. The username
  plugin's update hook checks uniqueness before the endpoint's session guard,
  making that path an anonymous lookup too. Budgets are separate per path and
  resolved client IP; a deployment proxy must provide trustworthy client IP
  headers; malformed or missing proxy identities are rejected at HTTP ingress. These limits reduce
  harvesting and sign-up email abuse; they do not make public handles secret
  or prevent probing from distributed IPs.
- **One email identifies one account, verified or not (issue #380).** Better
  Auth lowercases sign-up emails before lookup and persistence, and the
  `user_email_unique` constraint has enforced uniqueness since migration
  `0000`. With email verification required, signing up again with that email
  and a different free handle deliberately returns HTTP 200 with a synthetic
  user and `token: null`. It creates no user or credential and does not replace
  the existing account's fields or password. Do not turn this into an
  email-taken error: that would reveal private email membership. The auth
  integration suite checks the database after these responses, including
  case variants and both verification states. A response object alone does
  not establish duplicate persistence. This is not a blanket guarantee
  against email enumeration: the existing-email branch skips creation hooks,
  so invalid consent or date-of-birth fields can produce a different outcome
  for a fresh email. That pre-existing distinction is separate from the
  reported duplicate-persistence finding.
- **The page gate must recognise the `__Secure-` cookie prefix** used over
  HTTPS. A mismatch redirects every signed-in visitor on every page.
- **`hasValidSession` fails open.** A database blip degrades to "the client
  gate decides", never to a mass sign-out — a deliberate availability trade
  that the client-side gate still backstops.
- **Legal consent is refused server-side, not just asked for.** The dialog in
  the web app is a courtesy; `protectedProcedure` is the control. An account
  with no recorded acceptance, or one naming a superseded version, gets
  FORBIDDEN from every procedure — which is what covers the creation paths the
  sign-up hook cannot see (OAuth, passkey, and accounts predating the record).
  Deliberately reachable without consent, all outside oRPC: accepting, the
  `/welcome` claim, signing out, and the documents themselves. So is
  `moderation.appealOpen`, which builds from `baseProcedure` — a banned
  account must be able to appeal without first being asked to accept
  anything.

### Redirects

`?redirect=` round-trips through OAuth, so nothing in its path is trusted.
`sanitizeRedirect` in `apps/web/src/lib/redirect.ts` accepts only a value that
starts with a single `/`, contains no whitespace, is at most 2048 characters,
and does not point back at an auth page. Everything else — absolute URLs,
protocol-relative `//host` — becomes `null` and the caller falls back to its
default.

## Rate limiting

**Do not state that all limiting is keyed on `user:<id>`.** The API also
limits anonymous reads and appeal capabilities; Better Auth limits auth requests.

| Mechanism                                   | Key                                                        |
| ------------------------------------------- | ---------------------------------------------------------- |
| `rateLimit(policy)` middleware              | `<policy>:user:<id>`                                       |
| `rateLimitCapability(context, policy, key)` | `<policy>:appeal:<nonce>` or `<policy>:appeal:<actionId>`  |
| `publicRateLimit(policy)`                   | `<policy>:user:<id>` or `<policy>:ip:<normalized address>` |
| better-auth's own limiter                   | per IP, stored in Postgres                                 |

The HTTP boundary overwrites `x-mytuums-client-ip` before dispatching auth,
RPC or session reads. Callers cannot supply this internal identity themselves:

- With `EDGE_SECRET`, the secret gate must pass before trusting Cloudflare's
  single `CF-Connecting-IP`. The edge must overwrite both headers. This mode
  takes precedence over Railway detection, because Railway sees Cloudflare's
  address rather than the visitor's.
- Without that gate, a Railway runtime (`RAILWAY_ENVIRONMENT_ID` present) uses
  Railway public ingress's `X-Real-IP`. Keep this listener behind Railway's
  public HTTP ingress; do not expose it through a TCP proxy or let untrusted
  private-network workloads call it directly with forged headers.
- Outside Railway, direct/local requests use the socket address and ignore all
  supplied proxy headers. Vite's local proxy consequently shares the loopback
  budget, which is appropriate for local development.

Missing, invalid, repeated or comma-separated proxy IPs return HTTP 400 before
application dispatch; `/live` and `/health` remain independent of IP headers
(the existing edge-secret rule still applies to `/health`). There is no fallback
from a missing trusted header to `X-Forwarded-For`. An unexpected burst of these
400s is a proxy configuration fault to investigate, not a reason to disable the
check. Do not set `RAILWAY_ENVIRONMENT_ID` manually on a non-Railway host.

`@my-tuums/auth/client-ip` owns the internal header and Better Auth IP options.
Both limiters reuse Better Auth's IPv4-mapped IPv6 normalization and IPv6 /64
bucketing. Signed-in RPC budgets remain per user. In-process callers with no
HTTP identity retain a bounded fallback; deployed proxy traffic cannot reach it
with a missing identity.

Deployment validation: confirm two actual client addresses have independent
budgets, spoofed forwarding/internal headers do not change a budget, and the
Better Auth shared-IP warning disappears. No database migration is required.
The proxy contracts are documented by
[Cloudflare](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip)
and [Railway](https://docs.railway.com/networking/public-networking/specs-and-limits#technical-specifications).

`rateLimitCapability` is deliberately not a middleware: the appeal key only
exists after the handler's own branch work (an HMAC verify, or the removal
lookup), so deriving it earlier would mean doing that work twice. It is never
keyed on an IP, so the "no anonymous IP-keyed bucket" property holds there
too.

The twelve policies in `packages/api/src/rate-limit.ts` are per-minute:
read 300, like 120, bookmark 120, follow 60, repost 60, write 15, upload 10,
search 120, report 20, block 30, moderate 60, linkCard 300. The `linkCard`
tier is sized like `read` because its middleware charges every call —
cache-served cards included — and a feed asks for one card per post.

The limiter is **fixed-window and in-memory**: it resets on deploy and
multiplies per replica. That is right for bounding one client and wrong for
anything billed. `maxKeys` is a leak alarm, not an admission gate — at
capacity a brand-new key is let through, never refused, because refusing there
used to 429 every request from a fresh session.

## Outbound fetches

**Link preview cards** (`packages/api/src/link-card-http.ts`,
`packages/api/src/link-card.ts`) are the one surface where author-chosen text
makes the server dial out (issue #260):

- Only `http`/`https` targets are fetched — the same scheme rule the client's
  linkifier applies. The procedure is session-optional (the public permalink
  renders the same cards a signed-in feed does), so the `linkCard` tier that
  rates it is IP-keyed and must bound anonymous dial-outs, not just members'.
- The hostname is resolved by the server and **every** resolved address must be
  global unicast before any request is made. Loopback, RFC 1918 private,
  link-local (including `169.254.169.254`), CGNAT, unique-local, NAT64 (both
  the well-known and local-use blocks), Teredo, benchmarking, multicast and
  the reserved/documentation ranges of both families are refused, as is
  anything unparseable — fail closed. IPv4-mapped IPv6 is refused outright in
  **both** spellings: the URL parser canonicalizes `[::ffff:127.0.0.1]` to
  the hex form `[::ffff:7f00:1]`, so judging only the dotted spelling judged
  nothing a request can actually carry. The same table is re-applied at
  connect time, inside the HTTP client's own resolution
  (`createConnectValidatedLookup` in `packages/api/src/link-card-node.ts`):
  a rebinding DNS server that answers the pre-flight check with a public
  address and the actual connection with a private one still finds no socket
  to open — the address the client connects to, not the one it once resolved
  to, is what the range table must pass.
- Only the scheme's own port is dialled — 80 for `http`, 443 for `https`,
  explicit or default. A host's non-web ports (databases, internal status
  endpoints) are not card targets, first hop or redirect hop.
- Redirects are followed manually, at most four, and every hop re-runs the
  scheme, port and address checks — a public first hop cannot launder a
  redirect to a private one.
- One wall-clock deadline covers every hop, the body is cut off at a byte cap,
  and an HTML content type is required before parsing. Every refusal — plus a
  missing Open Graph payload — is cached as "no card" for the window, so a
  hostile or dead URL is asked about once, not per view.
- A target's lead image is fetched through the same guard, validated from its
  bytes like an upload, and stored in this app's own bucket under
  `link-cards/` — never hot-linked. `/media/link-cards/*` is readable without
  a session by design: it mirrors already-public web content, and the
  anonymous permalink needs it (see `canViewLinkCardMedia`).
- A card is shared by every post carrying its URL, so a hostile unfurl is a
  viewer-wide object: `moderation.purgeLinkCard` (moderator gate, `moderate`
  tier) nulls the row, removes the stored image, and stops the URL from ever
  unfurling again — the purge's actor and reason are recorded on the row.

## Media

**Cloudflare PoC video boundary:** `packages/api/src/stream.ts` requires private
Stream videos and verifies their environment-scoped creator before provider
operations. Tus destinations are validated; only the owner receives upload
capabilities, which are cleared on completion/termination. Creator identity is
recorded before provider I/O, allowing recovery after ambiguous creation and
account deletion. Browser declarations/upload completion do not authorize a post.

`packages/api/src/stream-publication.ts` accepts validated Stream metadata and
latches author eligibility, target visibility and the processing deadline inside
its publication batch. Post, attachment, notification and pending-text removal
share that commit. It does not claim FFmpeg-specific codec/frame validation,
derivative storage accounting or source deletion. Those are accepted Stream
processing differences for this synthetic-data PoC.

Failure commits one notice, private-text/caption erasure and cleanup debt.
Cleanup survives account deletion and retains empty tombstones for 24 hours to
catch late provider visibility; that recovery window is not a provider guarantee.
Moderation retains successful media for the existing author/moderator evidence
gates. Author deletion schedules provider removal.

`packages/api/src/video-media.ts` gates manifest-token issuance, posters, caption
retrieval and timeline previews on current post visibility, rechecking after
provider I/O. Native tokens expire after one hour. Their holder can access Stream
directly during that period, including after an app permission change; those
requests do not revisit Cloudflare Access. The app exposes no raw-source or
arbitrary media path. Captions have a 1 MiB bound; preview indexes contain at most
150 local authorized thumbnail paths and no bearer token.

Worker routing, Access, exact Stream CSP destinations and scheduled recovery are
not deployed yet. The legacy operational commands in
[video operations](video-operations.md) remain a runtime replacement checklist.

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

**Upload processing** (`apps/web/src/lib/media.ts`) — the client pipeline,
not the boundary:

- Every upload path re-encodes in the browser before anything is sent. The
  profile slots upload an untouched original beside the display variant on
  purpose: a user must be able to refit their picture without having lost
  pixels. Post attachments keep **no original** — the composer replaces each
  picked file with its canvas re-encode before it joins the draft (issue
  #207).
- A canvas encode emits pixels only, so **post attachments carry no EXIF,
  GPS or other container metadata** on the app's own upload path. Profile
  originals keep their metadata by the same token — deliberately, behind
  profile-media authorization rather than feed-wide reads.
- The guarantee is cooperative, like the rest of the pipeline: post-image
  validation sniffs and bounds whatever actually arrives but does not strip
  it, so a caller bypassing the web app could still store verbatim bytes;
  `canViewPostMedia` bounds who can fetch them. The re-encode also bounds
  what ordinary uploads weigh: never upscaled, at most 4096 px per side,
  shrunk until within `POST_ATTACHMENT_MAX_BYTES`.

**Replacement and removal** (`packages/api/src/profile-media.ts`):

- The lifecycle registers an upload intent before any storage write, then
  publishes the pair and consumes its unexpired intent in one D1 batch.
  Triggers capture the actual previous paths in each serialized transition,
  so concurrent replacements record cleanup for every superseded pair.
- Replacement cleanup uses only previous managed paths; provider URLs are
  ignored. Paths are immutable and cannot be reattached through profile edits.
  Cleanup debt survives account deletion and failed removals.
- A failed write or rolled-back batch leaves the profile untouched. Unconsumed
  uploads expire after 30 minutes and cannot publish afterward. Never delete
  newly written objects on an ambiguous database acknowledgement: publication
  may already have committed. Recovery retries cleanup; inventory reconciliation
  lists objects before reading pending and live references in one SQL snapshot,
  covering late PUTs without a gap during publication.

**Retrieval:**

- `/media` requires GET or HEAD, then resolves the session if a cookie is
  present. Session-optional since 0.4.0 (the public permalink renders media):
  an anonymous caller proceeds with a **null viewer**, and whether they may
  see a key is the per-key authorization below — never a blanket answer. A
  cookie-bearing caller whose session store cannot be read gets 503, fail
  closed: there is no viewer identity to authorize against. Keys are
  unguessable uuids, so an anonymous probe of well-formed shapes learns
  nothing about which objects exist.
- The response is a 302 to a presigned URL, `private, no-store` by default:
  every redirect is a **viewer-authorized decision**, and reusing one after an
  account switch, block, ban or profile change would serve the old decision.
  The one exemption is profile display objects, cached `private` and bounded
  by `secondsUntilWindowEnd()` — content any viewer who can see the owner may
  already render, so the staleness budget buys real per-render savings without
  widening who can see what. `.orig` originals and post attachments are never
  stored.
- Every key is authorized **per viewer**, post attachments included
  (`canViewPostMedia`): a moderator may inspect a reported or tombstoned post,
  and an ordinary reader must clear both post tombstones and the author
  visibility predicate. Private posts and private-account posts (issue #328)
  gate the same way — author, approved followers and moderators pass,
  anyone else (including anonymous) gets a 404. The one relaxation is that the
  **author of a moderation-removed post may still read its attachments** — it discloses
  nothing they did not upload, the objects deliberately survive a removal so a
  restore is lossless, and it is what lets `moderation.appealPreview` show
  someone the images they are contesting. Ban and block visibility still
  applies to them, and an author-_deleted_ post stays closed to everyone but a
  moderator because those objects are reaped. Profile display objects stay
  public for private accounts by decision — only posts, replies, lists and
  their attachments lock.
- Gating `/media` does **not** revoke a presigned URL already issued. That URL
  stays valid for its own TTL, because this server never sees it again.

**Response headers** are set at one choke point,
`apps/server/src/response-decorators.ts`: a Content-Security-Policy with
`img-src 'self' https: blob:` (the `blob:` source is only for the transient
local image preview in the crop editor), `frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`
and HSTS. Inner handlers win, so a handler setting its own header keeps it.
The GA4 script and collection origins are added to `script-src` and
`connect-src` only when the image was built with `VITE_GA_MEASUREMENT_ID`;
they remain absent from unconfigured deployments and from the separate,
script-free branding host. The browser still loads the tag only after a valid
per-device opt-in.

**The CSP is hash-based, which constrains the edge in front of the app.**
Cloudflare's JavaScript Detections injects its own inline `<script>` into every
HTML response at their edge, after our headers are written. Its source embeds
the per-request ray ID, so no static hash can allow it; Cloudflare only
nonce-matches when the policy itself uses nonces, which this policy does not.
With JS Detections on, every page load logs an inline-script CSP violation and
the injected script does not run.

This is enforced **in code**, not by a dashboard setting: HTML responses carry
`Cache-Control: no-transform` (`cacheHeaderFor` in
`apps/server/src/static-files.ts`), which is the standard way to declare a body
byte-exact, and which Cloudflare documents as suppressing that injection. The
guarantee therefore ships with the policy it protects. It is deliberately not a
statement about one vendor feature: any intermediary that rewrites the document
invalidates a hash-based policy, and `no-transform` denies all of them at once.

The dashboard toggle (Security → Bots → Configure Bot Management) is no longer
load-bearing, which matters because it has regressed before — enabling **Bot
Fight Mode force-enables JavaScript Detections and gives no way to turn it off
independently**, so the zone drifted the moment someone turned Bot Fight Mode
on. Bot Fight Mode may stay on; `no-transform` keeps the document intact
regardless.

If bot fingerprinting is ever genuinely needed, switch the policy to
per-response nonces rather than adding `'unsafe-inline'`. Note that this would
be cheaper than it sounds and than earlier revisions of this document claimed:
the app has **no inline `<script>` of its own**, so the nonce would only need to
appear in the CSP header — Cloudflare stamps its injected script with a nonce it
parses from that header — and `index.html` would stay prebuilt and untemplated.
The inline stylesheet-swap `onload` is an event handler, which nonces do not
cover in any case; it stays on `'unsafe-hashes'` plus its hash.

## Privacy projection

`publicUserColumns` in `packages/api/src/users.ts` is a privacy boundary, not
a convenience selection. It is exactly: `id`, `name`, `username`,
`displayUsername`, `image`, `bio`, `bannerImage`, `createdAt`, `isPrivate`.

`isPrivate` is in because it describes the profile's visibility — what the
client's locked-account branch reads — like the counts, not its owner's
settings. Never add `email`, `twoFactorEnabled`, `lastLoginMethod`, `role` or any
preference column. Sign-in method in particular is reconnaissance, not profile
data. `packages/api/src/users.int.test.ts` pins the exact shape, so widening
it fails a test rather than shipping.

Visibility filtering is centralised in `packages/api/src/visibility.ts` so
banned, blocked or private content cannot leak through a surface that forgot
to filter. A blocked profile reads as "no such user" — the same response as a handle that
never existed, so the block itself does not leak. A banned profile resolves so
the UI can show a suspension stub, but `user.byUsername` redacts its authored
profile fields, relationship counts and viewer relationship state first. A
private profile still resolves for everyone so the client can render the
locked notice; its posts, replies, follower/following lists, search rows and
media rows hide from non-followers at the query layer (`privatePostHidden`,
`privateUserHidden`, `canViewPostMedia`), and `follow` becomes a request.
Privacy and block checks execute inside the same D1 batch as the relationship
write, notification and badge effects. `block` atomically severs pending requests
in both directions along with the follow edges. Approval and withdrawal cannot
act on a request read outside their write batch.

`post.unlike` and `post.unrepost` always allow removal of the caller's own
interaction, including after losing visibility. Their count reads apply the
full post visibility predicate in the same query as the aggregate. Hidden
and nonexistent posts both return success with a zero count and a false
viewer flag, preventing retained post IDs from exposing private activity.

**Ranked snapshots store IDs, never content.** A `feedRankSnapshot` row holds
ordered post IDs with repost attribution and the event instant — no text, no
media, no scores. Every ranked page re-reads its slice live through the
shared projection and re-applies the full visibility treatment (banned,
blocked, private) plus live follow state and scope/filter membership, so a
row hidden since the build drops instead of rendering; removed or deleted
posts drop rather than stubbing. Ranked reads are signed-in only — an
anonymous ranked call is refused UNAUTHORIZED, and the snapshot binds the
viewer's id. Resuming with an unknown, foreign, mismatched-scope,
mismatched-filter or expired id is an explicit error asking for a Refresh,
never a silent restart under a fresh ordering. Expiry is enforced at
authorization time (an expired row is refused immediately); physical deletion
is opportunistic request-time maintenance, not a guarantee — a row past its
30-minute TTL is already unservable whether or not it has been reaped. No
impressions are recorded and no Redis is involved, so there is no
view-history store to leak.

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
- Appeal intake and manual reversal lock the contested `moderation_action` row
  before touching appeals. Holding that stable row through intake's validation
  and insert prevents a reversal from observing no appeal and then committing
  before a concurrent intake creates one. Manual reversal continues with the
  appeal row and then the target row, matching review's appeal-before-target
  order.
- Appeal review excludes the moderator who took the original action.
- The bootstrap promotion (`pnpm db:promote`, with `--remote` for PoC D1)
  is the one deliberate exception to "role changes go through `/rpc`": it
  exists to appoint the first admin before anyone can moderate. It is
  bootstrap-only by construction — `promoteUser` in `packages/db/src/promote.ts`
  atomically refuses to run once an admin already exists, including concurrent
  invocations. The CLI validates the isolated PoC account/database and defaults
  to local bindings, so it cannot become an
  unrestricted production role setter that bypasses the rank guard and the
  audit log.

## Configuration and secrets

- `apps/server/worker/index.ts` validates the fixed PoC origin/account, Access
  audience, minimum 32-character auth secret and all three OAuth credential pairs.
  Missing or malformed configuration fails closed with a content-free event;
  no environment values or validation details enter the response/log. Secrets
  come from bindings, not process environment. The old Node boot path is removed
  on this branch.
- The Cloudflare auth factory receives explicit database, origin, secret,
  provider credentials and delivery transport. Its `packages/auth/src/env.ts` defines only
  the OAuth credential type; no auth module reads process environment or supplies
  fallback credentials. Email templates receive the deployment origin explicitly,
  including notices that contain no action link.
- `BETTER_AUTH_SECRET` belongs only to the app's authentication sessions.
  `APPEAL_TOKEN_SECRET` independently keys appeal links and is shared by the app
  and jobs Workers. Rotating the latter invalidates outstanding appeal links;
  rotate it consistently on both Workers. Pending notices hold private content
  in D1 for at most 24 hours, are deleted after acknowledged delivery, and cascade
  with recipient deletion. Workflow state contains counts rather than message
  text or capabilities. Accepted-but-unacknowledged delivery may repeat after
  lease recovery; the provider binding supplies no idempotency key.
- `.gitignore` covers `.env*` — including stray backups like `.env.bak`, which
  would otherwise be untracked-but-committable files holding live credentials.
- The access log records the pathname only, never the raw URL, because query
  strings are where tokens end up.
- Native auth/provider diagnostics must not include credentials, recipients,
  SQL parameters, media keys or capability URLs. Better Auth receives a safe
  logger; its API-error hook converts unexpected failures to a generic 500
  APIError so Better Call cannot log the raw exception afterward. Moderation
  mail failures retain only the generated request identifier. Local workerd
  and API regressions enforce these properties; hosted log inspection remains
  a deployment gate.

- Every third-party GitHub Action is pinned to a full commit SHA; every
  checkout sets `persist-credentials: false` so the `GITHUB_TOKEN` cannot ride
  out in an uploaded artefact.

## Test and environment isolation

- **Native test resources are isolated and named with `_test`.**
  `packages/db/src/testing/d1.ts` creates ephemeral D1 runtimes; E2E's explicit
  database/bucket names and persistence roots are guarded by
  `e2e/support/platform.ts`. No test selects a production URL or remote bucket.
  Maintenance tools separately validate the exact PoC resource pair and default
  to local storage; remote access requires an explicit flag.
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
