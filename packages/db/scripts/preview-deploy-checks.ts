import timers from "node:timers/promises";
import { z } from "zod";

export type DeploymentTarget = "preview" | "production";

class PendingPreviewChecksError extends Error {}

/** Prevent a release branch from ever targeting production, or main from overwriting preview. */
export function requireDeploymentBranch(target: DeploymentTarget, branch: string) {
  const allowed = target === "production" ? branch === "main" : /^release\/.+/.test(branch);
  if (!allowed)
    throw new Error(`${target} deployment is not allowed from branch ${JSON.stringify(branch)}.`);
}

/** A newer failed run must supersede an older successful run for the same commit. */
export function requirePreviewChecks(
  commit: string,
  responseBody: string,
  target: DeploymentTarget,
) {
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
  let pendingCheck: string | undefined;
  const requiredChecks =
    target === "preview" ? ["Fast checks"] : ["Verify", "E2E tests", "Docker image builds"];
  for (const name of requiredChecks) {
    const latest = checks.check_runs
      .filter(
        (check) =>
          check.name === name && check.head_sha === commit && check.app.slug === "github-actions",
      )
      .sort((a, b) => b.id - a.id)[0];
    if (
      latest?.conclusion === null &&
      (latest.status === "queued" || latest.status === "in_progress")
    ) {
      pendingCheck ??= name;
      continue;
    }
    if (latest?.status !== "completed" || latest.conclusion !== "success")
      throw new Error(`The ${name} check must pass on the exact commit before deployment.`);
  }
  if (pendingCheck)
    throw new PendingPreviewChecksError(`The ${pendingCheck} check is still pending.`);
}

/** Push and PR checks can overlap; wait for pending checks without accepting stale successes. */
export async function waitForPreviewChecks(
  commit: string,
  readChecks: () => Promise<string>,
  target: DeploymentTarget,
) {
  const deadline = Date.now() + 30 * 60_000;
  let waitingLogged = false;
  while (Date.now() < deadline) {
    const responseBody = await readChecks();
    try {
      requirePreviewChecks(commit, responseBody, target);
      return;
    } catch (error) {
      if (!(error instanceof PendingPreviewChecksError)) throw error;
      if (!waitingLogged) {
        console.log("Waiting for pending CI checks on the deployment commit.");
        waitingLogged = true;
      }
      await timers.setTimeout(10_000);
    }
  }
  throw new Error("Timed out waiting for required CI checks before deployment.");
}
