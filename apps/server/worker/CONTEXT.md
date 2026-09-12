# Native HTTP Worker runtime

This directory contains the Cloudflare replacement for the Node server runtime.
The deployment entrypoint is `index.ts`; hosted activation and full verification remain
outstanding. The complete scope is in
[the migration record](../../../docs/cloudflare-migration.md).

`../src/worker-request-handler.ts` owns the Web Request/Response routing boundary:
Access and exact origin first, trusted edge identity, health, normalized admin
endpoint denial, auth, RPC, media and finally gated static assets. The entrypoint binds Access, auth/RPC/media services and static assets from its
Wrangler configuration. Hosted behavior remains unverified.
A local signing-key fixture is not evidence of a configured Access application.

Reuse one handler per isolate/environment. It permits one upload-sized RPC at a
time, while small RPCs remain independent. Both declared and actual bytes are
bounded before framework parsing; anonymous large/lengthless bodies are refused.
Auth receives a lazy stream capped at 1 MiB. Better Auth's own request-phase
limiter runs before its parser pulls any bytes; do not add a second limiter or
pre-buffer the stream. This ordering is pinned to Better Auth 1.6.25 and its
Better Call 1.3.7 router and exercised in the combined native test. Oversized
streams retain a 413 response even if the framework translates their read error.
Unused and failed bodies are cancelled. Appeal bodies retain the 16 KiB
limit and require a declared length. Media fails closed on a session-store
outage; only the page shell preserves the existing fail-open presentation rule.

Configure static assets with `run_worker_first: true` and no automatic SPA
fallback. The handler explicitly fetches an uncompressed index document after
page admission, never for a missing asset or reserved API path. The native
`worker-document.ts` bounds HTML and removes stale asset validators/lengths after
transformation. `public-heads.ts` receives this deployment's explicit origin.
`worker-response-headers.ts` computes the existing stylesheet CSP hash with Web
Crypto and permits only configured Stream origins for video transport.

`rate-limit-counter.ts` owns the SQLite-backed `RateLimitCounter` Durable Object.
The HTTP entrypoint must export it and bind a namespace configured with a
`new_sqlite_classes` migration before using it. No deployed binding exists yet.
Use `createDistributedRateLimiter` from `@my-tuums/api/distributed-rate-limit`
to inject it into API context. The same policy/caller pair hashes to the same
object; SQL stores only a count and reset timestamp. Never put a raw IP,
account ID or appeal capability into the object name or logs.

Counter admission is a synchronous SQL transaction with no external I/O.
Windows survive eviction and runtime restarts. An alarm clears expired storage;
a delayed alarm checks the stored deadline so it cannot erase a fresh window.
No counter failure may grant admission. There is no public counter HTTP endpoint
or reset API.

`auth-rate-limit-counter.ts` owns Better Auth's separate inactivity-window counter.
Each accepted request moves the window; denied attempts never extend it. Its
atomic `consume` is injected through `createAuthRateLimitStorage` from
`@my-tuums/auth/rate-limit-storage`, preserving Better Auth's path policies and
IP normalization. Configure an independent SQLite namespace and migration for
`AuthRateLimitCounter`, then pass the adapter as `createAuth`'s `rateLimitStorage`.
The get/set methods implement the legacy storage interface, but the pinned auth
version's request path uses atomic consume. No auth counter key is stored raw.

`../src/access.ts` validates the Access assertion with JOSE: fixed configured
team domain and application audience, RS256 signature, required expiry and any
not-before claim. Its public-key URL is never derived from a token. Fetching
uses manual redirects, a five-second deadline, a 1 MiB response bound and JOSE's
bounded cache/cooldown. Invalid tokens and unavailable keys fail closed without
logging tokens or raw errors. Owner-only Access policy provisioning remains a
separate deployment requirement; JWT validation does not configure that policy.

Run `pnpm --filter @my-tuums/server typecheck:worker` for Worker runtime types.
`../src/native-rate-limit.test.ts` erases TypeScript from the production class and
executes it with real Miniflare/workerd RPC and SQLite storage, testing concurrent
clients, policy/caller separation, expiry and persistence across runtime restart.
The temporary persistent directory is isolated and removed after its test.

`media.ts` delivers private R2 image bodies through Web Responses, with no S3
presigning or Sharp runtime dependency. Inject the existing per-image authorizers
and reuse one resolver per isolate. Both existing and generated variants inherit
their base key's authorization, checked before storage I/O and again before
delivery. Only shared allowlisted widths are derivable. Responses are always
`private, no-store`, including profile displays; no bucket metadata may introduce
shared caching or bypass Access. The application composition and entrypoint now use this resolver.

