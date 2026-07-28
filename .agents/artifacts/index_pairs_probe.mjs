// index_pairs_probe.mjs — READ-ONLY: extract (displayName, slug) PAIRS from the connector
// release-notes index, so we can judge whether a deterministic artifactId->slug map is buildable.
const INDEX = "https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes";
async function httpGet(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 25000);
  try {
    const res = await fetch(url, { signal: c.signal, redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 probe", Accept: "text/html" } });
    return { status: res.status, html: await res.text() };
  } catch (e) { return { status: 0, html: "", err: e?.message }; }
  finally { clearTimeout(t); }
}
const r = await httpGet(INDEX);
console.log("index status", r.status, "len", r.html.length);

// Anchor tags: capture href + inner text.
const anchors = [...r.html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
  .map(m => ({ href: m[1], text: m[2].replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim() }))
  // keep only connector release-notes slugs (relative, mule-4 era or connector-* form)
  .filter(a => /(release-notes.*mule-4|^connector-)/i.test(a.href) && !/^https?:/i.test(a.href) && a.text);

console.log("connector anchor pairs:", anchors.length);
console.log("\n--- sample (name → slug) ---");
for (const a of anchors.slice(0, 30)) console.log(`  "${a.text}"  ->  ${a.href}`);

// Now: for the 16 connectors we care about, find their pair by matching the display name.
const OURS = {
  "mule-http-connector": "http",
  "mule-db-connector": "database",
  "mule-sockets-connector": "sockets",
  "mule-salesforce-connector": "salesforce",
  "mule-netsuite-connector": "netsuite",
  "mule-twilio-connector": "twilio",
  "mule4-slack-connector": "slack",
  "mule4-gmail-connector": "gmail",
  "mule-validation-module": "validation",
  "mule-apikit-module": "apikit",
  "mule-objectstore-connector": "object store",
  "mule-json-module": "json",
  "mule-xml-module": "xml",
  "mule-oauth-module": "oauth",
  "mule-tracing-module": "tracing",
  "mule-secure-configuration-property-module": "secure",
};
console.log("\n--- match our artifactIds by display-name keyword ---");
for (const [art, kw] of Object.entries(OURS)) {
  const hits = anchors.filter(a => a.text.toLowerCase().includes(kw));
  console.log(`  ${art} [${kw}] -> ${hits.length ? hits.map(h=>h.href).join(" | ") : "NO MATCH"}`);
}
console.log("\n=== DONE ===");
