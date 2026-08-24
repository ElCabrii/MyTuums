import { describe, expect, it, vi } from "vitest";
import { createMediaResolver, type MediaAuthorizer } from "./media.js";
import { createDestructiveStorage } from "./storage.js";

/**
 * The HIGH-finding regression: `createMediaResolver` used to authorize only
 * `posts/` keys, letting any signed-in caller resolve any profile key — most
 * damagingly the `.orig` originals, which are the owner's untouched files.
 * These tests pin that the authorizer runs for EVERY key, profile included,
 * and that a missing viewer id is itself a denial.
 *
 * Signing is a local operation (see storage.test.ts), so a throwaway config is
 * enough for the resolver's storage half.
 */
function storage() {
  return createDestructiveStorage({
    endpoint: "http://storage.invalid",
    bucket: "test-bucket",
    accessKeyId: "access",
    secretAccessKey: "secret",
    region: "auto",
  });
}

const PROFILE_KEY = "avatars/user-1/11111111-1111-4111-8111-111111111111.webp";
const PROFILE_ORIGINAL_KEY = "avatars/user-1/11111111-1111-4111-8111-111111111111.orig.jpg";
const POST_KEY =
  "posts/author-1/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.png";

describe("createMediaResolver", () => {
  it("denies a profile key when no authorizer is wired", async () => {
    const resolve = createMediaResolver(storage());

    expect(await resolve(PROFILE_KEY, "viewer-1")).toBeNull();
    expect(await resolve(PROFILE_ORIGINAL_KEY, "viewer-1")).toBeNull();
  });

  it("runs the authorizer for profile keys and honours its verdict", async () => {
    const authorize = vi.fn<MediaAuthorizer>().mockResolvedValue(true);
    const resolver = createMediaResolver(storage(), authorize);

    expect(await resolver(PROFILE_KEY, "viewer-1")).not.toBeNull();
    expect(authorize).toHaveBeenCalledWith(PROFILE_KEY, "viewer-1");

    authorize.mockResolvedValue(false);
    expect(await resolver(PROFILE_KEY, "viewer-1")).toBeNull();
  });

  it("denies a profile original to a viewer the authorizer does not accept", async () => {
    const authorize = vi.fn<MediaAuthorizer>().mockResolvedValue(false);
    const resolver = createMediaResolver(storage(), authorize);

    expect(await resolver(PROFILE_ORIGINAL_KEY, "viewer-1")).toBeNull();
    expect(authorize).toHaveBeenCalledWith(PROFILE_ORIGINAL_KEY, "viewer-1");
  });

  it("keeps authorizing post keys through the same gate", async () => {
    const authorize = vi.fn<MediaAuthorizer>().mockResolvedValue(true);
    const resolver = createMediaResolver(storage(), authorize);

    expect(await resolver(POST_KEY, "viewer-1")).not.toBeNull();
    expect(authorize).toHaveBeenCalledWith(POST_KEY, "viewer-1");
  });

  it("treats a missing viewer as a denial", async () => {
    const authorize = vi.fn<MediaAuthorizer>().mockResolvedValue(true);
    const resolver = createMediaResolver(storage(), authorize);

    // The viewer id is required by type; the runtime still fails closed if a
    // future caller stops passing one — there is no authorized=undefined path.
    expect(await resolver(PROFILE_KEY, "")).toBeNull();
    expect(authorize).not.toHaveBeenCalled();
  });
});
