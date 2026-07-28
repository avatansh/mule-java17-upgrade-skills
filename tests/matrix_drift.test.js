// tests/matrix_drift.test.js — advisory gating-version drift check: metadata parsing, clean-release
// filtering, LTS line-prefix policy, and the drift verdict. The network fetch is injected so no test
// touches MuleSoft's Nexus.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isCleanRelease,
  parseMavenMetadata,
  highestClean,
  checkMatrixDrift,
  formatDrift,
  checkConnectorDrift,
  candidateMatrix,
  formatConnectorDrift,
  runDriftCheck,
} from "../skills/mule-upgrade-assess/scripts/lib/matrix_drift.js";

// ── isCleanRelease ─────────────────────────────────────────────────────────────────────────────
test("isCleanRelease accepts plain semver, rejects qualifiers/dated/snapshot", () => {
  assert.equal(isCleanRelease("4.9.19"), true);
  assert.equal(isCleanRelease("4.10.1"), true);
  assert.equal(isCleanRelease("1.7.0"), true);
  assert.equal(isCleanRelease("4.9.19-rc1"), false);
  assert.equal(isCleanRelease("2.13.0-20260706"), false);
  assert.equal(isCleanRelease("3.0.0-BETA"), false);
  assert.equal(isCleanRelease("2.2.1-support"), false);
  assert.equal(isCleanRelease(""), false);
  assert.equal(isCleanRelease(null), false);
});

// ── parseMavenMetadata ─────────────────────────────────────────────────────────────────────────
test("parseMavenMetadata extracts versions + latest/release", () => {
  const xml = `<metadata><versioning>
    <latest>4.12.1</latest><release>4.12.1</release>
    <versions><version>4.9.17</version><version>4.9.18</version><version>4.9.19-rc1</version>
    <version>4.9.19</version><version>4.12.1</version></versions>
  </versioning></metadata>`;
  const r = parseMavenMetadata(xml);
  assert.equal(r.latest, "4.12.1");
  assert.equal(r.release, "4.12.1");
  assert.deepEqual(r.versions, ["4.9.17", "4.9.18", "4.9.19-rc1", "4.9.19", "4.12.1"]);
  assert.deepEqual(parseMavenMetadata("").versions, []);
  assert.deepEqual(parseMavenMetadata(null).versions, []);
});

// ── highestClean + line prefix (the LTS policy) ────────────────────────────────────────────────
test("highestClean picks the top clean release, honoring the LTS line prefix", () => {
  const versions = ["4.9.17", "4.9.18", "4.9.19-rc1", "4.9.19", "4.10.0", "4.12.1"];
  // no prefix → highest clean overall
  assert.equal(highestClean(versions), "4.12.1");
  // restricted to the 4.9. LTS line → 4.9.19 (rc dropped)
  assert.equal(highestClean(versions, "4.9."), "4.9.19");
  // nothing on the line → null
  assert.equal(highestClean(versions, "4.8."), null);
  // dated-only line → null (all rejected as unclean)
  assert.equal(highestClean(["2.13.0-20260706", "2.13.0-20260601"], "2.13."), null);
});

// ── checkMatrixDrift: end-to-end with an injected fetcher ───────────────────────────────────────
function fakeMatrix() {
  return {
    target: { runtime: "4.9.18", javaVersion: "17" },
    gating: {
      muleMavenPlugin: { set: "4.10.0" },
      munit: { set: "3.6.3" },
      munitExtPlugin: { set: "1.5.0" },
    },
  };
}

const METADATA = {
  "mule-services-all": `<m><versions><version>4.9.18</version><version>4.9.19</version><version>4.12.1</version></versions></m>`,
  "mule-maven-plugin": `<m><versions><version>4.10.0</version><version>4.10.1</version></versions></m>`,
  "munit-maven-plugin": `<m><versions><version>3.6.3</version><version>3.7.3</version></versions></m>`,
  "munit-extensions-maven-plugin": `<m><versions><version>1.5.0</version><version>1.7.0</version></versions></m>`,
};

function fetchByUrl(url) {
  for (const [key, xml] of Object.entries(METADATA)) if (url.includes(key)) return Promise.resolve(xml);
  return Promise.reject(new Error("unexpected url " + url));
}

