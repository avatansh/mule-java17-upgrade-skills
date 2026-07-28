// catalog_probe.mjs — READ-ONLY: can Graph enumerate the FULL connector catalog with GAV + pagination?
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";
const token = await new AnypointClient()._getToken();
const GRAPH = "https://anypoint.mulesoft.com/graph/api/v1/graphql";
async function gql(q){ const r=await fetch(GRAPH,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({query:q})}); return JSON.parse(await r.text()); }

// 1) Introspect assets() args to see filters/pagination available.
const args = await gql(`query { __type(name:"Platform"){ fields{ name args{ name type{ name kind ofType{ name } } } } } }`);
const assetsField = args?.data?.__type?.fields?.find(f=>f.name==="assets");
console.log("assets() args:", JSON.stringify(assetsField?.args?.map(a=>a.name) ?? args));

// 2) Introspect the query input object to find a "type" filter (connector-only) + pagination.
const si = await gql(`query { __type(name:"SearchAsset"){ inputFields{ name type{ name kind ofType{ name } } } } }`);
console.log("SearchAsset inputFields:", JSON.stringify(si?.data?.__type?.inputFields?.map(f=>f.name) ?? si));

// 3) Try a type-filtered, paginated sweep: connectors only, page size + offset.
for (const q of [
  `query { assets(query:{ type:"connector", limit:5, offset:0 }){ groupId assetId version } }`,
  `query { assets(query:{ searchTerm:"connector", limit:5, offset:0 }){ groupId assetId version type } }`,
]) {
  const r = await gql(q);
  const a = r?.data?.assets;
  console.log("\nquery:", q.replace(/\s+/g," "));
  console.log("  count:", Array.isArray(a)?a.length:"ERR", JSON.stringify(a?.slice?.(0,3) ?? r?.errors?.[0]?.message ?? r).slice(0,400));
}
console.log("\n=== DONE ===");
