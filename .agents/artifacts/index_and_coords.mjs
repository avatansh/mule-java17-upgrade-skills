// READ-ONLY. Uses only global fetch (no shell, no child process).
async function httpGet(url){const c=new AbortController();const t=setTimeout(()=>c.abort(),25000);
  try{const r=await fetch(url,{signal:c.signal,redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 probe",Accept:"text/html"}});return{status:r.status,html:await r.text()};}
  catch(e){return{status:0,html:"",err:e?.message};}finally{clearTimeout(t);}}

// (A) index page: dump all hrefs matching release-notes/connector and their anchor text shape
const idx=await httpGet("https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes");
console.log("index len",idx.html.length);
const hrefs=[...idx.html.matchAll(/href="([^"]*release-notes\/connector\/[^"#]+)"/gi)].map(m=>m[1]);
const uniq=[...new Set(hrefs)].filter(h=>!/anypoint-connector-release-notes/.test(h));
console.log("unique connector hrefs:",uniq.length);
console.log("sample:",JSON.stringify(uniq.slice(0,15),null,0));

// (B) does the salesforce page contain the artifactId as PLAIN TEXT anywhere?
const sf=await httpGet("https://docs.mulesoft.com/release-notes/connector/salesforce-connector-release-notes-mule-4");
for(const needle of ["mule-salesforce-connector","com.mulesoft.connectors","artifactId","groupId","<dependency"]){
  const i=sf.html.indexOf(needle);
  console.log(`  salesforce page contains "${needle}": ${i>=0?("yes @"+i):"NO"}`);
}
// show a snippet around any maven coordinate mention
const mi=sf.html.search(/mule-salesforce-connector|com\.mulesoft\.connectors/);
if(mi>=0) console.log("  snippet:",sf.html.slice(mi-80,mi+120).replace(/\s+/g," "));
console.log("=== DONE ===");
