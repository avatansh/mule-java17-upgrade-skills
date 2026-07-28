// tests/version_resolver.test.js — EPIC B: OpenJDK-table parsing, in-major selection, connector
// choice building, strategy resolution, and the non-fatal resolveVersions orchestration.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  majorOf,
  parseJdkCell,
  parseOpenJdkTable,
  parseCompatibilityTable,
  muleRuntimeFor,
  firstJava17Version,
  highestVersion,
  latestInMajor,
  buildConnectorChoice,
  pickVersion,
} from "../skills/mule-upgrade-assess/scripts/lib/version_resolver.js";
import {
  resolveVersions,
  applyVersionStrategy,
  connectorReleaseNotesUrl,
  loadNotesMap,
  notesMapPath,
  _resetNotesMapCache,
} from "../skills/mule-upgrade-assess/scripts/lib/resolve_versions.js";

// ── parseJdkCell ────────────────────────────────────────────────────────────────────────
test("parseJdkCell tokenises the OpenJDK phrasings", () => {
  assert.deepEqual(parseJdkCell("8 and 11"), [8, 11]);
  assert.deepEqual(parseJdkCell("8, 11, and 17"), [8, 11, 17]);
  assert.deepEqual(parseJdkCell("11, 17"), [11, 17]);
  assert.deepEqual(parseJdkCell("1.8 and 11"), [8, 11]); // 1.8 normalised to 8
  assert.deepEqual(parseJdkCell("17"), [17]);
  assert.deepEqual(parseJdkCell(""), []);
  assert.deepEqual(parseJdkCell("no numbers here"), []);
});

test("majorOf parses the leading major, tolerant of qualifiers", () => {
  assert.equal(majorOf("10.19.2"), 10);
  assert.equal(majorOf("1.0.17"), 1);
  assert.equal(majorOf("4.2.9-SNAPSHOT"), 4);
  assert.equal(majorOf(""), null);
  assert.equal(majorOf(null), null);
});

// ── parseOpenJdkTable ───────────────────────────────────────────────────────────────────
const RELEASE_NOTES_HTML = `
<h2>Version 1.7.3</h2>
<p>Bug fixes.</p>
<table>
  <tr><th>Software</th><th>Version</th></tr>
  <tr><td>Mule</td><td>4.3.0 and later</td></tr>
  <tr><td>OpenJDK</td><td>8 and 11</td></tr>
</table>
<h2>Version 1.8.0</h2>
<p>Adds Java 17 support.</p>
<table>
  <tr><th>Software</th><th>Version</th></tr>
  <tr><td>Mule</td><td>4.6.0 and later</td></tr>
  <tr><td>OpenJDK</td><td>8, 11, and 17</td></tr>
</table>
<h2>Version 1.9.1</h2>
<table>
  <tr><td>OpenJDK</td><td>11 and 17</td></tr>
</table>
`;

test("parseOpenJdkTable extracts version→jdks rows in document order", () => {
  const entries = parseOpenJdkTable(RELEASE_NOTES_HTML);
  assert.deepEqual(entries, [
    { version: "1.7.3", jdks: [8, 11] },
    { version: "1.8.0", jdks: [8, 11, 17] },
    { version: "1.9.1", jdks: [11, 17] },
  ]);
});

test("parseOpenJdkTable returns [] for junk / empty input", () => {
  assert.deepEqual(parseOpenJdkTable(""), []);
  assert.deepEqual(parseOpenJdkTable("<p>no tables</p>"), []);
  assert.deepEqual(parseOpenJdkTable(null), []);
});

// ── parseCompatibilityTable / muleRuntimeFor (B6: capture the Mule-runtime row too) ───────
test("parseCompatibilityTable captures the Mule-runtime row alongside the JDK row", () => {
  const entries = parseCompatibilityTable(RELEASE_NOTES_HTML);
  assert.deepEqual(entries, [
    { version: "1.7.3", jdks: [8, 11], muleRuntime: "4.3.0 and later" },
    { version: "1.8.0", jdks: [8, 11, 17], muleRuntime: "4.6.0 and later" },
    { version: "1.9.1", jdks: [11, 17], muleRuntime: null }, // no Mule row in this table
  ]);
});

test("parseCompatibilityTable does not mistake a 'MuleSoft' label for the Mule-runtime row", () => {
  const html = `
    <h2>1.2.0</h2>
    <table>
      <tr><td>MuleSoft Certified</td><td>yes</td></tr>
      <tr><td>Mule Runtime</td><td>4.4.0 or later</td></tr>
      <tr><td>OpenJDK</td><td>8, 11, and 17</td></tr>
    </table>`;
  assert.deepEqual(parseCompatibilityTable(html), [
    { version: "1.2.0", jdks: [8, 11, 17], muleRuntime: "4.4.0 or later" },
  ]);
});

