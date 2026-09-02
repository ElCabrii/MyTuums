/**
 * Per-route crawler heads for the SPA's `index.html` (0.4.0).
 *
 * The SPA emits per-route `<title>`/description/canonical/Open Graph tags
 * only after it mounts; a no-JS unfurler (Slack, Discord, X, Facebook) or a
 * search crawler never runs that. Until now that was moot — every route
 * redirected a signed-out fetcher to `/login`. Post permalinks are public
 * now, so the server substitutes the `[data-app-fallback]` head block in
 * `index.html` with route-specific tags before the file ships.
 *
 * The static half is a table: the same English title/description each
 * route's `head()` produces (mirror of `apps/web/src/lib/document-head.ts`
 * and `messages/en.json` — change them together). The dynamic half is the
 * post permalink, which asks `publicPostHead` (in `@my-tuums/api`) for the
 * excerpt and lead image of a publicly visible post.
 *
 * Every substituted tag keeps the `data-app-fallback` attribute, so the
 * SPA's mount effect (`__root.tsx`) still strips the whole block and the
 * route's live, localized head becomes the single owner — this file only
 * covers the gap before JavaScript runs.
 *
 * English-only is deliberate and matches the static fallback: Paraglide
 * compiles into the browser bundle and cannot reach a server-side string.
 */
import type { Database } from "@my-tuums/db";
import { publicPostHead, type PublicPostHead } from "@my-tuums/api/public-post-head";
import type { IndexHtmlTransform } from "./static-files.js";

/** Mirrors `SITE_ORIGIN` in apps/web/src/lib/document-head.ts — change together. */
const SITE_ORIGIN = "https://mytuums.com";
/** Mirrors `SITE_IMAGE_PATH` there — the square mark unfurlers can afford. */
const SITE_IMAGE_PATH = "/mytuums-512.png";
/** Mirrors `app_title_suffix` — the suffix every route title carries. */
const TITLE_SUFFIX = "MyTuums";

/** One static route's crawler head. */
interface RouteHead {
  title: string;
  description: string;
}

/** The static public routes; values mirror each route's `pageHead` copy. */
const ROUTE_HEADS = new Map<string, RouteHead>([
  [
    "/login",
    { title: "Log in", description: "Sign in to MyTuums — the social media, for gamers." },
  ],
  [
    "/register",
    {
      title: "Register",
      description: "Create your MyTuums account — the social media, for gamers.",
    },
  ],
  [
    "/verify-email",
    {
      title: "Check your email",
      description: "Confirm your email address to activate your MyTuums account.",
    },
  ],
  [
    "/two-factor",
    {
      title: "Two-factor authentication",
      description: "Enter your two-factor authentication code to finish signing in to MyTuums.",
    },
  ],
  [
    "/forgot-password",
    {
      title: "Forgot your password?",
      description:
        "Reset your MyTuums password by requesting a recovery link for your account's email address.",
    },
  ],
  [
    "/reset-password",
    {
      title: "Set a new password",
      description: "Choose a new password for your MyTuums account.",
    },
  ],
  [
    "/welcome",
    {
      title: "Pick your handle",
      description: "Pick a handle and set up your public profile to start posting on MyTuums.",
    },
  ],
  [
    "/privacy",
    {
      title: "Privacy Policy",
      description: "How MyTuums collects, uses and protects your personal data.",
    },
  ],
  [
    "/terms",
    {
      title: "Terms of Service",
      description:
        "The rules that govern your use of MyTuums: accounts, content, conduct and liability.",
    },
  ],
  [
    "/mentions-legales",
    {
      title: "Legal Notice",
      description:
        "Legal information about MyTuums' publisher, hosting provider and contact details.",
    },
  ],
  [
    "/appeal",
    {
      title: "Appeal a moderation decision",
      description:
        "Appeal a moderation decision on MyTuums: explain why a sanction should be reconsidered.",
    },
  ],
  [
    "/banned",
    {
      title: "Account banned",
      description:
        "Your MyTuums account has been banned. Read this page to understand what happens next.",
    },
  ],
]);

const HEAD_BLOCK_START = "<!-- app-head-fallback-start -->";
const HEAD_BLOCK_END = "<!-- app-head-fallback-end -->";

/** Escapes the few characters that can terminate an attribute or a text node. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The full tag set a route head carries — `pageHead`'s shape, minus the live-only bits. */
function headBlockFor(route: {
  title: string;
  description: string;
  path: string;
  imagePath?: string | null;
}): string {
  const title = `${route.title} - ${TITLE_SUFFIX}`;
  const url = `${SITE_ORIGIN}${route.path}`;
  const image = route.imagePath
    ? `${SITE_ORIGIN}${route.imagePath}`
    : `${SITE_ORIGIN}${SITE_IMAGE_PATH}`;
  return [
    HEAD_BLOCK_START,
    `<title data-app-fallback>${escapeHtml(title)}</title>`,
    `<meta data-app-fallback name="description" content="${escapeHtml(route.description)}" />`,
    `<link data-app-fallback rel="canonical" href="${escapeHtml(url)}" />`,
    `<meta data-app-fallback property="og:title" content="${escapeHtml(title)}" />`,
    `<meta data-app-fallback property="og:description" content="${escapeHtml(route.description)}" />`,
    `<meta data-app-fallback property="og:type" content="website" />`,
    `<meta data-app-fallback property="og:url" content="${escapeHtml(url)}" />`,
    `<meta data-app-fallback property="og:site_name" content="MyTuums" />`,
    `<meta data-app-fallback property="og:image" content="${escapeHtml(image)}" />`,
    `<meta data-app-fallback name="twitter:card" content="summary" />`,
    `<meta data-app-fallback name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta data-app-fallback name="twitter:description" content="${escapeHtml(route.description)}" />`,
    `<meta data-app-fallback name="twitter:image" content="${escapeHtml(image)}" />`,
    HEAD_BLOCK_END,
  ].join("\n    ");
}

function replaceHeadBlock(html: string, replacement: string): string {
  const start = html.indexOf(HEAD_BLOCK_START);
  const end = html.indexOf(HEAD_BLOCK_END);
  if (start === -1 || end === -1 || end < start) return html;
  return html.slice(0, start) + replacement + html.slice(end + HEAD_BLOCK_END.length);
}

const POST_PATH_PREFIX = "/post/";

/**
 * The production `IndexHtmlTransform`: looks the route up in the static
 * table, asks the API for a post head on `/post/<uuid>`, and leaves every
 * other path on the generic fallback the file already carries (the gated
 * routes never reach a crawler — the page gate 302s it — and an unmarked
 * build must degrade to serving the file verbatim, never to a broken one).
 */
export function createPublicHeadTransform(db: Database): IndexHtmlTransform {
  return async (pathname, html) => {
    if (pathname.startsWith(POST_PATH_PREFIX)) {
      const postId = pathname.slice(POST_PATH_PREFIX.length).replace(/\/+$/, "");
      let head: PublicPostHead | null = null;
      try {
        head = await publicPostHead(db, postId);
      } catch (error) {
        // The unfurl degrades to the generic head; the page itself still
        // loads and the SPA takes over.
        console.error("Failed to build the public post head:", error);
      }
      if (head) {
        return replaceHeadBlock(
          html,
          headBlockFor({
            title: head.title,
            description: head.description,
            path: `${POST_PATH_PREFIX}${encodeURIComponent(postId)}`,
            imagePath: head.imagePath,
          }),
        );
      }
      return html;
    }

    const route = ROUTE_HEADS.get(pathname);
    if (!route) return html;
    return replaceHeadBlock(html, headBlockFor({ ...route, path: pathname }));
  };
}
