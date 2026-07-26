// tests/scan.test.js — fleet scan: version parsing, staleness classification, env enumeration,
// name→repo mapping (incl. the unmapped "needsCoordinates" path), and the not-configured no-op.
// All Anypoint reads are stubbed via a fake client; coordinate resolution is injected.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseRuntimeVersion } from "../skills/mule-upgrade/scripts/lib/anypoint.js";
import { scanFleet, classifyApp, formatReport } from "../skills/mule-upgrade-scan/scripts/scan.js";

// ── parseRuntimeVersion ──────────────────────────────────────────────────────────────────────
test("parseRuntimeVersion splits mule + java across shapes", () => {
  assert.deepEqual(parseRuntimeVersion("4.4.0:8-java"), { muleVersion: "4.4.0", javaVersion: 8 });
  assert.deepEqual(parseRuntimeVersion("4.9.18:17"), { muleVersion: "4.9.18", javaVersion: 17 });
  assert.deepEqual(parseRuntimeVersion("4.6.0"), { muleVersion: "4.6.0", javaVersion: null });
  assert.deepEqual(parseRuntimeVersion(null), { muleVersion: null, javaVersion: null });
  assert.deepEqual(parseRuntimeVersion(""), { muleVersion: null, javaVersion: null });
});

// ── classifyApp ──────────────────────────────────────────────────────────────────────────────
test("classifyApp flags old Mule and/or old Java", () => {
  const th = { staleMuleBelow: "4.5.0", targetJava: 17 };
  assert.equal(classifyApp({ muleVersion: "4.4.0", javaVersion: 8 }, th).stale, true);
  assert.equal(classifyApp({ muleVersion: "4.3.0", javaVersion: 8 }, th).reasons.length, 2);
  // current runtime, current java → not stale
  assert.equal(classifyApp({ muleVersion: "4.9.18", javaVersion: 17 }, th).stale, false);
  // modern Mule but still on Java 11 → stale (java only)
  const j = classifyApp({ muleVersion: "4.6.0", javaVersion: 11 }, th);
  assert.equal(j.stale, true);
  assert.match(j.reasons[0], /Java 11 is older than 17/);
  // unknown versions → not flagged (avoid false positives)
  assert.equal(classifyApp({ muleVersion: null, javaVersion: null }, th).stale, false);
});

// ── fake client ──────────────────────────────────────────────────────────────────────────────
function fakeClient({ configured = true, envs = [], byEnv = {} } = {}) {
  return {
    configured: () => configured,
    listEnvironments: async () => envs,
    listDeployments: async ({ env }) => byEnv[env] ?? [],
  };
}

const ENVS = [
  { id: "e1", name: "Production", type: "production" },
  { id: "e2", name: "Staging", type: "sandbox" },
];

// ── not configured → clean no-op ──────────────────────────────────────────────────────────────
test("scanFleet: not configured returns a 0/0 report, never throws", async () => {
  const report = await scanFleet({ client: fakeClient({ configured: false }) });
  assert.equal(report.configured, false);
  assert.equal(report.totalApps, 0);
  assert.equal(report.staleApps, 0);
  assert.match(formatReport(report), /not configured/i);
});

// ── full scan: classify + resolve repos + de-dup across envs + unmapped flag ────────────────────
test("scanFleet: classifies, maps repos, de-dups multi-env, flags unmapped", async () => {
  const client = fakeClient({
    envs: ENVS,
    byEnv: {
      Production: [
        { name: "orders-api", muleVersion: "4.4.0", javaVersion: 8, runtimeVersion: "4.4.0:8-java", status: "RUNNING", environment: "Production" },
        { name: "modern-api", muleVersion: "4.9.18", javaVersion: 17, runtimeVersion: "4.9.18:17", status: "RUNNING", environment: "Production" },
        { name: "legacy-billing-prod", muleVersion: "4.3.0", javaVersion: 8, runtimeVersion: "4.3.0:8-java", status: "RUNNING", environment: "Production" },
      ],
      Staging: [
        // same stale app in a second env → must collapse to one candidate with 2 environments
        { name: "orders-api", muleVersion: "4.4.0", javaVersion: 8, runtimeVersion: "4.4.0:8-java", status: "RUNNING", environment: "Staging" },
      ],
    },
  });

  // injected resolver: orders-api resolves; legacy-billing-prod does NOT (throws) → needsCoordinates
  const resolve = async ({ appName }) => {
    if (appName === "orders-api") return { owner: "acme", repo: "orders-api", appPath: ".", orgId: "o1", defaultBranch: "main", fromRegistry: false };
    throw new Error("unresolvable");
  };

  const report = await scanFleet({ client, deps: { resolve } });

  assert.equal(report.configured, true);
  assert.equal(report.coverage, "amc");
  assert.deepEqual(report.environmentsScanned, ["Production", "Staging"]);
  assert.equal(report.totalApps, 4); // 3 prod + 1 staging
  assert.equal(report.staleApps, 2); // orders-api (deduped) + legacy-billing-prod; modern-api excluded

  const orders = report.candidates.find((c) => c.appName === "orders-api");
  assert.deepEqual(orders.environments.sort(), ["Production", "Staging"]);
  assert.equal(orders.needsCoordinates, false);
  assert.equal(orders.repo, "orders-api");

  const legacy = report.candidates.find((c) => c.appName === "legacy-billing-prod");
  assert.equal(legacy.needsCoordinates, true);
  assert.equal(legacy.owner, null);

  assert.ok(report.warnings.some((w) => /could not be mapped/i.test(w)));
});

// ── env restriction ─────────────────────────────────────────────────────────────────────────────
test("scanFleet: --env restriction narrows to named environments + warns on unknown", async () => {
  const client = fakeClient({
    envs: ENVS,
    byEnv: { Production: [{ name: "a", muleVersion: "4.4.0", javaVersion: 8, environment: "Production" }] },
  });
  const resolve = async () => ({ owner: "o", repo: "a", appPath: ".", defaultBranch: "main" });
  const report = await scanFleet({ client, environments: ["Production", "Nope"], deps: { resolve } });
  assert.deepEqual(report.environmentsScanned, ["Production"]);
  assert.ok(report.warnings.some((w) => /"NOPE" not found/i.test(w)));
});

// ── resolveRepos:false skips mapping entirely ───────────────────────────────────────────────────
test("scanFleet: resolveRepos:false reports stale apps without touching the resolver", async () => {
  const client = fakeClient({
    envs: [ENVS[0]],
    byEnv: { Production: [{ name: "a", muleVersion: "4.4.0", javaVersion: 8, environment: "Production" }] },
  });
  let called = false;
  const resolve = async () => { called = true; return {}; };
  const report = await scanFleet({ client, resolveRepos: false, deps: { resolve } });
  assert.equal(called, false);
  assert.equal(report.staleApps, 1);
  assert.equal(report.candidates[0].needsCoordinates, true);
});
