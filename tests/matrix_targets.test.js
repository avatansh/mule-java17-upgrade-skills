// tests/matrix_targets.test.js — the per-Java-target matrix layout.
//
// The layout is one file per Java target, which duplicates the Java-NEUTRAL fields (connector
// properties/coordinates, gating coordinates, manualReview patterns) across files. That duplication
// is the one real hazard of the layout, so the parity test below is not a nice-to-have: it is the
// mechanism that makes the layout safe. Add a connector to one target and forget the other and this
// fails by name, instead of shipping an upgrade plan that silently skips that connector.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import {
  listTargets,
  defaultTarget,
  resolveTargetFile,
  identityOf,
  identityDrift,
  versionDelta,
  scaffoldTarget,
  isCurated,
  targetFileName,
  referencesDir,
  DEFAULT_MATRIX_FILE,
  SCAFFOLD_PLACEHOLDER,
} from "../skills/mule-upgrade-assess/scripts/lib/matrix_targets.js";
import {
  loadBundledMatrix,
  bundledMatrixPath,
  _resetMatrixCache,
} from "../skills/mule-upgrade-assess/scripts/lib/matrix.js";

const load = (file) => yaml.load(fs.readFileSync(file, "utf8"));

// ── the parity guard ────────────────────────────────────────────────────────────────────────────

test("PARITY: every target file shares identical Java-neutral identity fields", () => {
  const targets = listTargets();
  assert.ok(targets.length >= 1, "expected at least one compatibility matrix");
  if (targets.length === 1) return; // nothing to compare against yet

  const base = targets.find((t) => t.isDefault) ?? targets[0];
  const baseMatrix = load(base.file);

  for (const t of targets) {
    if (t.file === base.file) continue;
    const drift = identityDrift(baseMatrix, load(t.file));
    if (drift.length) {
      const detail = drift
        .map(
          (d) =>
            `  [${d.section}]\n` +
            d.onlyInA.map((x) => `    only in Java ${base.major}: ${x}`).join("\n") +
            (d.onlyInA.length && d.onlyInB.length ? "\n" : "") +
            d.onlyInB.map((x) => `    only in Java ${t.major}: ${x}`).join("\n")
        )
        .join("\n");
      assert.fail(
        `Java-neutral fields drifted between ${path.basename(base.file)} and ${path.basename(t.file)}.\n` +
          `These identify WHAT a rule points at and must be identical in every target ` +
          `(see references/MATRIX.md §4):\n${detail}`
      );
    }
  }
});

// ── target discovery ────────────────────────────────────────────────────────────────────────────

test("listTargets finds the default plus every java<N> file, sorted by major", () => {
  const targets = listTargets();
  const majors = targets.map((t) => t.major);
  assert.deepEqual(
    majors,
    [...majors].sort((a, b) => a - b),
    "targets should be sorted by Java major"
  );

  const def = targets.filter((t) => t.isDefault);
  assert.equal(def.length, 1, "exactly one target must be the default (compatibility-matrix.yaml)");
  assert.equal(path.basename(def[0].file), DEFAULT_MATRIX_FILE);
});

test("the Java 21 target ships scaffolded and is flagged uncurated", () => {
  const t21 = listTargets().find((t) => t.major === 21);
  assert.ok(t21, "expected a Java 21 target file");
  assert.equal(t21.curated, false, "Java 21 must stay uncurated until its versions are verified");
});

test("isCurated treats a missing status as curated", () => {
  assert.equal(isCurated({}), true);
  assert.equal(isCurated({ status: "curated" }), true);
  assert.equal(isCurated({ status: "uncurated" }), false);
  assert.equal(isCurated({ status: "UNCURATED" }), false);
});

// ── resolution: the default path must be exactly today's behaviour ──────────────────────────────

test("no target requested resolves to the default file (unchanged behaviour)", () => {
  assert.equal(path.basename(bundledMatrixPath()), DEFAULT_MATRIX_FILE);
  assert.equal(path.basename(resolveTargetFile().file), DEFAULT_MATRIX_FILE);
  assert.equal(path.basename(resolveTargetFile(null).file), DEFAULT_MATRIX_FILE);
});

test("requesting the default target's own Java resolves to the default file, not a java<N> file", () => {
  const def = defaultTarget();
  assert.ok(def);
  assert.equal(path.basename(resolveTargetFile(def.major).file), DEFAULT_MATRIX_FILE);
  // "1.8"-style and bare-integer spellings must land on the same file.
  assert.equal(resolveTargetFile(String(def.major)).file, resolveTargetFile(def.major).file);
});

test("the default matrix still loads fully populated (no regression from multi-target)", () => {
  const m = loadBundledMatrix();
  assert.equal(m.target.javaVersion, "17");
  assert.ok(m.gating && Object.keys(m.gating).length >= 9);
  assert.ok(Array.isArray(m.connectors) && m.connectors.length >= 15);
  assert.ok(m.manualReview && m.muleArtifact && m.processGuide);
  // No placeholder may ever appear in a curated target.
  assert.ok(
    !JSON.stringify(m).includes(SCAFFOLD_PLACEHOLDER),
    "the default matrix must not contain scaffold placeholders"
  );
});

