// tests/cve.test.js — Step 6: vulnerability detection.
//
// The bias of these tests: a FALSE "resolved-by-upgrade" is the only unacceptable outcome. Reporting a
// fixed CVE as still-open is noise; reporting an open CVE as fixed is a security failure delivered with
// confidence. So version comparison and the affected-package filter get the hardest scrutiny here.

import test from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  affectedIntervals,
  isVersionAffected,
  fixForVersion,
  collectDependencies,
  plannedVersions,
  classifyVuln,
  buildCveReport,
  sortFindings,
} from "../skills/mule-upgrade-cve/scripts/lib/cve_engine.js";
import { OsvClient, severityOf, fixedVersionsFor, osvPackageName } from "../skills/mule-upgrade-cve/scripts/lib/osv.js";
import { formatCve } from "../skills/mule-upgrade-cve/scripts/format_cve.js";
import { parsePom } from "../skills/mule-upgrade-assess/scripts/lib/pom_parse.js";

// ── version comparison: the correctness-critical part ───────────────────────────────────────────

test("compareVersions handles MORE than three segments (the jackson 2.9.10.4 case)", () => {
  // This is the exact shape lib_shared/semver.js `lt` gets wrong: equal on major.minor.patch, and the
  // real difference is in a 4th segment. Getting this wrong marks a live CVE as fixed.
  assert.equal(compareVersions("2.9.10", "2.9.10.4"), -1, "2.9.10 is BELOW the 2.9.10.4 fix");
  assert.equal(compareVersions("2.9.10.4", "2.9.10"), 1);
  assert.equal(compareVersions("2.9.10.4", "2.9.10.4"), 0);
  assert.equal(compareVersions("2.9.10.3", "2.9.10.4"), -1);
  assert.equal(compareVersions("2.9.10.5", "2.9.10.4"), 1);
});

test("compareVersions treats missing segments as zero", () => {
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("1", "1.0.0.0"), 0);
  assert.equal(compareVersions("1.0.1", "1.0"), 1);
});

test("compareVersions orders majors and minors before longer tails", () => {
  assert.equal(compareVersions("1.9.9.9", "2.0.0"), -1);
  assert.equal(compareVersions("2.0.0", "1.9.9.9"), 1);
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1, "10 > 9 numerically, not lexically");
});

test("compareVersions puts a pre-release BELOW its release (Maven ordering)", () => {
  assert.equal(compareVersions("1.0.0-SNAPSHOT", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0-SNAPSHOT"), 1);
  assert.equal(compareVersions("1.0.0-rc1", "1.0.0-rc2"), -1);
  assert.equal(compareVersions("1.0.0-SNAPSHOT", "1.0.0-SNAPSHOT"), 0);
});

// ── affected ranges: the backported-fix trap ────────────────────────────────────────────────────
//
// These use REAL advisory data. Log4Shell is fixed in 2.3.1, 2.12.2 and 2.15.0 because maintainers
// patched three maintenance branches. Any logic of the form "version >= some published fix" declares an
// app on 2.14.1 patched against Log4Shell and tells it to "upgrade" to 2.3.1. Both are catastrophic, so
// they are pinned down here with the exact shipped data.

/** GHSA-jfh8-c2jp-5v3q / CVE-2021-44228, as OSV actually returns it. */
const LOG4SHELL = {
  id: "GHSA-jfh8-c2jp-5v3q",
  aliases: ["CVE-2021-44228"],
  database_specific: { severity: "CRITICAL" },
  affected: [
    { package: { name: "org.apache.logging.log4j:log4j-core" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "2.13.0" }, { fixed: "2.15.0" }] }] },
    { package: { name: "org.apache.logging.log4j:log4j-core" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "2.0-beta9" }, { fixed: "2.3.1" }] }] },
    { package: { name: "org.apache.logging.log4j:log4j-core" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "2.4" }, { fixed: "2.12.2" }] }] },
  ],
};
const LOG4J = "org.apache.logging.log4j:log4j-core";

/** GHSA-4gq5-ch57-c2mg / CVE-2018-14719, three jackson-databind branches. */
const JACKSON = {
  id: "GHSA-4gq5-ch57-c2mg",
  aliases: ["CVE-2018-14719"],
  database_specific: { severity: "CRITICAL" },
  affected: [
    { package: { name: "com.fasterxml.jackson.core:jackson-databind" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "2.9.0" }, { fixed: "2.9.7" }] }] },
    { package: { name: "com.fasterxml.jackson.core:jackson-databind" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "2.8.0" }, { fixed: "2.8.11.3" }] }] },
    { package: { name: "com.fasterxml.jackson.core:jackson-databind" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "2.0.0" }, { fixed: "2.7.9.5" }] }] },
  ],
};
const JDB = "com.fasterxml.jackson.core:jackson-databind";

