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
  const commit = async (a) => {
    // assert the commit args carry the assessed headSha + staged files
    assert.equal(a.changePlan.headSha, "HEAD1");
    assert.equal(a.stagedFiles[0].path, "pom.xml");
    return {
      branchName: "migrate/app-h-4.9.18-java17",
      commitSha: "c1",
      prNumber: 7,
      prUrl: "https://x/pull/7",
    };
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

test("orchestrate-dryRun-returns-PLAN_PREVIEW-and-writes-nothing", async () => {
  // The interactive agent's CONFIRM gate: preview the plan without side effects. apply/commit are
  // injected to THROW — if the pipeline reaches them, the test fails loudly rather than silently.
  const res = await runUpgrade({
    appName: "app-dry",
    environment: "dev",
    mode: "api",
    coords: { owner: "o", repo: "r", defaultBranch: "main" },
    headSha: "HEAD1",
    dryRun: true,
    deps: {
      ...notifyStubs,
      assess: assessOk({
        changePlan: CHANGE_PLAN,
        currentRuntime: "4.6.0",
        currentJavaVersion: "11",
        connectorChoices: [{ artifactId: "mule-http-connector", matrixSet: "1.10.3" }],
        warnings: ["custom Java detected"],
      }),
      applyChangePlan: () => {
        throw new Error("dry run must NOT apply edits");
      },
      commitApi: async () => {
        throw new Error("dry run must NOT commit / open a PR");
      },
    },
  });
  assert.equal(res.status, "PLAN_PREVIEW");
  assert.equal(res.dryRun, true);
  assert.equal(res.targetRuntime, "4.9.18");
  assert.equal(res.targetJavaVersion, "17");
  assert.equal(res.fileEdits.length, 1);
  assert.deepEqual(res.connectorChoices, [{ artifactId: "mule-http-connector", matrixSet: "1.10.3" }]);
  assert.deepEqual(res.warnings, ["custom Java detected"]);
  assert.equal(res.jobId, undefined); // no job id issued
  // nothing was written: no lock, no job record
  assert.equal(store.lockHolder("app-dry"), null);
  assert.deepEqual(store.listJobs(), []);

  // a second dry run is likewise clean — dry runs never take the single-flight lock
  const again = await runUpgrade({
    appName: "app-dry",
    environment: "dev",
    coords: { owner: "o", repo: "r", defaultBranch: "main" },
    headSha: "HEAD1",
    dryRun: true,
    deps: { ...notifyStubs, assess: assessOk({ changePlan: CHANGE_PLAN, warnings: [] }) },
  });
  assert.equal(again.status, "PLAN_PREVIEW");
  assert.equal(store.lockHolder("app-dry"), null);
});

test("orchestrate-dryRun-on-already-upgraded-still-reports-ALREADY_UPGRADED", async () => {
  const res = await runUpgrade({
    appName: "app-dry-noop",
    environment: "dev",
    coords: { owner: "o", repo: "r", defaultBranch: "main" },
    dryRun: true,
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
  assert.equal(store.lockHolder("app-dry-noop"), null);
  assert.deepEqual(store.listJobs(), []);
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

// ── Tier 2c: topology routing (app-pom vs parent-pom vs none) ───────────────────────────────────
const GAP_ONLY_PLAN = {
  targetRuntime: "4.9.18",
  targetJavaVersion: "17",
  topology: "BOM_PARENT_APP",
  headSha: "HEAD1",
  fileEdits: [], // the app pom itself is clean...
  connectorGaps: [{ artifactId: "mule-http-connector", from: "1.7.0", to: "1.11.3" }], // ...but inherits a stale connector
};

test("orchestrate-routes-inherited-connector-gap-to-parent-pom-job", async () => {
  // No app-pom edits + an inherited connector gap → the orchestrator must NOT say ALREADY_UPGRADED;
  // it dispatches the parent-pom job. We inject runParentPomJob to observe the hand-off.
  let calledWith = null;
  const res = await runUpgrade({
    appName: "app-inherits",
    environment: "dev",
    jiraTicketId: "J-9",
    mode: "api",
    coords: { owner: "acme", repo: "mule-apps", defaultBranch: "develop" },
    deps: {
      ...notifyStubs,
      assess: assessOk({ changePlan: GAP_ONLY_PLAN, warnings: ["inherited gap"] }),
      // if the app pipeline were (wrongly) entered these would fire — make them throw to catch it
      applyChangePlan: () => {
        throw new Error("app pipeline must not run for a parent-pom route");
      },
      runParentPomJob: async (opts) => {
        calledWith = opts;
        return {
          status: "PR_OPEN",
          kind: "parentPomUpgrade",
          jobId: "parentpom-1",
          appName: "mule-apps",
          prUrl: "https://github.com/acme/mule-apps/pull/3",
          edits: [{ kind: "pomProperty", artifactId: "mule-http-connector" }],
          warnings: ["parent bumped"],
        };
      },
    },
  });
  assert.equal(res.status, "PR_OPEN");
  assert.equal(res.routedVia, "parent-pom");
  assert.equal(res.topology, "BOM_PARENT_APP");
  assert.equal(res.prUrl, "https://github.com/acme/mule-apps/pull/3");
  assert.match(res.routeReason, /parent\/BOM must be bumped/);
  // orchestrator forwarded the repo coords + jira to the parent-pom job
  assert.equal(calledWith.owner, "acme");
  assert.equal(calledWith.repo, "mule-apps");
  assert.equal(calledWith.branch, "develop");
  assert.equal(calledWith.jiraTicketId, "J-9");
  // warnings from both the assess and the parent-pom job are merged
  assert.ok(res.warnings.includes("inherited gap") && res.warnings.includes("parent bumped"));
});

test("orchestrate-parent-pom-route-can-be-forced-off-to-app-pipeline", async () => {
  // routeParentPom:false forces the plain app pipeline; with no app edits that no-ops to ALREADY_UPGRADED.
  const res = await runUpgrade({
    appName: "app-forced",
    environment: "dev",
    coords: { owner: "acme", repo: "mule-apps", defaultBranch: "main" },
    routeParentPom: false,
    deps: {
      ...notifyStubs,
      assess: assessOk({ changePlan: GAP_ONLY_PLAN, currentRuntime: "4.6.0", currentJavaVersion: "11", warnings: [] }),
      runParentPomJob: async () => {
        throw new Error("parent-pom job must not run when routeParentPom:false");
      },
    },
  });
  assert.equal(res.status, "ALREADY_UPGRADED");
  assert.equal(res.topology, "BOM_PARENT_APP");
});

test("orchestrate-dryRun-surfaces-the-parent-pom-route-without-dispatching", async () => {
  const res = await runUpgrade({
    appName: "app-preview",
    environment: "dev",
    dryRun: true,
    coords: { owner: "acme", repo: "mule-apps", defaultBranch: "main" },
    deps: {
      ...notifyStubs,
      assess: assessOk({ changePlan: GAP_ONLY_PLAN, warnings: [] }),
      runParentPomJob: async () => {
        throw new Error("dryRun must not dispatch the parent-pom job");
      },
    },
  });
  assert.equal(res.status, "PLAN_PREVIEW");
  assert.equal(res.route.strategy, "parent-pom");
  assert.match(res.message, /route=parent-pom/);
});

// ── source/coords forwarding to the pre-flight assess() (regression: API-mode assess) ────────────
// In API mode there is NO local clone (opts.repo is undefined), so runUpgrade MUST tell assess() to
// read over GitHub by forwarding source:"github" + owner/repoName/branch from coords. Without this,
// assess()'s resolveSource() defaults to "local" and throws "local source requires --repo <clone-dir>".
// This spies the injected assess to lock the exact arguments the orchestrator passes it.
function assessSpy(seen, result) {
  return async (a) => {
    seen.args = a;
    return { result };
  };
}
const NOOP_RESULT = {
  changePlan: { targetRuntime: "4.9.18", targetJavaVersion: "17", fileEdits: [], connectorGaps: [] },
  currentRuntime: "4.9.18",
  currentJavaVersion: "17",
  warnings: [],
};

test("orchestrate-api-mode-forwards-github-source-and-coords-to-assess", async () => {
  const seen = {};
  const res = await runUpgrade({
    appName: "app-api-src",
    environment: "dev",
    mode: "api", // no --repo clone in API mode
    coords: { owner: "avatansh", repo: "lead-to-contacts-demo-api", defaultBranch: "main" },
    deps: { ...notifyStubs, assess: assessSpy(seen, NOOP_RESULT) },
  });
  // The exact wiring the Vibes run was missing:
  assert.equal(seen.args.source, "github");
  assert.equal(seen.args.owner, "avatansh");
  assert.equal(seen.args.repoName, "lead-to-contacts-demo-api");
  assert.equal(seen.args.branch, "main");
  // sanity: pipeline still resolves normally (empty plan → ALREADY_UPGRADED, no side effects)
  assert.equal(res.status, "ALREADY_UPGRADED");
  assert.equal(store.lockHolder("app-api-src"), null);
});

test("orchestrate-local-mode-does-NOT-force-github-source", async () => {
  const seen = {};
  await runUpgrade({
    appName: "app-local-src",
    environment: "dev",
    mode: "local",
    repo: "/tmp/clone", // local clone drives assess
    coords: { owner: "o", repo: "r", defaultBranch: "main" },
    deps: { ...notifyStubs, assess: assessSpy(seen, NOOP_RESULT) },
  });
  // local mode must leave source unset so assess reads the clone at opts.repo (never GitHub)
  assert.equal(seen.args.source, undefined);
  assert.equal(seen.args.repo, "/tmp/clone");
});

test("orchestrate-assessOpts-still-flow-through-and-win-over-source-defaults", async () => {
  const seen = {};
  await runUpgrade({
    appName: "app-assessopts",
    environment: "dev",
    mode: "api",
    coords: { owner: "acme", repo: "orders-api", defaultBranch: "develop" },
    // assessOpts is spread LAST, so a caller can still override (here: pin a version strategy and
    // even repoUrl) without the API-mode defaults clobbering it.
    assessOpts: { versionStrategy: "min", repoUrl: "https://github.com/acme/orders-api/tree/develop/svc" },
    deps: { ...notifyStubs, assess: assessSpy(seen, NOOP_RESULT) },
  });
  assert.equal(seen.args.source, "github"); // still github mode
  assert.equal(seen.args.versionStrategy, "min"); // forwarded
  assert.equal(seen.args.repoUrl, "https://github.com/acme/orders-api/tree/develop/svc"); // override wins
});

test("orchestrate-api-mode-reads-files-over-github-for-apply (regression: FAILED_COMMIT path undefined)", async () => {
  // API mode has NO local clone (repoRoot is undefined). Before the fix, orchestrate called
  // applyChangePlan(changePlan, undefined) with no reader, so the default fs reader ran
  // path.join(undefined, "pom.xml") → 'The "path" argument must be of type string. Received undefined'
  // → FAILED_COMMIT. Now the orchestrator must build a GitHub Contents reader (deps.gh here) and the
  // real applyChangePlan must edit the fetched text. We do NOT inject applyChangePlan, so the REAL
  // apply + reader run — that is exactly the path that was broken.
  const reads = [];
  const fakeGh = {
    getContents: async (owner, repo, p, ref) => {
      reads.push({ owner, repo, p, ref });
      // GitHub Contents API returns base64-encoded file text
      return {
        content: Buffer.from(
          "<project><properties><app.runtime>4.5.1</app.runtime></properties></project>"
        ).toString("base64"),
        encoding: "base64",
      };
    },
  };
  let staged = null;
  const res = await runUpgrade({
    appName: "app-api-apply",
    environment: "dev",
    mode: "api",
    coords: { owner: "avatansh", repo: "lead-to-contacts-demo-api", defaultBranch: "main" },
    headSha: "HEAD1",
    deps: {
      ...notifyStubs,
      assess: assessOk({ changePlan: CHANGE_PLAN, warnings: [] }),
      gh: fakeGh, // <- the api reader uses this instead of constructing GitHubApi (which needs a token)
      commitApi: async (a) => {
        staged = a.stagedFiles;
        return { branchName: "b", commitSha: "c1", prNumber: 9, prUrl: "https://x/pull/9" };
      },
      // applyChangePlan intentionally NOT injected → the real apply + gh reader are exercised.
    },
  });
  assert.equal(res.status, "PR_OPEN");
  // the file was read over GitHub (not off a nonexistent clone), at the assessed ref
  assert.equal(reads.length, 1);
  assert.equal(reads[0].p, "pom.xml");
  assert.equal(reads[0].ref, "HEAD1");
  // and the edit was actually applied to the fetched text before commit
  assert.equal(staged.length, 1);
  assert.equal(staged[0].path, "pom.xml");
  assert.match(staged[0].content, /<app\.runtime>4\.9\.18<\/app\.runtime>/);
});

test("orchestrate-truly-clean-app-still-ALREADY_UPGRADED", async () => {
  // No edits AND no gaps → genuinely nothing to do (the router's "none").
  const res = await runUpgrade({
    appName: "app-clean",
    environment: "dev",
    coords: { owner: "o", repo: "r", defaultBranch: "main" },
    deps: {
      ...notifyStubs,
      assess: assessOk({
        changePlan: { targetRuntime: "4.9.18", targetJavaVersion: "17", topology: "APP_STANDALONE", fileEdits: [], connectorGaps: [] },
        currentRuntime: "4.9.18",
        currentJavaVersion: "17",
        warnings: [],
      }),
    },
  });
  assert.equal(res.status, "ALREADY_UPGRADED");
  assert.equal(store.lockHolder("app-clean"), null);
  assert.deepEqual(store.listJobs(), []);
});
