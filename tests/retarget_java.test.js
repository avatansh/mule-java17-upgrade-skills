// tests/retarget_java.test.js — Step 5: the engine's Java target is DATA, not code.
//
// The claim under test is "retargeting Java 17 → 21 is a matrix edit". The only honest way to test that
// is to flip a matrix to 21 and assert the engine produces Java-21 edits end-to-end, with no code path
// patched. Unit-testing javaMajor alone would prove the helper works while the engine still hardcoded
// 17 somewhere else.

import test from "node:test";
import assert from "node:assert/strict";
import { javaMajor, javaLt, javaEq, supportedJavaMajors } from "../lib_shared/java_version.js";
import {
  buildAssessmentResult,
  needsBump,
  customConnectorWarnings,
  retargetWarnings,
} from "../skills/mule-upgrade-assess/scripts/lib/assess_engine.js";
import {
  firstCompatibleVersion,
  firstJava17Version,
  buildConnectorChoice,
} from "../skills/mule-upgrade-assess/scripts/lib/version_resolver.js";
import { processGuideBaseline } from "../skills/mule-upgrade-assess/scripts/lib/process_guide.js";

// ── the Java version primitive ─────────────────────────────────────────────────────────────────

test("javaMajor normalises every shape of Java version token", () => {
  for (const [input, expected] of [
    ["1.8", 8],
    ["1.8.0_402", 8],
    ["8", 8],
    ["8.0.402", 8],
    ["11", 11],
    ["11.0.22", 11],
    ["17", 17],
    ["17.0.9+9", 17],
    ["21", 21],
    ["21.0.1", 21],
    [17, 17],
  ]) {
    assert.equal(javaMajor(input), expected, `javaMajor(${JSON.stringify(input)})`);
  }
  for (const bad of [null, undefined, "", "   ", "abc"]) assert.equal(javaMajor(bad), null);
});

test("javaMajor does not rewrite a non-legacy 1.x", () => {
  // 1.2-1.8 are real legacy Java; 1.9 never existed, so it must not be reinterpreted as 9.
  assert.equal(javaMajor("1.8"), 8);
  assert.equal(javaMajor("1.9"), 1);
});

test("javaLt compares by MAJOR, and unknown input is never 'older'", () => {
  assert.ok(javaLt("1.8", "17"));
  assert.ok(javaLt("8", "11"));
  assert.ok(javaLt("11", "17"));
  assert.ok(javaLt("17", "21"));
  assert.ok(!javaLt("17", "17"));
  assert.ok(!javaLt("21", "17"));
  assert.ok(!javaLt("1.8", "8"), "1.8 and 8 are the same Java");
  // An unparseable version must NOT look stale — that would trigger a spurious bump.
  assert.ok(!javaLt("weird", "17"));
  assert.ok(!javaLt("17", "weird"));
});

test("javaEq treats 1.8 and 8 as the same version", () => {
  assert.ok(javaEq("1.8", "8"));
  assert.ok(javaEq("17.0.9", "17"));
  assert.ok(!javaEq("11", "17"));
});

test("supportedJavaMajors grows the @JavaVersionSupport list with the target", () => {
  assert.deepEqual(supportedJavaMajors(17), [8, 11, 17]);
  assert.deepEqual(supportedJavaMajors(21), [8, 11, 17, 21]);
  assert.deepEqual(supportedJavaMajors(11), [8, 11]);
  assert.deepEqual(supportedJavaMajors("nonsense"), [8, 11, 17], "falls back to the 17 set");
});

// ── gating comparison is derived, not enumerated ────────────────────────────────────────────────

test("compare:'java' derives staleness from the target — no in:[] list to maintain", () => {
  const to17 = { property: "java.version", compare: "java", set: "17" };
  for (const installed of ["1.8", "8", "11"]) assert.ok(needsBump(installed, to17), `${installed} < 17`);
  assert.ok(!needsBump("17", to17));
  assert.ok(!needsBump("21", to17));

  // The point of the exercise: moving `set` to 21 starts flagging 17 with NO rule edit. Under the old
  // in:["1.8","8","11"] form this returned false and the Java bump was silently skipped.
  const to21 = { property: "java.version", compare: "java", set: "21" };
  assert.ok(needsBump("17", to21), "17 is stale once the target is 21");
  assert.ok(needsBump("1.8", to21));
  assert.ok(!needsBump("21", to21));
});

