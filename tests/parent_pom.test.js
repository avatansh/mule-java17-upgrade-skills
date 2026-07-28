// tests/parent_pom.test.js — SKILL 4 (mule-upgrade-parent-pom).
//   Ported from proc-parent-pom-suite.xml:
//     · parentpom-no-edits            → NO_CHANGE, upgraded:false, jiraUrl built.
//     · parentpom-with-edits-opens-pr → pins managed http.connector.version → PR_OPEN, edits>0, prUrl.
//     · parentpom-repourl-tree-parsing→ /tree/develop/bom → branch=develop, pomPath=bom/pom.xml, appName=repo.
//   Plus repo_url unit tests for the parsing edge cases the DWL fix addressed.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveRepoCoords, resolvePomPath } from "../skills/mule-upgrade-parent-pom/scripts/lib/repo_url.js";
import {
  upgradeParentPom,
  runParentPomJob,
  updateOpenPrParentRef,
  deriveAppPomPath,
} from "../skills/mule-upgrade-parent-pom/scripts/parent_pom.js";
import { commitToExistingBranchApi } from "../skills/mule-upgrade-pr/scripts/commit_pr.js";

// jobstore reads MULE_UPGRADE_HOME at call time, so a static import is fine; each Tier-2b test runs
// inside a fresh temp home so the real ~/.mule-upgrade is never touched.
const store = await import("../skills/mule-upgrade-job/scripts/jobstore.js");

// matrix stub: one managed connector (http) whose Java-17 set version is 1.9.0.
const MATRIX = {
  target: { runtime: "4.9.18", javaVersion: "17" },
  gating: {},
  connectors: [
    {
      groupId: "org.mule.connectors",
      artifactId: "mule-http-connector",
      property: "http.connector.version",
      set: "1.9.0",
    },
  ],
};
const resolveMatrixStub = async () => ({ matrix: MATRIX, source: "bundled", warnings: [] });

function pomB64(xml) {
  return Buffer.from(xml, "utf-8").toString("base64");
}

// ── repo_url units ────────────────────────────────────────────────────────────────────────
test("repo_url: plain https url → owner/repo, no branch/pomPath", () => {
  const c = resolveRepoCoords({ repoUrl: "https://github.com/o/r.git" });
  assert.equal(c.owner, "o");
  assert.equal(c.repo, "r");
  assert.equal(c.urlBranch, null);
  assert.equal(c.urlPomPath, null);
  assert.equal(resolvePomPath(null, c), "pom.xml");
});

test("repo_url: /tree/<branch>/<dir> keeps branch + sub-path dir → dir/pom.xml", () => {
  const c = resolveRepoCoords({ repoUrl: "https://github.com/avatansh/mule-apps/tree/develop/bom" });
  assert.equal(c.owner, "avatansh");
  assert.equal(c.repo, "mule-apps");
  assert.equal(c.urlBranch, "develop");
  assert.equal(c.urlPomPath, "bom/pom.xml");
  assert.equal(resolvePomPath(null, c), "bom/pom.xml");
});

test("repo_url: /blob/<branch>/<file.xml> keeps the file as pomPath", () => {
  const c = resolveRepoCoords({ repoUrl: "https://github.com/o/r/blob/main/nested/custom-pom.xml" });
  assert.equal(c.urlBranch, "main");
  assert.equal(c.urlPomPath, "nested/custom-pom.xml");
});

test("repo_url: explicit owner/repo override only owner/repo, URL branch/path still parsed", () => {
  const c = resolveRepoCoords({
    repoUrl: "https://github.com/urlOwner/urlRepo/tree/develop/bom",
    owner: "realOwner",
    repo: "realRepo",
  });
  assert.equal(c.owner, "realOwner");
  assert.equal(c.repo, "realRepo");
  assert.equal(c.urlBranch, "develop"); // NOT discarded
  assert.equal(c.urlPomPath, "bom/pom.xml");
});

test("repo_url: explicit pomPath wins over URL sub-path", () => {
  const c = resolveRepoCoords({ repoUrl: "https://github.com/o/r/tree/main/bom" });
  assert.equal(resolvePomPath("other/pom.xml", c), "other/pom.xml");
});

