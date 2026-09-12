import { readCappedLinkBody } from "../../../packages/api/src/link-card-http.js";
import { Container } from "@cloudflare/containers";
import { WorkerEntrypoint } from "cloudflare:workers";

export class LinkFetcherContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "60s";
}

/** Only explicitly bound Workers can call this entrypoint. It receives no user headers. */
export class LinkFetchService extends WorkerEntrypoint<LinkEnv> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || (path !== "/lookup" && path !== "/fetch"))
      return new Response(null, { status: 404 });
    const input = await readCappedLinkBody(new Response(request.body), 8192, Date.now() + 5000);
    if (input === "timeout" || input === "oversized" || input === "network")
      return new Response(null, { status: 413 });
    return this.env.CONTAINER.getByName("links").fetch(
      new Request(`http://container${path}`, {
        method: "POST",
        body: input,
        headers: { "content-type": "application/json" },
      }),
    );
  }
}

export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};
