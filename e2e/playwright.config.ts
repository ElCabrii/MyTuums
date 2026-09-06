import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { resolveTestDatabaseUrl } from "@my-tuums/db/testing";

/**
 * The E2E stack runs on its OWN ports, beside the dev stack rather than
 * instead of it.
 *
 * `pnpm dev` and `docker compose up` both occupy 3001 and 5173, and the point
 * of a suite you can run mid-session is that it does not ask you to stop
 * working first. The server moves to 3101 and the web app to 5273; the web
 * app's Vite proxy is pointed at the former through `RPC_TARGET` (see
 * `apps/web/vite.config.ts`).
 */
const SERVER_PORT = 3101;
const WEB_PORT = 5273;

// Two loopback spellings, split by who is talking.
//
// Anything a BROWSER touches must say `localhost`: cookies are shared across
// ports of the same host but not across `localhost` and `127.0.0.1` — the
// email-verification link mints its session on the server origin, and the
// signed-in app reads it from the web origin, so the two names must agree.
// WebAuthn adds a second reason: RP IDs reject IP literals, so the passkey
// spec cannot register credentials against http://127.0.0.1.
//
// Anything NODE fetches must say `127.0.0.1`: Node 24 resolves `localhost`
// to the IPv6 loopback first, while the server binds 127.0.0.1 only — a
// `localhost` target from Node races families and fails. That covers the
// health check, the api project, and vite's proxy target. The vite command
// below binds every family (`--host`) so the web app answers whichever
// family a `localhost` fetch lands on.
const serverUrl = `http://localhost:${String(SERVER_PORT)}`;
const nodeServerUrl = `http://127.0.0.1:${String(SERVER_PORT)}`;
const webUrl = `http://localhost:${String(WEB_PORT)}`;

const repoRoot = path.resolve(import.meta.dirname, "..");

/**
 * Both processes get the test database and matching origins.
 *
 * `WEB_ORIGIN` has to be the *browser's* origin, not the server's: it feeds
 * both the oRPC CORS allowlist and BetterAuth's `trustedOrigins`, and Vite's
 * `changeOrigin` rewrites `Host` but leaves `Origin` alone — so requests
 * proxied from 5273 still announce themselves as 5273.
 */
const stackEnv = {
  DATABASE_URL: resolveTestDatabaseUrl(),
  BETTER_AUTH_SECRET:
    process.env.BETTER_AUTH_SECRET ?? "playwright-e2e-secret-at-least-32-characters",
  BETTER_AUTH_URL: serverUrl,
  WEB_ORIGIN: webUrl,
  PORT: String(SERVER_PORT),
  HOST: "127.0.0.1",
  NODE_ENV: "development",
  // Every request in this suite comes from 127.0.0.1, so to BetterAuth's rate
  // limiter the whole run looks like one client brute-forcing sign-in — the
  // exact shape `customRules` in packages/auth/src/index.ts exists to stop. The
  // limits stay on everywhere else, including `pnpm dev`; the API project's
  // rate-limit spec covers the app's own /rpc limiter, which is unrelated and
  // still enforced here.
  AUTH_RATE_LIMIT: "false",
  /**
   * No real email, ever, from this suite.
   *
   * `webServer.env` is MERGED over `process.env`, and the `e2e` script loads
   * the repo `.env` — so a developer with a real `RESEND_API_KEY` had every
   * single sign-up in this suite firing a live Resend call, because
   * `emailVerification.sendOnSignUp` is on. That is wrong three ways: it spends
   * a real quota on fixtures (which exhausts it — Resend then 429s and the
   * server logs a wall of failed background tasks), it mails addresses nobody
   * owns, and each send is a network round trip that slows sign-up enough to
   * race the 3s session-store wait in `claimWelcomeFieldsAtom`. That last one
   * is how it surfaced: unrelated /welcome specs failing intermittently, in
   * proportion to how many accounts the specs before them had created.
   *
   * Blanked rather than deleted because merging cannot remove a key.
   * `optionalEnv` in packages/auth/src/env.ts treats "" as absent, so
   * `sendEmail` falls back to logging the message — which the E2E stack wants
   * anyway, since that console line is where a verification or reset link is
   * read from without a mailbox.
   */
  RESEND_API_KEY: "",
  // Object storage, forwarded from the ambient environment so avatar and
  // banner uploads work in the browser the same way they do in dev.
  //
  // All-or-nothing, because `apps/server/src/env.ts` refuses to boot on a
  // *partial* group: a machine with no bucket configured gets a server with
  // uploads reporting NOT_IMPLEMENTED and every other spec unaffected, rather
  // than a stack that will not start. The bucket must be the dev one —
  // `global-setup.ts` purges the suite's uploaded objects by prefix at the
  // start of every run (via `truncateAll` in support/db.ts), so pointing it
  // at any other bucket would delete that bucket's objects.
  ...s3Env(),
};

