import { test, expect } from "../../support/fixtures";
import { E2E } from "../../playwright.config";
import { NONBLOCKING_STYLESHEET_ONLOAD_HANDLER } from "@my-tuums/api/constants";

/**
 * Closes a real gap in this suite (issue #61's finding, not the issue itself):
 * every other CSP check — `apps/server/src/response-decorators.test.ts`,
 * `e2e/tests/api/headers.spec.ts` — asserts the header's *string*, never
 * hands it to a browser. Nothing in the suite loads a DOCUMENT under this
 * policy, and a CSP header on a subresource or XHR response (which is all the
 * `api` project ever sees — it has no browser) is not enforced the way a
 * document-response header is. This spec is the cheapest honest fix for that:
 * a real Chromium page, navigating to a real document, carrying the exact
 * header string this run's own server just sent.
 *
 * What this does NOT do, and why: it does not build and serve the actual
 * `apps/web` bundle under this header (that's what would fully close the
 * gap). The e2e stack's `chromium` project runs against Vite `dev`
 * deliberately (`playwright.config.ts`'s comment on the web `webServer`
 * entry) so a clean checkout needs no separate build step; the server here
 * never sets `WEB_DIST`, so it never serves an HTML document at all in this
 * suite. Standing up a third, build-then-serve stack just for this one
 * assertion would be the kind of e2e restructuring this suite's speed
 * depends on avoiding. Instead, this test fetches the real header from the
 * real running server (`GET /health`, which — like every response —
 * carries it, per `response-decorators.ts`) and hands that exact string to a
 * synthetic document containing the specific cross-origin resources and the
 * exact shared-constant inline handler this policy's directives exist for:
 * Google's script and stylesheet (`script-src`/`style-src`
 * `accounts.google.com` — the fix for the finding this spec exists to catch:
 * `style-src` used to omit the host GSI's injected stylesheet needs), and the
 * non-blocking stylesheet's hash-gated `onload` (`script-src`
 * `'unsafe-hashes' 'sha256-…'`).
 *
 * RESIDUAL RISK a human should still watch on first deploy: this proves the
 * header's directives are individually well-formed and permit the resources
 * they were written for, under real browser enforcement. It does NOT prove
 * the real built `index.html` — with its real script bundle, real inline
 * splash `<style>`, real Base UI positioning — renders violation-free end to
 * end. That would need the built-SPA-under-the-real-server setup described
 * above; short of that, the first production (or a manual `docker:up`) load
 * with DevTools open is the actual proof.
 */
test.describe("Content-Security-Policy enforcement", () => {
  test("a document served under the real header loads Google's script and stylesheet, and the hash-gated inline handler, with zero CSP violations", async ({
    page,
    request,
  }) => {
    const health = await request.get(`${E2E.serverUrl}/health`);
    const csp = health.headers()["content-security-policy"];
    expect(csp, "GET /health must carry the enforced CSP, like every response").toBeTruthy();

    const cspViolations: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && /content security policy/i.test(msg.text())) {
        cspViolations.push(msg.text());
      }
    });
    page.on("pageerror", (error) => {
      if (/content security policy/i.test(error.message)) cspViolations.push(error.message);
    });

    const docUrl = `${E2E.webUrl}/__csp-enforcement-check`;
    const localStylesheetUrl = `${E2E.webUrl}/__csp-enforcement-check.css`;
    const googleScriptUrl = "https://accounts.google.com/gsi/client";
    const googleStyleUrl = "https://accounts.google.com/gsi/style";

    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === docUrl) {
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          headers: { "content-security-policy": csp },
          body: `<!doctype html>
<html>
  <head>
    <script src="${googleScriptUrl}"></script>
    <link rel="stylesheet" href="${googleStyleUrl}">
    <link
      rel="stylesheet"
      media="print"
      onload="${NONBLOCKING_STYLESHEET_ONLOAD_HANDLER}"
      href="${localStylesheetUrl}"
      id="swap-target"
    >
  </head>
  <body>ok</body>
</html>`,
        });
        return;
      }
      if (url === googleScriptUrl) {
        await route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
        return;
      }
      if (url === googleStyleUrl || url === localStylesheetUrl) {
        await route.fulfill({ status: 200, contentType: "text/css", body: "" });
        return;
      }
      // Hermetic: anything else (e.g. a favicon probe) 404s rather than
      // falling through to whatever the real dev server happens to do with
      // an unrecognised path.
      await route.fulfill({ status: 404, body: "" });
    });

    await page.goto(docUrl);

    // The onload handler is the thing under test — wait for its effect
    // (media flips to "all") rather than a fixed timeout, so this fails fast
    // if the hash-source is wrong instead of racing a sleep.
    await expect(page.locator("#swap-target")).toHaveJSProperty("media", "all");

    // The settings crop editor previews a selected file through a blob URL.
    // Keep this in a real document under the exact response policy: jsdom and
    // a CSP string assertion cannot observe the browser blocking this image.
    const blobImageLoaded = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const image = new Image();
          const imageBytes = Uint8Array.from(
            atob(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
            ),
            (character) => character.charCodeAt(0),
          );
          const blobUrl = URL.createObjectURL(new Blob([imageBytes], { type: "image/png" }));
          const finish = (loaded: boolean) => {
            URL.revokeObjectURL(blobUrl);
            resolve(loaded);
          };
          image.onload = () => finish(true);
          image.onerror = () => finish(false);
          image.src = blobUrl;
          document.body.append(image);
        }),
    );
    expect(blobImageLoaded).toBe(true);

    expect(cspViolations).toEqual([]);
  });
});