test("affectedIntervals builds one half-open interval per maintenance branch", () => {
  const ivs = affectedIntervals(LOG4SHELL, LOG4J);
  assert.equal(ivs.length, 3);
  assert.deepEqual(
    ivs.map((i) => `${i.introduced}..<${i.fixed}`).sort(),
    ["2.0-beta9..<2.3.1", "2.13.0..<2.15.0", "2.4..<2.12.2"]
  );
});

test("isVersionAffected: log4j 2.14.1 IS exposed to Log4Shell despite 2.14.1 > 2.3.1", () => {
  // The whole reason this machinery exists.
  assert.ok(isVersionAffected("2.14.1", affectedIntervals(LOG4SHELL, LOG4J)));
});

test("isVersionAffected respects each branch's own upper bound", () => {
  const ivs = affectedIntervals(LOG4SHELL, LOG4J);
  assert.ok(isVersionAffected("2.14.0", ivs), "inside [2.13.0, 2.15.0)");
  assert.ok(!isVersionAffected("2.15.0", ivs), "`fixed` is EXCLUSIVE — the fix itself is safe");
  assert.ok(!isVersionAffected("2.17.1", ivs));
  assert.ok(isVersionAffected("2.12.1", ivs), "inside [2.4, 2.12.2)");
  assert.ok(!isVersionAffected("2.12.2", ivs), "the 2.12 branch fix");
  assert.ok(!isVersionAffected("2.3.1", ivs), "the 2.0 branch fix");
  assert.ok(!isVersionAffected("1.2.17", ivs), "below every introduced");
});

test("fixForVersion recommends the version's OWN branch fix, never a downgrade", () => {
  const ivs = affectedIntervals(LOG4SHELL, LOG4J);
  assert.equal(fixForVersion("2.14.1", ivs), "2.15.0", "NOT 2.3.1 — that is a downgrade and still vulnerable");
  assert.equal(fixForVersion("2.5.0", ivs), "2.12.2");
  assert.equal(fixForVersion("2.1.0", ivs), "2.3.1");
  assert.equal(fixForVersion("2.15.0", ivs), null, "already fixed → nothing to recommend");
});

test("fixForVersion picks jackson 2.9.0's real fix (2.9.7), not the lowest listed", () => {
  const ivs = affectedIntervals(JACKSON, JDB);
  assert.equal(fixForVersion("2.9.0", ivs), "2.9.7");
  assert.equal(fixForVersion("2.8.5", ivs), "2.8.11.3");
  assert.equal(fixForVersion("2.5.0", ivs), "2.7.9.5");
});

test("affectedIntervals handles last_affected (a branch that was never fixed)", () => {
  const v = {
    affected: [{ package: { name: "a:b" }, ranges: [{ events: [{ introduced: "1.0.0" }, { last_affected: "1.9.9" }] }] }],
  };
  const ivs = affectedIntervals(v, "a:b");
  assert.deepEqual(ivs, [{ introduced: "1.0.0", fixed: null, lastAffected: "1.9.9" }]);
  assert.ok(isVersionAffected("1.9.9", ivs), "last_affected is INCLUSIVE");
  assert.ok(!isVersionAffected("2.0.0", ivs));
  assert.equal(fixForVersion("1.5.0", ivs), null, "no fix to recommend on this branch");
});

test("affectedIntervals treats an unclosed range as affected without an upper bound", () => {
  const v = { affected: [{ package: { name: "a:b" }, ranges: [{ events: [{ introduced: "1.0.0" }] }] }] };
  const ivs = affectedIntervals(v, "a:b");
  assert.deepEqual(ivs, [{ introduced: "1.0.0", fixed: null, lastAffected: null }]);
  assert.ok(isVersionAffected("99.0.0", ivs), "nothing has fixed it yet");
  assert.ok(!isVersionAffected("0.9.0", ivs));
});

test("affectedIntervals sorts events so producer ordering cannot change the result", () => {
  const v = {
    affected: [{ package: { name: "a:b" }, ranges: [{ events: [{ fixed: "2.0.0" }, { introduced: "1.0.0" }] }] }],
  };
  assert.deepEqual(affectedIntervals(v, "a:b"), [{ introduced: "1.0.0", fixed: "2.0.0", lastAffected: null }]);
});

test("affectedIntervals skips GIT ranges (commit hashes are not versions)", () => {
  const v = {
    affected: [
      { package: { name: "a:b" }, ranges: [{ type: "GIT", events: [{ introduced: "abc123" }, { fixed: "def456" }] }] },
      { package: { name: "a:b" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "1.0.0" }, { fixed: "2.0.0" }] }] },
    ],
  };
  assert.deepEqual(affectedIntervals(v, "a:b"), [{ introduced: "1.0.0", fixed: "2.0.0", lastAffected: null }]);
});

