// tests/assessment.test.js — parity tests for the assessment engine, ported 1:1 from the Mule
// app's dw-assessment-suite.xml so the Node port matches the DataWeave modules byte-for-behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePom } from "../skills/mule-upgrade-assess/scripts/lib/pom_parse.js";
import { normalizePath, initChain } from "../skills/mule-upgrade-assess/scripts/lib/pom_chain.js";
import { classifyTopology } from "../skills/mule-upgrade-assess/scripts/lib/topology.js";
import { lt } from "../lib_shared/semver.js";
import {
  computePropEdits,
  computePropEditsOverride,
  buildAssessmentResult,
  scanFlags,
} from "../skills/mule-upgrade-assess/scripts/lib/assess_engine.js";

// helper: a chain entry from raw XML (carries pomText so rehydrate re-parses it)
function entry(path, xml) {
  return { path, pom: parsePom(xml), pomText: xml };
}

// ── assessment :: lt (semver) ──────────────────────────────────────────────────────────
test("assessment-lt-semver", () => {
  assert.equal(lt("4.6.0", "4.9.18"), true);
  assert.equal(lt("4.9.18", "4.9.18"), false);
  assert.equal(lt("11", "17"), true);
  assert.equal(lt("4.10.0", "4.9.0"), false);
});

// ── computePropEdits — app-owned (inPlace resolveRule path) ─────────────────────────────
test("assessment-computePropEdits-app-owned", () => {
  const childText =
    "<project><properties><app.runtime>4.6.0</app.runtime><java.version>8</java.version><mule.maven.plugin.version>4.4.0</mule.maven.plugin.version></properties></project>";
  const chain = [entry("app/pom.xml", childText)];
  const matrix = {
    target: { runtime: "4.9.18", javaVersion: "17" },
    muleArtifact: { minMuleVersion: "4.9.0", javaSpecificationVersions: ["17"] },
    gating: {
      r: { property: "app.runtime", set: "4.9.18" },
      j: { property: "java.version", set: "17" },
      m: { property: "mule.maven.plugin.version", set: "4.5.0" },
    },
    connectors: [{ property: "muleHttpConnectorVersion", set: "1.11.3" }],
  };
  const result = computePropEdits(chain, matrix);
  assert.equal(result.length, 3);
  assert.equal(result.filter((e) => e.kind === "pomProperty").length, 3);
  assert.equal(result.filter((e) => e.file === "app/pom.xml").length, 3);
  assert.equal(result.filter((e) => e.property === "muleHttpConnectorVersion").length, 0);
});

// ── buildAssessmentResult — golden (property edits only) ────────────────────────────────
test("assessment-buildAssessmentResult-golden", () => {
  const childText =
    "<project><properties><app.runtime>4.6.0</app.runtime><java.version>8</java.version></properties></project>";
  const chain = [entry("app/pom.xml", childText)];
  const matrix = {
    target: { runtime: "4.9.18", javaVersion: "17" },
    muleArtifact: { minMuleVersion: "4.9.0", javaSpecificationVersions: ["17"] },
    gating: { r: { property: "app.runtime", set: "4.9.18" }, j: { property: "java.version", set: "17" } },
    connectors: [],
  };
  const result = buildAssessmentResult({
    matrix,
    chain,
    appPomText: childText,
    muleArtifactCurrent: null,
    muleArtifactPath: null,
    ciWorkflowText: null,
    ciWorkflowPath: null,
    appName: "myapp",
    topology: "PARENT_APP",
    headSha: "sha123",
    hasApiPolicies: false,
    customJavaFound: false,
    lookupFound: false,
    warnings: [],
  });
  assert.equal(result.appName, "myapp");
  assert.equal(result.currentRuntime, "4.6.0");
  assert.equal(result.currentJavaVersion, "8");
  assert.equal(result.changePlan.targetRuntime, "4.9.18");
  assert.equal(result.changePlan.topology, "PARENT_APP");
  assert.equal(result.changePlan.headSha, "sha123");
  assert.equal(result.changePlan.fileEdits.length, 2);
  assert.equal(result.changePlan.filesToChange.length, 1);
  assert.equal(result.changePlan.filesToChange[0], "app/pom.xml");
  assert.equal(result.warnings.length, 0);
});

