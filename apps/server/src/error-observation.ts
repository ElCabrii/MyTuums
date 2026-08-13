/**
 * The server's error-observation policy.
 *
 * Callers identify where a failure surfaced and provide only the facts that
 * source knows. This module owns the repeated decisions that follow: the
 * source-specific log line, whether the failure belongs in the error
 * reporter, and whether the process must shut down. Reporting is deliberately
 * synchronous; delivery is flushed by the shutdown path in `index.ts`.
 *
 * The reporter and logger are adapters at real seams: production uses Sentry
 * and `console.error`, while tests use recording or throwing substitutes.
 */

export type ProcessErrorSource = "unhandledRejection" | "uncaughtException";

export type ErrorObservation =
  | {
      source: "orpc";
      error: unknown;
      requestId: string;
      status: number;
    }
  | {
      source: "request";
      error: unknown;
      requestId: string;
      method: string;
      path: string;
    }
  | {
      source: "process";
      error: unknown;
      event: ProcessErrorSource;
    };

export type ErrorObservationDecision =
  { action: "continue" } | { action: "shutdown"; reason: ProcessErrorSource; exitCode: 1 };

export type ErrorObserver = (observation: ErrorObservation) => ErrorObservationDecision;

export interface ErrorObserverAdapters {
  report: (error: unknown, requestId?: string) => void;
  log: (message: string, error: unknown) => void;
}

const CONTINUE = { action: "continue" } as const;
const CLIENT_ABORT_CODES = new Set(["ECONNRESET", "EPIPE", "ERR_STREAM_DESTROYED"]);

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function processLogMessage(event: ProcessErrorSource): string {
  return event === "unhandledRejection" ? "Unhandled promise rejection:" : "Uncaught exception:";
}

/**
 * Creates the one observer used by oRPC, the request safety net, and the two
 * fatal process handlers. The returned function never lets either adapter's
 * failure replace the observed error or prevent a required shutdown.
 */
export function createErrorObserver({ report, log }: ErrorObserverAdapters): ErrorObserver {
  const safeLog = (message: string, error: unknown): void => {
    try {
      log(message, error);
    } catch {
      // Logging is an observation channel, never part of the response or
      // shutdown path. With that channel itself broken there is nowhere safer
      // to report its failure, so preserve the original control flow.
    }
  };

  const safeReport = (
    error: unknown,
    requestId: string | undefined,
    failureMessage: string,
  ): void => {
    try {
      report(error, requestId);
    } catch (reportFailure) {
      safeLog(failureMessage, reportFailure);
    }
  };

  return (observation) => {
    switch (observation.source) {
      case "orpc":
        safeLog(`[${observation.requestId}] oRPC error:`, observation.error);
        if (observation.status >= 500) {
          safeReport(
            observation.error,
            observation.requestId,
            `[${observation.requestId}] Error reporter threw:`,
          );
        }
        return CONTINUE;

      case "request":
        safeLog(
          `[${observation.requestId}] Unhandled error while handling ${observation.method} ${observation.path}:`,
          observation.error,
        );
        // A client disconnect is expected traffic, not a server fault. This
        // deliberately preserves the existing heuristic: a dependency error
        // carrying the same code is also suppressed from the reporter, while
        // remaining present in the local log and access log.
        if (!CLIENT_ABORT_CODES.has(String(errorCode(observation.error)))) {
          safeReport(
            observation.error,
            observation.requestId,
            `[${observation.requestId}] Error observer threw:`,
          );
        }
        return CONTINUE;

      case "process":
        safeLog(processLogMessage(observation.event), observation.error);
        safeReport(observation.error, undefined, "Failed to report to Sentry:");
        return { action: "shutdown", reason: observation.event, exitCode: 1 };
    }
  };
}