test("legacy in:[] rules still work (back-compat)", () => {
  const legacy = { property: "java.version", in: ["1.8", "8", "11"], set: "17" };
  assert.ok(needsBump("8", legacy));
  assert.ok(!needsBump("17", legacy));
});

// ── release-notes compatibility is parameterised ────────────────────────────────────────────────

test("firstCompatibleVersion honours the requested target major", () => {
  const entries = [
    { version: "1.5.0", jdks: [8, 11] },
    { version: "1.8.0", jdks: [8, 11, 17] },
    { version: "1.9.0", jdks: [8, 11, 17] },
    { version: "2.1.0", jdks: [11, 17, 21] },
  ];
  assert.equal(firstCompatibleVersion(entries, 11), "1.5.0");
  assert.equal(firstCompatibleVersion(entries, 17), "1.8.0");
  assert.equal(firstCompatibleVersion(entries, 21), "2.1.0", "only 2.1.0 lists 21");
  assert.equal(firstCompatibleVersion(entries, 25), null, "no row claims 25");
  assert.equal(firstJava17Version(entries), "1.8.0", "the back-compat alias still means 17");
});

test("buildConnectorChoice labels and firstCompatible follow targetJava", () => {
  const jdkEntries = [
    { version: "1.8.0", jdks: [8, 11, 17] },
    { version: "2.1.0", jdks: [11, 17, 21] },
  ];
  const at17 = buildConnectorChoice({ artifactId: "c", matrixSet: "1.8.0", jdkEntries, targetJava: 17 });
  assert.equal(at17.firstCompatible, "1.8.0");
  assert.match(at17.options[0].label, /Java-17-safe/);

  const at21 = buildConnectorChoice({ artifactId: "c", matrixSet: "1.8.0", jdkEntries, targetJava: 21 });
  assert.equal(at21.firstCompatible, "2.1.0");
  assert.match(at21.options[0].label, /Java-21-safe/);
  assert.ok(
    at21.options.some((o) => o.strategy === "first-compatible" && /Java-21-compatible/.test(o.label)),
    "the menu must name the real target, not a stale 17"
  );
});

// ── prose that would otherwise mislead ──────────────────────────────────────────────────────────

test("the connector checklist annotates the right @JavaVersionSupport majors", () => {
  const at17 = customConnectorWarnings("my-conn", 17).join("\n");
  assert.match(at17, /@JavaVersionSupport\(\{JAVA_8, JAVA_11, JAVA_17\}\)/);

  const at21 = customConnectorWarnings("my-conn", 21).join("\n");
  assert.match(at21, /@JavaVersionSupport\(\{JAVA_8, JAVA_11, JAVA_17, JAVA_21\}\)/);
  assert.match(at21, /does not support Java 21/);
  assert.ok(!/Java-17 builds/.test(at21), "no stale 17 prose when targeting 21");
});

test("the Process Guide checklist relabels itself for the target", () => {
  const m21 = { target: { runtime: "4.9.18", javaVersion: "21" }, gating: {}, processGuide: {} };
  const b = processGuideBaseline({ matrix: m21 });
  const byId = Object.fromEntries(b.items.map((i) => [i.id, i.item]));
  assert.match(byId.javaVersion, /Java 21/);
  assert.match(byId.ciJdk, /JDK 21/);
  assert.match(byId.connectorVersions, /Java-21-compatible/);
  assert.match(byId.reflectiveAccess, /Java 21 strong encapsulation/);
  assert.match(byId.apiPolicies, /Java 21/);
  assert.ok(
    !b.items.some((i) => /Java[ -]17/.test(i.item)),
    "no item may still claim Java 17 when the matrix targets 21"
  );
});

// ── retarget coherence guard ────────────────────────────────────────────────────────────────────

test("a coherent matrix produces no retarget warnings", () => {
  assert.deepEqual(
    retargetWarnings({
      target: { javaVersion: "21" },
      muleArtifact: { javaSpecificationVersions: ["17", "21"] },
      gating: { javaVersion: { compare: "java", set: "21" } },
    }),
    []
  );
});

