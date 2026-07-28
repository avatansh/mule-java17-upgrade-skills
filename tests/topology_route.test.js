// tests/topology_route.test.js — Tier 2c: the pure upgrade-strategy router (skills/mule-upgrade/
// scripts/lib/topology_route.js). Given a ChangePlan it picks app-pom | parent-pom | none. This is
// the decision the orchestrator turns into either the app pipeline or a parent-pom job dispatch.
import { test } from "node:test";
import assert from "node:assert/strict";

import { routeUpgradeStrategy } from "../skills/mule-upgrade/scripts/lib/topology_route.js";

test("routeUpgradeStrategy: app-pom when the app's own pom carries edits", () => {
  const r = routeUpgradeStrategy({
    topology: "APP_STANDALONE",
    fileEdits: [{ file: "pom.xml", kind: "pomProperty" }],
    connectorGaps: [],
  });
  assert.equal(r.strategy, "app-pom");
  assert.equal(r.fileEditCount, 1);
});

test("routeUpgradeStrategy: app-pom takes precedence even if inherited gaps also exist", () => {
  // Mixed: the app declares some of its own versions (edits) AND inherits others below matrix. The
  // app pipeline runs; the inherited gaps are surfaced as warnings by assess, not a separate route.
  const r = routeUpgradeStrategy({
    topology: "BOM_PARENT_APP",
    fileEdits: [{ file: "pom.xml", kind: "depVersion" }],
    connectorGaps: [{ artifactId: "mule-db-connector", from: "1.0.0", to: "1.14.6" }],
  });
  assert.equal(r.strategy, "app-pom");
  assert.equal(r.connectorGapCount, 1, "gaps still reported on the route");
});

test("routeUpgradeStrategy: parent-pom when no app edits but inherited connector gaps exist", () => {
  const r = routeUpgradeStrategy({
    topology: "BOM_PARENT_APP",
    fileEdits: [],
    connectorGaps: [
      { artifactId: "mule-http-connector", from: "1.7.0", to: "1.11.3" },
      { artifactId: "mule-db-connector", from: "1.0.0", to: "1.14.6" },
    ],
  });
  assert.equal(r.strategy, "parent-pom");
  assert.equal(r.connectorGapCount, 2);
  assert.match(r.reason, /parent\/BOM must be bumped/);
  assert.match(r.reason, /mule-http-connector 1\.7\.0→1\.11\.3/);
});

test("routeUpgradeStrategy: none when there are neither edits nor gaps", () => {
  const r = routeUpgradeStrategy({ topology: "APP_STANDALONE", fileEdits: [], connectorGaps: [] });
  assert.equal(r.strategy, "none");
  assert.match(r.reason, /already in the desired state/);
});

test("routeUpgradeStrategy: tolerates a null/'undefined' changePlan → none", () => {
  assert.equal(routeUpgradeStrategy(null).strategy, "none");
  assert.equal(routeUpgradeStrategy(undefined).topology, "UNKNOWN");
});
