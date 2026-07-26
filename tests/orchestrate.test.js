// tests/orchestrate.test.js — SKILL 6 (mule-upgrade orchestrator) pipeline tests.
//   Ported from proc-start-upgrade-suite.xml expectations:
//     · ALREADY_UPGRADED short-circuit (no fileEdits → no job, no lock).
//     · happy path: PROCESSING → COMMITTING → COMMITTED → PR_OPEN, job persisted, branch indexed.
//     · CONFLICT when the app lock is already held.
//     · failure taxonomy: apply/commit throw → FAILED_COMMIT + lock released; STALE_PLAN → FAILED_ASSESS.
//   All external steps (assess, apply, commit, notify) are injected — zero network / git.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runUpgrade } from "../skills/mule-upgrade/scripts/orchestrate.js";

let tmpHome;
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mule-orch-"));
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

// silent, always-skipped notifiers so nothing hits the network
const notifyStubs = {
  slackNotify: async () => ({ sent: false, skipped: "test" }),
  jiraComment: async () => ({ sent: false, skipped: "test" }),
  jiraCreateIssue: async () => ({ created: false, skipped: "test" }),
};

const CHANGE_PLAN = {
  targetRuntime: "4.9.18",
  targetJavaVersion: "17",
  headSha: "HEAD1",
  fileEdits: [{ file: "pom.xml", kind: "pomProperty", property: "app.runtime", to: "4.9.18" }],
};

function assessOk(result) {
  return async () => ({ result });
}

test("orchestrate-ALREADY_UPGRADED-short-circuits-with-no-job", async () => {
  const res = await runUpgrade({
    appName: "app-noop",
    environment: "dev",
    coords: { owner: "o", repo: "r", defaultBranch: "main" },
    deps: {
      ...notifyStubs,
      assess: assessOk({
        changePlan: { targetRuntime: "4.9.18", targetJavaVersion: "17", fileEdits: [] },
        currentRuntime: "4.9.18",
        currentJavaVersion: "17",
        warnings: [],
      }),
    },
  });
  assert.equal(res.status, "ALREADY_UPGRADED");
  assert.equal(store.lockHolder("app-noop"), null); // no lock acquired
  assert.deepEqual(store.listJobs(), []); // no job created
});

test("orchestrate-happy-path-drives-to-PR_OPEN", async () => {
  const setStates = [];
  const commit = async (a) => {
    // assert the commit args carry the assessed headSha + staged files
    assert.equal(a.changePlan.headSha, "HEAD1");
    assert.equal(a.stagedFiles[0].path, "pom.xml");
    return { branchName: "migrate/app-h-4.9.18-java17", commitSha: "c1", prNumber: 7, prUrl: "https://x/pull/7" };
  };
  const res = await runUpgrade({
    appName: "app-happy",
    environment: "dev",
    jiraTicketId: "J-1",
    mode: "api",
    coords: { owner: "o", repo: "r", defaultBranch: "main" },
    headSha: "HEAD1",
    deps: {
      ...notifyStubs,
      assess: assessOk({ changePlan: CHANGE_PLAN, warnings: ["custom Java detected"] }),
      applyChangePlan: () => [{ path: "pom.xml", content: "<project/>" }],
      commitApi: commit,
    },
  });
  assert.equal(res.status, "PR_OPEN");
  assert.equal(res.prNumber, 7);
  assert.equal(res.branchName, "migrate/app-h-4.9.18-java17");
  assert.equal(res.nextPollSeconds, 0);

  const job = store.getJob(res.jobId);
  assert.equal(job.status, "PR_OPEN");
  assert.equal(job.prUrl, "https://x/pull/7");
  assert.equal(job.commitSha, "c1");
  // branch index recorded for reconcile correlation
  assert.equal(store.jobIdForBranch("migrate/app-h-4.9.18-java17"), res.jobId);
  // lock still held while PR is open
  assert.equal(store.lockHolder("app-happy"), res.jobId);
});

test("orchestrate-second-run-same-app-returns-CONFLICT", async () => {
  const first = await runUpgrade({
    appName: "app-conf",
    environment: "dev",
    coords: { owner: "o", repo: "r", defaultBranch: "main" },
    headSha: "HEAD1",
    deps: {
      ...notifyStubs,
      assess: assessOk({ changePlan: CHANGE_PLAN, warnings: [] }),
      applyChangePlan: () => [{ path: "pom.xml", content: "<project/>" }],
      commitApi: async () => ({ branchName: "b", commitSha: "c", prNumber: 1, prUrl: "u" }),
    },
  });
  assert.equal(first.status, "PR_OPEN");

  const second = await runUpgrade({
    appName: "app-conf",
    environment: "dev",
    coords: { owner: "o", repo: "r", defaultBranch: "main" },
    deps: {
      ...notifyStubs,
      assess: assessOk({ changePlan: CHANGE_PLAN, warnings: [] }),
    },
  });
  assert.equal(second.status, "CONFLICT");
  assert.equal(second.existingJobId, first.jobId);
  assert.equal(second.prUrl, "u");
});

test("orchestrate-commit-throws-goes-FAILED_COMMIT-and-releases-lock", async () => {
  const res = await runUpgrade({
    appName: "app-fail",
    environment: "dev",
    coords: { owner: "o", repo: "r", defaultBranch: "main" },
    headSha: "HEAD1",
    deps: {
      ...notifyStubs,
      assess: assessOk({ changePlan: CHANGE_PLAN, warnings: [] }),
      applyChangePlan: () => [{ path: "pom.xml", content: "<project/>" }],
      commitApi: async () => {
        throw new Error("GitHub 500");
      },
    },
  });
  assert.equal(res.status, "FAILED_COMMIT");
  assert.equal(store.getJob(res.jobId).status, "FAILED_COMMIT");
  assert.equal(store.lockHolder("app-fail"), null); // lock released on failure
});

test("orchestrate-stale-plan-maps-to-FAILED_ASSESS", async () => {
  const res = await runUpgrade({
    appName: "app-stale",
    environment: "dev",
    coords: { owner: "o", repo: "r", defaultBranch: "main" },
    headSha: "HEAD1",
    deps: {
      ...notifyStubs,
      assess: assessOk({ changePlan: CHANGE_PLAN, warnings: [] }),
      applyChangePlan: () => [{ path: "pom.xml", content: "<project/>" }],
      commitApi: async () => {
        const e = new Error("HEAD moved");
        e.code = "STALE_PLAN";
        throw e;
      },
    },
  });
  assert.equal(res.status, "FAILED_ASSESS");
  assert.equal(store.lockHolder("app-stale"), null);
});
