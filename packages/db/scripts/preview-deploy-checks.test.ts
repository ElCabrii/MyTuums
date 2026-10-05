import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  requireDeploymentBranch,
  requirePreviewChecks,
  waitForPreviewChecks,
} from "./preview-deploy-checks.js";

const commit = "a".repeat(40);
const checks = ["Verify", "E2E tests", "Docker image builds"].map((name, id) => ({
  id,
  name,
  head_sha: commit,
  status: "completed",
  conclusion: "success",
  app: { slug: "github-actions" },
}));

await test("deployment targets accept only their designated release branches", () => {
  assert.doesNotThrow(() => requireDeploymentBranch("production", "main"));
  assert.doesNotThrow(() => requireDeploymentBranch("preview", "release/0.6.0"));
  assert.throws(() => requireDeploymentBranch("production", "release/0.6.0"));
  assert.throws(() => requireDeploymentBranch("preview", "main"));
  assert.throws(() => requireDeploymentBranch("preview", "feature/video"));
  assert.throws(() => requireDeploymentBranch("preview", "release/"));
});
await test("production deployment requires all three successful GitHub Actions checks on the exact commit", () => {
  assert.doesNotThrow(() =>
    requirePreviewChecks(
      commit,
      JSON.stringify({ total_count: 3, check_runs: checks }),
      "production",
    ),
  );
  assert.throws(() =>
    requirePreviewChecks(
      "b".repeat(40),
      JSON.stringify({ total_count: 3, check_runs: checks }),
      "production",
    ),
  );
  assert.throws(() =>
    requirePreviewChecks(
      commit,
      JSON.stringify({ total_count: 1, check_runs: checks.slice(0, 1) }),
      "production",
    ),
  );
  assert.throws(() =>
    requirePreviewChecks(
      commit,
      JSON.stringify({
        total_count: 3,
        check_runs: checks.map((check) => ({ ...check, app: { slug: "another-app" } })),
      }),
      "production",
    ),
  );
});
await test("a newer failed or pending check prevents deployment even if an older run passed", () => {
  for (const conclusion of ["failure", "cancelled", null]) {
    const runs = [...checks, { ...checks[0], id: 100, conclusion }];
    assert.throws(() =>
      requirePreviewChecks(
        commit,
        JSON.stringify({ total_count: 4, check_runs: runs }),
        "production",
      ),
    );
  }
});

await test("a passing application suite cannot substitute for the required Container image check", () => {
  assert.throws(
    () =>
      requirePreviewChecks(
        commit,
        JSON.stringify({ total_count: 2, check_runs: checks.slice(0, 2) }),
        "production",
      ),
    /Docker image builds/,
  );
});

await test("a deployment waits for newer checks on the same commit before proceeding", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const newer = { ...checks[0], id: 100, status: "queued", conclusion: null };
  let runs = [...checks, newer];
  let outcome = "pending";
  const result = waitForPreviewChecks(
    commit,
    () => Promise.resolve(JSON.stringify({ total_count: runs.length, check_runs: runs })),
    "production",
  ).then(
    () => {
      outcome = "passed";
    },
    () => {
      outcome = "rejected";
    },
  );
  await setImmediate();
  assert.equal(outcome, "pending");

  runs = [...checks, { ...newer, status: "completed", conclusion: "success" }];
  t.mock.timers.tick(10_000);
  await result;
  assert.equal(outcome, "passed");
});

await test("a completed failure stops the deployment wait even when another check is pending", async () => {
  const runs = [
    ...checks,
    { ...checks[0], id: 100, status: "in_progress", conclusion: null },
    { ...checks[1], id: 101, conclusion: "failure" },
  ];
  await assert.rejects(
    waitForPreviewChecks(
      commit,
      () => Promise.resolve(JSON.stringify({ total_count: runs.length, check_runs: runs })),
      "production",
    ),
    /E2E tests check must pass/,
  );
});

await test("pending checks cannot hold a deployment indefinitely", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const runs = [...checks, { ...checks[0], id: 100, status: "in_progress", conclusion: null }];
  let outcome = "pending";
  const result = waitForPreviewChecks(
    commit,
    () => Promise.resolve(JSON.stringify({ total_count: runs.length, check_runs: runs })),
    "production",
  ).then(
    () => {
      outcome = "passed";
    },
    () => {
      outcome = "rejected";
    },
  );
  await setImmediate();
  assert.equal(outcome, "pending");

  t.mock.timers.tick(31 * 60_000);
  await result;
  assert.equal(outcome, "rejected");
});

await test("preview accepts fast checks without release checks; production cannot substitute them", () => {
  const fast = { ...checks[0], name: "Fast checks" };
  const response = JSON.stringify({ total_count: 1, check_runs: [fast] });
  assert.doesNotThrow(() => requirePreviewChecks(commit, response, "preview"));
  assert.throws(() => requirePreviewChecks(commit, response, "production"), /Verify/);
  assert.throws(() => requirePreviewChecks("b".repeat(40), response, "preview"), /Fast checks/);

  // Full checks (including skipped jobs) must not affect the preview gate.
  assert.doesNotThrow(() =>
    requirePreviewChecks(
      commit,
      JSON.stringify({
        total_count: 4,
        check_runs: [fast, ...checks.map((check) => ({ ...check, conclusion: "skipped" }))],
      }),
      "preview",
    ),
  );
  for (const replacement of [
    { ...fast, conclusion: "failure" },
    { ...fast, conclusion: "cancelled" },
    { ...fast, conclusion: "skipped" },
    { ...fast, status: "queued", conclusion: null },
    { ...fast, status: "in_progress", conclusion: null },
  ]) {
    assert.throws(
      () =>
        requirePreviewChecks(
          commit,
          JSON.stringify({
            total_count: 2,
            check_runs: [fast, { ...replacement, id: 100 }],
          }),
          "preview",
        ),
      /Fast checks/,
    );
  }
  for (const runs of [checks, [{ ...fast, app: { slug: "another-app" } }]]) {
    assert.throws(
      () =>
        requirePreviewChecks(
          commit,
          JSON.stringify({
            total_count: runs.length,
            check_runs: runs,
          }),
          "preview",
        ),
      /Fast checks/,
    );
  }
});
