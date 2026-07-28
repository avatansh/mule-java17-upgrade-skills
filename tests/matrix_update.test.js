// tests/matrix_update.test.js — the matrix-update skill (skills/mule-upgrade-matrix-update).
//
// This skill turns check_drift ADVISORIES into a REVIEWED bump of the bundled compatibility matrix,
// writing ONLY on an explicit apply and NEVER round-tripping the YAML (comments/format must survive).
// We inject a runDriftCheck()-shaped result + in-memory read/write so nothing touches the network or
// disk, and assert: (1) proposals derive correctly from gating + connector drift; (2) apply is
// text-preserving and moves every runtime anchor together; (3) the from-guard skips already-moved
// pins instead of clobbering; (4) dry-run writes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  proposeBumps,
  applyMatrixEdits,
  runMatrixUpdate,
  formatMatrixUpdate,
} from "../skills/mule-upgrade-matrix-update/scripts/matrix_update.js";

// A tiny matrix YAML fixture with the exact SHAPES the real file uses: an inline target.runtime with
// a trailing comment, two inline gating flow-maps (munit has BOTH min and set at the same value — the
// classic trap), and two connector lines. Comment lines are here to prove they survive a write.
const FIXTURE = `# curated Java-17 matrix
schemaVersion: "1.2"
target:
  runtime: "4.9.18"          # app.runtime AND app.runtime.semver
  javaVersion: "17"

# GATING
gating:
  muleRuntime:        { property: "app.runtime",        min: "4.6.0", set: "4.9.18" }
  muleRuntimeSemver:  { property: "app.runtime.semver", min: "4.6.0", set: "4.9.18" }
  muleMavenPlugin:    { property: "mule.maven.plugin.version", min: "4.1.1", set: "4.10.0" }
  munit:              { property: "munit.version",      min: "3.6.3", set: "3.6.3" }

# COMPATIBILITY
connectors:
  - { property: "http.connector.version", set: "1.11.3", groupId: "org.mule.connectors", artifactId: "mule-http-connector" }
  - { property: "db.connector.version",   set: "1.14.6", groupId: "org.mule.connectors", artifactId: "mule-db-connector" }
`;

// A runDriftCheck()-shaped result: gating pins trailing live Maven metadata + connector candidate bumps.
function driftFixture() {
  return {
    gating: {
      checked: true,
      results: [
        { key: "muleRuntime", label: "Mule runtime (LTS patch)", pinned: "4.9.18", latest: "4.9.19", drift: true },
        { key: "muleMavenPlugin", label: "mule-maven-plugin", pinned: "4.10.0", latest: "4.10.1", drift: true },
        { key: "munit", label: "munit-maven-plugin", pinned: "3.6.3", latest: "3.7.3", drift: true },
        // a NON-drifting gating pin must NOT become a proposal
        { key: "munitExtPlugin", label: "munit-extensions", pinned: "1.5.0", latest: "1.5.0", drift: false },
      ],
    },
    connectors: { checked: true, results: [] },
    candidate: {
      proposed: [
        { artifactId: "mule-http-connector", from: "1.11.3", to: "1.11.9" },
        { artifactId: "mule-db-connector", from: "1.14.6", to: "1.14.20" },
      ],
    },
    warnings: ["Matrix drift: Mule runtime pins 4.9.18, latest published is 4.9.19."],
  };
}

test("proposeBumps: derives gating + connector bumps, skips non-drifting pins", () => {
  const proposals = proposeBumps(driftFixture());
  const ids = proposals.map((p) => p.id).sort();
  assert.deepEqual(ids, ["mule-db-connector", "mule-http-connector", "muleMavenPlugin", "muleRuntime", "munit"]);
  const runtime = proposals.find((p) => p.id === "muleRuntime");
  assert.equal(runtime.from, "4.9.18");
  assert.equal(runtime.to, "4.9.19");
  // the runtime touches THREE anchors (target.runtime + both gating runtime pins)
  assert.equal(runtime.anchors.length, 3);
  // munitExtPlugin had drift:false → never proposed
  assert.ok(!proposals.some((p) => p.id === "munitExtPlugin"), "non-drifting pin is not proposed");
});

test("proposeBumps: falls back to raw connector results when no candidate is present", () => {
  const drift = {
    gating: { checked: false, results: [] },
    connectors: {
      checked: true,
      results: [
        { artifactId: "mule-http-connector", pinned: "1.11.3", latestInMajor: "1.11.9", drift: true },
        { artifactId: "mule-db-connector", pinned: "1.14.6", latestInMajor: null, drift: false }, // no drift → skip
      ],
    },
    // candidate absent
  };
  const proposals = proposeBumps(drift);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].id, "mule-http-connector");
  assert.equal(proposals[0].to, "1.11.9");
});

