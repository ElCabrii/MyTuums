import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  attachAccessLog,
  createRequestId,
  pathnameOf,
  type AccessLogEntry,
} from "./observability.js";

/** A `ServerResponse`-shaped double: real `EventEmitter` + the fields the access log reads. */
function resDouble(statusCode: number, requestId: string | undefined) {
  const res = new EventEmitter() as unknown as ServerResponse & { statusCode: number };
  res.statusCode = statusCode;
  res.getHeader = (name: string) => (name === "x-request-id" ? requestId : undefined);
  return res;
}

describe("createRequestId", () => {
  it("returns a fresh UUID per call", () => {
    const a = createRequestId();
    const b = createRequestId();

    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(b).not.toBe(a);
  });
});

describe("pathnameOf", () => {
  it("strips the query string — the access log never logs raw URLs", () => {
    expect(pathnameOf("/rpc/post.list?cursor=abc")).toBe("/rpc/post.list");
    expect(pathnameOf("/media/a.webp?sig=leak")).toBe("/media/a.webp");
  });

  it("returns null for a missing or malformed target", () => {
    expect(pathnameOf(undefined)).toBeNull();
    expect(pathnameOf("http://[")).toBeNull();
  });

  it("logs the OPTIONS asterisk-form target as-is, not as a path", () => {
    expect(pathnameOf("*")).toBe("*");
  });
});

describe("attachAccessLog", () => {
  it("logs exactly one JSON line when the response finishes, with the request id the routing tree set", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = resDouble(200, "req-123");
      const req = { method: "GET", url: "/health?probe=1" } as unknown as IncomingMessage;

      attachAccessLog(req, res);
      expect(logSpy).not.toHaveBeenCalled();

      res.emit("finish");

      expect(logSpy).toHaveBeenCalledOnce();
      const entry = JSON.parse(String(logSpy.mock.calls[0][0])) as AccessLogEntry;
      expect(entry).toMatchObject({
        type: "access",
        requestId: "req-123",
        method: "GET",
        // The query string is not logged.
        path: "/health",
        status: 200,
      });
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs a dash for a response that never got a request id", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = resDouble(404, undefined);
      const req = { method: "GET", url: "/nonsense" } as unknown as IncomingMessage;

      attachAccessLog(req, res);
      res.emit("finish");

      const entry = JSON.parse(String(logSpy.mock.calls[0][0])) as AccessLogEntry;
      expect(entry.requestId).toBe("-");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs a closed response's status once it has finished", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = resDouble(503, "req-456");
      const req = { method: "GET", url: "/health" } as unknown as IncomingMessage;

      attachAccessLog(req, res);
      res.emit("finish");

      const entry = JSON.parse(String(logSpy.mock.calls[0][0])) as AccessLogEntry;
      expect(entry.status).toBe(503);
    } finally {
      logSpy.mockRestore();
    }
  });
});
