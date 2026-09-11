/** Legacy Node transport. Never import this module into the application Worker. */
import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { Agent } from "undici";
import { isGlobalUnicastAddress, type LinkFetchTransport } from "./link-card-http.js";

/**
 * The non-standard fetch init slot undici's fetch reads, used only through
 * the SAFETY-noted view in `createLinkFetchTransport`. Named because the
 * standard `RequestInit` type carries it only through @types/node's vendored
 * undici-types, whose `Dispatcher` declaration has drifted from the runtime
 * package's.
 */
interface DispatcherInit {
  dispatcher: unknown;
}

/**
 * The connect-time half of the address guard: the same range table
 * `isGlobalUnicastAddress` applies, run inside the HTTP client's own DNS
 * resolution instead of before it.
 *
 * The pre-flight `transport.lookup` check answers "is this hostname safe";
 * this one answers "is the address the socket is about to open safe". A
 * rebinding resolver can pass the first with a public address and answer the
 * client's own resolution moments later with a private one — only validating
 * at connect time, on the address actually connected to, closes that window.
 * (IP literals never reach a lookup — `net` connects to them directly — and
 * a literal cannot rebind: the pre-flight check already judged it.)
 *
 * Exported for its unit pins (the resolver is injectable for exactly that —
 * a pin against the real resolver would be network I/O); the default
 * transport wires it into the dispatcher its fetches ride on.
 */
export function createConnectValidatedLookup(
  resolve: (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]> = dnsLookup,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true, verbatim: true }).then(
      (addresses: LookupAddress[]) => {
        // Every candidate the resolver returns must pass, not just the
        // first: the client may try any of them.
        if (!addresses.every((result) => isGlobalUnicastAddress(result.address))) {
          // The address arguments are ignored once err is set; `""`/`0` are
          // the placeholders the signature demands.
          callback(
            new Error(`connect-time refusal: ${hostname} re-resolved outside global unicast`),
            "",
            0,
          );
          return;
        }
        // dns with `all: true` only ever produces the array form of the
        // callback's union, which is the form undici's connector asks for.
        callback(null, addresses);
      },
      (cause: unknown) => {
        callback(new Error(`connect-time resolution failed: ${hostname}`, { cause }), "", 0);
      },
    );
  };
}

/**
 * The production transport: the real DNS resolver and the real `fetch`, whose
 * dispatcher re-resolves every hop through `createConnectValidatedLookup`.
 */
export function createLinkFetchTransport(): LinkFetchTransport {
  // One pooled dispatcher per transport — the transport is a module singleton
  // (`Context` threads it; tests substitute the whole transport), so a
  // per-fetch Agent would shed its connection pool on every hop.
  const dispatcher = new Agent({ connect: { lookup: createConnectValidatedLookup() } });
  return {
    async lookup(hostname) {
      // A bracketed IPv6 literal (`new URL("http://[::1]/").hostname` keeps
      // the brackets) is unwrapped first: `isIP` and the resolver both
      // refuse the bracketed spelling, so without this a literal IPv6 target
      // would miss the short-circuit and fail resolution instead of being
      // judged by the address guard.
      //
      // SAFETY: this is safe only because `isGlobalUnicastAddress` refuses
      // `::ffff:0:0/96` in both spellings. A bracketed IPv4-mapped literal
      // (`[::ffff:127.0.0.1]`, canonicalized by the URL parser to
      // `[::ffff:7f00:1]`) must not be able to reach the resolver as a
      // "literal IPv6 address" that is really a private IPv4; the range
      // table, not the brackets, is what refuses it.
      const literal =
        hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
      // A literal IP resolves to itself; dnsLookup would accept it too, but
      // short-circuiting keeps literal-IP targets off the resolver entirely.
      if (isIP(literal) !== 0) return [literal];
      const results = await dnsLookup(hostname, { all: true, verbatim: true });
      return results.map((result) => result.address);
    },
    fetch(url, init) {
      // `redirect: "manual"` is load-bearing: an HTTP client that follows
      // redirects internally re-resolves and reconnects with no chance for
      // this module to check the intermediate target. The dispatcher is the
      // rebinding backstop: each hop's socket opens only on an address the
      // connect-time guard passed, so a hostname cannot resolve public for
      // the pre-flight check and private for the actual connection.
      //
      // SAFETY: `dispatcher` is undici's documented non-standard fetch
      // option, and Node's global fetch IS undici's fetch — the option
      // reaches the dispatcher on Node 24 (the runtime this repo pins).
      // It is spread in because no `RequestInit` type carries it: undici's
      // own `fetch` types would, but its `Response` return type is not
      // assignable to the global `Response` every tsconfig in this repo
      // reads, and the transport interface must keep the global one.
      const guardedInit: RequestInit = { signal: init.signal, redirect: "manual" };
      // SAFETY: declaration skew only — `RequestInit`'s `dispatcher` is
      // typed by @types/node's vendored undici-types (7.18), whose
      // `Dispatcher` no longer textually matches the runtime `undici`
      // package's (7.29). Node's global fetch IS undici's fetch and takes
      // any undici Dispatcher at runtime; this Agent is one. The view
      // through `DispatcherInit` compiles to no runtime code.
      (guardedInit as DispatcherInit).dispatcher = dispatcher;
      return fetch(url, guardedInit);
    },
  };
}
