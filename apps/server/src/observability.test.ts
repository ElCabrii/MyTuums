import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  attachAccessLog,
  createRequestId,
  pathnameOf,
  type AccessLogResponse,
} from "./observability.js";

const accessLogEntrySchema = z.object({
  type: z.literal("access"),
  requestId: z.string(),
  method: z.string(),
  path: z.string(),
  status: z.number(),
  durationMs: z.number(),
});

/** An `AccessLogResponse` double: real `EventEmitter` + the fields the access log reads. */
function resDouble(statusCode: number, requestId: string | undefined): AccessLogResponse {
  const res = new EventEmitter();
  return Object.assign(res, {
    statusCode,
    getHeader: (name: string) => (name === "x-request-id" ? requestId : undefined),
  });
}

/** A real `IncomingMessage` carrying only the metadata the access log reads. */
function reqDouble(method: string, url: string): IncomingMessage {
  const request = new IncomingMessage(new Socket());
  request.method = method;
  request.url = url;
  return request;
}

/** The one log line `attachAccessLog` is expected to have written. */
function loggedEntry(logSpy: {
  mock: { calls: unknown[][] };
}): z.infer<typeof accessLogEntrySchema> {
  return accessLogEntrySchema.parse(JSON.parse(String(logSpy.mock.calls[0][0])));
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
      const req = reqDouble("GET", "/health?probe=1");

      attachAccessLog(req, res);
      expect(logSpy).not.toHaveBeenCalled();

      res.emit("finish");

      expect(logSpy).toHaveBeenCalledOnce();
      const entry = loggedEntry(logSpy);
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
      const req = reqDouble("GET", "/nonsense");

      attachAccessLog(req, res);
      res.emit("finish");

      expect(loggedEntry(logSpy).requestId).toBe("-");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("logs a closed response's status once it has finished", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = resDouble(503, "req-456");
      const req = reqDouble("GET", "/health");

      attachAccessLog(req, res);
      res.emit("finish");

      expect(loggedEntry(logSpy).status).toBe(503);
    } finally {
      logSpy.mockRestore();
    }
  });
});