test("affectedIntervals ignores another package's ranges", () => {
  assert.deepEqual(affectedIntervals(LOG4SHELL, "com.guicedee.services:log4j-core"), []);
});

test("isVersionAffected and fixForVersion are safe on empty input", () => {
  assert.ok(!isVersionAffected("1.0.0", []));
  assert.ok(!isVersionAffected("", [{ introduced: "0", fixed: null, lastAffected: null }]));
  assert.ok(!isVersionAffected("1.0.0", undefined));
  assert.equal(fixForVersion("1.0.0", []), null);
  assert.equal(fixForVersion("1.0.0", undefined), null);
});

// ── advisory parsing ────────────────────────────────────────────────────────────────────────────

test("severityOf maps OSV's vocabulary and refuses to invent a level", () => {
  assert.equal(severityOf({ database_specific: { severity: "CRITICAL" } }), "CRITICAL");
  assert.equal(severityOf({ database_specific: { severity: "HIGH" } }), "HIGH");
  assert.equal(severityOf({ database_specific: { severity: "MODERATE" } }), "MEDIUM", "MODERATE is MEDIUM");
  assert.equal(severityOf({ database_specific: { severity: "LOW" } }), "LOW");
  // A CVSS vector is a STRING, not a score. Without a CVSS parser the honest answer is UNKNOWN rather
  // than a made-up bucket.
  assert.equal(severityOf({ severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:H/..." }] }), "UNKNOWN");
  assert.equal(severityOf({}), "UNKNOWN");
  assert.equal(severityOf(null), "UNKNOWN");
});

test("fixedVersionsFor only reads the ranges of the MATCHING package", () => {
  // One advisory, two packages. Attributing jackson-core's fix to jackson-databind would understate the
  // required bump — the precise way to produce a false "resolved".
  const vuln = {
    affected: [
      {
        package: { name: "com.fasterxml.jackson.core:jackson-databind" },
        ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "2.9.0" }, { fixed: "2.9.10.4" }] }],
      },
      {
        package: { name: "com.fasterxml.jackson.core:jackson-core" },
        ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: "2.5.0" }] }],
      },
    ],
  };
  assert.deepEqual(fixedVersionsFor(vuln, "com.fasterxml.jackson.core:jackson-databind"), ["2.9.10.4"]);
  assert.deepEqual(fixedVersionsFor(vuln, "com.fasterxml.jackson.core:jackson-core"), ["2.5.0"]);
  assert.deepEqual(fixedVersionsFor({ affected: [] }, "x:y"), []);
});

test("fixedVersionsFor collects multiple fix branches and de-duplicates", () => {
  const vuln = {
    affected: [
      {
        package: { name: "a:b" },
        ranges: [
          { events: [{ introduced: "1.0" }, { fixed: "1.2.0" }] },
          { events: [{ introduced: "2.0" }, { fixed: "2.1.0" }] },
          { events: [{ introduced: "2.0" }, { fixed: "2.1.0" }] },
        ],
      },
    ],
  };
  assert.deepEqual(fixedVersionsFor(vuln, "a:b"), ["1.2.0", "2.1.0"]);
});

test("osvPackageName builds the Maven ecosystem coordinate", () => {
  assert.equal(osvPackageName("org.mule.connectors", "mule-http-connector"), "org.mule.connectors:mule-http-connector");
  assert.equal(osvPackageName(" a ", " b "), "a:b");
});

// ── dependency collection ───────────────────────────────────────────────────────────────────────

const APP_POM = `<project>
  <groupId>com.acme</groupId><artifactId>orders</artifactId><version>1.0.0</version>
  <properties>
    <jackson.version>2.9.0</jackson.version>
    <mule.http.version>1.5.0</mule.http.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>\${jackson.version}</version>
    </dependency>
    <dependency>
      <groupId>org.mule.connectors</groupId>
      <artifactId>mule-http-connector</artifactId>
      <version>\${mule.http.version}</version>
    </dependency>
    <dependency>
      <groupId>com.acme</groupId>
      <artifactId>no-version-here</artifactId>
    </dependency>
  </dependencies>
  <build><plugins>
    <plugin>
      <groupId>org.mule.tools.maven</groupId>
      <artifactId>mule-maven-plugin</artifactId>
      <version>3.8.0</version>
    </plugin>
  </plugins></build>
</project>`;

const PARENT_POM = `<project>
  <groupId>com.acme</groupId><artifactId>parent</artifactId><version>2.0.0</version>
  <dependencyManagement><dependencies>
    <dependency>
      <groupId>org.apache.logging.log4j</groupId>
      <artifactId>log4j-core</artifactId>
      <version>2.14.1</version>
    </dependency>
  </dependencies></dependencyManagement>
</project>`;

