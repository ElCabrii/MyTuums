# Browser notifications

The Notifications page offers an explicit per-browser opt-in. Notifications mirror
new events in the existing inbox: likes, replies, reposts, quotes, follows, follow
requests, moderation notices and failed video processing. Private messages are not
part of this release. Permission is requested only after pressing Enable notifications.
Denied permission is explained without prompting repeatedly. iPhone and iPad users
must first add MyTuums to their Home Screen and open that web app.

Alerts contain only the MyTuums title and “You have new notifications”, translated
using the browser's English/French language. Clicking focuses an existing inbox tab
or opens `/notifications`. The worker ignores incoming payloads and cannot open a
sender-provided URL. No private content, actor names or message previews leave the
server through push. Browser and operating-system settings ultimately control delivery.

## Ownership and delivery

- `packages/api/src/push.ts` owns authenticated status, subscribe and unsubscribe.
  `apps/web/src/atoms/browser-push.ts` owns client state and permission/subscription
  changes. The UI is `apps/web/src/components/browser-push-settings.tsx`.
- `push_subscription` binds one endpoint to one login session, with unique endpoint
  and session indexes. Signing out, revoking a session or deleting an account
  cascades to its subscriptions and queued deliveries. Expired sessions are also
  refused by the sender. A new login requires opting in again; the browser may
  remember its previous permission, but the app never silently enrols a new login.
- Migration `0014_push_delivery_trigger.sql` records per-device delivery obligations
  in the notification's insertion transaction. Existing notifications are not
  backfilled. Rollbacks cannot leave orphan delivery obligations. Deleting a notice
  or subscription removes its pending deliveries.
- `packages/api/src/push-delivery.ts` leases at most 25 due deliveries per minute's
  maintenance Workflow. Each network request has a five-second timeout. Transient
  failures retry with exponential backoff, up to six attempts; notices older than
  24 hours are discarded. Expired provider endpoints (404/410) are removed.
- Before sending, the worker rechecks session expiry, recipient bans, the inbox's
  shared visibility predicate, deletion and the read cursor. Already-read or hidden
  notices are skipped. Provider I/O occurs outside database transactions.
- Delivery is best-effort, with normally about one minute of scheduling latency
  and potentially longer under load or retries. A crash after provider acceptance
  can repeat delivery. The push topic and browser notification tag collapse alerts
  into one inbox alert; this is not an exactly-once delivery guarantee. Provider
  messages expire after five minutes. An already-accepted generic alert can arrive
  after logout or after the inbox is read; external delivery cannot be recalled.

## Configuration and rollout

Generate a separate persistent VAPID P-256 signing key for each hosted environment:

```sh
pnpm push:keys /absolute/path/outside/repository/push-keys.json
```

The command writes a new file with mode 0600, refuses to overwrite an existing file
and never prints key material. Store it in the environment's secret manager and
keep a secure backup. The JSON contains `publicKey` and `privateJwk`.

Configure these Worker secrets before enabling subscriptions:

| Worker      | Secret                 | Value                                  |
| ----------- | ---------------------- | -------------------------------------- |
| Jobs        | `WEB_PUSH_PRIVATE_JWK` | The JSON serialization of `privateJwk` |
| Application | `WEB_PUSH_PUBLIC_KEY`  | The matching `publicKey` string        |

Deploy the migrations, jobs and app through the existing CI-gated deployment
workflow. Set the jobs key before the application's public key so subscribers are
not enrolled without a sender. These settings are optional: without the public key
the UI reports unavailable, and without the private key jobs do not attempt delivery.
Never use a production signing key in local tests. Keep keys stable across releases;
rotating them requires users to opt in again with the new public key.

The sender implements payload-free Web Push with RFC 8292 VAPID authentication
using native Web Crypto. No paid notification service or new package dependency is
required. Only the Google FCM, Mozilla production push and Apple Web Push endpoint
hosts are accepted. Endpoints must use HTTPS without credentials, nonstandard ports
or fragments. Redirects are refused. Providers with other endpoint hosts require an
explicit reviewed allowlist addition; accepting arbitrary subscription URLs would
expose a server-side request-forgery surface. Endpoints and provider error bodies
must never appear in logs. Workflow state contains only delivery counts.

The existing production-only service worker owns push handling. Enabling push
updates and activates a waiting worker before subscribing, so an older offline-only
worker cannot receive pushes it cannot display. The local Vite development server
has no service worker or hosted signing configuration; its settings report unavailable.
For manual provider validation use the deployed HTTPS app with a test account.
Preview's Cloudflare Access gate still applies when clicking an alert.

## Verification

`packages/api/src/push.int.test.ts` exercises actual D1 transactions, ownership,
session cleanup, visibility/read-state filtering, leases and retry recovery.
`web-push.test.ts` verifies the VAPID signature and HTTP delivery boundary with a
synthetic transport. Web tests cover explicit permission, enabling/disabling,
failures, generic worker alerts and inbox-only click routing. Run `pnpm verify`.
Actual operating-system delivery and iOS Home Screen behavior need a hosted-device
smoke test after the signing secrets and deployment are in place.

References: [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API),
[RFC 8292](https://www.rfc-editor.org/rfc/rfc8292),
[Apple Web Push](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers).
