// READ-ONLY. Uses only global fetch (no shell, no child process).
// Verify the hand-curated slugs for the 15 matrix connectors return 200 + a parseable compat table.
import { parseCompatibilityTable, firstJava17Version } from "../../skills/mule-upgrade-assess/scripts/lib/version_resolver.js";
const BASE="https://docs.mulesoft.com/release-notes/connector/";
const CORE={
  "mule-http-connector":"connector-http",
  "mule-db-connector":"connector-db",
  "mule-sockets-connector":"connector-sockets",
  "mule-objectstore-connector":"object-store-connector-release-notes-mule-4",
  "mule-apikit-module":"apikit-release-notes",
  "mule-validation-module":"validation-module-release-notes",
  "mule-xml-module":"xml-module-release-notes",
  "mule-json-module":"json-module-release-notes",
  "mule-oauth-module":"oauth-module-release-notes",
  "mule-tracing-module":"tracing-module-release-notes",
  "mule-secure-configuration-property-module":"secure-configuration-property-module-release-notes",
  "mule4-slack-connector":"slack-connector-release-notes-mule-4",
  "mule4-gmail-connector":"gmail-connector-release-notes-mule-4",
  "mule-twilio-connector":"twilio-connector-release-notes-mule-4",
  "mule-salesforce-connector":"salesforce-connector-release-notes-mule-4",
};
async function httpGet(url){const c=new AbortController();const t=setTimeout(()=>c.abort(),25000);
  try{const r=await fetch(url,{signal:c.signal,redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 probe",Accept:"text/html"}});return{status:r.status,html:await r.text()};}
  catch(e){return{status:0,html:""};}finally{clearTimeout(t);}}
for(const [aid,slug] of Object.entries(CORE)){
  const r=await httpGet(BASE+slug);
  const rows=r.status===200?parseCompatibilityTable(r.html):[];
  console.log(`${r.status===200&&rows.length?"OK ":"!! "} ${aid} slug=${slug} status=${r.status} rows=${rows.length} firstJava17=${firstJava17Version(rows)} sampleRuntime=${rows.find(x=>x.muleRuntime)?.muleRuntime??"-"}`);
}
console.log("=== DONE ===");