const CHAIN = [
  { path: "pom.xml", pom: parsePom(APP_POM), pomText: APP_POM },
  { path: "../parent/pom.xml", pom: parsePom(PARENT_POM), pomText: PARENT_POM },
];

test("collectDependencies resolves ${property} versions through the chain", () => {
  const deps = collectDependencies({ chain: CHAIN });
  const byName = Object.fromEntries(deps.map((d) => [d.name, d]));

  assert.equal(byName["com.fasterxml.jackson.core:jackson-databind"].version, "2.9.0");
  assert.equal(byName["org.mule.connectors:mule-http-connector"].version, "1.5.0");
  assert.equal(byName["org.mule.tools.maven:mule-maven-plugin"].version, "3.8.0");
});

test("collectDependencies reaches dependencyManagement in a PARENT pom and records where", () => {
  const deps = collectDependencies({ chain: CHAIN });
  const log4j = deps.find((d) => d.name === "org.apache.logging.log4j:log4j-core");
  assert.ok(log4j, "a managed dependency declared upstream is still the app's exposure");
  assert.equal(log4j.version, "2.14.1");
  assert.equal(log4j.origin, "dependencyManagement");
  assert.equal(log4j.declaredIn, "../parent/pom.xml", "the report must point at the pom to edit");
});

test("collectDependencies surfaces an unresolvable version instead of dropping or guessing it", () => {
  const deps = collectDependencies({ chain: CHAIN });
  const noVer = deps.find((d) => d.name === "com.acme:no-version-here");
  assert.ok(noVer, "a coordinate with no version must stay visible");
  assert.equal(noVer.version, "", "an empty version marks it unqueryable, not version-zero");
});

test("collectDependencies does not fabricate a version from an unresolved property", () => {
  const pom = `<project><dependencies><dependency>
      <groupId>a</groupId><artifactId>b</artifactId><version>\${nowhere.defined}</version>
    </dependency></dependencies></project>`;
  const deps = collectDependencies({ chain: [{ path: "pom.xml", pom: parsePom(pom) }] });
  assert.equal(deps.length, 1);
  assert.equal(deps[0].version, "", "an unresolved placeholder is NOT a version");
});

test("collectDependencies ignores entries with no coordinates", () => {
  const pom = `<project><dependencies>
      <dependency><artifactId>orphan</artifactId><version>1.0</version></dependency>
    </dependencies></project>`;
  assert.deepEqual(collectDependencies({ chain: [{ path: "pom.xml", pom: parsePom(pom) }] }), []);
  assert.deepEqual(collectDependencies({ chain: [] }), []);
  assert.deepEqual(collectDependencies({ chain: null }), []);
});

// ── classification ──────────────────────────────────────────────────────────────────────────────

/** One advisory affecting `name` from 0 up to each fix — i.e. one branch per fix version. */
const vulnFor = (name, fixed, severity = "HIGH") => ({
  id: `GHSA-test-${name}`,
  aliases: ["CVE-2020-0001"],
  database_specific: { severity },
  affected: fixed.length
    ? fixed.map((f) => ({ package: { name }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: f }] }] }))
    : [{ package: { name }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }] }] }],
});

test("classifyVuln does NOT credit a fix backported to an OLDER branch (the Log4Shell trap)", () => {
  // An app on log4j 2.14.1 whose upgrade moves it to 2.14.1 (or anywhere below 2.15.0) is STILL exposed.
  // "2.14.1 >= 2.3.1" must not be allowed to read as resolved.
  const dep = { name: LOG4J, version: "2.14.1" };
  const c = classifyVuln({ vuln: LOG4SHELL, dep, plannedVersion: "2.14.1" });
  assert.equal(c.status, "action-required", "still inside [2.13.0, 2.15.0)");
  assert.equal(c.minimumFix, "2.15.0", "and the advice is a real upgrade, not a downgrade to 2.3.1");
});

test("classifyVuln credits the upgrade once it ESCAPES the affected interval", () => {
  const dep = { name: LOG4J, version: "2.14.1" };
  const c = classifyVuln({ vuln: LOG4SHELL, dep, plannedVersion: "2.17.1" });
  assert.equal(c.status, "resolved-by-upgrade");
  assert.equal(c.plannedVersion, "2.17.1");
});

