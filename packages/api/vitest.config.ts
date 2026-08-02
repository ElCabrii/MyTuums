import { config as loadEnv } from "dotenv";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { resolveTestDatabaseUrl } from "@my-tuums/db/testing";

// The root .env is the single source of credentials for every host-side
// process in this repo (see the `dotenv -e ../../.env` prefix on every db:*
// script). Loading it here rather than wrapping the test command keeps
// `vitest --project unit` usable directly from an editor.
loadEnv({ path: path.resolve(import.meta.dirname, "../../.env"), quiet: true });

/**
 * `resolveTestDatabaseUrl()` throws when neither `DATABASE_URL_TEST` nor
 * `DATABASE_URL` is set. Vitest evaluates this whole config file — both
 * projects — before `--project unit` ever gets to filter anything out, so
 * letting that throw escape here would fail the unit project too, on an
 * environment it has no business needing. Caught and left `undefined`
 * instead: the integration project's `env.DATABASE_URL` below is then unset,
 * and `@my-tuums/db` — which only integration tests import — throws its own
 * clear "DATABASE_URL is not set" error the moment one of them runs. That is
 * the right failure, in the right project, at the right time.
 */
function tryResolveTestDatabaseUrl(): string | undefined {
  try {
    return resolveTestDatabaseUrl();
  } catch {
    return undefined;
  }
}

/**
 * Two projects, split by filename:
 *
 * - `*.test.ts`     → unit. Pure logic, no I/O. Must pass with no database
 *                     reachable at all — that is the property that keeps the
 *                     split honest rather than incidental.
 * - `*.int.test.ts` → integration. Real Postgres, real BetterAuth sessions.
 *
 * Only the integration project gets an environment, so a unit run cannot
 * quietly start depending on one.
 */
const testDatabaseUrl = tryResolveTestDatabaseUrl();

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          root: import.meta.dirname,
          environment: "node",
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.int.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          root: import.meta.dirname,
          environment: "node",
          include: ["src/**/*.int.test.ts"],

          // Every file in this project shares one Postgres and one truncate
          // helper. Run in parallel and file A's cleanup deletes the users
          // file B is midway through asserting on — which surfaces as a
          // plausible-looking assertion failure rather than as the scheduling
          // problem it is.
          fileParallelism: false,

          // Sign-up hashes a password (deliberately slow) and the pagination
          // fixtures insert enough rows to cross a page boundary.
          testTimeout: 15_000,
          hookTimeout: 30_000,

          // `test.env` lands in the worker's `process.env` before it imports
          // anything, which is what this has to beat: `@my-tuums/db` reads
          // DATABASE_URL at module scope and throws when it is missing, and
          // `@my-tuums/auth` reads WEB_ORIGIN the same way. Setting it in the
          // config's module scope instead would be too late for a forked pool.
          env: {
            ...(testDatabaseUrl ? { DATABASE_URL: testDatabaseUrl } : {}),
            BETTER_AUTH_SECRET:
              process.env.BETTER_AUTH_SECRET ?? "vitest-integration-secret-at-least-32-chars",
            BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:3001",
            WEB_ORIGIN: process.env.WEB_ORIGIN ?? "http://localhost:5173",
          },
        },
      },
    ],
  },
});