// ── chained flow: parentRef folds a <parent> repoint into the app plan ──────────────────
test("buildAssessmentResult: parentRef folds a <parent> repoint into the app's own plan (first commit)", () => {
  const childText =
    "<project>" +
    "<parent><groupId>g</groupId><artifactId>solutions-parent-pom</artifactId><version>1.0.0-SNAPSHOT</version></parent>" +
    "<groupId>g</groupId><artifactId>customer-web-eapi-app</artifactId><version>1.0.0-SNAPSHOT</version>" +
    "<properties><app.runtime>4.6.0</app.runtime><java.version>8</java.version></properties>" +
    "</project>";
  const chain = [entry("customer-web-eapi/pom.xml", childText)];
  const matrix = {
    target: { runtime: "4.9.18", javaVersion: "17" },
    muleArtifact: { minMuleVersion: "4.9.0", javaSpecificationVersions: ["17"] },
    gating: { r: { property: "app.runtime", set: "4.9.18" }, j: { property: "java.version", set: "17" } },
    connectors: [],
  };
  const base = {
    matrix,
    chain,
    appPomText: childText,
    muleArtifactCurrent: null,
    muleArtifactPath: null,
    ciWorkflowText: null,
    ciWorkflowPath: null,
    appName: "customer-web-eapi-app",
    topology: "PARENT_APP",
    headSha: "s",
    hasApiPolicies: false,
    customJavaFound: false,
    lookupFound: false,
    warnings: [],
  };

  // (a) parentRef given + version differs → a pomParentVersion edit is folded into the SAME app pom.
  const withRef = buildAssessmentResult({
    ...base,
    parentRef: { artifactId: "solutions-parent-pom", toVersion: "1.1.0-SNAPSHOT" },
  });
  const pref = withRef.changePlan.fileEdits.find((e) => e.kind === "pomParentVersion");
  assert.ok(pref, "a pomParentVersion edit is emitted");
  assert.equal(pref.file, "customer-web-eapi/pom.xml", "edits the app's OWN pom, not the root");
  assert.equal(pref.from, "1.0.0-SNAPSHOT");
  assert.equal(pref.to, "1.1.0-SNAPSHOT");
  assert.equal(pref.artifactId, "solutions-parent-pom");
  // the app's own version bump is still present as an INDEPENDENT edit
  assert.ok(withRef.changePlan.fileEdits.some((e) => e.kind === "pomVersion" && e.to === "1.1.0-SNAPSHOT"));

  // (b) no parentRef → NO pomParentVersion edit (unchanged default behavior).
  const noRef = buildAssessmentResult({ ...base });
  assert.equal(noRef.changePlan.fileEdits.filter((e) => e.kind === "pomParentVersion").length, 0);

  // (c) parentRef artifact mismatch → NO edit (never touch a <parent> that isn't the target).
  const mismatch = buildAssessmentResult({
    ...base,
    parentRef: { artifactId: "some-other-pom", toVersion: "9.9.9" },
  });
  assert.equal(mismatch.changePlan.fileEdits.filter((e) => e.kind === "pomParentVersion").length, 0);

  // (d) parentRef version already equals current → NO edit (idempotent).
  const same = buildAssessmentResult({
    ...base,
    parentRef: { artifactId: "solutions-parent-pom", toVersion: "1.0.0-SNAPSHOT" },
  });
  assert.equal(same.changePlan.fileEdits.filter((e) => e.kind === "pomParentVersion").length, 0);
});

// ── shared-file warning under inPlace ──────────────────────────────────────────────────
test("assessment-shared-file-warning", () => {
  const childText = "<project><parent><relativePath>../../pom.xml</relativePath></parent></project>";
  const parentText = "<project><properties><app.runtime>4.6.0</app.runtime></properties></project>";
  const chain = [entry("modules/app/pom.xml", childText), entry("pom.xml", parentText)];
  const matrix = {
    target: { runtime: "4.9.18", javaVersion: "17" },
    muleArtifact: { minMuleVersion: "4.9.0", javaSpecificationVersions: ["17"] },
    gating: { r: { property: "app.runtime", set: "4.9.18" } },
    connectors: [],
  };
  const result = buildAssessmentResult({
    matrix,
    chain,
    appPomText: childText,
    muleArtifactCurrent: null,
    muleArtifactPath: null,
    ciWorkflowText: null,
    ciWorkflowPath: null,
    appName: "myapp",
    topology: "PARENT_APP",
    headSha: "sha123",
    hasApiPolicies: false,
    customJavaFound: false,
    lookupFound: false,
    warnings: [],
    pomEditStrategy: "inPlace",
  });
  assert.equal(result.changePlan.fileEdits[0].file, "pom.xml");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /WARNING/);
});

