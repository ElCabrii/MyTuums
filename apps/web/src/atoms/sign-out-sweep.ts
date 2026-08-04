/**
 * The cache sweeps `signOutAtom` runs, gathered in one module.
 *
 * This is a barrel, not a module with logic — it re-exports the `clear*`
 * helpers and `profileAtomFamily` from the atom modules that define them,
 * nothing else. What it exists for is chunking: those helpers live alongside
 * the query and mutation machinery they clear (postFeedAtom, the like/follow
 * intent atoms, the thread family), so importing them statically — as
 * `atoms/auth.ts` used to — dragged all of that machinery into the auth
 * module's graph, and from there into the login page's chunks, for the sake
 * of an action only a signed-in user can trigger.
 *
 * Sign-out is also the one moment nothing in the app is mounted against
 * those families, which is what makes sweeping them safe (see `signOutAtom`).
 * It is therefore fetched on demand: `signOutAtom` awaits a dynamic import
 * of this barrel, and a visitor who never signs out never pays for it.
 */
export { profileAtomFamily } from "@/atoms/profile";
export { clearPostFeedFamily } from "@/atoms/post-feed";
export { clearUserListFamily } from "@/atoms/user-list";
export { clearLikeFamilies } from "@/atoms/like";
export { clearFollowFamilies } from "@/atoms/follow";
export { clearThreadFamily } from "@/atoms/thread";
export { clearReplyFamilies } from "@/atoms/reply-composer";
