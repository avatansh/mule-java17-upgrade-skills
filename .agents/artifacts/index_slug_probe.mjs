// index_slug_probe.mjs — READ-ONLY: does the connector release-notes INDEX page link out to each
// per-connector release-notes page? If yes, we can extract real slugs deterministically (no Google,
// no guessing). Uses only global fetch.
const INDEX = "https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes";

async function httpGet(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 20000);
  try {
    const res = await fetch(url, { signal: c.signal, redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 probe", Accept: "text/html" } });
    return { status: res.status, html: await res.text() };
  } catch (e) { return { status: 0, html: "", err: e?.message }; }
  finally { clearTimeout(t); }
}

const r = await httpGet(INDEX);
console.log(`index status ${r.status} len=${r.html.length}`);

// Extract all hrefs that point at a connector release-notes page.
const hrefs = [...r.html.matchAll(/href="([^"]*release-notes\/connector\/[^"]+)"/gi)].map(m => m[1]);
const uniq = [...new Set(hrefs)].filter(h => !/anypoint-connector-release-notes/.test(h));
console.log(`connector release-notes links found: ${uniq.length}`);
console.log("sample:", JSON.stringify(uniq.slice(0, 25), null, 1));

// For the connectors in our matrix, see which slugs appear.
const WANT = ["http","database","db","salesforce","sockets","netsuite","twilio","slack","gmail",
  "object-store","objectstore","validation","apikit"];
console.log("\nslug matches for our connectors:");
for (const w of WANT) {
  const hit = uniq.filter(h => h.toLowerCase().includes(w));
  if (hit.length) console.log(`  ${w} -> ${hit.join(", ")}`);
}
console.log("\n=== DONE ===");
