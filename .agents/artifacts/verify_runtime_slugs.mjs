// READ-ONLY. Uses only global fetch (no shell, no child process).
import { parseCompatibilityTable, firstJava17Version } from "../../skills/mule-upgrade-assess/scripts/lib/version_resolver.js";
async function httpGet(url){const c=new AbortController();const t=setTimeout(()=>c.abort(),25000);
  try{const r=await fetch(url,{signal:c.signal,redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 probe",Accept:"text/html"}});return{status:r.status,html:await r.text(),url:r.url};}
  catch(e){return{status:0,html:""};}finally{clearTimeout(t);}}
const RN="https://docs.mulesoft.com/release-notes";
const URLS={
  "mule-secure-configuration-property-module":`${RN}/mule-runtime/secure-properties`,
  "mule-validation-module":`${RN}/mule-runtime/module-validation`,
  "mule-xml-module":`${RN}/mule-runtime/module-xml`,
  // apikit candidates
  "apikit-a":`${RN}/mule-runtime/apikit`,
  "apikit-b":`${RN}/connector/apikit-release-notes-mule-4`,
  "apikit-c":`${RN}/mule-runtime/apikit-release-notes`,
};
for(const [k,u] of Object.entries(URLS)){
  const r=await httpGet(u);
  const rows=r.status===200?parseCompatibilityTable(r.html):[];
  console.log(`${r.status===200&&rows.length?"OK ":"!! "} ${k} status=${r.status} rows=${rows.length} firstJava17=${firstJava17Version(rows)} url=${u}`);
}
console.log("=== DONE ===");