// ── appOverride retargets an inherited property edit onto the app pom ───────────────────
test("assessment-appOverride-retargets-to-app-pom", () => {
  const childText = "<project><parent><relativePath>../../pom.xml</relativePath></parent></project>";
  const parentText = "<project><properties><app.runtime>4.6.0</app.runtime></properties></project>";
  const chain = [entry("modules/app/pom.xml", childText), entry("pom.xml", parentText)];
  const matrix = {
    target: { runtime: "4.9.18", javaVersion: "17" },
    muleArtifact: { minMuleVersion: "4.9.0", javaSpecificationVersions: ["17"] },
    gating: { r: { property: "app.runtime", set: "4.9.18" } },
    connectors: [],
  };
  const result = buildAssessmentResult({
    matrix,
    chain,
    appPomText: childText,
    muleArtifactCurrent: null,
    muleArtifactPath: null,
    ciWorkflowText: null,
    ciWorkflowPath: null,
    appName: "myapp",
    topology: "PARENT_APP",
    headSha: "sha123",
    hasApiPolicies: false,
    customJavaFound: false,
    lookupFound: false,
    warnings: [],
  });
  assert.equal(result.changePlan.fileEdits[0].file, "modules/app/pom.xml");
  assert.equal(result.changePlan.fileEdits[0].addIfAbsent, true);
  assert.equal(result.warnings.length, 0);
});

// ── computePropEditsOverride pins declared connectors into the app pom ──────────────────
test("assessment-computePropEditsOverride-connectors", () => {
  const appText =
    "<project>" +
    "<properties/>" +
    "<dependencies>" +
    "<dependency><groupId>org.mule.connectors</groupId><artifactId>mule-http-connector</artifactId><version>${http.connector.version}</version></dependency>" +
    "<dependency><groupId>org.mule.modules</groupId><artifactId>mule-apikit-module</artifactId><version>1.6.0</version></dependency>" +
    "<dependency><groupId>org.mule.connectors</groupId><artifactId>mule-sockets-connector</artifactId></dependency>" +
    "</dependencies>" +
    "</project>";
  const chain = [entry("app/pom.xml", appText)];
  const matrix = {
    gating: {},
    connectors: [
      {
        property: "http.connector.version",
        set: "1.11.3",
        groupId: "org.mule.connectors",
        artifactId: "mule-http-connector",
      },
      {
        property: "apikit.version",
        set: "1.11.8",
        groupId: "org.mule.modules",
        artifactId: "mule-apikit-module",
      },
      {
        property: "sockets.version",
        set: "1.2.4",
        groupId: "org.mule.connectors",
        artifactId: "mule-sockets-connector",
      },
      {
        property: "db.version",
        set: "1.14.0",
        groupId: "org.mule.connectors",
        artifactId: "mule-db-connector",
      },
    ],
  };
  const result = computePropEditsOverride(chain, matrix);
  assert.equal(result.length, 2);
  assert.equal(
    result.filter(
      (e) =>
        e.kind === "pomProperty" &&
        e.property === "http.connector.version" &&
        e.to === "1.11.3" &&
        e.addIfAbsent === true
    ).length,
    1
  );
  assert.equal(
    result.filter(
      (e) => e.kind === "depVersion" && e.artifactId === "mule-apikit-module" && e.to === "1.11.8"
    ).length,
    1
  );
  assert.equal(result.filter((e) => (e.artifactId ?? "") === "mule-sockets-connector").length, 0);
  assert.equal(result.filter((e) => e.file === "app/pom.xml").length, 2);
  assert.equal(
    result.filter((e) => (e.artifactId ?? "") === "mule-db-connector" || (e.property ?? "") === "db.version")
      .length,
    0
  );
});

