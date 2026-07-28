// Regression tests for applyChangePlan's reader contract.
//
// Guards the api-mode "FAILED_COMMIT: The \"path\" argument must be of type string. Received undefined"
// bug: in api mode there is no local clone (repoRoot === undefined), so applyChangePlan MUST be given
// a reader. It must also await an async (GitHub Contents) reader, not just a sync fs reader.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChangePlan, applyEdits } from "../skills/mule-upgrade-apply/scripts/apply_edits.js";

const POM = "<project><properties><java.version>8</java.version></properties></project>";

test("applyChangePlan awaits an ASYNC reader (api mode: no local clone)", async () => {
  const plan = {
    fileEdits: [{ file: "pom.xml", kind: "pomProperty", property: "java.version", from: "8", to: "17" }],
  };
  // async reader like the GitHub Contents one — repoRoot is undefined (no clone)
  const ghReader = async (p) => (p === "pom.xml" ? POM : "");
  const staged = await applyChangePlan(plan, undefined, ghReader);
  assert.equal(staged.length, 1);
  assert.equal(staged[0].path, "pom.xml");
  assert.match(staged[0].content, /<java\.version>17<\/java\.version>/);
});

test("applyChangePlan still works with a SYNC reader (local clone)", async () => {
  const plan = {
    fileEdits: [{ file: "pom.xml", kind: "pomProperty", property: "java.version", to: "17" }],
  };
  const staged = await applyChangePlan(plan, undefined, () => POM);
  assert.match(staged[0].content, /<java\.version>17<\/java\.version>/);
});

test("applyChangePlan with NO reader AND no repoRoot throws the path/undefined error (documents the trap)", async () => {
  const plan = { fileEdits: [{ file: "pom.xml", kind: "pomProperty", property: "java.version", to: "17" }] };
  await assert.rejects(
    () => applyChangePlan(plan, undefined),
    /path.*must be of type string|Received undefined/i
  );
});

test("applyEdits: pomParentVersion repoints ONLY the <parent> version, leaving the project's own version", () => {
  const pom = [
    "<project>",
    "  <parent>",
    "    <groupId>g</groupId>",
    "    <artifactId>solutions-parent-pom</artifactId>",
    "    <version>1.0.0-SNAPSHOT</version>",
    "  </parent>",
    "  <artifactId>customer-web-eapi-app</artifactId>",
    "  <version>1.1.0-SNAPSHOT</version>",
    "</project>",
  ].join("\n");
  const out = applyEdits(pom, [
    { kind: "pomParentVersion", artifactId: "solutions-parent-pom", from: "1.0.0-SNAPSHOT", to: "1.1.0-SNAPSHOT" },
  ]);
  // <parent> repointed …
  assert.match(
    out,
    /<artifactId>solutions-parent-pom<\/artifactId>\s*<version>1\.1\.0-SNAPSHOT<\/version>/
  );
  // … and the project's OWN version is untouched (still exactly one occurrence at 1.1.0-SNAPSHOT for it)
  assert.match(out, /<artifactId>customer-web-eapi-app<\/artifactId>\s*<version>1\.1\.0-SNAPSHOT<\/version>/);
});

test("applyEdits: pomVersion + pomParentVersion together — own bump AND parent repoint in one pass", () => {
  const pom = [
    "<project>",
    "  <parent><artifactId>solutions-parent-pom</artifactId><version>1.0.0-SNAPSHOT</version></parent>",
    "  <artifactId>customer-web-eapi-app</artifactId>",
    "  <version>1.0.0-SNAPSHOT</version>",
    "</project>",
  ].join("\n");
  const out = applyEdits(pom, [
    { kind: "pomVersion", artifactId: "customer-web-eapi-app", from: "1.0.0-SNAPSHOT", to: "1.1.0-SNAPSHOT" },
    { kind: "pomParentVersion", artifactId: "solutions-parent-pom", from: "1.0.0-SNAPSHOT", to: "1.1.0-SNAPSHOT" },
  ]);
  assert.match(out, /<parent><artifactId>solutions-parent-pom<\/artifactId><version>1\.1\.0-SNAPSHOT<\/version><\/parent>/);
  assert.match(out, /<artifactId>customer-web-eapi-app<\/artifactId>\s*<version>1\.1\.0-SNAPSHOT<\/version>/);
});
