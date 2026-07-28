// tests/connector_deps.test.js — B12/B13: connectorGap enrichment with one-level Graph deps + POM
// version-management classification. All non-fatal; the enricher never throws.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  enrichConnectorGaps,
  classifyPom,
} from "../skills/mule-upgrade-assess/scripts/lib/connector_deps.js";

// A fake ExchangeClient exposing just the surface enrichConnectorGaps uses.
function fakeExchange({ configured = true, graph, pom } = {}) {
  return {
    configured: () => configured,
    graphDependencies: graph,
    fetchPom: pom,
  };
}

const GAPS = [
  { groupId: "com.mulesoft.connectors", artifactId: "mule-salesforce-connector", from: "9.4.5", to: "10.19.2" },
];

test("enrichConnectorGaps: no gaps → empty result", async () => {
  const { gaps, warnings } = await enrichConnectorGaps({ gaps: [], exchange: fakeExchange() });
  assert.deepEqual(gaps, []);
  assert.deepEqual(warnings, []);
});

test("enrichConnectorGaps: no/unconfigured exchange → gaps returned unenriched (live fields null)", async () => {
  for (const exchange of [undefined, fakeExchange({ configured: false, graph: async () => ({}) })]) {
    const { gaps } = await enrichConnectorGaps({ gaps: GAPS, exchange });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].artifactId, "mule-salesforce-connector");
    assert.equal(gaps[0].dependencies, null);
    assert.equal(gaps[0].pom, null);
  }
});

test("enrichConnectorGaps: attaches one-level deps + POM classification", async () => {
  const graph = async (groupId, artifactId, version) => {
    assert.equal(version, "10.19.2"); // enrich uses the TARGET version, not `from`
    return {
      ok: true,
      dependencies: [
        { groupId: "org.mule.connectors", assetId: "mule-objectstore-connector", version: "1.0.0" },
      ],
    };
  };
  const pom = async () => ({
    ok: true,
    properties: { "objectstore.version": "1.0.0" },
    dependencies: [
      { groupId: "org.mule.connectors", artifactId: "mule-objectstore-connector", version: null, versionRef: "objectstore.version", managed: false },
      { groupId: "com.x", artifactId: "commons", version: "1.3.0", versionRef: null, managed: false },
      { groupId: "org.mule.sdk", artifactId: "mule-sdk-api", version: null, versionRef: null, managed: true },
    ],
  });
  const { gaps, warnings } = await enrichConnectorGaps({ gaps: GAPS, exchange: fakeExchange({ graph, pom }) });
  assert.equal(warnings.length, 0);
  const g = gaps[0];
  assert.deepEqual(
    g.dependencies.map((d) => d.assetId),
    ["mule-objectstore-connector"]
  );
  assert.equal(g.pom.depCount, 3);
  assert.equal(g.pom.literal, 1);
  assert.equal(g.pom.managed, 1);
  assert.equal(g.pom.hasManagedVersions, true);
  assert.deepEqual(g.pom.propertyVersioned, [
    { groupId: "org.mule.connectors", artifactId: "mule-objectstore-connector", versionRef: "objectstore.version", resolved: "1.0.0" },
  ]);
});

test("enrichConnectorGaps: a failed lookup is non-fatal → warning + null field", async () => {
  const graph = async () => ({ ok: false, reason: "graph down" });
  const pom = async () => ({ ok: false, reason: "pom 404" });
  const { gaps, warnings } = await enrichConnectorGaps({ gaps: GAPS, exchange: fakeExchange({ graph, pom }) });
  assert.equal(gaps[0].dependencies, null);
  assert.equal(gaps[0].pom, null);
  assert.ok(warnings.some((w) => /graph down/.test(w)));
  assert.ok(warnings.some((w) => /pom 404/.test(w)));
});

test("enrichConnectorGaps: a thrown lookup is caught and surfaced, never propagates", async () => {
  const graph = async () => {
    throw new Error("boom");
  };
  const { gaps, warnings } = await enrichConnectorGaps({ gaps: GAPS, exchange: fakeExchange({ graph }) });
  assert.equal(gaps[0].dependencies, null);
  assert.ok(warnings.some((w) => /boom/.test(w)));
});

test("classifyPom: reduces a POM to counts + resolved property versions", () => {
  const c = classifyPom({
    properties: { "a.version": "2.0.0" },
    dependencies: [
      { artifactId: "a", groupId: "g", versionRef: "a.version" },
      { artifactId: "b", groupId: "g", versionRef: "missing.version" }, // resolved null (inherited prop)
      { artifactId: "c", groupId: "g", version: "3.0.0" },
      { artifactId: "d", groupId: "g", managed: true },
    ],
  });
  assert.equal(c.depCount, 4);
  assert.equal(c.literal, 1);
  assert.equal(c.managed, 1);
  assert.equal(c.propertyVersioned.length, 2);
  assert.equal(c.propertyVersioned.find((p) => p.artifactId === "a").resolved, "2.0.0");
  assert.equal(c.propertyVersioned.find((p) => p.artifactId === "b").resolved, null);
  assert.equal(c.hasManagedVersions, true);
});

test("classifyPom: a purely literal POM has hasManagedVersions=false", () => {
  const c = classifyPom({ properties: {}, dependencies: [{ artifactId: "a", groupId: "g", version: "1.0.0" }] });
  assert.equal(c.hasManagedVersions, false);
  assert.equal(c.literal, 1);
});
