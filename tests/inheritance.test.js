// tests/inheritance.test.js — read-only nested parent/BOM detection used by the chained flow.
// Locks the "report what the pom inherits BEFORE any edit" behavior against the real repo shapes
// (customer-web-eapi-app -> solutions-parent-pom -> solutions-bom) plus a dependencyManagement import.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectInheritance,
  inheritanceSummary,
  coordLabel,
} from "../skills/mule-upgrade-parent-pom/scripts/lib/inheritance.js";

const GID = "2e14f8c6-4d60-481b-bfb6-798695efc8f4";

const BOM = [
  "<project>",
  `  <groupId>${GID}</groupId>`,
  "  <artifactId>solutions-bom</artifactId>",
  "  <name>solutions-bom</name>",
  "  <version>1.0.0-SNAPSHOT</version>",
  "  <packaging>pom</packaging>",
  "</project>",
].join("\n");

const PARENT_POM = [
  "<project>",
  "  <parent>",
  `    <groupId>${GID}</groupId>`,
  "    <artifactId>solutions-bom</artifactId>",
  "    <version>1.0.0-SNAPSHOT</version>",
  "    <relativePath>../bom/pom.xml</relativePath>",
  "  </parent>",
  `  <groupId>${GID}</groupId>`,
  "  <artifactId>solutions-parent-pom</artifactId>",
  "  <version>1.0.0-SNAPSHOT</version>",
  "  <packaging>pom</packaging>",
  "</project>",
].join("\n");

const APP = [
  "<project>",
  "  <parent>",
  `    <groupId>${GID}</groupId>`,
  "    <artifactId>solutions-parent-pom</artifactId>",
  "    <version>1.0.0-SNAPSHOT</version>",
  "    <relativePath>../parent-pom/pom.xml</relativePath>",
  "  </parent>",
  "  <artifactId>customer-web-eapi-app</artifactId>",
  "  <version>1.0.0-SNAPSHOT</version>",
  "  <packaging>mule-application</packaging>",
  "</project>",
].join("\n");

test("detectInheritance: BOM stands alone (no parent, no imports)", () => {
  const inh = detectInheritance(BOM);
  assert.equal(inh.parent, null);
  assert.deepEqual(inh.importedBoms, []);
  assert.equal(inh.inheritsFromShared, false);
  assert.equal(inheritanceSummary(inh), "");
});

test("detectInheritance: parent-pom inherits solutions-bom via <parent>", () => {
  const inh = detectInheritance(PARENT_POM);
  assert.equal(inh.inheritsFromShared, true);
  assert.equal(inh.parent.artifactId, "solutions-bom");
  assert.equal(inh.parent.version, "1.0.0-SNAPSHOT");
  assert.equal(inh.parent.relativePath, "../bom/pom.xml");
  assert.match(inheritanceSummary(inh), /inherits from parent .*solutions-bom:1\.0\.0-SNAPSHOT/);
});

test("detectInheritance: app inherits solutions-parent-pom via <parent>", () => {
  const inh = detectInheritance(APP);
  assert.equal(inh.parent.artifactId, "solutions-parent-pom");
  assert.equal(inh.inheritsFromShared, true);
});

test("detectInheritance: surfaces <dependencyManagement> BOM imports (scope=import)", () => {
  const pom = [
    "<project>",
    "  <artifactId>my-app</artifactId>",
    "  <version>1.0.0</version>",
    "  <dependencyManagement><dependencies>",
    "    <dependency>",
    `      <groupId>${GID}</groupId>`,
    "      <artifactId>imported-bom</artifactId>",
    "      <version>2.3.0</version>",
    "      <type>pom</type>",
    "      <scope>import</scope>",
    "    </dependency>",
    "  </dependencies></dependencyManagement>",
    "</project>",
  ].join("\n");
  const inh = detectInheritance(pom);
  assert.equal(inh.parent, null);
  assert.equal(inh.importedBoms.length, 1);
  assert.equal(inh.importedBoms[0].artifactId, "imported-bom");
  assert.equal(inh.importedBoms[0].version, "2.3.0");
  assert.equal(inh.inheritsFromShared, true);
  assert.match(inheritanceSummary(inh), /imports BOM .*imported-bom:2\.3\.0/);
});

test("coordLabel: joins present segments, skips missing", () => {
  assert.equal(coordLabel({ groupId: "g", artifactId: "a", version: "1" }), "g:a:1");
  assert.equal(coordLabel({ artifactId: "a" }), "a");
});