test("applyMatrixEdits: is text-preserving — bumps only version tokens, keeps comments + munit.min", () => {
  const proposals = proposeBumps(driftFixture());
  const { text, applied, skipped } = applyMatrixEdits(FIXTURE, proposals);
  assert.equal(skipped.length, 0, "every anchor matched the fixture");

  // comments survive verbatim
  assert.ok(text.includes("# curated Java-17 matrix"));
  assert.ok(text.includes("# app.runtime AND app.runtime.semver"), "inline trailing comment preserved");

  // runtime moved in all three places
  assert.ok(text.includes('runtime: "4.9.19"'));
  assert.ok(text.includes('muleRuntime:        { property: "app.runtime",        min: "4.6.0", set: "4.9.19" }'));
  assert.ok(text.includes('muleRuntimeSemver:  { property: "app.runtime.semver", min: "4.6.0", set: "4.9.19" }'));

  // munit: set bumped to 3.7.3 but its min: "3.6.3" (SAME old value) must stay untouched
  assert.ok(text.includes('min: "3.6.3", set: "3.7.3"'), "only munit.set moved, munit.min preserved");

  // connectors moved
  assert.ok(text.includes('set: "1.11.9"') && text.includes('set: "1.14.20"'));

  // old runtime/connector values are fully gone
  assert.ok(!text.includes('"4.9.18"'));
  assert.ok(!text.includes('set: "1.11.3"'));

  // applied carries per-line provenance; runtime lists 3 lines
  const runtimeApplied = applied.find((a) => a.id === "muleRuntime");
  assert.equal(runtimeApplied.lines.length, 3);
});

test("applyMatrixEdits: from-guard SKIPS a pin that already moved (never clobbers)", () => {
  // The matrix already has munit at 3.7.3, but drift still thinks it's at 3.6.3 → guard fails → skip.
  const moved = FIXTURE.replace('min: "3.6.3", set: "3.6.3"', 'min: "3.6.3", set: "3.7.3"');
  const proposal = { kind: "gating", id: "munit", label: "munit", from: "3.6.3", to: "3.7.3", anchors: [{ contains: "munit:", token: "set", note: "gating.munit.set" }] };
  const { text, applied, skipped } = applyMatrixEdits(moved, [proposal]);
  assert.equal(applied.length, 0, "nothing applied — value already differs from `from`");
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /no line matched/);
  assert.equal(text, moved, "text is byte-identical — no clobber");
});

test("runMatrixUpdate: dry-run (default) writes NOTHING but reports the change", async () => {
  let wrote = 0;
  const rep = await runMatrixUpdate({
    driftResult: driftFixture(),
    matrixPath: "MEM",
    readText: () => FIXTURE,
    writeText: () => { wrote++; },
  });
  assert.equal(rep.wrote, false);
  assert.equal(rep.changed, true, "it WOULD change");
  assert.equal(wrote, 0, "dry-run never calls the writer");
  assert.equal(rep.applied.length, 5);
  assert.ok(rep.driftChecked);
});

test("runMatrixUpdate: --apply writes the bumped text exactly once", async () => {
  const writes = [];
  const rep = await runMatrixUpdate({
    apply: true,
    driftResult: driftFixture(),
    matrixPath: "MEM",
    readText: () => FIXTURE,
    writeText: (p, t) => writes.push({ p, t }),
  });
  assert.equal(rep.wrote, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].p, "MEM");
  assert.ok(writes[0].t.includes('runtime: "4.9.19"'), "the written text carries the bump");
});

test("runMatrixUpdate: --apply with nothing to change does NOT write", async () => {
  // A drift result with no drifting pins → no proposals → no write even under --apply.
  const clean = { gating: { checked: true, results: [] }, connectors: { checked: true, results: [] }, candidate: { proposed: [] }, warnings: [] };
  let wrote = 0;
  const rep = await runMatrixUpdate({
    apply: true,
    driftResult: clean,
    matrixPath: "MEM",
    readText: () => FIXTURE,
    writeText: () => { wrote++; },
  });
  assert.equal(rep.changed, false);
  assert.equal(rep.wrote, false);
  assert.equal(wrote, 0);
});

test("formatMatrixUpdate: distinguishes dry-run, applied, and no-data", () => {
  const dry = formatMatrixUpdate({ driftChecked: true, proposals: [{ id: "x" }], applied: [{ kind: "gating", label: "x", from: "1", to: "2", lines: [{ line: 3 }] }], skipped: [], changed: true, wrote: false, path: "P" });
  assert.match(dry, /DRY-RUN/);
  assert.match(dry, /--apply/);

  const done = formatMatrixUpdate({ driftChecked: true, proposals: [{ id: "x" }], applied: [{ kind: "gating", label: "x", from: "1", to: "2", lines: [{ line: 3 }] }], skipped: [], changed: true, wrote: true, path: "P" });
  assert.match(done, /APPLIED/);

  const noData = formatMatrixUpdate({ driftChecked: false, proposals: [], applied: [], skipped: [], changed: false, wrote: false, path: "P" });
  assert.match(noData, /drift not checked/);
});