// ── classifyTopology ────────────────────────────────────────────────────────────────────
test("treeAnalysis-classifyTopology", () => {
  const appXml = "<project><properties><app.runtime>4.6.0</app.runtime></properties></project>";
  const standalone = classifyTopology([entry("pom.xml", appXml)], ["app.runtime"]);
  const parentApp = classifyTopology(
    [entry("app/pom.xml", appXml), entry("pom.xml", "<project/>")],
    ["app.runtime"]
  );
  assert.equal(standalone.topology, "APP_STANDALONE");
  assert.equal(parentApp.topology, "PARENT_APP");
  assert.equal(parentApp.ownerByProperty["app.runtime"], "app/pom.xml");
});

// ── normalizePath + initChain ───────────────────────────────────────────────────────────
test("pomChain-normalizePath-and-initChain", () => {
  const appXml = "<project><parent><relativePath>../pom.xml</relativePath></parent></project>";
  const b64 = Buffer.from(appXml, "utf8").toString("base64");
  // initChain in the Node port takes decoded text; decode here to mirror the DWL decode step.
  const decoded = Buffer.from(b64, "base64").toString("utf8");
  const chainInit = initChain(decoded, "modules/app/pom.xml", [
    "modules/app/pom.xml",
    "modules/pom.xml",
    "pom.xml",
  ]);
  assert.equal(normalizePath("a/b/pom.xml", "../pom.xml"), "a/pom.xml");
  assert.equal(normalizePath("a/b/c/pom.xml", "../../pom.xml"), "a/pom.xml");
  assert.equal(chainInit.nextParentPath, "modules/pom.xml");
  assert.equal(chainInit.chain[0].path, "modules/app/pom.xml");
  assert.equal(chainInit.appPomText.includes("<project>"), true);
});

// ── scanFlags ───────────────────────────────────────────────────────────────────────────
test("assessment-scanFlags", () => {
  const treeJava = {
    truncated: false,
    tree: [
      { path: "src/main/java/Foo.java", type: "blob" },
      { path: "pom.xml", type: "blob" },
    ],
  };
  const withJava = scanFlags(treeJava, "<project/>");
  const treeLookup = { truncated: false, tree: [{ path: "pom.xml", type: "blob" }] };
  const withLookup = scanFlags(treeLookup, "<project>lookup(</project>");
  assert.equal(withJava.customJavaFound, true);
  assert.equal(withJava.warnings.length, 1);
  assert.equal(withJava.lookupFound, false);
  assert.equal(withLookup.lookupFound, true);
  assert.equal(withLookup.customJavaFound, false);
});

// ── EPIC F: content-based manualReview scans (setAccessible / ResourceBundle / powermock) ─
test("scanFlags: manualReview scanRegex hits Java source content via readFile", () => {
  const manualReview = {
    setAccessible: { scanRegex: "setAccessible\\s*\\(", warn: "SET_ACCESSIBLE" },
    resourceBundle: { scanRegex: "ResourceBundle\\.getBundle", warn: "RESOURCE_BUNDLE" },
    powermock: { scanRegex: "(?:org\\.powermock|powermock-)", warn: "POWERMOCK" },
  };
  const tree = {
    truncated: false,
    tree: [
      { path: "pom.xml", type: "blob" },
      { path: "src/main/java/Foo.java", type: "blob" },
    ],
  };
  const files = {
    "src/main/java/Foo.java": "class Foo { void m(){ f.setAccessible(true); ResourceBundle.getBundle(\"m\"); } }",
  };
  const flags = scanFlags(tree, "<project><dependency>org.powermock</dependency></project>", {
    manualReview,
    readFile: (rel) => files[rel] ?? null,
  });
  assert.ok(flags.warnings.includes("SET_ACCESSIBLE"), "setAccessible from java source");
  assert.ok(flags.warnings.includes("RESOURCE_BUNDLE"), "ResourceBundle from java source");
  assert.ok(flags.warnings.includes("POWERMOCK"), "powermock from pom text");
});

test("scanFlags: each manualReview warn is emitted at most once", () => {
  const manualReview = { s: { scanRegex: "setAccessible", warn: "SA" } };
  const tree = {
    truncated: false,
    tree: [
      { path: "a.java", type: "blob" },
      { path: "b.java", type: "blob" },
    ],
  };
  const flags = scanFlags(tree, "<project/>", {
    manualReview,
    readFile: () => "setAccessible(x); setAccessible(y);",
  });
  assert.equal(flags.warnings.filter((w) => w === "SA").length, 1);
});

