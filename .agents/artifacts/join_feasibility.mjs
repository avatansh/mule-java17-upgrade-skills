// READ-ONLY. Uses only global fetch (no shell, no child process).
// Can a display-name-derived Graph search resolve the correct connector-group artifactId?
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";
const token = await new AnypointClient()._getToken();
const GRAPH="https://anypoint.mulesoft.com/graph/api/v1/graphql";
async function gql(q){const r=await fetch(GRAPH,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({query:q})});try{return JSON.parse(await r.text());}catch{return{};}}
const CONN=new Set(["org.mule.connectors","com.mulesoft.connectors","org.mule.modules","com.mulesoft.modules"]);
// (displayName-ish search term, expected artifactId)
const CASES=[
  ["Salesforce Connector","mule-salesforce-connector"],
  ["HTTP Connector","mule-http-connector"],
  ["Database Connector","mule-db-connector"],
  ["NetSuite Connector","mule-netsuite-connector"],
  ["Slack Connector","mule4-slack-connector"],
  ["Amazon S3 Connector","(unknown)"],
  ["Salesforce Composite Connector","(unknown)"],
  ["Anaplan Connector","(unknown)"],
];
for(const [term,expect] of CASES){
  const j=await gql(`query { assets(query:{ searchTerm:${JSON.stringify(term)}, type:"connector", limit:10 }){ groupId assetId version } }`);
  const rows=j?.data?.assets??[];
  const conn=rows.filter(r=>CONN.has(r.groupId));
  const top=conn[0]||rows[0];
  console.log(`"${term}" → top=${top?top.groupId+":"+top.assetId:"(none)"} connGroupHits=${conn.length} expect=${expect}`);
  console.log(`     first5: ${JSON.stringify(rows.slice(0,5).map(r=>r.assetId))}`);
}
console.log("=== DONE ===");
