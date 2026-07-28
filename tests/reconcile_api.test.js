// tests/reconcile_api.test.js — token-based (api-mode) reconcile pollers + auto-refresh plumbing.
//
// These lock the behavior that makes "check status now" work in Vibes without a `gh` CLI:
//   · pollPrViaApi / pollChecksViaApi read PR state + checks over the GitHub token (injected fake api)
//   · runReconcile(opts.api) uses those pollers, records the munit sub-stage, and reports checks[]
//   · a passing MUnit stays PR_OPEN but is surfaced via checks[]/munit (does NOT advance the enum)
//   · reconcileJob scopes a single job and always polls (staleSeconds forced to 0)

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmpHome;
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mule-recapi-"));
  process.env.MULE_UPGRADE_HOME = tmpHome;
});
afterEach(() => {
  delete process.env.MULE_UPGRADE_HOME;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const store = await import("../skills/mule-upgrade-job/scripts/jobstore.js");
const { runReconcile, reconcileJob, pollPrViaApi, pollChecksViaApi, makeApiChecksPoller } = await import(
  "../skills/mule-upgrade-job/scripts/reconcile.js"
);
const { TOOLS_BY_NAME } = await import("../server/lib/tools.js");

const REC = { coords: { owner: "avatansh", repo: "lead-to-contacts-demo-api" }, prNumber: 13 };

// ── pollPrViaApi ────────────────────────────────────────────────────────────────────────────
test("pollPrViaApi maps merged / closed / open from the REST PR record", async () => {
  const merged = await pollPrViaApi(REC, { getPull: async () => ({ state: "closed", merged: true }) });
  assert.deepEqual(merged, { merged: true, closed: false, open: false });

  const mergedByDate = await pollPrViaApi(REC, {
    getPull: async () => ({ state: "closed", merged_at: "2026-07-28T00:00:00Z" }),
  });
  assert.equal(mergedByDate.merged, true);

  const closed = await pollPrViaApi(REC, { getPull: async () => ({ state: "closed", merged: false }) });
  assert.deepEqual(closed, { merged: false, closed: true, open: false });

  const open = await pollPrViaApi(REC, { getPull: async () => ({ state: "open" }) });
  assert.deepEqual(open, { merged: false, closed: false, open: true });
});

test("pollPrViaApi returns all-false on error or missing coords", async () => {
  const err = await pollPrViaApi(REC, {
    getPull: async () => {
      throw new Error("500");
    },
  });
  assert.deepEqual(err, { merged: false, closed: false, open: false });
  const noPr = await pollPrViaApi({ coords: { owner: "o", repo: "r" } }, { getPull: async () => ({}) });
  assert.deepEqual(noPr, { merged: false, closed: false, open: false });
});

// ── pollChecksViaApi (check-runs + legacy statuses, keyed off the PR head sha) ────────────────
test("pollChecksViaApi merges check-runs and combined statuses and normalizes conclusions", async () => {
  const api = {
    getPull: async () => ({ head: { sha: "HEADSHA" } }),
    listCheckRuns: async (o, r, ref) => {
      assert.equal(ref, "HEADSHA");
      return {
        check_runs: [
          { name: "MUnit tests", status: "completed", conclusion: "success" },
          { name: "java17-guard", status: "completed", conclusion: "failure" },
          { name: "flaky", status: "in_progress", conclusion: null }, // → pending
        ],
      };
    },
    getCombinedStatus: async () => ({ statuses: [{ context: "legacy-ci", state: "success" }] }),
  };
  const out = await pollChecksViaApi(REC, api);
  assert.deepEqual(out, [
    { name: "MUnit tests", conclusion: "success" },
    { name: "java17-guard", conclusion: "failure" },
    { name: "flaky", conclusion: "pending" },
    { name: "legacy-ci", conclusion: "success" },
  ]);
});

// ── makeApiChecksPoller: per-PR read coalescing within one sweep ──────────────────────────────
test("makeApiChecksPoller batches one REST read per PR across jobs; reset re-reads next sweep", async () => {
  let pulls = 0;
  const api = {
    getPull: async () => {
      pulls++;
      return { head: { sha: "SHARED" } };
    },
    listCheckRuns: async () => ({ check_runs: [{ name: "MUnit tests", status: "completed", conclusion: "success" }] }),
    getCombinedStatus: async () => ({ statuses: [] }),
  };
  const poll = makeApiChecksPoller(api);
  const recA = { coords: { owner: "o", repo: "mono" }, prNumber: 42 };
  const recB = { coords: { owner: "o", repo: "mono" }, prNumber: 42 }; // same PR → shares the read
  const [a, b] = await Promise.all([poll(recA), poll(recB)]);
  assert.deepEqual(a, b);
  assert.equal(pulls, 1); // two same-PR jobs → ONE getPull round-trip

  // a different PR is a distinct key → its own read
  await poll({ coords: { owner: "o", repo: "mono" }, prNumber: 43 });
  assert.equal(pulls, 2);

  // reset() drops the cache so the next sweep sees fresh state
  poll.reset();
  await poll(recA);
  assert.equal(pulls, 3);
});

// ── runReconcile via the token client (opts.api) ─────────────────────────────────────────────
function stale(rec) {
  rec.updatedAt = "2000-01-01T00:00:00.000Z";
  store.putJob(rec);
}
const NOW = Date.parse("2030-01-01T00:00:00.000Z");

test("runReconcile(opts.api): passing MUnit stays PR_OPEN, records sub-stage + reports checks[]", async () => {
  const { jobId } = store.createJob({ appName: "app-api-1", coords: REC.coords });
  store.setStatus(jobId, "PR_OPEN", { prNumber: 13 });
  stale(store.getJob(jobId));

  const api = {
    getPull: async () => ({ state: "open", head: { sha: "S1" } }),
    listCheckRuns: async () => ({
      check_runs: [
        { name: "MUnit tests", status: "completed", conclusion: "success" },
        { name: "dependency-guard", status: "completed", conclusion: "success" },
      ],
    }),
    getCombinedStatus: async () => ({ statuses: [] }),
  };
  const res = await runReconcile({ api, nowMs: NOW });
  assert.equal(store.getJob(jobId).status, "PR_OPEN"); // green MUnit does NOT advance the enum
  assert.equal(store.getJob(jobId).munit?.result, "passed"); // sub-stage recorded
  // both decisive checks surfaced, even though the enum didn't change
  const forJob = res.checks.filter((c) => c.jobId === jobId);
  assert.deepEqual(
    forJob.map((c) => `${c.stage}:${c.result}`).sort(),
    ["dependency-guard:success", "test:success"]
  );
});

test("runReconcile(opts.api): failing MUnit parks MUNIT_FAILED", async () => {
  const { jobId } = store.createJob({ appName: "app-api-2", coords: REC.coords });
  store.setStatus(jobId, "PR_OPEN", { prNumber: 14 });
  stale(store.getJob(jobId));

  const api = {
    getPull: async () => ({ state: "open", head: { sha: "S2" } }),
    listCheckRuns: async () => ({ check_runs: [{ name: "MUnit tests", status: "completed", conclusion: "failure" }] }),
    getCombinedStatus: async () => ({ statuses: [] }),
  };
  const res = await runReconcile({ api, nowMs: NOW });
  assert.equal(store.getJob(jobId).status, "MUNIT_FAILED");
  assert.ok(res.actions.some((a) => a.to === "MUNIT_FAILED"));
});

test("runReconcile(opts.api): merged PR advances PR_OPEN → DEPLOYING", async () => {
  const { jobId } = store.createJob({ appName: "app-api-3", coords: REC.coords });
  store.setStatus(jobId, "PR_OPEN", { prNumber: 15 });
  stale(store.getJob(jobId));

  const api = {
    getPull: async () => ({ state: "closed", merged: true, head: { sha: "S3" } }),
    listCheckRuns: async () => ({ check_runs: [{ name: "MUnit tests", status: "completed", conclusion: "success" }] }),
    getCombinedStatus: async () => ({ statuses: [] }),
  };
  await runReconcile({ api, nowMs: NOW });
  assert.equal(store.getJob(jobId).status, "DEPLOYING");
});

// ── parked (MUNIT_FAILED / DEP_GUARD_FAILED) jobs must ALSO poll the PR ───────────────────────
// Regression: a job sitting at DEP_GUARD_FAILED whose PR is manually CLOSED used to stay *_FAILED
// forever (reconcile only polled CI checks for parked jobs, never the PR) — so "check status now"
// never reported closed-unmerged. It must now finalize to CLOSED and release the lock.
test("runReconcile(opts.api): DEP_GUARD_FAILED job whose PR is manually CLOSED → CLOSED (closed-unmerged) + lock released", async () => {
  const { jobId } = store.createJob({ appName: "app-parked-closed", coords: REC.coords });
  store.setStatus(jobId, "DEP_GUARD_FAILED", { prNumber: 36 });
  stale(store.getJob(jobId));

  const api = {
    getPull: async () => ({ state: "closed", merged: false, head: { sha: "SC" } }),
    listCheckRuns: async () => ({ check_runs: [] }), // no decisive CI change this sweep
    getCombinedStatus: async () => ({ statuses: [] }),
  };
  const res = await runReconcile({ api, nowMs: NOW });
  assert.equal(store.getJob(jobId).status, "CLOSED");
  assert.ok(
    res.actions.some((a) => a.from === "DEP_GUARD_FAILED" && a.to === "CLOSED"),
    "records the DEP_GUARD_FAILED → CLOSED transition"
  );
  assert.ok(!store.lockHolder("app-parked-closed"), "app lock released on closure");
});

test("runReconcile(opts.api): MUNIT_FAILED job whose PR is manually CLOSED → CLOSED", async () => {
  const { jobId } = store.createJob({ appName: "app-parked-munit-closed", coords: REC.coords });
  store.setStatus(jobId, "MUNIT_FAILED", { prNumber: 39 });
  stale(store.getJob(jobId));

  const api = {
    getPull: async () => ({ state: "closed", merged: false, head: { sha: "SMC" } }),
    listCheckRuns: async () => ({ check_runs: [] }),
    getCombinedStatus: async () => ({ statuses: [] }),
  };
  await runReconcile({ api, nowMs: NOW });
  assert.equal(store.getJob(jobId).status, "CLOSED");
});

test("runReconcile(opts.api): DEP_GUARD_FAILED job whose PR was admin-MERGED → DEPLOYING", async () => {
  const { jobId } = store.createJob({ appName: "app-parked-merged", coords: REC.coords });
  store.setStatus(jobId, "DEP_GUARD_FAILED", { prNumber: 37 });
  stale(store.getJob(jobId));

  const api = {
    getPull: async () => ({ state: "closed", merged: true, head: { sha: "SM" } }),
    listCheckRuns: async () => ({ check_runs: [] }),
    getCombinedStatus: async () => ({ statuses: [] }),
  };
  await runReconcile({ api, nowMs: NOW });
  assert.equal(store.getJob(jobId).status, "DEPLOYING");
});

test("runReconcile(opts.api): DEP_GUARD_FAILED job whose PR is still OPEN stays parked (no spurious transition)", async () => {
  const { jobId } = store.createJob({ appName: "app-parked-open", coords: REC.coords });
  store.setStatus(jobId, "DEP_GUARD_FAILED", { prNumber: 38 });
  stale(store.getJob(jobId));

  const api = {
    getPull: async () => ({ state: "open", head: { sha: "SO" } }),
    listCheckRuns: async () => ({ check_runs: [] }),
    getCombinedStatus: async () => ({ statuses: [] }),
  };
  await runReconcile({ api, nowMs: NOW });
  assert.equal(store.getJob(jobId).status, "DEP_GUARD_FAILED");
});

// ── reconcileJob: scoped single-job refresh, always polls (staleSeconds 0) ────────────────────
test("reconcileJob refreshes one job even when freshly updated (staleSeconds forced to 0)", async () => {
  const { jobId } = store.createJob({ appName: "app-api-4", coords: REC.coords });
  store.setStatus(jobId, "PR_OPEN", { prNumber: 16 }); // fresh updatedAt (~now), NOT stale

  const api = {
    getPull: async () => ({ state: "open", head: { sha: "S4" } }),
    listCheckRuns: async () => ({ check_runs: [{ name: "MUnit tests", status: "completed", conclusion: "success" }] }),
    getCombinedStatus: async () => ({ statuses: [] }),
  };
  const r = await reconcileJob(jobId, { api });
  assert.equal(store.getJob(jobId).munit?.result, "passed"); // polled despite being fresh
  assert.ok(r.checks.some((c) => c.stage === "test" && c.result === "success"));
});

test("reconcileJob returns an empty result for an unknown job", async () => {
  const r = await reconcileJob("job-does-not-exist");
  assert.deepEqual(r, { scanned: 0, fixed: 0, actions: [], checks: [] });
});

// ── get_job_status MCP tool: auto-refresh wiring (refresh:false = deterministic pure read) ────
test("get_job_status tool with refresh:false is a pure cache read (no poll, no checks[])", async () => {
  const { jobId } = store.createJob({ appName: "app-tool-1", coords: REC.coords });
  store.setStatus(jobId, "PR_OPEN", { prNumber: 20, prUrl: "https://x/pull/20" });
  const out = await TOOLS_BY_NAME.get("get_job_status").handler({ jobId, refresh: false });
  assert.equal(out.status, "PR_OPEN");
  assert.equal(out.prNumber, 20);
  assert.equal("checks" in out, false); // refresh disabled → nothing polled, no sub-status surfaced
});
