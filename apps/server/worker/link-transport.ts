import { z } from "zod";
import type { LinkFetchTransport } from "../../../packages/api/src/link-card-http.js";

type LinkServiceInput = { hostname: string } | { url: string };

/** A private service binding carries only target URLs, never browser credentials. */
export function createWorkerLinkTransport(service: {
  fetch(request: Request): Promise<Response>;
}): LinkFetchTransport {
  async function call(path: string, input: LinkServiceInput, signal?: AbortSignal) {
    const response = await service.fetch(
      new Request(`https://link-fetcher.internal${path}`, {
        method: "POST",
        body: JSON.stringify(input),
        headers: { "content-type": "application/json" },
        signal,
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Link fetch unavailable.");
    }
    return response;
  }
  return {
    async lookup(hostname, init) {
      const response = await call("/lookup", { hostname }, init?.signal);
      return z.array(z.string()).parse(await response.json());
    },
    async fetch(url, init) {
      const response = await call("/fetch", { url: url.toString() }, init.signal);
      const status = Number(response.headers.get("x-link-status"));
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        await response.body?.cancel();
        throw new Error("Invalid link fetch response.");
      }
      const headers = new Headers();
      for (const name of ["content-type", "location"]) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
      }
      return new Response([204, 205, 304].includes(status) ? null : response.body, {
        status,
        headers,
      });
    },
  };
}
