// READ-ONLY. Uses only global fetch (no shell, no child process).
async function httpGet(url){const c=new AbortController();const t=setTimeout(()=>c.abort(),25000);
  try{const r=await fetch(url,{signal:c.signal,redirect:"follow",headers:{"User-Agent":"Mozilla/5.0 probe",Accept:"text/html"}});return{status:r.status,html:await r.text()};}
  catch(e){return{status:0,html:"",err:e?.message};}finally{clearTimeout(t);}}
const idx=await httpGet("https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes");
// ALL hrefs
const all=[...idx.html.matchAll(/href="([^"]+)"/gi)].map(m=>m[1]);
console.log("total hrefs:",all.length);
// ones that look like connector notes (relative or absolute), with anchor text
const anchors=[...idx.html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
  .map(m=>({href:m[1],text:m[2].replace(/<[^>]+>/g,"").trim()}))
  .filter(a=>/release-notes/.test(a.href)&&a.text&&!/anypoint-connector-release-notes/.test(a.href));
console.log("release-notes anchors:",anchors.length);
console.log(JSON.stringify(anchors.slice(0,25),null,1));
console.log("... distinct href prefixes:",JSON.stringify([...new Set(all.map(h=>h.replace(/[^/]*$/,"")).filter(h=>/release-notes/.test(h)))].slice(0,10)));
console.log("=== DONE ===");
