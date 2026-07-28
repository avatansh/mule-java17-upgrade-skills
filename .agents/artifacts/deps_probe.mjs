// deps_probe.mjs — READ-ONLY: can we (A) fetch a connector POM from Exchange Maven facade, and
// (B) get dependency edges from the Graph API to resolve transitively?
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";

const anypoint = new AnypointClient();
const token = await anypoint._getToken();
const org = anypoint.orgId;
console.log("org:", org, "token len:", (token||"").length);

async function get(url, base) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "follow" });
  const ct = res.headers.get("content-type") || "";
  const body = await res.text();
  return { status: res.status, ct: ct.split(";")[0], body };
}

// ---- (A) Try to fetch the Salesforce connector POM from the Exchange Maven facade ----
// Public MuleSoft connectors: groupId com.mulesoft.connectors. Try a couple of facade layouts.
console.log("\n=== (A) connector POM from Exchange Maven facade ===");
const MB = "https://maven.anypoint.mulesoft.com";
const gid = "com.mulesoft.connectors", aid = "mule-salesforce-connector", ver = "10.19.2";
const gidPath = gid.replace(/\./g, "/");
const candidates = [
  `${MB}/api/v3/maven/${gid}/${aid}/${ver}/${aid}-${ver}.pom`,
  `${MB}/api/v3/organizations/${org}/maven/${gid}/${aid}/${ver}/${aid}-${ver}.pom`,
  `${MB}/api/v1/maven/${gidPath}/${aid}/${ver}/${aid}-${ver}.pom`,
  `${MB}/api/v3/maven/${gidPath}/${aid}/${ver}/${aid}-${ver}.pom`,
];
for (const u of candidates) {
  try {
    const r = await get(u);
    const isPom = /<project/i.test(r.body);
    console.log(`  ${r.status} ${r.ct} pom=${isPom}  ${u.replace(MB,"")}`);
    if (isPom) {
      const deps = [...r.body.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)].length;
      console.log(`     → parsed <dependency> blocks: ${deps}`);
      const snip = r.body.match(/<dependencies>[\s\S]{0,400}/);
      if (snip) console.log("     snip:", snip[0].replace(/\s+/g," ").slice(0,350));
      break;
    }
  } catch (e) { console.log("  ERR", u.replace(MB,""), e.message); }
}

// ---- (B) Graph API dependencies field: depth + shape ----
console.log("\n=== (B) Graph API dependencies field ===");
const GRAPH = "https://anypoint.mulesoft.com/graph/api/v1/graphql";
async function gql(q){ const r = await fetch(GRAPH,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({query:q})}); return JSON.parse(await r.text()); }
// Does dependencies nest (transitive) or is it flat (direct only)? Introspect Dependency type.
const dt = await gql(`query { __type(name:"Dependency"){ fields{ name type{ name kind ofType{ name } } } } }`);
console.log("  Dependency type fields:", JSON.stringify(dt?.data?.__type?.fields?.map(f=>f.name) ?? dt));
// Real query: salesforce connector's dependencies as reported by Graph.
const q = `query { assets(query:{ searchTerm:"mule-salesforce-connector", limit:1 }) {
  groupId assetId version dependencies { groupId assetId version } } }`;
const r = await gql(q);
console.log("  salesforce deps:", JSON.stringify(r?.data?.assets?.[0] ?? r).slice(0,800));
console.log("\n=== DONE ===");
