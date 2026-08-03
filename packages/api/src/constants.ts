// Deliberately dependency-free and exposed under its own package subpath
// (`@my-tuums/api/constants`). The web app needs these values at runtime for
// the composer's character counter, and importing them from the package root
// would drag ./router.js -> @my-tuums/db into the browser bundle — where the
// `DATABASE_URL` check in that module throws on import.

/** Maximum length of a post, in characters, after trimming. */
export const POST_MAX_LENGTH = 500;

/** Default and maximum page sizes for `post.list`. */
export const POST_PAGE_SIZE = 20;
export const POST_PAGE_SIZE_MAX = 50;

/** Default and maximum page sizes for `user.followers` / `user.following`. */
export const FOLLOW_PAGE_SIZE = 20;
export const FOLLOW_PAGE_SIZE_MAX = 50;

/**
 * How far up a reply chain `post.thread` will walk to build the ancestor
 * context above the focused post.
 *
 * It is a recursion depth limit first and a UI decision second: the CTE that
 * collects ancestors follows `parent_id` upward, and while the schema makes a
 * cycle impossible (a post's parent must already exist when it is inserted),
 * an unbounded recursive CTE is not something to leave pointed at
 * user-controlled data. The web app uses the same number to decide when to
 * tell the reader the conversation continues above what they can see.
 */
export const THREAD_ANCESTOR_MAX = 20;

/**
 * Maximum length of a profile bio, in characters.
 *
 * DUPLICATED, deliberately, from `BIO_MAX_LENGTH` in
 * `packages/auth/src/profile.ts`, which is where the rule is actually
 * *enforced* — bios are written through `authClient.updateUser`, so the Better
 * Auth database hook is the authority and this copy is only what the web app
 * counts characters against. The two cannot share a module: this file must stay
 * dependency-free for the browser, and `packages/auth` importing
 * `@my-tuums/api` would close a dependency cycle (api already depends on auth).
 *
 * `auth-constants.int.test.ts` asserts the two agree, so a change to one that
 * forgets the other fails a test rather than silently letting the form accept
 * a bio the server rejects.
 */
export const BIO_MAX_LENGTH = 160;

/**
 * What the avatar and banner uploads accept.
 *
 * SVG is absent and must stay absent: it is a document format that can carry
 * script, and these bytes are served back from our own origin. The three
 * raster types below are what a browser canvas can produce, which is what
 * `apps/web/src/lib/media.ts` re-encodes every selected file into before it is
 * ever uploaded.
 */
export const ALLOWED_IMAGE_TYPES = ["image/webp", "image/png", "image/jpeg"] as const;

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/** The two image slots a profile has. Both are optional and independently set. */
export const IMAGE_KINDS = ["avatar", "banner"] as const;

export type ImageKind = (typeof IMAGE_KINDS)[number];

/**
 * Per-slot upload limits.
 *
 * The byte caps are the server's rule and are checked against the actual
 * payload, not a declared length. They are generous relative to what the client
 * actually sends — `downscaleImage` re-encodes an avatar to at most 512x512
 * WebP, which lands well under 200 KB — because the cap exists to bound a
 * hostile upload, not to second-guess a legitimate one.
 */
export const IMAGE_LIMITS = {
  avatar: { maxBytes: 2 * 1024 * 1024, maxWidth: 512, maxHeight: 512 },
  banner: { maxBytes: 4 * 1024 * 1024, maxWidth: 1500, maxHeight: 500 },
} as const satisfies Record<ImageKind, { maxBytes: number; maxWidth: number; maxHeight: number }>;

/**
 * The URL prefix under which uploaded images are served, and the marker that
 * distinguishes our own objects from a provider's absolute avatar URL.
 *
 * A relative path rather than an absolute URL on purpose: it survives the
 * origin changing between dev, E2E and production without rewriting stored
 * rows, and the web app is same-origin with the API in every one of those (see
 * `apps/web/src/lib/orpc.ts`, which resolves `/rpc` against
 * `window.location.origin` for the same reason).
 */
export const MEDIA_URL_PREFIX = "/media/";
