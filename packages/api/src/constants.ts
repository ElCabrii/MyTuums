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