// ── orchestration: NO_CHANGE ────────────────────────────────────────────────────────────────
test("parentpom-no-edits → NO_CHANGE with jiraUrl built", async () => {
  const readPom = async () => ({
    pomText:
      "<project><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging></project>",
    headSha: "PSHA",
  });
  const res = await upgradeParentPom({
    owner: "po",
    repo: "pr",
    branch: "main",
    jiraTicketId: "J1U-9",
    jiraBaseUrl: "https://jira.example.com",
    mode: "api",
    deps: { resolveMatrix: resolveMatrixStub, readPom },
  });
  assert.equal(res.status, "NO_CHANGE");
  assert.equal(res.upgraded, false);
  assert.equal(res.edits.length, 0);
  assert.ok(res.jobId);
  assert.ok(res.jiraUrl.endsWith("/browse/J1U-9"));
  assert.equal(res.appName, "pr");
});

// ── orchestration: edits → PR_OPEN ──────────────────────────────────────────────────────────
test("parentpom-with-edits-opens-pr → pins managed connector, PR_OPEN, prUrl", async () => {
  const managedPom =
    "<project><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging>" +
    "<properties><http.connector.version>1.7.0</http.connector.version></properties></project>";
  const readPom = async () => ({ pomText: managedPom, headSha: "PSHA" });
  let committed = null;
  const commitApi = async (a) => {
    committed = a;
    return {
      branchName: "migrate/pr-4.9.18-java17",
      commitSha: "commit1",
      prNumber: 12,
      prUrl: "https://github.com/po/pr/pull/12",
    };
  };
  const res = await upgradeParentPom({
    owner: "po",
    repo: "pr",
    branch: "main",
    mode: "api",
    deps: { resolveMatrix: resolveMatrixStub, readPom, commitApi },
  });
  assert.equal(res.status, "PR_OPEN");
  assert.equal(res.upgraded, true);
  assert.ok(res.edits.length > 0);
  assert.equal(res.prUrl, "https://github.com/po/pr/pull/12");
  assert.ok(res.jobId);
  // staged the single rewritten pom with the pinned connector + bumped parent version
  assert.equal(committed.stagedFiles.length, 1);
  assert.equal(committed.stagedFiles[0].path, "pom.xml");
  assert.match(
    committed.stagedFiles[0].content,
    /<http\.connector\.version>1\.9\.0<\/http\.connector\.version>/
  );
  assert.equal(committed.changePlan.headSha, "PSHA");
});

// ── orchestration: tree-URL parsing drives the read ───────────────────────────────────────────
test("parentpom-repourl-tree-parsing → reads bom/pom.xml @ develop, appName=repo", async () => {
  const seen = [];
  const readPom = async ({ coords, pomPath, defaultBranch }) => {
    seen.push({ owner: coords.owner, repo: coords.repo, pomPath, defaultBranch });
    return {
      pomText:
        "<project><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging></project>",
      headSha: "PSHA",
    };
  };
  const res = await upgradeParentPom({
    repoUrl: "https://github.com/avatansh/mule-apps/tree/develop/bom",
    mode: "api",
    deps: { resolveMatrix: resolveMatrixStub, readPom },
  });
  assert.equal(res.pomPath, "bom/pom.xml");
  assert.equal(res.appName, "mule-apps");
  assert.equal(res.coords.defaultBranch, "develop");
  assert.deepEqual(seen[0], {
    owner: "avatansh",
    repo: "mule-apps",
    pomPath: "bom/pom.xml",
    defaultBranch: "develop",
  });
});

// ── validation: unresolved coords ─────────────────────────────────────────────────────────────
test("parentpom: unresolved owner/repo raises VALIDATION", async () => {
  await assert.rejects(
    () => upgradeParentPom({ repoUrl: "not-a-url", mode: "api", deps: { resolveMatrix: resolveMatrixStub } }),
    (e) => e.code === "VALIDATION"
  );
});

