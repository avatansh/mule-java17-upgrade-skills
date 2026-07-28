// READ-ONLY. Uses only global fetch (no shell, no child process).
async function httpGet(url){const c=new AbortController();const t=setTimeout(()=>c.abort(),25000);
  try{const r=await fetch(url,{signal:c.signal,redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 probe",Accept:"text/html"}});return{status:r.status,html:await r.text()};}
  catch(e){return{status:0,html:""};}finally{clearTimeout(t);}}
// (A) scan connector index anchors for apikit/validation/xml/secure
const idx=await httpGet("https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes");
const anchors=[...idx.html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
  .map(m=>({href:m[1],text:m[2].replace(/<[^>]+>/g,"").trim()}));
console.log("=== connector-index anchors matching module keywords ===");
for(const a of anchors) if(/apikit|validation|xml|secure|json/i.test(a.href+a.text)) console.log(`   ${a.href} | ${a.text}`);
// (B) try candidate slugs directly
console.log("\n=== candidate slug probes ===");
const cands=["apikit-4-release-notes","apikit-module-release-notes","mule-apikit-module-release-notes",
  "validation-connector-release-notes","xml-connector-release-notes",
  "secure-configuration-property-editor-release-notes","secure-properties-release-notes"];
for(const s of cands){const r=await httpGet("https://docs.mulesoft.com/release-notes/connector/"+s);console.log(`   ${s} -> ${r.status}`);}
console.log("=== DONE ===");
