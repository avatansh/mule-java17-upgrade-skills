// exchange_graph_probe3.mjs — final READ-ONLY probe.
// (1) Fetch exact premium (Salesforce) + OSS (HTTP) connectors by GAV, dump the free-form
//     metadata lists (categories/attributes/customFields/tags/labels) to see if Java compat hides there.
// (2) Prove ONE call can batch multiple connectors via GraphQL aliases.
// (3) Show how versions are enumerated (versionGroup / assetVersions).
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";

const client = new AnypointClient();
const token = await client._getToken();
const GRAPH = "https://anypoint.mulesoft.com/graph/api/v1/graphql";

async function gql(query, variables) {
  const res = await fetch(GRAPH, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  try { return { status: res.status, json: JSON.parse(text) }; }
  catch { return { status: res.status, json: null, text }; }
}

// 1) Introspect the assets() query args so we filter by GAV correctly.
console.log("=== assets() input type (AssetQuery) fields ===");
{
  const r = await gql(`query { __type(name:"AssetQuery"){ inputFields{ name type{ name kind ofType{ name } } } } }`);
  const f = r.json?.data?.__type?.inputFields ?? [];
  console.log("  ", f.map(x => x.name).join(", ") || JSON.stringify(r.json).slice(0,300));
}

// 2) Batch TWO connectors in ONE call via aliases; dump free-form metadata lists.
console.log("\n=== ONE call, TWO connectors, full free-form metadata ===");
{
  const sub = (alias, gid, aid) => `
    ${alias}: assets(query:{ groupId:"${gid}", assetId:"${aid}", limit:1 }) {
      groupId assetId version type runtimeVersion
      categories { key value displayName }
      attributes { name value }
      customFields { key value }
      tags { value }
      labels
      dependencies { groupId assetId version }
    }`;
  // Salesforce = premium (com.mulesoft.connectors); HTTP = OSS (org.mule.connectors)
  const q = `query {
    ${sub("salesforce", "com.mulesoft.connectors", "mule-salesforce-connector")}
    ${sub("http", "org.mule.connectors", "mule-http-connector")}
  }`;
  const r = await gql(q);
  console.log("  status", r.status);
  console.log("  ", JSON.stringify(r.json, null, 1).slice(0, 3000));
}

// 3) How to enumerate versions? Check for a versions/assetVersions field via versionGroup.
console.log("\n=== version enumeration: does Asset expose a version list? ===");
{
  // Try common shapes; report which validate.
  for (const q of [
    `query { assets(query:{groupId:"com.mulesoft.connectors",assetId:"mule-salesforce-connector",limit:1}){ assetId version versionGroup } }`,
  ]) {
    const r = await gql(q);
    console.log("  ", JSON.stringify(r.json).slice(0, 500));
  }
}
console.log("\n=== DONE ===");
