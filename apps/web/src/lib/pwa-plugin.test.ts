import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { serviceWorkerSource } from "../../pwa-plugin";

const ORIGIN = "https://mytuums.example";

type NavigationRequest = { method: "GET"; mode: "navigate"; url: string };
type FetchEvent = {
  request: NavigationRequest;
  respondWith(response: Promise<Response>): void;
  waitUntil(work: Promise<unknown>): void;
};

function responseAt(path: string, body: string, contentType: string): Response {
  const response = new Response(body, { headers: { "Content-Type": contentType } });
  Object.defineProperty(response, "url", {
    value: new URL(path, ORIGIN).href,
  });
  return response;
}

function serviceWorkerHarness(initialShell: Response) {
  const entries = new Map<string, Response>([["/", initialShell]]);
  const put = vi.fn((key: string, response: Response): Promise<void> => {
    entries.set(key, response);
    return Promise.resolve();
  });
  const cache = {
    addAll: vi.fn().mockResolvedValue(undefined),
    put,
  };
  const caches = {
    open: vi.fn().mockResolvedValue(cache),
    keys: vi.fn().mockResolvedValue(["mytuums-shell-test"]),
    delete: vi.fn().mockResolvedValue(true),
    match: vi.fn((key: string) => Promise.resolve(entries.get(key)?.clone())),
  };
  let fetchResponse: Response | Error = new Error("offline");
  let fetchHandler: ((event: FetchEvent) => void) | undefined;
  const self = {
    location: { origin: ORIGIN },
    clients: { claim: vi.fn().mockResolvedValue(undefined) },
    addEventListener(type: string, handler: (event: FetchEvent) => void) {
      if (type === "fetch") fetchHandler = handler;
    },
  };

  runInNewContext(serviceWorkerSource("mytuums-shell-test", ["/"]), {
    Response,
    URL,
    caches,
    fetch: () =>
      fetchResponse instanceof Error
        ? Promise.reject(fetchResponse)
        : Promise.resolve(fetchResponse),
    self,
  });

  return {
    put,
    async navigate(path: string, response: Response | Error): Promise<Response> {
      fetchResponse = response;
      const pending: Promise<unknown>[] = [];
      let result: Promise<Response> | undefined;
      fetchHandler?.({
        request: { method: "GET", mode: "navigate", url: new URL(path, ORIGIN).href },
        respondWith(responsePromise) {
          result = responsePromise;
        },
        waitUntil(work) {
          pending.push(work);
        },
      });
      if (!result) throw new Error("Service worker did not handle the navigation.");
      const resolved = await result;
      await Promise.all(pending);
      return resolved;
    },
  };
}

describe("generated service worker navigation caching", () => {
  it("does not replace the app shell with manifest data or cross-origin HTML", async () => {
    const harness = serviceWorkerHarness(responseAt("/", "cached shell", "text/html"));

    await harness.navigate(
      "/manifest.webmanifest",
      responseAt("/manifest.webmanifest", '{"name":"MyTuums"}', "application/manifest+json"),
    );
    await harness.navigate(
      "/login",
      responseAt("https://identity.example/login", "foreign login", "text/html"),
    );

    expect(harness.put).not.toHaveBeenCalled();
    const offline = await harness.navigate("/@alice", new Error("offline"));
    expect(await offline.text()).toBe("cached shell");
  });

  it("still refreshes the offline shell from a successful same-origin HTML navigation", async () => {
    const harness = serviceWorkerHarness(responseAt("/", "old shell", "text/html"));

    await harness.navigate(
      "/@alice",
      responseAt("/@alice", "fresh shell", "text/html; charset=utf-8"),
    );

    expect(harness.put).toHaveBeenCalledOnce();
    const offline = await harness.navigate("/@bob", new Error("offline"));
    expect(await offline.text()).toBe("fresh shell");
  });
});
