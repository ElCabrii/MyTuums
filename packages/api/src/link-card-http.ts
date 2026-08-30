/**
 * The outbound half of link preview cards (issue #260): everything between
 * "an author typed a URL" and "here is the Open Graph payload" — the SSRF
 * address guard, the bounded fetch, and the metadata parser.
 *
 * Pure with respect to this package's database and bucket: the only I/O is
 * the injected `LinkFetchTransport`, so every rule here is unit-testable with
 * a fake transport while production runs the real DNS resolver and `fetch`.
 * The database cache lives beside the procedure in `./link-card.ts`.
 *
 * Every refusal here is a *degrade to the plain link*, never an error the
 * post inherits: a dead URL, a timeout, an oversized or non-HTML target, or a
 * refused private address all leave the caller with "no card".
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  LINK_CARD_DESCRIPTION_MAX_LENGTH,
  LINK_CARD_FETCH_TIMEOUT_MS,
  LINK_CARD_MAX_REDIRECTS,
  LINK_CARD_TITLE_MAX_LENGTH,
} from "./constants.js";

/**
 * The two operations the guard needs from the network. Injectable so tests
 * drive the real guard logic — scheme checks, address validation, redirect
 * re-checks, size and time caps — without reaching anything.
 *
 * `lookup` is separate from `fetch` on purpose: the guard resolves the
 * hostname itself and validates every address BEFORE the request is sent.
 * Delegating that to the HTTP client would validate nothing — a hostname is
 * not an address, and `localtest.me`-style names resolve straight to
 * loopback.
 */
export interface LinkFetchTransport {
  /** Every address the hostname resolves to. Must throw when it does not resolve. */
  lookup(hostname: string): Promise<string[]>;
  /** One request. Redirects are NEVER followed here — the guard re-checks each hop. */
  fetch(url: URL, init: { signal: AbortSignal }): Promise<Response>;
}

