// tests/parent_pom.test.js — SKILL 4 (mule-upgrade-parent-pom).
//   Ported from proc-parent-pom-suite.xml:
//     · parentpom-no-edits            → NO_CHANGE, upgraded:false, jiraUrl built.
//     · parentpom-with-edits-opens-pr → pins managed http.connector.version → PR_OPEN, edits>0, prUrl.
//     · parentpom-repourl-tree-parsing→ /tree/develop/bom → branch=develop, pomPath=bom/pom.xml, appName=repo.
//   Plus repo_url unit tests for the parsing edge cases the DWL fix addressed.
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveRepoCoords, resolvePomPath } from "../skills/mule-upgrade-parent-pom/scripts/lib/repo_url.js";
import { upgradeParentPom } from "../skills/mule-upgrade-parent-pom/scripts/parent_pom.js";

// matrix stub: one managed connector (http) whose Java-17 set version is 1.9.0.
const MATRIX = {
  target: { runtime: "4.9.18", javaVersion: "17" },
  gating: {},
  connectors: [
    { groupId: "org.mule.connectors", artifactId: "mule-http-connector", property: "http.connector.version", set: "1.9.0" },
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
    pomText: "<project><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging></project>",
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
    return { branchName: "migrate/pr-4.9.18-java17", commitSha: "commit1", prNumber: 12, prUrl: "https://github.com/po/pr/pull/12" };
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
  assert.match(committed.stagedFiles[0].content, /<http\.connector\.version>1\.9\.0<\/http\.connector\.version>/);
  assert.equal(committed.changePlan.headSha, "PSHA");
});

// ── orchestration: tree-URL parsing drives the read ───────────────────────────────────────────
test("parentpom-repourl-tree-parsing → reads bom/pom.xml @ develop, appName=repo", async () => {
  const seen = [];
  const readPom = async ({ coords, pomPath, defaultBranch }) => {
    seen.push({ owner: coords.owner, repo: coords.repo, pomPath, defaultBranch });
    return {
      pomText: "<project><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging></project>",
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
  assert.deepEqual(seen[0], { owner: "avatansh", repo: "mule-apps", pomPath: "bom/pom.xml", defaultBranch: "develop" });
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
  const xml = "<project><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging></project>";
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
