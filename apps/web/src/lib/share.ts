import { toast } from "sonner";
import { SITE_ORIGIN } from "@/lib/document-head";
import { m } from "@/paraglide/messages.js";

/**
 * The absolute permalink a share hands to the outside world (issue #307).
 * Built from `SITE_ORIGIN` — never `window.location` — so a link shared from a
 * preview environment still lands on the canonical public post page, exactly
 * like the og:url/canonical tags `document-head.ts` emits for the same route.
 */
export function postPermalinkUrl(postId: string): string {
  return `${SITE_ORIGIN}/post/${postId}`;
}

/**
 * Puts a post's permalink on its way out of the app: the system share sheet
 * where the platform offers one, the clipboard everywhere else — a silent
 * clipboard write would leave the reader unsure anything happened, so the copy
 * is confirmed by a toast. Client-side only by design; there is no procedure
 * to call and nothing to persist.
 */
export async function sharePost(postId: string): Promise<void> {
  const url = postPermalinkUrl(postId);

  if (navigator.share) {
    try {
      await navigator.share({ url });
    } catch {
      // A dismissed sheet rejects (AbortError) after the user already got
      // what they wanted — a say in where the link goes. Falling through to
      // the clipboard would copy anyway, which is not what "cancel" means.
    }
    return;
  }

  try {
    await navigator.clipboard.writeText(url);
    toast.success(m.post_share_link_copied());
  } catch {
    // A clipboard that refuses (permissions, insecure context) must not
    // masquerade as success — the link is NOT on it yet.
    toast.error(m.post_share_copy_failed());
  }
}
