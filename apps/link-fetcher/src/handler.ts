import { z } from "zod";
import {
  LINK_CARD_FETCH_TIMEOUT_MS,
  LINK_CARD_IMAGE_MAX_BYTES,
} from "../../../packages/api/src/constants.js";
import {
  openGuardedLinkResponse,
  readCappedLinkBody,
  type LinkFetchTransport,
} from "../../../packages/api/src/link-card-http.js";

export const linkFetchRequestSchema = z.discriminatedUnion("path", [
  z.object({
    path: z.literal("/lookup"),
    input: z.object({
      hostname: z
        .string()
        .min(1)
        .max(253)
        .regex(/^[^\s/@?#]+$/u),
    }),
  }),
  z.object({ path: z.literal("/fetch"), input: z.object({ url: z.string().min(1).max(4096) }) }),
]);
type LinkFetchRequest = z.infer<typeof linkFetchRequestSchema>;

/** Internal protocol: one guarded hop, never caller headers or automatic redirects. */
export function createLinkFetchHandler(transport: LinkFetchTransport) {
  let active = 0;
  return async (request: LinkFetchRequest): Promise<Response> => {
    if (active >= 4) return new Response(null, { status: 503 });
    active++;
    try {
      if (request.path === "/lookup") {
        const { hostname } = request.input;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const addresses = await Promise.race([
            transport.lookup(hostname),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Lookup timed out")),
                LINK_CARD_FETCH_TIMEOUT_MS,
              );
            }),
          ]);
          return Response.json(addresses);
        } finally {
          clearTimeout(timer);
        }
      }
      const url = new URL(request.input.url);
      if (url.username || url.password) return new Response(null, { status: 400 });
      const deadline = Date.now() + LINK_CARD_FETCH_TIMEOUT_MS;
      const response = await openGuardedLinkResponse(transport, url, deadline);
      if (
        response === "timeout" ||
        response === "address" ||
        response === "port" ||
        response === "scheme"
      )
        return new Response(null, { status: 502 });
      try {
        const headers = new Headers({ "x-link-status": String(response.status) });
        for (const name of ["content-type", "location"]) {
          const value = response.headers.get(name);
          if (value) headers.set(name, value);
        }
        if (!response.ok) return new Response(null, { headers });
        const bytes = await readCappedLinkBody(response, LINK_CARD_IMAGE_MAX_BYTES, deadline);
        if (bytes === "timeout" || bytes === "oversized" || bytes === "network")
          return new Response(null, { status: 502 });
        return new Response(bytes, { headers });
      } finally {
        if (response.body && !response.body.locked) response.body.cancel().catch(() => {});
      }
    } catch {
      return new Response(null, { status: 502 });
    } finally {
      active--;
    }
  };
}
