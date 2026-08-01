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
