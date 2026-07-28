// notesmap_feasibility.mjs — READ-ONLY. Uses only global fetch (no shell, no child process).
// G2 feasibility: (1) scrape the connector release-notes INDEX for (displayName, slug) pairs;
// (2) for a sample of pages, check HTTP 200 + whether an OpenJDK table parses + whether the POM
// artifactId is extractable from page text (Maven coordinates / <artifactId> snippet). This decides
// whether artifactId can be auto-populated for ALL connectors or must be hand-curated for our known set.
import { parseOpenJdkTable, firstJava17Version } from "../../skills/mule-upgrade/../mule-upgrade-assess/scripts/lib/version_resolver.js";

const INDEX = "https://docs.mulesoft.com/release-notes/connector/anypoint-connector-release-notes";
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

// 1) Harvest (displayName, slug) pairs from the index anchors.
const idx = await httpGet(INDEX);
const pairs = [...idx.html.matchAll(/<a[^>]+href="([^"]*\/release-notes\/connector\/[^"]+)"[^>]*>([^<]+)<\/a>/gi)]
  .map((m) => ({ href: m[1], name: m[2].trim() }))
  .filter((p) => !/anypoint-connector-release-notes/.test(p.href));
const bySlug = new Map();
for (const p of pairs) {
  const slug = p.href.replace(/^.*\/release-notes\/connector\//, "").replace(/[#?].*$/, "");
  if (slug && !bySlug.has(slug)) bySlug.set(slug, p.name);
}
console.log(`index status ${idx.status}; unique connector slugs: ${bySlug.size}`);
console.log("sample:", JSON.stringify([...bySlug.entries()].slice(0, 12)));

// 2) Extract artifactId from a page: look for a <artifactId>…</artifactId> or a mvn-style coordinate.
function extractArtifactId(html) {
  const tag = [...html.matchAll(/<artifactId>\s*([a-z0-9.\-]+)\s*<\/artifactId>/gi)].map((m) => m[1]);
  // Prefer a connector/module-looking artifactId over generic ones.
  const conn = tag.find((a) => /connector|module/.test(a) && /^mule/.test(a));
  return { any: [...new Set(tag)].slice(0, 6), connectorLike: conn ?? null };
}

const SAMPLE = ["connector-http", "connector-db", "salesforce-connector-release-notes-mule-4",
  "connector-sockets", "slack-connector-release-notes-mule-4", "netsuite-connector-release-notes-mule-4",
  "gmail-connector-release-notes-mule-4", "object-store-connector-release-notes-mule-4"];
console.log("\n=== sample page inspection ===");
for (const slug of SAMPLE) {
  const r = await httpGet(BASE + slug);
  if (r.status !== 200) { console.log(`  ${slug}: status ${r.status}`); continue; }
  const jdk = parseOpenJdkTable(r.html);
  const art = extractArtifactId(r.html);
  console.log(`  ${slug}: jdkRows=${jdk.length} firstJava17=${firstJava17Version(jdk)} artifactId(connectorLike)=${art.connectorLike} allArtifactIds=${JSON.stringify(art.any)}`);
}
console.log("\n=== DONE ===");