test("muleRuntimeFor returns the runtime string for a version, else null", () => {
  const entries = parseCompatibilityTable(RELEASE_NOTES_HTML);
  assert.equal(muleRuntimeFor(entries, "1.8.0"), "4.6.0 and later");
  assert.equal(muleRuntimeFor(entries, "1.9.1"), null);
  assert.equal(muleRuntimeFor(entries, "9.9.9"), null);
  assert.equal(muleRuntimeFor(entries, ""), null);
});

test("buildConnectorChoice surfaces muleRuntime for matrixSet and firstCompatible (B6)", () => {
  const jdkEntries = parseCompatibilityTable(RELEASE_NOTES_HTML); // 1.7.3/1.8.0/1.9.1
  const choice = buildConnectorChoice({
    artifactId: "mule-http-connector",
    matrixSet: "1.8.0",
    liveVersions: ["1.7.3", "1.8.0", "1.9.1"],
    jdkEntries,
  });
  assert.equal(choice.firstCompatible, "1.8.0");
  assert.deepEqual(choice.muleRuntime, {
    matrixSet: "4.6.0 and later", // runtime for the pinned 1.8.0
    firstCompatible: "4.6.0 and later", // firstCompatible === 1.8.0 here
  });
});

test("buildConnectorChoice.muleRuntime is null-filled when jdkEntries carry no runtime column", () => {
  // JDK-only shape (parseOpenJdkTable output) → muleRuntimeFor tolerates missing muleRuntime.
  const choice = buildConnectorChoice({
    artifactId: "x",
    matrixSet: "1.0.0",
    jdkEntries: [{ version: "1.0.0", jdks: [8, 11, 17] }],
  });
  assert.deepEqual(choice.muleRuntime, { matrixSet: null, firstCompatible: null });
});

test("firstJava17Version picks the LOWEST version whose row includes 17", () => {
  const entries = parseOpenJdkTable(RELEASE_NOTES_HTML);
  assert.equal(firstJava17Version(entries), "1.8.0");
  assert.equal(firstJava17Version([{ version: "2.0.0", jdks: [8, 11] }]), null);
  assert.equal(firstJava17Version([]), null);
});

// ── highestVersion / latestInMajor ──────────────────────────────────────────────────────
test("highestVersion returns the numerically greatest semver", () => {
  assert.equal(highestVersion(["1.0.17", "1.0.9", "1.0.100"]), "1.0.100");
  assert.equal(highestVersion(["10.19.2", "11.0.0", "9.5.1"]), "11.0.0");
  assert.equal(highestVersion([]), null);
});

test("latestInMajor never crosses the major boundary", () => {
  const versions = ["1.0.9", "1.0.17", "2.0.0", "2.1.0"];
  assert.equal(latestInMajor(versions, 1), "1.0.17"); // stays in 1.x even though 2.x exists
  assert.equal(latestInMajor(versions, 2), "2.1.0");
  assert.equal(latestInMajor(versions, 3), null);
});

// ── buildConnectorChoice ────────────────────────────────────────────────────────────────
test("buildConnectorChoice: matrix pin is recommended; latest-in-major + latest offered; staleness raised", () => {
  const choice = buildConnectorChoice({
    artifactId: "mule4-slack-connector",
    groupId: "com.mulesoft.connectors",
    matrixSet: "1.0.17",
    liveVersions: ["1.0.9", "1.0.17", "1.0.20", "2.0.0", "2.1.0"],
    jdkEntries: [
      { version: "1.0.15", jdks: [8, 11] },
      { version: "1.0.17", jdks: [8, 11, 17] },
    ],
  });
  assert.equal(choice.recommended, "1.0.17"); // curated floor, NEVER auto-jumps to latest
  assert.equal(choice.firstCompatible, "1.0.17");
  assert.equal(choice.latest, "2.1.0");
  assert.equal(choice.latestInMajor, "1.0.20"); // stays in 1.x
  // menu: min(1.0.17), in-major(1.0.20), latest(2.1.0). first-compatible dedupes with min(1.0.17).
  const strategies = choice.options.map((o) => o.strategy);
  assert.ok(strategies.includes("min"));
  assert.ok(strategies.includes("in-major"));
  assert.ok(strategies.includes("latest"));
  // staleness: 1.0.20 > matrix 1.0.17 within 1.x
  assert.match(choice.staleness, /1\.0\.20/);
});

test("buildConnectorChoice with no live data → matrix-only single option, no staleness", () => {
  const choice = buildConnectorChoice({
    artifactId: "mule-http-connector",
    groupId: "org.mule.connectors",
    matrixSet: "1.11.3",
  });
  assert.equal(choice.recommended, "1.11.3");
  assert.equal(choice.latest, null);
  assert.equal(choice.latestInMajor, null);
  assert.equal(choice.firstCompatible, null);
  assert.equal(choice.staleness, null);
  assert.deepEqual(
    choice.options.map((o) => o.version),
    ["1.11.3"]
  );
});

