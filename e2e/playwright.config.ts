import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { E2E_SERVER_ORIGIN, E2E_WEB_ORIGIN } from "./constants.js";

// Keep the existing Vite/browser ports. The backend runs the real application
// services in workerd with local D1/R2 and a synthetic authenticated Access edge.
const WEB_PORT = 5273;
const serverUrl = E2E_SERVER_ORIGIN;
const nodeServerUrl = "http://127.0.0.1:3101";
const webUrl = E2E_WEB_ORIGIN;
const repoRoot = path.resolve(import.meta.dirname, "..");

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

  // One worker. Every spec shares a single D1 database and persistent Worker
  // rate limiters on the server, so parallel workers would both contend for
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

  // Runs after server readiness: resets local application rows and seeds game fixtures.
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
      command: "node_modules/.bin/tsx src/e2e-server.ts",
      cwd: path.join(repoRoot, "apps", "server"),
      url: `${nodeServerUrl}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Exercise the built bundle. Repeated cold navigations through Vite's
      // development module graph exhausted Chromium resources before app boot.
      // Vite preview inherits server.proxy, preserving the real Worker backend.
      command: `node_modules/.bin/vite preview --host localhost --port ${String(WEB_PORT)} --strictPort`,
      cwd: path.join(repoRoot, "apps", "web"),
      url: webUrl,
      env: {
        RPC_TARGET: nodeServerUrl,
      },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