/** The production transport: the real DNS resolver and the real `fetch`. */
export function createLinkFetchTransport(): LinkFetchTransport {
  return {
    async lookup(hostname) {
      // A literal IP resolves to itself; dnsLookup would accept it too, but
      // short-circuiting keeps literal-IP targets off the resolver entirely.
      if (isIP(hostname) !== 0) return [hostname];
      const results = await dnsLookup(hostname, { all: true, verbatim: true });
      return results.map((result) => result.address);
    },
    fetch(url, init) {
      // `redirect: "manual"` is load-bearing: an HTTP client that follows
      // redirects internally re-resolves and reconnects with no chance for
      // this module to check the intermediate target.
      return fetch(url, { signal: init.signal, redirect: "manual" });
    },
  };
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/**
 * Refused IPv4 ranges, as `[first, last]` inclusive integer pairs. Everything
 * outside this table that parses as IPv4 is global unicast.
 *
 * Composed from the IANA special-purpose registry rather than a blocklist of
 * "the dangerous ones": loopback, RFC 1918 private, link-local (including the
 * cloud-metadata 169.254.169.254), CGNAT shared, benchmarking, the three
 * TEST-NETs, the reserved and multicast halves of the space, and the
 * this-network and assignment blocks. Refusing special-purpose ranges rather
 * than allowing "not private" is what makes the answer "non-global ⇒ no" —
 * a range added to the registry tomorrow is refused until it is listed here.
 */
const REFUSED_IPV4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const;

// SAFETY: every entry above is a literal that parses; `ipv4ToLong` returning
// null there would mean the table itself is malformed, which the unit tests pin.
const REFUSED_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = REFUSED_IPV4_CIDRS.map(
  (cidr) => {
    const [base, bitsText] = cidr.split("/");
    const bits = Number(bitsText);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    const first = ((ipv4ToLong(base) ?? 0) & mask) >>> 0;
    return [first, (first | (~mask >>> 0)) >>> 0] as const;
  },
);

function ipv4ToLong(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/** An IPv6 address as one 128-bit BigInt, or `null` when it does not parse. */
function parseIpv6(address: string): bigint | null {
  let normalized = address;

  // An embedded IPv4 tail (`::ffff:127.0.0.1`, `2001:db8::192.0.2.1`) becomes
  // its two hex groups so the rest of the parser is hex-only.
  const lastColon = normalized.lastIndexOf(":");
  const tail = normalized.slice(lastColon + 1);
  if (tail.includes(".")) {
    const tailValue = ipv4ToLong(tail);
    if (tailValue === null) return null;
    const high = (tailValue >>> 16).toString(16);
    const low = (tailValue & 0xffff).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const leftGroups =
    halves.length === 2 ? (halves[0] ? halves[0].split(":") : []) : normalized.split(":");
  const rightGroups = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const clean = (groups: string[]) => groups.filter((group) => group !== "");
  const left = clean(leftGroups);
  const right = clean(rightGroups);

  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;

  let value = 0n;
  for (const group of [
    ...left,
    ...Array.from({ length: Math.max(missing, 0) }, () => "0"),
    ...right,
  ]) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

/**
 * An inclusive BigInt pair for one IPv6 CIDR, from its canonical first
 * address. Written as a helper rather than hand-reduced literals so the table
 * below states "NAT64 is 64:ff9b::/96" and nothing has to be re-derived.
 */
function cidrRange(firstAddress: bigint, bits: number): readonly [bigint, bigint] {
  const hostBits = BigInt(128 - bits);
  return [firstAddress, firstAddress | ((1n << hostBits) - 1n)];
}

/** Refused IPv6 ranges — the IPv6 half of the IANA special-purpose registry. */
const REFUSED_IPV6_RANGES: ReadonlyArray<readonly [bigint, bigint]> = [
  [0n, 1n], // :: (unspecified) and ::1 (loopback)
  cidrRange(0x64ff9bn << 96n, 96), // NAT64 — reaches IPv4 space by gateway policy
  cidrRange(0x100n << 112n, 64), // discard-only
  cidrRange(0x20010db8n << 96n, 32), // documentation
  cidrRange(0xfc00n << 112n, 7), // unique local
  cidrRange(0xfe80n << 112n, 10), // link-local
  cidrRange(0xff00n << 112n, 8), // multicast
];

/**
 * Whether `address` is a global unicast target this app is willing to fetch.
 *
 * The one address form that resolves to another family — IPv4-mapped IPv6
 * (`::ffff:a.b.c.d`) — is judged by the IPv4 address it denotes, because that
 * is where the connection actually lands. Every special-purpose range of
 * either family is refused; anything unparseable is refused (fail closed).
 */
export function isGlobalUnicastAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) {
    const value = ipv4ToLong(address);
    if (value === null) return false;
    return !REFUSED_IPV4_RANGES.some(([first, last]) => value >= first && value <= last);
  }

  if (family === 6) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    if (mapped?.[1]) return isGlobalUnicastAddress(mapped[1]);
    const value = parseIpv6(address);
    if (value === null) return false;
    return !REFUSED_IPV6_RANGES.some(([first, last]) => value >= first && value <= last);
  }

  return false;
}

// ---------------------------------------------------------------------------
// The guarded fetch
// ---------------------------------------------------------------------------

/** Why a guarded fetch refused. Coarse on purpose — every reason degrades identically. */
export type GuardedFetchFailure =
  | "scheme"
  | "address"
  | "redirects"
  | "timeout"
  | "oversized"
  | "contentType"
  | "status"
  | "network";

export interface GuardedFetchSuccess {
  ok: true;
  bytes: Uint8Array;
  /** The declared media type, parameters stripped, lowercased. */
  contentType: string;
  /** The URL the bytes actually came from — after the followed redirects. */
  finalUrl: URL;
}

export type GuardedFetchResult = GuardedFetchSuccess | { ok: false; reason: GuardedFetchFailure };

/**
 * Fetches `url` under the card's whole defence line:
 *
 * - only `http`/`https` — the same scheme rule the client's linkifier applies,
 *   so `javascript:`/`data:` targets never become an outbound request;
 * - the hostname is resolved and EVERY resolved address must be global
 *   unicast, before any bytes are requested;
 * - redirects are followed manually, at most `LINK_CARD_MAX_REDIRECTS`, and
 *   every hop re-runs the scheme and address checks — a public first hop that
 *   redirects to `169.254.169.254` is refused at the hop, not discovered
 *   after the response body arrives;
 * - one wall-clock deadline covers every hop, enforced by racing the transport
 *   (an uncooperative transport cannot out-wait it);
 * - the body is streamed and cut off at `maxBytes`;
 * - the declared content type must satisfy `acceptContentType` before the
 *   body is read at all.
 */
export async function guardedLinkFetch(
  url: URL,
  options: {
    transport: LinkFetchTransport;
    maxBytes: number;
    /** Narrow the deadline; the default is the production ceiling. */
    timeoutMs?: number;
    acceptContentType: (contentType: string) => boolean;
  },
): Promise<GuardedFetchResult> {
  const deadline = Date.now() + (options.timeoutMs ?? LINK_CARD_FETCH_TIMEOUT_MS);

  let current = url;
  for (let hop = 0; hop <= LINK_CARD_MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      return { ok: false, reason: "scheme" };
    }

    // Resolve and validate before connecting. A hostname that fails to
    // resolve is as refused as one that resolves somewhere private: there is
    // no address this app is willing to dial for it.
    if (current.hostname.length === 0) return { ok: false, reason: "address" };
    let addresses: string[];
    try {
      addresses = await options.transport.lookup(current.hostname);
    } catch {
      return { ok: false, reason: "address" };
    }
    if (addresses.length === 0 || !addresses.every((address) => isGlobalUnicastAddress(address))) {
      return { ok: false, reason: "address" };
    }

    let response: Response | "timeout";
    try {
      response = await fetchRacingDeadline(options.transport, current, deadline);
    } catch {
      // A refused/dropped/reset connection is an ordinary dead target. The
      // guard degrades to "no card"; a transport error must never surface as
      // a procedure failure the post inherits.
      return { ok: false, reason: "network" };
    }
    if (response === "timeout") return { ok: false, reason: "timeout" };

    const location = response.headers.get("location");
    if (
      response.status === 301 ||
      response.status === 302 ||
      response.status === 303 ||
      response.status === 307 ||
      response.status === 308
    ) {
      if (!location) return { ok: false, reason: "network" };
      const next = new URL(location, current);
      // The next iteration re-runs every check on `next` — scheme, DNS,
      // ranges — which is the entire point of following redirects manually.
      if (hop === LINK_CARD_MAX_REDIRECTS) return { ok: false, reason: "redirects" };
      current = next;
      continue;
    }

    if (!response.ok) return { ok: false, reason: "status" };

    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (!options.acceptContentType(contentType)) return { ok: false, reason: "contentType" };

    const bytes = await readCappedBody(response, options.maxBytes, deadline);
    if (bytes === "timeout") return { ok: false, reason: "timeout" };
    if (bytes === "oversized") return { ok: false, reason: "oversized" };
    if (bytes === "network") return { ok: false, reason: "network" };

    return { ok: true, bytes, contentType, finalUrl: current };
  }

  // Unreachable: the hop budget is checked before following a redirect.
  return { ok: false, reason: "redirects" };
}

