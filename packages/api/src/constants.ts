// Deliberately dependency-free and exposed under its own package subpath
// (`@my-tuums/api/constants`). The web app needs these values at runtime for
// the composer's character counter, and importing them from the package root
// would drag ./router.js -> @my-tuums/db into the browser bundle — where the
// `DATABASE_URL` check in that module throws on import.
//
// Account rules — the bio limit, the handle bounds, the date-of-birth and
// preference rules — are deliberately NOT here. They belong to
// `@my-tuums/auth/rules`, which is browser-safe on the same terms and is the
// package that actually enforces them.

/** Maximum length of a post, in characters, after trimming. */
export const POST_MAX_LENGTH = 500;

/**
 * Initial post-media scope. The same limits apply to top-level posts and
 * replies because both are rows in `post` and share one composer contract.
 * Attachments are stored as the validated bytes the web app re-encoded for
 * us — bounded by these caps, and carrying no container metadata because a
 * canvas encode emits pixels only (issue #207); no client-supplied URL or
 * data URI is ever persisted.
 */
export const POST_ATTACHMENT_MAX_COUNT = 4;
export const POST_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const POST_ATTACHMENT_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
export const POST_ATTACHMENT_MAX_WIDTH = 4096;
export const POST_ATTACHMENT_MAX_HEIGHT = 4096;
export const POST_ATTACHMENT_MAX_MEGAPIXELS = 50;

/** Default and maximum page sizes for `post.list`. */
export const POST_PAGE_SIZE = 20;
export const POST_PAGE_SIZE_MAX = 50;

/** Default and maximum page sizes for `user.followers` / `user.following`. */
export const FOLLOW_PAGE_SIZE = 20;
export const FOLLOW_PAGE_SIZE_MAX = 50;

/** Maximum length of a search query, in characters, after trimming. */
export const SEARCH_QUERY_MAX_LENGTH = 100;

/** Default and maximum page sizes for `search.users` / `search.posts`. */
export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_PAGE_SIZE_MAX = 50;

/** Default and maximum page sizes for `moderation.queue` / `moderation.auditLog`. */
export const MODERATION_PAGE_SIZE = 20;
export const MODERATION_PAGE_SIZE_MAX = 50;

/** Maximum encoded length accepted for every opaque keyset cursor. */
export const CURSOR_MAX_ENCODED_LENGTH = 512;

/** Maximum length of a textual id carried inside a decoded cursor payload. */
export const CURSOR_ID_MAX_LENGTH = 128;

/** Maximum length of a moderator's stated reason or note, in characters, after trimming. */
export const MODERATION_NOTE_MAX_LENGTH = 1000;

/**
 * The nine stable moderation action codes — the `moderation_action.action`
 * check constraint's list (packages/db/src/schema/app.ts).
 *
 * These live here, in the dependency-free constants module, so unit tests can
 * pin them without importing `moderation-actions.ts` — which pulls in
 * `@my-tuums/auth` → `@my-tuums/db`, and the latter throws at module scope
 * when `DATABASE_URL` is unset. `moderation-actions.ts` re-exports them, so
 * every runtime importer keeps working unchanged.
 */
export const MODERATION_ACTION_CODES = [
  "post_removed",
  "post_restored",
  "user_suspended",
  "user_unsuspended",
  "user_banned",
  "user_unbanned",
  "role_changed",
  "case_resolved",
  "appeal_resolved",
] as const;

/** One of the nine action codes. */
export type ModerationActionCode = (typeof MODERATION_ACTION_CODES)[number];

/**
 * The four appealable actions and the inverse code the overturn logs.
 * `role_changed` maps to itself: the restore is another role change, and its
 * logged row records the full swing (old → the granted role → back).
 */
export const INVERSE_ACTION = {
  post_removed: "post_restored",
  user_suspended: "user_unsuspended",
  user_banned: "user_unbanned",
  role_changed: "role_changed",
} as const;

