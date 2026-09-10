import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { parseMediaVariantKey } from "./constants.js";
import { createMediaResolver, type MediaAuthorizer } from "./media.js";
import { createDestructiveStorage, type Storage } from "./storage.js";

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

/** A tiny real PNG, so the variant generator's sharp half runs for real. */
const PNG_BYTES = await sharp({
  create: { width: 64, height: 48, channels: 3, background: "#d63384" },
})
  .png()
  .toBuffer();

/** One GIF magic byte pair — enough for the contentType branch; the generator never decodes it. */
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

/**
 * An in-memory Storage with the variant half's needs (`head`, `get`, `put`)
 * — the real S3 client cannot be pointed at nothing from a unit test, and
 * `createDestructiveStorage` would dial `storage.invalid` on `head`. The
 * `put` mock is returned beside the storage (rather than read off it) so an
 * assertion can name it without the unbound-method dance.
 */
function variantCapableStorage() {
  const objects = new Map<string, { contentType: string; bytes: Uint8Array }>([
    [POST_KEY, { contentType: "image/png", bytes: PNG_BYTES }],
  ]);
  const put = vi.fn((key: string, bytes: Uint8Array, contentType: string) => {
    objects.set(key, { contentType, bytes });
    return Promise.resolve();
  });
  const storage: Storage = {
    put,
    remove: () => Promise.resolve(),
    head: (key: string) => Promise.resolve(objects.get(key) ?? null),
    get: (key: string) => Promise.resolve(objects.get(key) ?? null),
    signedGetUrl: (key: string) => Promise.resolve(`https://storage.test.invalid/${key}?signed=1`),
  };
  return { storage, objects, put };
}

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

  it("passes a null viewer — the anonymous post-permalink reader — to the authorizer", async () => {
    const authorize = vi.fn<MediaAuthorizer>().mockResolvedValue(true);
    const resolver = createMediaResolver(storage(), authorize);

    expect(await resolver(POST_KEY, null)).not.toBeNull();
    expect(authorize).toHaveBeenCalledWith(POST_KEY, null);

    authorize.mockResolvedValue(false);
    expect(await resolver(POST_KEY, null)).toBeNull();
  });

  it("authorizes a variant key against its BASE and serves the variant once it exists", async () => {
    // 0.4.0 responsive images: `…/uuid.w640.webp` derives from the base the
    // rows actually store, so THAT is what authorization must judge — a
    // variant can never be more visible than the object it derives from.
    const { storage: fake, put } = variantCapableStorage();
    const authorize = vi.fn<MediaAuthorizer>().mockResolvedValue(true);
    const resolver = createMediaResolver(fake, authorize);

    const variantKey =
      "posts/author-1/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.png.w640.webp";
    const result = await resolver(variantKey, null);

    expect(authorize).toHaveBeenCalledWith(POST_KEY, null);
    expect(result?.url).toContain(variantKey.slice("posts/".length));
    expect(put).toHaveBeenCalledWith(variantKey, expect.any(Uint8Array), "image/webp");
  });

  it("serves the base object when a requested variant is not derivable — unknown width or GIF", async () => {
    const { storage: fake, objects } = variantCapableStorage();
    const authorize = vi.fn<MediaAuthorizer>().mockResolvedValue(true);
    const resolver = createMediaResolver(fake, authorize);

    // An arbitrary width is not in MEDIA_VARIANT_WIDTHS: parseMediaVariantKey
    // refuses it, so the key is authorized (and served) AS IS — nothing in
    // this app will have generated it, and the row comparison in the real
    // authorizer 404s it.
    const rogue =
      "posts/author-1/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.png.w9999.webp";
    await resolver(rogue, null);
    expect(authorize).toHaveBeenCalledWith(rogue, null);

    // An animated GIF's variant falls back to the original bytes.
    objects.set(POST_KEY.replace(/png$/, "gif"), {
      contentType: "image/gif",
      bytes: GIF_BYTES,
    });
    const gifVariant =
      "posts/author-1/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.gif.w640.webp";
    const gifResult = await resolver(gifVariant, null);
    expect(gifResult?.url).toContain("22222222-2222-4222-8222-222222222222.gif");
  });

  it("forwards the policy's verdict per key and lets a null mean no-store", async () => {
    const authorize = vi.fn<MediaAuthorizer>().mockResolvedValue(true);
    const cachePolicy = vi
      .fn<(key: string) => string | null>()
      .mockImplementation((key) => (key === PROFILE_KEY ? "private, max-age=1200" : null));
    const resolver = createMediaResolver(storage(), authorize, cachePolicy);

    // The display key's directive passes through verbatim...
    const display = await resolver(PROFILE_KEY, "viewer-1");
    expect(display?.url).toBeTruthy();
    expect(display?.cacheControl).toBe("private, max-age=1200");
    // ...the original's refusal comes back as NO field, which the caller
    // answers with its no-store default.
    const original = await resolver(PROFILE_ORIGINAL_KEY, "viewer-1");
    expect(original).not.toHaveProperty("cacheControl");
    expect(cachePolicy).toHaveBeenCalledWith(PROFILE_KEY);
    expect(cachePolicy).toHaveBeenCalledWith(PROFILE_ORIGINAL_KEY);
  });
});

/**
 * The games half of the variant vocabulary (issue #314): a cover's derived
 * widths are exactly 320 and 640 — the one place the allowlist is spelled for
 * a key prefix, so a browser `srcset` and the server's lazy generation can
 * never name a width the other refuses.
 */
describe("parseMediaVariantKey for game covers", () => {
  it("parses 320 and 640 off a games base, and refuses every other width", () => {
    expect(parseMediaVariantKey("games/123-co1r7e.jpg.w320.webp")).toEqual({
      baseKey: "games/123-co1r7e.jpg",
      width: 320,
    });
    expect(parseMediaVariantKey("games/123-co1r7e.jpg.w640.webp")).toEqual({
      baseKey: "games/123-co1r7e.jpg",
      width: 640,
    });
    // A width no surface of this app requests for covers: `isSafeObjectKey`
    // accepts it structurally, the parse refuses it, so the resolver serves
    // the rogue key AS IS — never a generation request.
    expect(parseMediaVariantKey("games/123-co1r7e.jpg.w1280.webp")).toBeNull();
    expect(parseMediaVariantKey("games/123-co1r7e.jpg")).toBeNull();
  });
});
