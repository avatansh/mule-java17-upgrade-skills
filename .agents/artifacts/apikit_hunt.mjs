// READ-ONLY. Uses only global fetch (no shell, no child process).
import { parseCompatibilityTable, firstJava17Version } from "../../skills/mule-upgrade-assess/scripts/lib/version_resolver.js";
async function httpGet(url){const c=new AbortController();const t=setTimeout(()=>c.abort(),25000);
  try{const r=await fetch(url,{signal:c.signal,redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 probe",Accept:"text/html"}});return{status:r.status,html:await r.text()};}
  catch(e){return{status:0,html:""};}finally{clearTimeout(t);}}
const cands=[
  "https://docs.mulesoft.com/release-notes/mule-runtime/module-apikit",
  "https://docs.mulesoft.com/release-notes/apikit/apikit-release-notes",
  "https://docs.mulesoft.com/release-notes/mule-runtime/apikit-module",
  "https://docs.mulesoft.com/release-notes/connector/apikit-release-notes",
  "https://docs.mulesoft.com/release-notes/mule-runtime/apikit-4-release-notes",
];
for(const u of cands){const r=await httpGet(u);const rows=r.status===200?parseCompatibilityTable(r.html):[];console.log(`${r.status} rows=${rows.length} ${u}`);}
console.log("=== DONE ===");
