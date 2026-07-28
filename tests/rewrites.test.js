// tests/rewrites.test.js — parity tests for the 8 rewrite modules + applyEdits ordering.
import { test } from "node:test";
import assert from "node:assert/strict";

import { rewritePomProperties } from "../skills/mule-upgrade-apply/scripts/rewrites/pom_properties.js";
import { rewriteDepVersions } from "../skills/mule-upgrade-apply/scripts/rewrites/dep_versions.js";
import { rewritePluginVersions } from "../skills/mule-upgrade-apply/scripts/rewrites/plugin_versions.js";
import { rewritePomVersion } from "../skills/mule-upgrade-apply/scripts/rewrites/pom_version.js";
import { rewriteMunitRuntime } from "../skills/mule-upgrade-apply/scripts/rewrites/munit_runtime.js";
import { rewriteMuleArtifact } from "../skills/mule-upgrade-apply/scripts/rewrites/mule_artifact.js";
import { rewriteCiWorkflow } from "../skills/mule-upgrade-apply/scripts/rewrites/ci_workflow.js";
import { rewriteMunitArgLines } from "../skills/mule-upgrade-apply/scripts/rewrites/munit_arglines.js";
import {
  rewriteParentPom,
  rewriteParentRefVersion,
} from "../skills/mule-upgrade-apply/scripts/rewrites/parent_pom.js";
import { applyEdits } from "../skills/mule-upgrade-apply/scripts/apply_edits.js";

test("pom_properties: replace existing value, preserve other bytes", () => {
  const pom = `<project>\n  <properties>\n    <java.version>11</java.version>\n    <other.prop>keep</other.prop>\n  </properties>\n</project>`;
  const out = rewritePomProperties(pom, [{ property: "java.version", to: "17" }]);
  assert.match(out, /<java\.version>17<\/java\.version>/);
  assert.match(out, /<other\.prop>keep<\/other\.prop>/);
});

test("pom_properties: addIfAbsent inserts into existing <properties>", () => {
  const pom = `<project>\n  <properties>\n    <a>1</a>\n  </properties>\n</project>`;
  const out = rewritePomProperties(pom, [{ property: "java.version", to: "17", addIfAbsent: true }]);
  assert.match(out, /<java\.version>17<\/java\.version>\n {2}<\/properties>/);
});

test("pom_properties: addIfAbsent creates <properties> when none exists", () => {
  const pom = `<project>\n  <artifactId>x</artifactId>\n</project>`;
  const out = rewritePomProperties(pom, [{ property: "java.version", to: "17", addIfAbsent: true }]);
  assert.match(out, /<properties>\n {4}<java\.version>17<\/java\.version>\n {2}<\/properties>/);
});

test("pom_properties: addIfAbsent does NOT duplicate when tag present", () => {
  const pom = `<project>\n  <properties>\n    <java.version>11</java.version>\n  </properties>\n</project>`;
  const out = rewritePomProperties(pom, [{ property: "java.version", to: "17", addIfAbsent: true }]);
  assert.equal((out.match(/<java\.version>/g) || []).length, 1);
  assert.match(out, /<java\.version>17<\/java\.version>/);
});

test("dep_versions: replace inline version", () => {
  const pom = `<dependency><groupId>org.mule.connectors</groupId><artifactId>mule-http-connector</artifactId><version>1.5.0</version></dependency>`;
  const out = rewriteDepVersions(pom, [
    { groupId: "org.mule.connectors", artifactId: "mule-http-connector", to: "1.11.3" },
  ]);
  assert.match(out, /<version>1\.11\.3<\/version>/);
});

test("dep_versions: insert version for BOM-managed dep (no version)", () => {
  const pom = `<dependency><groupId>org.mule.connectors</groupId><artifactId>mule-http-connector</artifactId></dependency>`;
  const out = rewriteDepVersions(pom, [
    { groupId: "org.mule.connectors", artifactId: "mule-http-connector", to: "1.11.3" },
  ]);
  assert.match(out, /<\/artifactId>\n {12}<version>1\.11\.3<\/version>/);
});

