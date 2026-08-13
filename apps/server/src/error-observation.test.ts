import { describe, expect, it, vi } from "vitest";
import {
  createErrorObserver,
  type ErrorObservation,
  type ErrorObserverAdapters,
} from "./error-observation.js";

function observer(overrides: Partial<ErrorObserverAdapters> = {}) {
  const report = vi.fn();
  const log = vi.fn();
  return {
    observe: createErrorObserver({ report, log, ...overrides }),
    report,
    log,
  };
}

describe("createErrorObserver", () => {
  it("logs an expected oRPC error without reporting it", () => {
    const { observe, report, log } = observer();
    const error = new Error("not found");

    const decision = observe({
      source: "orpc",
      error,
      requestId: "request-1",
      status: 404,
    });

    expect(decision).toEqual({ action: "continue" });
    expect(log).toHaveBeenCalledWith("[request-1] oRPC error:", error);
    expect(report).not.toHaveBeenCalled();
  });

  it("reports a 500-class oRPC error with its request id", () => {
    const { observe, report } = observer();
    const error = new Error("database unavailable");

    const decision = observe({
      source: "orpc",
      error,
      requestId: "request-2",
      status: 503,
    });

    expect(decision).toEqual({ action: "continue" });
    expect(report).toHaveBeenCalledWith(error, "request-2");
  });

  it("logs and reports an unhandled request error", () => {
    const { observe, report, log } = observer();
    const error = new Error("boom");

    const decision = observe({
      source: "request",
      error,
      requestId: "request-3",
      method: "POST",
      path: "/rpc/post.create",
    });

    expect(decision).toEqual({ action: "continue" });
    expect(log).toHaveBeenCalledWith(
      "[request-3] Unhandled error while handling POST /rpc/post.create:",
      error,
    );
    expect(report).toHaveBeenCalledWith(error, "request-3");
  });

  it.each(["ECONNRESET", "EPIPE", "ERR_STREAM_DESTROYED"])(
    "logs but does not report a request error carrying %s",
    (code) => {
      const { observe, report, log } = observer();
      const error = Object.assign(new Error("client disconnected"), { code });

      observe({
        source: "request",
        error,
        requestId: "request-4",
        method: "GET",
        path: "/media/avatar.webp",
      });

      expect(log).toHaveBeenCalledWith(
        "[request-4] Unhandled error while handling GET /media/avatar.webp:",
        error,
      );
      expect(report).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      event: "unhandledRejection" as const,
      message: "Unhandled promise rejection:",
    },
    {
      event: "uncaughtException" as const,
      message: "Uncaught exception:",
    },
  ])("reports $event and requires a fatal shutdown", ({ event, message }) => {
    const { observe, report, log } = observer();
    const error = new Error(event);

    const decision = observe({ source: "process", event, error });

    expect(log).toHaveBeenCalledWith(message, error);
    expect(report).toHaveBeenCalledWith(error, undefined);
    expect(decision).toEqual({ action: "shutdown", reason: event, exitCode: 1 });
  });

  it.each<{
    observation: ErrorObservation;
    failureMessage: string;
    expectedDecision: { action: "continue" } | { action: "shutdown"; reason: string; exitCode: 1 };
  }>([
    {
      observation: {
        source: "orpc",
        error: new Error("orpc failed"),
        requestId: "request-5",
        status: 500,
      },
      failureMessage: "[request-5] Error reporter threw:",
      expectedDecision: { action: "continue" },
    },
    {
      observation: {
        source: "request",
        error: new Error("request failed"),
        requestId: "request-6",
        method: "GET",
        path: "/",
      },
      failureMessage: "[request-6] Error observer threw:",
      expectedDecision: { action: "continue" },
    },
    {
      observation: {
        source: "process",
        error: new Error("process failed"),
        event: "uncaughtException",
      },
      failureMessage: "Failed to report to Sentry:",
      expectedDecision: { action: "shutdown", reason: "uncaughtException", exitCode: 1 },
    },
  ])(
    "preserves the $observation.source decision when the reporter throws",
    ({ observation, failureMessage, expectedDecision }) => {
      const reportFailure = new Error("reporter unavailable");
      const log = vi.fn();
      const observe = createErrorObserver({
        report: () => {
          throw reportFailure;
        },
        log,
      });

      expect(observe(observation)).toEqual(expectedDecision);
      expect(log).toHaveBeenCalledWith(failureMessage, reportFailure);
    },
  );

  it("preserves the decision when the logger throws", () => {
    const report = vi.fn();
    const observe = createErrorObserver({
      report,
      log: () => {
        throw new Error("logger unavailable");
      },
    });
    const error = new Error("boom");

    const decision = observe({
      source: "process",
      event: "unhandledRejection",
      error,
    });

    expect(report).toHaveBeenCalledWith(error, undefined);
    expect(decision).toEqual({
      action: "shutdown",
      reason: "unhandledRejection",
      exitCode: 1,
    });
  });
});
