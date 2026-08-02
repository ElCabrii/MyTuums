import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { resolveClientIp } from "./client-ip.js";

function reqStub(opts: { forwarded?: string | string[]; remote?: string }): IncomingMessage {
  return {
    headers: { "x-forwarded-for": opts.forwarded },
    socket: { remoteAddress: opts.remote },
  } as unknown as IncomingMessage;
}

describe("resolveClientIp", () => {
  it("ignores X-Forwarded-For entirely when trustProxy is false", () => {
    // The header is client-supplied. Honouring it on a direct-to-internet
    // server would let a caller mint a fresh rate-limit bucket on every
    // request just by sending a different X-Forwarded-For — trustProxy has
    // to be an explicit deployment statement, not a default (client-ip.ts).
    const req = reqStub({ forwarded: "203.0.113.9", remote: "198.51.100.1" });
    expect(resolveClientIp(req, false)).toBe("198.51.100.1");
  });

  it("takes the left-most entry of a comma-separated list, trimmed", () => {
    const req = reqStub({ forwarded: "203.0.113.9, 70.41.3.18, 150.172.238.178" });
    expect(resolveClientIp(req, true)).toBe("203.0.113.9");
  });

  it("takes element 0 when Node hands back an array (header sent more than once)", () => {
    const req = reqStub({ forwarded: ["203.0.113.9", "70.41.3.18"] });
    expect(resolveClientIp(req, true)).toBe("203.0.113.9");
  });

  it("falls back to the socket address when the header is present but blank", () => {
    const req = reqStub({ forwarded: "   ", remote: "198.51.100.1" });
    expect(resolveClientIp(req, true)).toBe("198.51.100.1");
  });

  it("normalises an IPv4-mapped IPv6 address from the header", () => {
    const req = reqStub({ forwarded: "::ffff:203.0.113.9" });
    expect(resolveClientIp(req, true)).toBe("203.0.113.9");
  });

  it("normalises an IPv4-mapped IPv6 address from the socket", () => {
    const req = reqStub({ remote: "::ffff:203.0.113.9" });
    expect(resolveClientIp(req, false)).toBe("203.0.113.9");
  });

  it("leaves a plain IPv6 address unchanged", () => {
    const req = reqStub({ remote: "::1" });
    expect(resolveClientIp(req, false)).toBe("::1");
  });

  it("returns undefined when there is neither a header nor a socket address", () => {
    const req = reqStub({});
    expect(resolveClientIp(req, true)).toBe(undefined);
  });
});