test("classifyVuln reports a branch with no fix as no-fix-available, and says fixes exist elsewhere", () => {
  // Affected from 2.13.0 with no upper bound, but the 2.0 branch was fixed at 2.3.1. Telling a 2.14.1
  // app to "upgrade to 2.3.1" would be a downgrade, so it must not appear as action-required.
  const vuln = {
    id: "GHSA-branchless",
    database_specific: { severity: "HIGH" },
    affected: [
      { package: { name: LOG4J }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "2.13.0" }] }] },
      { package: { name: LOG4J }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "2.0" }, { fixed: "2.3.1" }] }] },
    ],
  };
  const c = classifyVuln({ vuln, dep: { name: LOG4J, version: "2.14.1" }, plannedVersion: "2.17.1" });
  assert.equal(c.status, "no-fix-available");
  assert.equal(c.minimumFix, null);
  assert.equal(c.fixedOnOtherBranchOnly, true, "a different decision from 'nobody has fixed this'");
  assert.deepEqual(c.fixedVersions, ["2.3.1"]);
});

test("classifyVuln credits the upgrade when the plan REACHES a fixed version", () => {
  const dep = { name: "a:b", version: "1.0.0" };
  const c = classifyVuln({ vuln: vulnFor("a:b", ["1.5.0"]), dep, plannedVersion: "1.6.0" });
  assert.equal(c.status, "resolved-by-upgrade");
  assert.equal(c.plannedVersion, "1.6.0");
  assert.equal(c.minimumFix, "1.5.0");
});

test("classifyVuln demands action when the plan STOPS SHORT of the fix", () => {
  const dep = { name: "a:b", version: "1.0.0" };
  const c = classifyVuln({ vuln: vulnFor("a:b", ["1.9.0"]), dep, plannedVersion: "1.6.0" });
  assert.equal(c.status, "action-required", "a bump that doesn't reach the fix is not a fix");
  assert.equal(c.minimumFix, "1.9.0", "the user is told exactly how far to go");
  assert.equal(c.plannedVersion, "1.6.0");
});

test("classifyVuln reports action-required when the upgrade does not touch the dep at all", () => {
  const c = classifyVuln({ vuln: vulnFor("a:b", ["1.9.0"]), dep: { name: "a:b", version: "1.0.0" }, plannedVersion: undefined });
  assert.equal(c.status, "action-required");
  assert.equal(c.plannedVersion, null);
});

test("classifyVuln never presents an unfixable advisory as fixable", () => {
  const c = classifyVuln({ vuln: vulnFor("a:b", []), dep: { name: "a:b", version: "1.0.0" }, plannedVersion: "9.9.9" });
  assert.equal(c.status, "no-fix-available", "even a huge bump cannot fix what has no published fix");
  assert.equal(c.minimumFix, null);
  assert.ok(!c.fixedOnOtherBranchOnly, "genuinely unfixed, not merely unfixed on this branch");
});

test("classifyVuln picks the SMALLEST escape from the app's version, across segment lengths", () => {
  const c = classifyVuln({
    vuln: vulnFor("a:b", ["2.10.0", "2.9.10.4", "3.0.0"]),
    dep: { name: "a:b", version: "2.9.0" },
    plannedVersion: null,
  });
  assert.equal(c.minimumFix, "2.9.10.4", "the smallest viable bump, not the first listed");
});

test("classifyVuln does NOT mark resolved from another package's fix range", () => {
  // The plan moves a:b to 3.0.0. The advisory's a:b fix is 4.0.0; only the UNRELATED c:d is fixed at
  // 1.0.0. Reading ranges without filtering by package would call this resolved.
  const vuln = {
    id: "GHSA-multi",
    database_specific: { severity: "CRITICAL" },
    affected: [
      { package: { name: "c:d" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "1.0.0" }] }] },
      { package: { name: "a:b" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "4.0.0" }] }] },
    ],
  };
  const c = classifyVuln({ vuln, dep: { name: "a:b", version: "2.0.0" }, plannedVersion: "3.0.0" });
  assert.equal(c.status, "action-required");
  assert.equal(c.minimumFix, "4.0.0");
});

// This is the VERBATIM fileEdits array assess() produces for a Mule 4.4 / Java 8 app (captured from a
// live run). Pinning the real shape is the point: reading changePlan off the wrong object, or keying on
// artifactId alone, both fail silently — the scan just reports zero resolved advisories forever, with no
// error to notice.
const REAL_FILE_EDITS = [
  { property: "app.runtime", kind: "pomProperty", file: "pom.xml", from: "4.4.0", to: "4.9.18", change: true },
  { property: "app.runtime.semver", kind: "pomProperty", file: "pom.xml", from: null, to: "4.9.18", change: true },
  { property: "java.version", kind: "pomProperty", file: "pom.xml", from: "1.8", to: "17", change: true },
  { property: "maven.compiler.source", kind: "pomProperty", file: "pom.xml", from: null, to: "17", change: true },
  { property: "maven.compiler.target", kind: "pomProperty", file: "pom.xml", from: null, to: "17", change: true },
  {
    kind: "depVersion",
    file: "pom.xml",
    from: "1.5.25",
    to: "1.11.3",
    change: true,
    property: "http.connector.version",
    groupId: "org.mule.connectors",
    artifactId: "mule-http-connector",
  },
  { file: "pom.xml", kind: "pomVersion", artifactId: "orders-api", from: "1.0.0", to: "1.1.0", change: true },
];