The Images binding produces WebP at quality 80 with scale-down and still-image
output. GIFs bypass transformation intact. R2 needs a known upload length, so
generated bytes are bounded by the RPC image-size ceiling before PUT. One
generation runs at a time per resolver; concurrent misses serve their original.
Provider failures also fall back to a newly read original, then recheck visibility.
Only a content-free event is logged. Daily inventory reconciliation catches a
variant written after its source was deleted. No image existence cache bypasses
current R2 reads or authorization.

`../src/native-media.test.ts` bundles this resolver into workerd with private local
R2 and Miniflare's Images binding. It verifies resize/no-enlargement, persistence,
GIF preservation, failure fallback, HEAD, MIME restrictions and authorization
changes. Admission decisions are synthetic; the D1 authorizers have separate
integration tests. Miniflare emulates Images with Sharp locally: this proves the
binding contract, not hosted codec fidelity, orientation or metadata stripping.

`../src/worker-request-handler.test.ts` covers route/security/body admission contracts.
`../src/native-http.test.ts` bundles the production boundary with synthetic services
using the existing tsup dependency and runs it in workerd. It now exercises the
real Access verifier using ephemeral RSA keys and a local certificate endpoint.
Requests enter through `dispatchFetch`, matching HTTP ingress. Calling the
binding proxy's `fetch` instead reproduced a connection reset when the handler
cancelled an unauthenticated upload under concurrent test load. The ingress
fixture keeps the same body and 401 assertion; production cancellation stays intact.
Other HTTP services remain synthetic. Its temporary bundle
is removed after each run. No fixture entrypoint is a deployment target.

`../src/native-auth-rate-limit.test.ts` executes the actual auth counter in workerd,
including concurrent admission, inactivity-window behavior and Better Auth's
sign-in policy across a runtime restart. Better Auth runs with disposable D1
and never sends email or uses production credentials in this suite.

`tests/appeal-token-entry.ts` executes the real API capability signer with a
synthetic secret and payload. `../src/native-appeal-token.test.ts` verifies Node
HMAC interoperability, Unicode, rejection and expiry inside workerd without
Node compatibility. It is a local fixture, never a deployment target. The app
entrypoint must construct the signer from its secret binding and pass it through
API context alongside the PoC origin.

`tests/auth-email-entry.ts` bundles the real Better Auth configuration and email
templates with isolated local D1 and captured synthetic delivery. The native
`../src/native-auth-email.test.ts` uses HTTP ingress (`dispatchFetch`) so a browser
Origin header reaches auth without the local RPC proxy's origin restriction.
Keep the `workerd` export condition when bundling React Email so its edge renderer
is selected. Worker typechecking enables JSX for these owned email templates.
The fixture captures structured workerd logs, forces a synthetic delivery failure
and a real missing-table error, and checks generic HTTP failure plus private
diagnostics. It is never deployed and does not prove hosted Email Service delivery.

`api.ts` binds the real application router to oRPC's fetch adapter and constructs
context from the current auth session for each request. Keep the CSRF plugin
paired with the frontend client. It must run behind the HTTP boundary's Access,
origin, identity and body-admission gates; it does not duplicate those gates.

`application.ts` composes Access validation, the HTTP boundary, real auth/RPC,
image authorizers and video capability delivery, database health and public page
metadata. Construct it with one environment's services, asset binding and media
resources. `index.ts` constructs those services from validated PoC configuration. `link-transport.ts` delegates outbound HTTP to the private `LINK_FETCHER` service;
its Cloudflare Container preserves Node connection-time DNS and TLS validation.

`tests/rpc-media-entry.ts` exercises this composition with real RPC/auth, D1, R2,
Images and both Durable Object counters. Access uses ephemeral RSA keys served
by a local certificate fixture. Outgoing email, static assets and external
preview networking are synthetic; video uploads are outside this fixture. The native multipart test
uses the same oRPC client version as the browser. It exercises private originals,
private post attachments, derived variants, malformed uploads, deletion/cleanup,
real session and CSRF refusal, alternate-host/Access rejection and public page
metadata. Stream instrumentation inside workerd proves the eleventh sign-in
attempt is rejected without a read after ten accepted admissions, and a
lengthless body stops at the byte limit with cancellation and a 413 response.
Bundle metadata confirms no AWS SDK, Sharp or Undici implementation is emitted.
Hosted provider behavior remains unverified; this fixture is never deployed.

## Deployment entrypoint and artifact checks

