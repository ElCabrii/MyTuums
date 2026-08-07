import type { Locator, Page } from "@playwright/test";

/**
 * Scopes a locator to the single PostCard whose content is `text`.
 *
 * There is no dedicated role or test id for "a post card" (see the suite's
 * selector policy — no `data-testid` exists in this codebase and none may be
 * added), so this locates it structurally instead: in `post-card.tsx`, the
 * content paragraph and the reply/like controls are both descendants of the
 * same `div.flex-1.min-w-0` content column, and that `div` is also the
 * innermost `div` whose text still contains the post's own content — every
 * `div` further out (the card shell, the feed list, the page) contains that
 * same text too, purely because text bubbles up through ancestors. Matching
 * on document order (a parent's opening tag always precedes its children's),
 * `.last()` among "divs containing this text" is therefore the deepest, most
 * specific one.
 *
 * Every spec that uses this should seed content unique enough that it can't
 * accidentally match a second card — including a leftover from an earlier
 * spec, since workers are pinned to 1 and specs share one database (see
 * playwright.config.ts).
 */
export function postCardWithText(page: Page, text: string): Locator {
  return page.locator("div").filter({ hasText: text }).last();
}

/**
 * The like control within one card, signed in: a real `<button>` whose
 * `aria-label` flips between "Like this post" and "Unlike this post"
 * (post-card.tsx). Matches either state.
 */
export function likeButtonFor(page: Page, text: string): Locator {
  return postCardWithText(page, text).getByRole("button", { name: /this post/ });
}
