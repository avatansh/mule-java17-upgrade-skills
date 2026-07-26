// tests/job.test.js — SKILL 5 parity + behaviour tests.
//   · buildJobStatus: 8 cases ported 1:1 from pf-get-job-status-suite.xml.
//   · jobstore: create/lock single-flight, setStatus, branch index, idempotency, delete, reapply.
//   · reconcile: PR_OPEN→DEPLOYING/CLOSED, DEPLOYING→DEPLOYED/FAILED_DEPLOY, early→FAILED_INTERRUPTED.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildJobStatus } from "../skills/mule-upgrade-job/scripts/status.js";

// Isolate the store under a temp MULE_UPGRADE_HOME so tests never touch the real ~/.mule-upgrade.
let tmpHome;
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mule-job-"));
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

// jobstore/reconcile read MULE_UPGRADE_HOME at call time, so a normal static import is fine.
const store = await import("../skills/mule-upgrade-job/scripts/jobstore.js");
const { runReconcile, classifyCheck, reconcileCiChecks } = await import(
  "../skills/mule-upgrade-job/scripts/reconcile.js"
);

// ── buildJobStatus — ported 1:1 from pf-get-job-status-suite.xml ─────────────────────────
test("jobStatus-PROCESSING-minimal", () => {
  const p = buildJobStatus({ jobId: "job-proc-001", status: "PROCESSING", appName: "test-app" });
  assert.equal(p.jobId, "job-proc-001");
  assert.equal(p.status, "PROCESSING");
  assert.equal(p.nextPollSeconds, 5);
  assert.ok(p.message);
  assert.equal("prUrl" in p, false);
  assert.equal("error" in p, false);
  assert.equal("completedAt" in p, false);
  assert.equal("jiraTicketId" in p, false);
  assert.equal("jiraUrl" in p, false);
});

test("jobStatus-PR_OPEN-includes-pr-and-branch", () => {
  const p = buildJobStatus({
    jobId: "job-pr-002",
    status: "PR_OPEN",
    appName: "test-app",
    prNumber: 42,
    prUrl: "https://github.com/owner/repo/pull/42",
    branchName: "migrate/test-app-4.9.18-java17",
  });
  assert.equal(p.status, "PR_OPEN");
  assert.equal(p.nextPollSeconds, 0);
  assert.equal(p.prUrl, "https://github.com/owner/repo/pull/42");
  assert.equal(p.prNumber, 42);
  assert.equal(p.branchName, "migrate/test-app-4.9.18-java17");
  assert.equal("completedAt" in p, false);
});

test("jobStatus-DEPLOYED-includes-completedAt", () => {
  const p = buildJobStatus({
    jobId: "job-dep-003",
    status: "DEPLOYED",
    appName: "test-app",
    completedAt: "2025-06-01T12:00:00Z",
    prUrl: "https://github.com/owner/repo/pull/10",
    prNumber: 10,
  });
  assert.equal(p.status, "DEPLOYED");
  assert.equal(p.nextPollSeconds, 0);
  assert.equal(p.completedAt, "2025-06-01T12:00:00Z");
  assert.equal("error" in p, false);
});

test("jobStatus-FAILED_COMMIT-includes-error", () => {
  const p = buildJobStatus({
    jobId: "job-fail-004",
    status: "FAILED_COMMIT",
    appName: "test-app",
    error: "GitHub API returned 422: Reference already exists",
  });
  assert.equal(p.status, "FAILED_COMMIT");
  assert.equal(p.nextPollSeconds, 0);
  assert.match(p.error, /422/);
});

test("jobStatus-unknown-status-fallback", () => {
  const p = buildJobStatus({ jobId: "job-unk-005", status: "CUSTOM_STATE", appName: "test-app" });
  assert.equal(p.status, "CUSTOM_STATE");
  assert.equal(p.nextPollSeconds, 10);
  assert.ok(p.message);
});

test("jobStatus-with-jira-builds-url", () => {
  const p = buildJobStatus(
    {
      jobId: "job-jira-006",
      status: "PR_OPEN",
      appName: "test-app",
      jiraTicketId: "J1U-123",
      prUrl: "https://github.com/owner/repo/pull/9",
      prNumber: 9,
    },
    "https://acme.atlassian.net"
  );
  assert.equal(p.jiraTicketId, "J1U-123");
  assert.match(p.jiraUrl, /\/browse\/J1U-123$/);
});