// ── api mode: reads pom via injected GitHubApi (Contents API base64 decode) ──────────────────
test("parentpom api mode: decodes Contents API base64 + uses headSha", async () => {
  const xml =
    "<project><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging></project>";
  const fakeApi = {
    headSha: async () => "APIHEAD",
    getContents: async () => ({ content: pomB64(xml), encoding: "base64" }),
  };
  const res = await upgradeParentPom({
    owner: "po",
    repo: "pr",
    branch: "main",
    mode: "api",
    deps: { resolveMatrix: resolveMatrixStub, api: fakeApi },
  });
  assert.equal(res.status, "NO_CHANGE"); // no managed connectors in this pom
  assert.equal(res.appName, "pr");
});

// ── commit-onto-existing-branch (amend an already-open PR) ────────────────────────────────────
test("commitToExistingBranchApi: blob → tree(base=head) → commit(parent=head) → move ref", async () => {
  const calls = [];
  const fakeApi = {
    headSha: async (o, r, ref) => {
      calls.push(["headSha", o, r, ref]);
      return "HEAD_ON_BRANCH";
    },
    createBlob: async (o, r, content) => {
      calls.push(["createBlob", content]);
      return "BLOB1";
    },
    createTree: async (o, r, baseTree, entries) => {
      calls.push(["createTree", baseTree, entries.map((e) => e.path).join(",")]);
      return "TREE1";
    },
    createCommit: async (o, r, msg, tree, parents) => {
      calls.push(["createCommit", tree, parents.join(",")]);
      return "COMMIT1";
    },
    updateRef: async (o, r, branch, sha) => {
      calls.push(["updateRef", branch, sha]);
      return {};
    },
  };
  const res = await commitToExistingBranchApi({
    coords: { owner: "o", repo: "r" },
    branchName: "migrate/app-x",
    stagedFiles: [{ path: "pom.xml", content: "<x/>" }],
    message: "amend",
    api: fakeApi,
  });
  assert.deepEqual(res, { branchName: "migrate/app-x", commitSha: "COMMIT1", headBefore: "HEAD_ON_BRANCH" });
  // base_tree AND commit parent are the branch head (not the repo default) → one commit ON the branch
  assert.ok(calls.some((c) => c[0] === "createTree" && c[1] === "HEAD_ON_BRANCH"));
  assert.ok(calls.some((c) => c[0] === "createCommit" && c[2] === "HEAD_ON_BRANCH"));
  assert.ok(calls.some((c) => c[0] === "updateRef" && c[1] === "migrate/app-x" && c[2] === "COMMIT1"));
});

test("commitToExistingBranchApi: stale branch (expectHeadSha mismatch) → STALE_PLAN", async () => {
  const fakeApi = { headSha: async () => "MOVED" };
  await assert.rejects(
    () =>
      commitToExistingBranchApi({
        coords: { owner: "o", repo: "r" },
        branchName: "b",
        stagedFiles: [{ path: "p", content: "c" }],
        message: "m",
        api: fakeApi,
        expectHeadSha: "ORIGINAL",
      }),
    (e) => e.code === "STALE_PLAN"
  );
});

// ── Tier 2b: runParentPomJob — the job/lock/assess pipeline ─────────────────────────────────────
// These run against the REAL jobstore inside a fresh temp MULE_UPGRADE_HOME so the lock/job/branch
// index behaviour is exercised end-to-end (not a stub).
const NO_EDITS_POM =
  "<project><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging></project>";
const MANAGED_POM =
  "<project><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging>" +
  "<properties><http.connector.version>1.7.0</http.connector.version></properties></project>";

const okCommit = async () => ({
  branchName: "migrate/pr-4.9.18-java17",
  commitSha: "commit1",
  prNumber: 12,
  prUrl: "https://github.com/po/pr/pull/12",
});

