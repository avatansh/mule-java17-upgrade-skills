// tests/repo_source.test.js — EPIC A: the repo-source abstraction (local vs github).
//
// Core acceptance criterion: assessing a GitHub repo over the REST API (NO local clone) yields a
// ChangePlan IDENTICAL to assessing the same files from a local clone. We build a small fixture
// repo on disk, assess it via localSource, then serve the SAME files through a fake GitHubApi and
// assess via githubSource, and assert the two changePlans are byte-for-byte equal.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { localSource, githubSource } from "../skills/mule-upgrade-assess/scripts/lib/repo_source.js";
import { assess, resolveSource, resolveVersionsForApp } from "../skills/mule-upgrade-assess/scripts/assess.js";

// ── a minimal Java-11 Mule app fixture (app.runtime 4.6.0, java 11 → needs the upgrade) ─────────
const APP_POM = `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>payments-api</artifactId>
  <version>1.0.0</version>
  <packaging>mule-application</packaging>
  <properties>
    <app.runtime>4.6.0</app.runtime>
    <java.version>11</java.version>
    <mule.maven.plugin.version>4.1.0</mule.maven.plugin.version>
    <http.connector.version>1.7.0</http.connector.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.mule.connectors</groupId>
      <artifactId>mule-http-connector</artifactId>
      <version>\${http.connector.version}</version>
      <classifier>mule-plugin</classifier>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.mule.tools.maven</groupId>
        <artifactId>mule-maven-plugin</artifactId>
        <version>\${mule.maven.plugin.version}</version>
      </plugin>
    </plugins>
  </build>
</project>`;

const MULE_ARTIFACT = JSON.stringify({ minMuleVersion: "4.6.0", javaSpecificationVersions: ["11"] }, null, 2);
const JAVA_SRC =
  'package com.example;\nclass Foo { void f() throws Exception { getClass().getDeclaredMethod("x").setAccessible(true); } }\n';

const FILES = {
  "pom.xml": APP_POM,
  "mule-artifact.json": MULE_ARTIFACT,
  "src/main/java/com/example/Foo.java": JAVA_SRC,
};

// Build the fixture in a fresh temp dir; caller cleans up.
function makeLocalRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mule-src-"));
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

// A fake GitHubApi that serves FILES via getTree + getContents (base64), like the real REST API.
function fakeGh(files = FILES) {
  const treeEntries = [];
  const dirs = new Set();
  for (const rel of Object.keys(files)) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    treeEntries.push({ path: rel, type: "blob" });
  }
  for (const d of dirs) treeEntries.push({ path: d, type: "tree" });
  return {
    calls: { getTree: 0, getContents: 0 },
    async getRepo() {
      return { default_branch: "main" };
    },
    async getTree(owner, repo, ref) {
      this.calls.getTree++;
      assert.equal(ref, "main");
      return { sha: "deadbeef", tree: treeEntries, truncated: false };
    },
    async getContents(owner, repo, p) {
      this.calls.getContents++;
      if (!(p in files)) {
        const e = new Error("Not Found");
        e.status = 404;
        throw e;
      }
      return { encoding: "base64", content: Buffer.from(files[p], "utf8").toString("base64") };
    },
  };
}

// A no-op ExchangeClient stub so resolveMatrix never touches the network (config defaults to
// matrix.source=exchange-latest). fetchAsset "fails" fast → bundled-matrix fallback, deterministic.
const NO_EXCHANGE = {
  async fetchAsset() {
    return { ok: false, reason: "test: exchange disabled" };
  },
};
// An unconfigured Anypoint client so the (env-gated) ARM/API cross-checks short-circuit instead of
// attempting a live call — keeps the assess() e2e tests fast and network-independent.
const NO_ANYPOINT = { configured: () => false };

// Common opts that keep assess() fully offline + deterministic regardless of the dev config.
const OFFLINE = { noFetch: true, exchange: NO_EXCHANGE, anypointClient: NO_ANYPOINT, env: "local" };

