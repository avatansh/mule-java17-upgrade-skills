// tests/batch_a.test.js — assess Batch A live cross-checks (ADR): ARM runtime cross-check +
// API-Manager policy detection. Both env-gated (assess.armCrossCheck / assess.apiPolicyCheck) and
// fully non-fatal. Drives batchACrossChecks() with a temp config dir (toggle control) + fake client.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { batchACrossChecks } from "../skills/mule-upgrade-assess/scripts/assess.js";
import { _resetConfigCache } from "../lib_shared/config.js";

let tmpCfg;
function writeConfig(toggles) {
  fs.writeFileSync(path.join(tmpCfg, "config.yaml"), "app:\n  name: t\n");
  fs.writeFileSync(
    path.join(tmpCfg, "config-test.yaml"),
    `assess:\n  armCrossCheck: "${toggles.arm}"\n  apiPolicyCheck: "${toggles.api}"\n`
  );
  _resetConfigCache();
}
beforeEach(() => {
  tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), "mule-cfg-"));
  process.env.MULE_CONFIG_DIR = tmpCfg;
  process.env.MULE_UPGRADE_ENV = "test";
});
afterEach(() => {
  delete process.env.MULE_CONFIG_DIR;
  delete process.env.MULE_UPGRADE_ENV;
  _resetConfigCache();
  try {
    fs.rmSync(tmpCfg, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// A fake AnypointClient with configurable readDeployment/readApiPolicies.
function fakeClient(over = {}) {
  return {
    configured: () => over.configured ?? true,
    readDeployment: async () => over.deployment ?? { reachable: true, found: false, status: "UNKNOWN", runtimeVersion: null },
    readApiPolicies: async () => over.policies ?? { hasApiPolicies: false, matched: false, checked: true },
  };
}

const RESULT = { changePlan: { targetRuntime: "4.9.18", hasApiPolicies: false }, warnings: [] };

test("both toggles off → no cross-checks, no client used", async () => {
  writeConfig({ arm: "false", api: "false" });
  let used = false;
  const out = await batchACrossChecks({
    appName: "a",
    result: structuredClone(RESULT),
    client: { configured: () => (used = true) },
  });
  assert.deepEqual(out, { warnings: [] });
  assert.equal(used, false);
});

test("client not configured → silently source-only", async () => {
  writeConfig({ arm: "true", api: "true" });
  const out = await batchACrossChecks({ appName: "a", result: structuredClone(RESULT), client: fakeClient({ configured: false }) });
  assert.deepEqual(out, { warnings: [] });
});

test("ARM cross-check warns when deployed runtime differs from source target", async () => {
  writeConfig({ arm: "true", api: "false" });
  const out = await batchACrossChecks({
    appName: "a",
    environment: "Production",
    result: structuredClone(RESULT),
    client: fakeClient({ deployment: { reachable: true, found: true, status: "RUNNING", runtimeVersion: "4.6.0:8-java" } }),
  });
  assert.ok(out.deployedState);
  assert.equal(out.deployedState.status, "RUNNING");
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /differs from the source pom target 4\.9\.18/);
});

test("ARM cross-check quiet when deployed runtime matches target", async () => {
  writeConfig({ arm: "true", api: "false" });
  const out = await batchACrossChecks({
    appName: "a",
    result: structuredClone(RESULT),
    client: fakeClient({ deployment: { reachable: true, found: true, status: "RUNNING", runtimeVersion: "4.9.18:17-java" } }),
  });
  assert.equal(out.warnings.length, 0);
});

test("API-policy check sets hasApiPolicies from platform", async () => {
  writeConfig({ arm: "false", api: "true" });
  const out = await batchACrossChecks({
    appName: "a",
    result: structuredClone(RESULT),
    client: fakeClient({ policies: { hasApiPolicies: true, matched: true, checked: true } }),
  });
  assert.equal(out.hasApiPolicies, true);
});

test("cross-check swallows client errors (non-fatal)", async () => {
  writeConfig({ arm: "true", api: "true" });
  const throwing = {
    configured: () => true,
    readDeployment: async () => {
      throw new Error("platform down");
    },
    readApiPolicies: async () => {
      throw new Error("platform down");
    },
  };
  const out = await batchACrossChecks({ appName: "a", result: structuredClone(RESULT), client: throwing });
  assert.deepEqual(out.warnings, []);
  assert.equal(out.hasApiPolicies, undefined);
});
