// tests/batch.test.js — SKILL 11 (batch upgrade): the fan-out layer.
//
// runUpgrade is injected everywhere, so these tests exercise the SCHEDULER's contracts — preview
// gating, per-app failure isolation, parent-pom grouping, de-duplication, bounded concurrency —
// without touching GitHub, the job store, or any lock.

import test from "node:test";
import assert from "node:assert/strict";
import { runBatchUpgrade, pool, summarise, managingPomPaths } from "../skills/mule-upgrade-batch/scripts/batch.js";

/** Coordinate resolver stub: every app maps to acme/<app>-repo unless told otherwise. */
const resolve = async ({ appName, request }) => ({
  owner: request?.owner ?? "acme",
  repo: request?.repo ?? `${appName}-repo`,
  appPath: request?.appPath ?? undefined,
  defaultBranch: "develop",
});

/** A runUpgrade stub driven by a per-app script of {dry, run} results. */
function fakeUpgrade(script, log = []) {
  return async (opts) => {
    log.push({ appName: opts.appName, dryRun: opts.dryRun, environment: opts.environment, notifyPrefs: opts.notifyPrefs });
    const entry = script[opts.appName] ?? {};
    const res = opts.dryRun ? entry.dry : entry.run;
    if (res instanceof Error) throw res;
    return res ?? { status: "PLAN_PREVIEW", changePlan: { fileEdits: [{ file: "pom.xml" }] } };
  };
}

const EDITS = { status: "PLAN_PREVIEW", changePlan: { fileEdits: [{ file: "pom.xml" }, { file: "mule-artifact.json" }] } };

test("pool: bounded concurrency, order preserved, never exceeds the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = await pool(items, 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, n % 3 === 0 ? 5 : 1));
    inFlight--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70, 80], "results keep INPUT order, not completion order");
  assert.ok(peak <= 3, `peak concurrency ${peak} must not exceed the limit`);
});

test("pool: a limit above the item count degrades to one slot per item", async () => {
  const out = await pool([1, 2], 99, async (n) => n + 1);
  assert.deepEqual(out, [2, 3]);
});

test("batch requires an environment (VALIDATION, never a silent default)", async () => {
  await assert.rejects(() => runBatchUpgrade({ apps: ["a"] }), (e) => e.code === "VALIDATION");
});

test("preview: writes nothing and reports what WOULD run", async () => {
  const log = [];
  const res = await runBatchUpgrade({
    apps: ["orders-api", "payments-api"],
    environment: "dev",
    deps: { resolve, runUpgrade: fakeUpgrade({ "orders-api": { dry: EDITS }, "payments-api": { dry: EDITS } }, log) },
  });
  assert.equal(res.status, "PLAN_PREVIEW");
  assert.equal(res.confirmed, false);
  assert.equal(res.summary.previewed, 2);
  assert.equal(res.summary.upgraded, 0);
  assert.ok(
    log.every((c) => c.dryRun === true),
    "an unconfirmed batch must only ever dry-run"
  );
});

test("confirm:true executes and reports each app's PR", async () => {
  const log = [];
  const res = await runBatchUpgrade({
    apps: ["orders-api", "payments-api"],
    environment: "dev",
    confirm: true,
    deps: {
      resolve,
      runUpgrade: fakeUpgrade(
        {
          "orders-api": { dry: EDITS, run: { status: "PR_OPEN", jobId: "job-1", prUrl: "https://pr/1" } },
          "payments-api": { dry: EDITS, run: { status: "PR_OPEN", jobId: "job-2", prUrl: "https://pr/2" } },
        },
        log
      ),
    },
  });
  assert.equal(res.status, "BATCH_COMPLETE");
  assert.equal(res.summary.upgraded, 2);
  assert.deepEqual(
    res.apps.map((a) => a.prUrl).sort(),
    ["https://pr/1", "https://pr/2"]
  );
  assert.equal(log.filter((c) => c.dryRun === false).length, 2, "each app is previewed THEN executed");
});

