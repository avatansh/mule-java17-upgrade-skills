// READ-ONLY. Uses only global fetch (no shell, no child process).
// Strategy test: slug/displayName -> candidate artifactIds -> Graph EXACT-verify (connector groups).
// Measures hit rate across ALL index connectors to decide G2 automation coverage.
import { AnypointClient } from "../../skills/mule-upgrade/scripts/lib/anypoint.js";
const token = await new AnypointClient()._getToken();
const GRAPH="https://anypoint.mulesoft.com/graph/api/v1/graphql";
const CONN=new Set(["org.mule.connectors","com.mulesoft.connectors","org.mule.modules","com.mulesoft.modules"]);
async function gql(q){const r=await fetch(GRAPH,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({query:q})});try{return JSON.parse(await r.text());}catch{return{};}}
async function httpGet(url){const c=new AbortController();const t=setTimeout(()=>c.abort(),25000);
  try{const r=await fetch(url,{signal:c.signal,redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 probe",Accept:"text/html"}});return{status:r.status,html:await r.text()};}
  catch(e){return{status:0,html:""};}finally{clearTimeout(t);}}

// 1) index pairs
const idx=await httpGet("https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes");
const pairs=[...idx.html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
  .map(m=>({slug:m[1].replace(/[#?].*$/,""),name:m[2].replace(/<[^>]+>/g,"").trim()}))
  .filter(a=>/release-notes/.test(a.slug)&&a.name&&!/anypoint-connector-release-notes/.test(a.slug));
const seen=new Set();const conns=pairs.filter(p=>{if(seen.has(p.slug))return false;seen.add(p.slug);return true;});
console.log("index connectors:",conns.length);

// 2) candidate artifactIds from slug + display name
function candidates(slug,name){
  const base=slug.replace(/-release-notes(-mule-4)?$/,"").replace(/^connector-/,"");
  const nm=name.toLowerCase().replace(/\s+connector.*$/,"").replace(/\s+module.*$/,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"");
  const stems=new Set([base, base.replace(/-connector$|-module$/,""), nm]);
  const out=new Set();
  for(const s of stems){ if(!s)continue;
    out.add(`mule-${s}-connector`); out.add(`mule-${s}-module`); out.add(`mule4-${s}-connector`);
    out.add(`mule-${s}`); out.add(s); out.add(`${s}-connector`); out.add(`${s}-module`);
  }
  return [...out];
}
// 3) verify a batch of candidates in ONE aliased query
function alias(i){return "c"+i;}
async function verifyMany(cands){
  const q=`query {${cands.map((c,i)=>`${alias(i)}: assets(query:{searchTerm:${JSON.stringify(c)},limit:20}){groupId assetId version}`).join("\n")}}`;
  const j=await gql(q); const data=j?.data??{};
  const hits=[];
  cands.forEach((c,i)=>{const rows=data[alias(i)]||[];const m=rows.find(r=>r.assetId===c&&CONN.has(r.groupId));if(m)hits.push({artifactId:c,groupId:m.groupId});});
  return hits;
}
let resolved=0;const unresolved=[];
const sample=conns; // all
for(const p of sample){
  const cands=candidates(p.slug,p.name);
  // chunk to <=15 aliases per call
  let hit=null;
  for(let k=0;k<cands.length&&!hit;k+=12){ const hits=await verifyMany(cands.slice(k,k+12)); if(hits.length)hit=hits[0]; }
  if(hit){resolved++; if(resolved<=20)console.log(`  OK ${p.slug} -> ${hit.groupId}:${hit.artifactId}`);}
  else unresolved.push(p.slug);
}
console.log(`\nRESOLVED ${resolved}/${sample.length}; UNRESOLVED ${unresolved.length}`);
console.log("unresolved sample:",JSON.stringify(unresolved.slice(0,30)));
console.log("=== DONE ===");
