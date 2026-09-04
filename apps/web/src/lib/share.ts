import { toast } from "sonner";
import { SITE_ORIGIN } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

/**
 * The absolute permalink the share dialog offers (issue #307). Built from
 * `SITE_ORIGIN` — never `window.location` — so a link copied from a preview
 * environment still lands on the canonical public post page, exactly like
 * the og:url/canonical tags `document-head.ts` emits for the same route.
 */
export function postPermalinkUrl(postId: string): string {
  return `${SITE_ORIGIN}/post/${postId}`;
}

/**
 * Copies the permalink to the clipboard and confirms it with a toast — a
 * silent clipboard write would leave the reader unsure anything happened.
 * Client-side only by design; there is no procedure to call and nothing to
 * persist. A clipboard that refuses (permissions, insecure context) must not
 * masquerade as success — the link is NOT on it yet.
 */
export async function copyPostLink(postId: string): Promise<void> {
  const url = postPermalinkUrl(postId);

  try {
    await navigator.clipboard.writeText(url);
    toast.success(m.post_share_link_copied());
  } catch {
    toast.error(m.post_share_copy_failed());
  }
}
