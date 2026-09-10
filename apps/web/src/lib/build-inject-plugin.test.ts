import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import { expect, it } from "vitest";
import { preloadInjectionPlugin } from "../../build-inject-plugin";
import { pwaPlugin } from "../../pwa-plugin";

it("#354 keeps lazy login out of shared HTML and the worker shell", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mytuums-preloads-"));
  try {
    await Promise.all([
      writeFile(
        path.join(root, "index.html"),
        '<html><head></head><body><script type="module" src="/main.js"></script></body></html>',
      ),
      writeFile(
        path.join(root, "main.js"),
        'import "./style.css"; window.login = () => import("./login.js");',
      ),
      writeFile(path.join(root, "login.js"), 'export const login = "lazy login";'),
      writeFile(
        path.join(root, "style.css"),
        '@font-face { font-family: Inter; src: url("./inter-latin-wght-normal.woff2"); } body { font-family: Inter; }',
      ),
      writeFile(path.join(root, "inter-latin-wght-normal.woff2"), "font fixture"),
    ]);
    await build({
      configFile: false,
      root,
      logLevel: "silent",
      build: { assetsInlineLimit: 0 },
      plugins: [preloadInjectionPlugin(), pwaPlugin()],
    });
    const html = await readFile(path.join(root, "dist/index.html"), "utf8");
    const worker = await readFile(path.join(root, "dist/service-worker.js"), "utf8");
    expect(await readdir(path.join(root, "dist/assets"))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^login-.*\.js$/)]),
    );
    expect(html).toMatch(
      /rel="preload" as="font" type="font\/woff2" crossorigin href="\/assets\/inter-latin-wght-normal-/,
    );
    expect(html).not.toMatch(/href="\/assets\/login-/);
    expect(worker).not.toMatch(/\/assets\/login-/);
    expect(html).toContain('media="print"');
    expect(html).toContain('<noscript><link rel="stylesheet"');
    expect(worker).toMatch(/\/assets\/index-.*\.js/);
    expect(worker).toMatch(/\/assets\/index-.*\.css/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