test("plannedVersions extracts coordinate bumps from the REAL changePlan.fileEdits shape", () => {
  const m = plannedVersions({ fileEdits: REAL_FILE_EDITS });
  assert.equal(m.get("org.mule.connectors:mule-http-connector"), "1.11.3");
  assert.equal(m.size, 1, "only the depVersion edit is a dependency coordinate");
});

test("plannedVersions ignores the app's OWN pomVersion bump", () => {
  // The pomVersion edit has an artifactId but no groupId. Keying on artifactId alone would put the app
  // itself in the dependency map and let its own 1.0.0 -> 1.1.0 bump "resolve" an unrelated advisory.
  const m = plannedVersions({ fileEdits: REAL_FILE_EDITS });
  assert.ok(!m.has("orders-api"), "the app is not one of its own dependencies");
  for (const key of m.keys()) assert.match(key, /:/, `every key is a groupId:artifactId (${key})`);
});

test("plannedVersions ignores property-only edits", () => {
  const m = plannedVersions({ fileEdits: [{ property: "java.version", to: "17" }] });
  assert.equal(m.size, 0);
  assert.equal(plannedVersions(null).size, 0);
  assert.equal(plannedVersions({}).size, 0);
});

// ── report assembly ─────────────────────────────────────────────────────────────────────────────

test("buildCveReport counts, buckets and sorts worst-first", () => {
  const deps = [
    { name: "a:b", version: "1.0.0", origin: "dependency", declaredIn: "pom.xml" },
    { name: "c:d", version: "1.0.0", origin: "dependency", declaredIn: "pom.xml" },
  ];
  const vulns = new Map([
    ["V-crit", vulnFor("a:b", ["9.0.0"], "CRITICAL")],
    ["V-low", vulnFor("a:b", ["1.1.0"], "LOW")],
    ["V-nofix", vulnFor("c:d", [], "HIGH")],
  ]);
  vulns.get("V-crit").id = "V-crit";
  vulns.get("V-low").id = "V-low";
  vulns.get("V-nofix").id = "V-nofix";

  const r = buildCveReport({
    deps,
    idsPerDep: [["V-crit", "V-low"], ["V-nofix"]],
    vulns,
    planned: new Map([["a:b", "1.2.0"]]),
  });

  assert.equal(r.summary.total, 3);
  assert.equal(r.summary.critical, 1);
  assert.equal(r.summary.actionRequired, 1, "V-crit: plan reaches 1.2.0, fix needs 9.0.0");
  assert.equal(r.summary.resolvedByUpgrade, 1, "V-low: fixed at 1.1.0, plan reaches 1.2.0");
  assert.equal(r.summary.noFixAvailable, 1);
  assert.equal(r.findings[0].id, "V-crit", "critical + action-required sorts first");
  assert.equal(r.scanned.dependencies, 2);
});

test("buildCveReport never invents a finding for an advisory it could not fetch", () => {
  const r = buildCveReport({
    deps: [{ name: "a:b", version: "1.0.0", origin: "dependency", declaredIn: "pom.xml" }],
    idsPerDep: [["MISSING-1", "MISSING-2"]],
    vulns: new Map(),
    warnings: ["detail fetch failed"],
    complete: false,
  });
  assert.equal(r.findings.length, 0, "an ID with no detail yields no fabricated finding");
  assert.equal(r.complete, false, "and the report says it is incomplete");
});

test("buildCveReport de-duplicates the same advisory on the same coordinate", () => {
  const v = vulnFor("a:b", ["2.0.0"]);
  v.id = "DUP";
  const r = buildCveReport({
    deps: [{ name: "a:b", version: "1.0.0", origin: "dependency", declaredIn: "pom.xml" }],
    idsPerDep: [["DUP", "DUP"]],
    vulns: new Map([["DUP", v]]),
  });
  assert.equal(r.findings.length, 1);
});

test("buildCveReport ALWAYS carries the transitive-scope limitation, even with zero findings", () => {
  const r = buildCveReport({ deps: [], idsPerDep: [], vulns: new Map() });
  assert.equal(r.summary.total, 0);
  assert.ok(
    r.limitations.some((l) => /[Tt]ransitive dependencies are NOT resolved/.test(l)),
    "a clean scan is exactly when the scope limit matters most"
  );
  assert.ok(r.limitations.some((l) => /lower bound/.test(l)));
  assert.equal(r.scanned.source, "declared-coordinates-only");
});