test("one app's failure is isolated — the rest of the batch still completes", async () => {
  const res = await runBatchUpgrade({
    apps: ["ok-api", "boom-api", "also-ok-api"],
    environment: "dev",
    confirm: true,
    deps: {
      resolve,
      runUpgrade: fakeUpgrade({
        "ok-api": { dry: EDITS, run: { status: "PR_OPEN", jobId: "j1", prUrl: "u1" } },
        "boom-api": { dry: EDITS, run: new Error("github 500") },
        "also-ok-api": { dry: EDITS, run: { status: "PR_OPEN", jobId: "j3", prUrl: "u3" } },
      }),
    },
  });
  assert.equal(res.summary.total, 3);
  assert.equal(res.summary.upgraded, 2);
  assert.equal(res.summary.failed, 1);
  const boom = res.apps.find((a) => a.appName === "boom-api");
  assert.equal(boom.status, "ERROR");
  assert.match(boom.error, /github 500/);
});

test("a CONFLICT on one app is counted, not treated as a crash", async () => {
  const res = await runBatchUpgrade({
    apps: ["busy-api"],
    environment: "dev",
    confirm: true,
    deps: {
      resolve,
      runUpgrade: fakeUpgrade({
        "busy-api": { dry: EDITS, run: { status: "CONFLICT", code: "UPGRADE_IN_PROGRESS", jobId: "existing" } },
      }),
    },
  });
  assert.equal(res.summary.conflicts, 1);
  assert.equal(res.summary.failed, 0);
});

test("apps already on target are reported, never executed", async () => {
  const log = [];
  const res = await runBatchUpgrade({
    apps: ["done-api"],
    environment: "dev",
    confirm: true,
    deps: { resolve, runUpgrade: fakeUpgrade({ "done-api": { dry: { status: "ALREADY_UPGRADED" } } }, log) },
  });
  assert.equal(res.summary.alreadyUpgraded, 1);
  assert.equal(log.filter((c) => c.dryRun === false).length, 0, "nothing to do → never executed");
});

test("shared parent pom: apps are held back as NEEDS_PARENT_POM and grouped", async () => {
  const upstream = {
    status: "PLAN_PREVIEW",
    changePlan: { fileEdits: [], connectorGaps: [{ artifactId: "mule-http-connector", managedInPath: "parent/pom.xml" }] },
  };
  const log = [];
  const res = await runBatchUpgrade({
    apps: [
      { appName: "a-api", owner: "acme", repo: "shared" },
      { appName: "b-api", owner: "acme", repo: "shared" },
    ],
    environment: "dev",
    confirm: true,
    deps: { resolve, runUpgrade: fakeUpgrade({ "a-api": { dry: upstream }, "b-api": { dry: upstream } }, log) },
  });
  assert.equal(res.summary.needsParentPom, 2);
  assert.equal(log.filter((c) => c.dryRun === false).length, 0, "N apps sharing one pom must NOT be run in parallel");
  assert.deepEqual(res.sharedParentPoms, [{ pom: "acme/shared::parent/pom.xml", apps: ["a-api", "b-api"] }]);
});

test("includeParentPomRouted:true overrides the hold-back", async () => {
  const upstream = {
    status: "PLAN_PREVIEW",
    changePlan: { fileEdits: [], connectorGaps: [{ managedInPath: "parent/pom.xml" }] },
  };
  const log = [];
  await runBatchUpgrade({
    apps: ["a-api"],
    environment: "dev",
    confirm: true,
    includeParentPomRouted: true,
    deps: { resolve, runUpgrade: fakeUpgrade({ "a-api": { dry: upstream, run: { status: "PR_OPEN" } } }, log) },
  });
  assert.equal(log.filter((c) => c.dryRun === false).length, 1);
});

test("duplicate app entries are skipped before anything runs (no self-CONFLICT)", async () => {
  const log = [];
  const res = await runBatchUpgrade({
    apps: ["dup-api", "dup-api"],
    environment: "dev",
    confirm: true,
    deps: { resolve, runUpgrade: fakeUpgrade({ "dup-api": { dry: EDITS, run: { status: "PR_OPEN" } } }, log) },
  });
  assert.equal(res.summary.skipped, 1);
  assert.equal(log.filter((c) => c.dryRun === false).length, 1, "the app runs exactly once");
  assert.match(res.apps.find((a) => a.status === "SKIPPED").reason, /duplicate/);
});

test("unresolvable coordinates are SKIPPED, never guessed", async () => {
  const res = await runBatchUpgrade({
    apps: ["mystery-api"],
    environment: "dev",
    deps: { resolve: async () => ({ owner: null, repo: null }), runUpgrade: fakeUpgrade({}) },
  });
  assert.equal(res.summary.skipped, 1);
  assert.match(res.apps[0].reason, /coordinates could not be resolved/);
});