function normalizeContentType(header: string | null): string {
  return ((header ?? "").split(";")[0] ?? "").trim().toLowerCase();
}

async function fetchRacingDeadline(
  transport: LinkFetchTransport,
  url: URL,
  deadline: number,
): Promise<Response | "timeout"> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return "timeout";

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => {
      // Resolve before aborting: the abort makes a cooperative transport
      // reject in the same tick, and whichever settles first wins the race
      // below. The deadline firing IS the answer — "network" is for failures
      // that happen on their own.
      resolve("timeout");
      controller.abort();
    }, remaining);
  });

  const fetchPromise = transport.fetch(url, { signal: controller.signal });
  // A transport that loses the race can still reject afterwards (the socket
  // error the abort causes). The race never observes it; attach the no-op
  // catch so it cannot surface as an unhandled rejection either.
  fetchPromise.catch(() => {});

  try {
    return await Promise.race([fetchPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Reads `response.body` up to `maxBytes`, racing every chunk against the
 * deadline. A body that drips one byte per tick is as refused as one that
 * never answers: the deadline is total, not per-read.
 */
async function readCappedBody(
  response: Response,
  maxBytes: number,
  deadline: number,
): Promise<Uint8Array | "timeout" | "oversized" | "network"> {
  if (response.body === null) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return "timeout";

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => resolve("timeout"), remaining);
      });
      const readPromise = reader.read();
      readPromise.catch(() => {});

      // Named through the reader's own return type rather than
      // `ReadableStreamReadResult`, which this package's tsconfig cannot
      // resolve — only the shape matters here.
      type Read = Awaited<ReturnType<typeof reader.read>>;
      let read: Read | "timeout";
      try {
        read = await Promise.race([readPromise, timeoutPromise]);
      } finally {
        clearTimeout(timeoutId);
      }
      if (read === "timeout") return "timeout";

      if (read.done) break;
      // SAFETY: the reader's element type reads as `any` under this package's
      // tsconfig; the runtime check is the honest narrow. A stream that hands
      // out something other than bytes is a broken transport.
      if (!(read.value instanceof Uint8Array)) return "network";
      chunks.push(read.value);
      total += read.value.byteLength;
      if (total > maxBytes) return "oversized";
    }
  } finally {
    // Cancel releases the transport's resources on every early exit — a
    // refusal must not leave the connection draining in the background.
    reader.cancel().catch(() => {});
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Open Graph / Twitter Card parsing
// ---------------------------------------------------------------------------

/** The card fields extracted from a target page. `title` present ⇒ a card exists. */
export interface OpenGraphMetadata {
  title: string;
  description: string | null;
  /** Absolute, or `null` when absent/unresolvable. Still guarded before fetching. */
  imageUrl: string | null;
  siteName: string | null;
}

/** `og:` first, Twitter Card names as the fallback, per field. */
function metaValue(tags: ReadonlyMap<string, string>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = tags.get(key);
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** Decodes the handful of entities metadata values actually carry. */
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|\w+);/gi, (match, body: string) => {
    switch (body.toLowerCase()) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
      case "#39":
        return "'";
      case "nbsp":
        return "\u00a0";
      default: {
        const hex = /^#x([0-9a-f]+)$/i.exec(body);
        const decimal = /^#([0-9]+)$/.exec(body);
        if (hex || decimal) {
          const code = hex?.[1]
            ? Number.parseInt(hex[1], 16)
            : decimal?.[1]
              ? Number.parseInt(decimal[1], 10)
              : Number.NaN;
          if (Number.isNaN(code) || code > 0x10ffff) return match;
          return String.fromCodePoint(code);
        }
        return match;
      }
    }
  });
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Extracts the card metadata from fetched HTML.
 *
 * `<meta>` attributes are picked apart with a bounded scan rather than a DOM
 * parser: the HTML is already capped at `LINK_CARD_HTML_MAX_BYTES`, meta
 * attributes may appear in any order and any quote style, and nothing else of
 * the document is interesting. Returns `null` when no title is present — the
 * "no Open Graph payload" case, which is a non-card, not an error.
 */
