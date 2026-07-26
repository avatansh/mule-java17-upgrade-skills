// tests/pr.test.js — SKILL 3 (mule-upgrade-pr) parity + behaviour tests.
//   · pr_meta: branch naming/collision, titles, bodies, commit + revert helpers (pure units).
//   · commitAndPrApi: full Git Data API flow via an injected fetch mock — asserts the exact
//     endpoint sequence, stale-plan CONFLICT guard, and returned {branchName, commitSha, prNumber}.
//     Ported from sys-github-suite.xml (atomic-commit-happy, atomic-commit-stale, open-pr).
//   · rollbackApi: revert PR restores the pre-upgrade first-parent tree (port of pf-rollback path).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  branchBase,
  pickBranchName,
  prTitle,
  prBody,
  commitMessage,
  revertBranchName,
  revertPrTitle,
  revertCommitMessage,
  revertPrBody,
} from "../skills/mule-upgrade-pr/scripts/lib/pr_meta.js";
import { GitHubApi } from "../skills/mule-upgrade-pr/scripts/lib/gh_api.js";
import { commitAndPrApi } from "../skills/mule-upgrade-pr/scripts/commit_pr.js";
import { rollbackApi } from "../skills/mule-upgrade-pr/scripts/rollback.js";

// ── pr_meta — pure helpers ───────────────────────────────────────────────────────────────
test("prmeta-branchBase-format", () => {
  assert.equal(branchBase("my-app", "4.9.18", "17"), "migrate/my-app-4.9.18-java17");
});

test("prmeta-pickBranchName-uses-base-when-free", () => {
  assert.equal(pickBranchName("migrate/app", [], "job-1"), "migrate/app");
});

test("prmeta-pickBranchName-bumps-suffix-on-collision", () => {
  const refs = ["refs/heads/migrate/app", "refs/heads/migrate/app-1"];
  assert.equal(pickBranchName("migrate/app", refs, "job-1"), "migrate/app-2");
});

test("prmeta-pickBranchName-accepts-bare-branch-names", () => {
  assert.equal(pickBranchName("migrate/app", ["migrate/app"], "job-1"), "migrate/app-1");
});

test("prmeta-pickBranchName-falls-back-to-jobId-when-all-taken", () => {
  const refs = ["migrate/app", ...Array.from({ length: 50 }, (_, i) => `migrate/app-${i + 1}`)];
  assert.equal(pickBranchName("migrate/app", refs, "job-xyz"), "migrate/app-job-xyz");
});

test("prmeta-prTitle-format", () => {
  assert.equal(prTitle("my-app", "4.9.18", "17"), "Java 17 upgrade: my-app → 4.9.18 / Java 17");
});

test("prmeta-prBody-includes-jira-and-warnings", () => {
  const body = prBody({
    appName: "my-app",
    targetRuntime: "4.9.18",
    targetJavaVersion: "17",
    commitSha: "abc123",
    jobId: "job-1",
    jiraTicketId: "J1U-9",
    jiraBaseUrl: "https://acme.atlassian.net",
    warnings: ["custom Java detected", "DW POJO in use"],
  });
  assert.match(body, /my-app/);
  assert.match(body, /4\.9\.18/);
  assert.match(body, /abc123/);
  assert.match(body, /\[J1U-9\]\(https:\/\/acme\.atlassian\.net\/browse\/J1U-9\)/);
  assert.match(body, /- custom Java detected/);
  assert.match(body, /- DW POJO in use/);
});

test("prmeta-prBody-omits-jira-and-warnings-when-absent", () => {
  const body = prBody({
    appName: "my-app",
    targetRuntime: "4.9.18",
    targetJavaVersion: "17",
    commitSha: "abc123",
    jobId: "job-1",
    jiraTicketId: null,
  });
  assert.equal(/Jira/.test(body), false);
  assert.equal(/Warnings/.test(body), false);
});

test("prmeta-commitMessage-with-and-without-jira", () => {
  assert.equal(commitMessage("job-1", "J1U-9"), "Java 17 upgrade (job-1) J1U-9");
  assert.equal(commitMessage("job-1", null), "Java 17 upgrade (job-1)");
});

