// scope_probe.mjs — READ-ONLY. Uses only global fetch (no shell, no child process).
// Decide how to enumerate the PUBLIC MuleSoft connector set for G1/G2, since the blind
// type:"connector" offset sweep is scoped to THIS org's visible Exchange (misses public connectors).
// Tests: (a) searchTerm broad terms + pagination reach public connectors? (b) do our 15 matrix
// connectors each resolve via a per-artifactId searchTerm, and what groupId do they report?
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MATRIX = path.resolve(__dirname, "..", "..", "skills", "mule-upgrade-assess", "references", "compatibility-matrix.yaml");
const GRAPH = "https://anypoint.mulesoft.com/graph/api/v1/graphql";

const client = new AnypointClient();
const token = await client._getToken();
console.log(`token len=${token.length}`);
async function gql(query) {
  const res = await fetch(GRAPH, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query }) });
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 200) }; }
}

// (a) Broad searchTerm + type:connector, does pagination reach public connectors? Count exact-ish.
console.log("\n=== (a) broad searchTerm sweeps ===");
for (const term of ["connector", "mule", "anypoint"]) {
  let all = [];
  for (let off = 0; off < 500; off += 100) {
    const r = await gql(`query { assets(query:{ searchTerm:"${term}", type:"connector", limit:100, offset:${off} }){ groupId assetId version } }`);
    const a = r?.data?.assets;
    if (!Array.isArray(a)) { console.log(`  term="${term}" off=${off} ERR ${JSON.stringify(r?.errors?.[0]?.message ?? r).slice(0,120)}`); break; }
    all.push(...a);
    if (a.length < 100) break;
  }
  const publicGroups = all.filter((x) => x.groupId === "org.mule.connectors" || x.groupId === "com.mulesoft.connectors");
  const uniq = new Set(all.map((x) => x.groupId + ":" + x.assetId));
  console.log(`  term="${term}": rows=${all.length} uniqGAV=${uniq.size} publicConnGroupRows=${publicGroups.length}`);
  console.log(`    sample public: ${JSON.stringify([...new Set(publicGroups.map((x) => x.assetId))].slice(0, 8))}`);
}

// (b) per-artifactId searchTerm for each of our 15 matrix connectors → does it resolve + groupId?
console.log("\n=== (b) per-connector searchTerm resolution ===");
const matrix = yaml.load(fs.readFileSync(MATRIX, "utf8"));
for (const c of matrix.connectors ?? []) {
  const r = await gql(`query { assets(query:{ searchTerm:"${c.artifactId}", limit:100 }){ groupId assetId version } }`);
  const a = r?.data?.assets ?? [];
  const exact = a.filter((x) => x.assetId === c.artifactId);
  const groups = [...new Set(exact.map((x) => x.groupId))];
  const vnum = (v) => v.split(".").map(Number).reduce((s, n, i) => s + n * [1e6, 1e3, 1][i], 0);
  const versions = [...new Set(exact.map((x) => x.version))].sort((a, b) => vnum(a) - vnum(b));
  console.log(`  ${c.artifactId}: exact=${exact.length} groups=${JSON.stringify(groups)} grpMatch=${groups.includes(c.groupId)} maxVer=${versions[versions.length - 1] ?? "-"} (matrix ${c.set})`);
}
console.log("\n=== DONE ===");