test("checkMatrixDrift flags all four pins as behind, staying on the 4.9 LTS line", async () => {
  const report = await checkMatrixDrift(fakeMatrix(), { fetchXml: fetchByUrl });
  assert.equal(report.checked, true);
  assert.equal(report.driftCount, 4);

  const runtime = report.results.find((r) => r.key === "muleRuntime");
  assert.equal(runtime.pinned, "4.9.18");
  assert.equal(runtime.latest, "4.9.19", "must NOT jump to 4.12.1 — line-filtered to 4.9.x");
  assert.equal(runtime.drift, true);

  const mmp = report.results.find((r) => r.key === "muleMavenPlugin");
  assert.equal(mmp.latest, "4.10.1");
  assert.equal(mmp.drift, true);

  const munit = report.results.find((r) => r.key === "munit");
  assert.equal(munit.latest, "3.7.3");

  assert.ok(
    report.warnings.some((w) => /mule-maven-plugin pins 4\.10\.0, latest published is 4\.10\.1/.test(w))
  );
});

test("checkMatrixDrift: current pins → no drift", async () => {
  const m = {
    target: { runtime: "4.9.19" },
    gating: { muleMavenPlugin: { set: "4.10.1" }, munit: { set: "3.7.3" }, munitExtPlugin: { set: "1.7.0" } },
  };
  const report = await checkMatrixDrift(m, { fetchXml: fetchByUrl });
  assert.equal(report.driftCount, 0);
  assert.ok(report.results.every((r) => r.drift === false));
});

test("checkMatrixDrift: a fetch failure is non-fatal → unknown for that artifact", async () => {
  const fetchXml = (url) =>
    url.includes("munit-maven-plugin") ? Promise.reject(new Error("HTTP 503")) : fetchByUrl(url);
  const report = await checkMatrixDrift(fakeMatrix(), { fetchXml });
  const munit = report.results.find((r) => r.key === "munit");
  assert.equal(munit.unknown, true);
  assert.match(munit.note, /fetch failed \(HTTP 503\)/);
  // the others still evaluated
  assert.ok(report.results.find((r) => r.key === "muleRuntime").drift);
});

test("checkMatrixDrift: noFetch skips the network and reports unchecked", async () => {
  let called = false;
  const fetchXml = () => {
    called = true;
    return Promise.resolve("");
  };
  const report = await checkMatrixDrift(fakeMatrix(), { noFetch: true, fetchXml });
  assert.equal(called, false);
  assert.equal(report.checked, false);
  assert.equal(report.driftCount, 0);
  assert.ok(report.results.every((r) => r.unknown));
});

test("formatDrift renders drift, current, and unknown lines", () => {
  const report = {
    checked: true,
    driftCount: 1,
    results: [
      { key: "a", label: "A", pinned: "1.0.0", latest: "1.1.0", drift: true },
      { key: "b", label: "B", pinned: "2.0.0", latest: "2.0.0", drift: false },
      { key: "c", label: "C", pinned: "3.0.0", latest: null, unknown: true, note: "fetch failed (x)" },
    ],
  };
  const out = formatDrift(report);
  assert.match(out, /1 version\(s\) behind/);
  assert.match(out, /! A: pinned 1\.0\.0 < latest 1\.1\.0/);
  assert.match(out, /✓ B: pinned 2\.0\.0 is current/);
  assert.match(out, /\? C: pinned 3\.0\.0 — fetch failed/);
});

// ── checkConnectorDrift / candidateMatrix (G5, advisory — reduces the CHOICE menu, no network) ────
const G5_MATRIX = {
  connectors: [
    { artifactId: "mule-http-connector", groupId: "org.mule.connectors", set: "1.11.3" },
    { artifactId: "mule-db-connector", groupId: "org.mule.connectors", set: "1.14.8" },
    { artifactId: "mule-sockets-connector", groupId: "org.mule.connectors", set: "1.2.5" },
  ],
};

test("checkConnectorDrift flags a pin below latest-in-major, leaves current pins clean", () => {
  const choices = [
    // http: matrix trails 1.11.3 -> 1.11.9 in-major (drift); a 2.x exists in a newer major.
    { artifactId: "mule-http-connector", latestInMajor: "1.11.9", latest: "2.0.0" },
    // db: pin is current in-major.
    { artifactId: "mule-db-connector", latestInMajor: "1.14.8", latest: "1.14.8" },
    // sockets: no live data (matrix-only) → unknown.
    { artifactId: "mule-sockets-connector", latestInMajor: null, latest: null },
  ];
  const r = checkConnectorDrift({ matrix: G5_MATRIX, choices });
  assert.equal(r.checked, true);
  assert.equal(r.driftCount, 1);
  const http = r.results.find((x) => x.artifactId === "mule-http-connector");
  assert.equal(http.drift, true);
  assert.equal(http.latestInMajor, "1.11.9");
  const db = r.results.find((x) => x.artifactId === "mule-db-connector");
  assert.equal(db.drift, false);
  const sockets = r.results.find((x) => x.artifactId === "mule-sockets-connector");
  assert.equal(sockets.unknown, true);
  // The drift warning must flag the newer-major caveat AND state the pin stays authoritative.
  assert.ok(r.warnings.some((w) => /mule-http-connector/.test(w) && /2\.0\.0/.test(w) && /floor/.test(w)));
});

