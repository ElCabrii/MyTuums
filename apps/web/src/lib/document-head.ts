import { m } from "@/paraglide/messages.js";

const POST_TITLE_MAX_LENGTH = 68;
const META_DESCRIPTION_MAX_LENGTH = 160;

/** The brand name as shared metadata; not localized, like the logo. */
const SITE_NAME = "MyTuums";

/**
 * The production origin every canonical and unfurl URL points at. Canonicals
 * must stay stable across environments — that is their whole point — so this
 * is deliberately not derived from `window.location`. index.html restates the
 * same origin and brand strings statically because it cannot import this
 * module; change the two together.
 */
export const SITE_ORIGIN = "https://mytuums.com";

/**
 * The square brand mark shared as the card image. Chosen over the 4096 px
 * `/mytuums.png` because unfurl fetchers cap download size; a square image
 * implies a `summary` Twitter card rather than a large one.
 */
const SITE_IMAGE_PATH = "/mytuums-512.png";

/** Builds the localized suffix shared by every route-owned document title. */
export function documentTitle(pageName: string): string {
  return `${pageName} - ${m.app_title_suffix()}`;
}

/**
 * The route-level head shape consumed by TanStack Router's `<HeadContent />`.
 */
export type DocumentHead = {
  meta: Array<Record<string, string>>;
  links?: Array<Record<string, string>>;
};

/**
 * The description argument deliberately defaults to the app description: a
 * route gets its own title immediately, while data-dependent descriptions can
 * be supplied later by the page once its query atom resolves. Every route also
 * emits Open Graph / Twitter Card mirrors so a pasted link unfurls with the
 * same copy the tab shows.
 */
export function pageHead(
  pageName: string,
  description = m.app_document_description(),
  path = "/",
): DocumentHead {
  const title = documentTitle(pageName);
  const url = `${SITE_ORIGIN}${path}`;
  return {
    links: [{ rel: "canonical", href: url }],
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:url", content: url },
      ...socialMeta(title, description),
    ],
  };
}

/** The root fallback shown before a child route has supplied its own head. */
export function fallbackHead(): DocumentHead {
  const title = m.app_document_title();
  const description = m.app_document_description();
  return {
    // No canonical here: every child route owns one, and emitting a second
    // from the root would put two canonicals on the page wherever the router
    // keeps both matches' links.
    meta: [
      { title },
      { name: "description", content: description },
      ...socialMeta(title, description),
    ],
  };
}

/** Collapses authored whitespace and bounds a post title for a browser tab. */
export function postPageName(content: string | null | undefined): string {
  const collapsed = content?.replace(/\s+/gu, " ").trim();
  if (!collapsed) return m.post_title();
  return truncate(collapsed, POST_TITLE_MAX_LENGTH);
}

/** Uses a profile bio as a useful description while retaining the site default. */
export function profilePageDescription(bio: string | null | undefined): string {
  const collapsed = bio?.replace(/\s+/gu, " ").trim();
  return collapsed
    ? truncate(collapsed, META_DESCRIPTION_MAX_LENGTH)
    : m.app_document_description();
}

/** Uses post text as a useful description while retaining the site default. */
export function postPageDescription(content: string | null | undefined): string {
  const collapsed = content?.replace(/\s+/gu, " ").trim();
  return collapsed
    ? truncate(collapsed, META_DESCRIPTION_MAX_LENGTH)
    : m.app_document_description();
}

/**
 * Applies data-dependent metadata after a route's static head has rendered.
 * TanStack Router owns the static tags; this small bridge only fills values
 * that arrive through existing Jotai query atoms — including the Open Graph
 * and Twitter mirrors, so an unfurl never disagrees with the visible tab.
 */
export function setDocumentHead(pageName: string, description: string): void {
  const title = documentTitle(pageName);
  document.title = title;
  setMetaContent('meta[name="description"]', description);
  setMetaContent('meta[property="og:title"]', title);
  setMetaContent('meta[property="og:description"]', description);
  setMetaContent('meta[name="twitter:title"]', title);
  setMetaContent('meta[name="twitter:description"]', description);
}

function socialMeta(title: string, description: string): DocumentHead["meta"] {
  const image = `${SITE_ORIGIN}${SITE_IMAGE_PATH}`;
  return [
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:image", content: image },
    { name: "twitter:card", content: "summary" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: image },
  ];
}

function setMetaContent(selector: string, content: string): void {
  document.querySelector(selector)?.setAttribute("content", content);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value;
}
