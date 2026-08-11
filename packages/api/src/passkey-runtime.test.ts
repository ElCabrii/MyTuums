import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The published passkey plugin contains the endpoint implementation that
 * Better Auth executes at runtime. Keep this contract test next to the unit
 * suites so removing the pnpm patch cannot silently restore optional UV.
 * A database-backed ceremony is intentionally not needed to prove these
 * constants; the integration suite covers the surrounding auth wiring.
 */
const authRequire = createRequire(new URL("../../auth/package.json", import.meta.url));
const passkeyRuntime = readFileSync(authRequire.resolve("@better-auth/passkey"), "utf8");

describe("passkey runtime user-verification contract", () => {
  it("requires user verification for both ceremonies and their assertions", () => {
    expect(passkeyRuntime.match(/userVerification: "required"/g)).toHaveLength(2);
    expect(passkeyRuntime).not.toContain('userVerification: "preferred"');
    expect(passkeyRuntime.match(/requireUserVerification: true/g)).toHaveLength(2);
    expect(passkeyRuntime).not.toContain("requireUserVerification: false");
  });
});