test("dep_versions: unmatched dependency untouched", () => {
  const pom = `<dependency><groupId>x</groupId><artifactId>y</artifactId><version>1.0.0</version></dependency>`;
  const out = rewriteDepVersions(pom, [{ groupId: "a", artifactId: "b", to: "9.9.9" }]);
  assert.equal(out, pom);
});

test("plugin_versions: replace only plugin's own first version, not nested dep", () => {
  const pom = `<plugin><groupId>com.mulesoft.munit.tools</groupId><artifactId>munit-maven-plugin</artifactId><version>3.1.0</version><dependencies><dependency><artifactId>z</artifactId><version>0.0.1</version></dependency></dependencies></plugin>`;
  const out = rewritePluginVersions(pom, [
    { pluginArtifactId: "munit-maven-plugin", pluginGroupId: "com.mulesoft.munit.tools", to: "3.6.3" },
  ]);
  assert.match(out, /munit-maven-plugin<\/artifactId><version>3\.6\.3<\/version>/);
  assert.match(out, /<artifactId>z<\/artifactId><version>0\.0\.1<\/version>/); // nested untouched
});

test("pom_version: bump own version only when it follows own artifactId", () => {
  const pom = `<project><parent><artifactId>parent-x</artifactId><version>1.0.0</version></parent><artifactId>my-app</artifactId><version>2.3.4</version></project>`;
  const out = rewritePomVersion(pom, "my-app", "2.4.0");
  assert.match(out, /<artifactId>my-app<\/artifactId><version>2\.4\.0<\/version>/);
  assert.match(out, /<artifactId>parent-x<\/artifactId><version>1\.0\.0<\/version>/); // parent untouched
});

test("munit_runtime: replace all runtimeVersion", () => {
  const pom = `<configuration><runtimeVersion>4.6.0</runtimeVersion></configuration>`;
  assert.match(rewriteMunitRuntime(pom, "4.9.18"), /<runtimeVersion>4\.9\.18<\/runtimeVersion>/);
});

test("mule_artifact: preserve other keys, set minMuleVersion + add javaSpecificationVersions", () => {
  const json = JSON.stringify({ minMuleVersion: "4.4.0", secureProperties: ["a"] });
  const out = JSON.parse(rewriteMuleArtifact(json, "4.9.0", ["17"]));
  assert.equal(out.minMuleVersion, "4.9.0");
  assert.deepEqual(out.javaSpecificationVersions, ["17"]);
  assert.deepEqual(out.secureProperties, ["a"]);
});

test("ci_workflow: bump setup-java version preserving quotes", () => {
  assert.equal(rewriteCiWorkflow("java-version: '11'", "17"), "java-version: '17'");
  assert.equal(rewriteCiWorkflow('java-version: "8"', "17"), 'java-version: "17"');
  assert.equal(rewriteCiWorkflow("java-version: 11", "17"), "java-version: 17");
});

test("munit_arglines: strip JPMS argLine in munit plugin only, drop empty wrapper", () => {
  const pom = `<plugin><artifactId>munit-maven-plugin</artifactId><configuration><argLines><argLine>--add-opens java.base/java.lang=ALL-UNNAMED</argLine></argLines></configuration></plugin>`;
  const out = rewriteMunitArgLines(pom, ["--add-opens", "--add-exports", "--add-modules"]);
  assert.doesNotMatch(out, /--add-opens/);
  assert.doesNotMatch(out, /<argLines>/); // empty wrapper removed
});

test("munit_arglines: non-munit plugin argLine untouched", () => {
  const pom = `<plugin><artifactId>some-other-plugin</artifactId><configuration><argLines><argLine>--add-opens foo</argLine></argLines></configuration></plugin>`;
  assert.equal(rewriteMunitArgLines(pom, ["--add-opens"]), pom);
});

test("parent_pom: pin managed connector property + bump own version", () => {
  const matrix = {
    connectors: [
      {
        property: "http.connector.version",
        set: "1.11.3",
        groupId: "org.mule.connectors",
        artifactId: "mule-http-connector",
      },
    ],
  };
  const pom = `<project><artifactId>my-bom</artifactId><version>1.0.0</version><properties><http.connector.version>1.5.0</http.connector.version></properties><dependencyManagement><dependencies><dependency><groupId>org.mule.connectors</groupId><artifactId>mule-http-connector</artifactId><version>\${http.connector.version}</version></dependency></dependencies></dependencyManagement></project>`;
  const { text, edits } = rewriteParentPom(pom, matrix, "pom.xml");
  assert.match(text, /<http\.connector\.version>1\.11\.3<\/http\.connector\.version>/);
  assert.match(text, /<artifactId>my-bom<\/artifactId><version>1\.1\.0<\/version>/);
  assert.equal(
    edits.some((e) => e.kind === "pomVersion"),
    true
  );
});

