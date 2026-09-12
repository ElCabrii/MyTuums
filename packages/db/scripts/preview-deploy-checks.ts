import { z } from "zod";

/** A newer failed run must supersede an older successful run for the same commit. */
export function requirePreviewChecks(commit: string, responseBody: string) {
  const checks = z
    .object({
      total_count: z.number().int(),
      check_runs: z.array(
        z.object({
          id: z.number().int(),
          name: z.string(),
          head_sha: z.string(),
          status: z.string(),
          conclusion: z.string().nullable(),
          app: z.object({ slug: z.string() }),
        }),
      ),
    })
    .parse(JSON.parse(responseBody));
  if (checks.total_count > 100)
    throw new Error("Too many check runs; inspect CI before deploying.");
  for (const name of ["Verify", "E2E tests"]) {
    const latest = checks.check_runs
      .filter(
        (check) =>
          check.name === name && check.head_sha === commit && check.app.slug === "github-actions",
      )
      .sort((a, b) => b.id - a.id)[0];
    if (latest?.status !== "completed" || latest.conclusion !== "success")
      throw new Error(`The ${name} check must pass on the exact commit before deployment.`);
  }
}
