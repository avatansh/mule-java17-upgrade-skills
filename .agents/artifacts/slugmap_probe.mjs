// slugmap_probe.mjs — build the connector->release-notes-slug map deterministically from the index
// page's relative hrefs, then FETCH each of our matrix connectors' page and parse the JDK+runtime
// table. This tests the full "no Google needed" pipeline end to end. Global fetch only.
import { parseOpenJdkTable, firstJava17Version } from "../../skills/mule-upgrade-assess/scripts/lib/version_resolver.js";

const BASE = "https://docs.mulesoft.com/release-notes/connector/";
async function httpGet(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 25000);
  try {
    const res = await fetch(url, { signal: c.signal, redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 probe", Accept: "text/html" } });
    return { status: res.status, html: await res.text() };
  } catch (e) { return { status: 0, html: "", err: e?.message }; }
  finally { clearTimeout(t); }
}

// 1) Harvest every relative slug from the index page.
const idx = await httpGet(BASE + "anypoint-connector-release-notes");
const slugs = [...new Set(
  [...idx.html.matchAll(/href="([a-z0-9][a-z0-9-]*(?:release-notes[a-z0-9-]*|connector-[a-z0-9-]*))"/gi)]
    .map(m => m[1])
)];
console.log(`harvested ${slugs.length} candidate slugs`);

// 2) Map OUR matrix connectors to a slug by keyword. (artifactId -> search keywords)
const WANT = {
  "mule-http-connector": ["connector-http","http-connector"],
  "mule-db-connector": ["connector-db","database-connector","db-connector"],
  "mule-sockets-connector": ["connector-sockets","sockets"],
  "mule-salesforce-connector": ["salesforce-connector-release","salesforce"],
  "mule-netsuite-connector": ["netsuite"],
  "mule-twilio-connector": ["twilio"],
  "mule4-slack-connector": ["slack"],
  "mule4-gmail-connector": ["gmail","google-mail"],
  "mule-validation-module": ["validation"],
  "mule-apikit-module": ["apikit"],
};
function pick(keywords) {
  for (const k of keywords) { const hit = slugs.find(s => s.toLowerCase().includes(k)); if (hit) return hit; }
  return null;
}

console.log("\n=== resolve + fetch + parse per connector ===");
for (const [art, kws] of Object.entries(WANT)) {
  const slug = pick(kws);
  if (!slug) { console.log(`  ${art}: NO SLUG MATCH`); continue; }
  const r = await httpGet(BASE + slug);
  const jdk = r.status === 200 ? parseOpenJdkTable(r.html) : [];
  console.log(`  ${art}\n    slug=${slug} status=${r.status} jdkRows=${jdk.length} firstJava17=${firstJava17Version(jdk)}`);
}
console.log("\n=== DONE ===");
