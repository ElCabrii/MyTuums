import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMaintenanceEnvironment } from "./maintenance-environment.js";

await test("maintenance defaults to isolated local resources", () => {
  assert.equal(resolveMaintenanceEnvironment(undefined, false), "local");
  assert.throws(() => resolveMaintenanceEnvironment(undefined, true));
});

await test("hosted maintenance requires an explicit environment and remote flag", () => {
  assert.equal(resolveMaintenanceEnvironment("preview", true), "preview");
  assert.equal(resolveMaintenanceEnvironment("production", true), "production");
  assert.throws(() => resolveMaintenanceEnvironment("preview", false));
  assert.throws(() => resolveMaintenanceEnvironment("production", false));
  assert.throws(() => resolveMaintenanceEnvironment("poc", true));
});
