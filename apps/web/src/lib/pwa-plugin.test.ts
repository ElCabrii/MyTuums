import { runInNewContext as runInVmSandbox } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { serviceWorkerSource } from "../../pwa-plugin";

const ORIGIN = "https://mytuums.example";

type WorkerRequest = { method: string; mode: string; url: string };
type FetchEvent = {
  request: WorkerRequest;
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

function serviceWorkerHarness(initialShell: Response, shell: string[] = ["/"]) {
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
    // The real Cache API is disk-backed, so `open` never settles within the
    // caller's microtask checkpoint. Modelling that is what makes the shell
    // refresh below a real test: it is the gap in which the browser consumes
    // the navigation body, so a clone taken after the await comes too late.
    open: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(cache), 0))),
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

  runInVmSandbox(serviceWorkerSource("mytuums-shell-test", shell), {
    Response,
    URL,
    caches,
    fetch: () =>
      fetchResponse instanceof Error
        ? Promise.reject(fetchResponse)
        : Promise.resolve(fetchResponse),
    self,
  });

  function dispatch(request: WorkerRequest) {
    const pending: Promise<unknown>[] = [];
    let result: Promise<Response> | undefined;
    fetchHandler?.({
      request,
      respondWith(responsePromise) {
        result = responsePromise;
      },
      waitUntil(work) {
        pending.push(work);
      },
    });
    return { pending, result };
  }

  return {
    put,
    /** Whether the worker answered the request itself instead of leaving it to the browser. */
    intercepts(path: string, mode = "no-cors"): boolean {
      const { result } = dispatch({ method: "GET", mode, url: new URL(path, ORIGIN).href });
      // The harness is offline by default; the caller only asks whether the
      // worker took the request, so swallow the network failure it would hit.
      result?.catch(() => undefined);
      return result !== undefined;
    },
    async navigate(path: string, response: Response | Error): Promise<string> {
      fetchResponse = response;
      const { pending, result } = dispatch({
        method: "GET",
        mode: "navigate",
        url: new URL(path, ORIGIN).href,
      });
      if (!result) throw new Error("Service worker did not handle the navigation.");
      // The browser starts consuming a navigation body the moment respondWith
      // settles; the worker only gets to keep what it cloned before returning.
      const body = await (await result).text();
      await Promise.all(pending);
      return body;
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
    expect(await harness.navigate("/@alice", new Error("offline"))).toBe("cached shell");
  });

  it("still refreshes the offline shell from a successful same-origin HTML navigation", async () => {
    const harness = serviceWorkerHarness(responseAt("/", "old shell", "text/html"));

    await harness.navigate(
      "/@alice",
      responseAt("/@alice", "fresh shell", "text/html; charset=utf-8"),
    );

    expect(harness.put).toHaveBeenCalledOnce();
    expect(await harness.navigate("/@bob", new Error("offline"))).toBe("fresh shell");
  });
});

describe("generated service worker subresource handling", () => {
  const shell = ["/", "/mytuums.svg", "/assets/index-B5y7ISu1.js"];

  it("serves the precached shell but leaves everything else to the browser", () => {
    const harness = serviceWorkerHarness(responseAt("/", "cached shell", "text/html"), shell);

    expect(harness.intercepts("/assets/index-B5y7ISu1.js")).toBe(true);
    expect(harness.intercepts("/mytuums.svg")).toBe(true);

    // /media 302s to a presigned URL on the storage bucket; re-fetching it from
    // the worker turns an img-src load into a connect-src one the CSP blocks.
    expect(harness.intercepts("/media/posts/42/photo.webp")).toBe(false);
    expect(harness.intercepts("/rpc/posts.feed")).toBe(false);
    expect(harness.intercepts("/assets/index-DifferentBuild.js")).toBe(false);
  });
});
