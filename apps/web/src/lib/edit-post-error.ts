import { m } from "@/paraglide/messages.js";

/**
 * The two state refusals `post.edit` throws (packages/api/src/posts.ts) and
 * nothing else. The dialog surfaces the server's message rather than a generic
 * banner because each refusal has a distinct reason worth naming, and these
 * are the keys that keep those names translated — the same arrangement as
 * `localizeAuthError` with `@my-tuums/auth/rules`: the English literals are
 * shared byte-for-byte with the procedure, so a refusal restated here must be
 * restated in both places or it renders untranslated.
 */
const editPostErrors = {
  "This post was removed by a moderator and can no longer be edited.": () => m.post_edit_removed(),
  "This post was deleted and can no longer be edited.": () => m.post_edit_deleted(),
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