`index.ts` creates one application handler per isolate, inside the first request.
Initialization errors are content-free and retryable. Its configuration accepts
only the PoC origin/account/Stream namespace and requires auth, Stream and all
three OAuth credential pairs. Both Durable Object classes are exported. The
video binding targets the Workflow owned by the separate jobs Worker; the
application does not run Cron or apply migrations.

`../wrangler.jsonc` declares D1, private EU R2, Images, Stream, restricted-sender
Email Service, both SQLite counters and the external video Workflow. It declares
the already-provisioned Access audience and custom domain, disables workers.dev
and preview URLs, and sends every asset request through the handler. Every
response is private/no-store and noindex. Source maps are uploaded; automatic
invocation logs are disabled and query strings redacted to avoid logging auth
capabilities. Provider credentials belong in secret bindings, never source.
The configured sender domain still needs Email Service activation/verification.

Run `pnpm --filter @my-tuums/server types` after configuration changes. The
binding types are generated into `worker-configuration.d.ts`. Build the web
workspace before `pnpm --filter @my-tuums/server build:worker`; root Turbo builds
now enforce that order. The server's normal build is the native Worker dry run;
Node deployment entrypoints and Docker configuration have been removed on this
branch. Native E2E and maintenance tools use local D1/R2; interactive development
and hosted deployment remain outstanding.

`../src/native-application.test.ts` runs the actual Wrangler bundle and Vite
assets in Miniflare with committed D1 migrations and real counter namespaces.
It proves asset/route Access gates, exact-host checks, configured PoC metadata,
auth signup/sign-in/session, secret-safe initialization failure and PoC email
links. Provider mail/Stream/Workflow delivery is synthetic in this test; the
separate jobs suite covers the actual local Workflow engine. Run the web/server
builds first, or root `pnpm test:unit`, whose Turbo dependency also builds branding.
Do not rebuild assets while these artifact tests are running.

The PoC frontend declares Google, Discord and Twitch because the entrypoint
requires all three pairs. Workers Builds must supply the matching public Google
client ID for One Tap. OAuth provider registration/callbacks, live email and
Stream availability, secure preview networking
and deployed parity tests remain required before the full PoC can be complete.

The RPC handler retains the configured-origin CORS plugin before CSRF admission.
Size rejections at the transport boundary use oRPC's documented JSON error
envelope for RPC requests; auth keeps its own plain HTTP rejection. Response
`Vary` values retain existing fields and add `Accept-Encoding` without duplicate
case variants; Cloudflare handles compression. The E2E HTTP suite checks these
contracts over the wire. `tests/e2e-entry.ts` composes the same services with
local bindings and a synthetic authenticated Access edge; it is not a deployment
entrypoint. Its Stream provider fixture shares upload metadata through local R2;
the real Stream adapter and jobs Video Workflow run unchanged. Browser routing
handles synthetic tus HEAD/PATCH requests and lost-acknowledgement recovery.
No actual codec processing, hosted playback or external provider request occurs.

## Native preview candidate

The entrypoint now permits the fixed preview and migration-candidate origins,
paired with the `mytuums-preview` Stream namespace. The default configuration
remains PoC. `../wrangler.preview.jsonc` binds only the isolated EU preview D1/R2
pair and owner-only candidate Access audience. Final-origin cutover must change
origin, route and audience together; see [the execution record](../../../docs/cloudflare-preview-migration.md).

Preview sets `GOOGLE_ANALYTICS=enabled` to preserve its existing consent-gated
analytics. The deployment command requires the matching public GA measurement ID
at build time; the Worker flag controls the corresponding CSP sources. PoC defaults
to disabled.

## Production candidate and public release

The production candidate uses the fixed production resource tuple behind the
candidate Access audience. `index.ts` permits `ACCESS_MODE=public` only with
`https://mytuums.com` and `mytuums-production`; every preview/PoC/candidate origin
still requires Access. The HTTP boundary still checks the exact host, edge IP,
application session and media permissions. Public responses preserve their normal
cache/metadata policy; private environments additionally enforce no-store/noindex.
`native-application.test.ts` checks public login, signed-out page redirects,
admin denial, alternate-host refusal and rejection of a public candidate config.
Rich link networking uses the private Cloudflare Container described in
[its context](../../link-fetcher/CONTEXT.md). Hosted card verification remains a
release gate; no browser credentials cross that binding.

## Interactive local development

`development.ts` composes the same application with fixed loopback admission,
local bindings, password auth and captured mail. It has no hosted configuration
or Access bypass flag. `../src/development-platform.ts` owns resource persistence
and jobs bindings; see [local development](../../../docs/operations.md#local-development).