/**
 * The actions `appealOpen` accepts, derived from the inverse map so the two
 * lists can never drift — anything with an inverse is appealable.
 */
export const APPEALABLE_ACTIONS =
  // SAFETY: Object.keys returns exactly INVERSE_ACTION's checked own keys.
  Object.keys(INVERSE_ACTION) as ModerationActionCode[];

/**
 * The stable report-reason codes (issue #38), one set per target type.
 *
 * The codes ARE the contract: they are checked into the `report` table's
 * check constraint (packages/db/src/schema/app.ts), accepted verbatim by
 * `moderation.report`'s discriminated union, and translated at render time
 * by the web app's message catalogue — renaming one lands in all three
 * places or the check constraint and the union stop agreeing.
 */
export const POST_REPORT_REASONS = [
  "spam",
  "harassment",
  "hate_speech",
  "misinformation",
  "self_harm",
  "illegal_content",
  "nsfw",
] as const;

export const USER_REPORT_REASONS = ["spam", "harassment", "impersonation", "underage"] as const;

/** Length bounds for an appeal's own words, in characters, after trimming. */
export const APPEAL_REASON_MIN_LENGTH = 10;
export const APPEAL_REASON_MAX_LENGTH = 2000;

/**
 * Bounds for `moderation.suspendUser`'s duration, in seconds: one hour to one
 * year. Permanence is what `moderation.banUser` is for — a suspension always
 * ends, by clock or by moderator.
 */
export const SUSPENSION_MIN_SECONDS = 60 * 60;
export const SUSPENSION_MAX_SECONDS = 365 * 24 * 60 * 60;

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
 * How many posts from an original-author continuation are embedded beneath a
 * direct reply before the permalink offers to expand that branch in place.
 */
export const THREAD_REPLY_BRANCH_INITIAL_SIZE = 3;

/**
 * Maximum descendant depth inspected while selecting an inline reply branch.
 * The post schema prevents cycles by requiring a parent to exist before its
 * child is inserted, but user-shaped trees still need a recursion bound.
 */
export const THREAD_REPLY_BRANCH_MAX_DEPTH = 100;

/**
 * Maximum number of children the descendant scan expands at any one post.
 * The branch rule follows the oldest child and looks for the focused author's
 * earliest reply, so the scan keeps the oldest children at each fork — the
 * candidates the rule actually walks. Capping the fanout is what stops a broad
 * tree (a reply with tens of thousands of direct replies) from turning every
 * permalink request into a full-sibling scan; only the oldest children per
 * fork are ever materialized.
 */
export const THREAD_REPLY_BRANCH_CHILD_FANOUT = 50;

/**
 * Hard ceiling on the total descendants the scan materializes for one page of
 * direct replies, across every reply root. It bounds both the recursive CTE's
 * output and the parameter list of the metadata lookup that follows, so a
 * user-shaped tree can never exhaust database resources or push the bound
 * parameter count past PostgreSQL's limit. The branch rule runs over this
 * bounded set; a branch buried beneath more descendants than the budget
 * simply stays collapsed rather than pulling the whole subtree into memory.
 */
export const THREAD_REPLY_BRANCH_DESCENDANT_BUDGET = 1000;

/**
 * What the avatar and banner uploads accept.
 *
 * SVG is absent and must stay absent: it is a document format that can carry
 * script, and these bytes are served back from our own origin. The three raster
 * types a browser canvas produces (WebP, PNG, JPEG) are what
 * `apps/web/src/lib/media.ts` re-encodes every selected still image into before
 * it is ever uploaded. GIF is the one exception to canvas re-encoding:
 * `canvas.toBlob()` flattens an animation to its first frame, so the web app
 * runs a frame-aware codec pipeline instead (issue #201) and uploads the
 * re-encoded animated GIF as the display object. The server sniffs and
 * structurally validates GIF the same way it does the canvas types — the
 * declared MIME is never trusted.
 */
export const ALLOWED_IMAGE_TYPES = ["image/webp", "image/png", "image/jpeg", "image/gif"] as const;

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/** The two image slots a profile has. Both are optional and independently set. */
export const IMAGE_KINDS = ["avatar", "banner"] as const;