test("checkConnectorDrift with no choices → checked:false, all unknown, no drift", () => {
  const r = checkConnectorDrift({ matrix: G5_MATRIX, choices: [] });
  assert.equal(r.checked, false);
  assert.equal(r.driftCount, 0);
  assert.ok(r.results.every((x) => x.unknown));
});

test("candidateMatrix proposes in-major bumps for drifting connectors, leaves others untouched", () => {
  const choices = [
    { artifactId: "mule-http-connector", latestInMajor: "1.11.9", latest: "2.0.0" },
    { artifactId: "mule-db-connector", latestInMajor: "1.14.8", latest: "1.14.8" },
    { artifactId: "mule-sockets-connector", latestInMajor: null, latest: null },
  ];
  const report = checkConnectorDrift({ matrix: G5_MATRIX, choices });
  const { matrix: proposedMatrix, proposed } = candidateMatrix(G5_MATRIX, report);
  assert.deepEqual(proposed, [{ artifactId: "mule-http-connector", from: "1.11.3", to: "1.11.9" }]);
  // Only http is bumped; db + sockets keep their pins. The ORIGINAL matrix is not mutated.
  assert.equal(proposedMatrix.connectors.find((c) => c.artifactId === "mule-http-connector").set, "1.11.9");
  assert.equal(proposedMatrix.connectors.find((c) => c.artifactId === "mule-db-connector").set, "1.14.8");
  assert.equal(G5_MATRIX.connectors.find((c) => c.artifactId === "mule-http-connector").set, "1.11.3", "source untouched");
});

// ── runDriftCheck (A3 — the check_drift orchestrator) ────────────────────────────────────────────
test("runDriftCheck (noFetch): gating unchecked, connectors matrix-only 'unknown', never throws", async () => {
  const { gating, connectors, candidate, warnings } = await runDriftCheck({
    matrix: G5_MATRIX,
    noFetch: true,
  });
  // noFetch → gating degrades to not-run, connectors resolve matrix-only (no latest-in-major → unknown).
  assert.equal(gating.checked, false, "gating drift is unchecked offline");
  assert.ok(connectors, "connector staleness is included by default");
  assert.equal(connectors.driftCount, 0, "matrix-only → no connector drift detected");
  assert.ok(connectors.results.every((r) => r.unknown), "every connector is 'unknown' offline");
  assert.equal(candidate, null, "no candidate matrix unless requested");
  assert.ok(Array.isArray(warnings), "warnings is always an array");
});

test("runDriftCheck (noFetch, includeConnectors:false): gating-only, no connector report", async () => {
  const { gating, connectors } = await runDriftCheck({
    matrix: G5_MATRIX,
    noFetch: true,
    includeConnectors: false,
  });
  assert.equal(gating.checked, false);
  assert.equal(connectors, null, "connector staleness skipped when includeConnectors:false");
});

test("formatConnectorDrift renders drift / current / unknown lines", () => {
  const report = {
    checked: true,
    driftCount: 1,
    results: [
      { artifactId: "http", pinned: "1.0.0", latestInMajor: "1.2.0", drift: true },
      { artifactId: "db", pinned: "2.0.0", latestInMajor: "2.0.0", drift: false },
      { artifactId: "sockets", pinned: "3.0.0", unknown: true, note: "no live version data (matrix-only)" },
    ],
  };
  const out = formatConnectorDrift(report);
  assert.match(out, /1 connector\(s\) behind/);
  assert.match(out, /matrix stays authoritative/);
  assert.match(out, /! http: pinned 1\.0\.0 < latest-in-major 1\.2\.0/);
  assert.match(out, /✓ db: pinned 2\.0\.0 is current in-major/);
  assert.match(out, /\? sockets: pinned 3\.0\.0 — no live version data/);
});