type S3Environment = Partial<{
  S3_ENDPOINT: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_REGION: string;
}>;

/** The ambient `S3_*` group as-is, or `{}` when any half is missing — the server refuses to boot on a partial group. */
function s3Env(): S3Environment {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return {};

  return {
    S3_ENDPOINT: endpoint,
    S3_BUCKET: bucket,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
    S3_REGION: process.env.S3_REGION ?? "auto",
  };
}

/** The suite's shared constants: server and web URLs, and the storage-state file path for a named fixture. */
export const E2E = {
  serverUrl,
  webUrl,
  storageStateFor: (name: string) => path.join(import.meta.dirname, ".auth", `${name}.json`),
} as const;

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // One retry in CI, not two. A required check has to be trustworthy, and two
  // retries is enough to keep a genuinely unreliable spec green indefinitely —
  // the failure mode is not a red build, it is a suite nobody believes. One
  // absorbs a real infrastructure blip (a service container that answered
  // slowly on its first request) while a spec that needs a third attempt
  // shows up as a failure to fix or quarantine, not as noise to absorb.
  retries: process.env.CI ? 1 : 0,

  // One worker. Every spec shares a single Postgres and a single in-process
  // rate limiter on the server, so parallel workers would both contend for
  // fixtures and burn one another's rate-limit budget — a 429 surfacing as a
  // failed assertion three specs away from the cause.
  workers: 1,

  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: webUrl,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  // Runs once, before the servers: migrates and empties the test database.
  globalSetup: "./global-setup.ts",

  projects: [
    // Signs up the fixture accounts through the real auth endpoint and saves
    // their cookies. Doing this once via HTTP rather than driving the register
    // form in every spec is most of the suite's speed.
    { name: "setup", testMatch: /.*\.setup\.ts/ },

    // Transport-level contract: health, CORS, 404s, the oRPC error envelope,
    // rate limiting. Hits the server directly — no browser, no auth state, so
    // it does not wait on `setup`.
    {
      name: "api",
      testMatch: /tests\/api\/.*\.spec\.ts/,
      use: { baseURL: nodeServerUrl },
    },

    // The browser journeys. Signed in as Alice by default; the signed-out
    // specs override `storageState` per-describe.
    {
      name: "chromium",
      testMatch: /tests\/specs\/.*\.spec\.ts/,
      testIgnore: /analytics-consent\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: E2E.storageStateFor("alice"),
      },
      dependencies: ["setup"],
    },
    // Runs only the analytics gate against the same app, without the refusal
    // seed the normal browser project installs. The Vite process below has a
    // placeholder measurement id; every other browser spec explicitly starts
    // denied so the new banner cannot perturb unrelated journeys.
    {
      name: "analytics",
      testMatch: /analytics-consent\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: { cookies: [], origins: [] },
      },
    },
  ],

  webServer: [
    {
      // The package-local bin shim, not `pnpm --filter @my-tuums/server exec`:
      // Playwright tears a web server down by killing the process group of the
      // process it spawned, and pnpm 12 runs its children in groups of their
      // own — the sh wrapper dies, tsx and the server escape the kill, inherit
      // the piped stdio, and Playwright waits forever on pipes that never
      // reach EOF. Spawning the leaf shim keeps the whole tree inside the
      // group Playwright kills. (pnpm 10 forwarded the signal; 12 does not.)
      command: "node_modules/.bin/tsx src/index.ts",
      cwd: path.join(repoRoot, "apps", "server"),
      url: `${nodeServerUrl}/health`,
      env: stackEnv,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // `vite dev`, not `vite preview`: `server.proxy` does not apply to
      // preview (that needs its own `preview.proxy` block), and dev generates
      // `routeTree.gen.ts` and `src/paraglide/**` — both git-ignored — as a
      // side effect, so a clean checkout needs no separate build step.
      // Runs from apps/web via its local bin shim for the same process-group
      // reason as the server above. `--host` binds every family so Node 24's
      // ::1-first `localhost` fetches reach it (see the URL comment above);
      // the proxy target is the 127.0.0.1 literal for the same reason in
      // reverse.
      command: `node_modules/.bin/vite --host --port ${String(WEB_PORT)} --strictPort`,
      cwd: path.join(repoRoot, "apps", "web"),
      url: webUrl,
      env: {
        RPC_TARGET: nodeServerUrl,
        VITE_GA_MEASUREMENT_ID: "G-E2E306TEST",
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
