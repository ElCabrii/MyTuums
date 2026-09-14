import { waitForLinkFetcher } from "./link-fetcher-ready.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { unstable_readConfig } from "wrangler";
import { requireDeploymentBranch, requirePreviewChecks } from "./preview-deploy-checks.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({ options: { target: { type: "string", default: "preview" } } });
const target = z.enum(["preview", "production"]).parse(values.target);
const environment = target === "preview" ? "preview" : "production";
const appConfiguration = `wrangler.${target}.jsonc`;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const branch =
  process.env.WORKERS_CI_BRANCH ?? process.env.GITHUB_REF_NAME ?? git("branch", "--show-current");
const commit = z
  .string()
  .regex(/^[a-f0-9]{40}$/)
  .parse(process.env.WORKERS_CI_COMMIT_SHA ?? process.env.GITHUB_SHA ?? git("rev-parse", "HEAD"));
function assertCheckout() {
  requireDeploymentBranch(target, branch);
  if (git("rev-parse", "HEAD") !== commit || git("status", "--porcelain")) {
    throw new Error(
      "Deployment requires an unchanged, clean checkout on the target's allowed branch.",
    );
  }
}
assertCheckout();
if (
  !process.env.VITE_GOOGLE_CLIENT_ID ||
  process.env.VITE_SOCIAL_PROVIDERS !== "google,discord,twitch"
) {
  throw new Error(
    "Supply the target's public Google client ID and VITE_SOCIAL_PROVIDERS=google,discord,twitch before building.",
  );
}
const githubHeaders = new Headers({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
});
if (process.env.GITHUB_TOKEN)
  githubHeaders.set("Authorization", `Bearer ${process.env.GITHUB_TOKEN}`);
const response = await fetch(
  `https://api.github.com/repos/ElCabrii/MyTuums/commits/${commit}/check-runs?per_page=100`,
  {
    headers: githubHeaders,
    signal: AbortSignal.timeout(15000),
  },
);
if (!response.ok) throw new Error("Cannot verify the deployment commit's CI checks.");
requirePreviewChecks(commit, await response.text());

function run(args: string[]) {
  assertCheckout();
  execFileSync("pnpm", args, { cwd: root, stdio: "inherit" });
}
const config = z
  .object({
    vars: z.object({
      WEB_ORIGIN: z.literal(
        target === "production" ? "https://mytuums.com" : "https://preview.mytuums.com",
      ),
      GOOGLE_ANALYTICS: z.enum(["enabled", "disabled"]),
    }),
  })
  .parse(unstable_readConfig({ config: `${root}apps/server/${appConfiguration}` }));
process.env.VITE_WEB_ORIGIN = config.vars.WEB_ORIGIN;
process.env.VITE_GOOGLE_ANALYTICS = config.vars.GOOGLE_ANALYTICS;
console.log(`Deploying verified ${target} commit ${commit}: build, migrations, jobs, application.`);
run(["build"]);
run(["db:migrate", "--remote", `--environment=${environment}`]);
run([
  "--filter",
  "@my-tuums/link-fetcher",
  "exec",
  "wrangler",
  "deploy",
  "--config",
  `wrangler.${environment}.jsonc`,
]);
await waitForLinkFetcher(environment);
run(["--filter", "@my-tuums/jobs", "exec", "wrangler", "deploy", "--config", appConfiguration]);
run(["--filter", "@my-tuums/server", "exec", "wrangler", "deploy", "--config", appConfiguration]);
if (target === "production")
  run([
    "--filter",
    "@my-tuums/branding",
    "exec",
    "wrangler",
    "deploy",
    "--config",
    "wrangler.production.jsonc",
  ]);
console.log(
  "Deployment commands completed. Verify health and provider behavior before reopening writes or schedules.",
);