test("parent_pom: no change when already compliant → no version bump", () => {
  const matrix = {
    connectors: [
      {
        property: "http.connector.version",
        set: "1.11.3",
        groupId: "org.mule.connectors",
        artifactId: "mule-http-connector",
      },
    ],
  };
  const pom = `<project><artifactId>my-bom</artifactId><version>1.0.0</version><properties><http.connector.version>1.11.3</http.connector.version></properties></project>`;
  const { text, edits } = rewriteParentPom(pom, matrix, "pom.xml");
  assert.equal(edits.length, 0);
  assert.equal(text, pom);
});

test("pom_version: bump own version even when <name>/comment sits between artifactId and version", () => {
  // Real Exchange BOM shape: <name> (and comments) interpose between <artifactId> and <version>.
  // The old adjacency-only regex silently skipped this; the relaxed matcher must still land the bump.
  const pom = [
    "<project>",
    "  <groupId>2e14f8c6</groupId>",
    "  <artifactId>solutions-bom</artifactId>",
    "  <!-- Exchange demands a name for deployment -->",
    "  <name>solutions-bom</name>",
    "  <!-- Exchange NON-SNAPSHOT version for deployment -->",
    "  <version>1.0.0-SNAPSHOT</version>",
    "  <packaging>pom</packaging>",
    "</project>",
  ].join("\n");
  const out = rewritePomVersion(pom, "solutions-bom", "1.1.0-SNAPSHOT");
  assert.match(out, /<version>1\.1\.0-SNAPSHOT<\/version>/);
  assert.match(out, /<name>solutions-bom<\/name>/); // interposed node preserved
  assert.match(out, /<packaging>pom<\/packaging>/);
});

test("parent_pom: BOM with <name> before <version> → pins connector AND bumps own SNAPSHOT version", () => {
  const matrix = {
    connectors: [
      {
        property: "http.connector.version",
        set: "1.11.3",
        groupId: "org.mule.connectors",
        artifactId: "mule-http-connector",
      },
    ],
  };
  // solutions-bom: <name> + comments interpose before <version>, version carries -SNAPSHOT.
  const pom = [
    "<project>",
    "  <groupId>2e14f8c6</groupId>",
    "  <artifactId>solutions-bom</artifactId>",
    "  <name>solutions-bom</name>",
    "  <version>1.0.0-SNAPSHOT</version>",
    "  <packaging>pom</packaging>",
    "  <properties><http.connector.version>1.5.0</http.connector.version></properties>",
    "</project>",
  ].join("\n");
  const { text, edits } = rewriteParentPom(pom, matrix, "pom.xml");
  assert.match(text, /<http\.connector\.version>1\.11\.3<\/http\.connector\.version>/);
  assert.match(text, /<version>1\.1\.0-SNAPSHOT<\/version>/); // own version bumped (was the bug)
  const verEdit = edits.find((e) => e.kind === "pomVersion");
  assert.ok(verEdit && verEdit.from === "1.0.0-SNAPSHOT" && verEdit.to === "1.1.0-SNAPSHOT");
});

