// version_enum_probe.mjs — READ-ONLY. Uses only global fetch (no shell, no child process).
// Resolve the RED FLAG: searchTerm for mule-http-connector capped at 1.5.15 while matrix=1.11.3.
// Determine the correct way to enumerate the FULL, current version list of one connector for G3.
//   (1) Paginate searchTerm fully — does it eventually surface 1.11.x, and what's the true max?
//   (2) Is there a singular asset(...) query or a versions/otherVersions sub-field?
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";
const client = new AnypointClient();
const token = await client._getToken();
console.log(`token len=${token.length}`);
const GRAPH = "https://anypoint.mulesoft.com/graph/api/v1/graphql";
async function gql(query) {
  const res = await fetch(GRAPH, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query }) });
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { raw: t.slice(0, 200) }; }
}
const vnum = (v) => String(v).split(".").map((n) => Number(n) || 0).reduce((s, n, i) => s + n * [1e6, 1e3, 1][i], 0);

// (1) Fully paginate searchTerm for http; collect ALL exact-match versions.
console.log("\n=== (1) full searchTerm pagination: mule-http-connector ===");
{
  const seen = new Set();
  for (let off = 0; off < 2000; off += 100) {
    const r = await gql(`query { assets(query:{ searchTerm:"mule-http-connector", limit:100, offset:${off} }){ groupId assetId version } }`);
    const a = r?.data?.assets;
    if (!Array.isArray(a) || a.length === 0) { console.log(`  off=${off}: end (${Array.isArray(a) ? 0 : "ERR"})`); break; }
    for (const x of a) if (x.assetId === "mule-http-connector") seen.add(x.version);
    if (a.length < 100) { console.log(`  off=${off}: last page (${a.length})`); break; }
  }
  const vers = [...seen].sort((a, b) => vnum(a) - vnum(b));
  console.log(`  total exact versions=${vers.length} max=${vers[vers.length - 1]} min=${vers[0]}`);
  console.log(`  has 1.11.x? ${vers.some((v) => v.startsWith("1.11."))}  has 1.10.x? ${vers.some((v) => v.startsWith("1.10."))}`);
  console.log(`  top: ${JSON.stringify(vers.slice(-12))}`);
}

// (2) Introspect top-level query for a singular asset(...) field + Asset version-list sub-fields.
console.log("\n=== (2) singular asset query + version sub-fields ===");
{
  const q = await gql(`query { __type(name:"Platform"){ fields{ name args{ name } } } }`);
  const fields = q?.data?.__type?.fields ?? [];
  console.log("  Platform query fields:", JSON.stringify(fields.map((f) => f.name)));
  const asset = fields.find((f) => f.name === "asset");
  if (asset) console.log("  asset() args:", JSON.stringify(asset.args.map((a) => a.name)));
  // Asset object: any versions / otherVersions / assetVersions field?
  const at = await gql(`query { __type(name:"Asset"){ fields{ name } } }`);
  const af = (at?.data?.__type?.fields ?? []).map((f) => f.name);
  console.log("  Asset fields:", JSON.stringify(af));
  console.log("  version-listish fields:", JSON.stringify(af.filter((n) => /version/i.test(n))));
}
console.log("\n=== DONE ===");