test("buildCveReport reports unresolved-version coordinates as a counted gap", () => {
  const r = buildCveReport({
    deps: [
      { name: "a:b", version: "1.0.0", origin: "dependency", declaredIn: "pom.xml" },
      { name: "c:d", version: "", origin: "dependency", declaredIn: "pom.xml" },
    ],
    idsPerDep: [[], []],
    vulns: new Map(),
  });
  assert.equal(r.scanned.dependencies, 1);
  assert.equal(r.scanned.unresolvedVersions, 1);
  assert.ok(r.limitations.some((l) => /could not be queried/.test(l)));
});

test("sortFindings is stable and total (no ordering ambiguity between equal rows)", () => {
  const mk = (severity, status, pkg, id) => ({ severity, status, package: pkg, id });
  const sorted = sortFindings([
    mk("HIGH", "resolved-by-upgrade", "b:b", "2"),
    mk("HIGH", "action-required", "b:b", "1"),
    mk("CRITICAL", "no-fix-available", "a:a", "3"),
    mk("HIGH", "action-required", "a:a", "0"),
  ]);
  assert.deepEqual(sorted.map((f) => f.id), ["3", "0", "1", "2"]);
});

// ── the OSV client, with a fake transport ───────────────────────────────────────────────────────

function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    for (const [pattern, respond] of handlers) {
      if (String(url).includes(pattern)) return respond(init);
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  impl.calls = calls;
  return impl;
}
const ok = (payload) => ({ ok: true, status: 200, json: async () => payload });

test("queryBatch maps results back to inputs BY POSITION", () => {
  // OSV guarantees order, not keys. A misalignment here attributes one library's CVEs to another — a
  // silent, plausible-looking corruption, so it is asserted explicitly.
  const fetchImpl = fakeFetch([
    ["/v1/querybatch", () => ok({ results: [{ vulns: [{ id: "A1" }] }, {}, { vulns: [{ id: "C1" }, { id: "C2" }] }] })],
  ]);
  const osv = OsvClient({ fetchImpl, refresh: true });
  return osv
    .queryBatch([
      { name: "a:a", version: "1" },
      { name: "b:b", version: "1" },
      { name: "c:c", version: "1" },
    ])
    .then((r) => {
      assert.ok(r.ok);
      assert.deepEqual(r.ids, [["A1"], [], ["C1", "C2"]]);
    });
});

test("queryBatch sends the Maven ecosystem and the concrete version", () => {
  const fetchImpl = fakeFetch([["/v1/querybatch", () => ok({ results: [{}] })]]);
  const osv = OsvClient({ fetchImpl, refresh: true });
  return osv.queryBatch([{ name: "a:b", version: "1.2.3" }]).then(() => {
    assert.deepEqual(fetchImpl.calls[0].body.queries[0], {
      package: { ecosystem: "Maven", name: "a:b" },
      version: "1.2.3",
    });
  });
});

test("queryBatch degrades to ok:false with partial ids instead of throwing", () => {
  const fetchImpl = fakeFetch([["/v1/querybatch", () => ({ ok: false, status: 503, json: async () => ({}) })]]);
  const osv = OsvClient({ fetchImpl, refresh: true });
  return osv.queryBatch([{ name: "a:b", version: "1" }]).then((r) => {
    assert.equal(r.ok, false, "an OSV outage must not throw into the upgrade");
    assert.deepEqual(r.ids, [[]]);
    assert.match(r.reason, /503/);
  });
});

test("queryBatch short-circuits on an empty input without a request", () => {
  const fetchImpl = fakeFetch([]);
  return OsvClient({ fetchImpl, refresh: true })
    .queryBatch([])
    .then((r) => {
      assert.deepEqual(r, { ok: true, ids: [] });
      assert.equal(fetchImpl.calls.length, 0);
    });
});

test("fetchVulns caps detail fetches and SAYS SO rather than under-reporting silently", () => {
  const fetchImpl = fakeFetch([["/v1/vulns/", (init) => ok({ id: "X" })]]);
  const osv = OsvClient({ fetchImpl, refresh: true, maxVulnDetails: 2 });
  return osv.fetchVulns(["A", "B", "C", "D", "E"]).then((r) => {
    assert.equal(r.skipped, 3);
    assert.ok(
      r.warnings.some((w) => /only the first 2 were detailed/.test(w)),
      "truncation must be visible in the output"
    );
  });
});

test("fetchVulns de-duplicates IDs before spending requests", () => {
  const fetchImpl = fakeFetch([["/v1/vulns/", () => ok({ id: "SAME" })]]);
  const osv = OsvClient({ fetchImpl, refresh: true });
  return osv.fetchVulns(["SAME", "SAME", "SAME", null, ""]).then((r) => {
    assert.equal(fetchImpl.calls.length, 1, "one unique ID → one request");
    assert.equal(r.vulns.size, 1);
  });
});

