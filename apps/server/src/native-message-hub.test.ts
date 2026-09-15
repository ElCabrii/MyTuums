import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { Miniflare } from "miniflare";
import { afterAll, expect, it } from "vitest";
import type { MessagePushEvent } from "@my-tuums/api/message-events";

// Execute the production class in workerd; only erase TypeScript, never
// replace its streaming or RPC implementation. No account or remote
// resources are used — one synthetic hub per test user name.
const contents = stripTypeScriptTypes(
  await readFile(new URL("../worker/message-hub.ts", import.meta.url), "utf8"),
);
const runtime = new Miniflare({
  workers: [
    {
      config: {
        type: "worker",
        name: "message-hub-test",
        compatibilityDate: "2026-09-10",
        manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents } } },
        exports: { MessageHub: { type: "durable-object", storage: "sqlite" } },
        env: {
          HUBS: {
            type: "durable-object",
            worker: "message-hub-test",
            exportName: "MessageHub",
          },
        },
      },
    },
  ],
});
type HubBindings = {
  HUBS: {
    getByName(name: string): {
      fetch(url: string): Promise<Response>;
      publish(event: MessagePushEvent): Promise<void>;
    };
  };
};
const { HUBS } = await runtime.getBindings<HubBindings>("message-hub-test");
afterAll(() => runtime.dispose());

/** One live connection: consumes the initial retry frame, then reads events. */
async function connect(name: string) {
  const response = await HUBS.getByName(name).fetch("https://hub/connect");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  // The binding types the stream loosely; the frame protocol is text.
  const reader = response.body!.getReader();
  const read = async (): Promise<{ done: boolean; chunk: string }> => {
    const result = (await reader.read()) as { done: boolean; value?: Uint8Array };
    return {
      done: result.done,
      chunk: new TextDecoder().decode(result.value ?? new Uint8Array()),
    };
  };
  expect((await read()).chunk).toBe("retry: 5000\n\n");
  return { reader, read };
}

it("fans one event out to every live connection of the same user, ids only", async () => {
  const tab1 = await connect("fan-out-user");
  const tab2 = await connect("fan-out-user");
  const event = { kind: "message", conversationId: "c-1" } as const;

  await HUBS.getByName("fan-out-user").publish(event);

  const frame = `event: message\ndata: ${JSON.stringify(event)}\n\n`;
  expect((await tab1.read()).chunk).toBe(frame);
  expect((await tab2.read()).chunk).toBe(frame);
  await tab1.reader.cancel();
  await tab2.reader.cancel();
});

it("keeps one user's events out of another user's hub", async () => {
  const alice = await connect("isolation-alice");
  const bob = await connect("isolation-bob");

  await HUBS.getByName("isolation-alice").publish({ kind: "unread" });
  await HUBS.getByName("isolation-bob").publish({ kind: "unread" });

  // Alice's frame is HER hub's publish — bob's connection receives only his.
  expect((await alice.read()).chunk).toContain(`"kind":"unread"`);
  expect((await bob.read()).chunk).toContain(`"kind":"unread"`);
  await alice.reader.cancel();
  await bob.reader.cancel();
});

it("bounds one user to three connections, evicting the oldest", async () => {
  const oldest = await connect("capped-user");
  const second = await connect("capped-user");
  const third = await connect("capped-user");
  // The fourth connection evicts the oldest, not the newest.
  const fourth = await connect("capped-user");

  expect((await oldest.read()).done).toBe(true);

  await HUBS.getByName("capped-user").publish({ kind: "unread" });
  for (const connection of [second, third, fourth]) {
    expect((await connection.read()).chunk).toContain(`"kind":"unread"`);
  }
  for (const connection of [oldest, second, third, fourth]) {
    await connection.reader.cancel();
  }
});

it("a disconnected reader drops out without breaking fan-out to the rest", async () => {
  const gone = await connect("cleanup-user");
  const staying = await connect("cleanup-user");
  // Cancelling the response body is the client-disconnect path: the stream's
  // cancel callback must unregister the connection.
  await gone.reader.cancel();

  await HUBS.getByName("cleanup-user").publish({ kind: "unread" });
  expect((await staying.read()).chunk).toContain(`"kind":"unread"`);
  await staying.reader.cancel();
});

it("refuses unknown paths", async () => {
  const response = await HUBS.getByName("fan-out-user").fetch("https://hub/elsewhere");
  expect(response.status).toBe(404);
});