// ── refusing rather than silently downgrading ───────────────────────────────────────────────────

test("an uncurated target is REFUSED, not silently downgraded to the default", () => {
  assert.throws(() => resolveTargetFile(21), /not curated yet/i);
  assert.throws(() => loadBundledMatrix(21), /not curated yet/i);
});

test("an unknown target names what IS available instead of failing blankly", () => {
  assert.throws(
    () => resolveTargetFile(99),
    (e) => {
      assert.match(e.message, /No compatibility matrix for Java 99/);
      assert.match(e.message, /Available: /);
      return true;
    }
  );
});

test("a nonsense target is rejected", () => {
  assert.throws(() => resolveTargetFile("banana"), /Unrecognised Java target/i);
});

// ── memoization still holds per file ────────────────────────────────────────────────────────────

test("loadBundledMatrix memoizes per file and hands out isolated copies", () => {
  _resetMatrixCache();
  const a = loadBundledMatrix();
  const b = loadBundledMatrix();
  assert.notEqual(a, b, "each caller must get its own deep copy");
  a.connectors[0].set = "999.999.999";
  assert.notEqual(
    loadBundledMatrix().connectors[0].set,
    "999.999.999",
    "mutation must not leak into the cache"
  );
  _resetMatrixCache();
});

// ── identity + delta helpers ────────────────────────────────────────────────────────────────────

test("identityOf ignores versions and captures coordinates", () => {
  const a = { connectors: [{ property: "p", groupId: "g", artifactId: "a", set: "1.0.0" }] };
  const b = { connectors: [{ property: "p", groupId: "g", artifactId: "a", set: "2.0.0" }] };
  assert.deepEqual(identityOf(a), identityOf(b), "a version bump must not change identity");
  assert.equal(identityDrift(a, b).length, 0);
});

test("identityDrift names a connector present in only one target", () => {
  const a = { connectors: [{ property: "p", groupId: "g", artifactId: "a" }] };
  const b = { connectors: [] };
  const drift = identityDrift(a, b);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].section, "connectors");
  assert.match(drift[0].onlyInA[0], /p\|g\|a/);
});

test("versionDelta reports only the fields that actually differ", () => {
  const a = {
    target: { runtime: "4.9.18", javaVersion: "17" },
    connectors: [{ property: "p", set: "1.0.0" }],
  };
  const b = {
    target: { runtime: "4.9.18", javaVersion: "21" },
    connectors: [{ property: "p", set: "2.0.0" }],
  };
  const delta = versionDelta(a, b);
  const keys = delta.map((d) => d.key);
  assert.ok(keys.includes("target.javaVersion"));
  assert.ok(keys.includes("connectors.p"));
  assert.ok(!keys.includes("target.runtime"), "identical fields must not appear in the delta");
});

// ── scaffolding ─────────────────────────────────────────────────────────────────────────────────

test("scaffoldTarget copies identity verbatim, blanks versions, and marks the file uncurated", () => {
  const src = fs.readFileSync(path.join(referencesDir(), DEFAULT_MATRIX_FILE), "utf8");
  const text = scaffoldTarget(src, 25);
  const out = yaml.load(text);

  assert.equal(out.target.javaVersion, "25");
  assert.equal(isCurated(out), false, "a scaffold must be uncurated");
  assert.deepEqual(out.muleArtifact.javaSpecificationVersions, ["25"]);

  // Identity is byte-identical to the source — that is the whole point of generating rather than
  // hand-copying, and it means a fresh scaffold always passes the parity test.
  assert.deepEqual(identityOf(out), identityOf(yaml.load(src)));
  assert.equal(identityDrift(out, yaml.load(src)).length, 0);

  // Every version-bearing field is a placeholder…
  for (const c of out.connectors) {
    assert.equal(c.set, SCAFFOLD_PLACEHOLDER, `connector ${c.property} should be blanked`);
  }
  assert.equal(out.target.runtime, SCAFFOLD_PLACEHOLDER);
  assert.equal(out.muleArtifact.minMuleVersion, SCAFFOLD_PLACEHOLDER);

  // …except the java gating rules, whose `set` IS the target major, not a version to look up.
  assert.equal(out.gating.javaVersion.set, "25");
  assert.equal(out.gating.javaCompilerSource.set, "25");
  assert.equal(out.gating.javaCompilerTarget.set, "25");
  assert.equal(out.gating.munit.set, SCAFFOLD_PLACEHOLDER);
});

test("scaffoldTarget preserves the curator's comments", () => {
  const src = fs.readFileSync(path.join(referencesDir(), DEFAULT_MATRIX_FILE), "utf8");
  const text = scaffoldTarget(src, 25);
  // Parse-and-dump would silently discard these; they are the curator's working notes.
  assert.match(text, /GATING - if installed < min/);
  assert.match(text, /embedded MUnit container manages JPMS itself/);
});

test("targetFileName follows the discovery convention", () => {
  assert.equal(targetFileName(21), "compatibility-matrix-java21.yaml");
  assert.equal(targetFileName("21"), "compatibility-matrix-java21.yaml");
});
