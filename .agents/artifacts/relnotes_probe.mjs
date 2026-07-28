// relnotes_probe.mjs — READ-ONLY: fetch REAL connector release-notes pages and test whether the
// runtime/Java compatibility table is actually extractable. Uses the suite's OWN parser
// (parseOpenJdkTable) so this measures what the shipped code would really see.
import { parseOpenJdkTable, firstJava17Version } from "../../skills/mule-upgrade-assess/scripts/lib/version_resolver.js";

// Candidate real MuleSoft connector release-notes URLs (Antora docs). We try a few known patterns.
const URLS = [
  ["salesforce", "https://docs.mulesoft.com/release-notes/connector/connector-salesforce"],
  ["http", "https://docs.mulesoft.com/release-notes/connector/connector-http"],
  ["db", "https://docs.mulesoft.com/release-notes/connector/connector-database"],
];

async function get(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 20000);
  try {
    const res = await fetch(url, { signal: c.signal, redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 probe", Accept: "text/html" } });
    const html = await res.text();
    return { status: res.status, ct: res.headers.get("content-type") || "", html, finalUrl: res.url };
  } catch (e) {
    return { status: 0, ct: "", html: "", err: e?.message ?? String(e) };
  } finally { clearTimeout(t); }
}

for (const [name, url] of URLS) {
  console.log(`\n=== ${name} :: ${url} ===`);
  const r = await get(url);
  console.log(`  status ${r.status} ${r.ct.split(";")[0]} finalUrl=${r.finalUrl ?? ""} len=${r.html.length}`);
  if (r.err) { console.log("  ERR", r.err); continue; }
  if (!r.html) { console.log("  (empty body)"); continue; }

  // Signal 1: does the raw HTML even mention JDK/OpenJDK and a Mule runtime version?
  const mentionsJdk = /openjdk|\bjdk\b/i.test(r.html);
  const mentionsJava = /\bjava\b/i.test(r.html);
  const tableCount = (r.html.match(/<table/gi) || []).length;
  console.log(`  raw signals: <table>=${tableCount}  mentions OpenJDK/JDK=${mentionsJdk}  Java=${mentionsJava}`);

  // Signal 2: run the SHIPPED parser.
  const entries = parseOpenJdkTable(r.html);
  console.log(`  parseOpenJdkTable → ${entries.length} version rows`);
  console.log("  sample:", JSON.stringify(entries.slice(0, 6)));
  console.log("  firstJava17Version:", firstJava17Version(entries));

  // Signal 3: show a snippet around the first OpenJDK/JDK mention so we SEE the real structure.
  const idx = r.html.search(/openjdk|\bjdk\b/i);
  if (idx >= 0) {
    const snip = r.html.slice(Math.max(0, idx - 200), idx + 300).replace(/\s+/g, " ");
    console.log("  context around first JDK mention:", snip);
  }
}
console.log("\n=== DONE ===");
