import { posix } from "node:path";
import type { Plugin } from "vite";
import { NONBLOCKING_STYLESHEET_ONLOAD_HANDLER } from "@my-tuums/api/constants";

/**
 * Post-build surgery on `dist/index.html`, registered in vite.config.ts.
 *
 * Three things the *source* index.html cannot express, because none of them
 * are known until the bundle exists:
 *
 * 1. A `modulepreload` for the lazy `/login` route chunk. Without it, the
 *    route chunk only starts downloading after the main chunk has been
 *    fetched, parsed and executed and the router has resolved the route — a
 *    serial dependency on the critical path of the login page. Preloading it
 *    (which fetches its module graph too — the paraglide message chunks it
 *    imports) lets it ride alongside the main chunk.
 * 2. A font `preload` for the Inter latin woff2, so the font swap after
 *    first paint doesn't wait for the stylesheet's @font-face to be parsed
 *    and the fetch to start from scratch.
 * 3. The stylesheet loaded non-blocking (`media="print"` + `onload` swap,
 *    with a `<noscript>` fallback). The sheet is the only render-blocking
 *    resource left; the cold-load splash is inline-styled, so it paints
 *    immediately regardless, and the sheet still starts downloading with the
 *    HTML — what moves is *when rendering waits on it*. The FOUC this could
 *    cause is contained by the splash covering the document until the
 *    session settles (see #app-splash in index.html).
 *
 * Every lookup is a no-op when the asset is missing: if the login chunk is
 * renamed or the font subset changes, the build degrades to "no preload
 * hints" rather than failing.
 *
 * `enforce: "post"` is load-bearing: Vite's own build-html plugin emits
 * `index.html` from *its* generateBundle, and only post-enforce user plugins
 * run after it — which is what lets this plugin see the final HTML with the
 * script and stylesheet tags already injected.
 */
export function preloadInjectionPlugin(): Plugin {
  return {
    name: "mytuums-preload-injection",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = bundle["index.html"];
      if (!html || html.type !== "asset" || html.source instanceof Uint8Array) return;

      // A bundle entry's fileName already carries the `assets/` prefix
      // (`assets/login-<hash>.js`); the URL in the HTML is that joined onto
      // the base — the same join Vite's own build-html plugin performs when it
      // emits the script and stylesheet tags, which is why those hrefs do not
      // double the prefix.
      const urlOf = (fileName: string): string => posix.join("/", fileName);

      // `NONBLOCKING_STYLESHEET_ONLOAD_HANDLER` is interpolated into a
      // double-quoted HTML attribute below (raw, not templated by a proper
      // HTML serialiser), so it needs the same two escapes any attribute
      // value needs: a literal `"` would close the attribute early and leak
      // the rest of the string into the tag as bare attributes, and a
      // literal `&` would let the browser's attribute-value parsing treat
      // whatever follows as a character reference — either way, the parsed
      // `onload` value would silently stop matching the constant this
      // module hashed the CSP source from (`response-decorators.ts`), which
      // is exactly the drift the shared-constant design exists to prevent.
      // The handler is a fixed literal today with neither character, but
      // escaping here makes that a property of the code, not a fact someone
      // has to remember when it next changes.
      const escapeAttr = (value: string): string =>
        value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

      const tags: string[] = [];

      // The TanStack Router route chunk. The fileName regex is the reliable
      // matcher: the chunk's facadeModuleId carries a `?tsr-split=component`
      // query suffix, so an `endsWith("src/routes/login.tsx")` check fails.
      const loginChunk = Object.values(bundle).find(
        (entry) => entry.type === "chunk" && /^assets\/login-.*\.js$/.test(entry.fileName),
      );
      if (loginChunk) {
        tags.push(`<link rel="modulepreload" crossorigin href="${urlOf(loginChunk.fileName)}">`);
      }

      // The latin subset of Inter — the one en/fr text actually renders with.
      // `crossorigin` is required: fonts are fetched in CORS mode even from
      // the same origin.
      const latinFont = Object.values(bundle).find(
        (entry) =>
          entry.type === "asset" &&
          /^assets\/inter-latin-wght-normal-.*\.woff2$/.test(entry.fileName),
      );
      if (latinFont) {
        tags.push(
          `<link rel="preload" as="font" type="font/woff2" crossorigin href="${urlOf(latinFont.fileName)}">`,
        );
      }

      let source = html.source;

      const stylesheetTags = [...source.matchAll(/<link rel="stylesheet"([^>]*)>/g)];
      if (stylesheetTags.length === 1) {
        // The captured attribute group keeps `crossorigin` and `href` intact
        // on both the async variant and the noscript fallback.
        const attrs = stylesheetTags[0][1];
        source = source.replace(
          stylesheetTags[0][0],
          // The `onload` value is the shared constant, not a literal, so the
          // server's CSP (apps/server/src/response-decorators.ts) can allow
          // this exact inline handler by hash — see the constant's doc
          // comment for why that has to stay in sync rather than hand-copied.
          // `escapeAttr` keeps the *parsed* attribute value equal to the
          // constant even if it ever gains a `"` or `&` — the server hashes
          // the raw constant, which is what the browser hands back after
          // decoding entities, not the escaped source text.
          `<!-- Loaded non-blocking (see build-inject-plugin.ts): the inline splash\n     covers first paint, and the sheet still starts downloading with the HTML.\n     The <noscript> twin keeps the blocking behaviour for no-JS visitors. -->\n<link rel="stylesheet" media="print" onload="${escapeAttr(NONBLOCKING_STYLESHEET_ONLOAD_HANDLER)}"${attrs}>\n<noscript><link rel="stylesheet"${attrs}></noscript>`,
        );
      }
      // More than one stylesheet (or none) is unexpected for this app's build
      // — leave the tags alone rather than risk a wrong swap.

      if (tags.length > 0) {
        source = source.replace("</head>", `${tags.join("\n")}\n</head>`);
      }

      html.source = source;
    },
  };
}
