import { m } from "@/paraglide/messages.js";

const POST_TITLE_MAX_LENGTH = 68;
const META_DESCRIPTION_MAX_LENGTH = 160;

/** Builds the localized suffix shared by every route-owned document title. */
export function documentTitle(pageName: string): string {
  return `${pageName} - ${m.app_title_suffix()}`;
}

/**
 * The route-level head shape consumed by TanStack Router's `<HeadContent />`.
 * The description argument deliberately defaults to the app description: a
 * route gets its own title immediately, while data-dependent descriptions can
 * be supplied later by the page once its query atom resolves.
 */
export function pageHead(pageName: string, description = m.app_document_description()) {
  return {
    meta: [{ title: documentTitle(pageName) }, { name: "description", content: description }],
  };
}

/** The root fallback shown before a child route has supplied its own head. */
export function fallbackHead() {
  return {
    meta: [
      { title: m.app_document_title() },
      { name: "description", content: m.app_document_description() },
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
 * that arrive through existing Jotai query atoms.
 */
export function setDocumentHead(pageName: string, description: string): void {
  document.title = documentTitle(pageName);
  document.querySelector('meta[name="description"]')?.setAttribute("content", description);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value;
}
