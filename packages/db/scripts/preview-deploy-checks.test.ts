import assert from "node:assert/strict";
import { test } from "node:test";
import { requirePreviewChecks } from "./preview-deploy-checks.js";

const commit = "a".repeat(40);
const checks = ["Verify", "E2E tests"].map((name, id) => ({
  id,
  name,
  head_sha: commit,
  status: "completed",
  conclusion: "success",
  app: { slug: "github-actions" },
}));
await test("preview deployment requires both successful GitHub Actions checks on the exact commit", () => {
  assert.doesNotThrow(() =>
    requirePreviewChecks(commit, JSON.stringify({ total_count: 2, check_runs: checks })),
  );
  assert.throws(() =>
    requirePreviewChecks("b".repeat(40), JSON.stringify({ total_count: 2, check_runs: checks })),
  );
  assert.throws(() =>
    requirePreviewChecks(
      commit,
      JSON.stringify({ total_count: 1, check_runs: checks.slice(0, 1) }),
    ),
  );
  assert.throws(() =>
    requirePreviewChecks(
      commit,
      JSON.stringify({
        total_count: 2,
        check_runs: checks.map((check) => ({ ...check, app: { slug: "another-app" } })),
      }),
    ),
  );
});
await test("a newer failed or pending check prevents deployment even if an older run passed", () => {
  for (const conclusion of ["failure", "cancelled", null]) {
    const runs = [...checks, { ...checks[0], id: 100, conclusion }];
    assert.throws(() =>
      requirePreviewChecks(commit, JSON.stringify({ total_count: 3, check_runs: runs })),
    );
  }
});