describeJobHome();
function describeJobHome() {
  let tmpHome;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "mule-ppjob-"));
    process.env.MULE_UPGRADE_HOME = tmpHome;
  });
  afterEach(() => {
    delete process.env.MULE_UPGRADE_HOME;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("runParentPomJob: NO_CHANGE takes no lock and creates no job", async () => {
    const readPom = async () => ({ pomText: NO_EDITS_POM, headSha: "PSHA" });
    const res = await runParentPomJob({
      owner: "po",
      repo: "pr",
      branch: "main",
      mode: "api",
      deps: { resolveMatrix: resolveMatrixStub, readPom },
    });
    assert.equal(res.status, "NO_CHANGE");
    assert.equal(res.jobId, null, "no job id on the no-change path");
    assert.equal(store.lockHolder("pr"), null, "no lock was acquired");
    assert.equal(store.listJobs().length, 0, "no job persisted");
  });

  test("runParentPomJob: edits → PR_OPEN persists a job, holds the lock, indexes the branch", async () => {
    const readPom = async () => ({ pomText: MANAGED_POM, headSha: "PSHA" });
    const res = await runParentPomJob({
      owner: "po",
      repo: "pr",
      branch: "main",
      mode: "api",
      deps: { resolveMatrix: resolveMatrixStub, readPom, commitApi: okCommit },
    });
    assert.equal(res.status, "PR_OPEN");
    assert.ok(res.jobId, "job id assigned by the store");
    assert.equal(res.prUrl, "https://github.com/po/pr/pull/12");
    // persisted record reflects PR_OPEN + the PR fields
    const rec = store.getJob(res.jobId);
    assert.equal(rec.status, "PR_OPEN");
    assert.equal(rec.prNumber, 12);
    assert.equal(rec.changePlan.kind, "parentPomUpgrade");
    // the lock is RETAINED at PR_OPEN (deploy tail still owns it), keyed per MODULE (repo::pomPath)
    assert.equal(store.lockHolder("pr::pom.xml"), res.jobId, "lock retained by this job (per-module key)");
    assert.equal(rec.lockKey, "pr::pom.xml", "record carries the per-module lock key");
    // branch → job index written
    assert.equal(store.jobIdForBranch("migrate/pr-4.9.18-java17"), res.jobId);
  });

  test("runParentPomJob: a second run while locked → CONFLICT (single-flight), no second job", async () => {
    const readPom = async () => ({ pomText: MANAGED_POM, headSha: "PSHA" });
    const first = await runParentPomJob({
      owner: "po",
      repo: "pr",
      branch: "main",
      mode: "api",
      deps: { resolveMatrix: resolveMatrixStub, readPom, commitApi: okCommit },
    });
    assert.equal(first.status, "PR_OPEN");
    const second = await runParentPomJob({
      owner: "po",
      repo: "pr",
      branch: "main",
      mode: "api",
      deps: { resolveMatrix: resolveMatrixStub, readPom, commitApi: okCommit },
    });
    assert.equal(second.status, "CONFLICT");
    assert.equal(second.code, "UPGRADE_IN_PROGRESS");
    assert.equal(second.existingJobId, first.jobId);
    assert.equal(second.prUrl, "https://github.com/po/pr/pull/12", "surfaces the in-flight PR");
    assert.equal(store.listJobs().length, 1, "no second job created");
  });

  test("runParentPomJob: a commit failure → FAILED_COMMIT terminal + lock released", async () => {
    const readPom = async () => ({ pomText: MANAGED_POM, headSha: "PSHA" });
    const boomCommit = async () => {
      throw new Error("github 500");
    };
    const res = await runParentPomJob({
      owner: "po",
      repo: "pr",
      branch: "main",
      mode: "api",
      deps: { resolveMatrix: resolveMatrixStub, readPom, commitApi: boomCommit },
    });
    assert.equal(res.status, "FAILED_COMMIT");
    assert.match(res.error, /github 500/);
    const rec = store.getJob(res.jobId);
    assert.equal(rec.status, "FAILED_COMMIT");
    assert.ok(rec.completedAt, "terminal status stamped completedAt");
    assert.equal(store.lockHolder("pr::pom.xml"), null, "lock released on failure so a retry can proceed");
  });

  test("runParentPomJob: BOM and parent-pom in the SAME repo do NOT conflict (per-module lock)", async () => {
    // The monorepo chained flow: a BOM upgrade (bom/pom.xml) and a parent-pom upgrade
    // (parent-pom/pom.xml) both live in repo "mule-apps". With a per-repo lock they would falsely
    // CONFLICT; with the per-module lock (repo::pomPath) both open their own PR concurrently.
    const bom = await runParentPomJob({
      repoUrl: "https://github.com/avatansh/mule-apps/tree/develop/bom",
      mode: "api",
      deps: { resolveMatrix: resolveMatrixStub, readPom: async () => ({ pomText: MANAGED_POM, headSha: "PSHA" }), commitApi: okCommit },
    });
    assert.equal(bom.status, "PR_OPEN", "BOM PR opens");
    const parent = await runParentPomJob({
      repoUrl: "https://github.com/avatansh/mule-apps/tree/develop/parent-pom",
      mode: "api",
      deps: { resolveMatrix: resolveMatrixStub, readPom: async () => ({ pomText: MANAGED_POM, headSha: "PSHA" }), commitApi: okCommit },
    });
    assert.equal(parent.status, "PR_OPEN", "parent-pom PR opens even though the BOM job holds a lock on the same repo");
    assert.notEqual(bom.jobId, parent.jobId, "two distinct tracked jobs");
    assert.equal(store.lockHolder("mule-apps::bom/pom.xml"), bom.jobId);
    assert.equal(store.lockHolder("mule-apps::parent-pom/pom.xml"), parent.jobId);
    assert.equal(store.listJobs().length, 2, "both jobs persisted");
  });

  test("runParentPomJob: a VALIDATION error in assess → FAILED path is never entered (no job)", async () => {
    // Unresolved coords throw VALIDATION during the read-only assess, BEFORE any lock/job — the
    // caller sees a throw, not a FAILED_* job (matches upgradeParentPom's validation contract).
    await assert.rejects(
      () => runParentPomJob({ repoUrl: "not-a-url", mode: "api", deps: { resolveMatrix: resolveMatrixStub } }),
      (e) => e.code === "VALIDATION"
    );
    assert.equal(store.listJobs().length, 0, "no job created on pre-lock validation failure");
  });

  // ── chained flow: detect-only, parent-ref repoint, and app-PR amend ─────────────────────────
  const PARENT_CHAIN_POM = [
    "<project>",
    "  <parent>",
    "    <groupId>g</groupId>",
    "    <artifactId>solutions-bom</artifactId>",
    "    <version>1.0.0-SNAPSHOT</version>",
    "    <relativePath>../bom/pom.xml</relativePath>",
    "  </parent>",
    "  <artifactId>solutions-parent-pom</artifactId>",
    "  <version>1.0.0-SNAPSHOT</version>",
    "  <packaging>pom</packaging>",
    "</project>",
  ].join("\n");

  test("runParentPomJob detectOnly: reports inheritance, takes no lock, creates no job", async () => {
    const readPom = async () => ({ pomText: PARENT_CHAIN_POM, headSha: "PSHA" });
    const res = await runParentPomJob({
      owner: "po",
      repo: "parent-pom",
      branch: "develop",
      mode: "api",
      detectOnly: true,
      deps: { resolveMatrix: resolveMatrixStub, readPom },
    });
    assert.equal(res.status, "DETECTED");
    assert.equal(res.inheritance.parent.artifactId, "solutions-bom");
    assert.equal(res.inheritance.inheritsFromShared, true);
    assert.equal(store.lockHolder("parent-pom"), null, "detect takes no lock");
    assert.equal(store.listJobs().length, 0, "detect creates no job");
  });

  test("runParentPomJob chained: repoint <parent> + force own bump → PR_OPEN with both edits", async () => {
    const readPom = async () => ({ pomText: PARENT_CHAIN_POM, headSha: "PSHA" });
    let staged = null;
    const commitApi = async (a) => {
      staged = a.stagedFiles;
      return { branchName: "migrate/parent-pom-4.9.18-java17", commitSha: "c1", prNumber: 20, prUrl: "https://x/pull/20" };
    };
    const res = await runParentPomJob({
      owner: "po",
      repo: "parent-pom",
      branch: "develop",
      mode: "api",
      parentRef: { artifactId: "solutions-bom", toVersion: "1.1.0-SNAPSHOT" },
      bumpOwnVersion: true,
      deps: { resolveMatrix: resolveMatrixStub, readPom, commitApi },
    });
    assert.equal(res.status, "PR_OPEN");
    // both a parent-ref repoint and an own-version bump are present even though NO connectors changed
    assert.ok(res.edits.some((e) => e.kind === "pomParentVersion" && e.to === "1.1.0-SNAPSHOT"));
    assert.ok(res.edits.some((e) => e.kind === "pomVersion" && e.to === "1.1.0-SNAPSHOT"));
    // staged pom has the repointed parent AND the bumped own version
    assert.match(staged[0].content, /<artifactId>solutions-bom<\/artifactId>\s*<version>1\.1\.0-SNAPSHOT<\/version>/);
    assert.match(
      staged[0].content,
      /<artifactId>solutions-parent-pom<\/artifactId>\s*<version>1\.1\.0-SNAPSHOT<\/version>/
    );
  });

  test("updateOpenPrParentRef: amends the app's open PR branch + records the amendment on the job", async () => {
    // seed a tracked APP job in PR_OPEN with an open PR branch
    const { jobId } = store.createJob({
      appName: "customer-web-eapi",
      coords: { owner: "avatansh", repo: "mule-apps", defaultBranch: "develop" },
    });
    store.setStatus(jobId, "PR_OPEN", { branchName: "migrate/app-4.9.18-java17", prNumber: 30, prUrl: "https://x/pull/30" });

    const APP_POM = [
      "<project>",
      "  <parent>",
      "    <artifactId>solutions-parent-pom</artifactId>",
      "    <version>1.0.0-SNAPSHOT</version>",
      "  </parent>",
      "  <artifactId>customer-web-eapi-app</artifactId>",
      "  <version>1.0.0-SNAPSHOT</version>",
      "</project>",
    ].join("\n");
    let committed = null;
    const res = await updateOpenPrParentRef({
      appJobId: jobId,
      parentRef: { artifactId: "solutions-parent-pom", toVersion: "1.1.0-SNAPSHOT" },
      pomPath: "customer-web-eapi/pom.xml",
      deps: {
        readPom: async ({ ref }) => {
          assert.equal(ref, "migrate/app-4.9.18-java17"); // reads at the OPEN PR head branch
          return { pomText: APP_POM };
        },
        commitToBranchApi: async (a) => {
          committed = a;
          return { branchName: a.branchName, commitSha: "amend1", headBefore: "H0" };
        },
      },
    });
    assert.equal(res.status, "PR_UPDATED");
    assert.equal(res.commitSha, "amend1");
    assert.equal(res.parentRef.from, "1.0.0-SNAPSHOT");
    // committed onto the SAME branch, with the repointed app <parent>
    assert.equal(committed.branchName, "migrate/app-4.9.18-java17");
    assert.match(
      committed.stagedFiles[0].content,
      /<artifactId>solutions-parent-pom<\/artifactId>\s*<version>1\.1\.0-SNAPSHOT<\/version>/
    );
    // amendment recorded on the app job (status unchanged)
    const rec = store.getJob(jobId);
    assert.equal(rec.status, "PR_OPEN");
    assert.equal(rec.amendments.length, 1);
    assert.equal(rec.amendments[0].to, "1.1.0-SNAPSHOT");
    assert.equal(rec.commitSha, "amend1");
  });

  test("updateOpenPrParentRef: AUTO-DERIVES the app's own pom path from the job (no pomPath passed) — bug PR#38", async () => {
    // Regression for PR #38: the amendment must edit customer-web-eapi/pom.xml (the file the app PR
    // itself edited), NOT the repo-root pom.xml. The agent passed no pomPath; the tool must derive it
    // from the tracked job's changePlan instead of defaulting to "pom.xml".
    const { jobId } = store.createJob({
      appName: "customer-web-eapi-app",
      coords: { owner: "avatansh", repo: "mule-apps", defaultBranch: "develop" },
      changePlan: {
        kind: "appUpgrade",
        filesToChange: ["customer-web-eapi/pom.xml", "customer-web-eapi/mule-artifact.json"],
        fileEdits: [
          { kind: "pomProperty", file: "customer-web-eapi/pom.xml", property: "java.version", from: "1.8", to: "17" },
          { kind: "pomVersion", file: "customer-web-eapi/pom.xml", artifactId: "customer-web-eapi-app", from: "1.0.0-SNAPSHOT", to: "1.1.0-SNAPSHOT" },
        ],
      },
    });
    store.setStatus(jobId, "PR_OPEN", { branchName: "migrate/customer-web-eapi-app-4.9.18-java17", prNumber: 38 });

    const APP_POM = [
      "<project>",
      "  <parent>",
      "    <artifactId>solutions-parent-pom</artifactId>",
      "    <version>1.0.0-SNAPSHOT</version>",
      "  </parent>",
      "  <artifactId>customer-web-eapi-app</artifactId>",
      "  <version>1.1.0-SNAPSHOT</version>",
      "</project>",
    ].join("\n");
    let readPath = null;
    let committedPath = null;
    const res = await updateOpenPrParentRef({
      appJobId: jobId,
      parentRef: { artifactId: "solutions-parent-pom", toVersion: "1.1.0-SNAPSHOT" },
      // NOTE: no pomPath — must be derived
      deps: {
        readPom: async ({ pomPath }) => {
          readPath = pomPath;
          return { pomText: APP_POM };
        },
        commitToBranchApi: async (a) => {
          committedPath = a.stagedFiles[0].path;
          return { branchName: a.branchName, commitSha: "amendD", headBefore: "H0" };
        },
      },
    });
    assert.equal(res.status, "PR_UPDATED");
    assert.equal(readPath, "customer-web-eapi/pom.xml", "read the app's OWN pom, not repo-root");
    assert.equal(committedPath, "customer-web-eapi/pom.xml", "committed to the app's OWN pom, not repo-root");
    assert.equal(res.pomPath, "customer-web-eapi/pom.xml");
  });

  test("deriveAppPomPath: prefers the pomVersion edit file, then any pom.xml, then appPath, then root", () => {
    assert.equal(
      deriveAppPomPath({ changePlan: { fileEdits: [{ kind: "pomVersion", file: "svc-a/pom.xml" }] } }),
      "svc-a/pom.xml"
    );
    assert.equal(
      deriveAppPomPath({ changePlan: { filesToChange: ["svc-b/mule-artifact.json", "svc-b/pom.xml"] } }),
      "svc-b/pom.xml"
    );
    assert.equal(deriveAppPomPath({ changePlan: { appPath: "svc-c" } }), "svc-c/pom.xml");
    assert.equal(deriveAppPomPath({ coords: { appPath: "svc-d" } }), "svc-d/pom.xml");
    assert.equal(deriveAppPomPath({}), "pom.xml"); // single-module repo at root
    assert.equal(deriveAppPomPath({ changePlan: { appPath: "." } }), "pom.xml");
  });

  test("updateOpenPrParentRef: NO_CHANGE when the app <parent> does not match the coords", async () => {
    const { jobId } = store.createJob({
      appName: "app2",
      coords: { owner: "o", repo: "app2", defaultBranch: "main" },
    });
    store.setStatus(jobId, "PR_OPEN", { branchName: "b2", prNumber: 5 });
    const res = await updateOpenPrParentRef({
      appJobId: jobId,
      parentRef: { artifactId: "not-present", toVersion: "9.9.9" },
      deps: {
        readPom: async () => ({ pomText: "<project><parent><artifactId>other</artifactId><version>1</version></parent></project>" }),
        commitToBranchApi: async () => {
          throw new Error("must not commit on NO_CHANGE");
        },
      },
    });
    assert.equal(res.status, "NO_CHANGE");
  });

  test("updateOpenPrParentRef: a job with no open PR → VALIDATION", async () => {
    const { jobId } = store.createJob({ appName: "app3", coords: { owner: "o", repo: "app3" } });
    // still PROCESSING, no branch
    await assert.rejects(
      () => updateOpenPrParentRef({ appJobId: jobId, parentRef: { artifactId: "x", toVersion: "1" } }),
      (e) => e.code === "VALIDATION"
    );
  });
}