test("stopOnFailure abandons apps that have not started yet", async () => {
  const log = [];
  const res = await runBatchUpgrade({
    apps: ["a", "b", "c", "d"],
    environment: "dev",
    confirm: true,
    concurrency: 1, // deterministic ordering so "not yet started" is well-defined
    stopOnFailure: true,
    deps: {
      resolve,
      runUpgrade: fakeUpgrade(
        {
          a: { dry: EDITS, run: { status: "PR_OPEN" } },
          b: { dry: EDITS, run: { status: "FAILED_COMMIT", error: "nope" } },
          c: { dry: EDITS, run: { status: "PR_OPEN" } },
          d: { dry: EDITS, run: { status: "PR_OPEN" } },
        },
        log
      ),
    },
  });
  assert.equal(res.summary.failed, 1);
  assert.equal(res.summary.skipped, 2, "c and d are abandoned after b fails");
});

test("notifyPrefs are applied to EVERY app in the batch", async () => {
  const log = [];
  await runBatchUpgrade({
    apps: ["a", "b"],
    environment: "dev",
    confirm: true,
    notifyPrefs: { slack: true, jira: "comment" },
    jiraTicketId: "PLAT-9",
    deps: { resolve, runUpgrade: fakeUpgrade({ a: { dry: EDITS, run: { status: "PR_OPEN" } }, b: { dry: EDITS, run: { status: "PR_OPEN" } } }, log) },
  });
  assert.ok(
    log.every((c) => c.notifyPrefs?.slack === true && c.notifyPrefs?.jira === "comment"),
    "the session's notify choice must reach every app"
  );
});

test("fromScan: repo-mapped candidates run, unmappable ones are skipped", async () => {
  const scanFleet = async () => ({
    configured: true,
    candidates: [
      { appName: "mapped-api", owner: "acme", repo: "mapped", needsCoordinates: false },
      { appName: "unmapped-api", needsCoordinates: true },
    ],
  });
  const res = await runBatchUpgrade({
    fromScan: true,
    environment: "dev",
    deps: { resolve, scanFleet, runUpgrade: fakeUpgrade({ "mapped-api": { dry: EDITS } }) },
  });
  assert.equal(res.summary.previewed, 1);
  assert.equal(res.summary.skipped, 1);
  assert.match(res.apps.find((a) => a.appName === "unmapped-api").reason, /could not map/);
});

test("an empty selection is a clean EMPTY_SELECTION, not a crash", async () => {
  const res = await runBatchUpgrade({ apps: [], environment: "dev", deps: { resolve } });
  assert.equal(res.status, "EMPTY_SELECTION");
  assert.equal(res.summary.total, 0);
});

test("a dry-run throw is recorded as FAILED_ASSESS for that app only", async () => {
  const res = await runBatchUpgrade({
    apps: ["bad-api", "good-api"],
    environment: "dev",
    deps: {
      resolve,
      runUpgrade: fakeUpgrade({ "bad-api": { dry: new Error("401 bad credentials") }, "good-api": { dry: EDITS } }),
    },
  });
  assert.equal(res.apps.find((a) => a.appName === "bad-api").status, "FAILED_ASSESS");
  assert.equal(res.apps.find((a) => a.appName === "good-api").status, "PLAN_PREVIEW");
});

test("managingPomPaths reads gaps and explicit parent-pom routing", () => {
  assert.deepEqual(
    managingPomPaths({ changePlan: { connectorGaps: [{ managedInPath: "p/pom.xml" }, { managedInPath: "p/pom.xml" }] } }),
    ["p/pom.xml"],
    "duplicates collapse"
  );
  assert.deepEqual(managingPomPaths({ parentPomPaths: ["a/pom.xml", "b/pom.xml"] }), ["a/pom.xml", "b/pom.xml"]);
  assert.deepEqual(managingPomPaths({}), []);
});

test("summarise buckets every status it can see", () => {
  const s = summarise([
    { status: "PR_OPEN" },
    { status: "ALREADY_UPGRADED" },
    { status: "NEEDS_PARENT_POM" },
    { status: "CONFLICT" },
    { status: "FAILED_ASSESS" },
    { status: "ERROR" },
    { status: "SKIPPED" },
    { status: "PLAN_PREVIEW" },
  ]);
  assert.deepEqual(s, {
    total: 8,
    upgraded: 1,
    alreadyUpgraded: 1,
    needsParentPom: 1,
    conflicts: 1,
    failed: 2,
    skipped: 1,
    previewed: 1,
  });
});