test("parent_pom: a LATER plugin <version>${...}</version> must NOT hijack the own-version bump", () => {
  // The exact production BOM shape that broke: comment + <name> + comment between <artifactId> and
  // the real <version>, and a plugin <version>${google.replacer.plugin.version}</version> further down.
  // The greedy interposed-run used to swallow the real line-17 version and latch onto the plugin
  // placeholder → projectCoords saw a ${...} version → own-version bump silently skipped. The excluded
  // <version> lookahead pins detection to the project's own version.
  const matrix = {
    connectors: [
      { property: "http.connector.version", set: "1.11.3", groupId: "org.mule.connectors", artifactId: "mule-http-connector" },
    ],
  };
  const pom = [
    "<project>",
    "  <modelVersion>4.0.0</modelVersion>",
    "  <groupId>2e14f8c6</groupId>",
    "  <artifactId>solutions-bom</artifactId>",
    "  <!-- Exchange demands a name for deployment -->",
    "  <name>solutions-bom</name>",
    "  <!-- Exchange NON-SNAPSHOT version for deployment -->",
    "  <version>1.0.0-SNAPSHOT</version>",
    "  <packaging>pom</packaging>",
    "  <properties>",
    "    <http.connector.version>1.5.0</http.connector.version>",
    "    <google.replacer.plugin.version>1.5.3</google.replacer.plugin.version>",
    "  </properties>",
    "  <build><plugins><plugin>",
    "    <groupId>com.google.code.maven-replacer-plugin</groupId>",
    "    <artifactId>replacer</artifactId>",
    "    <version>${google.replacer.plugin.version}</version>",
    "  </plugin></plugins></build>",
    "</project>",
  ].join("\n");
  const { text, edits } = rewriteParentPom(pom, matrix, "bom/pom.xml");
  const verEdit = edits.find((e) => e.kind === "pomVersion");
  assert.ok(verEdit, "own-version bump must fire");
  assert.equal(verEdit.from, "1.0.0-SNAPSHOT");
  assert.equal(verEdit.to, "1.1.0-SNAPSHOT");
  assert.match(text, /<version>1\.1\.0-SNAPSHOT<\/version>/); // project version bumped
  assert.match(text, /<version>\$\{google\.replacer\.plugin\.version\}<\/version>/); // plugin version untouched
  assert.match(text, /<http\.connector\.version>1\.11\.3<\/http\.connector\.version>/);
});

test("parent_pom: parent-pom with a <parent> block isolates OWN coords and bumps own version", () => {
  const matrix = {
    connectors: [
      {
        property: "http.connector.version",
        set: "1.11.3",
        groupId: "org.mule.connectors",
        artifactId: "mule-http-connector",
      },
    ],
  };
  // solutions-parent-pom: inherits solutions-bom via <parent>; its OWN version follows its artifactId.
  const pom = [
    "<project>",
    "  <parent>",
    "    <groupId>2e14f8c6</groupId>",
    "    <artifactId>solutions-bom</artifactId>",
    "    <version>1.0.0-SNAPSHOT</version>",
    "    <relativePath>../bom/pom.xml</relativePath>",
    "  </parent>",
    "  <groupId>2e14f8c6</groupId>",
    "  <artifactId>solutions-parent-pom</artifactId>",
    "  <version>1.0.0-SNAPSHOT</version>",
    "  <packaging>pom</packaging>",
    "  <name>solutions-parent-pom</name>",
    "  <properties><http.connector.version>1.5.0</http.connector.version></properties>",
    "</project>",
  ].join("\n");
  const { text, edits } = rewriteParentPom(pom, matrix, "pom.xml");
  // own version bumped, but the <parent> (solutions-bom) reference is NOT touched by this path
  const verEdit = edits.find((e) => e.kind === "pomVersion");
  assert.equal(verEdit?.artifactId, "solutions-parent-pom");
  assert.match(text, /<artifactId>solutions-parent-pom<\/artifactId>\s*<version>1\.1\.0-SNAPSHOT<\/version>/);
  assert.match(text, /<artifactId>solutions-bom<\/artifactId>\s*<version>1\.0\.0-SNAPSHOT<\/version>/); // parent ref intact
});

test("rewriteParentRefVersion: repoints the <parent> version, leaves own coords untouched", () => {
  const pom = [
    "<project>",
    "  <parent>",
    "    <groupId>g</groupId>",
    "    <artifactId>solutions-bom</artifactId>",
    "    <version>1.0.0-SNAPSHOT</version>",
    "  </parent>",
    "  <artifactId>solutions-parent-pom</artifactId>",
    "  <version>1.0.0-SNAPSHOT</version>",
    "</project>",
  ].join("\n");
  const out = rewriteParentRefVersion(pom, { artifactId: "solutions-bom" }, "1.1.0-SNAPSHOT");
  assert.match(out, /<artifactId>solutions-bom<\/artifactId>\s*<version>1\.1\.0-SNAPSHOT<\/version>/);
  assert.match(out, /<artifactId>solutions-parent-pom<\/artifactId>\s*<version>1\.0\.0-SNAPSHOT<\/version>/);
});