test("fetchVulns records a per-advisory failure and keeps the rest", () => {
  const fetchImpl = fakeFetch([
    [
      "/v1/vulns/",
      (init) => ({ ok: false, status: 500, json: async () => ({}) }),
    ],
  ]);
  const osv = OsvClient({ fetchImpl, refresh: true });
  return osv.fetchVulns(["BAD"]).then((r) => {
    assert.equal(r.vulns.size, 0);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /BAD/);
  });
});

// ── output ──────────────────────────────────────────────────────────────────────────────────────

test("formatCve leads with action-required and always prints the scope limits", () => {
  const text = formatCve({
    ok: true,
    appName: "orders-api",
    planCompared: true,
    scanned: { dependencies: 12, unresolvedVersions: 0, source: "declared-coordinates-only" },
    summary: { total: 2, critical: 1, high: 0, medium: 0, low: 1, unknown: 0, resolvedByUpgrade: 1, actionRequired: 1, noFixAvailable: 0 },
    findings: [
      { id: "V1", cve: ["CVE-2021-1"], package: "a:b", currentVersion: "1.0.0", severity: "CRITICAL", status: "action-required", minimumFix: "9.0.0", plannedVersion: "1.2.0", summary: "bad things", origin: "dependency", declaredIn: "pom.xml" },
      { id: "V2", cve: [], package: "a:b", currentVersion: "1.0.0", severity: "LOW", status: "resolved-by-upgrade", minimumFix: "1.1.0", plannedVersion: "1.2.0", summary: "", origin: "dependency", declaredIn: "pom.xml" },
    ],
    limitations: ["Transitive dependencies are NOT resolved"],
    complete: true,
    warnings: [],
  });

  assert.ok(text.indexOf("ACTION REQUIRED") < text.indexOf("RESOLVED BY THE UPGRADE"), "action comes first");
  assert.match(text, /upgrade to 9\.0\.0 or later/);
  assert.match(text, /the upgrade plan only reaches 1\.2\.0/);
  assert.match(text, /SCOPE AND LIMITS/);
  assert.match(text, /CVE-2021-1/);
});

test("formatCve states the scope limits even when nothing was found", () => {
  const text = formatCve({
    ok: true,
    appName: "clean-app",
    planCompared: true,
    scanned: { dependencies: 5, unresolvedVersions: 0 },
    summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0, unknown: 0, resolvedByUpgrade: 0, actionRequired: 0, noFixAvailable: 0 },
    findings: [],
    limitations: ["Transitive dependencies are NOT resolved — treat findings as a lower bound"],
    complete: true,
  });
  assert.match(text, /No known advisories matched/);
  assert.match(text, /lower bound/, "an empty result must not read as a security clearance");
});

test("formatCve distinguishes 'plan fixes nothing' from 'no plan was compared'", () => {
  const base = {
    ok: true,
    scanned: { dependencies: 3 },
    summary: { total: 1, critical: 0, high: 1, medium: 0, low: 0, unknown: 0, resolvedByUpgrade: 0, actionRequired: 1, noFixAvailable: 0 },
    findings: [],
    limitations: [],
    complete: true,
  };
  // The comparison RAN and found the upgrade touches none of these libraries — real information.
  const ran = formatCve({ ...base, planCompared: true, plannedCoordinateCount: 0 });
  assert.match(ran, /plan moves no scanned dependency version/);
  assert.ok(!/No upgrade plan was compared/.test(ran), "a successful comparison must not read as a failure");

  // The comparison did NOT run.
  const skipped = formatCve({ ...base, planCompared: false, plannedCoordinateCount: 0 });
  assert.match(skipped, /No upgrade plan was compared/);

  const credited = formatCve({
    ...base,
    planCompared: true,
    plannedCoordinateCount: 2,
    summary: { ...base.summary, resolvedByUpgrade: 1 },
  });
  assert.match(credited, /plan resolves 1 of them/);
});

test("formatCve flags an incomplete scan so counts are not over-trusted", () => {
  const text = formatCve({
    ok: true,
    scanned: { dependencies: 1 },
    summary: { total: 0 },
    findings: [],
    limitations: [],
    complete: false,
    warnings: ["OSV query was incomplete"],
  });
  assert.match(text, /INCOMPLETE/);
  assert.match(text, /OSV query was incomplete/);
});

test("formatCve renders a scan that never ran without pretending it was clean", () => {
  const text = formatCve({ ok: false, reason: "No fetch implementation available" });
  assert.match(text, /SCAN DID NOT RUN/);
  assert.ok(!/No known advisories matched/.test(text), "a failed scan must not look like a clean one");
});
