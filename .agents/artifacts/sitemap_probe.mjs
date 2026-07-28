// sitemap_probe.mjs — READ-ONLY: two deterministic slug-discovery options.
//  (A) docs.mulesoft.com sitemap.xml — does it enumerate connector release-notes URLs?
//  (B) what href patterns actually exist on the index page (maybe not absolute release-notes paths)?
async function httpGet(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 25000);
  try {
    const res = await fetch(url, { signal: c.signal, redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 probe", Accept: "*/*" } });
    return { status: res.status, body: await res.text(), ct: res.headers.get("content-type")||"" };
  } catch (e) { return { status: 0, body: "", err: e?.message }; }
  finally { clearTimeout(t); }
}

console.log("=== (A) sitemap candidates ===");
for (const u of [
  "https://docs.mulesoft.com/sitemap.xml",
  "https://docs.mulesoft.com/release-notes/sitemap.xml",
]) {
  const r = await httpGet(u);
  console.log(`  ${u} → ${r.status} ${r.ct.split(";")[0]} len=${r.body.length}`);
  if (r.status === 200) {
    const locs = [...r.body.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m=>m[1]);
    console.log(`    <loc> entries: ${locs.length}`);
    const conn = locs.filter(l => /release-notes\/connector\//.test(l));
    console.log(`    connector release-notes locs: ${conn.length}`);
    console.log("    sample:", JSON.stringify(conn.slice(0,15), null, 1));
    // Look for our specific connectors
    for (const w of ["http","database","salesforce","netsuite","sockets","twilio","slack","gmail","apikit","object-store"]) {
      const hit = conn.filter(l => l.toLowerCase().includes(w));
      if (hit.length) console.log(`      ${w}: ${hit[0]}`);
    }
    break;
  }
}

console.log("\n=== (B) all href patterns on the index page ===");
const idx = await httpGet("https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes");
const allHref = [...idx.body.matchAll(/href="([^"]+)"/gi)].map(m=>m[1]);
console.log("  total hrefs:", allHref.length);
const conn = [...new Set(allHref.filter(h => /connector/i.test(h)))];
console.log("  hrefs containing 'connector':", conn.length);
console.log("  sample:", JSON.stringify(conn.slice(0,20), null, 1));
console.log("\n=== DONE ===");
