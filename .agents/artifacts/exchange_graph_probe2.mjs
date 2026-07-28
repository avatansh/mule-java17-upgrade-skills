// exchange_graph_probe2.mjs — READ-ONLY follow-up probe. Endpoint confirmed:
//   https://anypoint.mulesoft.com/graph/api/v1/graphql  (queryType = Platform)
// Now: (1) full field dump of Asset + related types, (2) a corrected real query using the
// field names the server suggested (runtimeVersion, version), so we can see actual data + whether
// any Java/JDK compatibility signal is present.
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";

const client = new AnypointClient();
const token = await client._getToken();
const GRAPH = "https://anypoint.mulesoft.com/graph/api/v1/graphql";

async function gql(query, variables) {
  const res = await fetch(GRAPH, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text };
  }
}

// 1) Root Platform type: what query entry points exist?
console.log("=== Platform (root) query fields ===");
{
  const r = await gql(`query { __type(name:"Platform"){ fields{ name args{ name } type{ name kind ofType{ name kind } } } } }`);
  const fields = r.json?.data?.__type?.fields ?? [];
  for (const f of fields) {
    const t = f.type?.ofType?.name || f.type?.name || f.type?.kind;
    console.log(`  ${f.name}(${(f.args||[]).map(a=>a.name).join(",")}) : ${t}`);
  }
}

// 2) Full Asset field dump — the crux. Does ANYTHING carry java/jdk/runtime compatibility?
console.log("\n=== Asset type — ALL fields ===");
{
  const r = await gql(`query { __type(name:"Asset"){ fields(includeDeprecated:true){ name type{ name kind ofType{ name kind } } } } }`);
  const fields = r.json?.data?.__type?.fields ?? [];
  if (!fields.length) console.log("  (0 fields — dumping raw)", JSON.stringify(r.json).slice(0,300));
  for (const f of fields) {
    const t = f.type?.ofType?.name || f.type?.name || f.type?.kind;
    const flag = /java|jdk|runtime|mule|compat/i.test(f.name) ? "   <<< compat?" : "";
    console.log(`  ${f.name} : ${t}${flag}`);
  }
}

// 3) Corrected real query — use the field names the server confirmed exist.
console.log("\n=== Real query: search 'salesforce', ask for confirmed fields ===");
{
  const r = await gql(`query {
    assets(query:{ searchTerm:"salesforce", limit:3 }) {
      groupId assetId version name type runtimeVersion
      dependencies { groupId assetId version }
    }
  }`);
  console.log("  status", r.status);
  console.log("  ", JSON.stringify(r.json).slice(0, 1800));
}

console.log("\n=== DONE ===");
