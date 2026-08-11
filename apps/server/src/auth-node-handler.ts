import type { IncomingMessage, ServerResponse } from "node:http";
import { setResponse } from "better-call/node";
import { fromNodeHeaders } from "better-auth/node";

/**
 * Auth requests are small JSON/form exchanges. Keep a separate ceiling from
 * the much larger oRPC upload budget so public auth endpoints cannot make the
 * process buffer an arbitrary request body before Better Auth validates it.
 */
export const AUTH_MAX_BODY_BYTES = 1024 * 1024;

const PAYLOAD_TOO_LARGE_MESSAGE = "Payload too large";

class RequestBodyTooLargeError extends Error {
  constructor() {
    super(PAYLOAD_TOO_LARGE_MESSAGE);
    this.name = "RequestBodyTooLargeError";
  }
}

type AuthHandler = (request: Request) => Promise<Response>;

function requestUrl(req: IncomingMessage): string {
  const firstHeader = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;
  const protocol =
    firstHeader(req.headers["x-forwarded-proto"]) ??
    ((req.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  const host = firstHeader(req.headers[":authority"]) ?? firstHeader(req.headers.host) ?? "localhost";
  return `${protocol}://${host}${req.url ?? "/"}`;
}

/**
 * Read a Node request into a bounded buffer. This deliberately counts bytes
 * arriving from the stream instead of relying on Content-Length: HTTP/1.1
 * chunked requests have no declared length and are a normal Node client
 * framing. Once the ceiling is crossed, the request is drained without
 * retaining data and the caller returns 413.
 */
async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    throw new RequestBodyTooLargeError();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for await (const chunk of req) {
      const bytes: Uint8Array = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        req.resume();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    throw error;
  }

  return Buffer.concat(chunks, total);
}

function writePayloadTooLarge(res: ServerResponse): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(413, { "Content-Type": "text/plain" });
  res.end(PAYLOAD_TOO_LARGE_MESSAGE);
}

/**
 * Adapts Better Auth's Web Request handler to Node while enforcing an
 * application-owned body ceiling before the handler can parse or retain the
 * body. `setResponse` remains Better Call's response adapter so cookies,
 * redirects, status codes, and headers retain the same behavior as
 * Better Auth's standard `toNodeHandler`.
 */
export function createAuthNodeHandler(
  handler: AuthHandler,
  maxBodyBytes = AUTH_MAX_BODY_BYTES,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      let body: Buffer | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        body = await readBody(req, maxBodyBytes);
      }

      const response = await handler(
        new Request(requestUrl(req), {
          method: req.method,
          headers: fromNodeHeaders(req.headers),
          body,
          // Node's Request implementation requires this for streamed bodies;
          // the body is already bounded and buffered by this adapter.
          duplex: "half",
        }),
      );
      await setResponse(res, response);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        writePayloadTooLarge(res);
        return;
      }
      throw error;
    }
  };
}
