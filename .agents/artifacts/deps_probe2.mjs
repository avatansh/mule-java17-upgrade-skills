// deps_probe2.mjs — READ-ONLY: confirm (A) per-EXACT-version Graph dependencies, and (B) the POM
// facade path works for an OSS (org.mule.connectors) connector too. Uses only global fetch to stay
// clear of the security hook. Evidence for B12/B13.
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";

const anypoint = new AnypointClient();
const token = await anypoint._getToken();
const GRAPH = "https://anypoint.mulesoft.com/graph/api/v1/graphql";
const MB = "https://maven.anypoint.mulesoft.com";

async function gql(q) {
  const r = await fetch(GRAPH, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: q }),
  });
  return JSON.parse(await r.text());
}

// (A) Do dependencies differ per version row? Sweep salesforce pages, print (version → deps count).
console.log("=== (A) per-version dependencies (salesforce, first 3 pages) ===");
const term = JSON.stringify("mule-salesforce-connector");
const perVer = new Map();
for (let page = 0; page < 3; page++) {
  const data = await gql(
    `query { assets(query:{ searchTerm:${term}, limit:100, offset:${page * 100} }){ groupId assetId version dependencies { groupId assetId version } } }`
  );
  for (const a of data?.data?.assets ?? []) {
    if (a.assetId !== "mule-salesforce-connector") continue;
    if (!perVer.has(a.version)) perVer.set(a.version, (a.dependencies ?? []).map((d) => `${d.assetId}@${d.version}`));
  }
}
for (const [v, deps] of [...perVer].slice(0, 8)) console.log(`  ${v}: [${deps.join(", ")}]`);
console.log(`  distinct versions seen: ${perVer.size}`);

// (B) OSS connector POM via facade (org.mule.connectors / mule-http-connector).
console.log("\n=== (B) OSS connector POM (mule-http-connector 1.11.3) ===");
const u = `${MB}/api/v3/maven/org.mule.connectors/mule-http-connector/1.11.3/mule-http-connector-1.11.3.pom`;
const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` }, redirect: "follow" });
const body = await r.text();
console.log(`  ${r.status} pom=${/<project/i.test(body)}  deps=${[...body.matchAll(/<dependency>/g)].length}`);
// Show a couple of ${property}-versioned + hardcoded deps to validate the parser design.
const blocks = [...body.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].slice(0, 40).map((m) => m[1]);
let propCount = 0,
  litCount = 0,
  noneCount = 0;
for (const b of blocks) {
  const ver = (b.match(/<version>\s*([^<]*)<\/version>/) ?? [])[1];
  if (ver == null) noneCount++;
  else if (/\$\{/.test(ver)) propCount++;
  else litCount++;
}
console.log(`  of first ${blocks.length} deps → \${prop}:${propCount} literal:${litCount} no-version(BOM):${noneCount}`);
console.log("\n=== DONE ===");