test("rewriteParentRefVersion: no-op when the parent artifactId does not match", () => {
  const pom = "<project><parent><artifactId>other</artifactId><version>1.0.0</version></parent></project>";
  assert.equal(rewriteParentRefVersion(pom, { artifactId: "solutions-bom" }, "9.9.9"), pom);
});

test("rewriteParentPom (chained): repoint parent + force own bump with NO connector edits", () => {
  const matrix = { connectors: [] };
  const pom = [
    "<project>",
    "  <parent>",
    "    <groupId>g</groupId>",
    "    <artifactId>solutions-bom</artifactId>",
    "    <version>1.0.0-SNAPSHOT</version>",
    "  </parent>",
    "  <artifactId>solutions-parent-pom</artifactId>",
    "  <version>1.0.0-SNAPSHOT</version>",
    "  <packaging>pom</packaging>",
    "</project>",
  ].join("\n");
  const { text, edits } = rewriteParentPom(pom, matrix, "parent-pom/pom.xml", {
    parentRef: { artifactId: "solutions-bom", toVersion: "1.1.0-SNAPSHOT" },
    bumpOwnVersion: true,
  });
  // parent ref bumped to the new BOM version
  assert.match(text, /<artifactId>solutions-bom<\/artifactId>\s*<version>1\.1\.0-SNAPSHOT<\/version>/);
  // own version minor-bumped even though zero connectors changed
  assert.match(text, /<artifactId>solutions-parent-pom<\/artifactId>\s*<version>1\.1\.0-SNAPSHOT<\/version>/);
  const parentRefEdit = edits.find((e) => e.kind === "pomParentVersion");
  const verEdit = edits.find((e) => e.kind === "pomVersion");
  assert.ok(parentRefEdit && parentRefEdit.from === "1.0.0-SNAPSHOT" && parentRefEdit.to === "1.1.0-SNAPSHOT");
  assert.ok(verEdit && verEdit.artifactId === "solutions-parent-pom" && verEdit.to === "1.1.0-SNAPSHOT");
});

test("rewriteParentPom (chained): placeholder own version is NOT literal-bumped even if forced", () => {
  const pom = [
    "<project>",
    "  <parent><artifactId>solutions-bom</artifactId><version>1.0.0</version></parent>",
    "  <artifactId>p</artifactId>",
    "  <version>${revision}</version>",
    "</project>",
  ].join("\n");
  const { text, edits } = rewriteParentPom(pom, { connectors: [] }, "pom.xml", {
    parentRef: { artifactId: "solutions-bom", toVersion: "1.1.0" },
    bumpOwnVersion: true,
  });
  assert.match(text, /<artifactId>solutions-bom<\/artifactId><version>1\.1\.0<\/version>/); // parent ref bumped
  assert.match(text, /<version>\$\{revision\}<\/version>/); // own placeholder untouched
  assert.equal(edits.some((e) => e.kind === "pomVersion"), false);
});

test("applyEdits: runs mixed kinds in fixed order", () => {
  const pom = `<project><artifactId>my-app</artifactId><version>1.0.0</version><properties><java.version>11</java.version></properties><dependencies><dependency><groupId>org.mule.connectors</groupId><artifactId>mule-http-connector</artifactId><version>1.5.0</version></dependency></dependencies></project>`;
  const edits = [
    { kind: "pomProperty", property: "java.version", to: "17" },
    { kind: "depVersion", groupId: "org.mule.connectors", artifactId: "mule-http-connector", to: "1.11.3" },
    { kind: "pomVersion", artifactId: "my-app", to: "1.1.0" },
  ];
  const out = applyEdits(pom, edits);
  assert.match(out, /<java\.version>17<\/java\.version>/);
  assert.match(out, /mule-http-connector<\/artifactId><version>1\.11\.3<\/version>/);
  assert.match(out, /<artifactId>my-app<\/artifactId><version>1\.1\.0<\/version>/);
});