export type ImageKind = (typeof IMAGE_KINDS)[number];

/** The canonical aspect of every encoded profile banner. */
export const BANNER_ASPECT_RATIO = 3;

/**
 * Per-slot upload limits.
 *
 * Every slot stores TWO objects (see `packages/api/src/users.ts`):
 *
 * - the **original** — the user's file, untouched. The byte cap is what
 *   bounds a hostile upload; a generous cap is fine because the megapixel
 *   rule below bounds the real cost (pixels, not bytes).
 * - the **display** object — the browser-made WebP (or PNG fallback) the feeds
 *   render, so megabytes of original never travel down a timeline. Its byte
 *   cap and its `maxWidth`/`maxHeight` are checked against the actual payload,
 *   never a declared length: with the client re-encode gone from the mandatory
 *   path, these are what stop a hostile "display" object being an unbounded
 *   image.
 */
export const IMAGE_LIMITS = {
  avatar: {
    maxOriginalBytes: 5 * 1024 * 1024,
    // The profile page's full-size viewer renders this same object up to
    // ~900 CSS px (~896px dialog), so the ceiling is where that view is at or
    // near 1:1 rather than a stretched blur; 2 MiB keeps a photographic PNG
    // fallback (browsers without a WebP encoder) from being downscaled by the
    // client's byte-cap retry loop.
    maxDisplayBytes: 2 * 1024 * 1024,
    maxWidth: 1024,
    maxHeight: 1024,
  },
  banner: {
    maxOriginalBytes: 8 * 1024 * 1024,
    // Every display variant is encoded at the canonical 3:1 banner aspect.
    // The profile renders that composition without a second crop. 3840px
    // provides a 2x sample on a 1920px-wide display; 1280px is the matching
    // height.
    maxDisplayBytes: 8 * 1024 * 1024,
    maxWidth: 3840,
    maxHeight: 1280,
  },
} as const satisfies Record<
  ImageKind,
  { maxOriginalBytes: number; maxDisplayBytes: number; maxWidth: number; maxHeight: number }
>;

/**
 * The largest original, in pixels, this app will store.
 *
 * The byte cap does not bound this: a 20000x20000 flat-colour PNG is ~200 KB
 * and 400 megapixels, and originals are served back from a public `/media/`
 * path — unbounded, one is a decompression bomb aimed at whoever visits the
 * profile. Checked against header bytes, so it costs nothing to enforce.
 */
export const MAX_IMAGE_MEGAPIXELS = 50;

/**
 * Animation-specific limits for GIF, applied in addition to the byte and
 * dimension caps above (issue #201).
 *
 * A GIF's byte size does not bound its decode cost the way a still image's
 * does: LZW-compressed flat colour compresses many large frames into few bytes,
 * so a tiny upload can explode into gigabytes of decoded pixels. These three
 * centrally-defined limits bound that work, and are enforced server-side from
 * the file's own block structure (never a declared field). The web app reads
 * them too, for early client feedback before the upload.
 *
 * - `GIF_MAX_FRAMES` — the number of image descriptors. Bounds the encode pass
 *   the web app runs and the storage/read cost of a multi-frame object.
 * - `GIF_MAX_TOTAL_DURATION_MS` — the sum of every frame's delay. Bounds how
 *   long one stored animation runs.
 * - `GIF_MAX_CUMULATIVE_PIXELS` — the sum of every frame's `width × height`.
 *   This is the decompression-bomb defence: it is what stops a small-byte upload
 *   from decoding to an unbounded RGBA buffer, the way the megapixel ceiling
 *   does for a single still frame.
 */
export const GIF_MAX_FRAMES = 500;
export const GIF_MAX_TOTAL_DURATION_MS = 200_000;
export const GIF_MAX_CUMULATIVE_PIXELS = 50_000_000;

