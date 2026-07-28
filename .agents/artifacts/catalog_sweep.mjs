// catalog_sweep.mjs — P0 data generation (G1 + B4 + version-enumeration confirmation for G3).
// READ-ONLY against Anypoint. Uses only global fetch (no shell, no child process).
//
//   G1: paginate the Exchange GraphQL catalog for type:"connector", dedup to highest-semver per GAV,
//       filter to real connector groupIds, and write exchange-catalog.json.
//   G3-probe: confirm the query shape that enumerates ALL versions of ONE connector (each version is
//       a separate assets() row), so listVersions() can be rewired to Graph.
//   B4: diff the live catalog + bundled matrix connectors to find which are missing on each side.
//
// Writes: exchange-catalog.json, matrix-diff.json in this artifacts dir. Prints a summary only
// (no secrets; token length only).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";
import { highestSemver } from "../../lib_shared/exchange.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_CATALOG = path.join(__dirname, "exchange-catalog.json");
const OUT_DIFF = path.join(__dirname, "matrix-diff.json");
const MATRIX = path.resolve(__dirname, "..", "..", "skills", "mule-upgrade-assess", "references", "compatibility-matrix.yaml");

const GRAPH = "https://anypoint.mulesoft.com/graph/api/v1/graphql";
const CONNECTOR_GROUPS = new Set(["org.mule.connectors", "com.mulesoft.connectors", "org.mule.modules"]);

const client = new AnypointClient();
const token = await client._getToken();
console.log(`token acquired (len=${token.length})`);

async function gql(query) {
  const res = await fetch(GRAPH, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; }
  catch { return { status: res.status, json: null, text: text.slice(0, 300) }; }
}

// ---- G3 probe: enumerate ALL versions of one known connector -------------------------------------
// Salesforce is premium (com.mulesoft.connectors). Confirm which filter returns multiple version rows.
console.log("\n=== G3 probe: version enumeration for mule-salesforce-connector ===");
for (const q of [
  `query { assets(query:{ searchTerm:"mule-salesforce-connector", limit:50 }){ groupId assetId version type } }`,
  `query { assets(query:{ groupId:"com.mulesoft.connectors", assetId:"mule-salesforce-connector", limit:50 }){ groupId assetId version type } }`,
]) {
  const r = await gql(q);
  const a = r.json?.data?.assets;
  const label = q.includes("groupId:") ? "GAV-filter" : "searchTerm";
  if (Array.isArray(a)) {
    const exact = a.filter((x) => x.assetId === "mule-salesforce-connector");
    console.log(`  [${label}] rows=${a.length} exactMatch=${exact.length} versions=${JSON.stringify(exact.map((x) => x.version).slice(0, 12))}`);
  } else {
    console.log(`  [${label}] ERR ${JSON.stringify(r.json?.errors?.[0]?.message ?? r.text ?? r.json).slice(0, 200)}`);
  }
}

// ---- G1: paginate the full connector catalog -----------------------------------------------------
console.log("\n=== G1: catalog sweep (type:connector, paginated) ===");
const PAGE = 100;
let offset = 0;
let raw = [];
for (let page = 0; page < 100; page++) {
  const q = `query { assets(query:{ type:"connector", limit:${PAGE}, offset:${offset} }){ groupId assetId version type runtimeVersion } }`;
  const r = await gql(q);
  const a = r.json?.data?.assets;
  if (!Array.isArray(a)) {
    console.log(`  page ${page} offset ${offset}: ERR ${JSON.stringify(r.json?.errors?.[0]?.message ?? r.text ?? r.json).slice(0, 200)}`);
    break;
  }
  raw.push(...a);
  console.log(`  page ${page} offset ${offset}: +${a.length} (total ${raw.length})`);
  if (a.length < PAGE) break;
  offset += PAGE;
}

// Dedup to highest semver per groupId:assetId; keep connector groupIds only.
const byGav = new Map();
for (const row of raw) {
  const gid = row.groupId, aid = row.assetId;
  if (!gid || !aid) continue;
  const key = `${gid}:${aid}`;
  const cur = byGav.get(key);
  if (!cur) byGav.set(key, { groupId: gid, assetId: aid, versions: new Set([row.version]), runtimeVersion: row.runtimeVersion });
  else cur.versions.add(row.version);
}
const catalog = [...byGav.values()]
  .map((c) => ({
    groupId: c.groupId,
    assetId: c.assetId,
    latest: highestSemver([...c.versions]),
    versionCount: c.versions.size,
    runtimeVersion: c.runtimeVersion ?? null,
    isConnectorGroup: CONNECTOR_GROUPS.has(c.groupId),
  }))
  .sort((a, b) => (a.groupId + a.assetId).localeCompare(b.groupId + b.assetId));

const connectorOnly = catalog.filter((c) => c.isConnectorGroup);
fs.writeFileSync(OUT_CATALOG, JSON.stringify({ generatedFrom: "exchange-graphql", totalAssets: raw.length, uniqueGav: catalog.length, connectorGroupGav: connectorOnly.length, groups: [...new Set(catalog.map((c) => c.groupId))].sort(), catalog }, null, 2));
console.log(`  wrote ${OUT_CATALOG}: ${catalog.length} unique GAV (${connectorOnly.length} in connector groups)`);
console.log(`  groups seen: ${JSON.stringify([...new Set(catalog.map((c) => c.groupId))].sort())}`);

// ---- B4: diff bundled matrix connectors vs catalog ----------------------------------------------
console.log("\n=== B4: bundled matrix vs live catalog ===");
const matrix = yaml.load(fs.readFileSync(MATRIX, "utf8"));
const bundled = (matrix.connectors ?? []).map((c) => ({ artifactId: c.artifactId, groupId: c.groupId, set: c.set }));
const catByAid = new Map(catalog.map((c) => [c.assetId, c]));
const diff = bundled.map((b) => {
  const live = catByAid.get(b.artifactId);
  return {
    artifactId: b.artifactId,
    groupId: b.groupId,
    matrixSet: b.set,
    inCatalog: Boolean(live),
    liveGroupId: live?.groupId ?? null,
    liveLatest: live?.latest ?? null,
    groupMatches: live ? live.groupId === b.groupId : null,
  };
});
const missingInCatalog = diff.filter((d) => !d.inCatalog);
fs.writeFileSync(OUT_DIFF, JSON.stringify({ bundledCount: bundled.length, matchedInCatalog: diff.length - missingInCatalog.length, missingInCatalog, diff }, null, 2));
console.log(`  bundled connectors: ${bundled.length}, matched in catalog: ${diff.length - missingInCatalog.length}`);
console.log(`  bundled NOT in catalog: ${JSON.stringify(missingInCatalog.map((d) => d.artifactId))}`);
for (const d of diff) console.log(`    ${d.inCatalog ? "OK" : "??"} ${d.artifactId} matrix=${d.matrixSet} live=${d.liveLatest ?? "-"} grpMatch=${d.groupMatches}`);
console.log("\n=== DONE ===");