test("jobStatus-PR_OPEN-munit-passed-substage", () => {
  const p = buildJobStatus({
    jobId: "job-mp-007",
    status: "PR_OPEN",
    appName: "test-app",
    prNumber: 12,
    prUrl: "https://github.com/owner/repo/pull/12",
    munit: { result: "passed", at: "2025-06-01T12:00:00Z" },
  });
  assert.equal(p.status, "PR_OPEN");
  assert.match(p.message, /MUnit tests passed/);
});

test("jobStatus-DEP_GUARD_FAILED-surfaces-report", () => {
  const p = buildJobStatus({
    jobId: "job-dg-008",
    status: "DEP_GUARD_FAILED",
    appName: "test-app",
    prUrl: "https://github.com/owner/repo/pull/8",
    error: "1 Java 17 dependency violation",
    depGuard: {
      at: "2025-06-01T12:00:00Z",
      report: [
        {
          groupId: "org.mule.connectors",
          artifactId: "mule-objectstore-connector",
          resolvedVersion: "1.2.0",
          requiredVersion: "1.2.2",
          reason: "below Java 17 minimum",
        },
      ],
    },
  });
  assert.equal(p.status, "DEP_GUARD_FAILED");
  assert.equal((p.report ?? []).length, 1);
  assert.equal(p.report[0].artifactId, "mule-objectstore-connector");
  assert.match(p.message, /dependency guard/);
});

// ── jobstore — create + single-flight lock ──────────────────────────────────────────────
test("jobstore-create-persists-PROCESSING-record", () => {
  const { jobId, record } = store.createJob({ appName: "app-a", environment: "dev" });
  assert.match(jobId, /^job-/);
  assert.equal(record.status, "PROCESSING");
  assert.equal(record.appName, "app-a");
  assert.equal(record.prUrl, null);
  assert.equal(record.branchName, null);
  assert.equal(record.completedAt, null);
  // re-read from disk
  const persisted = store.getJob(jobId);
  assert.equal(persisted.jobId, jobId);
  assert.equal(persisted.status, "PROCESSING");
  // lock is held by this job
  assert.equal(store.lockHolder("app-a"), jobId);
});

test("jobstore-second-create-same-app-conflicts", () => {
  const { jobId: first } = store.createJob({ appName: "app-b" });
  assert.throws(
    () => store.createJob({ appName: "app-b" }),
    (e) => e.code === "CONFLICT" && e.existingJobId === first
  );
});

test("jobstore-setStatus-merges-and-stamps-terminal-completedAt", () => {
  const { jobId } = store.createJob({ appName: "app-c" });
  const open = store.setStatus(jobId, "PR_OPEN", {
    prUrl: "https://x/pull/1",
    prNumber: 1,
    branchName: "migrate/app-c",
  });
  assert.equal(open.status, "PR_OPEN");
  assert.equal(open.prNumber, 1);
  assert.equal(open.completedAt, null); // non-terminal → no completedAt
  const done = store.setStatus(jobId, "DEPLOYED");
  assert.equal(done.status, "DEPLOYED");
  assert.ok(done.completedAt, "terminal status stamps completedAt");
});

test("jobstore-branch-index-and-idempotency", () => {
  const { jobId } = store.createJob({ appName: "app-d" });
  store.putBranchIndex("migrate/app-d-1", jobId);
  assert.equal(store.jobIdForBranch("migrate/app-d-1"), jobId);
  // idempotency: first mark wins, duplicate is skipped
  assert.equal(store.markOnce("cd-result::sha123"), true);
  assert.equal(store.markOnce("cd-result::sha123"), false);
  assert.equal(store.seen("cd-result::sha123"), true);
});

test("jobstore-delete-clears-index-and-releases-own-lock", () => {
  const { jobId } = store.createJob({ appName: "app-e" });
  store.setStatus(jobId, "PR_OPEN", { branchName: "migrate/app-e" });
  store.putBranchIndex("migrate/app-e", jobId);
  const res = store.deleteJob(jobId);
  assert.equal(res.deleted, true);
  assert.equal(res.branchCleared, true);
  assert.equal(res.lockReleased, true);
  assert.equal(store.getJob(jobId), null);
  assert.equal(store.lockHolder("app-e"), null);
  assert.equal(store.jobIdForBranch("migrate/app-e"), null);
});

