import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { isSignedOutPath, RPC_MAX_BODY_BYTES, RPC_SMALL_BODY_BYTES } from "@my-tuums/api/constants";

type SessionLookup =
  { kind: "authenticated"; userId: string } | { kind: "anonymous" } | { kind: "unavailable" };

export interface WorkerRequestDependencies {
  origin: string;
  /** Must validate Access before trusting edge identity or dispatching any route. */
  authorizeAccess(request: Request): Promise<boolean>;
  pingDb(): Promise<void>;
  resolveSession(request: Request): Promise<SessionLookup>;
  /** Better Auth must retain its request-phase limiter, before parsing the bounded stream. */
  handleAuth(request: Request): Promise<Response>;
  handleRpc(request: Request, requestId: string): Promise<Response | null>;
  resolveMedia(key: string, viewerId: string | null, request: Request): Promise<Response | null>;
  /** Explicit asset lookup; configure the binding without an automatic SPA fallback. */
  fetchAsset(request: Request): Promise<Response>;
  /** Public post/game metadata is injected only when serving the app document. */
  transformDocument(response: Response, request: Request): Promise<Response>;
  responseHeaders: Readonly<Record<string, string>>;
  observe(event: { event: "request_failed"; requestId: string }): void;
}

export const WORKER_AUTH_MAX_BODY_BYTES = 1024 * 1024;
// A 17 MiB request can have multiple live copies while parsing multipart.
// This is isolate-local memory protection; distributed abuse budgets live in DOs.
export const WORKER_LARGE_RPC_CAPACITY = 1;
const clientAddress = z.union([z.ipv4(), z.ipv6()]);
const appealPath = "/rpc/moderation/appealOpen";

function hasSessionCookie(request: Request): boolean {
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .some((part) => /^(?:__Secure-)?better-auth\.session_token=/.test(part.trim())) ?? false
  );
}

function canonicalPath(path: string): string | null {
  try {
    const segments: string[] = [];
    for (const segment of decodeURIComponent(path).split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    return `/${segments.join("/")}`;
  } catch {
    return null;
  }
}

function prefix(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function assetPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.includes(".") && !name.startsWith(".");
}

function reply(status: number, text: string, headers?: Record<string, string>): Response {
  return new Response(text, { status, headers });
}

function payloadTooLarge(request: Request): Response {
  if (!prefix(canonicalPath(new URL(request.url).pathname) ?? "", "/rpc"))
    return reply(413, "Payload too large");
  // The cap runs before oRPC parses a body. Preserve its documented wire
  // envelope so the real client still receives a typed PAYLOAD_TOO_LARGE error.
  const error = new ORPCError("PAYLOAD_TOO_LARGE");
  return Response.json({ json: error.toJSON(), meta: [] }, { status: error.status });
}

class BodyTooLarge extends Error {}

/** Let Better Auth admit the request before its parser pulls any body bytes. */
async function handleBoundedAuth(
  request: Request,
  handle: WorkerRequestDependencies["handleAuth"],
): Promise<Response> {
  if (!request.body) return handle(request);
  const reader = request.body.getReader();
  let size = 0;
  let exceeded = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            return;
          }
          const bytes: unknown = chunk.value;
          if (!(bytes instanceof Uint8Array)) throw new Error("Invalid request body.");
          size += bytes.byteLength;
          if (size > WORKER_AUTH_MAX_BODY_BYTES) {
            exceeded = true;
            throw new BodyTooLarge();
          }
          controller.enqueue(bytes);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        return reader.cancel().catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  try {
    // Node's Web Request requires duplex for streams; workerd ignores that field.
    const init = { method: request.method, body, duplex: "half" as const };
    const response = await handle(new Request(request, init));
    // Frameworks may translate a stream error into their own response. Preserve
    // the boundary's 413 contract even when the parser catches that error.
    if (exceeded) {
      await response.body?.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    return response;
  } catch (error) {
    if (exceeded) throw new BodyTooLarge();
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Read once with a strict byte bound before a framework can allocate a multipart body. */
async function boundedRequest(request: Request, limit: number): Promise<Request> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array)) throw new Error("Invalid request body.");
      length += bytes.byteLength;
      if (length > limit) throw new BodyTooLarge();
      chunks.push(bytes);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers(request.headers);
  headers.delete("transfer-encoding");
  headers.set("content-length", String(length));
  return new Request(request, { method: request.method, headers, body });
}