test("scanFlags: no manualReview + no readFile behaves like the legacy signature", () => {
  const tree = { truncated: false, tree: [{ path: "pom.xml", type: "blob" }] };
  const flags = scanFlags(tree, "<project>setAccessible(</project>");
  assert.equal(flags.customJavaFound, false);
  // Without a manualReview block nothing content-scans → no extra warnings.
  assert.equal(flags.warnings.length, 0);
});

// ── EPIC F: CUSTOM_CONNECTOR topology + checklist ─────────────────────────────────────────
test("isCustomConnector + customConnectorWarnings for a mule-extension project", async () => {
  const { isCustomConnector, customConnectorWarnings } = await import(
    "../skills/mule-upgrade-assess/scripts/lib/assess_engine.js"
  );
  const ext = [entry("pom.xml", "<project><packaging>mule-extension</packaging></project>")];
  const parented = [
    entry("pom.xml", "<project><parent><artifactId>mule-java-extension-parent</artifactId></parent></project>"),
  ];
  const plainApp = [entry("pom.xml", "<project><packaging>mule-application</packaging></project>")];
  assert.equal(isCustomConnector(ext), true);
  assert.equal(isCustomConnector(parented), true);
  assert.equal(isCustomConnector(plainApp), false);
  const w = customConnectorWarnings("my-conn");
  assert.ok(w.some((l) => l.includes("@JavaVersionSupport")));
  assert.ok(w.some((l) => l.includes("mule-sdk-api")));
});

test("buildAssessmentResult: mule-extension project → topology CUSTOM_CONNECTOR + checklist warnings", () => {
  const appText =
    "<project xmlns='http://maven.apache.org/POM/4.0.0'>" +
    "<packaging>mule-extension</packaging>" +
    "<properties><app.runtime>4.6.0</app.runtime></properties></project>";
  const chain = [entry("pom.xml", appText)];
  const matrix = {
    target: { runtime: "4.9.18", javaVersion: "17" },
    muleArtifact: { minMuleVersion: "4.9.0", javaSpecificationVersions: ["17"] },
    gating: { r: { property: "app.runtime", set: "4.9.18" } },
    connectors: [],
  };
  const res = buildAssessmentResult({
    matrix,
    chain,
    appPomText: appText,
    muleArtifactCurrent: null,
    appName: "my-conn",
    topology: "APP_STANDALONE",
  });
  assert.equal(res.changePlan.topology, "CUSTOM_CONNECTOR");
  assert.ok(res.warnings.some((w) => w.includes("connector-upgrade path")));
});