// ── pickVersion ─────────────────────────────────────────────────────────────────────────
test("pickVersion resolves each strategy against a choice", () => {
  const choice = buildConnectorChoice({
    artifactId: "x",
    matrixSet: "1.0.17",
    liveVersions: ["1.0.20", "2.0.0"],
    jdkEntries: [{ version: "1.0.15", jdks: [11, 17] }],
  });
  assert.equal(pickVersion(choice, "latest"), "2.0.0");
  assert.equal(pickVersion(choice, "in-major"), "1.0.20");
  assert.equal(pickVersion(choice, "min"), "1.0.17"); // curated matrix floor
  assert.equal(pickVersion(choice, "first-compatible"), "1.0.15");
  assert.equal(pickVersion(choice, "manual", "1.0.99"), "1.0.99");
  assert.equal(pickVersion(choice, "manual"), "1.0.17"); // no override → matrixSet
  assert.equal(pickVersion(choice, undefined), "1.0.17"); // default → matrixSet
});

test("pickVersion falls back to matrixSet when a live-derived value is missing", () => {
  const choice = buildConnectorChoice({ artifactId: "x", matrixSet: "1.11.3" });
  assert.equal(pickVersion(choice, "latest"), "1.11.3");
  assert.equal(pickVersion(choice, "in-major"), "1.11.3");
  assert.equal(pickVersion(choice, "min"), "1.11.3");
  assert.equal(pickVersion(choice, "first-compatible"), "1.11.3");
});

// ── notes-map lookup (connectorReleaseNotesUrl / loadNotesMap) ───────────────────────────
test("connectorReleaseNotesUrl looks up the URL in an injected Map", () => {
  const map = new Map([["mule-http-connector", "https://docs.mulesoft.com/release-notes/connector/connector-http"]]);
  assert.equal(
    connectorReleaseNotesUrl("mule-http-connector", map),
    "https://docs.mulesoft.com/release-notes/connector/connector-http"
  );
});

test("connectorReleaseNotesUrl accepts a {notesMap} options object", () => {
  const notesMap = new Map([["mule-db-connector", "https://docs.mulesoft.com/release-notes/connector/connector-db"]]);
  assert.equal(
    connectorReleaseNotesUrl("mule-db-connector", { notesMap }),
    "https://docs.mulesoft.com/release-notes/connector/connector-db"
  );
});

test("connectorReleaseNotesUrl returns null for an unmapped connector", () => {
  assert.equal(connectorReleaseNotesUrl("no-such-connector", new Map()), null);
  assert.equal(connectorReleaseNotesUrl("", new Map()), null);
});

test("loadNotesMap parses the bundled connector-notes-map.yaml and maps the matrix connectors", () => {
  _resetNotesMapCache();
  const { byArtifact } = loadNotesMap();
  assert.ok(byArtifact instanceof Map);
  // The 15 curated matrix connectors must all resolve to an https docs URL.
  for (const artifactId of ["mule-http-connector", "mule-db-connector", "mule-salesforce-connector"]) {
    const url = byArtifact.get(artifactId);
    assert.ok(typeof url === "string" && url.startsWith("https://"), `${artifactId} -> ${url}`);
  }
  _resetNotesMapCache();
});

test("notesMapPath points at references/connector-notes-map.yaml", () => {
  assert.ok(notesMapPath().replace(/\\/g, "/").endsWith("references/connector-notes-map.yaml"));
});

// ── resolveVersions (non-fatal orchestration) ───────────────────────────────────────────
const MINI_MATRIX = {
  connectors: [
    {
      property: "slack.connector.version",
      set: "1.0.17",
      groupId: "com.mulesoft.connectors",
      artifactId: "mule4-slack-connector",
    },
    {
      property: "http.connector.version",
      set: "1.11.3",
      groupId: "org.mule.connectors",
      artifactId: "mule-http-connector",
    },
  ],
};

test("resolveVersions: noFetch yields matrix-only choices (no network)", async () => {
  const { choices, source } = await resolveVersions({ matrix: MINI_MATRIX, noFetch: true });
  assert.equal(source, "matrix-only");
  assert.equal(choices.length, 2);
  for (const ch of choices) {
    assert.equal(ch.recommended, ch.matrixSet);
    assert.equal(ch.latest, null);
  }
});