test("prmeta-revert-helpers", () => {
  assert.equal(revertBranchName("migrate/app-1"), "revert/migrate/app-1");
  assert.equal(revertPrTitle("my-app"), "Revert: Java 17 upgrade my-app");
  assert.equal(revertCommitMessage("job-1"), "Revert Java 17 upgrade (job-1) — deploy failed");
  assert.match(revertPrBody({ jobId: "job-1" }), /rollback for job job-1/);
});

// ── fetch mock — records the endpoint sequence and returns canned JSON per (method, path) ──
function makeFetchMock(routes) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const method = opts.method;
    const path = url.replace("https://api.github.com", "");
    calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : undefined });
    // find first matching route (by method + path regex)
    const route = routes.find((r) => r.method === method && r.match.test(path));
    if (!route) throw new Error(`no mock route for ${method} ${path}`);
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(typeof route.body === "function" ? route.body(path) : route.body),
    };
  };
  return { fetchImpl, calls };
}

// ── commitAndPrApi — happy path (port of github-atomic-commit-happy + github-open-pr) ──────
test("commitApi-happy-path-runs-full-git-data-sequence", async () => {
  const { fetchImpl, calls } = makeFetchMock([
    { method: "GET", match: /\/commits\/main$/, body: { sha: "HEAD1" } },
    { method: "GET", match: /\/git\/matching-refs\/heads\//, body: [] },
    { method: "POST", match: /\/git\/refs$/, body: { ref: "refs/heads/x" } },
    { method: "POST", match: /\/git\/blobs$/, body: { sha: "blob1" } },
    { method: "POST", match: /\/git\/trees$/, body: { sha: "tree1" } },
    { method: "POST", match: /\/git\/commits$/, body: { sha: "commit1" } },
    { method: "PATCH", match: /\/git\/refs\/heads\//, body: { ref: "refs/heads/x" } },
    { method: "POST", match: /\/pulls$/, body: { number: 7, html_url: "https://github.com/o/r/pull/7" } },
  ]);
  const api = new GitHubApi({ token: "t", fetchImpl });
  const result = await commitAndPrApi({
    coords: { owner: "o", repo: "r", defaultBranch: "main" },
    changePlan: { headSha: "HEAD1", targetRuntime: "4.9.18", targetJavaVersion: "17" },
    stagedFiles: [{ path: "pom.xml", content: "<project/>" }],
    appName: "ac-app",
    jobId: "job-ac-1",
    api,
  });
  assert.equal(result.commitSha, "commit1");
  assert.equal(result.prNumber, 7);
  assert.equal(result.prUrl, "https://github.com/o/r/pull/7");
  assert.equal(result.branchName, "migrate/ac-app-4.9.18-java17");

  // verify the endpoint order matches pf-atomic-commit → pf-open-pr
  const seq = calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
  assert.deepEqual(seq, [
    "GET /repos/o/r/commits/main",
    "GET /repos/o/r/git/matching-refs/heads/migrate/ac-app-4.9.18-java17",
    "POST /repos/o/r/git/refs",
    "POST /repos/o/r/git/blobs",
    "POST /repos/o/r/git/trees",
    "POST /repos/o/r/git/commits",
    "PATCH /repos/o/r/git/refs/heads/migrate/ac-app-4.9.18-java17",
    "POST /repos/o/r/pulls",
  ]);
  // tree used base_tree = headSha; commit parent = headSha
  const tree = calls.find((c) => /\/git\/trees$/.test(c.path));
  assert.equal(tree.body.base_tree, "HEAD1");
  const commit = calls.find((c) => /\/git\/commits$/.test(c.path));
  assert.deepEqual(commit.body.parents, ["HEAD1"]);
});

// ── commitAndPrApi — stale plan (port of github-atomic-commit-stale) ───────────────────────
test("commitApi-stale-plan-raises-CONFLICT", async () => {
  const { fetchImpl } = makeFetchMock([
    { method: "GET", match: /\/commits\/main$/, body: { sha: "MOVED-SHA" } },
  ]);
  const api = new GitHubApi({ token: "t", fetchImpl });
  await assert.rejects(
    () =>
      commitAndPrApi({
        coords: { owner: "o", repo: "r", defaultBranch: "main" },
        changePlan: { headSha: "HEAD1", targetRuntime: "4.9.18", targetJavaVersion: "17" },
        stagedFiles: [{ path: "pom.xml", content: "<project/>" }],
        appName: "ac-app2",
        jobId: "job-ac-2",
        api,
      }),
    (e) => e.code === "STALE_PLAN"
  );
});

test("commitApi-branch-collision-picks-next-suffix", async () => {
  const { fetchImpl } = makeFetchMock([
    { method: "GET", match: /\/commits\/main$/, body: { sha: "HEAD1" } },
    {
      method: "GET",
      match: /\/git\/matching-refs\/heads\//,
      body: [{ ref: "refs/heads/migrate/c-app-4.9.18-java17" }],
    },
    { method: "POST", match: /\/git\/refs$/, body: {} },
    { method: "POST", match: /\/git\/blobs$/, body: { sha: "b" } },
    { method: "POST", match: /\/git\/trees$/, body: { sha: "t" } },
    { method: "POST", match: /\/git\/commits$/, body: { sha: "c" } },
    { method: "PATCH", match: /\/git\/refs\/heads\//, body: {} },
    { method: "POST", match: /\/pulls$/, body: { number: 1, html_url: "u" } },
  ]);
  const api = new GitHubApi({ token: "t", fetchImpl });
  const result = await commitAndPrApi({
    coords: { owner: "o", repo: "r", defaultBranch: "main" },
    changePlan: { headSha: "HEAD1", targetRuntime: "4.9.18", targetJavaVersion: "17" },
    stagedFiles: [{ path: "pom.xml", content: "<project/>" }],
    appName: "c-app",
    jobId: "job-c",
    api,
  });
  assert.equal(result.branchName, "migrate/c-app-4.9.18-java17-1");
});

// ── rollbackApi — restores the first-parent tree on a revert branch ────────────────────────
test("rollbackApi-restores-parent-tree-and-opens-revert-pr", async () => {
  const { fetchImpl, calls } = makeFetchMock([
    // getCommitFull(upgradeCommit) → parents[0].sha = BASE
    { method: "GET", match: /\/commits\/commit1$/, body: { sha: "commit1", parents: [{ sha: "BASE" }] } },
    // getCommit(BASE) → tree.sha = BASETREE
    { method: "GET", match: /\/git\/commits\/BASE$/, body: { sha: "BASE", tree: { sha: "BASETREE" } } },
    // headSha(main) → current HEAD
    { method: "GET", match: /\/commits\/main$/, body: { sha: "HEADNOW" } },
    { method: "POST", match: /\/git\/refs$/, body: {} },
    { method: "POST", match: /\/git\/commits$/, body: { sha: "revcommit" } },
    { method: "PATCH", match: /\/git\/refs\/heads\//, body: {} },
    { method: "POST", match: /\/pulls$/, body: { number: 9, html_url: "https://github.com/o/r/pull/9" } },
  ]);
  const api = new GitHubApi({ token: "t", fetchImpl });
  const result = await rollbackApi({
    coords: { owner: "o", repo: "r", defaultBranch: "main" },
    upgradeCommitSha: "commit1",
    branchName: "migrate/app-4.9.18-java17",
    appName: "app",
    jobId: "job-1",
    api,
  });
  assert.equal(result.baseSha, "BASE");
  assert.equal(result.revertBranch, "revert/migrate/app-4.9.18-java17");
  assert.equal(result.revertCommitSha, "revcommit");
  assert.equal(result.prNumber, 9);
  // the revert commit must restore the base tree
  const commit = calls.find((c) => /\/git\/commits$/.test(c.path) && c.method === "POST");
  assert.equal(commit.body.tree, "BASETREE");
  assert.deepEqual(commit.body.parents, ["HEADNOW"]);
});