// ── rehydrate from pomText (connector pin survives a collapsed parsed .pom) ─────────────
test("assessment-buildAssessmentResult-rehydrates-from-pomText", () => {
  const appText =
    "<project xmlns='http://maven.apache.org/POM/4.0.0'>" +
    "<properties/>" +
    "<build><plugins><plugin><groupId>com.mulesoft.munit.tools</groupId><artifactId>munit-maven-plugin</artifactId><version>${munit.version}</version></plugin></plugins></build>" +
    "<dependencies>" +
    "<dependency><groupId>com.mulesoft.munit</groupId><artifactId>munit-runner</artifactId><classifier>mule-plugin</classifier><scope>test</scope></dependency>" +
    "<dependency><groupId>org.mule.connectors</groupId><artifactId>mule-http-connector</artifactId><version>1.6.0</version><classifier>mule-plugin</classifier></dependency>" +
    "<dependency><groupId>org.mule.connectors</groupId><artifactId>mule-vm-connector</artifactId><classifier>mule-plugin</classifier></dependency>" +
    "</dependencies>" +
    "</project>";
  // Deliberately collapsed parsed pom (no dependencies) — pomText carries the real deps.
  const collapsedPom = parsePom("<project xmlns='http://maven.apache.org/POM/4.0.0'><properties/></project>");
  const chain = [{ path: "pom.xml", pom: collapsedPom, pomText: appText }];
  const matrix = {
    target: { runtime: "4.9.18", javaVersion: "17" },
    gating: {
      munit: {
        property: "munit.version",
        min: "3.6.3",
        set: "3.6.3",
        groupId: "com.mulesoft.munit",
        artifactId: "munit-runner",
        pluginGroupId: "com.mulesoft.munit.tools",
        pluginArtifactId: "munit-maven-plugin",
      },
    },
    connectors: [
      {
        property: "http.connector.version",
        set: "1.11.3",
        groupId: "org.mule.connectors",
        artifactId: "mule-http-connector",
      },
    ],
    muleArtifact: { minMuleVersion: "4.9.0", javaSpecificationVersions: ["17"] },
  };
  const result = buildAssessmentResult({
    matrix,
    chain,
    appPomText: appText,
    muleArtifactCurrent: null,
    muleArtifactPath: "mule-artifact.json",
    ciWorkflowText: null,
    ciWorkflowPath: null,
    appName: "collapse-app",
    topology: "APP_STANDALONE",
    headSha: "sha",
    hasApiPolicies: false,
    customJavaFound: false,
    lookupFound: false,
    warnings: [],
    pomEditStrategy: "appOverride",
    excludeArtifacts: ["munit-runner", "munit-tools"],
  });
  const edits = result.changePlan.fileEdits ?? [];
  assert.equal(
    edits.filter(
      (e) =>
        (e.kind ?? "") === "depVersion" && (e.artifactId ?? "") === "mule-http-connector" && e.to === "1.11.3"
    ).length,
    1
  );
  assert.equal(
    (result.changePlan.missingFromMatrix ?? []).filter((e) => (e.artifactId ?? "") === "mule-vm-connector")
      .length,
    1
  );
});

// ── pomVersion minor bump emitted when other edits exist ────────────────────────────────
test("assessment-emits-pomVersion-minor-bump", () => {
  const childText =
    "<project><artifactId>my-app</artifactId><version>1.0.0-SNAPSHOT</version><properties><app.runtime>4.6.0</app.runtime></properties></project>";
  const chain = [entry("app/pom.xml", childText)];
  const matrix = {
    target: { runtime: "4.9.18", javaVersion: "17" },
    muleArtifact: { minMuleVersion: "4.9.0", javaSpecificationVersions: ["17"] },
    gating: { r: { property: "app.runtime", set: "4.9.18" } },
    connectors: [],
  };
  const result = buildAssessmentResult({
    matrix,
    chain,
    appPomText: childText,
    muleArtifactCurrent: null,
    muleArtifactPath: null,
    ciWorkflowText: null,
    ciWorkflowPath: null,
    appName: "my-app",
    topology: "APP_STANDALONE",
    headSha: "sha",
    hasApiPolicies: false,
    customJavaFound: false,
    lookupFound: false,
    warnings: [],
  });
  const pv = result.changePlan.fileEdits.filter((e) => e.kind === "pomVersion");
  assert.equal(pv.length, 1);
  assert.equal(pv[0].to, "1.1.0-SNAPSHOT");
  assert.equal(pv[0].file, "app/pom.xml");
});

// ── no pomVersion when nothing else changes ─────────────────────────────────────────────
test("assessment-no-pomVersion-when-no-changes", () => {
  const childText =
    "<project><artifactId>my-app</artifactId><version>1.0.0-SNAPSHOT</version><properties><app.runtime>4.9.18</app.runtime></properties></project>";
  const chain = [entry("app/pom.xml", childText)];
  const matrix = {
    target: { runtime: "4.9.18", javaVersion: "17" },
    muleArtifact: { minMuleVersion: "4.9.0", javaSpecificationVersions: ["17"] },
    gating: { r: { property: "app.runtime", set: "4.9.18" } },
    connectors: [],
  };
  const result = buildAssessmentResult({
    matrix,
    chain,
    appPomText: childText,
    muleArtifactCurrent: null,
    muleArtifactPath: null,
    ciWorkflowText: null,
    ciWorkflowPath: null,
    appName: "my-app",
    topology: "APP_STANDALONE",
    headSha: "sha",
    hasApiPolicies: false,
    customJavaFound: false,
    lookupFound: false,
    warnings: [],
  });
  assert.equal(result.changePlan.fileEdits.filter((e) => e.kind === "pomVersion").length, 0);
});
