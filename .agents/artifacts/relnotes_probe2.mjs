// relnotes_probe2.mjs — correct slugs + confirm BOTH the Mule-runtime row and OpenJDK row are present
// in the same compatibility table. Uses only global fetch (no shell, no child process).
import { parseOpenJdkTable, firstJava17Version } from "../../skills/mule-upgrade-assess/scripts/lib/version_resolver.js";

const URLS = [
  ["salesforce", "https://docs.mulesoft.com/release-notes/connector/salesforce-connector"],
  ["db",         "https://docs.mulesoft.com/release-notes/connector/connector-db"],
  ["netsuite",   "https://docs.mulesoft.com/release-notes/connector/netsuite-connector"],
];
async function httpGet(url) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 20000);
  try {
    const res = await fetch(url, { signal: c.signal, redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 probe", Accept: "text/html" } });
    return { status: res.status, html: await res.text(), finalUrl: res.url };
  } catch (e) { return { status: 0, html: "", err: e?.message }; }
  finally { clearTimeout(t); }
}
// Feasibility test: extract the "Mule" runtime row the same way parseOpenJdkTable does the JDK row.
function parseRuntimeRows(html) {
  const text = String(html).replace(/\r/g, ""); const out = []; const seen = new Set();
  const tableRe = /<table[\s\S]*?<\/table>/gi; let m; let last = 0;
  while ((m = tableRe.exec(text)) !== null) {
    const tbl = m[0]; const pre = text.slice(last, m.index); last = tableRe.lastIndex;
    const rowRe = /<tr[\s\S]*?<\/tr>/gi; let r; let mule = null;
    while ((r = rowRe.exec(tbl)) !== null) {
      const cells = [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map(c => c[1].replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").trim());
      if (cells.length < 2) continue;
      if (/^mule\b/i.test(cells[0])) { mule = cells.slice(1).join(" ").trim(); break; }
    }
    if (!mule) continue;
    const vs = [...pre.matchAll(/(?:version\s+)?\b(\d+\.\d+\.\d+)\b/gi)].map(v => v[1]);
    const version = vs.length ? vs[vs.length-1] : null;
    if (!version || seen.has(version)) continue; seen.add(version);
    out.push({ version, muleRuntime: mule });
  }
  return out;
}

for (const [name, url] of URLS) {
  console.log(`\n=== ${name} :: ${url} ===`);
  const r = await httpGet(url);
  console.log(`  status ${r.status} len=${r.html.length}`);
  if (!r.html || r.status !== 200) { console.log("  skip", r.err ?? ""); continue; }
  const jdk = parseOpenJdkTable(r.html);
  const rt  = parseRuntimeRows(r.html);
  console.log(`  OpenJDK rows: ${jdk.length}  | firstJava17=${firstJava17Version(jdk)}`);
  console.log(`  sample JDK:`, JSON.stringify(jdk.slice(0,4)));
  console.log(`  runtime rows: ${rt.length}`);
  console.log(`  sample runtime:`, JSON.stringify(rt.slice(0,4)));
}
console.log("\n=== DONE ===");