test("a half-finished retarget is caught, not silently shipped", () => {
  const w = retargetWarnings({
    target: { javaVersion: "21" },
    muleArtifact: { javaSpecificationVersions: ["17"] },
    gating: { javaVersion: { compare: "java", set: "17" } },
  });
  assert.equal(w.length, 2);
  assert.ok(
    w.some((x) => /javaSpecificationVersions/.test(x)),
    "descriptor mismatch is reported"
  );
  assert.ok(
    w.some((x) => /gating\.javaVersion sets "17"/.test(x)),
    "stale gating set is reported"
  );
});

test("a missing target.javaVersion is reported loudly", () => {
  const w = retargetWarnings({ target: {} });
  assert.equal(w.length, 1);
  assert.match(w[0], /no usable target\.javaVersion/);
});

// ── the end-to-end proof ────────────────────────────────────────────────────────────────────────

/** A minimal app pom on Mule 4.6 / Java 17 — i.e. already "done" for 17, stale for 21. */
const APP_POM = `<project>
  <groupId>com.acme</groupId>
  <artifactId>orders-api</artifactId>
  <version>1.2.0</version>
  <packaging>mule-application</packaging>
  <properties>
    <app.runtime>4.9.18</app.runtime>
    <java.version>17</java.version>
    <maven.compiler.source>17</maven.compiler.source>
    <maven.compiler.target>17</maven.compiler.target>
  </properties>
</project>`;

/** The SAME matrix shape; only the target (and the keys that must agree with it) differ. */
function matrixFor(javaVersion) {
  return {
    target: { runtime: "4.9.18", javaVersion },
    gating: {
      muleRuntime: { property: "app.runtime", min: "4.6.0", set: "4.9.18" },
      javaVersion: { property: "java.version", compare: "java", set: javaVersion },
      javaCompilerSource: { property: "maven.compiler.source", compare: "java", set: javaVersion },
      javaCompilerTarget: { property: "maven.compiler.target", compare: "java", set: javaVersion },
    },
    connectors: [],
    muleArtifact: { minMuleVersion: "4.9.18", javaSpecificationVersions: [javaVersion] },
    manualReview: {},
    processGuide: {},
  };
}

const assessWith = (matrix) =>
  buildAssessmentResult({
    matrix,
    chain: [{ path: "pom.xml", pomText: APP_POM }],
    appPomText: APP_POM,
    muleArtifactCurrent: { minMuleVersion: "4.9.18", javaSpecificationVersions: ["17"] },
    muleArtifactPath: "mule-artifact.json",
    ciWorkflowText: "java-version: '17'",
    ciWorkflowPath: ".github/workflows/build.yml",
    appName: "orders-api",
    topology: "APP_STANDALONE",
    warnings: [],
  });

// Named explicitly: a /java/i match would silently miss maven.compiler.source/target and let a
// half-retargeted plan pass.
const JAVA_PROPS = ["java.version", "maven.compiler.source", "maven.compiler.target"];
const javaEditsOf = (r) => r.changePlan.fileEdits.filter((e) => JAVA_PROPS.includes(e.property));

test("targeting 17: an app already on 17 needs no Java edits", () => {
  const r = assessWith(matrixFor("17"));
  assert.deepEqual(javaEditsOf(r), [], "nothing to do — the app is already on the target");
  assert.equal(r.currentJavaVersion, "17");
});

test("RETARGET: flipping ONLY the matrix to Java 21 makes the same app produce Java-21 edits", () => {
  const r = assessWith(matrixFor("21"));

  const javaEdits = javaEditsOf(r);
  assert.equal(javaEdits.length, 3, "java.version + maven.compiler.source + maven.compiler.target");
  for (const e of javaEdits) {
    assert.equal(e.from, "17", `${e.property} moves off 17`);
    assert.equal(e.to, "21", `${e.property} moves to 21`);
  }

  // The descriptor and CI follow the same target.
  const ma = r.changePlan.fileEdits.find((e) => e.kind === "muleArtifactJson");
  assert.deepEqual(ma.to.javaSpecificationVersions, ["21"]);
  const ci = r.changePlan.fileEdits.find((e) => e.kind === "ciWorkflow");
  assert.equal(ci.to, "21");

  assert.equal(r.changePlan.targetJavaVersion, "21");
  assert.match(
    r.processGuide.items.find((i) => i.id === "javaVersion").item,
    /Java 21/,
    "the baseline report retargets too"
  );
  assert.deepEqual(
    r.warnings.filter((w) => /target\.javaVersion/.test(w)),
    [],
    "a coherent retarget raises no coherence warnings"
  );
});