export function parseOpenGraphMetadata(html: string, baseUrl: URL): OpenGraphMetadata | null {
  const tags = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    let key: string | undefined;
    let content: string | undefined;
    for (const attribute of tag.match(/[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g) ?? []) {
      const separator = attribute.indexOf("=");
      if (separator === -1) continue;
      const name = attribute.slice(0, separator).trim().toLowerCase();
      const rawValue = attribute.slice(separator + 1).trim();
      const value =
        rawValue.startsWith('"') || rawValue.startsWith("'") ? rawValue.slice(1, -1) : rawValue;
      if ((name === "property" || name === "name") && key === undefined) key = value.toLowerCase();
      if (name === "content" && content === undefined) content = value;
    }
    if (key !== undefined && content !== undefined && !tags.has(key)) tags.set(key, content);
  }

  const rawTitle = metaValue(tags, ["og:title", "twitter:title"]);
  if (rawTitle === undefined) return null;

  const rawDescription = metaValue(tags, ["og:description", "twitter:description"]);
  const rawSiteName = metaValue(tags, ["og:site_name", "twitter:site"]);
  const rawImage = metaValue(tags, [
    "og:image",
    "og:image:url",
    "twitter:image",
    "twitter:image:src",
  ]);

  let imageUrl: string | null = null;
  if (rawImage !== undefined) {
    try {
      const resolved = new URL(decodeEntities(rawImage), baseUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        imageUrl = resolved.toString();
      }
    } catch {
      imageUrl = null;
    }
  }

  return {
    title: truncate(decodeEntities(rawTitle), LINK_CARD_TITLE_MAX_LENGTH),
    description:
      rawDescription === undefined
        ? null
        : truncate(decodeEntities(rawDescription), LINK_CARD_DESCRIPTION_MAX_LENGTH),
    imageUrl,
    siteName: rawSiteName === undefined ? null : decodeEntities(rawSiteName),
  };
}
