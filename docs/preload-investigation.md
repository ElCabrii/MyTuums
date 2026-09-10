# Production preload investigation — issue #354

## Result

The shared HTML unnecessarily preloaded the lazy login route on legal documents
and authenticated home. Removing that hint also removes login from the worker's
shell inventory. Login remains a lazy route and is runtime-cached after use.
Shared entry dependencies, the Inter font hint, non-blocking stylesheet, CSP,
worker lifecycle and request interception policy are unchanged.

This fixes confirmed wasted loading. It does **not** establish the cause of the
original anonymized console warnings; #354 should remain open for that evidence.

## Reproduction and measurements

Measured on 2026-09-08 from release/0.5.0 at `8ecbfce`, using the production
Vite bundle served by the built application server on localhost, one origin,
a guarded `_test` database and a disposable authenticated fixture. The server
used development auth-cookie settings for local HTTP; the browser bundle used
production mode and registered its real service worker. No Vite dev server,
extensions, request interception, worker bypass or production data were used.
Browser: headless Chromium **151.0.7922.34**, fresh context per entry route.

CDP `Network.requestWillBeSent`, `Network.responseReceived` and `Log.entryAdded`
recorded asset paths, initiators, worker/cache attribution and preload diagnostics.
The original regression assertion failed on a first `/terms` visit: one login
request where zero was expected. It passes after the change.

| Entry               | Cold login-chunk requests, before → after | Controlled reload, before → after |
| ------------------- | ----------------------------------------- | --------------------------------- |
| `/login`, anonymous | 1 → 1                                     | 1 → 1                             |
| `/terms`, anonymous | 1 → 0                                     | 1 → 0                             |
| `/`, authenticated  | 1 → 0                                     | 1 → 0                             |

The actual unnecessary resource was `/assets/login-C3rKEgnz.js`, **9,112 decoded
bytes**, requested by the HTML parser before the change. On login after the
change it is initiated by script, with **4,544 encoded bytes** in the measured
cold response and zero transferred bytes on the controlled/offline repeats.
Those byte counts describe that one asset and response, not aggregate savings:
worker install requests and HTTP cache reuse are separate from document requests.
The final shell inventory has 28 resources and contains no login chunk.

Five fresh login loads per build with CDP network emulation (100 ms latency,
750,000 bytes/s download, 250,000 bytes/s upload), measured from navigation to
a visible login textbox:

- Before: 1067, 1172, 1113, 1157, 1121 ms; median **1121 ms**.
- After: 1175, 1102, 1089, 1168, 1084 ms; median **1102 ms**.

This small local sample detects no cold-login regression; it is not evidence of
a general performance improvement or a substitute for field measurements.

## Worker and offline checks

- Clean install and worker-controlled reload rendered all three entry routes.
- Previously visited login and terms rendered after going offline and reloading.
- A fresh authenticated home reload while offline did not show the signed-in
  header within 30 seconds. Offline authenticated product availability is not
  established by this check; do not count it as a passing offline home journey.
- With an old controlled tab held open, serving the new build and calling the
  normal registration `update()` produced a waiting worker. A second tab loaded
  the new legal page while the old worker still controlled it. Closing both tabs
  allowed normal activation; no `skipWaiting` was used.
- Activation removed the old app caches and preserved an unrelated cache. Login
  rendered after the update and on a subsequent offline reload.
- Existing worker tests retain navigation refresh/fallback and media/RPC bypass
  coverage; the bypass check now explicitly includes `/api/auth/get-session`.

## Warning families and limits

Neither reported warning family appeared on the six baseline cold/controlled
loads or the corresponding fixed loads (at least 5.5 seconds observation after
load). The font preload remained consumed, and the unnecessary login
`modulepreload` did not itself produce an unused-preload warning in this browser.
An additional isolated-world dynamic import on a controlled legal page also
produced no warning. The recorded 22/132 original warning occurrences cannot be
mapped to assets from the supplied `<URL>` placeholders.

Chromium's [resource reuse check](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/loader/fetch/resource.cc)
returns `kCrossWorldServiceWorkerResourceMismatch` when a worker-provided response
would be reused across different script worlds. Its
[preload diagnostic](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/loader/fetch/resource_fetcher.cc)
prints the reported message for that condition. This is more specific than
“the worker changed during loading”; extension or tooling involvement remains
a hypothesis, not a diagnosis of the original report.

Follow-up evidence needed to close the warning investigation: the affected
browser/version and actual sanitized asset paths, with script-world/initiator
and worker state at the time of each warning. No console filtering or security
feature changes were made. Other browser engines, remote preview behavior and
real mobile devices were not tested.

## Verification

- `pnpm format` and `pnpm verify` passed: build, lint, typecheck, formatting,
  documentation, unit suites (including 971 web tests), migration checks/setup,
  and all 502 API integration tests.
- `pnpm --filter @my-tuums/web exec vitest run src/lib/build-inject-plugin.test.ts src/lib/pwa-plugin.test.ts`
  passed all five tests. The build regression was also run with the original
  plugin restored temporarily and failed on the unwanted login hint.
- Final web lint/typecheck, documentation and format checks cover the later
  regression-test and report refinements.