test("jobstore-delete-does-not-steal-another-jobs-lock", () => {
  // job1 held the lock, then a reapply (job2) took over the app; deleting job1 must NOT release job2's lock.
  const { jobId: job1 } = store.createJob({ appName: "app-f" });
  store.releaseLock("app-f");
  const { jobId: job2 } = store.createJob({ appName: "app-f" });
  const res = store.deleteJob(job1);
  assert.equal(res.lockReleased, false);
  assert.equal(store.lockHolder("app-f"), job2);
});

test("jobstore-reapply-reseeds-new-job", () => {
  const { jobId: orig } = store.createJob({
    appName: "app-g",
    coords: { owner: "o", repo: "r" },
    jiraTicketId: "J-9",
  });
  store.setStatus(orig, "CLOSED");
  store.releaseLock("app-g"); // CLOSED released the app
  const { jobId: fresh, record } = store.reapplyJob(orig);
  assert.notEqual(fresh, orig);
  assert.equal(record.status, "PROCESSING");
  assert.equal(record.appName, "app-g");
  assert.deepEqual(record.coords, { owner: "o", repo: "r" });
  assert.equal(record.jiraTicketId, "J-9");
});

// ── reconcile ────────────────────────────────────────────────────────────────────────────
const STALE = "2020-01-01T00:00:00Z";
const NOW_MS = Date.parse("2020-01-02T00:00:00Z"); // 24h later → stale under any small threshold

test("reconcile-stale-PR_OPEN-merged-goes-DEPLOYING", () => {
  const { jobId } = store.createJob({ appName: "app-h", coords: { owner: "o", repo: "r" } });
  store.setStatus(jobId, "PR_OPEN", { prNumber: 5 });
  // force staleness
  store.patchJob(jobId, {});
  const rec = store.getJob(jobId);
  rec.updatedAt = STALE;
  store.putJob(rec);

  const notes = [];
  const res = runReconcile({
    staleSeconds: 900,
    nowMs: NOW_MS,
    pollPr: () => ({ merged: true, closed: false, open: false }),
    notify: (ev) => notes.push(ev),
  });
  assert.equal(res.fixed, 1);
  assert.equal(store.getJob(jobId).status, "DEPLOYING");
  assert.deepEqual(notes, ["PR_OPEN->DEPLOYING"]);
});

test("reconcile-stale-PR_OPEN-closed-goes-CLOSED-and-releases-lock", () => {
  const { jobId } = store.createJob({ appName: "app-i", coords: { owner: "o", repo: "r" } });
  store.setStatus(jobId, "PR_OPEN", { prNumber: 6 });
  const rec = store.getJob(jobId);
  rec.updatedAt = STALE;
  store.putJob(rec);

  const res = runReconcile({
    staleSeconds: 900,
    nowMs: NOW_MS,
    pollPr: () => ({ merged: false, closed: true, open: false }),
  });
  assert.equal(res.fixed, 1);
  assert.equal(store.getJob(jobId).status, "CLOSED");
  assert.equal(store.lockHolder("app-i"), null);
});

test("reconcile-stale-DEPLOYING-healthy-goes-DEPLOYED", () => {
  const { jobId } = store.createJob({ appName: "app-j" });
  store.setStatus(jobId, "DEPLOYING");
  const rec = store.getJob(jobId);
  rec.updatedAt = STALE;
  store.putJob(rec);

  const res = runReconcile({
    staleSeconds: 900,
    nowMs: NOW_MS,
    verifyDeploy: () => ({ status: "healthy" }),
  });
  assert.equal(res.fixed, 1);
  assert.equal(store.getJob(jobId).status, "DEPLOYED");
});

test("reconcile-stale-DEPLOYING-unhealthy-goes-FAILED_DEPLOY", () => {
  const { jobId } = store.createJob({ appName: "app-k" });
  store.setStatus(jobId, "DEPLOYING");
  const rec = store.getJob(jobId);
  rec.updatedAt = STALE;
  store.putJob(rec);

  const res = runReconcile({
    staleSeconds: 900,
    nowMs: NOW_MS,
    verifyDeploy: () => ({ status: "unhealthy" }),
  });
  assert.equal(res.fixed, 1);
  assert.equal(store.getJob(jobId).status, "FAILED_DEPLOY");
});