/**
 * Link preview cards (issue #260): bounds for unfurling the first URL of a
 * post server-side. Every one of these is a defence line on an outbound fetch
 * an author's text triggered, so they live beside the other caps rather than
 * inside the fetch module — the client reads them too, for its URL input
 * bound.
 */
/** Longest absolute URL accepted as a card target, in characters. */
export const LINK_CARD_URL_MAX_LENGTH = 2048;
/** Most HTML bytes read from a target before it is declared oversized. */
export const LINK_CARD_HTML_MAX_BYTES = 512 * 1024;
/** Most image bytes read from a target's lead image. */
export const LINK_CARD_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Wall-clock ceiling on one outbound request, redirects included. */
export const LINK_CARD_FETCH_TIMEOUT_MS = 5000;
/** Most redirects followed, each hop re-checked against the address guard. */
export const LINK_CARD_MAX_REDIRECTS = 4;
/**
 * How long a stored card (positive or negative) is served before the next
 * request refetches it. A fetched-once-per-window budget: shorter refreshes
 * cost outbound fetches, longer ones serve stale titles.
 */
export const LINK_CARD_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** Longest card title stored, in characters; longer ones are truncated. */
export const LINK_CARD_TITLE_MAX_LENGTH = 300;
/** Longest card description stored, in characters; longer ones are truncated. */
export const LINK_CARD_DESCRIPTION_MAX_LENGTH = 500;
/**
 * Longest card domain stored, in characters; longer ones are truncated. The
 * value is the target's `og:site_name` or, absent that, its hostname — both
 * are page-controlled text shipped to every viewer of every post carrying
 * the URL, so the cap bounds them like the title and description.
 */
export const LINK_CARD_SITE_NAME_MAX_LENGTH = 300;

/**
 * The largest request body the RPC endpoint will accept.
 *
 * Derived from the image caps rather than written as a literal, so raising a
 * slot's limit can never silently leave the ceiling behind. An upload carries
 * BOTH objects of a slot in one request — the original and the display copy —
 * so the ceiling must clear the slot's total, not just its bigger cap. The
 * headroom above the largest slot total covers the multipart framing oRPC's
 * file encoding adds around the payload (boundaries and part headers).
 *
 * Enforced in `apps/server/src/request-handler.ts`, which is the one chokepoint
 * that runs before oRPC buffers a body in memory. Chunked (`Transfer-Encoding`)
 * bodies carry no Content-Length and are bounded at this ceiling by oRPC's
 * BodyLimitPlugin (wired in `apps/server/src/index.ts`).
 */
export const RPC_MAX_BODY_BYTES =
  Math.max(
    POST_ATTACHMENT_MAX_TOTAL_BYTES,
    ...Object.values(IMAGE_LIMITS).map((slot) => slot.maxOriginalBytes + slot.maxDisplayBytes),
  ) +
  1024 * 1024;

/**
 * The largest body any non-upload RPC call legitimately carries — the line
 * the pre-auth gate draws (finding `resource-exhaustion.rpc-preauth-buffering`).
 *
 * Every `/rpc` procedure takes either a small JSON object (a post is 500
 * characters, an appeal reason 2000, the appeal token 4 KiB — nothing above a
 * few kilobytes) or a file upload, which is the one thing that crosses this
 * line. So a declared body above this bound is an upload by definition — and
 * every upload procedure is session-gated, so an anonymous caller has no
 * legitimate use for it. `apps/server/src/request-handler.ts` therefore:
 *
 * - refuses an appeal body above this bound — the public appeal surface's low
 *   limit, where the biggest legitimate body is the token plus the reason;
 * - demands a valid session before letting any OTHER `/rpc` body above it be
 *   buffered, so an anonymous upload-sized body is refused before oRPC parses
 *   it instead of being buffered and then rejected as UNAUTHORIZED.
 *
 * Chunked (`Transfer-Encoding`) bodies carry no Content-Length to compare, so
 * they are treated as over this bound by definition: the session demand
 * applies to them exactly as to an oversized upload, and a chunked body on the
 * appeal path itself is refused with 411 — every client that legitimately
 * reaches that link sends plain JSON with a declared length. What an
 * AUTHENTICATED chunked body can still do (buffer up to `RPC_MAX_BODY_BYTES`
 * under oRPC's BodyLimitPlugin) is bounded in number by the RPC concurrency
 * admission cap in `request-handler.ts`.
 */
