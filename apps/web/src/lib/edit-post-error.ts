import { m } from "@/paraglide/messages.js";

/**
 * Three of `post.edit`'s refusals (packages/api/src/posts.ts) and nothing
 * else. The dialog surfaces the server's message rather than a generic banner
 * because each refusal has a distinct reason worth naming, and these are the
 * keys that keep those names translated — the same arrangement as
 * `localizeAuthError` with `@my-tuums/auth/rules`: the English literals are
 * shared byte-for-byte with the procedure, so a refusal restated here must be
 * restated in both places or it renders untranslated.
 *
 * The empty-content refusal is `post.create`'s own cross-field rule (the same
 * literal, thrown against the row's attachments), so its key is not
 * edit-specific. `post.edit`'s remaining two refusals — "You can only edit
 * your own posts." and "Post not found." — are deliberately unmapped: the edit
 * menu only opens on the viewer's own card and posts are never hard-deleted,
 * so neither can surface here, and translating unreachable strings is
 * duplication without a reader.
 */
const editPostErrors = {
  "This post was removed by a moderator and can no longer be edited.": () => m.post_edit_removed(),
  "This post was deleted and can no longer be edited.": () => m.post_edit_deleted(),
  "Post cannot be empty.": () => m.post_cannot_be_empty(),
} satisfies Record<string, () => string>;

/**
 * Translates `post.edit`'s known refusals without hiding server errors: an
 * unrecognised string reaches the user verbatim, the same fallthrough
 * `localizeAuthError` keeps.
 */
export function localizeEditPostError(error: string): string {
  for (const [known, translate] of Object.entries(editPostErrors)) {
    if (known === error) return translate();
  }
  return error;
}
