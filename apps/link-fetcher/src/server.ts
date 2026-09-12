import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createLinkFetchTransport } from "../../../packages/api/src/link-card-node.js";
import { createLinkFetchHandler, linkFetchRequestSchema } from "./handler.js";
const handle = createLinkFetchHandler(createLinkFetchTransport());
async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "POST" || !["/lookup", "/fetch"].includes(request.url ?? "")) {
    response.writeHead(404).end();
    return;
  }
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) throw new Error("Invalid body");
      size += chunk.length;
      if (size > 8192) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const requestBody: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const input = linkFetchRequestSchema.parse({ path: request.url, input: requestBody });
    const result = await handle(input);
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    if (!response.headersSent) response.writeHead(400);
    response.end();
  }
}
const server = createServer((request, response) => {
  void handleRequest(request, response).catch(() => response.destroy());
});
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.listen(8080, "0.0.0.0");
