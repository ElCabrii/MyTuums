import { auth } from "@my-tuums/auth";
import { db, type Database } from "@my-tuums/db";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";
import { createStorage, type Storage } from "./storage.js";

type Session = Awaited<ReturnType<typeof auth.api.getSession>>;

/**
 * Everything an oRPC procedure can read: the database, the caller's session
 * and transport identity, the rate limiter and object storage.
 */
export interface Context {
  db: Database;
  session: Session;
  /**
   * The request identity from the server's `x-request-id` header
   * (`apps/server/src/request-handler.ts` generates it at the top of every
   * request). Threaded onto the Context so API-layer failures can be tied
   * to the same id the HTTP response, the access log and Sentry carry —
   * the oRPC `onError` interceptor in `apps/server/src/index.ts` reads it
   * from here. Required, not optional: every Context is built from a real
   * request (or a test that supplies one), same as `rateLimiter`.
   */
  requestId: string;
  /**
   * Where `./procedures.ts`'s `rateLimit()` middleware consumes budget.
   *
   * Required, not optional: every `Context` has to come from somewhere, and
   * making that explicit is what keeps a limiter from being an invisible
   * global a procedure reaches for on its own. Production gets exactly one
   * instance for the server's lifetime — see `defaultRateLimiter` below —
   * shared across every request the same way the old module-level singleton
   * in `rate-limit.ts` was. Tests build `Context` objects directly
   * (`testing/harness.ts`) and supply their own, entirely independent
   * instance, so a rate-limit assertion in one suite can never bleed into
   * another's.
   */
  rateLimiter: RateLimiter;
  /**
   * Object storage for avatars and banners, or `null` when this deployment has
   * no bucket configured.
   *
   * Nullable rather than absent, and threaded on the context for the same
   * reason `rateLimiter` is: the upload procedures must not reach for a module
   * global, and a test must be able to hand them a fake. `null` is a first-class
   * state — a fresh clone with no `S3_*` variables boots, serves every other
   * procedure, and fails only the two that need a bucket, which mirrors how an
   * unconfigured OAuth provider is simply absent rather than fatal.
   */
  storage: Storage | null;
  /**
   * The raw request headers, for the one thing that still needs them after
   * session resolution: the moderation emails' locale fallback
   * (`localeFromRequest` in packages/auth/src/email.ts), used only when the
   * recipient has no stored `localePreference`. Absent in tests, which build
   * `Context` objects directly and always fall back to the base locale.
   */
  headers?: Headers;
}

/**
 * Created once, at module load, and captured by the default parameter below —
 * NOT created fresh inside `createContext`. `createContext` runs once per
 * request, but a rate limiter has to persist ACROSS requests to mean
 * anything; a fresh instance per call would let every caller reset their own
 * budget just by making another request.
 */
const defaultRateLimiter = createRateLimiter();

/**
 * The one storage client this process uses, or `null` when the `S3_*` group is
 * unset.
 *
 * Read from the environment here rather than in `./storage.ts` so that module
 * stays a pure factory with no ambient dependency — the same split
 * `rate-limit.ts` and this file already have. `apps/server/src/env.ts` is what
 * refuses to boot on a *partial* group; by the time this runs, the variables
 * are either all present or all absent.
 *
 * Built once at module load, not per request: an S3Client holds a connection
 * pool, and constructing one per call would discard it every time.
 */
const defaultStorage: Storage | null =
  process.env.S3_ENDPOINT &&
  process.env.S3_BUCKET &&
  process.env.S3_ACCESS_KEY_ID &&
  process.env.S3_SECRET_ACCESS_KEY
    ? createStorage({
        endpoint: process.env.S3_ENDPOINT,
        bucket: process.env.S3_BUCKET,
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        region: process.env.S3_REGION,
      })
    : null;

/**
 * Builds a `Context` for one request: resolves the session from the request
 * headers and threads the process-wide limiter and storage.
 */
export async function createContext({
  headers,
  requestId,
  rateLimiter = defaultRateLimiter,
  storage = defaultStorage,
}: {
  headers: Headers;
  /** The server's per-request identity — see `Context.requestId`. */
  requestId: string;
  /** Override for tests that want to build a context without a real request. */
  rateLimiter?: RateLimiter;
  /** Override so a test can supply a fake bucket instead of reaching a real one. */
  storage?: Storage | null;
}): Promise<Context> {
  const session = await auth.api.getSession({ headers });
  return { db, session, requestId, rateLimiter, storage, headers };
}

/** The process-wide storage client, for callers outside a procedure (the `/media` route). */
export { defaultStorage };
