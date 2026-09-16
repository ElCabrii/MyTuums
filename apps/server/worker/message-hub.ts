import { DurableObject } from "cloudflare:workers";
import type { MessagePushEvent } from "@my-tuums/api/message-events";

/**
 * One user's live message-event connections (issue #408): the SSE half of
 * real-time private messages. One instance per user (the user id is the DO
 * name, by design — issue #408), holding that user's open
 * `GET /events/messages` streams and nothing else.
 *
 * The hub is deliberately stateless beyond the connections: D1 is the single
 * source of truth, events carry ids only (never message text or another
 * user's state), and a missed or failed push loses nothing — the client
 * refetches on reconnect and focus. `publish` is the RPC surface the API's
 * injected notifier reaches (packages/api/src/message-events.ts); `fetch`'s
 * `/connect` is the stream the HTTP route proxies.
 */

/** How many concurrent streams one user may hold (multiple tabs). */
const MAX_CONNECTIONS = 3;

/** Keep-alive comment frames keep intermediaries from idling the stream out. */
const KEEP_ALIVE_MS = 25_000;

/**
 * How long any one stream may live before the server closes it. A closed
 * stream is EventSource's signal to reconnect — through the worker route,
 * which re-resolves the session — so a revoked or expired session cannot keep
 * receiving events forever. Short of a push channel for revocation, a bound
 * on stream lifetime is the reauthorization cadence.
 */
const MAX_STREAM_MS = 10 * 60_000;

/** The reconnect hint sent before anything else. */
const RETRY_FRAME = `retry: 5000\n\n`;

interface Connection {
  write(chunk: string): void;
  close(): void;
}

export class MessageHub extends DurableObject {
  /** Insertion-ordered; the head is always the oldest connection. */
  readonly #connections: Connection[] = [];
  #keepAlive: ReturnType<typeof setInterval> | null = null;

  /** The stream endpoint the worker route proxies for an authenticated user. */
  fetch(request: Request): Response {
    if (new URL(request.url).pathname !== "/connect") {
      return new Response("Not found", { status: 404 });
    }

    const encoder = new TextEncoder();
    let connection: Connection | null = null;
    const remove = () => {
      const index = this.#connections.indexOf(connection!);
      if (index >= 0) this.#connections.splice(index, 1);
      this.#stopKeepAliveWhenIdle();
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const lifetime = setTimeout(() => close(), MAX_STREAM_MS);
        const close = () => {
          clearTimeout(lifetime);
          remove();
          try {
            controller.close();
          } catch {
            // Already closed by the client or by eviction; nothing to do.
          }
        };
        connection = {
          write: (chunk) => {
            // A failed write means the reader is gone; that connection drops
            // out of the set without ever breaking fan-out for the others.
            try {
              controller.enqueue(encoder.encode(chunk));
            } catch {
              close();
            }
          },
          close,
        };

        // Bounded per user: the oldest stream is evicted when a new one
        // arrives, so a tab spree cannot accumulate streams indefinitely.
        while (this.#connections.length >= MAX_CONNECTIONS) {
          this.#connections[0].close();
        }
        this.#connections.push(connection);
        this.#startKeepAlive();

        connection.write(RETRY_FRAME);
        // The client disconnecting aborts the request and cancels the
        // response body; both paths must unregister the connection.
        request.signal.addEventListener("abort", close);
      },
      cancel: () => {
        connection?.close();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "private, no-store",
        "x-accel-buffering": "no",
      },
    });
  }

  /** Fans one thin invalidation event out to every live connection. */
  publish(event: MessagePushEvent): void {
    const frame = `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
    // A copy: a failing write closes its connection, which mutates the set
    // mid-iteration.
    for (const connection of this.#connections.slice()) {
      connection.write(frame);
    }
  }

  #startKeepAlive(): void {
    if (this.#keepAlive) return;
    this.#keepAlive = setInterval(() => {
      // Same copy rule as publish: a failed ping drops its own connection.
      for (const connection of this.#connections.slice()) {
        connection.write(": ping\n\n");
      }
    }, KEEP_ALIVE_MS);
  }

  #stopKeepAliveWhenIdle(): void {
    if (this.#connections.length > 0 || !this.#keepAlive) return;
    clearInterval(this.#keepAlive);
    this.#keepAlive = null;
  }
}