test("resolveVersions: live Exchange + release-notes enrich the choices; failures are non-fatal", async () => {
  const exchange = {
    async listVersions(groupId, artifactId) {
      if (artifactId === "mule4-slack-connector")
        return { ok: true, versions: ["1.0.17", "1.0.20", "2.0.0"], latest: "2.0.0", release: "2.0.0" };
      return { ok: false, reason: "test: not published" }; // http fails → non-fatal
    },
  };
  const fetchHtml = async (url) => {
    if (url.includes("slack"))
      return `<h2>1.0.16</h2><table><tr><td>OpenJDK</td><td>8 and 11</td></tr></table>
              <h2>1.0.17</h2><table><tr><td>OpenJDK</td><td>8, 11, and 17</td></tr></table>`;
    throw new Error("test: no page");
  };
  const { choices, warnings, source } = await resolveVersions({
    matrix: MINI_MATRIX,
    exchange,
    fetchHtml,
  });
  assert.equal(source, "live");
  const slack = choices.find((c) => c.artifactId === "mule4-slack-connector");
  assert.equal(slack.latest, "2.0.0");
  assert.equal(slack.latestInMajor, "1.0.20");
  assert.equal(slack.firstCompatible, "1.0.17");
  assert.equal(slack.recommended, "1.0.17"); // matrix floor, not the 2.0.0 latest

  const http = choices.find((c) => c.artifactId === "mule-http-connector");
  assert.equal(http.recommended, "1.11.3"); // both live sources failed → matrix-only, still valid
  assert.equal(http.latest, null);

  // failures surfaced as warnings, never thrown
  assert.ok(warnings.some((w) => /mule-http-connector/.test(w)));
});

test("resolveVersions: injected notesMap drives the release-notes URLs (only mapped connectors fetch)", async () => {
  const seen = [];
  const fetchHtml = async (url) => {
    seen.push(url);
    return "";
  };
  // Map ONLY the slack connector — http is deliberately unmapped, so it must not be fetched.
  const notesMap = new Map([["mule4-slack-connector", "https://mirror.example.com/rn/slack"]]);
  await resolveVersions({ matrix: MINI_MATRIX, fetchHtml, notesMap });
  assert.deepEqual(seen, ["https://mirror.example.com/rn/slack"]);
});

test("resolveVersions: an empty notesMap skips all release-notes fetches (non-fatal)", async () => {
  const seen = [];
  const fetchHtml = async (url) => {
    seen.push(url);
    return "";
  };
  const { source } = await resolveVersions({ matrix: MINI_MATRIX, fetchHtml, notesMap: new Map() });
  assert.equal(seen.length, 0);
  assert.equal(source, "live"); // fetchHtml present → still a "live" run even if nothing mapped
});

// ── applyVersionStrategy ────────────────────────────────────────────────────────────────
test("applyVersionStrategy rewrites connector pins per strategy, never below the curated floor", async () => {
  const choices = [
    buildConnectorChoice({
      artifactId: "mule4-slack-connector",
      groupId: "com.mulesoft.connectors",
      matrixSet: "1.0.17",
      liveVersions: ["1.0.17", "1.0.20", "2.0.0"],
      jdkEntries: [{ version: "1.0.16", jdks: [11, 17] }],
    }),
    buildConnectorChoice({
      artifactId: "mule-http-connector",
      groupId: "org.mule.connectors",
      matrixSet: "1.11.3",
    }), // no live data → matrix-only
  ];

  // in-major: slack → 1.0.20 ; http has no live data → stays 1.11.3
  const inMajor = applyVersionStrategy({ matrix: MINI_MATRIX, choices, strategy: "in-major" });
  const slackPin = inMajor.matrix.connectors.find((c) => c.artifactId === "mule4-slack-connector");
  const httpPin = inMajor.matrix.connectors.find((c) => c.artifactId === "mule-http-connector");
  assert.equal(slackPin.set, "1.0.20");
  assert.equal(httpPin.set, "1.11.3"); // floor preserved when strategy has no live value
  assert.equal(inMajor.applied.length, 1);
  assert.deepEqual(inMajor.applied[0], {
    artifactId: "mule4-slack-connector",
    from: "1.0.17",
    to: "1.0.20",
    strategy: "in-major",
  });

  // manual: explicit per-connector selection wins; unselected connectors keep the curated pin
  const manual = applyVersionStrategy({
    matrix: MINI_MATRIX,
    choices,
    strategy: "manual",
    selections: { "mule4-slack-connector": "1.0.19" },
  });
  assert.equal(manual.matrix.connectors.find((c) => c.artifactId === "mule4-slack-connector").set, "1.0.19");
  assert.equal(manual.matrix.connectors.find((c) => c.artifactId === "mule-http-connector").set, "1.11.3");

  // min: nothing changes from the curated matrix
  const min = applyVersionStrategy({ matrix: MINI_MATRIX, choices, strategy: "min" });
  assert.equal(min.applied.length, 0);
});
