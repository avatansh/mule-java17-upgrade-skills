// exchange_graph_probe4.mjs — resolve query ergonomics + free-form metadata shape.
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";
const client = new AnypointClient();
const token = await client._getToken();
const GRAPH = "https://anypoint.mulesoft.com/graph/api/v1/graphql";
async function gql(query) {
  const res = await fetch(GRAPH, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query }) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0,200) }; }
}
const inputFields = async (n) => {
  const j = await gql(`query { __type(name:"${n}"){ inputFields{ name type{ name kind ofType{ name } } } } }`);
  return (j?.data?.__type?.inputFields ?? []).map(f => `${f.name}:${f.type?.ofType?.name||f.type?.name||f.type?.kind}`);
};
const objFields = async (n) => {
  const j = await gql(`query { __type(name:"${n}"){ kind fields{ name } } }`);
  const t = j?.data?.__type;
  return t ? `${t.kind}: ${(t.fields||[]).map(f=>f.name).join(", ")}` : "(null)";
};

console.log("SearchAsset input:", (await inputFields("SearchAsset")).join(", "));
console.log("Attribute:", await objFields("Attribute"));
console.log("Label:", await objFields("Label"));
console.log("Category:", await objFields("Category"));

// Real search for the premium Salesforce connector — dump attributes/categories/labels to see if
// ANY free-form entry names java/jdk. searchTerm only (no GAV filter available).
console.log("\n=== salesforce search → free-form metadata ===");
const j = await gql(`query {
  assets(query:{ searchTerm:"mule-salesforce-connector", limit:5 }) {
    groupId assetId version type runtimeVersion
    categories { key value }
    attributes { value }
    labels { value }
  }
}`);
console.log(JSON.stringify(j, null, 1).slice(0, 2500));
console.log("\n=== DONE ===");
