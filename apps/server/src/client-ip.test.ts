import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { resolveClientIp } from "./client-ip.js";

interface Stub {
  forwarded?: string | string[];
  remote?: string;
}

function reqStub(opts: Stub): IncomingMessage {
  return {
    headers: { "x-forwarded-for": opts.forwarded },
    socket: { remoteAddress: opts.remote },
  } as unknown as IncomingMessage;
}

function expectResolved(
  cases: readonly (readonly [Stub, boolean, string | undefined])[],
): void {
  expect(cases.map(([opts, trustProxy]) => [opts, resolveClientIp(reqStub(opts), trustProxy)])).toEqual(
    cases.map(([opts, , expected]) => [opts, expected]),
  );
}

describe("resolveClientIp", () => {
  it("ignores X-Forwarded-For entirely when trustProxy is false", () => {
    // The header is client-supplied. Honouring it on a direct-to-internet
    // server would let a caller mint a fresh rate-limit bucket on every
    // request just by sending a different X-Forwarded-For — trustProxy has
    // to be an explicit deployment statement, not a default (client-ip.ts).
    expectResolved([[{ forwarded: "203.0.113.9", remote: "198.51.100.1" }, false, "198.51.100.1"]]);
  });

  it("takes the left-most forwarded entry when trustProxy is true, else the socket", () => {
    expectResolved([
      // Comma-separated list, trimmed.
      [{ forwarded: "203.0.113.9, 70.41.3.18, 150.172.238.178" }, true, "203.0.113.9"],
      // Node hands back an array when the header is sent more than once.
      [{ forwarded: ["203.0.113.9", "70.41.3.18"] }, true, "203.0.113.9"],
      // Present but blank falls through to the socket address.
      [{ forwarded: "   ", remote: "198.51.100.1" }, true, "198.51.100.1"],
      // Neither available at all.
      [{}, true, undefined],
    ]);
  });

  it("normalises IPv4-mapped IPv6 from either source, leaving plain IPv6 alone", () => {
    expectResolved([
      [{ forwarded: "::ffff:203.0.113.9" }, true, "203.0.113.9"],
      [{ remote: "::ffff:203.0.113.9" }, false, "203.0.113.9"],
      [{ remote: "::1" }, false, "::1"],
    ]);
  });
});
