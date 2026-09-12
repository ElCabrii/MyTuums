import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** Build crawler documents with the same public/private choice as the HTML. */
export function crawlerDocuments(directory: string, publicSite: boolean): Plugin {
  return {
    name: "mytuums-crawler-documents",
    generateBundle() {
      for (const name of ["robots.txt", "sitemap.xml", "llms.txt"]) {
        const privateDocument =
          name === "llms.txt"
            ? "# MyTuums preview\n\nThis environment requires Cloudflare Access and must not be indexed.\n"
            : name === "robots.txt"
              ? "User-agent: *\nDisallow: /\n"
              : '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" />\n';
        this.emitFile({
          type: "asset",
          fileName: name,
          source: publicSite ? readFileSync(resolve(directory, name), "utf8") : privateDocument,
        });
      }
    },
  };
}