/** Reuse one handler per isolate/environment so its upload admission counter is shared. */
export function createWorkerRequestHandler(deps: WorkerRequestDependencies) {
  const origin = new URL(deps.origin).origin;
  let largeRpcInFlight = 0;

  async function route(request: Request, requestId: string): Promise<Response> {
    const url = new URL(request.url);
    // Reject alternate hosts even if someone presents a valid Access token there.
    if (url.origin !== origin || !(await deps.authorizeAccess(request)))
      return reply(404, "Not found");

    const path = canonicalPath(url.pathname);
    if (path === null) return reply(400, "Invalid path");
    const headers = new Headers(request.headers);
    headers.delete("x-mytuums-client-ip");
    const ip = clientAddress.safeParse(headers.get("cf-connecting-ip"));
    if (ip.success) headers.set("x-mytuums-client-ip", ip.data);
    else if (path !== "/health" && path !== "/live") return reply(400, "Invalid client address");
    request = new Request(request, { headers });
    try {
      if ((path === "/health" || path === "/live") && !url.search) {
        if (request.method !== "GET" && request.method !== "HEAD")
          return reply(405, "Method not allowed", { Allow: "GET, HEAD" });
        try {
          if (path === "/health") await deps.pingDb();
          return Response.json({ status: "ok" });
        } catch {
          return Response.json(
            { status: "error", reason: "database unreachable" },
            { status: 503 },
          );
        }
      }
      if (prefix(path, "/api/auth/admin")) return reply(404, "Not found");

      const lengthHeader = request.headers.get("content-length");
      if (
        lengthHeader !== null &&
        (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(Number(lengthHeader)))
      )
        return reply(400, "Invalid content length");
      const declared = lengthHeader === null ? null : Number(lengthHeader);

      if (prefix(path, "/api/auth")) {
        if (declared !== null && declared > WORKER_AUTH_MAX_BODY_BYTES)
          return payloadTooLarge(request);
        return await handleBoundedAuth(request, (bounded) => deps.handleAuth(bounded));
      }
      if (prefix(path, "/rpc")) {
        if (declared !== null && declared > RPC_MAX_BODY_BYTES) return payloadTooLarge(request);
        const unknownLength = request.body !== null && declared === null;
        const large = unknownLength || (declared !== null && declared > RPC_SMALL_BODY_BYTES);
        if (path === appealPath && large)
          return unknownLength ? reply(411, "Length required") : payloadTooLarge(request);
        if (large) {
          const session = hasSessionCookie(request) ? await deps.resolveSession(request) : null;
          if (session?.kind !== "authenticated") return reply(401, "Unauthorized");
          if (largeRpcInFlight >= WORKER_LARGE_RPC_CAPACITY) return reply(503, "Server busy");
          largeRpcInFlight += 1;
        }
        try {
          const bounded = await boundedRequest(
            request,
            large ? RPC_MAX_BODY_BYTES : RPC_SMALL_BODY_BYTES,
          );
          return (await deps.handleRpc(bounded, requestId)) ?? reply(404, "Not found");
        } finally {
          if (large) largeRpcInFlight -= 1;
        }
      }
      if (prefix(path, "/media")) {
        if (request.method !== "GET" && request.method !== "HEAD")
          return reply(405, "Method not allowed", { Allow: "GET, HEAD" });
        const session = hasSessionCookie(request) ? await deps.resolveSession(request) : null;
        if (session?.kind === "unavailable") return reply(503, "Service unavailable");
        // Pass the decoded, unnormalized key to its authorizer: normalization must
        // never turn a traversal-shaped object key into a valid stored object.
        const decoded = decodeURIComponent(url.pathname);
        const key = decoded.startsWith("/media/") ? decoded.slice("/media/".length) : "";
        return key
          ? ((await deps.resolveMedia(
              key,
              session?.kind === "authenticated" ? session.userId : null,
              request,
            )) ?? reply(404, "Not found"))
          : reply(404, "Not found");
      }
      // Reserved prefixes never fall through to a successful app document.
      if (prefix(path, "/api") || url.pathname.startsWith("/rpc")) return reply(404, "Not found");
      if (request.method !== "GET" && request.method !== "HEAD")
        return reply(405, "Method not allowed", { Allow: "GET, HEAD" });

      const isAsset = assetPath(url.pathname);
      if (!isAsset && !isSignedOutPath(url.pathname)) {
        const session = hasSessionCookie(request) ? await deps.resolveSession(request) : null;
        // Only page presentation fails open on a database outage. API and media
        // authorization still fail closed, so a shell cannot grant data access.
        if (!session || session.kind === "anonymous")
          return reply(302, "", {
            Location: `/login?redirect=${encodeURIComponent(url.pathname + url.search)}`,
          });
      }
      const asset = await deps.fetchAsset(request);
      if (asset.status !== 404) return asset;
      if (isAsset || url.pathname.startsWith("/assets/")) return asset;
      const documentUrl = new URL("/index.html", origin);
      const documentHeaders = new Headers(request.headers);
      documentHeaders.set("accept-encoding", "identity");
      const document = await deps.fetchAsset(
        new Request(documentUrl, { headers: documentHeaders }),
      );
      return document.ok ? deps.transformDocument(document, request) : document;
    } finally {
      if (request.body && !request.body.locked) await request.body.cancel().catch(() => {});
    }
  }

  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    let response: Response;
    try {
      response = await route(request, requestId);
    } catch (error) {
      if (error instanceof BodyTooLarge) response = payloadTooLarge(request);
      else {
        // Do not expose/log a database error's bound values, tokens or request URL.
        try {
          deps.observe({ event: "request_failed", requestId });
        } catch {
          /* Logging cannot replace the response. */
        }
        response = reply(500, "Internal server error");
      }
    }
    // Rejections must not keep an unread upload flowing into a framework.
    if (request.body && !request.body.locked) await request.body.cancel().catch(() => {});
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(deps.responseHeaders))
      if (!headers.has(name)) headers.set(name, value);
    headers.set("x-request-id", requestId);
    const vary = (headers.get("vary") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!vary.some((value) => value === "*" || value.toLowerCase() === "accept-encoding")) {
      vary.push("Accept-Encoding");
      headers.set("vary", vary.join(", "));
    }
    if (!headers.has("cache-control")) headers.set("cache-control", "private, no-store");
    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