// Assess against a local clone with fetch disabled (matrix = bundled) for determinism.
async function assessLocal(root) {
  return assess({ source: "local", repo: root, ...OFFLINE });
}
async function assessGithub(gh) {
  return assess({
    source: "github",
    owner: "acme",
    repoName: "payments-api",
    branch: "main",
    gh,
    ...OFFLINE,
  });
}

test("localSource.listTree mirrors the github blob/tree vocabulary", async () => {
  const root = makeLocalRepo();
  try {
    const { tree } = await localSource(root).listTree();
    const paths = tree.map((t) => t.path).sort();
    assert.ok(paths.includes("pom.xml"));
    assert.ok(paths.includes("mule-artifact.json"));
    assert.ok(paths.includes("src/main/java/com/example/Foo.java"));
    // directories are "tree", files are "blob"
    assert.equal(tree.find((t) => t.path === "src").type, "tree");
    assert.equal(tree.find((t) => t.path === "pom.xml").type, "blob");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("githubSource.prime + readSync serves files; 404 → null (not thrown)", async () => {
  const gh = fakeGh();
  const src = githubSource({ owner: "acme", repo: "payments-api", ref: "main", gh });
  const { tree, truncated } = await src.listTree();
  assert.equal(truncated, false);
  assert.ok(tree.some((t) => t.path === "pom.xml" && t.type === "blob"));
  await src.prime(["pom.xml", "does/not/exist.txt"]);
  assert.equal(src.readSync("pom.xml"), APP_POM);
  assert.equal(src.readSync("does/not/exist.txt"), null); // 404 primed as null
  assert.equal(src.readSync("never-primed"), null);
});

test("githubSource.readSync memoises — prime is idempotent, no duplicate fetches", async () => {
  const gh = fakeGh();
  const src = githubSource({ owner: "acme", repo: "payments-api", ref: "main", gh });
  await src.prime(["pom.xml"]);
  await src.prime(["pom.xml"]); // already cached → no second getContents
  assert.equal(gh.calls.getContents, 1);
});

test("resolveSource: repoUrl with /tree/<branch>/<sub> yields a github source + app-path hint", () => {
  const { source, appPathHint } = resolveSource({
    source: "github",
    repoUrl: "https://github.com/acme/monorepo/tree/develop/apps/payments",
    gh: fakeGh(),
  });
  assert.equal(source.kind, "github");
  assert.equal(appPathHint, "apps/payments");
});

test("EPIC A acceptance: github assess ChangePlan === local assess ChangePlan", async () => {
  const root = makeLocalRepo();
  try {
    const local = await assessLocal(root);
    const gh = fakeGh();
    const remote = await assessGithub(gh);

    // The heart of EPIC A: byte-identical change plans regardless of source.
    assert.deepEqual(remote.result.changePlan.fileEdits, local.result.changePlan.fileEdits);
    assert.deepEqual(
      remote.result.changePlan.filesToChange.sort(),
      local.result.changePlan.filesToChange.sort()
    );
    assert.equal(remote.result.changePlan.topology, local.result.changePlan.topology);
    assert.equal(remote.result.currentRuntime, local.result.currentRuntime);
    assert.equal(remote.result.currentJavaVersion, local.result.currentJavaVersion);

    // github ran with no clone: at least one getTree + several getContents happened.
    assert.equal(gh.calls.getTree, 1);
    assert.ok(gh.calls.getContents >= 2);

    // sanity: the fixture genuinely needs the upgrade (runtime + java + plugin + connector edits).
    assert.ok(local.result.changePlan.fileEdits.length > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("EPIC A: the setAccessible manualReview warning fires equally for both sources", async () => {
  const root = makeLocalRepo();
  try {
    const local = await assessLocal(root);
    const remote = await assessGithub(fakeGh());
    const hasSetAccessible = (r) => r.result.warnings.some((w) => /setAccessible/.test(w));
    assert.equal(hasSetAccessible(remote), hasSetAccessible(local));
    assert.equal(hasSetAccessible(local), true); // Foo.java has setAccessible(
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── The Full Split (A1/A2/A3): lean assess by default ────────────────────────────────────────────
test("Full Split A1: default assess is LEAN — no connectorChoices/connectorDrift; connectorsInApp present", async () => {
  const root = makeLocalRepo();
  try {
    const { result, connectorChoices, connectorDrift, matrixDrift } = await assessLocal(root);
    // The rich menu / drift advisories are absent by default.
    assert.equal(result.connectorChoices, undefined, "no connectorChoices on the result by default");
    assert.equal(result.connectorDrift, undefined, "no connectorDrift on the result by default");
    assert.deepEqual(connectorChoices, [], "top-level connectorChoices is empty by default");
    assert.equal(connectorDrift, null, "top-level connectorDrift is null by default");
    assert.equal(matrixDrift, null, "matrixDrift is null by default (opt-in via includeDrift)");
    // But the network-free per-app connector view is always present.
    const inApp = result.changePlan.connectorsInApp;
    assert.ok(Array.isArray(inApp) && inApp.length >= 1, "connectorsInApp[] is always present");
    const http = inApp.find((c) => c.artifactId === "mule-http-connector");
    assert.ok(http, "the app's mule-http-connector appears in connectorsInApp");
    assert.equal(http.current, "1.7.0", "current is the app's declared version");
    assert.equal(http.declaredInApp, true, "the app declares its own http.connector.version");
    assert.equal(http.willChange, true, "1.7.0 is below the matrix pin → willChange");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// B6: assess echoes an optional jiraTicketId onto the result so a downstream start_upgrade / PR can
// cite it. Absent by default (lean result stays clean).
test("B6: assess echoes jiraTicketId when supplied, omits it otherwise", async () => {
  const root = makeLocalRepo();
  try {
    const withTicket = await assess({ source: "local", repo: root, ...OFFLINE, jiraTicketId: "JIRA-4321" });
    assert.equal(withTicket.result.jiraTicketId, "JIRA-4321", "ticket echoed onto the result");
    const without = await assessLocal(root);
    assert.equal(without.result.jiraTicketId, undefined, "no jiraTicketId key when not supplied");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Full Split A1: includeVersions opts INTO the connector menu", async () => {
  const root = makeLocalRepo();
  try {
    const { result, connectorChoices } = await assess({
      source: "local",
      repo: root,
      ...OFFLINE,
      includeVersions: true,
    });
    assert.ok(Array.isArray(result.connectorChoices), "connectorChoices attached when includeVersions");
    assert.ok(connectorChoices.length >= 1, "the menu is computed (matrix-only under noFetch)");
    const http = connectorChoices.find((c) => c.artifactId === "mule-http-connector");
    assert.ok(http && http.matrixSet, "menu carries the curated matrixSet pin");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Full Split A1: a non-min versionStrategy still computes choices even without includeVersions", async () => {
  const root = makeLocalRepo();
  try {
    const { connectorChoices } = await assess({
      source: "local",
      repo: root,
      ...OFFLINE,
      versionStrategy: "in-major",
    });
    // start_upgrade's path: the menu must exist so applyVersionStrategy can rewrite pins.
    assert.ok(connectorChoices.length >= 1, "choices computed for an active versionStrategy");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Full Split A2: resolveVersionsForApp is scoped to the app's connectors + populates current", async () => {
  const root = makeLocalRepo();
  try {
    const { choices, scope } = await resolveVersionsForApp({
      source: "local",
      repo: root,
      noFetch: true, // matrix-only, but still app-scoped + current-populated
      exchange: NO_EXCHANGE,
      anypointClient: NO_ANYPOINT,
    });
    // Scope: the app only references mule-http-connector, so the menu is just that one.
    assert.deepEqual(scope.only, ["mule-http-connector"], "scoped to the app's connectors");
    assert.equal(scope.currents["mule-http-connector"], "1.7.0", "current threaded into scope");
    assert.equal(choices.length, 1, "one choice — the whole matrix is NOT resolved");
    assert.equal(choices[0].artifactId, "mule-http-connector");
    assert.equal(choices[0].current, "1.7.0", "buildConnectorChoice.current is populated");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
