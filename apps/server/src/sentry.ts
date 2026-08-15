import * as Sentry from "@sentry/node";

/**
 * The thin Sentry seam of the server. Everything Sentry-related lives here
 * so `index.ts` — the wiring hub — only ever calls three named functions,
 * and so "Sentry is not configured" is a state this module owns rather
 * than a conditional scattered through the entrypoint.
 *
 * The no-DSN state is a first-class one: `Sentry.init` is never called, and
 * `@sentry/node`'s capture functions are no-ops without an initialized
 * client, so `reportError` is safe to call unconditionally. Dev and CI get
 * the same code paths with none of the service.
 *
 * The default `OnUncaughtException` / `OnUnhandledRejection` integrations
 * are deliberately dropped: `index.ts` already owns those two process
 * events (its `shutdown()` is what drains the pool and exits), and a second
 * handler capturing the same event is double-reporting, not defense. The
 * events still reach Sentry — `index.ts` calls `reportError` in its own
 * handlers before shutting down — with the same flush on the way out.
 */
export function initSentry(dsn: string, environment: string): void {
  Sentry.init({
    dsn,
    environment,
    integrations: (integrations) =>
      integrations.filter(
        (integration) =>
          integration.name !== "OnUncaughtException" && integration.name !== "OnUnhandledRejection",
      ),
  });
}

/**
 * Reports an error to Sentry with the request it belongs to attached, when
 * a client exists. `requestId` is optional because process-level crashes
 * (unhandled rejections, uncaught exceptions) have no request to belong
 * to — those events get the error and nothing else.
 */
export function reportError(error: Error, requestId?: string): void {
  Sentry.withScope((scope) => {
    if (requestId) scope.setTag("requestId", requestId);
    Sentry.captureException(error);
  });
}

/**
 * Waits for queued events to reach Sentry, up to `timeoutMs`, resolving
 * `true` when every event was sent. Called during graceful shutdown, where
 * a `process.exit` before the queue drains would drop the very event the
 * shutdown is reporting.
 *
 * Without a client — the no-DSN state — this resolves `true` immediately:
 * nothing was ever queued, so "drained" is vacuously true. The SDK's own
 * `flush` resolves `false` when uninitialized, which would have the caller
 * log an undrained queue on every dev/CI shutdown.
 */
export async function flushSentry(timeoutMs: number): Promise<boolean> {
  if (!Sentry.getClient()) return true;
  return Sentry.flush(timeoutMs);
}