test("reconcile-stale-early-stage-goes-FAILED_INTERRUPTED-and-releases-lock", () => {
  const { jobId } = store.createJob({ appName: "app-l" }); // PROCESSING
  const rec = store.getJob(jobId);
  rec.updatedAt = STALE;
  store.putJob(rec);

  const res = runReconcile({ staleSeconds: 900, nowMs: NOW_MS });
  assert.equal(res.fixed, 1);
  assert.equal(store.getJob(jobId).status, "FAILED_INTERRUPTED");
  assert.equal(store.lockHolder("app-l"), null);
});

test("reconcile-fresh-job-untouched", () => {
  const { jobId } = store.createJob({ appName: "app-m" }); // fresh updatedAt (~now)
  const res = runReconcile({ staleSeconds: 900, nowMs: Date.parse(new Date().toISOString()) });
  assert.equal(res.fixed, 0);
  assert.equal(store.getJob(jobId).status, "PROCESSING");
});

test("reconcile-stale-PR_OPEN-still-open-not-fixed", () => {
  const { jobId } = store.createJob({ appName: "app-n", coords: { owner: "o", repo: "r" } });
  store.setStatus(jobId, "PR_OPEN", { prNumber: 7 });
  const rec = store.getJob(jobId);
  rec.updatedAt = STALE;
  store.putJob(rec);

  const res = runReconcile({
    staleSeconds: 900,
    nowMs: NOW_MS,
    pollPr: () => ({ merged: false, closed: false, open: true }),
  });
  assert.equal(res.fixed, 0);
  assert.equal(store.getJob(jobId).status, "PR_OPEN");
});

// ── reconcile — CI-checks polling (drives MUNIT_FAILED / DEP_GUARD_FAILED park/resume) ──────
const CI_PATTERNS = {
  test: ["munit", "unit test", "test"],
  "dependency-guard": ["dependency-guard", "dep-guard", "java17-guard", "dependency guard"],
};

test("classifyCheck-dependency-guard-wins-over-test-substring", () => {
  // "dependency-guard-test" contains "test" but must classify as dependency-guard (checked first).
  assert.equal(classifyCheck("dependency-guard-test", CI_PATTERNS), "dependency-guard");
  assert.equal(classifyCheck("MUnit / build", CI_PATTERNS), "test");
  assert.equal(classifyCheck("java17-guard", CI_PATTERNS), "dependency-guard");
  assert.equal(classifyCheck("lint", CI_PATTERNS), null);
});

test("reconcileCiChecks-test-failure-parks-MUNIT_FAILED", () => {
  const { jobId } = store.createJob({ appName: "app-o", coords: { owner: "o", repo: "r" } });
  store.setStatus(jobId, "PR_OPEN", { prNumber: 10 });
  const rec = store.getJob(jobId);
  const applied = reconcileCiChecks(rec, {
    pollChecks: () => [{ name: "MUnit tests", conclusion: "failure" }],
    ciPatterns: CI_PATTERNS,
  });
  assert.deepEqual(applied, [{ stage: "test", result: "failure", to: "MUNIT_FAILED" }]);
  assert.equal(store.getJob(jobId).status, "MUNIT_FAILED");
});

test("reconcileCiChecks-pending-checks-are-skipped", () => {
  const { jobId } = store.createJob({ appName: "app-p", coords: { owner: "o", repo: "r" } });
  store.setStatus(jobId, "PR_OPEN", { prNumber: 11 });
  const rec = store.getJob(jobId);
  const applied = reconcileCiChecks(rec, {
    pollChecks: () => [{ name: "MUnit tests", conclusion: "pending" }],
    ciPatterns: CI_PATTERNS,
  });
  assert.deepEqual(applied, []);
  assert.equal(store.getJob(jobId).status, "PR_OPEN");
});

test("reconcileCiChecks-dependency-guard-failure-wins-and-parks-first", () => {
  const { jobId } = store.createJob({ appName: "app-q", coords: { owner: "o", repo: "r" } });
  store.setStatus(jobId, "PR_OPEN", { prNumber: 12 });
  const rec = store.getJob(jobId);
  // Both fail: dependency-guard is ingested first, and DEPGUARD_NOOP then makes the test-failure a no-op.
  const applied = reconcileCiChecks(rec, {
    pollChecks: () => [
      { name: "MUnit tests", conclusion: "failure" },
      { name: "java17-guard", conclusion: "failure" },
    ],
    ciPatterns: CI_PATTERNS,
  });
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0], { stage: "dependency-guard", result: "failure", to: "DEP_GUARD_FAILED" });
  assert.equal(store.getJob(jobId).status, "DEP_GUARD_FAILED");
});

