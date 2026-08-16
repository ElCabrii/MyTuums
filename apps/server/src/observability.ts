import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";

/**
 * The per-request observability of the HTTP layer: an identity for every
 * request (`createRequestId`), and the one-line access log emitted when the
 * response finishes (`attachAccessLog`).
 *
 * The request ID itself is generated and owned by `request-handler.ts` — the
 * module that writes every response — which sets it as the `x-request-id`
 * header before any routing branch runs. This module only *reads* that
 * header back when the response finishes, which is what keeps the access
 * log and the routing tree from needing shared state: the header is the
 * contract between them.
 *
 * The access log is one JSON line per finished request, written to stdout
 * (via `console.log`, which Railway surfaces in its log viewer alongside
 * everything else). The path is deliberately the PATHNAME ONLY — never the
 * raw `req.url`: query strings are where tokens and other credentials end
 * up, and an access log that stored them verbatim would turn every logged
 * request into a leak waiting for a log dump.
 */
export function createRequestId(): string {
  return randomUUID();
}

/**
 * The pathname of a raw request target, or `null` when it is not a URL at all.
 * `*` (the HTTP/1.1 OPTIONS asterisk-form) is not a URL either, but it is a
 * valid request target — logged as-is rather than let `new URL` turn it into
 * a misleading `/*`.
 */
export function pathnameOf(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  if (rawUrl === "*") return "*";
  try {
    return new URL(rawUrl, "http://log.invalid").pathname;
  } catch {
    return null;
  }
}

export interface AccessLogEntry {
  type: "access";
  requestId: string;
  method: string;
  /** The pathname only — the query string is never logged (see the module header). */
  path: string;
  status: number;
  durationMs: number;
}

/** The response surface the access log reads: a finish event, one header, and the status code. */
export interface AccessLogResponse extends EventEmitter {
  statusCode: number;
  getHeader(name: string): number | string | string[] | undefined;
}

export function responseHeaderText(value: number | string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "-";
  return value === undefined ? "-" : String(value);
}

/**
 * Attaches the finish listener that writes the access log line and returns
 * the same `res`, so it composes with `decorateResponse` in `index.ts`:
 *
 *     void handleRequest(req, decorateResponse(req, attachAccessLog(req, res)))
 *
 * `finish` fires when the response has been handed to the OS — the status
 * code is final by then. A connection the client aborts mid-flight never
 * finishes (it emits `close` instead) and is therefore not logged; the
 * request-handler catch path that destroys the socket has already written
 * its own error line before the destroy, and an access log that
 * double-counts aborted requests is noisier than one that skips them. (The
 * one destroy path that stays silent — a stream error inside
 * static-files.ts — was silent before the access log existed too; this
 * listener only ever adds lines, never replaces an error log.)
 */
export function attachAccessLog<Response extends AccessLogResponse>(
  req: IncomingMessage,
  res: Response,
): Response {
  const startedAt = performance.now();

  res.once("finish", () => {
    const entry: AccessLogEntry = {
      type: "access",
      // Set by request-handler.ts before any routing branch runs — see the
      // module header. A response that somehow lacks it (a future caller
      // that never went through the routing tree) logs a dash rather than
      // throwing from inside a listener.
      requestId: responseHeaderText(res.getHeader("x-request-id")),
      method: req.method ?? "-",
      path: pathnameOf(req.url) ?? "-",
      status: res.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
    };
    console.log(JSON.stringify(entry));
  });

  return res;
}
