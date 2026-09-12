import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { getPlatformProxy } from "wrangler";

/** First-time Container provisioning must finish before the application can cache a failed card. */
export async function waitForLinkFetcher(environment: "preview" | "production"): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "mytuums-link-readiness-"));
  const configPath = join(directory, "wrangler.json");
  let proxy:
    | Awaited<ReturnType<typeof getPlatformProxy<{ LINK_FETCHER: { fetch: typeof fetch } }>>>
    | undefined;
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        name: "mytuums-link-readiness",
        account_id: "734f3b84571b1967e6940140a0b7d75f",
        compatibility_date: "2026-09-12",
        services: [
          {
            binding: "LINK_FETCHER",
            service: `mytuums-${environment}-link-fetcher`,
            entrypoint: "LinkFetchService",
            remote: true,
          },
        ],
      }),
      { mode: 0o600 },
    );
    proxy = await getPlatformProxy({ configPath, remoteBindings: true });
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      try {
        const response = await proxy.env.LINK_FETCHER.fetch(
          "https://link-fetcher.internal/lookup",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ hostname: "example.com" }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (
          response.ok &&
          z
            .array(z.string())
            .min(1)
            .safeParse(await response.json()).success
        ) {
          console.log(`The ${environment} link fetcher is ready.`);
          return;
        }
        await response.body?.cancel();
      } catch {
        // A new Container application can take several minutes to become available.
        // No application deployment follows until a real lookup succeeds.
      }
      await delay(5000);
    }
    throw new Error(
      "The private link fetcher did not become ready; application deployment stopped.",
    );
  } finally {
    await proxy?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}
