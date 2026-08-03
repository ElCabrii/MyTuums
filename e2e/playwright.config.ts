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

const serverUrl = `http://localhost:${String(SERVER_PORT)}`;
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
  TRUST_PROXY: "false",
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
  // `truncateAll()` deletes its objects by prefix after every run.
  ...s3Env(),
};

function s3Env(): Record<string, string> {
  const required = [
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ] as const;

  if (required.some((key) => !process.env[key])) return {};

  return {
    ...Object.fromEntries(required.map((key) => [key, process.env[key] ?? ""])),
    S3_REGION: process.env.S3_REGION ?? "auto",
  };
}

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
  retries: process.env.CI ? 2 : 0,

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
      use: { baseURL: serverUrl },
    },

    // The browser journeys. Signed in as Alice by default; the signed-out
    // specs override `storageState` per-describe.
    {
      name: "chromium",
      testMatch: /tests\/specs\/.*\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        storageState: E2E.storageStateFor("alice"),
      },
      dependencies: ["setup"],
    },
  ],

  webServer: [
    {
      command: "pnpm --filter @my-tuums/server exec tsx src/index.ts",
      cwd: repoRoot,
      url: `${serverUrl}/health`,
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
      command: `pnpm --filter @my-tuums/web exec vite --port ${String(WEB_PORT)} --strictPort`,
      cwd: repoRoot,
      url: webUrl,
      env: { RPC_TARGET: serverUrl },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