test("reconcileCiChecks-failure-beats-success-for-same-stage", () => {
  const { jobId } = store.createJob({ appName: "app-r", coords: { owner: "o", repo: "r" } });
  store.setStatus(jobId, "PR_OPEN", { prNumber: 13 });
  const rec = store.getJob(jobId);
  // Two test-stage checks disagree; failure must win (fail-closed).
  const applied = reconcileCiChecks(rec, {
    pollChecks: () => [
      { name: "unit test (jdk8)", conclusion: "success" },
      { name: "unit test (jdk17)", conclusion: "failure" },
    ],
    ciPatterns: CI_PATTERNS,
  });
  assert.deepEqual(applied, [{ stage: "test", result: "failure", to: "MUNIT_FAILED" }]);
  assert.equal(store.getJob(jobId).status, "MUNIT_FAILED");
});

test("runReconcile-stale-MUNIT_FAILED-resumes-to-PR_OPEN-on-test-success", () => {
  const { jobId } = store.createJob({ appName: "app-s", coords: { owner: "o", repo: "r" } });
  store.setStatus(jobId, "MUNIT_FAILED", { prNumber: 14, error: "boom" });
  const rec = store.getJob(jobId);
  rec.updatedAt = STALE;
  store.putJob(rec);

  const res = runReconcile({
    staleSeconds: 900,
    nowMs: NOW_MS,
    pollChecks: () => [{ name: "MUnit tests", conclusion: "success" }],
    ciPatterns: CI_PATTERNS,
  });
  assert.equal(res.fixed, 1);
  assert.equal(store.getJob(jobId).status, "PR_OPEN");
  assert.equal(res.actions[0].reason, "ci:test=success");
});

test("runReconcile-stale-PR_OPEN-parks-on-CI-failure-and-skips-PR-poll", () => {
  const { jobId } = store.createJob({ appName: "app-t", coords: { owner: "o", repo: "r" } });
  store.setStatus(jobId, "PR_OPEN", { prNumber: 15 });
  const rec = store.getJob(jobId);
  rec.updatedAt = STALE;
  store.putJob(rec);

  let prPolled = false;
  const res = runReconcile({
    staleSeconds: 900,
    nowMs: NOW_MS,
    pollChecks: () => [{ name: "MUnit tests", conclusion: "failure" }],
    ciPatterns: CI_PATTERNS,
    pollPr: () => {
      prPolled = true;
      return { merged: true, closed: false, open: false };
    },
  });
  assert.equal(res.fixed, 1);
  assert.equal(store.getJob(jobId).status, "MUNIT_FAILED");
  assert.equal(prPolled, false, "PR merge poll must be skipped once parked by CI this sweep");
});

test("runReconcile-stale-PR_OPEN-passing-CI-then-merges", () => {
  const { jobId } = store.createJob({ appName: "app-u", coords: { owner: "o", repo: "r" } });
  store.setStatus(jobId, "PR_OPEN", { prNumber: 16 });
  const rec = store.getJob(jobId);
  rec.updatedAt = STALE;
  store.putJob(rec);

  const res = runReconcile({
    staleSeconds: 900,
    nowMs: NOW_MS,
    pollChecks: () => [{ name: "MUnit tests", conclusion: "success" }], // passing → no park
    ciPatterns: CI_PATTERNS,
    pollPr: () => ({ merged: true, closed: false, open: false }),
  });
  assert.equal(store.getJob(jobId).status, "DEPLOYING");
  // munit sub-stage recorded, then PR merge advanced it.
  assert.equal(store.getJob(jobId).munit?.result, "passed");
});

test("runReconcile-ciChecks-false-disables-polling", () => {
  const { jobId } = store.createJob({ appName: "app-v", coords: { owner: "o", repo: "r" } });
  store.setStatus(jobId, "MUNIT_FAILED", { prNumber: 17 });
  const rec = store.getJob(jobId);
  rec.updatedAt = STALE;
  store.putJob(rec);

  let checksPolled = false;
  const res = runReconcile({
    staleSeconds: 900,
    nowMs: NOW_MS,
    ciChecks: false,
    pollChecks: () => {
      checksPolled = true;
      return [{ name: "MUnit tests", conclusion: "success" }];
    },
  });
  assert.equal(checksPolled, false);
  assert.equal(store.getJob(jobId).status, "MUNIT_FAILED"); // untouched
});