export const RPC_SMALL_BODY_BYTES = 16 * 1024;

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

/**
 * Where a signed-out visitor is allowed to be. Everything else redirects to
 * `/login` — the site is private, like a social media app where nothing
 * renders until you're signed in.
 *
 * The auth pages speak for themselves. `/welcome` is here because it is the
 * completion page for a *signed-in* session that lacks a handle or a date of
 * birth; a signed-out visitor landing on it is sent to `/login` by the page's
 * own guard. The legal pages are exempt because a sign-in gate that will not
 * let someone read the terms and privacy policy they are being asked to
 * accept is its own problem — the same reason `use-require-handle.ts`
 * exempts them.
 *
 * Shared, deliberately, between the client gate (`apps/web/src/hooks/
 * use-require-signed-in.ts`) and the server gate (`apps/server/src/
 * request-handler.ts`): if the two ever drifted, a path gated on one side but
 * not the other could send a signed-out visitor into a redirect loop between
 * the server and `/login`. One list is what makes that impossible rather than
 * merely unlikely.
 */
export const SIGNED_OUT_PATHS = new Set([
  "/login",
  "/register",
  // The check-your-email screen a password sign-up lands on before its email
  // is verified, and the target a verification link redirects back to (issue
  // #172). Signed-out by construction: a successful verification creates a
  // session and `useRedirectWhenSignedIn` immediately moves the person on, so
  // the only visitors who stay here are the pending and the bad-link states,
  // both of which are signed out.
  "/verify-email",
  "/two-factor",
  // `/forgot-password` is an auth page like the ones above; `/reset-password`
  // is exempt on purpose even though it is NOT — resetting your own password
  // from an email link is legitimate while signed in, and the reset revokes
  // every session anyway.
  "/forgot-password",
  "/reset-password",
  "/welcome",
  "/privacy",
  "/terms",
  "/mentions-legales",
  // The moderation appeal form (issue #38): the signed-out path a suspended or
  // banned user's email link lands on. It must stay exempt from the gates —
  // the whole point is that the person cannot sign in — and the page itself
  // still requires the `?token=` capability (or a session for a post-stub
  // appeal) before it will submit.
  "/appeal",
  // The banned-account screen (issue #74): a banned sign-in attempt never
  // produces a session, so whoever lands here is signed out by definition —
  // exempt for the same reason /appeal is.
  "/banned",
]);

/**
 * The exact inline `onload` handler body the built `index.html`'s deferred
 * stylesheet `<link>` carries (`apps/web/build-inject-plugin.ts`), shared so
 * the server's Content-Security-Policy can allow *this one* inline event
 * handler by hash instead of weakening `script-src` with `'unsafe-inline'`.
 *
 * `apps/server/src/response-decorators.ts` hashes this constant into the
 * `'unsafe-hashes' 'sha256-…'` source it adds to `script-src` — computed at
 * module load, never hand-copied — so the two sides cannot drift: change the
 * handler here (or in the build plugin) and the header's hash updates with
 * it, instead of silently going stale and leaving the production stylesheet
 * stuck at `media="print"` (the exact failure a hard-coded hash would risk,
 * and one that would ship invisibly — there is no console to watch for it in
 * production). That guarantee relies on `build-inject-plugin.ts` HTML-escaping
 * this value before it interpolates it into the `onload="..."` attribute —
 * without that, a future value containing a `"` or `&` would change what the
 * browser parses the attribute to versus what got hashed here, reintroducing
 * the same silent `media="print"` failure through the back door.
 */
export const NONBLOCKING_STYLESHEET_ONLOAD_HANDLER = "this.media='all'";
